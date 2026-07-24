// src/retry.ts
/**
 * Retry utilities for coordinator startup and runtime dependency checks.
 *
 * Design goals:
 *  - Distinguish fatal configuration errors from transient service outages.
 *  - Provide structured logging hooks so callers can emit context-rich
 *    log entries rather than raw console output.
 *  - Support a `shouldRetry` predicate so callers can escalate certain
 *    errors to fatal without swallowing them in the retry loop.
 */

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
    maxAttempts = 5,
    baseDelayMs = 500,
    maxDelayMs = 30_000,
    jitterMs = 200,
    shouldRetry,
    onRetry,
  } = opts;

  let attempt = 0;

  while (true) {
    try {
      return await fn();
    } catch (err) {
      // FatalStartupError is never retried — propagate immediately.
      if (err instanceof FatalStartupError) {
        throw err;
      }

      // Caller-supplied predicate can mark any error as non-retryable.
      if (shouldRetry && !shouldRetry(err)) {
        throw err;
      }

      attempt++;

      if (attempt >= maxAttempts) {
        throw err;
      }

      const expBackoff = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      const jitter = Math.floor(Math.random() * jitterMs);
      const delayMs = expBackoff + jitter;

      onRetry?.({ attempt, maxAttempts, delayMs, err });

      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
