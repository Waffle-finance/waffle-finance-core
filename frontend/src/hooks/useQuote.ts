import { useCallback, useEffect, useRef, useState } from 'react';
import type { CacheStaleness } from '../lib/fetchWithRetry';
import { fetchWithStaleWhileRevalidate } from '../lib/fetchWithRetry';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PriceData {
  ethUsd: number;
  xlmUsd: number;
  solUsd: number;
  xlmPerEth: number | null;
  ethPerXlm: number | null;
  source: 'coingecko' | 'cache' | 'fallback';
  staleness: 'fresh' | 'stale' | 'fallback';
  fetchedAt: number;
  ageMs: number;
  pairs?: Array<{
    pair: string;
    srcChain: string;
    dstChain: string;
    staleness: string;
    ageMs: number;
    source: string;
  }>;
}

export interface QuoteState {
  /** Latest successful price data (may be stale). Never null after first fetch. */
  data: PriceData | null;
  /** True during the initial load (no data available yet). */
  isLoading: boolean;
  /** True during a background refresh (data already available). */
  isRefreshing: boolean;
  /** Simple staleness flag for quick UI decisions. */
  isStale: boolean;
  /** Detailed staleness level. */
  staleness: CacheStaleness | 'fallback' | null;
  /** Last error, if any. */
  error: Error | null;
  /** Force a fresh fetch. */
  refresh: (force?: boolean) => Promise<void>;
  /** Clear cached data. */
  clearCache: () => void;
}

export interface UseQuoteOptions {
  /** Base URL of the prices API. */
  apiBase: string;
  /** How often to proactively refresh in ms (default: 30_000). */
  refreshIntervalMs?: number;
  /** Fresh TTL in ms (default: 15_000). */
  freshTtlMs?: number;
  /** Stale TTL in ms (default: 60_000). */
  staleTtlMs?: number;
  /** Max stale TTL in ms (default: 5 min). */
  maxStaleTtlMs?: number;
  /** Enable periodic refresh (default: true). */
  enablePeriodicRefresh?: boolean;
}

const DEFAULT_OPTIONS: Required<UseQuoteOptions> = {
  apiBase: '',
  refreshIntervalMs: 30_000,
  freshTtlMs: 15_000,
  staleTtlMs: 60_000,
  maxStaleTtlMs: 5 * 60 * 1000,
  enablePeriodicRefresh: true,
};

const PRICES_CACHE_KEY = 'prices_v2';

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useQuote(userOptions: UseQuoteOptions): QuoteState {
  const opts = { ...DEFAULT_OPTIONS, ...userOptions };
  const { apiBase, refreshIntervalMs, freshTtlMs, staleTtlMs, maxStaleTtlMs, enablePeriodicRefresh } = opts;

  const [data, setData] = useState<PriceData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isStale, setIsStale] = useState(false);
  const [staleness, setStaleness] = useState<CacheStaleness | 'fallback' | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const inFlightRef = useRef(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastKnownGoodRef = useRef<PriceData | null>(null);

  const fetchPrices = useCallback(async (force: boolean = false) => {
    if (inFlightRef.current && !force) return;
    inFlightRef.current = true;

    const hadData = Boolean(data || lastKnownGoodRef.current);
    if (!hadData) setIsLoading(true);
    if (hadData) setIsRefreshing(true);
    setError(null);

    try {
      const url = `${apiBase}/api/prices${force ? '?force=true' : ''}`;
      const result = await fetchWithStaleWhileRevalidate<PriceData>(
        url,
        PRICES_CACHE_KEY,
        {
          maxRetries: 2,
          retryDelayMs: 1000,
          cache: {
            freshTtlMs,
            staleTtlMs,
            maxStaleTtlMs,
            bypassCache: force,
          },
        },
      );

      const priceData = result.data;

      // Validate that we got usable data
      if (!priceData || typeof priceData.ethUsd !== 'number' || priceData.ethUsd <= 0) {
        throw new Error('Invalid price data received');
      }

      setData(priceData);
      lastKnownGoodRef.current = priceData;
      setIsStale(result.isStale || priceData.staleness === 'stale' || priceData.staleness === 'fallback');
      setStaleness(
        priceData.staleness === 'fallback'
          ? 'fallback'
          : result.staleness
      );
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      setError(error);

      // Keep last-known-good data when fetch fails
      if (lastKnownGoodRef.current) {
        setData(lastKnownGoodRef.current);
        setIsStale(true);
        setStaleness('fallback');
      }
    } finally {
      inFlightRef.current = false;
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, [apiBase, freshTtlMs, staleTtlMs, maxStaleTtlMs, data]);

  // Initial fetch
  useEffect(() => {
    void fetchPrices();
  }, [fetchPrices]);

  // Periodic refresh
  useEffect(() => {
    if (!enablePeriodicRefresh) return;

    intervalRef.current = setInterval(() => {
      void fetchPrices();
    }, refreshIntervalMs);

    return () => {
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [enablePeriodicRefresh, refreshIntervalMs, fetchPrices]);

  // Refresh on visibility change (tab becomes active again)
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        void fetchPrices();
      }
    };

    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [fetchPrices]);

  const refresh = useCallback(async (force: boolean = false) => {
    await fetchPrices(force);
  }, [fetchPrices]);

  const clearCache = useCallback(() => {
    try {
      localStorage.removeItem(`wafflefinance_api_cache_v2:${PRICES_CACHE_KEY}`);
    } catch {
      // ignore
    }
  }, []);

  return {
    data,
    isLoading,
    isRefreshing,
    isStale,
    staleness,
    error,
    refresh,
    clearCache,
  };
}
