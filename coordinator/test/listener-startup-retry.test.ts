/**
 * listener-startup-retry.test.ts
 *
 * Coordinator listener startup retry contract tests.
 *
 * Background
 * ----------
 * Listener startup can fail transiently when an RPC endpoint is temporarily
 * unavailable (ECONNREFUSED, 503, timeout).  The coordinator's `retryAsync`
 * utility (coordinator/src/retry.ts) provides capped exponential backoff with
 * optional jitter — the same helper used for database and RPC probe retries
 * in index.ts.
 *
 * These tests verify that a bounded retry policy applied to listener.start()
 * behaves correctly without requiring any deployed service, real network I/O,
 * or wall-clock delays.
 *
 * Acceptance criteria verified here
 * -----------------------------------
 *  1. Retries are bounded — the loop never busy-waits and stops after
 *     maxAttempts, producing a clear error signal.
 *  2. A successful later attempt starts each listener exactly once (no
 *     double-start on retry).
 *  3. Exhausted retries produce a clear readiness/log signal — onRetry is
 *     called for every failed attempt and the final error is re-thrown.
 *  4. No external services required — all providers are pure in-process fakes.
 *
 * Design
 * ------
 * - A "fake listener" is a minimal object with a `start(): Promise<void>` method
 *   and a `startCount` counter — no real viem/stellar/solana imports.
 * - Delays are zeroed out (baseDelayMs:0, maxDelayMs:0, jitterMs:0) so tests
 *   run in microseconds.
 * - The onRetry callback is used to assert metadata shape, matching what
 *   index.ts passes to its retryAsync calls (attempt, maxAttempts, delayMs, err).
 * - FatalStartupError bypasses the loop immediately (existing coordinator
 *   contract) — we confirm this behaviour holds for listener startup too.
 */

import { describe, it, expect, vi } from 'vitest';
import { retryAsync, FatalStartupError, type RetryOptions } from '../src/retry.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Zero-delay retry wrapper — identical to the fastRetry helper in
 * startup.test.ts, kept here so this file is self-contained.
 */
function fastRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  return retryAsync(fn, { baseDelayMs: 0, maxDelayMs: 0, jitterMs: 0, ...opts });
}

/**
 * Build a fake listener whose start() method fails `failCount` times with an
 * RPC-like error, then succeeds.  Tracks the total number of start() calls.
 */
function makeFakeListener(failCount: number, label = 'ethereum') {
  let startCount = 0;
  let callsBeforeSuccess = failCount;

  return {
    label,
    /** Total successful + failed start() calls. */
    get startCount() { return startCount; },

    async start(): Promise<void> {
      startCount++;
      if (callsBeforeSuccess > 0) {
        callsBeforeSuccess--;
        throw new Error(`ECONNREFUSED: RPC endpoint unavailable (${label})`);
      }
      // Success — the listener is now running.
    },

    stop(): void { /* no-op for lifecycle tests */ },
  };
}

/**
 * Wrap a listener's start() with the coordinator retry policy.
 * Mirrors the wrapper that would be added around ethListener.start() in
 * index.ts with the production-equivalent options (but zero delays for tests).
 */
function startWithRetry(
  listener: ReturnType<typeof makeFakeListener>,
  opts: Partial<RetryOptions> = {}
): Promise<void> {
  return fastRetry(() => listener.start(), {
    maxAttempts: 5,
    ...opts,
  });
}

// ── 1. Retries are bounded and do not busy-loop ───────────────────────────────

describe('listener startup retry — bounded retries', () => {
  it('stops retrying after maxAttempts and re-throws the last error', async () => {
    const listener = makeFakeListener(99); // will always fail within 5 attempts

    const err = await startWithRetry(listener, { maxAttempts: 3 }).catch(e => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('ECONNREFUSED');
    // 3 attempts exactly — no busy-loop past the cap.
    expect(listener.startCount).toBe(3);
  });

  it('attempt count is exactly maxAttempts on total failure', async () => {
    const listener = makeFakeListener(99);
    const attempts: number[] = [];

    await startWithRetry(listener, {
      maxAttempts: 4,
      onRetry: ({ attempt }) => attempts.push(attempt),
    }).catch(() => {});

    // onRetry fires for attempts 1, 2, 3 (not the final exhausted attempt 4)
    expect(attempts).toEqual([1, 2, 3]);
    expect(listener.startCount).toBe(4);
  });

  it('does not start the listener at all after maxAttempts: 1 fails', async () => {
    const listener = makeFakeListener(1);

    await startWithRetry(listener, { maxAttempts: 1 }).catch(() => {});

    // Called once, failed, no retries.
    expect(listener.startCount).toBe(1);
  });
});

// ── 2. Successful later attempt starts listener exactly once ─────────────────

describe('listener startup retry — eventual recovery', () => {
  it('starts the listener exactly once after transient failures', async () => {
    // Fail twice, succeed on the third attempt.
    const listener = makeFakeListener(2);

    await startWithRetry(listener, { maxAttempts: 5 });

    // start() was called 3 times total (2 failures + 1 success).
    expect(listener.startCount).toBe(3);
  });

  it('resolves on the very first attempt when start() succeeds immediately', async () => {
    const listener = makeFakeListener(0); // no failures

    await startWithRetry(listener, { maxAttempts: 5 });

    expect(listener.startCount).toBe(1);
  });

  it('resolves on the last allowed attempt (maxAttempts - 1 failures)', async () => {
    const listener = makeFakeListener(4); // fail 4 times, succeed on 5th

    await startWithRetry(listener, { maxAttempts: 5 });

    expect(listener.startCount).toBe(5);
  });

  it('starts each of multiple listeners exactly once on eventual recovery', async () => {
    const eth     = makeFakeListener(1, 'ethereum');
    const soroban = makeFakeListener(2, 'soroban');
    const solana  = makeFakeListener(0, 'solana');

    await Promise.all([
      startWithRetry(eth,     { maxAttempts: 5 }),
      startWithRetry(soroban, { maxAttempts: 5 }),
      startWithRetry(solana,  { maxAttempts: 5 }),
    ]);

    // Each listener started the minimum number of times required.
    expect(eth.startCount).toBe(2);     // 1 failure + 1 success
    expect(soroban.startCount).toBe(3); // 2 failures + 1 success
    expect(solana.startCount).toBe(1);  // immediate success
  });
});

// ── 3. Exhausted retries produce a clear onRetry/log signal ──────────────────

describe('listener startup retry — onRetry metadata', () => {
  it('onRetry is called for every failed attempt before exhaustion', async () => {
    const listener = makeFakeListener(99);
    const retryCalls: Array<{ attempt: number; maxAttempts: number; err: unknown }> = [];

    await startWithRetry(listener, {
      maxAttempts: 4,
      onRetry: ({ attempt, maxAttempts, err }) => retryCalls.push({ attempt, maxAttempts, err }),
    }).catch(() => {});

    // onRetry fires for attempts 1, 2, 3 (not the final exhausted attempt 4)
    expect(retryCalls).toHaveLength(3);
    expect(retryCalls[0].attempt).toBe(1);
    expect(retryCalls[1].attempt).toBe(2);
    expect(retryCalls[2].attempt).toBe(3);
  });

  it('onRetry receives the correct maxAttempts value', async () => {
    const listener = makeFakeListener(99);
    const maxValues: number[] = [];

    await startWithRetry(listener, {
      maxAttempts: 3,
      onRetry: ({ maxAttempts }) => maxValues.push(maxAttempts),
    }).catch(() => {});

    expect(maxValues).toEqual([3, 3]); // 2 retries for maxAttempts:3
  });

  it('onRetry receives the thrown RPC error', async () => {
    const listener = makeFakeListener(2);
    const receivedErrors: Error[] = [];

    await startWithRetry(listener, {
      maxAttempts: 5,
      onRetry: ({ err }) => { if (err instanceof Error) receivedErrors.push(err); },
    });

    expect(receivedErrors).toHaveLength(2);
    expect(receivedErrors[0].message).toContain('ECONNREFUSED');
    expect(receivedErrors[1].message).toContain('ECONNREFUSED');
  });

  it('onRetry is NOT called when start() succeeds on the first attempt', async () => {
    const listener = makeFakeListener(0);
    const onRetry = vi.fn();

    await startWithRetry(listener, { maxAttempts: 5, onRetry });

    expect(onRetry).not.toHaveBeenCalled();
  });

  it('the error thrown on exhaustion is the last RPC error from start()', async () => {
    let callCount = 0;
    const errors = [
      new Error('ECONNREFUSED attempt 1'),
      new Error('ECONNREFUSED attempt 2'),
      new Error('ECONNREFUSED attempt 3'),
    ];

    const err = await fastRetry(
      async () => { throw errors[callCount++] ?? new Error('overflow'); },
      { maxAttempts: 3 }
    ).catch(e => e);

    expect(err).toBe(errors[2]); // exact last error instance
  });
});

// ── 4. shouldRetry: non-retryable RPC errors bypass the loop ─────────────────

describe('listener startup retry — shouldRetry predicate', () => {
  it('does not retry when shouldRetry returns false (e.g. bad config)', async () => {
    const listener = makeFakeListener(99);
    const onRetry = vi.fn();

    const err = await startWithRetry(listener, {
      maxAttempts: 5,
      shouldRetry: () => false, // treat every error as non-retryable
      onRetry,
    }).catch(e => e);

    expect(listener.startCount).toBe(1);  // no retries
    expect(onRetry).not.toHaveBeenCalled();
    expect(err).toBeInstanceOf(Error);
  });

  it('skips retries on schema-mismatch-style errors, retries on ECONNREFUSED', async () => {
    let call = 0;
    const errors = [
      new Error('ECONNREFUSED: temporary'),
      new Error('RPC_URL invalid — missing protocol'),
    ];

    const err = await fastRetry(
      async () => { throw errors[call++] ?? new Error('overflow'); },
      {
        maxAttempts: 5,
        shouldRetry: (e) => {
          const msg = e instanceof Error ? e.message : '';
          // Non-retryable: bad URL / config errors.
          if (msg.includes('invalid') || msg.includes('missing protocol')) return false;
          return true; // transient network errors are retryable
        },
      }
    ).catch(e => e);

    // First error: ECONNREFUSED → retried.
    // Second error: bad URL → not retried, thrown immediately.
    expect(call).toBe(2);
    expect((err as Error).message).toContain('RPC_URL invalid');
  });
});

// ── 5. FatalStartupError bypasses the retry loop immediately ─────────────────

describe('listener startup retry — FatalStartupError passthrough', () => {
  it('propagates FatalStartupError from start() without any retry', async () => {
    let callCount = 0;
    const fatal = new FatalStartupError('contract address not configured');

    const err = await fastRetry(async () => {
      callCount++;
      throw fatal;
    }, { maxAttempts: 5 }).catch(e => e);

    expect(err).toBe(fatal);
    expect(callCount).toBe(1);
  });

  it('FatalStartupError thrown on second attempt stops further retries', async () => {
    let callCount = 0;
    const fatal = new FatalStartupError('schema mismatch on startup');

    await fastRetry(async () => {
      callCount++;
      if (callCount === 1) throw new Error('ECONNREFUSED: transient');
      throw fatal;
    }, { maxAttempts: 5 }).catch(() => {});

    expect(callCount).toBe(2); // transient once, then fatal — no more
  });

  it('onRetry is NOT called before FatalStartupError is propagated', async () => {
    const onRetry = vi.fn();

    await fastRetry(async () => { throw new FatalStartupError('fatal'); }, {
      maxAttempts: 5,
      onRetry,
    }).catch(() => {});

    expect(onRetry).not.toHaveBeenCalled();
  });
});

// ── 6. Policy validates sane bounds (mirrors startup.test.ts guard) ──────────

describe('listener startup retry — bounds validation', () => {
  it('rejects maxAttempts: 0 with RangeError', async () => {
    await expect(
      fastRetry(async () => 'ok', { maxAttempts: 0 })
    ).rejects.toThrow('maxAttempts must be a positive integer');
  });

  it('rejects negative maxAttempts with RangeError', async () => {
    await expect(
      fastRetry(async () => 'ok', { maxAttempts: -1 })
    ).rejects.toThrow('maxAttempts must be a positive integer');
  });

  it('accepts maxAttempts: 1 (single attempt, no retry)', async () => {
    await expect(
      fastRetry(async () => 'ok', { maxAttempts: 1 })
    ).resolves.toBe('ok');
  });
});
