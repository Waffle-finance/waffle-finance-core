// src/retry.ts
/**
 * Retry utilities for coordinator startup and runtime dependency checks.
 *
 * Re-exports the shared retry implementation from @wafflefinance/sdk with
 * coordinator-specific policies and the FatalStartupError class.
 */

export {
  retryAsync as retryAsyncBase,
  type RetryPolicy,
} from "@wafflefinance/sdk";

// ── FatalStartupError ────────────────────────────────────────────────────────

/**
 * Throw a FatalStartupError to signal that a startup failure is NOT
 * recoverable and should not be retried. Examples: bad database URL format,
 * schema version mismatch, missing required environment variables.
 *
 * The coordinator's `retryAsync` wrapper propagates these immediately without
 * waiting for the backoff delay or consuming remaining attempts.
 */
export class FatalStartupError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "FatalStartupError";
  }
}

// ── RetryOptions ─────────────────────────────────────────────────────────────

export interface RetryOptions {
  /** Maximum number of attempts (including the first try). Default: 5. */
  maxAttempts?: number;
  /** Base delay in ms before the first retry. Default: 500. */
  baseDelayMs?: number;
  /** Maximum delay cap in ms between retries. Default: 30 000. */
  maxDelayMs?: number;
  /** Add random jitter up to this many ms. Default: 200. */
  jitterMs?: number;
  /**
   * Return false to bypass further retries and rethrow the error immediately.
   * Use this to short-circuit on errors you know are not worth retrying
   * (e.g. schema version mismatches, bad credentials).
   *
   * FatalStartupError instances are always treated as non-retryable regardless
   * of this predicate.
   */
  shouldRetry?: (err: unknown) => boolean;
  /**
   * Called after each failed attempt (before the delay sleep).
   * Useful for emitting structured log entries with attempt / delay context.
   */
  onRetry?: (opts: { attempt: number; maxAttempts: number; delayMs: number; err: unknown }) => void;
}

// ── retryAsync ───────────────────────────────────────────────────────────────

/**
 * Execute `fn` with exponential backoff and jitter.
 *
 * - FatalStartupError is always re-thrown immediately (no delay, no retry).
 * - `opts.shouldRetry` is consulted on every failure; returning false also
 *   causes an immediate re-throw so callers retain full control.
 * - Structured retry metadata is surfaced via `opts.onRetry` so the caller
 *   can emit context-rich log entries.
 */
export async function retryAsync<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {}
): Promise<T> {
  const {
    shouldRetry: userShouldRetry,
    onRetry,
    ...restOpts
  } = opts;

  // Wrap shouldRetry to check for FatalStartupError first
  const shouldRetry = (err: unknown, attempt: number): boolean => {
    // FatalStartupError is never retried — propagate immediately.
    if (err instanceof FatalStartupError) {
      return false;
    }

    // Caller-supplied predicate can mark any error as non-retryable.
    if (userShouldRetry && !userShouldRetry(err)) {
      return false;
    }

    return true;
  };

  return retryAsyncBase(fn, {
    ...restOpts,
    shouldRetry,
    onRetry: onRetry
      ? ({ attempt, delayMs, err }) =>
          onRetry({
            attempt,
            maxAttempts: opts.maxAttempts ?? 5,
            delayMs,
            err,
          })
      : undefined,
  });
}
