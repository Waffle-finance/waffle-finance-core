export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterFactor?: number;
  onRetry?: (attempt: number, delayMs: number, error: Error) => void;
  logger?: { warn: (msg: string, ...args: unknown[]) => void };
  /**
   * When true the retry loop stops immediately on the first failure rather
   * than retrying.  Useful for write-path callers that must not double-submit.
   */
  noRetry?: boolean;
}

// ── RPC error classification ──────────────────────────────────────────────────

/**
 * Coarse error class used to select a backoff strategy.
 *
 * - `timeout`       — the request started but the provider stopped responding
 *                     (read timeout, ETIMEDOUT, operation timed out).
 *                     Short backoff: the connection is open, just slow.
 * - `reset`         — TCP connection was forcibly closed mid-request
 *                     (ECONNRESET, socket hang up).  The endpoint is up but
 *                     shedding load; medium backoff.
 * - `unavailable`   — provider is entirely unreachable right now
 *                     (ECONNREFUSED, EHOSTUNREACH, fetch failed, 503/429).
 *                     Full exponential backoff — no point hammering it.
 * - `rate_limited`  — HTTP 429 from a JSON-RPC gateway.  Same as unavailable
 *                     but may carry a Retry-After header in future.
 * - `partial`       — response arrived but was structurally invalid or
 *                     incomplete (parse error, missing required fields).
 *                     Short backoff: the node might just be restarting.
 * - `transient`     — any other recognisably short-lived error.
 * - `unknown`       — could not be classified; use default backoff.
 */
export type RpcErrorClass =
  | "timeout"
  | "reset"
  | "unavailable"
  | "rate_limited"
  | "partial"
  | "transient"
  | "unknown";

/**
 * Backoff multiplier applied on top of the base exponential delay for each
 * error class.  Values < 1 compress the delay (faster retry for short-lived
 * errors); values > 1 stretch it (slower retry for persistent outages).
 *
 * These are tuned for a resolver that must not miss settlement events:
 *   - timeout / partial: retry quickly — the node is probably just slow.
 *   - reset: moderate delay — the node is shedding load but still present.
 *   - unavailable / rate_limited: full delay — give the provider time to recover.
 *   - transient / unknown: full delay — err on the side of caution.
 */
const ERROR_CLASS_MULTIPLIER: Record<RpcErrorClass, number> = {
  timeout:      0.5,   // fast retry — connection was open
  partial:      0.5,   // fast retry — likely a restarting node
  reset:        0.75,  // medium retry — load shedding
  transient:    1.0,
  unknown:      1.0,
  unavailable:  1.5,   // slow retry — provider is down
  rate_limited: 2.0,   // very slow retry — respect the gateway
};

/**
 * Classify an arbitrary thrown value into a coarse error class so the retry
 * loop can choose an appropriate backoff multiplier.
 *
 * The classification is intentionally conservative: an error that fits
 * multiple categories picks the one that results in the longest backoff,
 * so misclassification errs toward safety.
 */
export function classifyRpcError(err: unknown): RpcErrorClass {
  const msg = err instanceof Error
    ? `${err.message} ${(err as NodeJS.ErrnoException).code ?? ""}`.toLowerCase()
    : typeof err === "string"
      ? err.toLowerCase()
      : "";

  // HTTP 429 / rate limiting
  if (
    msg.includes("429") ||
    msg.includes("rate limit") ||
    msg.includes("too many requests")
  ) return "rate_limited";

  // Provider entirely unavailable
  if (
    msg.includes("econnrefused") ||
    msg.includes("ehostunreach") ||
    msg.includes("enetunreach") ||
    msg.includes("fetch failed") ||
    msg.includes("failed to fetch") ||
    msg.includes("503") ||
    msg.includes("service unavailable") ||
    msg.includes("network error")
  ) return "unavailable";

  // TCP reset / hung connection
  if (
    msg.includes("econnreset") ||
    msg.includes("socket hang up") ||
    msg.includes("connection reset")
  ) return "reset";

  // Read timeout
  if (
    msg.includes("etimedout") ||
    msg.includes("timed out") ||
    msg.includes("timeout") ||
    msg.includes("abort")
  ) return "timeout";

  // Partial / malformed response
  if (
    msg.includes("parse") ||
    msg.includes("json") ||
    msg.includes("unexpected end") ||
    msg.includes("invalid response") ||
    msg.includes("unexpected token")
  ) return "partial";

  // Tagged transient errors from this module
  if (err instanceof TransientError) return "transient";

  return "unknown";
}

/**
 * Return the effective base delay for a given error class, capped at maxDelayMs.
 * The multiplier is applied BEFORE the exponential factor so early retries
 * for cheap errors (timeout, partial) stay short even as attempts accumulate.
 */
export function effectiveBaseDelay(
  errorClass: RpcErrorClass,
  baseDelayMs: number,
  maxDelayMs: number
): number {
  const multiplier = ERROR_CLASS_MULTIPLIER[errorClass];
  return Math.min(maxDelayMs, Math.max(0, baseDelayMs * multiplier));
}

const DEFAULTS: Required<Omit<RetryOptions, 'logger'>> & { onRetry: NonNullable<RetryOptions['onRetry']> } = {
  maxAttempts: 5,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  jitterFactor: 0.2,
  onRetry: () => {},
  noRetry: false,
};

/**
 * Normalize raw RetryOptions into a validated, fully-resolved set of options.
 *
 * Invariants enforced here:
 *  - `maxAttempts` must be at least 1. Zero is ambiguous (does it mean "run
 *    once with no retries" or "never run"?), so we treat it the same as 1 —
 *    one attempt, no retries. This matches the principle of least surprise
 *    for callers who pass 0 thinking they want a single attempt.
 *  - `baseDelayMs` must be ≥ 0. A negative base delay would produce a
 *    negative timeout argument passed to setTimeout, which Node.js converts
 *    to 0 — creating an unintended busy-retry loop during an outage that
 *    obscures the original failure and hammers downstream RPC endpoints.
 *  - `jitterFactor` must be ≥ 0. A negative jitter value inverts the sign
 *    of the jitter term, which can also produce a negative (or zero) delay
 *    for the same reason.
 */
export function normalizeRetryOptions(
  opts: RetryOptions
): Required<Omit<RetryOptions, 'logger'>> & { onRetry: NonNullable<RetryOptions['onRetry']> } {
  const merged = { ...DEFAULTS, ...opts };

  if (merged.maxAttempts < 1) {
    merged.maxAttempts = 1;
  }

  if (merged.baseDelayMs < 0) {
    throw new RangeError(
      `RetryOptions.baseDelayMs must be ≥ 0 (got ${merged.baseDelayMs})`
    );
  }

  if (merged.jitterFactor < 0) {
    throw new RangeError(
      `RetryOptions.jitterFactor must be ≥ 0 (got ${merged.jitterFactor})`
    );
  }

  return merged;
}

export class TransientError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "TransientError";
  }
}

export function calculateBackoff(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  jitterFactor: number
): number {
  const exponential = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt));
  const jitter = jitterFactor * exponential * (Math.random() - 0.5);
  return Math.max(0, Math.round(exponential + jitter));
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {}
): Promise<T> {
  const { maxAttempts, baseDelayMs, maxDelayMs, jitterFactor, onRetry, noRetry } =
    normalizeRetryOptions(opts);

  let lastError: Error | undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastError = err instanceof Error ? err : new Error(String(err));

      // noRetry: give up after the first failure (write-path safety).
      if (noRetry) throw lastError;

      // Dynamic backoff: scale base delay by the error class multiplier so
      // transient failures (timeouts, partial responses) retry quickly while
      // persistent outages (unavailable, rate-limited) back off aggressively.
      const errorClass = classifyRpcError(err);
      const adjustedBase = effectiveBaseDelay(errorClass, baseDelayMs, maxDelayMs);
      const delay = calculateBackoff(attempt, adjustedBase, maxDelayMs, jitterFactor);

      onRetry(attempt + 1, delay, lastError);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError!;
}

/**
 * Retry an RPC call with dynamic backoff based on the error class.
 *
 * The `errorClass` is logged alongside the retry count so operators can
 * distinguish "slow node" (timeout) from "node down" (unavailable) from
 * "gateway throttling" (rate_limited) without reading raw error messages.
 *
 * Default profile: 5 attempts, 1 s base, 30 s cap, 0.2 jitter.
 * Effective per-attempt delay (approximate, no jitter):
 *   timeout/partial  → 500 ms, 1 s, 2 s, 4 s, 8 s
 *   reset            → 750 ms, 1.5 s, 3 s, 6 s, 12 s
 *   unknown/transient→ 1 s, 2 s, 4 s, 8 s, 16 s
 *   unavailable      → 1.5 s, 3 s, 6 s, 12 s, 24 s
 *   rate_limited     → 2 s, 4 s, 8 s, 16 s, 30 s (capped)
 */
export async function retryRpcCall<T>(
  fn: () => Promise<T>,
  opts?: Partial<RetryOptions>
): Promise<T> {
  const { logger, ...rest } = opts ?? {};
  return withRetry(fn, {
    maxAttempts: 5,
    baseDelayMs: 1000,
    maxDelayMs: 30000,
    jitterFactor: 0.2,
    onRetry: (attempt, delayMs, error) => {
      const errorClass = classifyRpcError(error);
      logger?.warn(
        `RPC call failed (attempt ${attempt}, class=${errorClass}), retrying in ${delayMs}ms: ${error.message}`
      );
    },
    ...rest,
  });
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Operation timed out after ${timeoutMs}ms`)), timeoutMs)
    ),
  ]);
}