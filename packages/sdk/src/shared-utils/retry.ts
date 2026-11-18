/**
 * Shared retry utilities with exponential backoff and jitter.
 *
 * This module consolidates retry logic used across packages to ensure
 * consistent behavior and reduce maintenance cost.
 */

export interface RetryPolicy {
  /** Maximum number of attempts (including the first try). Default: 5. */
  maxAttempts?: number;
  /** Base delay in ms before the first retry. Default: 500. */
  baseDelayMs?: number;
  /** Maximum delay cap in ms between retries. Default: 30000. */
  maxDelayMs?: number;
  /** Add random jitter up to this many ms. Default: 200. */
  jitterMs?: number;
  /**
   * Return false to bypass further retries and rethrow the error immediately.
   * Use this to short-circuit on errors you know are not worth retrying.
   */
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  /**
   * Called after each failed attempt (before the delay sleep).
   * Useful for emitting structured log entries with attempt / delay context.
   */
  onRetry?: (meta: {
    attempt: number;
    maxAttempts: number;
    delayMs: number;
    err: unknown;
  }) => void;
}

/**
 * Execute `fn` with exponential backoff and jitter.
 *
 * Returns the result on success or throws the last error after exhausting all attempts.
 */
export async function retryAsync<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy = {}
): Promise<T> {
  const {
    maxAttempts = 5,
    baseDelayMs = 500,
    maxDelayMs = 30_000,
    jitterMs = 200,
    shouldRetry,
    onRetry,
  } = policy;

  validateRetryPolicy({ maxAttempts, baseDelayMs, maxDelayMs, jitterMs });

  let attempt = 0;

  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt++;

      // Check if caller wants to short-circuit
      if (shouldRetry && !shouldRetry(err, attempt)) {
        throw err;
      }

      // Exhausted all attempts
      if (attempt >= maxAttempts) {
        throw err;
      }

      const delayMs = calculateBackoff(attempt, baseDelayMs, maxDelayMs, jitterMs);

      onRetry?.({ attempt, maxAttempts, delayMs, err });

      await sleep(delayMs);
    }
  }
}

/**
 * Synchronous retry for operations that don't need async.
 *
 * @param fn Function to retry
 * @param policy Retry policy
 */
export function retrySync<T>(
  fn: () => T,
  policy: RetryPolicy = {}
): T {
  const {
    maxAttempts = 5,
    shouldRetry,
    onRetry,
  } = policy;

  if (!Number.isInteger(maxAttempts) || maxAttempts <= 0) {
    throw new RangeError(`maxAttempts must be a positive integer, got ${maxAttempts}`);
  }

  let attempt = 0;
  let lastErr: unknown;

  while (attempt < maxAttempts) {
    try {
      return fn();
    } catch (err) {
      lastErr = err;
      attempt++;

      if (shouldRetry && !shouldRetry(err, attempt)) {
        throw err;
      }

      if (attempt >= maxAttempts) {
        throw err;
      }

      // For sync operations, we just track attempts without sleeping
      onRetry?.({ attempt, maxAttempts, delayMs: 0, err });
    }
  }

  throw lastErr;
}

/**
 * Calculate exponential backoff delay with jitter.
 */
function calculateBackoff(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  jitterMs: number
): number {
  const expBackoff = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
  const jitter = Math.floor(Math.random() * jitterMs);
  return expBackoff + jitter;
}

/**
 * Sleep for the specified duration.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Validate retry policy parameters.
 */
function validateRetryPolicy(policy: {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterMs: number;
}): void {
  const { maxAttempts, baseDelayMs, maxDelayMs, jitterMs } = policy;

  if (!Number.isInteger(maxAttempts) || maxAttempts <= 0) {
    throw new RangeError(`maxAttempts must be a positive integer, got ${maxAttempts}`);
  }

  if (baseDelayMs < 0) {
    throw new RangeError(`baseDelayMs must be non-negative, got ${baseDelayMs}`);
  }

  if (maxDelayMs < 0) {
    throw new RangeError(`maxDelayMs must be non-negative, got ${maxDelayMs}`);
  }

  if (jitterMs < 0) {
    throw new RangeError(`jitterMs must be non-negative, got ${jitterMs}`);
  }
}

/**
 * Common retry policies for different scenarios.
 */
export const RetryPolicies = {
  /** Fast retry for real-time operations (3 attempts, 100ms base, 5s max) */
  fast: {
    maxAttempts: 3,
    baseDelayMs: 100,
    maxDelayMs: 5_000,
    jitterMs: 50,
  } as RetryPolicy,

  /** Standard retry for most operations (5 attempts, 500ms base, 30s max) */
  standard: {
    maxAttempts: 5,
    baseDelayMs: 500,
    maxDelayMs: 30_000,
    jitterMs: 200,
  } as RetryPolicy,

  /** Aggressive retry for critical operations (10 attempts, 1s base, 60s max) */
  aggressive: {
    maxAttempts: 10,
    baseDelayMs: 1_000,
    maxDelayMs: 60_000,
    jitterMs: 500,
  } as RetryPolicy,

  /** Network-specific retry (handles timeouts and transient failures) */
  network: {
    maxAttempts: 5,
    baseDelayMs: 1_000,
    maxDelayMs: 30_000,
    jitterMs: 500,
    shouldRetry: (err: unknown) => {
      const msg = err instanceof Error ? err.message.toLowerCase() : "";
      return (
        msg.includes("timeout") ||
        msg.includes("network") ||
        msg.includes("econnreset") ||
        msg.includes("econnrefused") ||
        msg.includes("etimedout")
      );
    },
  } as RetryPolicy,
} as const;
