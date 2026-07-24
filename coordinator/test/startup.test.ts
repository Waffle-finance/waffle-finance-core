/**
 * startup.test.ts
 *
 * Tests for coordinator startup retry/backoff semantics (Part A).
 *
 * Covers:
 *  - retryAsync: exponential backoff timing, attempt counting, success on
 *    nth attempt
 *  - FatalStartupError: immediate propagation without delay or retry
 *  - shouldRetry predicate: non-retryable errors bypass the loop
 *  - onRetry callback: called with correct metadata on each failure
 *  - Exhaustion: after maxAttempts the last error is re-thrown
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { retryAsync, FatalStartupError, type RetryOptions } from "../src/retry.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a function that fails `failCount` times then resolves with `value`. */
function failsThen<T>(failCount: number, value: T, errMsg = "transient"): () => Promise<T> {
  let calls = 0;
  return async () => {
    calls++;
    if (calls <= failCount) throw new Error(errMsg);
    return value;
  };
}

/**
 * Accelerated retryAsync: zero-delay so tests don't sleep.
 * Keeps jitter=0 so delay assertions are deterministic.
 */
function fastRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  return retryAsync(fn, { baseDelayMs: 0, maxDelayMs: 0, jitterMs: 0, ...opts });
}

// ── retryAsync — basic behaviour ─────────────────────────────────────────────

describe("retryAsync — success paths", () => {
  it("resolves immediately when the first attempt succeeds", async () => {
    let calls = 0;
    const result = await fastRetry(async () => {
      calls++;
      return 42;
    });
    expect(result).toBe(42);
    expect(calls).toBe(1);
  });

  it("resolves on the second attempt after one transient failure", async () => {
    const fn = failsThen(1, "hello");
    const result = await fastRetry(fn);
    expect(result).toBe("hello");
  });

  it("resolves on the last allowed attempt (maxAttempts - 1 failures)", async () => {
    const fn = failsThen(4, "ok");
    const result = await fastRetry(fn, { maxAttempts: 5 });
    expect(result).toBe("ok");
  });

  it("passes the resolved value through unchanged", async () => {
    const obj = { foo: "bar" };
    const result = await fastRetry(async () => obj);
    expect(result).toBe(obj);
  });
});

describe("retryAsync — exhaustion", () => {
  it("throws after maxAttempts are consumed", async () => {
    const err = new Error("always fails");
    await expect(
      fastRetry(async () => { throw err; }, { maxAttempts: 3 })
    ).rejects.toBe(err);
  });

  it("re-throws the exact last error instance", async () => {
    const errors = [new Error("first"), new Error("second"), new Error("last")];
    let i = 0;
    await expect(
      fastRetry(async () => { throw errors.at(i++) ?? new Error("overflow"); }, { maxAttempts: 3 })
    ).rejects.toBe(errors.at(2));
  });

  it("calls fn exactly maxAttempts times before giving up", async () => {
    let calls = 0;
    await fastRetry(async () => { calls++; throw new Error("x"); }, { maxAttempts: 4 }).catch(() => {});
    expect(calls).toBe(4);
  });
});

// ── FatalStartupError — immediate propagation ─────────────────────────────────

describe("retryAsync — FatalStartupError", () => {
  it("propagates a FatalStartupError immediately on the first failure", async () => {
    let calls = 0;
    const fatal = new FatalStartupError("schema mismatch");
    await expect(
      fastRetry(async () => {
        calls++;
        throw fatal;
      }, { maxAttempts: 5 })
    ).rejects.toBe(fatal);
    expect(calls).toBe(1); // no retries
  });

  it("does not invoke onRetry before propagating FatalStartupError", async () => {
    const onRetry = vi.fn();
    const fatal = new FatalStartupError("bad url");
    await expect(
      fastRetry(async () => { throw fatal; }, { maxAttempts: 5, onRetry })
    ).rejects.toBeInstanceOf(FatalStartupError);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("propagates FatalStartupError thrown on a later attempt without further retries", async () => {
    let calls = 0;
    await expect(
      fastRetry(async () => {
        calls++;
        if (calls === 2) throw new FatalStartupError("fatal on second call");
        throw new Error("transient");
      }, { maxAttempts: 5 })
    ).rejects.toBeInstanceOf(FatalStartupError);
    expect(calls).toBe(2); // transient once, then fatal — no more retries
  });

  it("FatalStartupError name is 'FatalStartupError'", () => {
    expect(new FatalStartupError("x").name).toBe("FatalStartupError");
  });

  it("FatalStartupError is an instance of Error", () => {
    expect(new FatalStartupError("x")).toBeInstanceOf(Error);
  });

  it("FatalStartupError stores an optional cause", () => {
    const cause = new Error("root cause");
    const err = new FatalStartupError("wrapper", cause);
    expect(err.cause).toBe(cause);
  });
});

// ── shouldRetry predicate ──────────────────────────────────────────────────────

describe("retryAsync — shouldRetry predicate", () => {
  it("rethrows immediately when shouldRetry returns false", async () => {
    let calls = 0;
    const err = new Error("schema behind");
    await expect(
      fastRetry(
        async () => { calls++; throw err; },
        { maxAttempts: 5, shouldRetry: () => false }
      )
    ).rejects.toBe(err);
    expect(calls).toBe(1);
  });

  it("continues retrying when shouldRetry returns true", async () => {
    const fn = failsThen(3, "done");
    const result = await fastRetry(fn, {
      maxAttempts: 5,
      shouldRetry: () => true,
    });
    expect(result).toBe("done");
  });

  it("shouldRetry receives the thrown error as its argument", async () => {
    const capturedErrors: unknown[] = [];
    const errA = new Error("a");
    const errB = new Error("b");
    const errs = [errA, errB];
    let i = 0;
    await fastRetry(
      async () => { if (i < 2) throw errs.at(i++) ?? new Error("overflow"); return "ok"; },
      {
        maxAttempts: 5,
        shouldRetry: (e) => { capturedErrors.push(e); return true; },
      }
    );
    expect(capturedErrors).toEqual([errA, errB]);
  });

  it("shouldRetry can selectively block certain errors", async () => {
    const schemaErr = new Error("Database schema is behind");
    const transientErr = new Error("ECONNREFUSED");
    let attempt = 0;

    // First call: transient (should retry). Second call: schema error (should NOT retry).
    await expect(
      fastRetry(
        async () => {
          attempt++;
          if (attempt === 1) throw transientErr;
          throw schemaErr;
        },
        {
          maxAttempts: 5,
          shouldRetry: (e) => {
            const msg = e instanceof Error ? e.message : "";
            return !msg.includes("Database schema");
          },
        }
      )
    ).rejects.toBe(schemaErr);
    expect(attempt).toBe(2);
  });
});

// ── onRetry callback ──────────────────────────────────────────────────────────

describe("retryAsync — onRetry callback", () => {
  it("is called once per failed attempt (excluding the final exhausted attempt)", async () => {
    const onRetry = vi.fn();
    await fastRetry(
      async () => { throw new Error("x"); },
      { maxAttempts: 4, onRetry }
    ).catch(() => {});
    // 4 attempts total: failures on 1, 2, 3 trigger onRetry; failure 4 exhausts.
    expect(onRetry).toHaveBeenCalledTimes(3);
  });

  it("is called with correct attempt number (1-indexed)", async () => {
    const attempts: number[] = [];
    await fastRetry(
      async () => { throw new Error("x"); },
      { maxAttempts: 4, onRetry: ({ attempt }) => attempts.push(attempt) }
    ).catch(() => {});
    expect(attempts).toEqual([1, 2, 3]);
  });

  it("receives the thrown error in the onRetry payload", async () => {
    const err = new Error("specific error");
    const receivedErrors: unknown[] = [];
    await fastRetry(
      async () => { throw err; },
      { maxAttempts: 3, onRetry: ({ err: e }) => receivedErrors.push(e) }
    ).catch(() => {});
    expect(receivedErrors).toEqual([err, err]);
  });

  it("receives the maxAttempts value in the onRetry payload", async () => {
    const maxValues: number[] = [];
    await fastRetry(
      async () => { throw new Error("x"); },
      { maxAttempts: 3, onRetry: ({ maxAttempts: m }) => maxValues.push(m) }
    ).catch(() => {});
    expect(maxValues).toEqual([3, 3]); // called twice for 3 maxAttempts
  });

  it("is not called when the function succeeds on the first attempt", async () => {
    const onRetry = vi.fn();
    await fastRetry(async () => "ok", { onRetry });
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("is not called when FatalStartupError is thrown", async () => {
    const onRetry = vi.fn();
    await fastRetry(
      async () => { throw new FatalStartupError("fatal"); },
      { onRetry }
    ).catch(() => {});
    expect(onRetry).not.toHaveBeenCalled();
  });
});

// ── Delay / backoff ───────────────────────────────────────────────────────────

describe("retryAsync — backoff delays", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses exponential backoff: delay doubles on each retry", async () => {
    const delays: number[] = [];
    let attempt = 0;

    const p = retryAsync(
      async () => {
        attempt++;
        if (attempt < 4) throw new Error("transient");
        return "done";
      },
      {
        maxAttempts: 4,
        baseDelayMs: 100,
        maxDelayMs: 10_000,
        jitterMs: 0,
        onRetry: ({ delayMs }) => delays.push(delayMs),
      }
    );

    // Drive each setTimeout tick.
    await vi.runAllTimersAsync();
    await p;

    // Delays: 100ms (2^0), 200ms (2^1), 400ms (2^2)
    expect(delays).toEqual([100, 200, 400]);
  });

  it("caps delay at maxDelayMs", async () => {
    const delays: number[] = [];
    let attempt = 0;

    const p = retryAsync(
      async () => {
        attempt++;
        if (attempt < 5) throw new Error("transient");
        return "ok";
      },
      {
        maxAttempts: 5,
        baseDelayMs: 1_000,
        maxDelayMs: 2_000,
        jitterMs: 0,
        onRetry: ({ delayMs }) => delays.push(delayMs),
      }
    );

    await vi.runAllTimersAsync();
    await p;

    // Without cap: 1000, 2000, 4000, 8000. With cap of 2000: 1000, 2000, 2000, 2000.
    expect(delays.at(0)).toBe(1_000);
    expect(delays.at(1)).toBe(2_000);
    expect(delays.at(2)).toBe(2_000);
    expect(delays.at(3)).toBe(2_000);
  });
});
