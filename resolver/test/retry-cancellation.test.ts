import { describe, it, expect, vi, afterEach } from "vitest";
import { withRetry, RetryCancelledError } from "../src/retry.js";

describe("withRetry — cancellation during backoff settles promptly", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("cancels the scheduled attempt when aborted during the retry delay", async () => {
    vi.useFakeTimers();
    const fn = vi.fn().mockRejectedValue(new Error("fetch failed"));
    const controller = new AbortController();

    const promise = withRetry(fn, {
      maxAttempts: 5,
      baseDelayMs: 5000,
      maxDelayMs: 30000,
      jitterFactor: 0,
      signal: controller.signal,
    });
    const assertion = expect(promise).rejects.toBeInstanceOf(RetryCancelledError);

    // Let the first attempt fail so the retry delay starts.
    await vi.advanceTimersByTimeAsync(0);
    expect(fn).toHaveBeenCalledTimes(1);

    // Cancel mid-backoff and jump past the scheduled attempt.
    controller.abort();
    await vi.advanceTimersByTimeAsync(30000);

    await assertion;
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("cancellation is distinguishable from a retryable RPC failure", async () => {
    vi.useFakeTimers();
    const fn = vi.fn().mockRejectedValue(new Error("fetch failed"));
    const controller = new AbortController();

    const promise = withRetry(fn, {
      maxAttempts: 5,
      baseDelayMs: 5000,
      maxDelayMs: 30000,
      jitterFactor: 0,
      signal: controller.signal,
    });
    const assertion = promise.catch((err) => err);

    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(30000);

    const err = await assertion;
    expect(err).toBeInstanceOf(RetryCancelledError);
    expect(err.name).toBe("RetryCancelledError");
    expect(err.message).not.toMatch(/fetch failed/);
  });

  it("an already-aborted signal settles without scheduling attempts", async () => {
    vi.useFakeTimers();
    const fn = vi.fn().mockResolvedValue("ok");
    const controller = new AbortController();
    controller.abort();

    await expect(
      withRetry(fn, { maxAttempts: 3, signal: controller.signal })
    ).rejects.toBeInstanceOf(RetryCancelledError);
    expect(fn).not.toHaveBeenCalled();
  });
});
