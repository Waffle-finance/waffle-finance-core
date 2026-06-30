export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterFactor?: number;
  onRetry?: (attempt: number, delayMs: number, error: Error) => void;
  logger?: { warn: (msg: string, ...args: unknown[]) => void };
}

const DEFAULTS: Required<Omit<RetryOptions, 'logger'>> & { onRetry: NonNullable<RetryOptions['onRetry']> } = {
  maxAttempts: 5,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  jitterFactor: 0.2,
  onRetry: () => {},
};

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
  const { maxAttempts, baseDelayMs, maxDelayMs, jitterFactor, onRetry } = {
    ...DEFAULTS,
    ...opts,
  };

  let lastError: Error | undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const delay = calculateBackoff(attempt, baseDelayMs, maxDelayMs, jitterFactor);
      onRetry(attempt + 1, delay, lastError);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError!;
}

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
      logger?.warn(
        `RPC call failed (attempt ${attempt}), retrying in ${delayMs}ms: ${error.message}`
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