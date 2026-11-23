/**
 * Abuse-detection middleware for cross-route rate-limit analysis.
 *
 * Tracks IPs that hit rate limits on multiple distinct routes within a
 * configurable time window — a strong signal of enumeration, credential
 * stuffing, or bot activity.  Metrics are emitted as Prometheus gauges so
 * operators can monitor abuse levels at a glance.
 *
 * Design:
 *  - Each `recordBlock({ip, route})` call updates an in-memory sliding window.
 *  - When an IP accumulates blocks on ≥2 distinct routes within
 *    `multiRouteWindowMs` it is flagged as a multi-route abuser.
 *  - Expired records are purged periodically to cap memory.
 *  - Prometheus gauges (`coordinator_rate_limit_active_blocks` and
 *    `coordinator_rate_limit_multi_route_abusers`) are refreshed on each
 *    purge cycle.
 */

import { rateLimitActiveBlocks, rateLimitMultiRouteAbusers } from "../../metrics.js";
import type { Logger } from "pino";
import { createHash } from "node:crypto";

// ── Types ────────────────────────────────────────────────────────────────────

export interface AbuseBlockEvent {
  ip: string;
  route: string;
  timestamp: number;
}

interface IpRecord {
  /** Routes this IP has been blocked on within the window. */
  routes: Map<string, number /* timestamp */>;
  /** Total block count tracked (for diagnostics). */
  totalBlocks: number;
  /** Cached flag — set when routes.size >= multiRouteThreshold. */
  flagged: boolean;
}

/**
 * Only deterministic client mistakes count as abuse. Transient dependency
 * failures (chain/quote lookups) are explicitly excluded so legitimate
 * retries are never penalised.
 */
export const COUNTED_INVALID_REASONS = ["malformed", "policy_denied"] as const;
export const TRANSIENT_INVALID_REASONS = ["chain_unavailable", "quote_unavailable"] as const;
export type InvalidAnnounceReason =
  | (typeof COUNTED_INVALID_REASONS)[number]
  | (typeof TRANSIENT_INVALID_REASONS)[number];

export interface InvalidAnnounceEvent {
  /** Raw client identity — hashed before it is retained or logged. */
  clientId: string;
  reason: InvalidAnnounceReason;
  timestamp: number;
  /** Trusted clients (valid API key) are exempt from invalid-request counting. */
  trusted?: boolean;
}

interface InvalidAttemptRecord {
  count: number;
  updatedAt: number;
  flagged: boolean;
}

export interface AbuseDetectorOptions {
  /**
   * Sliding window in milliseconds for multi-route detection.
   * Default: 5 minutes.
   */
  multiRouteWindowMs?: number;
  /**
   * Number of distinct routes that trigger a multi-route flag.
   * Default: 2.
   */
  multiRouteThreshold?: number;
  /**
   * Pino logger for abuse alerts (optional).
   */
  log?: Logger;
  /** Sliding window for repeated invalid announcements. Default: 5 minutes. */
  invalidWindowMs?: number;
  /** Invalid announcements from one client that trigger an alert. Default: 5. */
  invalidThreshold?: number;
}

// ── Abuse detector ───────────────────────────────────────────────────────────

export class AbuseDetector {
  private readonly ips = new Map<string, IpRecord>();
  private readonly windowMs: number;
  private readonly threshold: number;
  private readonly log?: Logger;
  private readonly purgeTimer: ReturnType<typeof setInterval>;
  private flaggedCount = 0;
  private readonly invalidWindowMs: number;
  private readonly invalidThreshold: number;
  /** Opaque client hashes only — raw addresses are never retained. */
  private readonly invalidAttempts = new Map<string, InvalidAttemptRecord>();
  private invalidFlaggedCount = 0;
  private countedInvalid = 0;
  private transientSkipped = 0;
  private trustedSkipped = 0;

  constructor(opts: AbuseDetectorOptions = {}) {
    this.windowMs = opts.multiRouteWindowMs ?? 5 * 60_000;
    this.threshold = opts.multiRouteThreshold ?? 2;
    this.invalidWindowMs = opts.invalidWindowMs ?? 5 * 60_000;
    this.invalidThreshold = opts.invalidThreshold ?? 5;
    this.log = opts.log;
    this.purgeTimer = setInterval(() => this.purgeExpired(), this.windowMs);
    if (this.purgeTimer.unref) this.purgeTimer.unref();
  }

  /** Stop the internal purge timer. */
  stop(): void {
    clearInterval(this.purgeTimer);
  }

  /**
   * Record a rate-limit block event for cross-route analysis.
   * This is called by the rate-limit middleware on every 429 response.
   */
  recordBlock(event: AbuseBlockEvent): void {
    const now = event.timestamp;
    let rec = this.ips.get(event.ip);

    if (!rec) {
      rec = { routes: new Map(), totalBlocks: 0, flagged: false };
      this.ips.set(event.ip, rec);
    }

    // Update or touch the route entry.
    rec.routes.set(event.route, now);
    rec.totalBlocks++;

    // Check for multi-route threshold.
    if (!rec.flagged && rec.routes.size >= this.threshold) {
      rec.flagged = true;
      this.flaggedCount++;
      this.log?.warn(
        {
          ip: event.ip,
          routes: [...rec.routes.keys()],
          totalBlocks: rec.totalBlocks,
          windowMs: this.windowMs
        },
        `[abuse] IP ${event.ip} hit rate limits on ${rec.routes.size} distinct routes ` +
        `(${[...rec.routes.keys()].join(", ")}) — possible enumeration`
      );
    }

    // Emit per-route active block gauge value.
    // We aggregate across all IPs per route for the gauge snapshot.
    this.refreshGauges();
  }

  /**
   * Record a rejected announce request. Only malformed/policy-denied requests
   * are counted; transient chain or quote failures are ignored so clients can
   * retry legitimately. The client id is hashed before storage and alerts
   * contain aggregate counters only — no raw address or request body.
   */
  recordInvalidAnnounce(event: InvalidAnnounceEvent): boolean {
    if (TRANSIENT_INVALID_REASONS.includes(event.reason as any)) {
      this.transientSkipped++;
      return false;
    }
    if (event.trusted || !COUNTED_INVALID_REASONS.includes(event.reason as any)) {
      this.trustedSkipped++;
      return false;
    }

    const clientKey = createHash("sha256").update(event.clientId).digest("hex");
    let rec = this.invalidAttempts.get(clientKey);
    if (!rec) {
      rec = { count: 0, updatedAt: event.timestamp, flagged: false };
      this.invalidAttempts.set(clientKey, rec);
    }
    rec.count++;
    rec.updatedAt = event.timestamp;
    this.countedInvalid++;

    if (!rec.flagged && rec.count >= this.invalidThreshold) {
      rec.flagged = true;
      this.invalidFlaggedCount++;
      this.log?.warn(
        {
          reason: event.reason,
          windowMs: this.invalidWindowMs,
          threshold: this.invalidThreshold,
          trackedClients: this.invalidAttempts.size,
        },
        `[abuse] repeated invalid announce requests detected (${event.reason})`,
      );
    }
    return rec.flagged;
  }

  /**
   * Remove expired entries and recompute gauges.
   * Called periodically by the purge timer.
   */
  private purgeExpired(): void {
    const now = Date.now();
    const cutoff = now - this.windowMs;

    for (const [ip, rec] of this.ips) {
      // Remove stale route entries.
      for (const [route, ts] of rec.routes) {
        if (ts < cutoff) rec.routes.delete(route);
      }

      // If all routes expired, remove the IP entirely.
      if (rec.routes.size === 0) {
        if (rec.flagged) this.flaggedCount--;
        this.ips.delete(ip);
      } else {
        // Re-check flag status after expiry.
        const wasFlagged = rec.flagged;
        rec.flagged = rec.routes.size >= this.threshold;
        if (wasFlagged && !rec.flagged) this.flaggedCount--;
        if (!wasFlagged && rec.flagged) this.flaggedCount++;
      }
    }

    // Decay invalid-announce history with the same clock. A client is only
    // penalised while repeated invalid requests stay inside the window.
    const invalidCutoff = now - this.invalidWindowMs;
    for (const [clientKey, rec] of this.invalidAttempts) {
      if (rec.updatedAt < invalidCutoff) {
        if (rec.flagged) this.invalidFlaggedCount--;
        this.invalidAttempts.delete(clientKey);
      }
    }

    this.refreshGauges();
  }

  /**
   * Refresh Prometheus gauges to reflect current state.
   * This is called after every mutation so dashboards stay current.
   */
  private refreshGauges(): void {
    // Per-route active block count (unique IPs with blocks on that route).
    const routeCounts = new Map<string, number>();
    for (const rec of this.ips.values()) {
      for (const route of rec.routes.keys()) {
        routeCounts.set(route, (routeCounts.get(route) ?? 0) + 1);
      }
    }

    // Reset and set per-route gauge values.
    rateLimitActiveBlocks.reset();
    for (const [route, count] of routeCounts) {
      rateLimitActiveBlocks.set({ route }, count);
    }

    rateLimitMultiRouteAbusers.set(this.flaggedCount);
  }

  // ── Accessors for diagnostics / tests ─────────────────────────────────────

  /** Number of IPs currently tracked. */
  get trackedIps(): number {
    return this.ips.size;
  }

  /** Number of IPs flagged for multi-route abuse. */
  get flaggedIpCount(): number {
    return this.flaggedCount;
  }

  /** Aggregate invalid-announce counters — no raw addresses or request bodies. */
  get invalidAnnounceCounters() {
    return {
      counted: this.countedInvalid,
      transientSkipped: this.transientSkipped,
      trustedSkipped: this.trustedSkipped,
      flaggedClients: this.invalidFlaggedCount,
      trackedClients: this.invalidAttempts.size,
      windowMs: this.invalidWindowMs,
      threshold: this.invalidThreshold,
    };
  }
}
