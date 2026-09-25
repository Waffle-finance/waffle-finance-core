import type { Logger } from "pino";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type QuoteSource = "coingecko" | "fallback" | "cache";
export type QuoteStaleness = "fresh" | "stale" | "fallback";

/**
 * A single price pair snapshot as returned to callers.
 *
 * `source` describes where the numbers came from:
 *   - "coingecko" — fetched live from the upstream API this call
 *   - "cache"     — served from in-memory cache (still within staleTtlMs)
 *   - "fallback"  — upstream was unreachable and we returned last-known-good
 *                   or hardcoded values
 *
 * `staleness` is the higher-level signal for the UI:
 *   - "fresh"    — within freshTtlMs
 *   - "stale"    — within staleTtlMs but a background refresh has been kicked
 *   - "fallback" — beyond maxStaleTtlMs or never fetched; hardcoded price used
 */
export interface QuoteSnapshot {
  pair: string;
  /** USD price per unit of the source asset (ETH for ETH-XLM). */
  srcUsd: number | null;
  /** USD price per unit of the destination asset (XLM for ETH-XLM). */
  dstUsd: number | null;
  /** Derived exchange rate: srcUsd / dstUsd. Null when either leg is null. */
  rate: number | null;
  source: QuoteSource;
  staleness: QuoteStaleness;
  /** Unix ms when the upstream API data was fetched. */
  fetchedAt: number;
  /** How many milliseconds old is this snapshot, measured at response time. */
  ageMs: number;
}

// ---------------------------------------------------------------------------
// Internal cache entry
// ---------------------------------------------------------------------------

interface CacheEntry {
  pair: string;
  srcUsd: number | null;
  dstUsd: number | null;
  rate: number | null;
  fetchedAt: number;
  /** Whether this entry came from a live API call or is a hardcoded fallback. */
  isFallback: boolean;
}

// ---------------------------------------------------------------------------
// Hardcoded fallback prices (used ONLY when the upstream is unreachable and
// no prior live snapshot is in the cache). These should be reviewed quarterly.
// ---------------------------------------------------------------------------

const FALLBACK_PRICES: Record<string, { srcUsd: number; dstUsd: number }> = {
  "ETH-XLM": { srcUsd: 3_500, dstUsd: 0.12 },
  "ETH-SOL": { srcUsd: 3_500, dstUsd: 150 },
};

// ---------------------------------------------------------------------------
// SWR configuration defaults
// ---------------------------------------------------------------------------

export interface QuoteServiceOptions {
  /**
   * Data is "fresh" for this many milliseconds — served immediately with no
   * upstream call.
   * Default: 15 seconds.
   */
  freshTtlMs?: number;

  /**
   * Data is "stale" but still acceptable for this many milliseconds — served
   * immediately AND a background refresh is triggered for the next caller.
   * Default: 60 seconds.
   */
  staleTtlMs?: number;

  /**
   * Beyond this age, the data is considered too stale to serve safely. The
   * caller will block on a fresh upstream call (de-duped across concurrent
   * callers). If the upstream also fails, the hardcoded fallback is returned
   * with `staleness: "fallback"` so the caller can decide to surface a
   * warning.
   * Default: 5 minutes.
   */
  maxStaleTtlMs?: number;
}

function assertPositiveTtl(name: string, value: number | undefined): number {
  const resolved = value ?? {
    freshTtlMs: DEFAULT_FRESH_TTL_MS,
    staleTtlMs: DEFAULT_STALE_TTL_MS,
    maxStaleTtlMs: DEFAULT_MAX_STALE_TTL_MS,
  }[name];

  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new RangeError(`${name} must be a positive number, got ${resolved}`);
  }

  return resolved;
}

const DEFAULT_FRESH_TTL_MS = 15_000;
const DEFAULT_STALE_TTL_MS = 60_000;
const DEFAULT_MAX_STALE_TTL_MS = 5 * 60_000;

// ---------------------------------------------------------------------------
// QuoteService
// ---------------------------------------------------------------------------

/**
 * Robust SWR price cache that:
 *   1. Returns fresh data immediately when within `freshTtlMs`.
 *   2. Returns stale data and kicks off a background refresh when within
 *      `staleTtlMs`. The next caller (or a 50 ms later re-fetch by the same
 *      caller) will see fresher data.
 *   3. Blocks callers on a live fetch when beyond `staleTtlMs` (but de-dupes
 *      concurrent callers so only one upstream hit occurs).
 *   4. Falls back to last-known-good (or hardcoded prices) when the upstream
 *      is unreachable, rather than returning null or throwing.
 *   5. Exposes `staleness` and `ageMs` in the snapshot so the frontend can
 *      surface a "prices may be stale" indicator without guessing.
 */
export class QuoteService {
  private readonly log: Logger;
  private readonly freshTtlMs: number;
  private readonly staleTtlMs: number;
  private readonly maxStaleTtlMs: number;

  /** In-memory cache — one entry per pair key. */
  private readonly cache = new Map<string, CacheEntry>();

  /**
   * Inflight refresh promises, keyed by pair. This is the thundering-herd
   * guard: a burst of requests for the same pair collapses into a single
   * upstream call.
   */
  private readonly inflight = new Map<string, Promise<CacheEntry>>();

  constructor(log: Logger, opts: QuoteServiceOptions = {}) {
    this.log = log;
    this.freshTtlMs = assertPositiveTtl("freshTtlMs", opts.freshTtlMs);
    this.staleTtlMs = assertPositiveTtl("staleTtlMs", opts.staleTtlMs);
    this.maxStaleTtlMs = assertPositiveTtl("maxStaleTtlMs", opts.maxStaleTtlMs);
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Return a quote snapshot for `pair` (e.g. "ETH-XLM" or "ETH-SOL").
   *
   * - If fresh: returns immediately from cache.
   * - If stale: returns from cache and triggers a background refresh.
   * - If expired / cold: blocks on a live fetch (de-duped).
   * - On upstream failure with no valid cache: returns hardcoded fallback.
   */
  async getQuote(pair: string): Promise<QuoteSnapshot> {
    const entry = await this._resolve(pair);
    return this._toSnapshot(entry);
  }

  /**
   * Evict a pair from the in-memory cache, forcing the next caller to block
   * on a fresh upstream fetch.  Safe to call from operator tooling or tests.
   * If the pair is not cached this is a no-op.
   */
  invalidate(pair: string): void {
    this.cache.delete(pair);
    this.log.info({ pair }, "quote cache invalidated");
  }

  /**
   * Return a snapshot of the current cache state for observability.
   *
   * Each entry includes the pair key, how old the cached data is, whether it
   * is a fallback value, and its staleness classification at the moment of the
   * call.  Useful for health-check endpoints and dashboards.
   */
  getCacheStats(): Record<string, { pair: string; ageMs: number; isFallback: boolean; staleness: QuoteStaleness }> {
    const now = Date.now();
    const stats: Record<string, { pair: string; ageMs: number; isFallback: boolean; staleness: QuoteStaleness }> = {};
    for (const [key, entry] of this.cache) {
      const ageMs = now - entry.fetchedAt;
      let staleness: QuoteStaleness;
      if (entry.isFallback) {
        staleness = "fallback";
      } else if (ageMs < this.freshTtlMs) {
        staleness = "fresh";
      } else {
        staleness = "stale";
      }
      stats[key] = { pair: entry.pair, ageMs, isFallback: entry.isFallback, staleness };
    }
    return stats;
  }

  /**
   * Convenience wrapper for the ETH/XLM pair — preserves backwards compat
   * with code that calls `quoteEthXlm()` directly.
   */
  async quoteEthXlm(): Promise<{
    ethUsd: string | null;
    xlmUsd: string | null;
    source: QuoteSource;
    staleness: QuoteStaleness;
    fetchedAt: number;
    ageMs: number;
  }> {
    const snap = await this.getQuote("ETH-XLM");
    return {
      ethUsd: snap.srcUsd !== null ? String(snap.srcUsd) : null,
      xlmUsd: snap.dstUsd !== null ? String(snap.dstUsd) : null,
      source: snap.source,
      staleness: snap.staleness,
      fetchedAt: snap.fetchedAt,
      ageMs: snap.ageMs,
    };
  }

  // -------------------------------------------------------------------------
  // SWR resolution logic
  // -------------------------------------------------------------------------

  private async _resolve(pair: string): Promise<CacheEntry> {
    const now = Date.now();
    const cached = this.cache.get(pair);

    if (cached) {
      const age = now - cached.fetchedAt;

      if (age < this.freshTtlMs) {
        // Fully fresh — serve immediately, no upstream touch.
        return cached;
      }

      if (age < this.staleTtlMs) {
        // Stale-but-acceptable — serve immediately and kick off background
        // refresh immediately (non-blocking, void the promise).
        this._triggerBackgroundRefresh(pair);
        return cached;
      }

      if (age < this.maxStaleTtlMs) {
        // Past stale window but within max — same pattern.
        this._triggerBackgroundRefresh(pair);
        return cached;
      }
    }

    // Cold start or beyond maxStaleTtl — block the caller on a live fetch.
    // De-dupe: concurrent callers share the same inflight promise.
    const existing = this.inflight.get(pair);
    if (existing) return existing;

    const fetching = this._fetchAndStore(pair);
    this.inflight.set(pair, fetching);
    try {
      return await fetching;
    } finally {
      this.inflight.delete(pair);
    }
  }

  /**
   * Start a background refresh immediately if one is not already in-flight.
   * Failures are logged but never propagated to callers.
   */
  private _triggerBackgroundRefresh(pair: string): void {
    if (this.inflight.has(pair)) return;

    const p = this._fetchAndStore(pair).catch((err) => {
      this.log.warn({ err, pair }, "background price refresh failed; keeping stale entry");
    }).finally(() => {
      this.inflight.delete(pair);
    });

    // Cast so Map<string, Promise<CacheEntry>> stays happy — we swallow the
    // error above so the stored promise never rejects.
    this.inflight.set(pair, p as unknown as Promise<CacheEntry>);
  }

  /**
   * Perform the actual upstream fetch, write the result to the cache, and
   * return it. On failure, store and return a fallback entry so that
   * subsequent calls within maxStaleTtlMs don't hammer the upstream.
   */
  private async _fetchAndStore(pair: string): Promise<CacheEntry> {
    try {
      const entry = await this._fetchFromUpstream(pair);
      this.cache.set(pair, entry);
      this.log.debug({ pair, srcUsd: entry.srcUsd, dstUsd: entry.dstUsd }, "price cache updated");
      return entry;
    } catch (err) {
      this.log.warn({ err, pair }, "upstream price fetch failed");

      // If we have a previous (possibly stale) entry, refresh its timestamp
      // just enough to prevent thundering-herd storms while clearly marking
      // it as a fallback.
      const stale = this.cache.get(pair);
      if (stale) {
        const refreshed: CacheEntry = { ...stale, fetchedAt: Date.now(), isFallback: true };
        this.cache.set(pair, refreshed);
        return refreshed;
      }

      // No prior entry at all — return hardcoded fallback without caching so
      // the next call still tries the upstream.
      return this._hardcodedFallback(pair);
    }
  }

  // -------------------------------------------------------------------------
  // Upstream fetch
  // -------------------------------------------------------------------------

  private async _fetchFromUpstream(pair: string): Promise<CacheEntry> {
    const ids = this._geckoIds(pair);

    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`,
      { signal: AbortSignal.timeout(8_000) }
    );

    if (!res.ok) {
      throw new Error(`CoinGecko returned HTTP ${res.status}`);
    }

    const body = (await res.json()) as Record<string, { usd?: number }>;
    const [srcId, dstId] = this._geckoIdPair(pair);

    const srcUsd = typeof body[srcId]?.usd === "number" ? (body[srcId].usd as number) : null;
    const dstUsd = typeof body[dstId]?.usd === "number" ? (body[dstId].usd as number) : null;

    if (srcUsd === null || srcUsd <= 0 || dstUsd === null || dstUsd <= 0) {
      throw new Error(`CoinGecko returned invalid prices for ${pair}: src=${srcUsd} dst=${dstUsd}`);
    }

    return {
      pair,
      srcUsd,
      dstUsd,
      rate: srcUsd / dstUsd,
      fetchedAt: Date.now(),
      isFallback: false,
    };
  }

  // -------------------------------------------------------------------------
  // Snapshot projection
  // -------------------------------------------------------------------------

  private _toSnapshot(entry: CacheEntry): QuoteSnapshot {
    const now = Date.now();
    const ageMs = now - entry.fetchedAt;

    let staleness: QuoteStaleness;
    if (entry.isFallback) {
      staleness = "fallback";
    } else if (ageMs < this.freshTtlMs) {
      staleness = "fresh";
    } else {
      staleness = "stale";
    }

    const source: QuoteSource = entry.isFallback ? "fallback" : ageMs < this.freshTtlMs ? "coingecko" : "cache";

    return {
      pair: entry.pair,
      srcUsd: entry.srcUsd,
      dstUsd: entry.dstUsd,
      rate: entry.rate,
      source,
      staleness,
      fetchedAt: entry.fetchedAt,
      ageMs,
    };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private _hardcodedFallback(pair: string): CacheEntry {
    const prices = FALLBACK_PRICES[pair] ?? { srcUsd: null, dstUsd: null };
    return {
      pair,
      srcUsd: prices.srcUsd,
      dstUsd: prices.dstUsd,
      rate: prices.srcUsd !== null && prices.dstUsd !== null && prices.dstUsd > 0
        ? prices.srcUsd / prices.dstUsd
        : null,
      fetchedAt: Date.now(),
      isFallback: true,
    };
  }

  private _geckoIds(pair: string): string {
    return this._geckoIdPair(pair).join(",");
  }

  private _geckoIdPair(pair: string): [string, string] {
    const MAP: Record<string, [string, string]> = {
      "ETH-XLM": ["ethereum", "stellar"],
      "ETH-SOL": ["ethereum", "solana"],
    };
    const ids = MAP[pair];
    if (!ids) throw new Error(`Unsupported quote pair: ${pair}`);
    return ids;
  }
}
