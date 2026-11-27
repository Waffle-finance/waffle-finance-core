/**
 * Integration tests: resolver behavior when registry eligibility changes
 * before and after an order is accepted (issue #1097).
 *
 * Wires the real ResolverStatusMonitor (with scripted registry probes), the
 * OrderEligibilityGate, the ResolverWorkLimiter and a ResolverKeyRing through
 * ResolverOrderIntake — the same composition `commands/run.ts` uses.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import pino from "pino";
import { ResolverStatusMonitor } from "../src/registry-status.js";
import { OrderEligibilityGate, toRegistryChain } from "../src/order-eligibility.js";
import { ResolverWorkLimiter } from "../src/work-limiter.js";
import { ResolverKeyRing, deriveKeyId, type ResolverSigner } from "../src/key-rotation.js";
import { ResolverOrderIntake } from "../src/order-intake.js";
import { registry } from "../src/metrics.js";
import {
  ACTIVE,
  INACTIVE,
  LOW_STAKE,
  NOT_CONFIGURED,
  SLASHED,
  UNAVAILABLE,
  UNBONDING,
  UNREGISTERED,
  resolverConfig,
  scriptedProbe,
  type RegistryResponse,
} from "./fixtures/registry.js";

const log = pino({ level: "silent" });

function signer(name: string): ResolverSigner {
  const address = `0x${name.padEnd(40, "0")}`;
  return { keyId: deriveKeyId("ethereum", address), address, sign: async (p) => `${name}:${String(p)}` };
}

function harness(eth: RegistryResponse, soroban: RegistryResponse = NOT_CONFIGURED) {
  const ethProbe = scriptedProbe(eth);
  const sorobanProbe = scriptedProbe(soroban);
  const monitor = new ResolverStatusMonitor(resolverConfig(), log, {
    evmProbe: ethProbe.probe,
    sorobanProbe: sorobanProbe.probe,
    staleAfterMs: 120_000,
  });
  const gate = new OrderEligibilityGate({ monitor, log });
  const limiter = new ResolverWorkLimiter({ log, dedupTtlMs: 0 });
  const ring = new ResolverKeyRing({ chain: "ethereum", initial: signer("k1"), log });
  const intake = new ResolverOrderIntake({ limiter, gate, keyRings: new Map([["ethereum", ring]]), log });
  const work: string[] = [];
  const handler = (label: string) => async (s?: ResolverSigner) => {
    work.push(`${label}@${s?.keyId ?? "none"}`);
  };
  return { monitor, gate, intake, ring, ethProbe, sorobanProbe, work, handler };
}

beforeEach(() => {
  registry.resetMetrics();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("new work requires an eligible registry status", () => {
  it("active resolver accepts new orders", async () => {
    const h = harness(ACTIVE);
    await h.monitor.checkNow();
    expect(await h.intake.onOrderCreated("ethereum", "1", h.handler("create-1"))).toEqual({ status: "processed" });
    expect(h.work).toEqual([`create-1@${h.ring.activeKey}`]);
  });

  it.each([
    ["inactive", INACTIVE],
    ["slashed", SLASHED],
    ["low_stake", LOW_STAKE],
    ["unbonding", UNBONDING],
    ["unregistered", UNREGISTERED],
  ] as const)("%s resolver does not accept new orders", async (state, fixture) => {
    const h = harness(fixture);
    await h.monitor.checkNow();
    expect(h.monitor.getState("ethereum")).toBe(state);
    expect(await h.intake.onOrderCreated("ethereum", "1", h.handler("create-1"))).toEqual({
      status: "skipped",
      reason: "not_active",
    });
    expect(h.work).toEqual([]);
    expect(h.ring.keyFor("1")).toBeUndefined();
  });

  it("registry never read (startup outage) refuses new orders", async () => {
    const h = harness(UNAVAILABLE);
    await h.monitor.checkNow();
    expect(await h.intake.onOrderCreated("ethereum", "1", h.handler("create"))).toEqual({
      status: "skipped",
      reason: "registry_unavailable",
    });
  });

  it("before the first probe completes, new orders are refused", async () => {
    const h = harness(ACTIVE);
    expect(h.gate.checkNewWork("ethereum")).toMatchObject({ eligible: false, reason: "registry_unavailable" });
  });

  it("chain without a configured registry is not gated", async () => {
    const h = harness(ACTIVE, NOT_CONFIGURED);
    await h.monitor.checkNow();
    expect(h.gate.checkNewWork("soroban")).toEqual({ eligible: true, basis: "registry_not_configured" });
    expect(h.gate.checkNewWork("solana")).toEqual({ eligible: true, basis: "registry_not_configured" });
  });

  it("each chain is gated by its own registry", async () => {
    const h = harness(ACTIVE, SLASHED);
    await h.monitor.checkNow();
    expect(h.gate.checkNewWork("ethereum").eligible).toBe(true);
    expect(h.gate.checkNewWork("soroban")).toMatchObject({ eligible: false, reason: "not_active", state: "slashed" });
    expect(toRegistryChain("stellar")).toBe("soroban");
  });
});

describe("registry status changes after an order is accepted", () => {
  it("deactivation stops new work but in-flight claim and refund still run", async () => {
    const h = harness(ACTIVE);
    await h.monitor.checkNow();
    await h.intake.onOrderCreated("ethereum", "A", h.handler("create-A"));
    await h.intake.onOrderCreated("ethereum", "B", h.handler("create-B"));

    h.ethProbe.set(INACTIVE);
    await h.monitor.checkNow();

    expect(await h.intake.onOrderCreated("ethereum", "C", h.handler("create-C"))).toMatchObject({ status: "skipped" });
    expect(await h.intake.onSettlement("ethereum", "A", "claim", h.handler("claim-A"))).toEqual({ status: "processed" });
    expect(await h.intake.onSettlement("ethereum", "B", "refund", h.handler("refund-B"))).toEqual({ status: "processed" });

    expect(h.work.map((w) => w.split("@")[0])).toEqual(["create-A", "create-B", "claim-A", "refund-B"]);
    expect(h.gate.inFlightCount()).toBe(0);
  });

  it("slash after acceptance: recovery duties are retained", async () => {
    const h = harness(ACTIVE);
    await h.monitor.checkNow();
    await h.intake.onOrderCreated("ethereum", "A", h.handler("create-A"));
    h.ethProbe.set(SLASHED);
    await h.monitor.checkNow();
    expect(await h.intake.onSettlement("ethereum", "A", "refund", h.handler("refund-A"))).toEqual({ status: "processed" });
  });

  it("registry outage after acceptance: in-flight work completes, unknown orders are not claimed", async () => {
    const h = harness(ACTIVE);
    await h.monitor.checkNow();
    await h.intake.onOrderCreated("ethereum", "A", h.handler("create-A"));

    h.ethProbe.set(UNAVAILABLE);
    await h.monitor.checkNow();
    // Last-known state is still "active", but the probe failed: fail closed.
    expect(h.monitor.getState("ethereum")).toBe("active");

    expect(await h.intake.onSettlement("ethereum", "X", "claim", h.handler("claim-X"))).toEqual({
      status: "skipped",
      reason: "registry_unavailable",
    });
    expect(await h.intake.onOrderCreated("ethereum", "N", h.handler("create-N"))).toMatchObject({
      status: "skipped",
      reason: "registry_unavailable",
    });
    expect(await h.intake.onSettlement("ethereum", "A", "claim", h.handler("claim-A"))).toEqual({ status: "processed" });
    expect(h.work.map((w) => w.split("@")[0])).toEqual(["create-A", "claim-A"]);
  });

  it("refund for an order never accepted here is refused (nothing of ours to return)", async () => {
    const h = harness(ACTIVE);
    await h.monitor.checkNow();
    expect(await h.intake.onSettlement("ethereum", "Z", "refund", h.handler("refund-Z"))).toEqual({
      status: "skipped",
      reason: "not_accepted",
    });
  });

  it("stale registry status refuses new work", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const h = harness(ACTIVE);
    await h.monitor.checkNow();
    expect(h.gate.checkNewWork("ethereum").eligible).toBe(true);
    vi.setSystemTime(1_000_000 + 121_000);
    expect(h.gate.checkNewWork("ethereum")).toMatchObject({ eligible: false, reason: "registry_stale" });
  });

  it("an order skipped while ineligible is processed once eligibility returns", async () => {
    const h = harness(INACTIVE);
    await h.monitor.checkNow();
    expect((await h.intake.onOrderCreated("ethereum", "R", h.handler("create-R"))).status).toBe("skipped");

    h.ethProbe.set(ACTIVE);
    await h.monitor.checkNow();
    expect(await h.intake.onOrderCreated("ethereum", "R", h.handler("create-R"))).toEqual({ status: "processed" });
  });
});

describe("intake composition", () => {
  it("in-flight orders keep their signing key across a rotation", async () => {
    const h = harness(ACTIVE);
    await h.monitor.checkNow();
    await h.intake.onOrderCreated("ethereum", "A", h.handler("create-A"));
    const k1 = h.ring.activeKey!;
    const k2 = signer("k2");
    h.ring.rotate(k2, 0);

    await h.intake.onOrderCreated("ethereum", "B", h.handler("create-B"));
    await h.intake.onSettlement("ethereum", "A", "claim", h.handler("claim-A"));
    expect(h.work).toEqual([`create-A@${k1}`, `create-B@${k2.keyId}`, `claim-A@${k1}`]);
    // A settled and the window was 0: the old key retires.
    expect(h.ring.snapshot().keys.map((k) => k.keyId)).toEqual([k2.keyId]);
  });

  it("a failing create handler rolls back acceptance and key binding", async () => {
    const h = harness(ACTIVE);
    await h.monitor.checkNow();
    await expect(
      h.intake.onOrderCreated("ethereum", "F", async () => {
        throw new Error("rpc down");
      })
    ).rejects.toThrow("rpc down");
    expect(h.gate.isInFlight("ethereum", "F")).toBe(false);
    expect(h.ring.keyFor("F")).toBeUndefined();
  });

  it("duplicate settlement events run the handler once", async () => {
    const h = harness(ACTIVE);
    await h.monitor.checkNow();
    await h.intake.onOrderCreated("ethereum", "D", h.handler("create-D"));
    const results = await Promise.all(
      Array.from({ length: 10 }, () => h.intake.onSettlement("ethereum", "D", "claim", h.handler("claim-D")))
    );
    expect(results.filter((r) => r.status === "processed")).toHaveLength(1);
    expect(h.work.filter((w) => w.startsWith("claim-D"))).toHaveLength(1);
  });
});
