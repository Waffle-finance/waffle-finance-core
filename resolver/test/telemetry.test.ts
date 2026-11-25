import { describe, it, expect, beforeEach } from "vitest";
import {
  computeResolverTelemetry,
  ResolverTelemetryCollector,
  type ComputeTelemetryInput,
} from "../src/telemetry.js";
import { Supervisor } from "../src/supervisor.js";
import {
  registry,
  listenerLastEventTimestampSeconds,
  operationFailuresTotal,
  activeOperations,
} from "../src/metrics.js";
import pino from "pino";

const log = pino({ level: "silent" });

function baseInput(overrides: Partial<ComputeTelemetryInput> = {}): ComputeTelemetryInput {
  return {
    supervisorState: "running",
    restarts: 0,
    nowSeconds: 1_000_000,
    chainLastEventSeconds: [
      { chain: "ethereum", lastEventSeconds: 999_990 },
      { chain: "soroban", lastEventSeconds: 999_995 },
    ],
    staleAfterSeconds: 300,
    recentFailureCount: 0,
    recentRetryCount: 0,
    commandQueueDepth: 0,
    degradedFailureThreshold: 3,
    ...overrides,
  };
}

describe("computeResolverTelemetry", () => {
  it("reports connected when running with fresh chains and no failures", () => {
    const snapshot = computeResolverTelemetry(baseInput());
    expect(snapshot.state).toBe("connected");
    expect(snapshot.chains.every((c) => c.live)).toBe(true);
  });

  it.each(["idle", "stopping", "stopped", "failed"] as const)(
    "reports inactive when supervisor state is %s",
    (supervisorState) => {
      const snapshot = computeResolverTelemetry(baseInput({ supervisorState }));
      expect(snapshot.state).toBe("inactive");
      expect(snapshot.reason).toContain(supervisorState);
    }
  );

  it("reports stale when a chain has gone quiet past the threshold", () => {
    const snapshot = computeResolverTelemetry(
      baseInput({
        chainLastEventSeconds: [
          { chain: "ethereum", lastEventSeconds: 999_990 },
          { chain: "soroban", lastEventSeconds: 999_000 }, // 1000s ago > 300s threshold
        ],
      })
    );
    expect(snapshot.state).toBe("stale");
    expect(snapshot.reason).toContain("soroban");
    const soroban = snapshot.chains.find((c) => c.chain === "soroban")!;
    expect(soroban.live).toBe(false);
    expect(soroban.secondsSinceLastEvent).toBe(1000);
  });

  it("reports stale when a chain has never reported an event", () => {
    const snapshot = computeResolverTelemetry(
      baseInput({
        chainLastEventSeconds: [
          { chain: "ethereum", lastEventSeconds: 999_990 },
          { chain: "soroban", lastEventSeconds: null },
        ],
      })
    );
    expect(snapshot.state).toBe("stale");
    const soroban = snapshot.chains.find((c) => c.chain === "soroban")!;
    expect(soroban.live).toBe(false);
    expect(soroban.secondsSinceLastEvent).toBeNull();
  });

  it("reports degraded when the supervisor is restarting but chains are still live", () => {
    const snapshot = computeResolverTelemetry(
      baseInput({ supervisorState: "restarting", restarts: 2 })
    );
    expect(snapshot.state).toBe("degraded");
    expect(snapshot.reason).toContain("restarting");
  });

  it("reports degraded when recent failures reach the threshold", () => {
    const snapshot = computeResolverTelemetry(baseInput({ recentFailureCount: 3 }));
    expect(snapshot.state).toBe("degraded");
    expect(snapshot.reason).toContain("failure");
  });

  it("does not report degraded when failures are below the threshold", () => {
    const snapshot = computeResolverTelemetry(baseInput({ recentFailureCount: 2 }));
    expect(snapshot.state).toBe("connected");
  });

  it("prioritizes inactive over stale and degraded", () => {
    const snapshot = computeResolverTelemetry(
      baseInput({
        supervisorState: "failed",
        chainLastEventSeconds: [{ chain: "ethereum", lastEventSeconds: null }],
        recentFailureCount: 10,
      })
    );
    expect(snapshot.state).toBe("inactive");
  });

  it("prioritizes stale over degraded", () => {
    const snapshot = computeResolverTelemetry(
      baseInput({
        supervisorState: "restarting",
        chainLastEventSeconds: [{ chain: "ethereum", lastEventSeconds: null }],
      })
    );
    expect(snapshot.state).toBe("stale");
  });

  it("passes through restarts and commandQueueDepth unchanged", () => {
    const snapshot = computeResolverTelemetry(baseInput({ restarts: 4, commandQueueDepth: 2 }));
    expect(snapshot.restarts).toBe(4);
    expect(snapshot.commandQueueDepth).toBe(2);
  });
});

describe("ResolverTelemetryCollector", () => {
  beforeEach(() => {
    registry.resetMetrics();
  });

  it("collects a connected snapshot from live metrics and supervisor state", async () => {
    const supervisor = new Supervisor({ log });
    // Drive the supervisor into "running" without a real listener loop.
    // Phase 1 (startup): resolves immediately so supervisor reaches "running".
    // Phase 2 (loop): never resolves so supervisor stays in "running".
    let startCalls = 0;
    const runPromise = supervisor.run({
      start: () => {
        startCalls++;
        if (startCalls === 1) return Promise.resolve(); // startup succeeds
        return new Promise(() => {}); // loop call never resolves
      },
      stop: async () => {},
    });
    void runPromise;

    // Wait for startup to complete and supervisor to enter running state.
    await new Promise((r) => setTimeout(r, 10));

    const now = Math.floor(Date.now() / 1000);
    listenerLastEventTimestampSeconds.set({ chain: "ethereum" }, now);
    listenerLastEventTimestampSeconds.set({ chain: "soroban" }, now);

    const collector = new ResolverTelemetryCollector();
    const snapshot = await collector.collect({
      supervisor,
      chains: ["ethereum", "soroban"],
    });

    expect(snapshot.state).toBe("connected");
    expect(snapshot.supervisorState).toBe("running");

    supervisor.stop();
  });

  it("reports inactive before the supervisor has started", async () => {
    const supervisor = new Supervisor({ log });
    const collector = new ResolverTelemetryCollector();

    const snapshot = await collector.collect({ supervisor, chains: ["ethereum"] });

    expect(snapshot.state).toBe("inactive");
    expect(snapshot.supervisorState).toBe("idle");
  });

  it("only counts failures/retries since the previous collection", async () => {
    const supervisor = new Supervisor({ log });
    const runPromise = supervisor.run({
      start: () => new Promise(() => {}),
      stop: async () => {},
    });
    void runPromise;

    const now = Math.floor(Date.now() / 1000);
    listenerLastEventTimestampSeconds.set({ chain: "ethereum" }, now);

    operationFailuresTotal.inc({ chain: "ethereum", operation: "register", failure_reason: "x" });
    operationFailuresTotal.inc({ chain: "ethereum", operation: "register", failure_reason: "x" });
    operationFailuresTotal.inc({ chain: "ethereum", operation: "register", failure_reason: "x" });

    const collector = new ResolverTelemetryCollector();
    const first = await collector.collect({
      supervisor,
      chains: ["ethereum"],
      degradedFailureThreshold: 3,
    });
    expect(first.recentFailureCount).toBe(3);
    expect(first.state).toBe("degraded");

    // No new failures since the last collection — should drop back to connected.
    const second = await collector.collect({
      supervisor,
      chains: ["ethereum"],
      degradedFailureThreshold: 3,
    });
    expect(second.recentFailureCount).toBe(0);
    expect(second.state).toBe("connected");

    supervisor.stop();
  });

  it("publishes the current state to the resolver_runtime_state_info gauge", async () => {
    const supervisor = new Supervisor({ log });
    const collector = new ResolverTelemetryCollector();

    await collector.collect({ supervisor, chains: ["ethereum"] });

    const metrics = await registry.metrics();
    expect(metrics).toContain('resolver_runtime_state_info{state="inactive"} 1');
    expect(metrics).toContain('resolver_runtime_state_info{state="connected"} 0');
  });

  it("reflects commandQueueDepth from in-flight operations", async () => {
    const supervisor = new Supervisor({ log });
    const runPromise = supervisor.run({
      start: () => new Promise(() => {}),
      stop: async () => {},
    });
    void runPromise;

    activeOperations.inc({ operation: "register" });
    activeOperations.inc({ operation: "status" });

    const collector = new ResolverTelemetryCollector();
    const snapshot = await collector.collect({ supervisor, chains: [] });

    expect(snapshot.commandQueueDepth).toBe(2);

    supervisor.stop();
  });
});
