import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { CoordinatorConfig } from "../src/config.js";
import { openDatabase } from "../src/persistence/db.js";
import { createReadinessChecks } from "../src/readiness.js";

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
    resolverRegistry: null
  },
  soroban: {
    rpcUrl: "https://soroban.example/rpc",
    horizonUrl: "https://horizon.example",
    networkPassphrase: "Test SDF Network ; September 2015",
    htlcContract: null,
    resolverRegistry: null
  },
  solana: {
    rpcUrl: "https://solana.example/rpc",
    programId: "PLACEHOLDER",
    commitment: "confirmed"
  }
};

async function freshDb() {
  const dir = mkdtempSync(resolve(tmpdir(), "waffle-readiness-test-"));
  return openDatabase(`file:${dir}/test.db`);
}

describe("createReadinessChecks", () => {
  it("checks the database and each chain RPC", async () => {
    const db = await freshDb();
    const methods: string[] = [];
    const fetcher = async (_url: string, init: { body: string }) => {
      methods.push(JSON.parse(init.body).method);
      return { ok: true, status: 200, json: async () => ({ result: "ok" }) };
    };

    const checks = await createReadinessChecks({
      cfg: baseConfig,
      db,
      getReconciliationStatus: () => ({ lastRunAt: Date.now(), lastRunOk: true, eventsReplayed: 0 }),
      fetcher,
      timeoutMs: 10
    })();

    expect(checks.map((check) => check.name)).toEqual([
      "database",
      "ethereum_rpc",
      "soroban_rpc",
      "solana_rpc",
      "reconciliation"
    ]);
    expect(checks.every((check) => check.ok)).toBe(true);
    expect(methods).toEqual(["eth_blockNumber", "getHealth", "getHealth"]);
  });

  it("marks failed RPC and reconciliation checks without exposing URLs", async () => {
    const db = await freshDb();
    const fetcher = async (url: string, init: { body: string }) => ({
      ok: !url.includes("soroban"),
      status: url.includes("soroban") ? 503 : 200,
      json: async () => ({ result: JSON.parse(init.body).method })
    });

    const checks = await createReadinessChecks({
      cfg: baseConfig,
      db,
      getReconciliationStatus: () => ({ lastRunAt: Date.now(), lastRunOk: false, eventsReplayed: 0 }),
      fetcher,
      timeoutMs: 10
    })();

    expect(checks).toContainEqual(
      expect.objectContaining({ name: "soroban_rpc", ok: false, detail: "unavailable" })
    );
    expect(checks).toContainEqual(
      expect.objectContaining({ name: "reconciliation", ok: false, detail: "last_run_failed" })
    );
    expect(JSON.stringify(checks)).not.toContain("soroban.example");
  });
});
