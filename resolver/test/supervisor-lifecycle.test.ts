/**
 * supervisor-lifecycle.test.ts
 *
 * Tests for resolver supervisor lifecycle enhancements (Part C).
 *
 * Covers:
 *  - SupervisorState transitions: idle → running → restarting → stopped/failed
 *  - maxRestartDelayMs: cap on exponential backoff
 *  - stop() cancels the restart sleep immediately
 *  - run() resolves cleanly when stopped mid-restart (no throw)
 *  - state machine monotonicity (no transitions backward)
 *  - health endpoint reflects state correctly
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import pino from "pino";
import { Supervisor, FatalError, type SupervisorState } from "../src/supervisor.js";
import { createResolverHealthServer, type ResolverHealthDeps } from "../src/health.js";
import type { ResolverConfig } from "../src/config.js";

const nullLog = pino({ level: "silent" });

function makeSupervisor(opts?: {
  maxRestarts?: number;
  restartDelayMs?: number;
  maxRestartDelayMs?: number;
}) {
  return new Supervisor({
    log: nullLog,
    maxRestarts: opts?.maxRestarts ?? 3,
    restartDelayMs: opts?.restartDelayMs ?? 0,
    maxRestartDelayMs: opts?.maxRestartDelayMs,
  });
}

// ── SupervisorState transitions ───────────────────────────────────────────────

describe("Supervisor — state transitions", () => {
  it("starts in 'idle' state before run() is called", () => {
    const supervisor = makeSupervisor();
    expect(supervisor.state).toBe("idle");
  });

  it("transitions to 'running' when listeners are starting", async () => {
    const supervisor = makeSupervisor();
    let capturedState: SupervisorState = "idle";

    const start = vi.fn().mockImplementation(async () => {
      capturedState = supervisor.state;
    });

    await supervisor.run({ start, stop: vi.fn() });
    expect(capturedState).toBe("running");
  });

  it("transitions to 'stopped' after a clean listener exit", async () => {
    const supervisor = makeSupervisor();
    await supervisor.run({ start: vi.fn(), stop: vi.fn() });
    expect(supervisor.state).toBe("stopped");
  });

  it("transitions to 'restarting' after a recoverable error", async () => {
    const supervisor = makeSupervisor({ restartDelayMs: 5 });
    const observedStates: SupervisorState[] = [];
    let attempt = 0;

    const start = vi.fn().mockImplementation(async () => {
      attempt++;
      if (attempt === 1) throw new Error("transient");
      // On the second attempt, record the state we see (should be "running" again).
      observedStates.push(supervisor.state);
    });

    // Patch sleep to capture the state while in the delay phase.
    (supervisor as any).sleep = async (_ms: number) => {
      observedStates.push(supervisor.state); // should be "restarting"
    };

    await supervisor.run({ start, stop: vi.fn() });

    expect(observedStates).toContain("restarting");
    expect(supervisor.state).toBe("stopped");
  });

  it("transitions to 'failed' when maxRestarts is exceeded", async () => {
    const supervisor = makeSupervisor({ maxRestarts: 2 });
    const start = vi.fn().mockRejectedValue(new Error("always fails"));

    await expect(supervisor.run({ start, stop: vi.fn() })).rejects.toThrow();
    expect(supervisor.state).toBe("failed");
  });

  it("transitions to 'failed' on a FatalError", async () => {
    const supervisor = makeSupervisor();
    const start = vi.fn().mockRejectedValue(new FatalError("config invalid"));

    await expect(supervisor.run({ start, stop: vi.fn() })).rejects.toBeInstanceOf(FatalError);
    expect(supervisor.state).toBe("failed");
  });

  it("transitions to 'stopping' when stop() is called", () => {
    const supervisor = makeSupervisor();
    supervisor.stop();
    expect(supervisor.state).toBe("stopping");
  });

  it("transitions from 'stopping' to 'stopped' when run() completes", async () => {
    const supervisor = makeSupervisor({ restartDelayMs: 50 });

    let resolveDelay!: () => void;
    const delayPromise = new Promise<void>((r) => {
      resolveDelay = r;
    });

    const start = vi.fn().mockImplementation(async () => {
      throw new Error("transient");
    });

    // Use originalSleep so the real sleepReject mechanism is preserved.
    const originalSleep = (supervisor as any).sleep.bind(supervisor);
    (supervisor as any).sleep = async (ms: number) => {
      resolveDelay();
      return originalSleep(ms);
    };

    const runPromise = supervisor.run({ start, stop: vi.fn() });
    await delayPromise;

    expect(supervisor.state).toBe("restarting");
    supervisor.stop();
    expect(supervisor.state).toBe("stopping");

    await runPromise;
    expect(supervisor.state).toBe("stopped");
  });
});

// ── maxRestartDelayMs cap ─────────────────────────────────────────────────────

describe("Supervisor — maxRestartDelayMs", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("caps the restart delay at maxRestartDelayMs", async () => {
    const delays: number[] = [];
    const supervisor = new Supervisor({
      log: nullLog,
      maxRestarts: 5,
      restartDelayMs: 1_000,
      maxRestartDelayMs: 3_000,
    });

    let attempt = 0;
    const start = vi.fn().mockImplementation(async () => {
      attempt++;
      if (attempt < 5) throw new Error("transient");
    });

    // Patch the internal sleep to capture the delay.
    (supervisor as any).sleep = async (ms: number) => {
      delays.push(ms);
      return new Promise((resolve) => setTimeout(resolve, 0));
    };

    const p = supervisor.run({ start, stop: vi.fn() });
    await vi.runAllTimersAsync();
    await p;

    // Without cap: 1000, 2000, 4000, 8000. With cap of 3000: 1000, 2000, 3000, 3000.
    expect(delays.at(0)).toBe(1_000);
    expect(delays.at(1)).toBe(2_000);
    expect(delays.at(2)).toBe(3_000);
    expect(delays.at(3)).toBe(3_000);
  });

  it("defaults maxRestartDelayMs to 60_000", () => {
    const supervisor = new Supervisor({
      log: nullLog,
      restartDelayMs: 5_000,
    });
    // Internal check: the field is private but behaviour is observable.
    // A large number of restarts would hit the cap.
    expect((supervisor as any).maxRestartDelayMs).toBe(60_000);
  });
});

// ── stop() cancels restart sleep ─────────────────────────────────────────────

describe("Supervisor — stop() during restart sleep", () => {
  it("resolves the sleep promise immediately when stop() is called", async () => {
    const supervisor = makeSupervisor({ restartDelayMs: 1_000 });

    let resolveDelay!: () => void;
    const delayPromise = new Promise<void>((r) => {
      resolveDelay = r;
    });

    const start = vi.fn().mockImplementation(async () => {
      throw new Error("transient");
    });

    // Patch the sleep to signal when it's entered.
    const originalSleep = (supervisor as any).sleep.bind(supervisor);
    (supervisor as any).sleep = async (ms: number) => {
      resolveDelay();
      return originalSleep(ms);
    };

    const runPromise = supervisor.run({ start, stop: vi.fn() });

    // Wait for the supervisor to enter the sleep phase.
    await delayPromise;

    const t0 = Date.now();
    supervisor.stop();
    await runPromise;
    const elapsed = Date.now() - t0;

    // Sleep was aborted: elapsed should be much less than 1000ms.
    expect(elapsed).toBeLessThan(100);
  });

  it("run() resolves cleanly (does not reject) when stopped mid-sleep", async () => {
    const supervisor = makeSupervisor({ restartDelayMs: 100 });

    let resolveDelay!: () => void;
    const delayPromise = new Promise<void>((r) => {
      resolveDelay = r;
    });

    const start = vi.fn().mockImplementation(async () => {
      throw new Error("transient");
    });

    // Use originalSleep so the real sleepReject mechanism is preserved.
    const originalSleep = (supervisor as any).sleep.bind(supervisor);
    (supervisor as any).sleep = async (ms: number) => {
      resolveDelay();
      return originalSleep(ms);
    };

    const runPromise = supervisor.run({ start, stop: vi.fn() });
    await delayPromise;

    supervisor.stop();

    // run() must resolve, not reject.
    await expect(runPromise).resolves.toBeUndefined();
  });

  it("calling stop() multiple times is safe (idempotent)", () => {
    const supervisor = makeSupervisor();
    expect(() => {
      supervisor.stop();
      supervisor.stop();
      supervisor.stop();
    }).not.toThrow();
  });
});

// ── isStopped backward-compat accessor ────────────────────────────────────────

describe("Supervisor — isStopped (deprecated accessor)", () => {
  it("returns false before stop() is called", () => {
    const supervisor = makeSupervisor();
    expect(supervisor.isStopped).toBe(false);
  });

  it("returns true after stop() is called", () => {
    const supervisor = makeSupervisor();
    supervisor.stop();
    expect(supervisor.isStopped).toBe(true);
  });
});

// ── Health endpoint state reflection ─────────────────────────────────────────

describe("resolver health endpoints — supervisor state", () => {
  const baseConfig: ResolverConfig = {
    network: "testnet",
    pollIntervalMs: 15_000,
    coordinatorUrl: "http://localhost:3001",
    logLevel: "error",
    ethereum: {
      rpcUrl: "https://ethereum.example/rpc",
      chainId: 11_155_111,
      htlcEscrow: "0x0000000000000000000000000000000000000001",
      resolverRegistry: null,
      resolverPrivateKey: "0x0000000000000000000000000000000000000000000000000000000000000001",
    },
    soroban: {
      rpcUrl: "https://soroban.example/rpc",
      horizonUrl: "https://horizon.example",
      networkPassphrase: "Test SDF Network ; September 2015",
      htlc: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB",
      resolverRegistry: null,
      resolverSecret: "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    },
  };

  function makeDeps(supervisorState: SupervisorState): ResolverHealthDeps {
    const supervisor = makeSupervisor();
    (supervisor as any)._state = supervisorState; // Inject state directly for testing.
    return {
      cfg: baseConfig,
      supervisor,
      startedAt: Date.now(),
    };
  }

  /** Start a health server on a random port, run the test callback, then close. */
  async function withServer(
    deps: ResolverHealthDeps,
    fn: (baseUrl: string) => Promise<void>
  ): Promise<void> {
    const server = createResolverHealthServer(deps);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as any).port as number;
    try {
      await fn(`http://127.0.0.1:${port}`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it("GET /readyz returns 503 when supervisor state is 'stopping'", async () => {
    await withServer(makeDeps("stopping"), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/readyz`);
      const body = await res.json();
      expect(res.status).toBe(503);
      expect(body.status).toBe("degraded");
      expect(body.supervisorState).toBe("stopping");
    });
  });

  it("GET /readyz returns 503 when supervisor state is 'stopped'", async () => {
    await withServer(makeDeps("stopped"), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/readyz`);
      expect(res.status).toBe(503);
    });
  });

  it("GET /readyz returns 503 when supervisor state is 'failed'", async () => {
    await withServer(makeDeps("failed"), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/readyz`);
      expect(res.status).toBe(503);
    });
  });

  it("GET /readyz returns 200 when supervisor state is 'running'", async () => {
    await withServer(makeDeps("running"), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/readyz`);
      expect(res.status).toBe(200);
    });
  });

  it("GET /readyz returns 200 when supervisor state is 'idle' (not yet started)", async () => {
    await withServer(makeDeps("idle"), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/readyz`);
      expect(res.status).toBe(200);
    });
  });

  it("GET /health includes supervisorState in the response body", async () => {
    await withServer(makeDeps("restarting"), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/health`);
      const body = await res.json();
      expect(body.supervisorState).toBe("restarting");
    });
  });

  it("GET /health status='stopping' when state is 'stopping'", async () => {
    await withServer(makeDeps("stopping"), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/health`);
      const body = await res.json();
      expect(body.status).toBe("stopping");
    });
  });

  it("GET /health status='unhealthy' when state is 'failed'", async () => {
    await withServer(makeDeps("failed"), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/health`);
      const body = await res.json();
      expect(res.status).toBe(503);
      expect(body.status).toBe("unhealthy");
    });
  });

  it("GET /health includes checks array with supervisor check detail", async () => {
    await withServer(makeDeps("running"), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/health`);
      const body = await res.json();
      const supervisorCheck = body.checks.find((c: any) => c.name === "supervisor");
      expect(supervisorCheck).toMatchObject({
        name: "supervisor",
        ok: true,
        detail: "running",
      });
    });
  });
});
