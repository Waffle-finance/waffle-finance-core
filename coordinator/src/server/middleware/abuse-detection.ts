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
}

// ── Abuse detector ───────────────────────────────────────────────────────────

export class AbuseDetector {
  private readonly ips = new Map<string, IpRecord>();
  private readonly windowMs: number;
  private readonly threshold: number;
  private readonly log?: Logger;
  private readonly purgeTimer: ReturnType<typeof setInterval>;
  private flaggedCount = 0;

  constructor(opts: AbuseDetectorOptions = {}) {
    this.windowMs = opts.multiRouteWindowMs ?? 5 * 60_000;
    this.threshold = opts.multiRouteThreshold ?? 2;
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
}
