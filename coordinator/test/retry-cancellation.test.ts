/**
 * Tests: AbortSignal propagation through the coordinator's retryAsync wrapper.
 *
 * Covers:
 *  1. An already-aborted signal rejects immediately — fn is never called.
 *  2. Abort mid-backoff (between attempts) stops the loop promptly — no later
 *     attempt is started.
 *  3. The error thrown is RetryCancelledError, distinguishable from both a
 *     plain exhaustion error and a FatalStartupError.
 *  4. A signal that is never aborted does not interfere with normal retry
 *     behaviour.
 *  5. FatalStartupError still short-circuits independently of the signal.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { retryAsync, FatalStartupError, RetryCancelledError } from "../src/retry.js";

afterEach(() => {
  vi.useRealTimers();
});

// ── 1. Already-aborted signal ─────────────────────────────────────────────────

describe("retryAsync — already-aborted signal", () => {
  it("rejects immediately without calling fn", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const controller = new AbortController();
    controller.abort();

    await expect(
      retryAsync(fn, { maxAttempts: 3, signal: controller.signal }),
    ).rejects.toBeInstanceOf(RetryCancelledError);

    expect(fn).not.toHaveBeenCalled();
  });

  it("throws RetryCancelledError, not any other error type", async () => {
    const controller = new AbortController();
    controller.abort();

    const err = await retryAsync(vi.fn(), { signal: controller.signal }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(RetryCancelledError);
    expect(err.name).toBe("RetryCancelledError");
  });
});

// ── 2. Abort mid-backoff ──────────────────────────────────────────────────────

describe("retryAsync — abort during retry delay", () => {
  it("stops the loop when abort fires between attempts — no second attempt started", async () => {
    vi.useFakeTimers();

    const fn = vi.fn().mockRejectedValue(new Error("transient"));
    const controller = new AbortController();

    const promise = retryAsync(fn, {
      maxAttempts: 5,
      baseDelayMs: 5_000,
      maxDelayMs: 30_000,
      jitterMs: 0,
      signal: controller.signal,
    });
    const assertion = expect(promise).rejects.toBeInstanceOf(RetryCancelledError);

    // Let the first attempt run and fail (the onRetry callback fires here).
    await vi.advanceTimersByTimeAsync(0);
    expect(fn).toHaveBeenCalledTimes(1);

    // Abort while in the delay window, then advance past the scheduled retry.
    controller.abort();
    await vi.advanceTimersByTimeAsync(30_000);

    await assertion;
    // Only the first attempt ran; no subsequent attempt was scheduled.
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

// ── 3. RetryCancelledError is distinguishable ─────────────────────────────────

describe("retryAsync — RetryCancelledError identity", () => {
  it("is not an instance of FatalStartupError", async () => {
    const controller = new AbortController();
    controller.abort();

    const err = await retryAsync(vi.fn(), { signal: controller.signal }).catch(
      (e) => e,
    );
    expect(err).not.toBeInstanceOf(FatalStartupError);
    expect(err).toBeInstanceOf(RetryCancelledError);
  });

  it("message does not contain the original transient error message", async () => {
    vi.useFakeTimers();

    const fn = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    const controller = new AbortController();

    const promise = retryAsync(fn, {
      maxAttempts: 5,
      baseDelayMs: 2_000,
      jitterMs: 0,
      signal: controller.signal,
    }).catch((e) => e);

    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(10_000);

    const err = await promise;
    expect(err).toBeInstanceOf(RetryCancelledError);
    expect(err.message).not.toMatch(/ECONNRESET/);
  });
});

// ── 4. Non-aborted signal does not interfere ──────────────────────────────────

describe("retryAsync — non-aborted signal is transparent", () => {
  it("succeeds normally when the signal never fires", async () => {
    const controller = new AbortController();
    let calls = 0;

    const result = await retryAsync(
      async () => {
        calls++;
        if (calls < 3) throw new Error("transient");
        return "done";
      },
      {
        maxAttempts: 5,
        baseDelayMs: 0,
        maxDelayMs: 0,
        jitterMs: 0,
        signal: controller.signal,
      },
    );

    expect(result).toBe("done");
    expect(calls).toBe(3);
  });

  it("exhaustion still throws normally when signal is provided but never aborted", async () => {
    const controller = new AbortController();

    await expect(
      retryAsync(async () => { throw new Error("always"); }, {
        maxAttempts: 3,
        baseDelayMs: 0,
        maxDelayMs: 0,
        jitterMs: 0,
        signal: controller.signal,
      }),
    ).rejects.toThrow("always");
  });
});

// ── 5. FatalStartupError still short-circuits independently ──────────────────

describe("retryAsync — FatalStartupError with signal present", () => {
  it("propagates FatalStartupError immediately regardless of signal state", async () => {
    const controller = new AbortController(); // signal never aborted
    let calls = 0;

    const err = await retryAsync(
      async () => {
        calls++;
        throw new FatalStartupError("bad schema");
      },
      { maxAttempts: 5, baseDelayMs: 0, jitterMs: 0, signal: controller.signal },
    ).catch((e) => e);

    expect(err).toBeInstanceOf(FatalStartupError);
    expect(err.message).toBe("bad schema");
    expect(calls).toBe(1);
  });
});
