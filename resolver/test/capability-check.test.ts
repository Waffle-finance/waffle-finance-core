/**
 * Tests for CapabilityChecker and CapabilityError
 * (issue: capability checks before resolver actions).
 *
 * Covers:
 *  - Policy layer: unsupported action is blocked
 *  - Fallback layer: suspended chain blocks acting
 *  - Registry layer: non-ready standing blocks acting
 *  - All-pass: check returns ok when all layers pass
 *  - assertCanAct: throws CapabilityError with correct code
 *  - checkAll: collects all failures in one pass
 *  - assertPolicySupports: standalone helper
 *  - Logger: warn is called on capability failure
 *  - Optional layers: checker works without fallback/statusMonitor
 */

import { describe, it, expect, vi } from "vitest";
import pino from "pino";
import {
  CapabilityChecker,
  CapabilityError,
  assertPolicySupports,
} from "../src/capability-check.js";
import { ChainFallbackPolicy } from "../src/chain-fallback.js";

const silentLog = pino({ level: "silent" });

// ── Minimal SupportPolicy stub ────────────────────────────────────────────────

/**
 * Build a mock SupportPolicy whose `supportsAction` behaviour can be
 * controlled per-chain and per-action.
 *
 * The real @wafflefinance/config `supportsAction` is a free function;
 * we stub it by constructing a mock policy object that makes
 * `supportsAction` return what we want via vi.mock at the module level.
 *
 * Since we can't easily mock named package exports here without module-level
 * vi.mock(), we test through a factory that takes a `supported` flag,
 * verifying the checker's routing correctly.
 *
 * Approach: mock the entire `@wafflefinance/config` module so `supportsAction`
 * returns a value we control.
 */
vi.mock("@wafflefinance/config", () => ({
  supportsAction: vi.fn(),
}));

import { supportsAction } from "@wafflefinance/config";

const mockSupportsAction = vi.mocked(supportsAction);

/** Returns a minimal stub SupportPolicy (shape is unused — supportsAction is mocked). */
function stubPolicy() {
  return {} as import("@wafflefinance/config").SupportPolicy;
}

/** Build a mock ResolverStatusMonitor with controllable `isReady` / `getState`. */
function stubMonitor(opts: { ready?: boolean; state?: string } = {}) {
  return {
    isReady: vi.fn().mockReturnValue(opts.ready ?? true),
    getState: vi.fn().mockReturnValue(opts.state ?? "active"),
  } as any;
}

function makeChecker(opts: {
  supported?: boolean;
  reason?: string;
  fallback?: ChainFallbackPolicy;
  monitorReady?: boolean;
  monitorState?: string;
  log?: any;
} = {}) {
  mockSupportsAction.mockReturnValue({
    supported: opts.supported ?? true,
    code: opts.supported === false ? "missing_htlc" : undefined,
    reason: opts.reason ?? (opts.supported === false ? "HTLC address not configured" : undefined),
  } as any);

  return new CapabilityChecker({
    policy: stubPolicy(),
    fallback: opts.fallback,
    statusMonitor:
      opts.monitorReady !== undefined || opts.monitorState !== undefined
        ? stubMonitor({ ready: opts.monitorReady, state: opts.monitorState })
        : undefined,
    log: opts.log,
  });
}

// ── Layer 1: static policy ────────────────────────────────────────────────────

describe("CapabilityChecker — policy layer", () => {
  it("returns ok=true when policy supports the action", () => {
    const checker = makeChecker({ supported: true });
    const result = checker.check("ethereum", "claim");
    expect(result.ok).toBe(true);
    expect(result.code).toBeNull();
  });

  it("returns ok=false with code=policy_unsupported when policy blocks the action", () => {
    const checker = makeChecker({ supported: false, reason: "HTLC address not configured" });
    const result = checker.check("ethereum", "claim");
    expect(result.ok).toBe(false);
    expect(result.code).toBe("policy_unsupported");
    expect(result.reason).toContain("HTLC");
  });
});

// ── Layer 2: chain-fallback ────────────────────────────────────────────────────

describe("CapabilityChecker — fallback layer", () => {
  it("returns ok=false with code=chain_suspended when chain is suspended", () => {
    const fallback = new ChainFallbackPolicy({
      degradeAfterConsecutiveFailures: 1,
      suspendAfterConsecutiveFailures: 2,
    });
    fallback.reportFailure("ethereum");
    fallback.reportFailure("ethereum"); // suspended

    const checker = makeChecker({ supported: true, fallback });
    const result = checker.check("ethereum", "claim", "ethereum");
    expect(result.ok).toBe(false);
    expect(result.code).toBe("chain_suspended");
    expect(result.reason).toContain("ethereum");
  });

  it("returns ok=true when chain is degraded (not yet suspended)", () => {
    const fallback = new ChainFallbackPolicy({
      degradeAfterConsecutiveFailures: 1,
      suspendAfterConsecutiveFailures: 5,
    });
    fallback.reportFailure("ethereum"); // degraded, not suspended

    const checker = makeChecker({ supported: true, fallback });
    const result = checker.check("ethereum", "claim", "ethereum");
    expect(result.ok).toBe(true);
  });

  it("runtimeChain parameter routes the fallback check correctly", () => {
    const fallback = new ChainFallbackPolicy({
      degradeAfterConsecutiveFailures: 1,
      suspendAfterConsecutiveFailures: 2,
    });
    fallback.reportFailure("soroban");
    fallback.reportFailure("soroban"); // soroban suspended, stellar policy chain

    const checker = makeChecker({ supported: true, fallback });
    // policyChain="stellar", runtimeChain="soroban"
    const result = checker.check("stellar", "claim", "soroban");
    expect(result.ok).toBe(false);
    expect(result.code).toBe("chain_suspended");
  });
});

// ── Layer 3: registry standing ────────────────────────────────────────────────

describe("CapabilityChecker — registry layer", () => {
  it("returns ok=true when monitor reports active standing", () => {
    const checker = makeChecker({
      supported: true,
      monitorReady: true,
      monitorState: "active",
    });
    const result = checker.check("ethereum", "claim", "ethereum");
    expect(result.ok).toBe(true);
  });

  it("returns ok=false with code=registry_not_ready when state is slashed", () => {
    const monitor = stubMonitor({ ready: false, state: "slashed" });
    mockSupportsAction.mockReturnValue({ supported: true } as any);
    const checker = new CapabilityChecker({
      policy: stubPolicy(),
      statusMonitor: monitor,
    });
    const result = checker.check("ethereum", "claim", "ethereum");
    expect(result.ok).toBe(false);
    expect(result.code).toBe("registry_not_ready");
    expect(result.reason).toContain("slashed");
  });

  it("does not block when monitor reports unregistered (observe-only deployment)", () => {
    const monitor = stubMonitor({ ready: true, state: "unregistered" });
    mockSupportsAction.mockReturnValue({ supported: true } as any);
    const checker = new CapabilityChecker({
      policy: stubPolicy(),
      statusMonitor: monitor,
    });
    const result = checker.check("ethereum", "claim", "ethereum");
    expect(result.ok).toBe(true);
  });

  it.each(["low_stake", "unbonding", "inactive"] as const)(
    "blocks action when registry state is %s",
    (badState) => {
      const monitor = stubMonitor({ ready: false, state: badState });
      mockSupportsAction.mockReturnValue({ supported: true } as any);
      const checker = new CapabilityChecker({
        policy: stubPolicy(),
        statusMonitor: monitor,
      });
      const result = checker.check("ethereum", "claim", "ethereum");
      expect(result.ok).toBe(false);
      expect(result.code).toBe("registry_not_ready");
    }
  );
});

// ── assertCanAct ───────────────────────────────────────────────────────────────

describe("CapabilityChecker — assertCanAct", () => {
  it("does not throw when all checks pass", () => {
    const checker = makeChecker({ supported: true });
    expect(() => checker.assertCanAct("ethereum", "claim")).not.toThrow();
  });

  it("throws CapabilityError when policy blocks the action", () => {
    const checker = makeChecker({ supported: false, reason: "no HTLC configured" });
    expect(() => checker.assertCanAct("ethereum", "claim")).toThrow(CapabilityError);
  });

  it("CapabilityError has the correct code", () => {
    const checker = makeChecker({ supported: false });
    let err: CapabilityError | undefined;
    try {
      checker.assertCanAct("ethereum", "claim");
    } catch (e) {
      err = e as CapabilityError;
    }
    expect(err).toBeInstanceOf(CapabilityError);
    expect(err!.code).toBe("policy_unsupported");
  });

  it("CapabilityError is an instance of Error", () => {
    expect(new CapabilityError("test_code", "msg")).toBeInstanceOf(Error);
  });

  it("logs a warning when assertCanAct fails", () => {
    const warnSpy = vi.fn();
    const log = { ...silentLog, warn: warnSpy } as any;
    const checker = makeChecker({ supported: false, log });
    try { checker.assertCanAct("ethereum", "claim"); } catch { /* expected */ }
    expect(warnSpy).toHaveBeenCalledOnce();
    const args = warnSpy.mock.calls[0];
    expect(args[0]).toMatchObject({ action: "claim", code: "policy_unsupported" });
  });
});

// ── checkAll ──────────────────────────────────────────────────────────────────

describe("CapabilityChecker — checkAll", () => {
  it("returns empty array when all requirements pass", () => {
    mockSupportsAction.mockReturnValue({ supported: true } as any);
    const checker = new CapabilityChecker({ policy: stubPolicy() });
    const failures = checker.checkAll([
      { policyChain: "ethereum", action: "observe" },
      { policyChain: "stellar",  action: "observe" },
    ]);
    expect(failures).toHaveLength(0);
  });

  it("returns only the failing requirements", () => {
    let call = 0;
    mockSupportsAction.mockImplementation(() => {
      call++;
      return call === 1
        ? { supported: false, reason: "no eth config" }
        : { supported: true };
    });
    const checker = new CapabilityChecker({ policy: stubPolicy() });
    const failures = checker.checkAll([
      { policyChain: "ethereum", action: "claim" },
      { policyChain: "stellar",  action: "claim" },
    ]);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.code).toBe("policy_unsupported");
  });
});

// ── assertPolicySupports ──────────────────────────────────────────────────────

describe("assertPolicySupports — standalone helper", () => {
  it("does not throw when policy supports the action", () => {
    mockSupportsAction.mockReturnValue({ supported: true } as any);
    expect(() =>
      assertPolicySupports(stubPolicy(), "ethereum", "observe")
    ).not.toThrow();
  });

  it("throws CapabilityError when policy does not support the action", () => {
    mockSupportsAction.mockReturnValue({
      supported: false,
      reason: "no HTLC configured",
    } as any);
    expect(() =>
      assertPolicySupports(stubPolicy(), "ethereum", "claim")
    ).toThrow(CapabilityError);
  });

  it("logs a warning when the check fails and a logger is provided", () => {
    const warnSpy = vi.fn();
    const log = { ...silentLog, warn: warnSpy } as any;
    mockSupportsAction.mockReturnValue({ supported: false, reason: "missing key" } as any);
    try {
      assertPolicySupports(stubPolicy(), "ethereum", "claim", log);
    } catch { /* expected */ }
    expect(warnSpy).toHaveBeenCalledOnce();
  });
});

// ── Optional layers ───────────────────────────────────────────────────────────

describe("CapabilityChecker — optional layers", () => {
  it("works without fallback or statusMonitor when policy passes", () => {
    mockSupportsAction.mockReturnValue({ supported: true } as any);
    const checker = new CapabilityChecker({ policy: stubPolicy() });
    expect(checker.check("ethereum", "claim").ok).toBe(true);
  });

  it("works without fallback or statusMonitor when policy fails", () => {
    mockSupportsAction.mockReturnValue({ supported: false, reason: "no config" } as any);
    const checker = new CapabilityChecker({ policy: stubPolicy() });
    expect(checker.check("ethereum", "claim").ok).toBe(false);
  });
});
