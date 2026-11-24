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
  trustedProxies?: ReadonlySet<string> | TrustedProxyConfig;
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

// ── Trusted proxy configuration ──────────────────────────────────────────────

export interface TrustedProxyConfig {
  /** Exact peer addresses that are allowed to forward client identity. */
  addresses: ReadonlySet<string>;
  /** IPv4 CIDR ranges, as [network address as unsigned int, prefix length]. */
  cidrs: ReadonlyArray<readonly [number, number]>;
  /** Number of trusted proxy hops at the right of X-Forwarded-For (0 = none). */
  hops: number;
}

const EMPTY_PROXY_CONFIG: TrustedProxyConfig = {
  addresses: new Set<string>(),
  cidrs: [],
  hops: 0
};

function normalizePeer(value: string): string {
  const trimmed = value.trim().toLowerCase();
  // Express reports IPv4 peers as ::ffff:a.b.c.d on dual-stack sockets.
  return trimmed.startsWith("::ffff:") ? trimmed.slice(7) : trimmed;
}

function parseCidr(entry: string): readonly [number, number] {
  const [address, prefix, extra] = entry.split("/");
  if (extra !== undefined || !address || prefix === undefined || !/^\d{1,2}$/.test(prefix)) {
    throw new Error(`invalid trusted proxy CIDR "${entry}"`);
  }
  const bits = Number(prefix);
  if (bits < 0 || bits > 32) {
    throw new Error(`invalid trusted proxy CIDR "${entry}" (prefix must be 0-32)`);
  }
  const octets = address.split(".");
  if (octets.length !== 4 || octets.some((o) => !/^\d{1,3}$/.test(o) || Number(o) > 255)) {
    throw new Error(`invalid trusted proxy CIDR "${entry}"`);
  }
  const value =
    ((Number(octets[0]) << 24) | (Number(octets[1]) << 16) |
      (Number(octets[2]) << 8) | Number(octets[3])) >>> 0;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return [(value & mask) >>> 0, bits];
}

/**
 * Parse COORDINATOR_TRUSTED_PROXIES. Accepted comma-separated entries:
 *  - IPv4 / IPv6 addresses (exact match)
 *  - IPv4 CIDR ranges, e.g. `10.0.0.0/8`
 *  - hop counts, e.g. `hops=2` (0-10; leftmost untrusted XFF entry is used)
 *
 * Empty/absent configuration is the documented safe default: no forwarded
 * header is trusted. Malformed configuration throws so startup can fail
 * clearly instead of silently trusting attacker-controlled headers.
 */
export function parseTrustedProxies(raw: string | undefined): TrustedProxyConfig {
  const entries = (raw ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (entries.length === 0) return EMPTY_PROXY_CONFIG;

  const addresses = new Set<string>();
  const cidrs: Array<readonly [number, number]> = [];
  let hops = 0;
  for (const entry of entries) {
    if (/^hops=\d+$/i.test(entry)) {
      hops = Number(entry.slice(5));
      if (hops > 10) throw new Error(`invalid trusted proxy hop count "${entry}" (max 10)`);
      continue;
    }
    if (entry.includes("/")) {
      cidrs.push(parseCidr(entry));
      continue;
    }
    const normalized = normalizePeer(entry);
    const isIpv4 = /^(\d{1,3}\.){3}\d{1,3}$/.test(normalized) &&
      normalized.split(".").every((o) => Number(o) <= 255);
    const isIpv6 = /^[0-9a-f:]+$/.test(normalized) && normalized.includes(":");
    if (!isIpv4 && !isIpv6) {
      throw new Error(`invalid trusted proxy address "${entry}"`);
    }
    addresses.add(normalized);
  }
  return { addresses, cidrs, hops };
}

function isTrustedPeer(peer: string, config: TrustedProxyConfig): boolean {
  if (config.addresses.has(peer)) return true;
  if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(peer)) return false;
  const octets = peer.split(".").map(Number);
  const value =
    ((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0;
  return config.cidrs.some(([network, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return ((value & mask) >>> 0) === network;
  });
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
export function resolveClientIp(
  req: Request,
  trustedProxies?: ReadonlySet<string> | TrustedProxyConfig
): string {
  const directPeer = normalizePeer(req.socket?.remoteAddress ?? "unknown");
  if (!trustedProxies) return directPeer;

  const config: TrustedProxyConfig =
    trustedProxies instanceof Set
      ? { addresses: trustedProxies, cidrs: [], hops: 0 }
      : trustedProxies;
  if (config.addresses.size === 0 && config.cidrs.length === 0 && config.hops === 0) {
    return directPeer;
  }
  if (!isTrustedPeer(directPeer, config)) return directPeer;

  const forwarded = req.headers["x-forwarded-for"];
  if (!forwarded) return directPeer;
  const raw = typeof forwarded === "string" ? forwarded : (forwarded[0] ?? "");
  const chain = raw.split(",").map((part) => normalizePeer(part.trim())).filter(Boolean);
  if (chain.length === 0) return directPeer;

  // hops=N: the rightmost N entries are proxies we control; select the first
  // untrusted entry to the left. Without hops, preserve the legacy leftmost
  // behaviour for a single trusted reverse proxy.
  const index = config.hops > 0 ? chain.length - config.hops - 1 : 0;
  return index >= 0 ? chain[index]! : directPeer;
}

// ── API-key extraction ───────────────────────────────────────────────────────

/**
 * Extract a bearer token from `Authorization: Bearer <token>`.
 * Returns `null` when the header is absent or malformed.
 *
 * Exported for unit testing.
 */
export function extractBearerToken(req: Request): string | null {
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
export function loadTrustedProxies(): TrustedProxyConfig {
  try {
    return loadTrustedProxyConfig();
  } catch {
    // Documented safe fallback: trust no forwarded headers. Startup config
    // validation reports the malformed value clearly before this is reached.
    return EMPTY_PROXY_CONFIG;
  }
}

/** Parse the configured trusted proxies, throwing on malformed entries. */
export function loadTrustedProxyConfig(): TrustedProxyConfig {
  return parseTrustedProxies(process.env.COORDINATOR_TRUSTED_PROXIES);
}
