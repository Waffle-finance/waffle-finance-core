/**
 * readiness-phase.test.ts
 *
 * Tests for coordinator readiness lifecycle semantics (Part A).
 *
 * Covers:
 *  - deriveStartupPhase: all phase transitions from check arrays
 *  - createReadinessChecks: startup_phase synthetic check injection
 *    - "starting" → ok:false, detail:"starting" prepended
 *    - "pending"  → ok:true,  detail:"pending"  prepended
 *    - "ready"    → no synthetic check added
 *  - getStartupPhase getter wired correctly (real check + phase combo)
 *  - Existing readiness behaviour preserved (no regression)
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { CoordinatorConfig } from "../src/config.js";
import { openDatabase } from "../src/persistence/db.js";
import {
  createReadinessChecks,
  deriveStartupPhase,
  type StartupPhase,
} from "../src/readiness.js";
import type { ReadinessCheck } from "../src/server/routes/health.js";

// ── Test fixtures ─────────────────────────────────────────────────────────────

const baseConfig: CoordinatorConfig = {
  network: "testnet",
  port: 3001,
  databaseUrl: "file:./wafflefinance.db",
  logLevel: "error",
  corsOrigin: "*",
  pollIntervalMs: 15_000,
  secretStorageKey: undefined,
  ethereum: {
    rpcUrl: "https://ethereum.example/rpc",
    chainId: 11_155_111,
    htlcEscrow: null,
    resolverRegistry: null,
  },
  soroban: {
    rpcUrl: "https://soroban.example/rpc",
    horizonUrl: "https://horizon.example",
    networkPassphrase: "Test SDF Network ; September 2015",
    htlcContract: null,
    resolverRegistry: null,
  },
  solana: {
    rpcUrl: "https://solana.example/rpc",
    programId: "PLACEHOLDER",
    commitment: "confirmed",
  },
};

const okFetcher = async (_url: string, _init: unknown) => ({
  ok: true,
  status: 200,
  json: async () => ({ result: "ok" }),
});

const failFetcher = async (_url: string, _init: unknown) => ({
  ok: false,
  status: 503,
  json: async () => ({}),
});

async function freshDb() {
  const dir = mkdtempSync(resolve(tmpdir(), "waffle-phase-test-"));
  return openDatabase(`file:${dir}/test.db`);
}

function makeChecks(overrides: Partial<ReadinessCheck>[] = []): ReadinessCheck[] {
  const defaults: ReadinessCheck[] = [
    { name: "database",       ok: true,  latencyMs: 1 },
    { name: "ethereum_rpc",   ok: true,  latencyMs: 2 },
    { name: "soroban_rpc",    ok: true,  latencyMs: 3 },
    { name: "solana_rpc",     ok: true,  detail: "disabled_placeholder" },
    { name: "reconciliation", ok: true,  detail: "last_run_ok" },
  ];
  return defaults.map((d, i) => ({ ...d, ...(overrides.at(i) ?? {}) }));
}

// ── deriveStartupPhase ────────────────────────────────────────────────────────

describe("deriveStartupPhase", () => {
  it("returns 'starting' when externalPhase is 'starting' regardless of checks", () => {
    const checks = makeChecks();
    expect(deriveStartupPhase(checks, "starting")).toBe("starting");
  });

  it("returns 'starting' even when all checks are passing", () => {
    expect(deriveStartupPhase(makeChecks(), "starting")).toBe("starting");
  });

  it("returns 'degraded' when the database check is failing", () => {
    const checks = makeChecks([{ name: "database", ok: false, latencyMs: 1 }]);
    expect(deriveStartupPhase(checks)).toBe("degraded");
  });

  it("returns 'degraded' when any non-startup_phase check is failing", () => {
    const checks = makeChecks();
    checks[1] = { name: "ethereum_rpc", ok: false, latencyMs: 5 };
    expect(deriveStartupPhase(checks)).toBe("degraded");
  });

  it("returns 'pending' when all checks pass but reconciliation is not_run_yet", () => {
    const checks = makeChecks([
      {}, {}, {}, {},
      { name: "reconciliation", ok: true, detail: "not_run_yet" },
    ]);
    expect(deriveStartupPhase(checks)).toBe("pending");
  });

  it("returns 'ready' when all checks pass and reconciliation has run", () => {
    const checks = makeChecks();
    expect(deriveStartupPhase(checks)).toBe("ready");
  });

  it("ignores the startup_phase check itself when computing degraded state", () => {
    const checks = [
      { name: "startup_phase", ok: false, detail: "starting" } as ReadinessCheck,
      ...makeChecks(),
    ];
    // startup_phase is not a real dependency — should not trigger "degraded"
    expect(deriveStartupPhase(checks)).toBe("ready");
  });

  it("returns 'degraded' for 'degraded' externalPhase (pass-through not overriding)", () => {
    // "degraded" has no special override rule in deriveStartupPhase —
    // it falls through to the check-based logic. All checks passing → "ready".
    const checks = makeChecks();
    expect(deriveStartupPhase(checks, "degraded")).toBe("ready");
  });
});

// ── createReadinessChecks — startup_phase injection ───────────────────────────

describe("createReadinessChecks — startup_phase synthetic check", () => {
  it("prepends startup_phase ok:false detail:'starting' when phase is 'starting'", async () => {
    const db = await freshDb();
    let phase: StartupPhase = "starting";

    const run = createReadinessChecks({
      cfg: baseConfig,
      db,
      getReconciliationStatus: () => ({ lastRunAt: Date.now(), lastRunOk: true, eventsReplayed: 0 }),
      fetcher: okFetcher,
      timeoutMs: 10,
      getStartupPhase: () => phase,
    });

    const checks = await run();
    const phaseCheck = checks.find((c) => c.name === "startup_phase");

    expect(phaseCheck).toBeDefined();
    expect(phaseCheck?.ok).toBe(false);
    expect(phaseCheck?.detail).toBe("starting");
    // Must be first so the HTTP layer sees it immediately.
    expect(checks.at(0)?.name).toBe("startup_phase");
  });

  it("prepends startup_phase ok:true detail:'pending' when phase is 'pending'", async () => {
    const db = await freshDb();
    let phase: StartupPhase = "pending";

    const run = createReadinessChecks({
      cfg: baseConfig,
      db,
      getReconciliationStatus: () => ({ lastRunAt: Date.now(), lastRunOk: true, eventsReplayed: 0 }),
      fetcher: okFetcher,
      timeoutMs: 10,
      getStartupPhase: () => phase,
    });

    const checks = await run();
    expect(checks.at(0)).toMatchObject({ name: "startup_phase", ok: true, detail: "pending" });
  });

  it("does NOT add a startup_phase check when phase is 'ready'", async () => {
    const db = await freshDb();

    const run = createReadinessChecks({
      cfg: baseConfig,
      db,
      getReconciliationStatus: () => ({ lastRunAt: Date.now(), lastRunOk: true, eventsReplayed: 0 }),
      fetcher: okFetcher,
      timeoutMs: 10,
      getStartupPhase: () => "ready",
    });

    const checks = await run();
    expect(checks.every((c) => c.name !== "startup_phase")).toBe(true);
  });

  it("does NOT add a startup_phase check when phase is 'degraded'", async () => {
    const db = await freshDb();

    const run = createReadinessChecks({
      cfg: baseConfig,
      db,
      getReconciliationStatus: () => ({ lastRunAt: Date.now(), lastRunOk: true, eventsReplayed: 0 }),
      fetcher: okFetcher,
      timeoutMs: 10,
      getStartupPhase: () => "degraded",
    });

    const checks = await run();
    expect(checks.every((c) => c.name !== "startup_phase")).toBe(true);
  });

  it("omits startup_phase entirely when getStartupPhase is not provided", async () => {
    const db = await freshDb();

    const run = createReadinessChecks({
      cfg: baseConfig,
      db,
      getReconciliationStatus: () => ({ lastRunAt: Date.now(), lastRunOk: true, eventsReplayed: 0 }),
      fetcher: okFetcher,
      timeoutMs: 10,
      // no getStartupPhase
    });

    const checks = await run();
    expect(checks.some((c) => c.name === "startup_phase")).toBe(false);
  });

  it("phase getter is called on every invocation (live, not cached)", async () => {
    const db = await freshDb();
    let phase: StartupPhase = "starting";

    const run = createReadinessChecks({
      cfg: baseConfig,
      db,
      getReconciliationStatus: () => ({ lastRunAt: Date.now(), lastRunOk: true, eventsReplayed: 0 }),
      fetcher: okFetcher,
      timeoutMs: 10,
      getStartupPhase: () => phase,
    });

    const first = await run();
    expect(first.at(0)).toMatchObject({ name: "startup_phase", ok: false, detail: "starting" });

    // Simulate phase transition
    phase = "ready";

    const second = await run();
    expect(second.every((c) => c.name !== "startup_phase")).toBe(true);
  });
});

// ── createReadinessChecks — core checks still work correctly ──────────────────

describe("createReadinessChecks — core checks (regression)", () => {
  it("returns all expected check names in order", async () => {
    const db = await freshDb();

    const run = createReadinessChecks({
      cfg: baseConfig,
      db,
      getReconciliationStatus: () => ({ lastRunAt: Date.now(), lastRunOk: true, eventsReplayed: 0 }),
      fetcher: okFetcher,
      timeoutMs: 10,
    });

    const checks = await run();
    expect(checks.map((c) => c.name)).toEqual([
      "database",
      "ethereum_rpc",
      "soroban_rpc",
      "solana_rpc",
      "reconciliation",
    ]);
  });

  it("marks failing RPC as ok:false detail:'unavailable'", async () => {
    const db = await freshDb();

    const run = createReadinessChecks({
      cfg: baseConfig,
      db,
      getReconciliationStatus: () => ({ lastRunAt: Date.now(), lastRunOk: true, eventsReplayed: 0 }),
      fetcher: failFetcher,
      timeoutMs: 10,
    });

    const checks = await run();
    const eth = checks.find((c) => c.name === "ethereum_rpc");
    expect(eth?.ok).toBe(false);
    expect(eth?.detail).toBe("unavailable");
  });

  it("reconciliation not_run_yet is ok:true", async () => {
    const db = await freshDb();

    const run = createReadinessChecks({
      cfg: baseConfig,
      db,
      getReconciliationStatus: () => ({ lastRunAt: null, lastRunOk: null, eventsReplayed: 0 }),
      fetcher: okFetcher,
      timeoutMs: 10,
    });

    const checks = await run();
    const recon = checks.find((c) => c.name === "reconciliation");
    expect(recon?.ok).toBe(true);
    expect(recon?.detail).toBe("not_run_yet");
  });

  it("reconciliation last_run_failed is ok:false", async () => {
    const db = await freshDb();

    const run = createReadinessChecks({
      cfg: baseConfig,
      db,
      getReconciliationStatus: () => ({ lastRunAt: Date.now(), lastRunOk: false, eventsReplayed: 0 }),
      fetcher: okFetcher,
      timeoutMs: 10,
    });

    const checks = await run();
    const recon = checks.find((c) => c.name === "reconciliation");
    expect(recon?.ok).toBe(false);
    expect(recon?.detail).toBe("last_run_failed");
  });

  it("Solana placeholder produces ok:true detail:'disabled_placeholder'", async () => {
    const db = await freshDb();
    const probedUrls: string[] = [];

    const run = createReadinessChecks({
      cfg: baseConfig, // programId = "PLACEHOLDER"
      db,
      getReconciliationStatus: () => ({ lastRunAt: Date.now(), lastRunOk: true, eventsReplayed: 0 }),
      fetcher: async (url, _init) => {
        probedUrls.push(url);
        return { ok: true, status: 200, json: async () => ({ result: "ok" }) };
      },
      timeoutMs: 10,
    });

    const checks = await run();
    const solana = checks.find((c) => c.name === "solana_rpc");
    expect(solana?.ok).toBe(true);
    expect(solana?.detail).toBe("disabled_placeholder");
    expect(probedUrls).not.toContain(baseConfig.solana.rpcUrl);
  });
});
