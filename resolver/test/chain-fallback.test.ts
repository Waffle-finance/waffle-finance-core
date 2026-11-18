/**
 * Tests for ChainFallbackPolicy (issue: fallback policy for degraded chains).
 *
 * Covers:
 *  - State transitions: healthy → degraded → suspended → healthy
 *  - canAct / canListen gate correctly for each state
 *  - allHealthy / hasAnySuspended aggregates
 *  - Independent per-chain tracking
 *  - Auto-recover via reportSuccess
 *  - forceReset
 *  - snapshot returns a copy, not a reference
 *  - Default-healthy for untracked chains
 *  - Threshold configuration
 *  - Logger called on state transitions
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import pino from "pino";
import {
  ChainFallbackPolicy,
  type ChainHealthState,
} from "../src/chain-fallback.js";

const silentLog = pino({ level: "silent" });

function makePolicy(opts?: {
  suspend?: number;
  degrade?: number;
}) {
  return new ChainFallbackPolicy({
    suspendAfterConsecutiveFailures: opts?.suspend ?? 5,
    degradeAfterConsecutiveFailures: opts?.degrade ?? 2,
  });
}

// ── Initial state ─────────────────────────────────────────────────────────────

describe("ChainFallbackPolicy — initial state", () => {
  it("untracked chain defaults to healthy", () => {
    const policy = makePolicy();
    expect(policy.getState("ethereum")).toBe("healthy");
  });

  it("canAct returns true for an untracked chain", () => {
    const policy = makePolicy();
    expect(policy.canAct("ethereum")).toBe(true);
  });

  it("canListen returns true for an untracked chain", () => {
    const policy = makePolicy();
    expect(policy.canListen("ethereum")).toBe(true);
  });

  it("allHealthy returns true when no chains tracked", () => {
    const policy = makePolicy();
    expect(policy.allHealthy()).toBe(true);
  });

  it("hasAnySuspended returns false when no chains tracked", () => {
    const policy = makePolicy();
    expect(policy.hasAnySuspended()).toBe(false);
  });
});

// ── State transitions ─────────────────────────────────────────────────────────

describe("ChainFallbackPolicy — state transitions", () => {
  it("stays healthy after fewer than degrade_threshold failures", () => {
    const policy = makePolicy({ degrade: 2, suspend: 5 });
    policy.reportFailure("ethereum"); // 1 failure — below degrade threshold
    expect(policy.getState("ethereum")).toBe("healthy");
  });

  it("transitions to degraded when degrade_threshold is reached", () => {
    const policy = makePolicy({ degrade: 2, suspend: 5 });
    policy.reportFailure("ethereum");
    policy.reportFailure("ethereum");
    expect(policy.getState("ethereum")).toBe("degraded");
  });

  it("transitions to suspended when suspend_threshold is reached", () => {
    const policy = makePolicy({ degrade: 2, suspend: 3 });
    policy.reportFailure("ethereum");
    policy.reportFailure("ethereum");
    policy.reportFailure("ethereum");
    expect(policy.getState("ethereum")).toBe("suspended");
  });

  it("reportFailure returns the resulting state", () => {
    const policy = makePolicy({ degrade: 1, suspend: 2 });
    expect(policy.reportFailure("ethereum")).toBe("degraded");
    expect(policy.reportFailure("ethereum")).toBe("suspended");
  });

  it("transitions back to healthy after a success from degraded", () => {
    const policy = makePolicy({ degrade: 2, suspend: 5 });
    policy.reportFailure("ethereum");
    policy.reportFailure("ethereum"); // degraded
    policy.reportSuccess("ethereum");
    expect(policy.getState("ethereum")).toBe("healthy");
  });

  it("transitions back to healthy after a success from suspended", () => {
    const policy = makePolicy({ degrade: 2, suspend: 3 });
    for (let i = 0; i < 5; i++) policy.reportFailure("ethereum");
    expect(policy.getState("ethereum")).toBe("suspended");
    policy.reportSuccess("ethereum");
    expect(policy.getState("ethereum")).toBe("healthy");
  });

  it("consecutive failure counter resets to 0 after success", () => {
    const policy = makePolicy({ degrade: 2, suspend: 5 });
    policy.reportFailure("ethereum");
    policy.reportFailure("ethereum");
    policy.reportSuccess("ethereum");
    // Should be able to fail up to degrade threshold again without hitting degraded immediately
    policy.reportFailure("ethereum"); // 1 — below threshold
    expect(policy.getState("ethereum")).toBe("healthy");
  });
});

// ── canAct / canListen ────────────────────────────────────────────────────────

describe("ChainFallbackPolicy — canAct / canListen", () => {
  it("canAct returns true when healthy", () => {
    const policy = makePolicy();
    expect(policy.canAct("ethereum")).toBe(true);
  });

  it("canAct returns true when degraded", () => {
    const policy = makePolicy({ degrade: 1, suspend: 5 });
    policy.reportFailure("ethereum");
    expect(policy.getState("ethereum")).toBe("degraded");
    expect(policy.canAct("ethereum")).toBe(true);
  });

  it("canAct returns false when suspended", () => {
    const policy = makePolicy({ degrade: 1, suspend: 2 });
    policy.reportFailure("ethereum");
    policy.reportFailure("ethereum");
    expect(policy.getState("ethereum")).toBe("suspended");
    expect(policy.canAct("ethereum")).toBe(false);
  });

  it("canListen returns false when suspended", () => {
    const policy = makePolicy({ degrade: 1, suspend: 2 });
    policy.reportFailure("ethereum");
    policy.reportFailure("ethereum");
    expect(policy.canListen("ethereum")).toBe(false);
  });

  it("canListen returns true after recovery from suspended", () => {
    const policy = makePolicy({ degrade: 1, suspend: 2 });
    policy.reportFailure("ethereum");
    policy.reportFailure("ethereum");
    policy.reportSuccess("ethereum");
    expect(policy.canListen("ethereum")).toBe(true);
  });
});

// ── Independent per-chain tracking ───────────────────────────────────────────

describe("ChainFallbackPolicy — per-chain independence", () => {
  it("suspending one chain does not affect another chain", () => {
    const policy = makePolicy({ degrade: 1, suspend: 2 });
    policy.reportFailure("ethereum");
    policy.reportFailure("ethereum"); // ethereum suspended
    // soroban untouched
    expect(policy.getState("ethereum")).toBe("suspended");
    expect(policy.getState("soroban")).toBe("healthy");
    expect(policy.canAct("soroban")).toBe(true);
  });

  it("recovering one chain does not affect another suspended chain", () => {
    const policy = makePolicy({ degrade: 1, suspend: 2 });
    policy.reportFailure("ethereum");
    policy.reportFailure("ethereum"); // ethereum suspended
    policy.reportFailure("soroban");
    policy.reportFailure("soroban");  // soroban suspended
    policy.reportSuccess("ethereum"); // only ethereum recovers
    expect(policy.getState("ethereum")).toBe("healthy");
    expect(policy.getState("soroban")).toBe("suspended");
  });

  it("allHealthy returns false when any chain is degraded", () => {
    const policy = makePolicy({ degrade: 1, suspend: 5 });
    policy.reportFailure("soroban");
    expect(policy.allHealthy()).toBe(false);
  });

  it("allHealthy returns true when all tracked chains are healthy", () => {
    const policy = makePolicy({ degrade: 2, suspend: 5 });
    policy.reportFailure("ethereum");
    policy.reportSuccess("ethereum");
    policy.reportFailure("soroban");
    policy.reportSuccess("soroban");
    expect(policy.allHealthy()).toBe(true);
  });

  it("hasAnySuspended is true when at least one chain is suspended", () => {
    const policy = makePolicy({ degrade: 1, suspend: 2 });
    policy.reportFailure("ethereum");
    policy.reportFailure("ethereum");
    policy.reportFailure("soroban");
    // soroban only degraded, ethereum suspended
    expect(policy.hasAnySuspended()).toBe(true);
  });

  it("hasAnySuspended is false when all chains are only degraded", () => {
    const policy = makePolicy({ degrade: 1, suspend: 5 });
    policy.reportFailure("ethereum"); // degraded
    policy.reportFailure("soroban");  // degraded
    expect(policy.hasAnySuspended()).toBe(false);
  });
});

// ── Snapshot ──────────────────────────────────────────────────────────────────

describe("ChainFallbackPolicy — snapshot", () => {
  it("snapshot returns copies of entries, not live references", () => {
    const policy = makePolicy({ degrade: 1, suspend: 2 });
    policy.reportFailure("ethereum");
    const snap = policy.snapshot();
    expect(snap).toHaveLength(1);
    // Mutating the snapshot should not affect internal state.
    snap[0]!.state = "healthy";
    expect(policy.getState("ethereum")).toBe("degraded");
  });

  it("snapshot includes all tracked chains", () => {
    const policy = makePolicy();
    policy.reportFailure("ethereum");
    policy.reportFailure("soroban");
    const snap = policy.snapshot();
    const chains = snap.map((e) => e.chain).sort();
    expect(chains).toEqual(["ethereum", "soroban"]);
  });
});

// ── forceReset ────────────────────────────────────────────────────────────────

describe("ChainFallbackPolicy — forceReset", () => {
  it("forceReset immediately returns chain to healthy from any state", () => {
    const states: ChainHealthState[] = ["degraded", "suspended"];
    for (const startState of states) {
      const policy = makePolicy({ degrade: 1, suspend: 2 });
      if (startState === "degraded") {
        policy.reportFailure("ethereum");
      } else {
        policy.reportFailure("ethereum");
        policy.reportFailure("ethereum");
      }
      expect(policy.getState("ethereum")).toBe(startState);
      policy.forceReset("ethereum");
      expect(policy.getState("ethereum")).toBe("healthy");
    }
  });
});

// ── Logger ────────────────────────────────────────────────────────────────────

describe("ChainFallbackPolicy — logger integration", () => {
  it("logs a warning when transitioning to degraded", () => {
    const warnSpy = vi.fn();
    const log = { ...silentLog, warn: warnSpy } as any;
    const policy = new ChainFallbackPolicy({
      degradeAfterConsecutiveFailures: 1,
      suspendAfterConsecutiveFailures: 5,
      log,
    });

    policy.reportFailure("ethereum");
    expect(warnSpy).toHaveBeenCalledOnce();
    const call = warnSpy.mock.calls[0];
    expect(call[0]).toMatchObject({ chain: "ethereum", newState: "degraded" });
  });

  it("logs an error when transitioning to suspended", () => {
    const errorSpy = vi.fn();
    const log = { ...silentLog, error: errorSpy } as any;
    const policy = new ChainFallbackPolicy({
      degradeAfterConsecutiveFailures: 1,
      suspendAfterConsecutiveFailures: 2,
      log,
    });

    policy.reportFailure("ethereum"); // degraded
    policy.reportFailure("ethereum"); // suspended
    expect(errorSpy).toHaveBeenCalledOnce();
    const call = errorSpy.mock.calls[0];
    expect(call[0]).toMatchObject({ chain: "ethereum", newState: "suspended" });
  });

  it("logs an info when recovering from suspended", () => {
    const infoSpy = vi.fn();
    const log = { ...silentLog, info: infoSpy } as any;
    const policy = new ChainFallbackPolicy({
      degradeAfterConsecutiveFailures: 1,
      suspendAfterConsecutiveFailures: 2,
      log,
    });

    policy.reportFailure("ethereum");
    policy.reportFailure("ethereum"); // suspended
    infoSpy.mockClear();
    policy.reportSuccess("ethereum");
    expect(infoSpy).toHaveBeenCalledOnce();
    const call = infoSpy.mock.calls[0];
    expect(call[0]).toMatchObject({ chain: "ethereum", newState: "healthy" });
  });

  it("does not log anything when the state does not change", () => {
    const warnSpy = vi.fn();
    const log = { ...silentLog, warn: warnSpy } as any;
    const policy = new ChainFallbackPolicy({
      degradeAfterConsecutiveFailures: 3,
      suspendAfterConsecutiveFailures: 10,
      log,
    });

    // Two failures — still below degrade threshold; state unchanged (healthy).
    policy.reportFailure("ethereum");
    policy.reportFailure("ethereum");
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
