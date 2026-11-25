/**
 * Issue #1093 — per-chain progress age telemetry.
 *
 * Covers the pure classifier, the snapshot fields on /telemetry, and the
 * StalenessMonitor's progress metrics (the inputs to ResolverListenerProgressStalled).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PROGRESS_STALE_AFTER_SECONDS,
  StalenessMonitor,
  classifyListenerProgress,
  computeProgressAgeSeconds,
  computeResolverTelemetry,
  progressThresholdsFromEnv,
  type ComputeTelemetryInput,
} from "../src/telemetry.js";
import {
  listenerProgressAgeSeconds,
  listenerProgressStaleThresholdSeconds,
  listenerProgressState,
  registry,
} from "../src/metrics.js";

const base = {
  isActive: true,
  consecutiveFailures: 0,
  secondsSinceLastPoll: null,
  secondsSinceLastEvent: null,
  secondsSinceStart: null,
  staleAfterSeconds: 300,
};

describe("classifyListenerProgress", () => {
  it("is active when an event was processed within the threshold", () => {
    expect(classifyListenerProgress({ ...base, secondsSinceLastPoll: 5, secondsSinceLastEvent: 60 })).toBe("active");
  });

  it("is idle when polls succeed but no recent events (quiet chain)", () => {
    expect(classifyListenerProgress({ ...base, secondsSinceLastPoll: 5, secondsSinceLastEvent: 3600 })).toBe("idle");
    expect(classifyListenerProgress({ ...base, secondsSinceLastPoll: 5 })).toBe("idle");
  });

  it("is stale when neither polls nor events advance beyond the threshold", () => {
    expect(classifyListenerProgress({ ...base, secondsSinceLastPoll: 301, secondsSinceLastEvent: 900 })).toBe("stale");
  });

  it("is degraded when the listener is stopped or failing repeatedly", () => {
    expect(classifyListenerProgress({ ...base, isActive: false, secondsSinceLastPoll: 1 })).toBe("degraded");
    expect(classifyListenerProgress({ ...base, consecutiveFailures: 3, secondsSinceLastPoll: 1 })).toBe("degraded");
  });

  it("ages from start before the first progress", () => {
    expect(classifyListenerProgress({ ...base, secondsSinceStart: 10 })).toBe("idle");
    expect(classifyListenerProgress({ ...base, secondsSinceStart: 301 })).toBe("stale");
    expect(classifyListenerProgress(base)).toBe("stale");
  });

  it("progress age is the most recent of poll and event", () => {
    expect(computeProgressAgeSeconds({ secondsSinceLastPoll: 40, secondsSinceLastEvent: 7, secondsSinceStart: 999 })).toBe(7);
    expect(computeProgressAgeSeconds({ secondsSinceLastPoll: null, secondsSinceLastEvent: null, secondsSinceStart: 12 })).toBe(12);
  });
});

describe("computeResolverTelemetry progress fields", () => {
  const now = 10_000;
  const input = (overrides: Partial<ComputeTelemetryInput>): ComputeTelemetryInput => ({
    supervisorState: "running",
    restarts: 0,
    nowSeconds: now,
    chainLastEventSeconds: [{ chain: "soroban", lastEventSeconds: null }],
    staleAfterSeconds: 300,
    recentFailureCount: 0,
    recentRetryCount: 0,
    commandQueueDepth: 0,
    degradedFailureThreshold: 3,
    ...overrides,
  });

  it("reports a healthy quiet poll chain as idle and the resolver as connected", () => {
    const snap = computeResolverTelemetry(
      input({
        chainHealthData: [
          {
            chain: "soroban",
            lastHealthyTickSeconds: now - 5,
            consecutiveFailures: 0,
            missedEventBatches: 0,
            isActive: true,
            listener: "poll",
            lastPollSuccessSeconds: now - 5,
            lastProcessedEventSeconds: null,
            startedAtSeconds: now - 7200,
            progressStaleAfterSeconds: 300,
          },
        ],
      }),
    );
    expect(snap.chains[0]).toMatchObject({
      listener: "poll",
      progressState: "idle",
      progressAgeSeconds: 5,
      progressStaleAfterSeconds: 300,
      secondsSinceLastPoll: 5,
      secondsSinceLastProcessedEvent: null,
    });
    expect(snap.stalledChains).toEqual([]);
    expect(snap.state).toBe("connected");
  });

  it("reports a connected-but-stalled poll chain as stale", () => {
    const snap = computeResolverTelemetry(
      input({
        chainHealthData: [
          {
            chain: "soroban",
            lastHealthyTickSeconds: now - 600,
            consecutiveFailures: 0,
            missedEventBatches: 0,
            isActive: true,
            listener: "poll",
            lastPollSuccessSeconds: now - 600,
            lastProcessedEventSeconds: null,
            startedAtSeconds: now - 7200,
            progressStaleAfterSeconds: 300,
          },
        ],
      }),
    );
    expect(snap.chains[0].progressState).toBe("stale");
    expect(snap.chains[0].progressAgeSeconds).toBe(600);
    expect(snap.stalledChains).toEqual(["soroban"]);
    expect(snap.state).toBe("stale");
  });

  it("reports an active chain and falls back to defaults without monitor data", () => {
    const snap = computeResolverTelemetry(
      input({ chainLastEventSeconds: [{ chain: "ethereum", lastEventSeconds: now - 30 }] }),
    );
    expect(snap.chains[0]).toMatchObject({
      listener: "subscription",
      progressState: "active",
      progressStaleAfterSeconds: DEFAULT_PROGRESS_STALE_AFTER_SECONDS.subscription,
      secondsSinceLastProcessedEvent: 30,
    });
  });
});

describe("StalenessMonitor progress metrics", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-25T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const gaugeValue = async (
    gauge: { get(): Promise<{ values: Array<{ labels: Record<string, unknown>; value: number }> }> },
    labels: Record<string, string>,
  ) => {
    const { values } = await gauge.get();
    return values.find((v) => Object.entries(labels).every(([k, val]) => v.labels[k] === val))?.value;
  };

  it("moves idle → stale when polls stop advancing and exposes the alert inputs", async () => {
    const chain = "progress-test-a";
    const monitor = new StalenessMonitor({ progressStaleAfterSeconds: { [chain]: 120 } });
    monitor.recordStarted(chain, "poll");
    monitor.recordHealthyTick(chain); // successful poll, no events

    expect(monitor.progressStateFor(chain)).toBe("idle");

    vi.advanceTimersByTime(121_000);
    monitor.refreshProgressGauges();

    expect(monitor.progressStateFor(chain)).toBe("stale");
    const labels = { chain, listener: "poll" };
    expect(await gaugeValue(listenerProgressAgeSeconds, labels)).toBe(121);
    expect(await gaugeValue(listenerProgressStaleThresholdSeconds, labels)).toBe(120);
    expect(await gaugeValue(listenerProgressState, { ...labels, state: "stale" })).toBe(1);
    expect(await gaugeValue(listenerProgressState, { ...labels, state: "idle" })).toBe(0);
  });

  it("is active after a processed event and degraded after repeated failures", () => {
    const chain = "progress-test-b";
    const monitor = new StalenessMonitor();
    monitor.recordStarted(chain, "poll");
    monitor.recordEventProcessed(chain);
    monitor.recordHealthyTick(chain);
    expect(monitor.progressStateFor(chain)).toBe("active");

    monitor.recordFailure(chain);
    monitor.recordFailure(chain);
    monitor.recordFailure(chain);
    expect(monitor.progressStateFor(chain)).toBe("degraded");

    monitor.recordHealthyTick(chain);
    expect(monitor.progressStateFor(chain)).toBe("active");

    monitor.recordStopped(chain);
    expect(monitor.progressStateFor(chain)).toBe("degraded");
  });

  it("snapshots progress timestamps per chain", () => {
    const chain = "progress-test-c";
    const monitor = new StalenessMonitor();
    monitor.recordStarted(chain, "subscription");
    monitor.recordHealthyTick(chain, "event");
    const nowSeconds = Math.floor(Date.now() / 1000);
    expect(monitor.snapshotChainData().find((c) => c.chain === chain)).toMatchObject({
      listener: "subscription",
      lastPollSuccessSeconds: null,
      lastProcessedEventSeconds: nowSeconds,
      startedAtSeconds: nowSeconds,
      progressStaleAfterSeconds: DEFAULT_PROGRESS_STALE_AFTER_SECONDS.subscription,
    });
  });

  it("refreshes progress age on a /metrics scrape", async () => {
    const { globalStalenessMonitor } = await import("../src/telemetry.js");
    const chain = "progress-test-scrape";
    globalStalenessMonitor.setProgressThreshold(chain, 60);
    globalStalenessMonitor.recordStarted(chain, "poll");
    globalStalenessMonitor.recordHealthyTick(chain);
    vi.advanceTimersByTime(90_000);

    const text = await registry.metrics();
    expect(text).toContain(
      `resolver_listener_progress_age_seconds{chain="${chain}",listener="poll"} 90`,
    );
    expect(text).toContain(
      `resolver_listener_progress_state{chain="${chain}",listener="poll",state="stale"} 1`,
    );
  });

  it("rejects non-positive thresholds", () => {
    expect(() => new StalenessMonitor().setProgressThreshold("x", 0)).toThrow(RangeError);
  });
});

describe("progressThresholdsFromEnv", () => {
  it("parses per-chain overrides and ignores invalid values", () => {
    expect(
      progressThresholdsFromEnv({
        RESOLVER_PROGRESS_STALE_AFTER_SECONDS_ETHEREUM: "900",
        RESOLVER_PROGRESS_STALE_AFTER_SECONDS_SOROBAN: "abc",
        RESOLVER_PROGRESS_STALE_AFTER_SECONDS_SOLANA: "0",
        UNRELATED: "1",
      }),
    ).toEqual({ ethereum: 900 });
  });
});
