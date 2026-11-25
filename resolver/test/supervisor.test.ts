import { describe, it, expect, vi, beforeEach } from "vitest";
import pino from "pino";
import { Supervisor, FatalError } from "../src/supervisor.js";

const nullLog = pino({ level: "silent" });

function makeSupervisor(opts?: { maxRestarts?: number; restartDelayMs?: number }) {
  return new Supervisor({
    log: nullLog,
    maxRestarts: opts?.maxRestarts ?? 3,
    restartDelayMs: opts?.restartDelayMs ?? 0,
  });
}

describe("Supervisor", () => {
  describe("clean exit", () => {
    it("resolves when the listener set starts without error", async () => {
      const supervisor = makeSupervisor();
      // Phase 1 (startup): start() resolves → running.
      // Phase 2 (loop): start() resolves → stopped.
      const start = vi
        .fn()
        .mockResolvedValueOnce(undefined) // startup
        .mockResolvedValueOnce(undefined); // loop clean exit
      const stop = vi.fn().mockResolvedValue(undefined);

      await expect(supervisor.run({ start, stop })).resolves.toBeUndefined();
      expect(start).toHaveBeenCalledTimes(2);
    });

    it("does not restart after a clean exit", async () => {
      const supervisor = makeSupervisor();
      const start = vi
        .fn()
        .mockResolvedValueOnce(undefined) // startup
        .mockResolvedValueOnce(undefined); // loop clean exit
      const stop = vi.fn();

      await supervisor.run({ start, stop });
      expect(start).toHaveBeenCalledTimes(2);
      expect(supervisor.restarts).toBe(0);
    });
  });

  describe("recoverable errors — restart behaviour", () => {
    it("restarts after a single recoverable error then exits cleanly", async () => {
      // Startup succeeds; first loop call fails; second loop call succeeds.
      const supervisor = makeSupervisor();
      const start = vi
        .fn()
        .mockResolvedValueOnce(undefined)       // startup
        .mockRejectedValueOnce(new Error("rpc timeout")) // loop iteration 1 → restart
        .mockResolvedValueOnce(undefined);      // loop iteration 2 → clean exit
      const stop = vi.fn();

      await supervisor.run({ start, stop });
      expect(start).toHaveBeenCalledTimes(3);
      expect(supervisor.restarts).toBe(1);
    });

    it("retries up to maxRestarts times before rejecting", async () => {
      const supervisor = makeSupervisor({ maxRestarts: 2 });
      // Startup succeeds; all loop calls fail.
      const start = vi
        .fn()
        .mockResolvedValueOnce(undefined) // startup
        .mockRejectedValue(new Error("persistent error")); // loop always fails
      const stop = vi.fn();

      await expect(supervisor.run({ start, stop })).rejects.toThrow("max restarts");
      // startup(1) + 3 loop attempts (maxRestarts+1) = 4 total
      expect(start).toHaveBeenCalledTimes(4);
      expect(supervisor.restarts).toBe(3);
    });

    it("counts restarts accurately across multiple failures", async () => {
      const supervisor = makeSupervisor({ maxRestarts: 3 });
      let calls = 0;
      const start = vi.fn().mockImplementation(async () => {
        calls++;
        if (calls === 1) return; // startup succeeds
        if (calls < 4) throw new Error("not yet"); // loop iterations 1,2 fail
        // loop iteration 3 succeeds
      });
      const stop = vi.fn();

      await supervisor.run({ start, stop });
      expect(supervisor.restarts).toBe(2);
    });
  });

  describe("fatal errors — no restart", () => {
    it("does not restart on a FatalError in startup", async () => {
      const supervisor = makeSupervisor();
      const start = vi.fn().mockRejectedValue(new FatalError("config invalid"));
      const stop = vi.fn();

      await expect(supervisor.run({ start, stop })).rejects.toBeInstanceOf(FatalError);
      expect(start).toHaveBeenCalledTimes(1);
      expect(supervisor.restarts).toBe(0);
    });

    it("does not restart on a FatalError in the loop", async () => {
      const supervisor = makeSupervisor();
      const start = vi
        .fn()
        .mockResolvedValueOnce(undefined) // startup succeeds
        .mockRejectedValue(new FatalError("config invalid")); // loop always fatal
      const stop = vi.fn();

      await expect(supervisor.run({ start, stop })).rejects.toBeInstanceOf(FatalError);
      expect(start).toHaveBeenCalledTimes(2);
      expect(supervisor.restarts).toBe(0);
    });

    it("propagates the FatalError so the caller can handle it", async () => {
      const supervisor = makeSupervisor();
      const fatal = new FatalError("bad chain id");
      const start = vi.fn().mockRejectedValue(fatal);
      const stop = vi.fn();

      const rejected = await supervisor.run({ start, stop }).catch((e) => e);
      expect(rejected).toBe(fatal);
    });
  });

  describe("stop() — graceful shutdown", () => {
    it("isStopped returns false before stop() is called", () => {
      const supervisor = makeSupervisor();
      expect(supervisor.isStopped).toBe(false);
    });

    it("isStopped returns true after stop() is called", () => {
      const supervisor = makeSupervisor();
      supervisor.stop();
      expect(supervisor.isStopped).toBe(true);
    });

    it("stop() is idempotent — calling it twice does not throw", () => {
      const supervisor = makeSupervisor();
      expect(() => {
        supervisor.stop();
        supervisor.stop();
      }).not.toThrow();
    });

    it("exits the restart loop when stop() is called mid-restart", async () => {
      const supervisor = makeSupervisor({ restartDelayMs: 50 });

      let resolveDelay!: () => void;
      const delayPromise = new Promise<void>((res) => { resolveDelay = res; });

      let calls = 0;
      const start = vi.fn().mockImplementation(async () => {
        calls++;
        if (calls === 1) return; // startup succeeds
        // First loop call: throw so the supervisor enters the retry wait.
        throw new Error("transient");
      });
      const stop = vi.fn();

      // Patch the private sleep so we can interject.
      const origSleep = (supervisor as any).sleep.bind(supervisor);
      (supervisor as any).sleep = async (ms: number) => {
        // Signal the test that the supervisor is now in the sleep phase.
        resolveDelay();
        return origSleep(ms);
      };

      const runPromise = supervisor.run({ start, stop });

      // Wait until the supervisor is sleeping before the first restart.
      await delayPromise;

      // Stop the supervisor while it is waiting to restart.
      supervisor.stop();

      // The run() should resolve cleanly (not reject).
      await expect(runPromise).resolves.toBeUndefined();
      expect(start).toHaveBeenCalledTimes(2);
    });
  });

  describe("isRecoverable()", () => {
    it("returns false for FatalError instances", () => {
      const supervisor = makeSupervisor();
      expect(supervisor.isRecoverable(new FatalError("oops"))).toBe(false);
    });

    it("returns true for generic Error instances", () => {
      const supervisor = makeSupervisor();
      expect(supervisor.isRecoverable(new Error("timeout"))).toBe(true);
    });

    it("returns true for non-Error values (strings, objects)", () => {
      const supervisor = makeSupervisor();
      expect(supervisor.isRecoverable("some string error")).toBe(true);
      expect(supervisor.isRecoverable({ code: 503 })).toBe(true);
    });
  });
});

describe("FatalError", () => {
  it("is an instance of Error", () => {
    expect(new FatalError("x")).toBeInstanceOf(Error);
  });

  it("has name FatalError", () => {
    expect(new FatalError("x").name).toBe("FatalError");
  });

  it("stores an optional cause", () => {
    const cause = new Error("underlying");
    const err = new FatalError("wrapper", cause);
    expect(err.cause).toBe(cause);
  });
});
