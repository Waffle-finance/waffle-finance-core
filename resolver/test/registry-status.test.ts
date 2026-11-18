import { describe, it, expect, beforeEach, vi } from "vitest";
import pino from "pino";
import type { ResolverConfig } from "../src/config.js";
import {
  deriveLifecycleState,
  isOperationallyReady,
  ResolverStatusMonitor,
  ALL_LIFECYCLE_STATES,
  toBigIntSafe,
  type RawRegistryInfo,
  type ResolverLifecycleState,
} from "../src/registry-status.js";
import { registry, registrationInfo, registrationChangesTotal, resolverLifecycleState } from "../src/metrics.js";

const log = pino({ level: "silent" });

function baseConfig(overrides: Partial<ResolverConfig> = {}): ResolverConfig {
  return {
    network: "testnet",
    pollIntervalMs: 15_000,
    coordinatorUrl: "http://localhost:3001",
    logLevel: "info",
    ethereum: {
      rpcUrl: "https://rpc.example/testnet",
      chainId: 11_155_111,
      htlcEscrow: null,
      resolverRegistry: null,
      resolverPrivateKey: null,
    },
    soroban: {
      rpcUrl: "https://soroban-testnet.stellar.org",
      networkPassphrase: "Test SDF Network ; September 2015",
      horizonUrl: "https://horizon-testnet.stellar.org",
      htlc: null,
      resolverRegistry: null,
      resolverSecret: null,
    },
    ...overrides,
  };
}

function info(overrides: Partial<RawRegistryInfo> = {}): RawRegistryInfo {
  return {
    registered: true,
    active: true,
    stake: 100n,
    minStake: 50n,
    totalSlashed: 0n,
    unbondingAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  registry.resetMetrics();
});

describe("deriveLifecycleState", () => {
  it("unregistered — no on-chain record", () => {
    expect(deriveLifecycleState(info({ registered: false, active: false, stake: 0n }))).toBe(
      "unregistered"
    );
  });

  it("active — registered, sufficiently staked, active flag set", () => {
    expect(deriveLifecycleState(info({ stake: 100n, minStake: 50n, active: true }))).toBe("active");
  });

  it("low_stake — under minimum, never slashed (e.g. minStake was raised)", () => {
    expect(
      deriveLifecycleState(info({ stake: 40n, minStake: 50n, totalSlashed: 0n }))
    ).toBe("low_stake");
  });

  it("slashed — under minimum AND has a nonzero slash history", () => {
    expect(
      deriveLifecycleState(info({ stake: 40n, minStake: 50n, totalSlashed: 10n }))
    ).toBe("slashed");
  });

  it("unbonding — unbondingAt set takes precedence over a stake shortfall", () => {
    expect(
      deriveLifecycleState(
        info({ stake: 0n, minStake: 50n, totalSlashed: 0n, unbondingAt: 123n })
      )
    ).toBe("unbonding");
  });

  it("unbonding — takes precedence even when stake is still sufficient", () => {
    expect(deriveLifecycleState(info({ stake: 100n, minStake: 50n, unbondingAt: 999n }))).toBe(
      "unbonding"
    );
  });

  it("inactive — sufficiently staked but the contract's active flag is false", () => {
    expect(deriveLifecycleState(info({ stake: 100n, minStake: 50n, active: false }))).toBe(
      "inactive"
    );
  });

  it("stake exactly equal to minStake counts as sufficient (not low_stake)", () => {
    expect(deriveLifecycleState(info({ stake: 50n, minStake: 50n, active: true }))).toBe("active");
  });

  it("a past slash that has since been topped back up over minStake is just active", () => {
    expect(
      deriveLifecycleState(info({ stake: 100n, minStake: 50n, totalSlashed: 10n, active: true }))
    ).toBe("active");
  });
});

describe("isOperationallyReady", () => {
  it("active and unregistered are ready", () => {
    expect(isOperationallyReady("active")).toBe(true);
    expect(isOperationallyReady("unregistered")).toBe(true);
  });

  it("low_stake, slashed, unbonding, inactive are not ready", () => {
    const notReady: ResolverLifecycleState[] = ["low_stake", "slashed", "unbonding", "inactive"];
    for (const s of notReady) {
      expect(isOperationallyReady(s)).toBe(false);
    }
  });

  it("every declared state is covered by ALL_LIFECYCLE_STATES", () => {
    expect(ALL_LIFECYCLE_STATES.sort()).toEqual(
      (["unregistered", "active", "low_stake", "slashed", "unbonding", "inactive"] as const)
        .slice()
        .sort()
    );
  });
});

describe("ResolverStatusMonitor", () => {
  it("skips a chain whose probe returns null (not configured) — no metric, no state", async () => {
    const cfg = baseConfig();
    const evmProbe = vi.fn().mockResolvedValue(null);
    const sorobanProbe = vi.fn().mockResolvedValue(null);
    const monitor = new ResolverStatusMonitor(cfg, log, { evmProbe, sorobanProbe });

    await monitor.checkNow();

    expect(monitor.getState("ethereum")).toBeUndefined();
    expect(monitor.getState("soroban")).toBeUndefined();
    expect(monitor.isReady()).toBe(true);
  });

  it("records active state and sets the gauges", async () => {
    const cfg = baseConfig();
    const evmProbe = vi.fn().mockResolvedValue(info({ stake: 100n, minStake: 50n, active: true }));
    const sorobanProbe = vi.fn().mockResolvedValue(null);
    const monitor = new ResolverStatusMonitor(cfg, log, { evmProbe, sorobanProbe });

    await monitor.checkNow();

    expect(monitor.getState("ethereum")).toBe("active");
    expect(monitor.isReady()).toBe(true);

    const metrics = await registry.metrics();
    expect(metrics).toMatch(/resolver_registration_info\{chain="ethereum"\} 1/);
    expect(metrics).toMatch(
      /resolver_registry_lifecycle_state\{chain="ethereum",state="active"\} 1/
    );
    expect(metrics).toMatch(
      /resolver_registry_lifecycle_state\{chain="ethereum",state="slashed"\} 0/
    );
  });

  it("isReady() is false when a tracked chain is slashed", async () => {
    const cfg = baseConfig();
    const evmProbe = vi
      .fn()
      .mockResolvedValue(info({ stake: 10n, minStake: 50n, totalSlashed: 5n, active: false }));
    const sorobanProbe = vi.fn().mockResolvedValue(null);
    const monitor = new ResolverStatusMonitor(cfg, log, { evmProbe, sorobanProbe });

    await monitor.checkNow();

    expect(monitor.getState("ethereum")).toBe("slashed");
    expect(monitor.isReady()).toBe(false);
  });

  it("increments registrationChangesTotal only on an actual transition, not every tick", async () => {
    const cfg = baseConfig();
    const evmProbe = vi.fn().mockResolvedValue(info({ stake: 100n, minStake: 50n, active: true }));
    const sorobanProbe = vi.fn().mockResolvedValue(null);
    const monitor = new ResolverStatusMonitor(cfg, log, { evmProbe, sorobanProbe });

    await monitor.checkNow();
    await monitor.checkNow();
    await monitor.checkNow();

    const metrics = await registry.metrics();
    const match = metrics.match(/resolver_registration_changes_total\{action="active"\} (\d+)/);
    expect(match).not.toBeNull();
    expect(match![1]).toBe("1");
  });

  it("records a second transition when state changes from active to slashed", async () => {
    const cfg = baseConfig();
    let call = 0;
    const evmProbe = vi.fn().mockImplementation(async () => {
      call += 1;
      return call === 1
        ? info({ stake: 100n, minStake: 50n, active: true })
        : info({ stake: 10n, minStake: 50n, totalSlashed: 5n, active: false });
    });
    const sorobanProbe = vi.fn().mockResolvedValue(null);
    const monitor = new ResolverStatusMonitor(cfg, log, { evmProbe, sorobanProbe });

    await monitor.checkNow();
    expect(monitor.getState("ethereum")).toBe("active");

    await monitor.checkNow();
    expect(monitor.getState("ethereum")).toBe("slashed");

    const metrics = await registry.metrics();
    expect(metrics).toMatch(/resolver_registration_changes_total\{action="active"\} 1/);
    expect(metrics).toMatch(/resolver_registration_changes_total\{action="slashed"\} 1/);
  });

  it("a probe error is swallowed and logged — it doesn't throw or clear existing state", async () => {
    const cfg = baseConfig();
    const evmProbe = vi
      .fn()
      .mockResolvedValueOnce(info({ stake: 100n, minStake: 50n, active: true }))
      .mockRejectedValueOnce(new Error("RPC timeout"));
    const sorobanProbe = vi.fn().mockResolvedValue(null);
    const monitor = new ResolverStatusMonitor(cfg, log, { evmProbe, sorobanProbe });

    await monitor.checkNow();
    expect(monitor.getState("ethereum")).toBe("active");

    await expect(monitor.checkNow()).resolves.toBeUndefined();
    // State from the last successful probe is preserved, not cleared.
    expect(monitor.getState("ethereum")).toBe("active");
  });

  it("tracks ethereum and soroban independently", async () => {
    const cfg = baseConfig();
    const evmProbe = vi.fn().mockResolvedValue(info({ stake: 100n, minStake: 50n, active: true }));
    const sorobanProbe = vi
      .fn()
      .mockResolvedValue(info({ stake: 0n, minStake: 50n, unbondingAt: 999n }));
    const monitor = new ResolverStatusMonitor(cfg, log, { evmProbe, sorobanProbe });

    await monitor.checkNow();

    expect(monitor.getState("ethereum")).toBe("active");
    expect(monitor.getState("soroban")).toBe("unbonding");
    expect(monitor.isReady()).toBe(false);
  });

  it("start()/stop() schedule and cancel the polling timer without leaking it", async () => {
    vi.useFakeTimers();
    try {
      const cfg = baseConfig();
      const evmProbe = vi.fn().mockResolvedValue(info());
      const sorobanProbe = vi.fn().mockResolvedValue(null);
      const monitor = new ResolverStatusMonitor(cfg, log, {
        evmProbe,
        sorobanProbe,
        intervalMs: 1000,
      });

      monitor.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(evmProbe).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1000);
      expect(evmProbe).toHaveBeenCalledTimes(2);

      monitor.stop();
      await vi.advanceTimersByTimeAsync(5000);
      // No further calls after stop().
      expect(evmProbe).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stop() called before the first tick prevents any RPC request", async () => {
    vi.useFakeTimers();
    try {
      const cfg = baseConfig();
      const evmProbe = vi.fn().mockResolvedValue(info());
      const sorobanProbe = vi.fn().mockResolvedValue(null);
      const monitor = new ResolverStatusMonitor(cfg, log, {
        evmProbe,
        sorobanProbe,
        intervalMs: 1000,
      });

      // Start the monitor, let the initial tick fire, then stop.
      monitor.start();
      await vi.advanceTimersByTimeAsync(0); // drain the first async tick
      const callsAfterFirstTick = evmProbe.mock.calls.length;

      monitor.stop();

      // Advance well past multiple intervals — no further probes should fire.
      await vi.advanceTimersByTimeAsync(5000);

      expect(evmProbe).toHaveBeenCalledTimes(callsAfterFirstTick);
    } finally {
      vi.useRealTimers();
    }
  });

  it("repeated stop() calls are harmless (idempotent)", () => {
    const cfg = baseConfig();
    const monitor = new ResolverStatusMonitor(cfg, log, {
      evmProbe: vi.fn().mockResolvedValue(null),
      sorobanProbe: vi.fn().mockResolvedValue(null),
    });
    expect(() => {
      monitor.stop();
      monitor.stop();
      monitor.stop();
    }).not.toThrow();
  });
});

// ── Cache freshness ─────────────────────────────────────────────────────────

describe("ResolverStatusMonitor — status cache freshness", () => {
  it("marks a fresh successful read as not stale with a freshness timestamp", async () => {
    const cfg = baseConfig();
    const evmProbe = vi.fn().mockResolvedValue(info());
    const monitor = new ResolverStatusMonitor(cfg, log, {
      evmProbe,
      sorobanProbe: vi.fn().mockResolvedValue(null),
      staleAfterMs: 60_000,
    });

    await monitor.checkNow();

    expect(monitor.getState("ethereum")).toBe("active");
    expect(monitor.getLastUpdatedAt("ethereum")).toEqual(expect.any(Number));
    expect(monitor.isStale("ethereum")).toBe(false);
    // Fresh status counts toward readiness — health may rely on it.
    expect(monitor.isReady()).toBe(true);
    const snapshot = monitor.getStatusSnapshot();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]).toMatchObject({ chain: "ethereum", state: "active", stale: false });
    expect(snapshot[0].lastUpdatedAt).toEqual(expect.any(Number));
  });

  it("marks cached status stale after the threshold without a refresh", async () => {
    vi.useFakeTimers();
    try {
      const cfg = baseConfig();
      const evmProbe = vi.fn().mockResolvedValue(info());
      const monitor = new ResolverStatusMonitor(cfg, log, {
        evmProbe,
        sorobanProbe: vi.fn().mockResolvedValue(null),
        staleAfterMs: 1_000,
      });

      await monitor.checkNow();
      expect(monitor.isStale("ethereum")).toBe(false);

      // Advance past the cache threshold with no further successful read.
      vi.setSystemTime(Date.now() + 1_001);
      expect(monitor.isStale("ethereum")).toBe(true);
      // Stale data is distinguishable from fresh status via the snapshot.
      const snapshot = monitor.getStatusSnapshot();
      expect(snapshot[0].stale).toBe(true);
      expect(snapshot[0].state).toBe("active");
    } finally {
      vi.useRealTimers();
    }
  });

  it("failed refresh preserves last-known data and marks it stale rather than overstating readiness", async () => {
    vi.useFakeTimers();
    try {
      const cfg = baseConfig();
      const evmProbe = vi.fn().mockResolvedValue(info());
      const monitor = new ResolverStatusMonitor(cfg, log, {
        evmProbe,
        sorobanProbe: vi.fn().mockResolvedValue(null),
        staleAfterMs: 1_000,
      });

      await monitor.checkNow();
      const lastUpdated = monitor.getLastUpdatedAt("ethereum");
      expect(lastUpdated).toEqual(expect.any(Number));

      // Next read rejects (RPC error): last-known value must be preserved
      // and the freshness clock must NOT reset.
      evmProbe.mockRejectedValueOnce(new Error("RPC down"));
      vi.setSystemTime(Date.now() + 1_001);
      await monitor.checkNow();

      expect(monitor.getState("ethereum")).toBe("active");
      expect(monitor.getLastUpdatedAt("ethereum")).toBe(lastUpdated);
      expect(monitor.isStale("ethereum")).toBe(true);
      // Readiness still reflects the last-known value, but consumers can see
      // it is stale instead of mistaking it for a current read.
      expect(monitor.getStatusSnapshot()[0]).toMatchObject({ state: "active", stale: true });
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── toBigIntSafe ──────────────────────────────────────────────────────────────

describe("toBigIntSafe — safe integer range guard", () => {
  it("passes through bigint values unchanged", () => {
    expect(toBigIntSafe(123n, "stake")).toBe(123n);
    expect(toBigIntSafe(0n, "stake")).toBe(0n);
  });

  it("converts a string representation with full precision", () => {
    // A value larger than Number.MAX_SAFE_INTEGER — can only be represented as
    // a string or bigint without precision loss.
    const large = "9007199254740993"; // MAX_SAFE_INTEGER + 2
    expect(toBigIntSafe(large, "stake")).toBe(9007199254740993n);
  });

  it("converts a safe integer number", () => {
    expect(toBigIntSafe(42, "stake")).toBe(42n);
    expect(toBigIntSafe(Number.MAX_SAFE_INTEGER, "stake")).toBe(BigInt(Number.MAX_SAFE_INTEGER));
  });

  it("throws RangeError for a number larger than MAX_SAFE_INTEGER", () => {
    const unsafe = Number.MAX_SAFE_INTEGER + 1; // already rounded — cannot be exact
    expect(() => toBigIntSafe(unsafe, "stake")).toThrow(RangeError);
    expect(() => toBigIntSafe(unsafe, "stake")).toThrow(/stake/);
  });

  it("throws RangeError for a floating-point number", () => {
    expect(() => toBigIntSafe(1.5, "totalSlashed")).toThrow(RangeError);
  });

  it("throws RangeError for Infinity", () => {
    expect(() => toBigIntSafe(Infinity, "minStake")).toThrow(RangeError);
  });

  it("throws RangeError for NaN", () => {
    expect(() => toBigIntSafe(NaN, "minStake")).toThrow(RangeError);
  });
});
