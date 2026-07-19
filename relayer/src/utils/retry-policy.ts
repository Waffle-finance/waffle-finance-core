/**
 * Exponential backoff with jitter for RPC retries.
 *
 * Strategy:
 *   delay = min(maxMs, baseMs * 2^attempt) +- jitter
 *
 * The jitter spreads retries across time so a burst of failures doesn't
 * cause a thundering-herd of simultaneous reconnection attempts against
 * the same public RPC endpoint.
 */

export interface RetryOptions {
  /** Base delay in ms (doubles each attempt). Defaults to 1_000. */
  baseDelayMs?: number;
  /** Hard cap on delay. Defaults to 30_000. */
  maxDelayMs?: number;
  /** Max retries before throwing. Defaults to 5. */
  maxRetries?: number;
  /** Jitter as fraction of the current delay (0 = no jitter, 0.2 = ┬▒20%). */
  jitterFactor?: number;
  /** Called before each retry attempt. Useful for logging. */
  onRetry?: (attempt: number, delayMs: number, error: Error) => void;
}

const DEFAULTS: Required<RetryOptions> = {
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  maxRetries: 5,
  jitterFactor: 0.2,
  onRetry: () => {},
};

/**
 * Calculate the delay for a given retry attempt.
 * Exported for testing ΓÇö callers should normally use `withRetry`.
 */
export function calculateDelay(
  attempt: number,
  baseMs: number,
  maxMs: number,
  jitterFactor: number = 0.2,
): number {
  const exponential = Math.min(maxMs, baseMs * Math.pow(2, attempt));
  const jitter = jitterFactor * exponential * (Math.random() - 0.5);
  return Math.max(0, Math.round(exponential + jitter));
}

/**
 * Wrap an async function with exponential backoff retry logic.
 *
 * @example
 *   const data = await withRetry(() => provider.getBlockNumber(), { maxRetries: 3 });
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const { baseDelayMs, maxDelayMs, maxRetries, jitterFactor, onRetry } = {
    ...DEFAULTS,
    ...options,
  };

  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxRetries) {
        const delay = calculateDelay(attempt, baseDelayMs, maxDelayMs, jitterFactor);
        onRetry(attempt, delay, lastError);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError!;
}