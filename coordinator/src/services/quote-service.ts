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
 *
 * `chain` identifies which blockchain the asset is on, enabling per-chain
 * freshness evaluation in the frontend.
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
  /** The source chain for this pair (e.g. "ethereum" for the src leg). */
  srcChain: string;
  /** The destination chain for this pair (e.g. "stellar" for the dst leg). */
  dstChain: string;
}

/** Cache statistics exposed for monitoring / debugging. */
export interface QuoteCacheStats {
  totalEntries: number;
  entries: Array<{
    pair: string;
    ageMs: number;
    staleness: QuoteStaleness;
    isFallback: boolean;
  }>;
  nextProactiveRefreshInMs: number;
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
  /** Source chain identifier (e.g. "ethereum"). */
  srcChain: string;
  /** Destination chain identifier (e.g. "stellar"). */
  dstChain: string;
  /** Number of refreshes this entry has gone through. */
  refreshCount: number;
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

  /**
   * Chain-specific TTL overrides keyed by chain name.
   * Allows specific chains to have tighter or looser freshness windows.
   * Example: { solana: { freshTtlMs: 10_000, staleTtlMs: 30_000 } }
   */
  perChainTtls?: Record<string, {
    freshTtlMs?: number;
    staleTtlMs?: number;
    maxStaleTtlMs?: number;
  }>;

  /**
   * Interval for proactive background refresh timer.
   * When set, the service will periodically refresh all cached entries before
   * they expire, reducing stale-serving latency.
   * Default: 0 (disabled — only reactive refresh).
   */
  proactiveRefreshIntervalMs?: number;
}

const DEFAULT_FRESH_TTL_MS = 15_000;
const DEFAULT_STALE_TTL_MS = 60_000;
const DEFAULT_MAX_STALE_TTL_MS = 5 * 60_000;

const PAIR_CHAIN_MAP: Record<string, { srcChain: string; dstChain: string }> = {
  "ETH-XLM": { srcChain: "ethereum", dstChain: "stellar" },
  "ETH-SOL": { srcChain: "ethereum", dstChain: "solana" },
};

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
  private readonly perChainTtls: NonNullable<QuoteServiceOptions["perChainTtls"]>;
  private readonly proactiveRefreshIntervalMs: number;

  /** In-memory cache — one entry per pair key. */
  private readonly cache = new Map<string, CacheEntry>();

  /**
   * Inflight refresh promises, keyed by pair. This is the thundering-herd
   * guard: a burst of requests for the same pair collapses into a single
   * upstream call.
   */
  private readonly inflight = new Map<string, Promise<CacheEntry>>();

  /** Proactive refresh timer handle, if enabled. */
  private proactiveTimer: ReturnType<typeof setInterval> | null = null;

  constructor(log: Logger, opts: QuoteServiceOptions = {}) {
    this.log = log;
    this.freshTtlMs = opts.freshTtlMs ?? DEFAULT_FRESH_TTL_MS;
    this.staleTtlMs = opts.staleTtlMs ?? DEFAULT_STALE_TTL_MS;
    this.maxStaleTtlMs = opts.maxStaleTtlMs ?? DEFAULT_MAX_STALE_TTL_MS;
    this.perChainTtls = opts.perChainTtls ?? {};
    this.proactiveRefreshIntervalMs = opts.proactiveRefreshIntervalMs ?? 0;

    if (this.proactiveRefreshIntervalMs > 0) {
      this._startProactiveRefresh();
    }
  }

  /**
   * Stop the proactive refresh timer. Call during shutdown to prevent
   * stale timer callbacks after the service is no longer needed.
   */
  stop(): void {
    if (this.proactiveTimer !== null) {
      clearInterval(this.proactiveTimer);
      this.proactiveTimer = null;
    }
  }

  /**
   * Return cache statistics for monitoring.
   */
  getStats(): QuoteCacheStats {
    const now = Date.now();
    const entries = Array.from(this.cache.entries()).map(([pair, entry]) => ({
      pair,
      ageMs: now - entry.fetchedAt,
      staleness: this._stalenessFor(entry) as QuoteStaleness,
      isFallback: entry.isFallback,
    }));

    return {
      totalEntries: this.cache.size,
      entries,
      nextProactiveRefreshInMs: this.proactiveTimer !== null
        ? this.proactiveRefreshIntervalMs
        : -1,
    };
  }

  // -------------------------------------------------------------------------
  // Per-chain TTL helpers
  // -------------------------------------------------------------------------

  private _chainForPair(pair: string): string | null {
    const chains = PAIR_CHAIN_MAP[pair];
    return chains?.srcChain ?? null;
  }

  private _effectiveFreshTtl(pair: string): number {
    const chain = this._chainForPair(pair);
    const override = chain ? this.perChainTtls[chain]?.freshTtlMs : undefined;
    return override ?? this.freshTtlMs;
  }

  private _effectiveStaleTtl(pair: string): number {
    const chain = this._chainForPair(pair);
    const override = chain ? this.perChainTtls[chain]?.staleTtlMs : undefined;
    return override ?? this.staleTtlMs;
  }

  private _effectiveMaxStaleTtl(pair: string): number {
    const chain = this._chainForPair(pair);
    const override = chain ? this.perChainTtls[chain]?.maxStaleTtlMs : undefined;
    return override ?? this.maxStaleTtlMs;
  }

  // -------------------------------------------------------------------------
  // Proactive refresh
  // -------------------------------------------------------------------------

  private _startProactiveRefresh(): void {
    this.proactiveTimer = setInterval(() => {
      for (const [pair] of this.cache) {
        const freshTtl = this._effectiveFreshTtl(pair);
        const staleTtl = this._effectiveStaleTtl(pair);
        const entry = this.cache.get(pair);
        if (!entry) continue;
        const age = Date.now() - entry.fetchedAt;

        // Proactively refresh when we're past 80% of the fresh window
        // or past 50% of the stale window — this keeps data fresh without
        // blocking user-facing requests.
        if (age >= freshTtl * 0.8 && age < staleTtl) {
          this._triggerBackgroundRefresh(pair);
        }
      }
    }, this.proactiveRefreshIntervalMs);

    if (this.proactiveTimer && typeof this.proactiveTimer === "object") {
      this.proactiveTimer.unref?.();
    }
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
   *
   * @param pair The pair key (e.g. "ETH-XLM").
   * @param options Optional overrides (e.g. force refresh).
   */
  async getQuote(pair: string, options?: { forceRefresh?: boolean }): Promise<QuoteSnapshot> {
    const entry = await this._resolve(pair, options);
    return this._toSnapshot(entry);
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

  private async _resolve(pair: string, options?: { forceRefresh?: boolean }): Promise<CacheEntry> {
    const now = Date.now();
    const cached = this.cache.get(pair);

    if (options?.forceRefresh) {
      return this._blockingFetch(pair);
    }

    if (cached) {
      const age = now - cached.fetchedAt;
      const freshTtl = this._effectiveFreshTtl(pair);
      const staleTtl = this._effectiveStaleTtl(pair);
      const maxStaleTtl = this._effectiveMaxStaleTtl(pair);

      if (age < freshTtl) {
        return cached;
      }

      if (age < staleTtl) {
        this._triggerBackgroundRefresh(pair);
        return cached;
      }

      if (age < maxStaleTtl) {
        this._triggerBackgroundRefresh(pair);
        return cached;
      }
    }

    return this._blockingFetch(pair);
  }

  /**
   * Block the caller on a live upstream fetch (de-duped across concurrent
   * callers so a burst collapses into a single network round-trip).
   */
  private async _blockingFetch(pair: string): Promise<CacheEntry> {
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

      // If we have a previous entry, mark it as fallback and refresh its
      // timestamp to prevent thundering-herd storms. The maxStaleTtl will
      // still cause subsequent callers to block on a live fetch if this
      // fallback entry itself becomes too old.
      const stale = this.cache.get(pair);
      if (stale) {
        const refreshed: CacheEntry = {
          ...stale,
          fetchedAt: Date.now(),
          isFallback: true,
          refreshCount: stale.refreshCount + 1,
        };
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

    const chains = PAIR_CHAIN_MAP[pair] ?? { srcChain: "unknown", dstChain: "unknown" };
    return {
      pair,
      srcUsd,
      dstUsd,
      rate: srcUsd / dstUsd,
      fetchedAt: Date.now(),
      isFallback: false,
      srcChain: chains.srcChain,
      dstChain: chains.dstChain,
      refreshCount: 0,
    };
  }

  // -------------------------------------------------------------------------
  // Snapshot projection
  // -------------------------------------------------------------------------

  private _stalenessFor(entry: CacheEntry): string {
    if (entry.isFallback) return "fallback";
    const now = Date.now();
    const ageMs = now - entry.fetchedAt;
    const freshTtl = this._effectiveFreshTtl(entry.pair);
    if (ageMs < freshTtl) return "fresh";
    return "stale";
  }

  private _toSnapshot(entry: CacheEntry): QuoteSnapshot {
    const now = Date.now();
    const ageMs = now - entry.fetchedAt;
    const freshTtl = this._effectiveFreshTtl(entry.pair);

    let staleness: QuoteStaleness;
    if (entry.isFallback) {
      staleness = "fallback";
    } else if (ageMs < freshTtl) {
      staleness = "fresh";
    } else {
      staleness = "stale";
    }

    const source: QuoteSource = entry.isFallback ? "fallback" : ageMs < freshTtl ? "coingecko" : "cache";

    return {
      pair: entry.pair,
      srcUsd: entry.srcUsd,
      dstUsd: entry.dstUsd,
      rate: entry.rate,
      source,
      staleness,
      fetchedAt: entry.fetchedAt,
      ageMs,
      srcChain: entry.srcChain,
      dstChain: entry.dstChain,
    };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private _hardcodedFallback(pair: string): CacheEntry {
    const prices = FALLBACK_PRICES[pair] ?? { srcUsd: null, dstUsd: null };
    const chains = PAIR_CHAIN_MAP[pair] ?? { srcChain: "unknown", dstChain: "unknown" };
    return {
      pair,
      srcUsd: prices.srcUsd,
      dstUsd: prices.dstUsd,
      rate: prices.srcUsd !== null && prices.dstUsd !== null && prices.dstUsd > 0
        ? prices.srcUsd / prices.dstUsd
        : null,
      fetchedAt: Date.now(),
      isFallback: true,
      srcChain: chains.srcChain,
      dstChain: chains.dstChain,
      refreshCount: 0,
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
