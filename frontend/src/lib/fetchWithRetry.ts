/**
 * Retry-aware fetch wrapper with exponential backoff and stale-while-revalidate support
 */

interface FetchWithRetryOptions extends RequestInit {
  maxRetries?: number;
  retryDelayMs?: number;
  retryableStatuses?: number[];
  onRetry?: (attempt: number, error: Error) => void;
  fetcher?: typeof fetch;
}

const DEFAULT_RETRYABLE_STATUSES = [408, 429, 500, 502, 503, 504];
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof TypeError && error.message.includes('fetch')) {
    // Network errors (offline, DNS, etc.)
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
 * then fetches fresh data in the background
 */
export async function fetchWithStaleWhileRevalidate<T>(
  url: string,
  cacheKey: string,
  options: FetchWithRetryOptions = {},
  parser: (response: Response) => Promise<T> = (r) => r.json()
): Promise<{ data: T; isStale: boolean }> {
  // Try to get cached data
  const cached = getCachedData<T>(cacheKey);
  
  // Start background refresh
  const refreshPromise = fetchWithRetry(url, options)
    .then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await parser(response);
      setCachedData(cacheKey, data);
      return data;
    })
    .catch((error) => {
      console.warn(`Background refresh failed for ${cacheKey}:`, error);
      throw error;
    });

  // Return cached data immediately if available
  if (cached) {
    return { data: cached, isStale: true };
  }

  // Otherwise wait for fresh data
  try {
    const freshData = await refreshPromise;
    return { data: freshData, isStale: false };
  } catch (error) {
    // If refresh fails and we have cached data, use it
    if (cached) {
      return { data: cached, isStale: true };
    }
    throw error;
  }
}

const CACHE_PREFIX = 'wafflefinance_api_cache_v1';
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getCachedData<T>(key: string): T | null {
  try {
    const item = localStorage.getItem(`${CACHE_PREFIX}:${key}`);
    if (!item) return null;

    const { data, timestamp } = JSON.parse(item);
    const age = Date.now() - timestamp;

    if (age > DEFAULT_CACHE_TTL_MS) {
      localStorage.removeItem(`${CACHE_PREFIX}:${key}`);
      return null;
    }

    return data as T;
  } catch (error) {
    console.warn('Failed to parse cached data:', error);
    return null;
  }
}

function setCachedData<T>(key: string, data: T): void {
  try {
    const item = {
      data,
      timestamp: Date.now(),
    };
    localStorage.setItem(`${CACHE_PREFIX}:${key}`, JSON.stringify(item));
  } catch (error) {
    console.warn('Failed to cache data:', error);
  }
}

export function clearApiCache(): void {
  const keys = Object.keys(localStorage);
  for (const key of keys) {
    if (key.startsWith(CACHE_PREFIX)) {
      localStorage.removeItem(key);
    }
  }
}
