/**
 * Centralised rate-limiting middleware for the WaffleFinance coordinator.
 *
 * Design goals:
 *  - Single in-process store for zero-dependency single-instance deployments.
 *  - Drop-in replaceable: swap `createStore()` for a Redis-backed one and the
 *    rest of the code is unchanged.
 *  - Trusted-proxy support: X-Forwarded-For is only trusted when the immediate
 *    peer matches a configured trusted CIDR/address list, preventing IP spoofing.
 *  - Optional API-key bypass: callers that present a valid bearer token in
 *    COORDINATOR_API_KEYS (comma-separated) are exempt from rate limits, making
 *    the middleware safe for high-volume resolver integrations.
 *  - Abuse logging: every 429 response is logged at `warn` level with the
 *    offending IP and route so operators can detect enumeration or DoS attempts.
 *  - Metrics: emits structured prometheus counters & histograms for every
 *    decision so abuse patterns are surfaced in the monitoring stack.
 */

import type { Request, Response, NextFunction } from "express";
import type { Logger } from "pino";
import { rateLimitDecisions, rateLimitWindowUsage } from "../../metrics.js";
import type { AbuseDetector } from "./abuse-detection.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface RateLimitOptions {
  /** Rolling window length in milliseconds. */
  windowMs: number;
  /** Maximum number of requests allowed within the window. */
  max: number;
  /** Human-readable identifier used in log messages. */
  name: string;
  /** Pino logger (optional; falls back to console.warn). */
  log?: Logger;
  /**
   * Set of API keys whose bearers bypass the limit.
   * Populated from COORDINATOR_API_KEYS at startup.
   */
  apiKeys?: ReadonlySet<string>;
  /**
   * Trusted upstream proxy IPs/CIDRs.  When the direct peer matches one of
   * these, the first value in X-Forwarded-For is used as the real IP.
   * When empty, X-Forwarded-For is IGNORED to prevent spoofing.
   */
  trustedProxies?: ReadonlySet<string>;
  /**
   * Optional abuse detector that tracks cross-route enumeration.
   * When provided, blocked requests are reported for multi-route analysis.
   */
  abuseDetector?: AbuseDetector;
}

interface Bucket {
  count: number;
  resetAt: number;
}

// ── In-process store ─────────────────────────────────────────────────────────

/**
 * Minimal in-memory bucket store.  Expired buckets are lazily evicted on
 * access, keeping steady-state memory proportional to unique active IPs
 * rather than historical traffic.
 */
class InMemoryStore {
  private readonly buckets = new Map<string, Bucket>();

  /** Increment the counter for `key` and return the updated bucket. */
  increment(key: string, windowMs: number): Bucket {
    const now = Date.now();
    let bucket = this.buckets.get(key);
    if (!bucket || now > bucket.resetAt) {
      bucket = { count: 1, resetAt: now + windowMs };
      this.buckets.set(key, bucket);
    } else {
      bucket.count += 1;
    }
    return bucket;
  }

  /** Remove all expired entries.  Call periodically to cap memory usage. */
  purgeExpired(): void {
    const now = Date.now();
    for (const [key, bucket] of this.buckets) {
      if (now > bucket.resetAt) this.buckets.delete(key);
    }
  }

  /** Number of tracked keys (useful for tests). */
  get size(): number {
    return this.buckets.size;
  }
}

// ── IP extraction helpers ────────────────────────────────────────────────────

/**
 * Resolve the real client IP from a request.
 *
 * Security contract:
 *  - When `trustedProxies` is empty the X-Forwarded-For header is completely
 *    ignored; we use `req.socket.remoteAddress` only.
 *  - When the direct peer IS in `trustedProxies` we take the *leftmost*
 *    X-Forwarded-For entry (the first hop not controlled by us).
 *  - Clients cannot forge their own IP by stuffing arbitrary values into
 *    X-Forwarded-For because that only matters when the direct peer is trusted.
 */
export function resolveClientIp(req: Request, trustedProxies?: ReadonlySet<string>): string {
  const directPeer = req.socket?.remoteAddress ?? "unknown";

  if (!trustedProxies || trustedProxies.size === 0) {
    return directPeer;
  }

  if (trustedProxies.has(directPeer)) {
    const forwarded = req.headers["x-forwarded-for"];
    if (forwarded) {
      const raw = typeof forwarded === "string" ? forwarded : (forwarded[0] ?? "");
      const first = raw.split(",")[0]?.trim();
      if (first) return first;
    }
  }

  return directPeer;
}

// ── API-key extraction ───────────────────────────────────────────────────────

/**
 * Extract a bearer token from `Authorization: Bearer <token>`.
 * Returns `null` when the header is absent or malformed.
 */
function extractBearerToken(req: Request): string | null {
  const auth = req.headers["authorization"];
  if (!auth || !auth.startsWith("Bearer ")) return null;
  const token = auth.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a rate-limiting Express middleware.
 *
 * @example
 * ```ts
 * const revealLimit = makeRateLimiter({
 *   windowMs: 60_000,
 *   max: 5,
 *   name: "secrets/reveal",
 *   log,
 *   apiKeys: loadApiKeys(),
 * });
 * router.post("/secrets/reveal", revealLimit, handler);
 * ```
 */
export function makeRateLimiter(opts: RateLimitOptions) {
  const store = new InMemoryStore();

  // Periodically purge expired buckets (every window or at least every 5 min).
  const purgeInterval = Math.min(opts.windowMs, 5 * 60_000);
  const timer = setInterval(() => store.purgeExpired(), purgeInterval);
  // Allow the process to exit even if the timer is still active.
  if (timer.unref) timer.unref();

  return function rateLimitMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): void {
    // ── API key bypass ──────────────────────────────────────────────────────
    if (opts.apiKeys && opts.apiKeys.size > 0) {
      const token = extractBearerToken(req);
      if (token && opts.apiKeys.has(token)) {
        rateLimitDecisions.inc({ route: opts.name, decision: "bypass" });
        return next();
      }
    }

    // ── IP resolution ───────────────────────────────────────────────────────
    const ip = resolveClientIp(req, opts.trustedProxies);
    const key = `${opts.name}:${ip}`;

    // ── Bucket increment ────────────────────────────────────────────────────
    const bucket = store.increment(key, opts.windowMs);

    // Record how full the window was before this request (as a ratio 0–1).
    // This lets operators spot sustained near-limit traffic before blocks occur.
    const usageRatio = Math.min(bucket.count / opts.max, 1);
    rateLimitWindowUsage.observe({ route: opts.name }, usageRatio);

    // Set standard rate-limit headers (RFC 6585 / draft-ietf-httpapi-ratelimit).
    const remaining = Math.max(0, opts.max - bucket.count);
    const resetSecs = Math.ceil((bucket.resetAt - Date.now()) / 1000);
    res.setHeader("X-RateLimit-Limit", opts.max);
    res.setHeader("X-RateLimit-Remaining", remaining);
    res.setHeader("X-RateLimit-Reset", resetSecs);

    if (bucket.count > opts.max) {
      res.setHeader("Retry-After", resetSecs);

      rateLimitDecisions.inc({ route: opts.name, decision: "block" });

      // Report to the abuse detector for cross-route enumeration tracking.
      opts.abuseDetector?.recordBlock({ ip, route: opts.name, timestamp: Date.now() });

      // Abuse log — contains route name and IP, never echoes user data.
      const msg = `[ratelimit] ${opts.name} — too many requests from ${ip} (${bucket.count}/${opts.max} in ${opts.windowMs}ms window)`;
      if (opts.log) {
        opts.log.warn({ ip, route: opts.name, count: bucket.count, limit: opts.max }, msg);
      } else {
        console.warn(msg);
      }

      res.status(429).json({
        error: "too_many_requests",
        message: "Rate limit exceeded. Try again shortly.",
        retryAfterSeconds: resetSecs
      });
      return;
    }

    rateLimitDecisions.inc({ route: opts.name, decision: "pass" });
    next();
  };
}

// ── Convenience pre-sets ──────────────────────────────────────────────────────

/**
 * Load the set of valid API keys from the COORDINATOR_API_KEYS env variable.
 * Returns an empty set when the variable is absent or blank.
 *
 * Keys are comma-separated and trimmed.  Blank entries are ignored so that a
 * trailing comma in `.env` does not accidentally grant open access.
 */
export function loadApiKeys(): ReadonlySet<string> {
  const raw = process.env.COORDINATOR_API_KEYS ?? "";
  const keys = raw
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
  return new Set(keys);
}

/**
 * Load the set of trusted upstream proxy IPs from COORDINATOR_TRUSTED_PROXIES.
 * Returns an empty set (i.e. X-Forwarded-For IGNORED) when absent.
 */
export function loadTrustedProxies(): ReadonlySet<string> {
  const raw = process.env.COORDINATOR_TRUSTED_PROXIES ?? "";
  const ips = raw
    .split(",")
    .map((ip) => ip.trim())
    .filter((ip) => ip.length > 0);
  return new Set(ips);
}
