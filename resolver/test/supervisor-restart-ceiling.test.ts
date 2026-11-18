/**
 * supervisor-restart-ceiling.test.ts
 *
 * Component: Resolver supervisor — restart ceiling and final lifecycle state.
 *
 * Covers the configured boundary between retrying and giving up.
 *
 * Design note on the supervisor's run() structure
 * ------------------------------------------------
 * The Supervisor.run() method has TWO distinct phases:
 *   1. Startup phase (outside the while loop): calls start() once. If this
 *      fails for ANY reason (including a recoverable error), the supervisor
 *      transitions to "failed" immediately and rethrows the original error.
 *      restartCount is NOT incremented.
 *   2. Running phase (while loop): calls start() repeatedly. Recoverable
 *      failures here increment restartCount and trigger a restart sleep. Once
 *      restartCount > maxRestarts, the supervisor transitions to "failed" and
 *      throws "max restarts exceeded".
 *
 * Implication: maxRestarts governs only the RUNNING phase restarts. A startup
 * failure always ends in "failed" regardless of maxRestarts.
 *
 * Test strategy
 * -------------
 * We simulate the running phase by having the startup start() succeed (so the
 * while loop is entered), then the while-loop start() always fails.
 *
 * Acceptance criteria
 * -------------------
 *  - The maximum is enforced at the documented boundary.
 *  - Exhaustion ends in a visible "failed" state.
 *  - Tests do not depend on timing sleeps.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import pino from "pino";
import { Supervisor, FatalError } from "../src/supervisor.js";

const nullLog = pino({ level: "silent" });

/**
 * Create a supervisor with patched sleep so no real delays occur.
 */
function makeSupervisorNoSleep(opts: {
  maxRestarts: number;
  restartDelayMs?: number;
  maxRestartDelayMs?: number;
}): Supervisor {
  const supervisor = new Supervisor({
    log: nullLog,
    maxRestarts: opts.maxRestarts,
    restartDelayMs: opts.restartDelayMs ?? 0,
    maxRestartDelayMs: opts.maxRestartDelayMs,
  });
  (supervisor as any).sleep = (_ms: number) => Promise.resolve();
  return supervisor;
}

/**
 * Build a ListenerSet where startup (first call) succeeds, and the N subsequent
 * loop calls all fail with a recoverable error.
 *
 * This lets us exercise the restart loop independently of the startup path.
 */
function loopAlwaysFails(): { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> } {
  let calls = 0;
  const start = vi.fn().mockImplementation(async () => {
    calls++;
    if (calls === 1) return; // startup succeeds
    throw new Error("loop failure");
  });
  return { start, stop: vi.fn() };
}

// ── Zero maxRestarts ──────────────────────────────────────────────────────────

describe("Supervisor — zero maxRestarts (no retry in the loop)", () => {
  it("enters failed after the first loop failure when maxRestarts=0", async () => {
    const supervisor = makeSupervisorNoSleep({ maxRestarts: 0 });
    const listeners = loopAlwaysFails();

    await supervisor.run(listeners).catch(() => {});

    // startup (call 1) + one loop attempt (call 2) = 2 total calls
    expect(listeners.start).toHaveBeenCalledTimes(2);
    expect(supervisor.state).toBe("failed");
  });

  it("restartCount is 1 after the first loop failure with maxRestarts=0", async () => {
    const supervisor = makeSupervisorNoSleep({ maxRestarts: 0 });
    await supervisor.run(loopAlwaysFails()).catch(() => {});
    // 1 loop failure → restartCount incremented once before ceiling check
    expect(supervisor.restarts).toBe(1);
  });

  it("throws 'max restarts exceeded' with maxRestarts=0", async () => {
    const supervisor = makeSupervisorNoSleep({ maxRestarts: 0 });
    await expect(supervisor.run(loopAlwaysFails())).rejects.toThrow(/max restarts/i);
  });
});

// ── One maxRestart ────────────────────────────────────────────────────────────

describe("Supervisor — one maxRestart", () => {
  it("allows exactly one loop restart before hitting failed", async () => {
    const supervisor = makeSupervisorNoSleep({ maxRestarts: 1 });
    const listeners = loopAlwaysFails();

    await supervisor.run(listeners).catch(() => {});

    // startup (1) + first loop attempt (2) + second loop attempt (3) = 3 total
    expect(listeners.start).toHaveBeenCalledTimes(3);
    expect(supervisor.restarts).toBe(2);
    expect(supervisor.state).toBe("failed");
  });

  it("ends in 'failed' after one loop restart", async () => {
    const supervisor = makeSupervisorNoSleep({ maxRestarts: 1 });
    await supervisor.run(loopAlwaysFails()).catch(() => {});
    expect(supervisor.state).toBe("failed");
  });

  it("resolves cleanly if the loop recovers on the first retry", async () => {
    const supervisor = makeSupervisorNoSleep({ maxRestarts: 1 });
    let calls = 0;
    const start = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls === 1) return; // startup succeeds
      if (calls === 2) throw new Error("first loop failure");
      // calls === 3: second loop attempt succeeds → clean exit
    });

    await expect(supervisor.run({ start, stop: vi.fn() })).resolves.toBeUndefined();
    expect(supervisor.restarts).toBe(1);
    expect(supervisor.state).toBe("stopped");
  });
});

// ── Configured maximum (N restarts) ──────────────────────────────────────────

describe("Supervisor — configured maximum restart boundary", () => {
  it.each([2, 3, 5])(
    "allows exactly %d loop restarts and fails on the next",
    async (maxRestarts) => {
      const supervisor = makeSupervisorNoSleep({ maxRestarts });
      const listeners = loopAlwaysFails();

      await supervisor.run(listeners).catch(() => {});

      // startup (1) + (maxRestarts + 1) loop attempts = maxRestarts + 2 total calls
      expect(listeners.start).toHaveBeenCalledTimes(maxRestarts + 2);
      // restartCount is incremented once per loop failure including the final one
      expect(supervisor.restarts).toBe(maxRestarts + 1);
      expect(supervisor.state).toBe("failed");
    }
  );

  it("throws 'max restarts exceeded' when the ceiling is breached", async () => {
    const supervisor = makeSupervisorNoSleep({ maxRestarts: 2 });
    await expect(supervisor.run(loopAlwaysFails())).rejects.toThrow(/max restarts/i);
  });

  it("recovers on the last allowed retry", async () => {
    const supervisor = makeSupervisorNoSleep({ maxRestarts: 3 });
    let calls = 0;
    const start = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls === 1) return; // startup
      if (calls <= 3) throw new Error("still failing"); // loop attempts 1–2 fail
      // 4th call (3rd loop attempt) succeeds
    });

    await expect(supervisor.run({ start, stop: vi.fn() })).resolves.toBeUndefined();
    expect(supervisor.state).toBe("stopped");
  });
});

// ── Startup failure is always fatal (not subject to maxRestarts) ──────────────

describe("Supervisor — startup failure bypasses maxRestarts", () => {
  it("fails immediately on startup error regardless of maxRestarts", async () => {
    const supervisor = makeSupervisorNoSleep({ maxRestarts: 99 });
    // Startup always fails — never enters the loop.
    const start = vi.fn().mockRejectedValue(new Error("startup failure"));

    await supervisor.run({ start, stop: vi.fn() }).catch(() => {});

    // Only one call — startup. No loop iterations.
    expect(start).toHaveBeenCalledTimes(1);
    expect(supervisor.restarts).toBe(0);
    expect(supervisor.state).toBe("failed");
  });

  it("startup failure throws the original error, not 'max restarts'", async () => {
    const supervisor = makeSupervisorNoSleep({ maxRestarts: 5 });
    const originalError = new Error("startup_specific_error");
    const start = vi.fn().mockRejectedValue(originalError);

    const caught = await supervisor.run({ start, stop: vi.fn() }).catch((e) => e);
    expect(caught).toBe(originalError);
  });
});

// ── State machine visibility ───────────────────────────────────────────────────

describe("Supervisor — terminal state visibility on exhaustion", () => {
  it("state is 'failed' (not 'stopped' or 'idle') after loop exhaustion", async () => {
    const supervisor = makeSupervisorNoSleep({ maxRestarts: 1 });

    await supervisor.run(loopAlwaysFails()).catch(() => {});

    expect(supervisor.state).toBe("failed");
    expect(supervisor.state).not.toBe("stopped");
    expect(supervisor.state).not.toBe("idle");
  });

  it("restarts count is accurate and observable after failure", async () => {
    const supervisor = makeSupervisorNoSleep({ maxRestarts: 4 });
    const listeners = loopAlwaysFails();

    await supervisor.run(listeners).catch(() => {});

    // startup + 5 loop attempts (maxRestarts+1) = 5 restarts counted
    expect(supervisor.restarts).toBe(5);
    expect(supervisor.state).toBe("failed");
  });
});

// ── FatalError always stops at zero restarts ───────────────────────────────────

describe("Supervisor — FatalError bypasses restart ceiling entirely", () => {
  it("FatalError in the loop ends in 'failed' without retry", async () => {
    const supervisor = makeSupervisorNoSleep({ maxRestarts: 99 });
    let calls = 0;
    const start = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls === 1) return; // startup succeeds
      throw new FatalError("fatal in loop");
    });

    await supervisor.run({ start, stop: vi.fn() }).catch(() => {});

    expect(supervisor.restarts).toBe(0);
    expect(supervisor.state).toBe("failed");
    expect(start).toHaveBeenCalledTimes(2); // startup + one loop call
  });

  it("FatalError propagates without triggering retry attempts", async () => {
    const supervisor = makeSupervisorNoSleep({ maxRestarts: 5 });
    let calls = 0;
    const start = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls === 1) return;
      throw new FatalError("config invalid");
    });

    await expect(supervisor.run({ start, stop: vi.fn() })).rejects.toBeInstanceOf(FatalError);
    expect(start).toHaveBeenCalledTimes(2);
  });
});

// ── No timing sleeps — fake timer verification ────────────────────────────────

describe("Supervisor — tests complete without real timing sleeps", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("all loop restarts resolve immediately with fake timers (no real delay)", async () => {
    const supervisor = new Supervisor({
      log: nullLog,
      maxRestarts: 3,
      restartDelayMs: 60_000, // would be very slow without fake timers
    });

    const listeners = loopAlwaysFails();
    // Catch immediately so the rejection is never unhandled.
    const resultPromise = supervisor.run(listeners).then(() => null, (e: Error) => e);

    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/max restarts/i);
    // startup + 4 loop attempts (maxRestarts+1)
    expect(listeners.start).toHaveBeenCalledTimes(5);
    expect(supervisor.state).toBe("failed");
  });

  it("zero maxRestarts resolves immediately even with a large restartDelayMs", async () => {
    const supervisor = new Supervisor({
      log: nullLog,
      maxRestarts: 0,
      restartDelayMs: 999_999,
    });

    const listeners = loopAlwaysFails();
    const resultPromise = supervisor.run(listeners).then(() => null, (e: Error) => e);

    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/max restarts/i);
    expect(supervisor.state).toBe("failed");
  });
});
