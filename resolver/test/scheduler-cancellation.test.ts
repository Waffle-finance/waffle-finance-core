/**
 * Tests: AbortSignal propagation through the resolver's retry and supervisor
 * scheduler paths.
 *
 * The resolver's withRetry already has full AbortSignal support
 * (resolver/src/retry.ts).  These tests verify:
 *
 *  1. retryRpcCall — signal cancels an in-flight delay between attempts.
 *  2. Supervisor restart sleep — stop() cancels the restart delay immediately
 *     so shutdown is not held up by an exponential back-off pause.
 *  3. Cancellation is distinguishable from retry exhaustion in both error type
 *     and log-readable name.
 *  4. No further attempt occurs after cancellation, and no dangling handles
 *     remain (fake-timer based verification).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import pino from "pino";
import {
  withRetry,
  retryRpcCall,
  RetryCancelledError,
  TransientError,
} from "../src/retry.js";
import { Supervisor, type ListenerSet } from "../src/supervisor.js";

afterEach(() => vi.useRealTimers());

const log = pino({ level: "silent" });

// ── 1. retryRpcCall cancellation ──────────────────────────────────────────────

describe("retryRpcCall — AbortSignal cancellation", () => {
  it("aborts during delay: no second attempt, rejects with RetryCancelledError", async () => {
    vi.useFakeTimers();
    const fn = vi.fn().mockRejectedValue(new Error("unavailable"));
    const controller = new AbortController();

    const promise = retryRpcCall(fn, {
      maxAttempts: 5,
      baseDelayMs: 5_000,
      maxDelayMs: 30_000,
      jitterFactor: 0,
      signal: controller.signal,
    });
    const assertion = expect(promise).rejects.toBeInstanceOf(RetryCancelledError);

    // Run first attempt.
    await vi.advanceTimersByTimeAsync(0);
    expect(fn).toHaveBeenCalledTimes(1);

    // Abort mid-backoff.
    controller.abort();
    await vi.advanceTimersByTimeAsync(30_000);

    await assertion;
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("already-aborted signal rejects immediately — fn is never called", async () => {
    const controller = new AbortController();
    controller.abort();
    const fn = vi.fn().mockResolvedValue("ok");

    await expect(
      retryRpcCall(fn, { signal: controller.signal }),
    ).rejects.toBeInstanceOf(RetryCancelledError);

    expect(fn).not.toHaveBeenCalled();
  });
});

// ── 2. withRetry — cancellation is distinguishable from exhaustion ────────────

describe("withRetry — RetryCancelledError vs exhaustion", () => {
  it("cancellation error name is RetryCancelledError, not a plain Error", async () => {
    vi.useFakeTimers();
    const fn = vi.fn().mockRejectedValue(new TransientError("rpc down"));
    const controller = new AbortController();

    const promise = withRetry(fn, {
      maxAttempts: 5,
      baseDelayMs: 2_000,
      maxDelayMs: 10_000,
      jitterFactor: 0,
      signal: controller.signal,
    }).catch((e) => e);

    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(10_000);

    const err = await promise;
    expect(err).toBeInstanceOf(RetryCancelledError);
    expect(err.name).toBe("RetryCancelledError");
  });

  it("exhaustion without abort throws the original error, not RetryCancelledError", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("always fails"));

    const err = await withRetry(fn, {
      maxAttempts: 2,
      baseDelayMs: 0,
      maxDelayMs: 0,
      jitterFactor: 0,
    }).catch((e) => e);

    expect(err).not.toBeInstanceOf(RetryCancelledError);
    expect(err.message).toBe("always fails");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

// ── 3. Supervisor restart sleep — stop() cancels the delay immediately ────────

describe("Supervisor — stop() cancels restart sleep promptly", () => {
  it("stop() during restart delay resolves without waiting for the full delay", async () => {
    vi.useFakeTimers();

    // A listener that always fails to simulate a recoverable error.
    let startCalls = 0;
    const failingListeners: ListenerSet = {
      async start() {
        startCalls++;
        // First start succeeds to let the supervisor reach 'running'.
        // Subsequent starts throw to trigger a restart.
        if (startCalls > 1) throw new Error("transient listener error");
      },
      async stop() {},
    };

    const supervisor = new Supervisor({
      log,
      maxRestarts: 10,
      restartDelayMs: 60_000,   // 60 s restart delay
      maxRestartDelayMs: 60_000,
    });

    const runPromise = supervisor.run(failingListeners);

    // Let startup + first running iteration proceed, then trigger the error
    // that starts the restart delay.
    await vi.advanceTimersByTimeAsync(0);

    // stop() should cancel the pending restart sleep immediately.
    supervisor.stop();

    // Advance a tiny amount — the sleep resolve should have fired via the
    // sleepReject cancellation path, not after the full 60 s delay.
    await vi.advanceTimersByTimeAsync(0);
    await runPromise; // must resolve, not hang

    expect(supervisor.state).toBe("stopped");
  });

  it("supervisor state after stop() is 'stopped', not 'restarting'", async () => {
    vi.useFakeTimers();

    let calls = 0;
    const failingListeners: ListenerSet = {
      async start() {
        calls++;
        if (calls > 1) throw new Error("transient");
      },
      async stop() {},
    };

    const supervisor = new Supervisor({ log, maxRestarts: 5, restartDelayMs: 10_000 });
    const runPromise = supervisor.run(failingListeners);

    await vi.advanceTimersByTimeAsync(0);

    supervisor.stop();
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;

    expect(supervisor.state).toBe("stopped");
    // The state must never be 'restarting' after stop() completes.
    expect(supervisor.state).not.toBe("restarting");
  });
});

// ── 4. No dangling handles ────────────────────────────────────────────────────

describe("withRetry — no dangling timer after cancellation", () => {
  it("advancing well past the delay after abort does not trigger a late attempt", async () => {
    vi.useFakeTimers();
    const fn = vi.fn().mockRejectedValue(new Error("transient"));
    const controller = new AbortController();

    const result = withRetry(fn, {
      maxAttempts: 10,
      baseDelayMs: 1_000,
      maxDelayMs: 30_000,
      jitterFactor: 0,
      signal: controller.signal,
    }).catch(() => "cancelled");

    // Run attempt 1.
    await vi.advanceTimersByTimeAsync(0);
    const afterAttempt1 = fn.mock.calls.length;

    // Cancel immediately.
    controller.abort();

    // Advance a full minute — no additional attempts should fire.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await result).toBe("cancelled");
    expect(fn).toHaveBeenCalledTimes(afterAttempt1);
  });
});
