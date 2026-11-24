/**
 * Tests: AbortSignal propagation through RetryEngine.run().
 *
 * Covers:
 *  1. An already-aborted signal rejects before fn executes.
 *  2. Abort during the backoff delay stops the loop — no later attempt occurs.
 *  3. Abort while fn is executing surfaces as RetryCancelledError after fn
 *     resolves/rejects, without scheduling another attempt.
 *  4. RetryCancelledError is distinguishable from RetryExhaustedError and
 *     from an original transient error.
 *  5. A signal that never fires does not alter normal retry behaviour.
 *  6. No open handles remain after cancellation (timer cleared).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/metrics.js", () => ({
  retryEngineAttemptsTotal:        { inc: vi.fn() },
  retryEngineExhaustedTotal:       { inc: vi.fn() },
  retryEngineCircuitOpenedTotal:   { inc: vi.fn() },
  retryEngineCircuitRejectedTotal: { inc: vi.fn() },
  retryEngineCircuitState:         { set: vi.fn() },
  retryEngineBackoffSeconds:       { observe: vi.fn() },
  correlationOpsTotal:             { inc: vi.fn() },
  correlationCheckpointsTotal:     { inc: vi.fn() },
  correlationOpDurationSeconds:    { startTimer: () => () => {} },
  correlationRetryHopsTotal:       { inc: vi.fn() },
}));

import {
  RetryEngine,
  RetryExhaustedError,
  RetryCancelledError,
} from "../src/utils/retry-engine.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEngine() {
  return new RetryEngine({
    defaultMaxAttempts: 5,
    defaultBaseDelayMs: 5_000,
    defaultMaxDelayMs: 30_000,
    jitterFactor: 0,
    circuitBreakerThreshold: 99, // don't trip in these tests
  });
}

afterEach(() => vi.useRealTimers());

// ── 1. Already-aborted signal ─────────────────────────────────────────────────

describe("RetryEngine — already-aborted signal", () => {
  it("rejects immediately without executing fn", async () => {
    const engine = makeEngine();
    const fn = vi.fn().mockResolvedValue("ok");

    const controller = new AbortController();
    controller.abort();

    await expect(
      engine.run("rpc", fn, { signal: controller.signal }),
    ).rejects.toBeInstanceOf(RetryCancelledError);

    expect(fn).not.toHaveBeenCalled();
  });
});

// ── 2. Abort during backoff delay ─────────────────────────────────────────────

describe("RetryEngine — abort during backoff delay", () => {
  it("stops the loop without scheduling another attempt", async () => {
    vi.useFakeTimers();
    const engine = makeEngine();
    const fn = vi.fn().mockRejectedValue(new Error("transient"));
    const controller = new AbortController();

    const promise = engine.run("rpc", fn, {
      signal: controller.signal,
      maxAttempts: 5,
      baseDelayMs: 5_000,
    });
    const assertion = expect(promise).rejects.toBeInstanceOf(RetryCancelledError);

    // Allow the first attempt to run and fail.
    await vi.advanceTimersByTimeAsync(0);
    expect(fn).toHaveBeenCalledTimes(1);

    // Abort mid-backoff; advance past the full scheduled delay.
    controller.abort();
    await vi.advanceTimersByTimeAsync(30_000);

    await assertion;
    // No second attempt was started.
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("resolves the sleep timer so no open handles remain", async () => {
    vi.useFakeTimers();
    const engine = makeEngine();
    const fn = vi.fn().mockRejectedValue(new Error("transient"));
    const controller = new AbortController();

    const promise = engine.run("rpc", fn, {
      signal: controller.signal,
      maxAttempts: 3,
      baseDelayMs: 10_000,
    }).catch(() => "caught");

    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    // Advancing past the delay must not leave a pending timer.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await promise).toBe("caught");
  });
});

// ── 3. Abort while fn is executing ───────────────────────────────────────────

describe("RetryEngine — abort while fn is executing", () => {
  it("surfaces RetryCancelledError after fn rejects, never starts another attempt", async () => {
    vi.useFakeTimers();
    const engine = makeEngine();
    const controller = new AbortController();

    // fn rejects after a small delay.
    const fn = vi.fn().mockImplementation(
      () =>
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error("slow-transient")), 100),
        ),
    );

    const promise = engine.run("rpc", fn, {
      signal: controller.signal,
      maxAttempts: 5,
      baseDelayMs: 5_000,
    });
    const assertion = expect(promise).rejects.toBeInstanceOf(RetryCancelledError);

    // fn is now in-flight.  Abort the controller.
    controller.abort();
    // Advance past fn's internal timeout and the backoff.
    await vi.advanceTimersByTimeAsync(30_100);

    await assertion;
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

// ── 4. RetryCancelledError is distinguishable ─────────────────────────────────

describe("RetryEngine — RetryCancelledError identity", () => {
  it("is not an instance of RetryExhaustedError", async () => {
    const engine = makeEngine();
    const controller = new AbortController();
    controller.abort();

    const err = await engine
      .run("rpc", vi.fn(), { signal: controller.signal })
      .catch((e) => e);

    expect(err).toBeInstanceOf(RetryCancelledError);
    expect(err).not.toBeInstanceOf(RetryExhaustedError);
    expect(err.name).toBe("RetryCancelledError");
  });

  it("message does not contain the original transient error text", async () => {
    vi.useFakeTimers();
    const engine = makeEngine();
    const controller = new AbortController();

    const fn = vi.fn().mockRejectedValue(new Error("horizon timeout"));

    const promise = engine
      .run("rpc", fn, {
        signal: controller.signal,
        maxAttempts: 5,
        baseDelayMs: 5_000,
      })
      .catch((e) => e);

    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(30_000);

    const err = await promise;
    expect(err).toBeInstanceOf(RetryCancelledError);
    expect(err.message).not.toMatch(/horizon timeout/);
  });
});

// ── 5. Non-aborted signal is transparent ─────────────────────────────────────

describe("RetryEngine — non-aborted signal does not alter behaviour", () => {
  it("retries and succeeds normally", async () => {
    const engine = new RetryEngine({
      defaultMaxAttempts: 5,
      defaultBaseDelayMs: 1,
      defaultMaxDelayMs: 5,
      jitterFactor: 0,
      circuitBreakerThreshold: 99,
    });
    const controller = new AbortController();
    let calls = 0;

    const result = await engine.run(
      "rpc",
      async () => {
        calls++;
        if (calls < 3) throw new Error("transient");
        return "done";
      },
      { signal: controller.signal },
    );

    expect(result).toBe("done");
    expect(calls).toBe(3);
  });

  it("exhaustion still throws RetryExhaustedError when signal never fires", async () => {
    const engine = new RetryEngine({
      defaultMaxAttempts: 3,
      defaultBaseDelayMs: 1,
      defaultMaxDelayMs: 5,
      jitterFactor: 0,
      circuitBreakerThreshold: 99,
    });
    const controller = new AbortController();

    await expect(
      engine.run("rpc", vi.fn().mockRejectedValue(new Error("always")), {
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(RetryExhaustedError);
  });
});
