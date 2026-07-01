/**
 * Retry-aware fetch wrapper with exponential backoff and stale-while-revalidate support
 */

export interface CacheOptions {
  /** TTL for "fresh" data — served immediately without refresh (default: 15s). */
  freshTtlMs?: number;
  /** TTL for "stale" data — served immediately, background refresh triggered (default: 60s). */
  staleTtlMs?: number;
  /** Absolute max age — beyond this, caller blocks on a live fetch (default: 5min). */
  maxStaleTtlMs?: number;
  /** Bypass cache entirely and force a fresh fetch. */
  bypassCache?: boolean;
}

export type CacheStaleness = "fresh" | "stale" | "expired";

export interface FetchWithRetryOptions extends RequestInit {
  maxRetries?: number;
  retryDelayMs?: number;
  retryableStatuses?: number[];
  onRetry?: (attempt: number, error: Error) => void;
  fetcher?: typeof fetch;
}

interface StaleWhileRevalidateOptions extends FetchWithRetryOptions {
  cache?: CacheOptions;
  parser?: (response: Response) => Promise<any>;
}

const DEFAULT_RETRYABLE_STATUSES = [408, 429, 500, 502, 503, 504];
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof TypeError && error.message.includes('fetch')) {
    return true;
  }
  return false;
}

export async function fetchWithRetry(
  url: string,
  options: FetchWithRetryOptions = {}
): Promise<Response> {
  const {
    maxRetries = DEFAULT_MAX_RETRIES,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    retryableStatuses = DEFAULT_RETRYABLE_STATUSES,
    onRetry,
    fetcher = fetch,
    ...fetchOptions
  } = options;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetcher(url, fetchOptions);

      if (retryableStatuses.includes(response.status)) {
        const error = new Error(`HTTP ${response.status}: ${response.statusText}`);
        lastError = error;

        if (attempt < maxRetries) {
          onRetry?.(attempt + 1, error);
          await sleep(retryDelayMs * Math.pow(2, attempt));
          continue;
        }
      }

      return response;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (isRetryableError(error) && attempt < maxRetries) {
        onRetry?.(attempt + 1, lastError);
        await sleep(retryDelayMs * Math.pow(2, attempt));
        continue;
      }

      throw lastError;
    }
  }

  throw lastError || new Error('Max retries exceeded');
}

/**
 * Stale-while-revalidate fetch: returns cached data immediately if available,
 * then fetches fresh data in the background.
 *
 * Supports three-tier staleness: fresh / stale / expired.
 * Cache TTL is configurable per-key via `cacheOptions`.
 */
export async function fetchWithStaleWhileRevalidate<T>(
  url: string,
  cacheKey: string,
  options: StaleWhileRevalidateOptions = {}
): Promise<{ data: T; isStale: boolean; staleness: CacheStaleness }> {
  const cacheOpts: Required<CacheOptions> = {
    freshTtlMs: options.cache?.freshTtlMs ?? 15_000,
    staleTtlMs: options.cache?.staleTtlMs ?? 60_000,
    maxStaleTtlMs: options.cache?.maxStaleTtlMs ?? 5 * 60 * 1000,
    bypassCache: options.cache?.bypassCache ?? false,
  };

  // Bypass cache if requested
  if (cacheOpts.bypassCache) {
    try {
      const freshData = await doFetchAndCache(url, cacheKey, options);
      return { data: freshData, isStale: false, staleness: "fresh" };
    } catch (error) {
      // Fallback: try cache even in bypass mode
      const cached = getCachedDataWithAge<T>(cacheKey);
      if (cached !== null) {
        console.warn(`Bypass fetch failed for ${cacheKey}, serving cached fallback`);
        return { data: cached.data, isStale: true, staleness: "stale" };
      }
      throw error;
    }
  }

  // Normal path: check cache
  const cached = getCachedDataWithAge<T>(cacheKey);
  if (cached !== null) {
    let isStale: boolean;
    let staleness: CacheStaleness;

    if (cached.ageMs < cacheOpts.freshTtlMs) {
      isStale = false;
      staleness = "fresh";
    } else if (cached.ageMs < cacheOpts.staleTtlMs) {
      isStale = true;
      staleness = "stale";
    } else if (cached.ageMs < cacheOpts.maxStaleTtlMs) {
      isStale = true;
      staleness = "stale";
    } else {
      isStale = true;
      staleness = "expired";
    }

    if (staleness !== "expired") {
      // Start background refresh for stale data
      if (staleness === "stale") {
        refreshInBackground(url, cacheKey, options);
      }
      return { data: cached.data, isStale, staleness };
    }

    // Data is expired — remove it so we don't serve truly ancient data
    removeCachedData(cacheKey);
  }

  // No cache hit or expired: wait for fresh data
  try {
    const freshData = await doFetchAndCache(url, cacheKey, options);
    return { data: freshData, isStale: false, staleness: "fresh" };
  } catch (error) {
    // Last resort: check if any cached data survived (e.g. remove failed)
    const lastResort = getCachedDataWithAge<T>(cacheKey);
    if (lastResort !== null) {
      console.warn(`Fetch failed for ${cacheKey}, serving stale cache as fallback`);
      return { data: lastResort.data, isStale: true, staleness: "stale" };
    }
    throw error;
  }
}

async function refreshInBackground<T>(
  url: string,
  cacheKey: string,
  options: StaleWhileRevalidateOptions
): Promise<void> {
  try {
    await doFetchAndCache(url, cacheKey, options);
  } catch {
    // Background refresh failures are intentionally swallowed
  }
}

async function doFetchAndCache<T>(
  url: string,
  cacheKey: string,
  options: StaleWhileRevalidateOptions
): Promise<T> {
  const response = await fetchWithRetry(url, options);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await (options.parser?.(response) ?? response.json());
  setCachedData(cacheKey, data);
  return data as T;
}

const CACHE_PREFIX = 'wafflefinance_api_cache_v2';

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

interface CacheEntryWithAge<T> {
  data: T;
  ageMs: number;
}

function getCachedDataWithAge<T>(key: string): CacheEntryWithAge<T> | null {
  try {
    const item = localStorage.getItem(`${CACHE_PREFIX}:${key}`);
    if (!item) return null;

    const entry = JSON.parse(item) as CacheEntry<T>;
    if (!entry || typeof entry.timestamp !== 'number') return null;

    return {
      data: entry.data,
      ageMs: Date.now() - entry.timestamp,
    };
  } catch {
    return null;
  }
}

function setCachedData<T>(key: string, data: T): void {
  try {
    const entry: CacheEntry<T> = { data, timestamp: Date.now() };
    localStorage.setItem(`${CACHE_PREFIX}:${key}`, JSON.stringify(entry));
  } catch (error) {
    console.warn('Failed to cache data:', error);
  }
}

function removeCachedData(key: string): void {
  try {
    localStorage.removeItem(`${CACHE_PREFIX}:${key}`);
  } catch {
    // Silently ignore
  }
}

export function clearApiCache(): void {
  const keys = Object.keys(localStorage);
  for (const key of keys) {
    if (key.startsWith(CACHE_PREFIX) || key.startsWith('wafflefinance_api_cache_v1')) {
      localStorage.removeItem(key);
    }
  }
}
