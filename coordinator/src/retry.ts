// src/retry.ts
/**
 * Utility for retrying async functions with exponential backoff.
 * Used to make coordinator startup resilient to transient failures.
 */
export interface RetryOptions {
  /** Maximum number of attempts (including the first try) */
  maxAttempts?: number;
  /** Base delay in ms before the first retry */
  baseDelayMs?: number;
  /** Maximum delay in ms between retries */
  maxDelayMs?: number;
  /** Add random jitter up to this many ms */
  jitterMs?: number;
}

export async function retryAsync<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {}
): Promise<T> {
  const {
    maxAttempts = 5,
    baseDelayMs = 500,
    maxDelayMs = 10000,
    jitterMs = 200,
  } = opts;

  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (attempt >= maxAttempts) {
        throw err;
      }
      // exponential backoff
      const delay = Math.min(
        baseDelayMs * 2 ** (attempt - 1),
        maxDelayMs
      );
      const jitter = Math.floor(Math.random() * jitterMs);
      await new Promise((resolve) => setTimeout(resolve, delay + jitter));
    }
  }
}
