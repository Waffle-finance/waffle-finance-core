/**
 * Tests for dynamic backoff by error type (issue: targeted retry strategy).
 *
 * Covers:
 *  - classifyRpcError: correct classification for all error classes
 *  - effectiveBaseDelay: multiplier applied correctly
 *  - withRetry: short backoff for timeouts/partial, long for unavailable
 *  - withRetry: noRetry flag prevents any retry on failure
 *  - retryRpcCall: logs the error class in the retry message
 *  - Persistent outage: does not spin in a busy loop (delays are always > 0
 *    for unavailable errors)
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  classifyRpcError,
  effectiveBaseDelay,
  withRetry,
  retryRpcCall,
  type RpcErrorClass,
} from "../src/retry.js";

// ── classifyRpcError ──────────────────────────────────────────────────────────

describe("classifyRpcError — error class identification", () => {
  it.each<[string, RpcErrorClass]>([
    ["Request timeout after 5000ms", "timeout"],
    ["ETIMEDOUT", "timeout"],
    ["operation timed out", "timeout"],
    ["The operation was aborted", "timeout"],
  ])('classifies "%s" as timeout', (message, expected) => {
    expect(classifyRpcError(new Error(message))).toBe(expected);
  });

  it.each<[string, RpcErrorClass]>([
    ["read ECONNRESET", "reset"],
    ["socket hang up", "reset"],
    ["Connection reset by peer", "reset"],
  ])('classifies "%s" as reset', (message, expected) => {
    expect(classifyRpcError(new Error(message))).toBe(expected);
  });

  it.each<[string, RpcErrorClass]>([
    ["connect ECONNREFUSED 127.0.0.1:8545", "unavailable"],
    ["fetch failed", "unavailable"],
    ["Failed to fetch", "unavailable"],
    ["503 Service Unavailable", "unavailable"],
    ["EHOSTUNREACH", "unavailable"],
    ["Network error", "unavailable"],
  ])('classifies "%s" as unavailable', (message, expected) => {
    expect(classifyRpcError(new Error(message))).toBe(expected);
  });

  it.each<[string, RpcErrorClass]>([
    ["HTTP 429 Too Many Requests", "rate_limited"],
    ["rate limit exceeded", "rate_limited"],
    ["too many requests", "rate_limited"],
  ])('classifies "%s" as rate_limited', (message, expected) => {
    expect(classifyRpcError(new Error(message))).toBe(expected);
  });

  it.each<[string, RpcErrorClass]>([
    ["Unexpected token < in JSON at position 0", "partial"],
    ["JSON parse error", "partial"],
    ["Unexpected end of JSON input", "partial"],
    ["Invalid response from RPC node", "partial"],
  ])('classifies "%s" as partial', (message, expected) => {
    expect(classifyRpcError(new Error(message))).toBe(expected);
  });

  it("classifies an unrecognised error as unknown", () => {
    expect(classifyRpcError(new Error("some weird provider error"))).toBe("unknown");
  });

  it("classifies a plain string as unknown (unless it matches)", () => {
    expect(classifyRpcError("a string error")).toBe("unknown");
    expect(classifyRpcError("fetch failed")).toBe("unavailable");
  });

  it("classifies a non-Error object as unknown", () => {
    expect(classifyRpcError({ code: 500 })).toBe("unknown");
    expect(classifyRpcError(null)).toBe("unknown");
  });

  it("rate_limited takes precedence over unavailable (503 is in both patterns)", () => {
    // The 429 keyword check runs first — 503 alone should map to unavailable.
    expect(classifyRpcError(new Error("503 Service Unavailable"))).toBe("unavailable");
    expect(classifyRpcError(new Error("429 Too Many Requests"))).toBe("rate_limited");
  });
});

// ── effectiveBaseDelay ────────────────────────────────────────────────────────

describe("effectiveBaseDelay — multiplier application", () => {
  const BASE = 1_000;
  const MAX  = 30_000;

  it("timeout multiplier (0.5) halves the base delay", () => {
    expect(effectiveBaseDelay("timeout", BASE, MAX)).toBe(500);
  });

  it("partial multiplier (0.5) halves the base delay", () => {
    expect(effectiveBaseDelay("partial", BASE, MAX)).toBe(500);
  });

  it("reset multiplier (0.75) reduces the base delay", () => {
    expect(effectiveBaseDelay("reset", BASE, MAX)).toBe(750);
  });

  it("unknown/transient multiplier (1.0) leaves the base delay unchanged", () => {
    expect(effectiveBaseDelay("unknown", BASE, MAX)).toBe(1_000);
    expect(effectiveBaseDelay("transient", BASE, MAX)).toBe(1_000);
  });

  it("unavailable multiplier (1.5) increases the base delay", () => {
    expect(effectiveBaseDelay("unavailable", BASE, MAX)).toBe(1_500);
  });

  it("rate_limited multiplier (2.0) doubles the base delay", () => {
    expect(effectiveBaseDelay("rate_limited", BASE, MAX)).toBe(2_000);
  });

  it("caps at maxDelayMs even when multiplier * base > max", () => {
    expect(effectiveBaseDelay("rate_limited", 20_000, 30_000)).toBe(30_000);
  });

  it("never returns a negative value", () => {
    expect(effectiveBaseDelay("timeout", 0, 30_000)).toBe(0);
    expect(effectiveBaseDelay("rate_limited", 0, 30_000)).toBe(0);
  });
});

// ── withRetry — dynamic backoff ───────────────────────────────────────────────

describe("withRetry — dynamic backoff by error class", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("uses a shorter backoff for timeout errors than for unavailable errors", async () => {
    const timeoutDelays: number[] = [];
    const unavailableDelays: number[] = [];

    // timeout run
    let t = 0;
    const timeoutFn = vi.fn().mockImplementation(async () => {
      if (++t < 3) throw new Error("operation timed out");
      return "done";
    });

    // unavailable run
    let u = 0;
    const unavailableFn = vi.fn().mockImplementation(async () => {
      if (++u < 3) throw new Error("fetch failed");
      return "done";
    });

    const makeOpts = (delays: number[]) => ({
      maxAttempts: 3,
      baseDelayMs: 1_000,
      maxDelayMs: 30_000,
      jitterFactor: 0, // deterministic
      onRetry: (_: number, ms: number) => delays.push(ms),
    });

    const p1 = withRetry(timeoutFn, makeOpts(timeoutDelays));
    const p2 = withRetry(unavailableFn, makeOpts(unavailableDelays));
    await vi.runAllTimersAsync();
    await p1;
    await p2;

    // timeout base = 1000 * 0.5 = 500; unavailable base = 1000 * 1.5 = 1500
    // attempt 0: 500 vs 1500
    expect(timeoutDelays[0]).toBeLessThan(unavailableDelays[0]!);
    // attempt 1: 1000 vs 3000 (exponential factor 2)
    expect(timeoutDelays[1]).toBeLessThan(unavailableDelays[1]!);
  });

  it("rate_limited errors get the longest backoff", async () => {
    const delays: number[] = [];
    let calls = 0;
    const fn = vi.fn().mockImplementation(async () => {
      if (++calls < 3) throw new Error("429 too many requests");
      return "ok";
    });

    const p = withRetry(fn, {
      maxAttempts: 3,
      baseDelayMs: 1_000,
      maxDelayMs: 30_000,
      jitterFactor: 0,
      onRetry: (_, ms) => delays.push(ms),
    });
    await vi.runAllTimersAsync();
    await p;

    // rate_limited base = 2000; attempt 0 delay = 2000
    expect(delays[0]).toBe(2_000);
    // attempt 1 delay = min(30000, 2000 * 2^1) = 4000
    expect(delays[1]).toBe(4_000);
  });
});

// ── withRetry — noRetry flag ──────────────────────────────────────────────────

describe("withRetry — noRetry flag", () => {
  it("does not retry when noRetry=true", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("transient"));
    await expect(withRetry(fn, { noRetry: true })).rejects.toThrow("transient");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries normally when noRetry=false (default)", async () => {
    let calls = 0;
    const fn = vi.fn().mockImplementation(async () => {
      if (++calls < 3) throw new Error("transient");
      return "ok";
    });
    const result = await withRetry(fn, {
      maxAttempts: 3,
      baseDelayMs: 0,
      jitterFactor: 0,
      noRetry: false,
    });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });
});

// ── retryRpcCall — error class in log message ─────────────────────────────────

describe("retryRpcCall — error class included in log output", () => {
  it("logs the error class alongside the attempt number", async () => {
    const warnMessages: string[] = [];
    const logger = { warn: (msg: string) => warnMessages.push(msg) };

    let calls = 0;
    const fn = vi.fn().mockImplementation(async () => {
      if (++calls < 2) throw new Error("read ECONNRESET");
      return "ok";
    });

    await retryRpcCall(fn, {
      logger,
      maxAttempts: 2,
      baseDelayMs: 0,
      jitterFactor: 0,
    });

    expect(warnMessages.length).toBeGreaterThan(0);
    expect(warnMessages[0]).toContain("class=reset");
    expect(warnMessages[0]).toContain("attempt 1");
  });
});

// ── Persistent outage: no busy loop ──────────────────────────────────────────

describe("withRetry — persistent outage never spins in a busy loop", () => {
  it("all scheduled delays are > 0 for unavailable errors with base > 0", async () => {
    const delays: number[] = [];
    // Spy on setTimeout to capture delay values without fake timers (which
    // cause a PromiseRejectionHandledWarning with async mock rejections).
    const orig = globalThis.setTimeout;
    const spy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation((fn: TimerHandler, ms?: number, ...args: unknown[]) => {
        if (typeof ms === "number") delays.push(ms);
        // Execute immediately so the test doesn't actually wait.
        return orig(fn as (...a: unknown[]) => void, 0, ...args);
      });

    const fn = vi.fn().mockImplementation(() =>
      Promise.reject(new Error("connect ECONNREFUSED"))
    );

    await withRetry(fn, {
      maxAttempts: 5,
      baseDelayMs: 500,
      maxDelayMs: 30_000,
      jitterFactor: 0,
      onRetry: (_, ms) => delays.push(ms),
    }).catch(() => {});

    spy.mockRestore();

    // onRetry is called with the computed delay before the setTimeout fires.
    // unavailable multiplier = 1.5, so base = 750; all onRetry delays ≥ 750.
    expect(delays.length).toBeGreaterThan(0);
    for (const ms of delays) {
      expect(ms).toBeGreaterThan(0);
    }
    // Delays are non-decreasing (exponential without jitter).
    for (let i = 1; i < delays.length; i++) {
      expect(delays[i]).toBeGreaterThanOrEqual(delays[i - 1]!);
    }
  });
});
