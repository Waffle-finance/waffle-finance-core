import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { CoordinatorConfig } from "../src/config.js";
import { openDatabase } from "../src/persistence/db.js";
import { createReadinessChecks } from "../src/readiness.js";
import { CURRENT_SCHEMA_VERSION, isPostgresDatabase, queryMigrations } from "../src/persistence/db.js";
import { deriveStartupPhase } from "../src/readiness.js";
import { healthRoutes } from "../src/server/routes/health.js";

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
  it("rejects outdated migration history while liveness stays healthy, then recovers", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "waffle-migration-readiness-"));
    const db = await openDatabase(`file:${dir}/test.db`);
    if (isPostgresDatabase(db)) throw new Error("Expected disposable SQLite database");
    try {
      const latest = (await queryMigrations(db)).find(row => row.migration === CURRENT_SCHEMA_VERSION)!;
      db.prepare("DELETE FROM schema_migrations WHERE migration = ?").run(latest.migration);
      const run = createReadinessChecks({
        cfg: { ...baseConfig, databaseUrl: "postgresql://fake-user:fake-password@invalid/test" },
        db,
        getReconciliationStatus: () => ({ lastRunAt: 1, lastRunOk: true, eventsReplayed: 0 }),
        fetcher: async () => ({ ok: true, status: 200, json: async () => ({ result: "ok" }) }),
      });
      const checks = await run();
      expect(deriveStartupPhase(checks)).toBe("degraded");
      expect(checks).toContainEqual(expect.objectContaining({
        name: "database", ok: false, detail: "missing_migrations",
      }));

      // Invoke the real health handlers directly without opening a socket.
      const router = healthRoutes({ getReadinessChecks: run });
      const invoke = async (path: string) => {
        const layer = router.stack.find(layer => layer.route?.path === path)!;
        const response = {
          statusCode: 200,
          body: undefined as unknown,
          status(code: number) { this.statusCode = code; return this; },
          json(body: unknown) { this.body = body; return this; },
        };
        await layer.route.stack[0].handle({}, response, () => {});
        return response;
      };
      expect((await invoke("/healthz")).statusCode).toBe(200);
      const unready = await invoke("/readyz");
      expect(unready.statusCode).toBe(503);
      expect(unready.body).toMatchObject({ status: "degraded", degradedServices: ["database"] });
      const serialized = JSON.stringify(unready.body);
      for (const unsafe of ["SELECT", "schema_migrations", "postgresql://", "fake-user", "fake-password"]) {
        expect(serialized).not.toContain(unsafe);
      }

      db.prepare("INSERT INTO schema_migrations (migration, applied_at, duration_ms) VALUES (?, ?, ?)")
        .run(latest.migration, latest.appliedAt, latest.durationMs);
      expect(deriveStartupPhase(await run())).toBe("ready");
      expect((await invoke("/readyz")).statusCode).toBe(200);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

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
    // solana_rpc is skipped (placeholder) so getHealth is NOT called for it;
    // only eth_blockNumber and getHealth (soroban) are issued.
    expect(methods).toEqual(["eth_blockNumber", "getHealth"]);
  });

  it("marks solana_rpc as ok with detail=disabled_placeholder when programId is a placeholder", async () => {
    const db = await freshDb();
    const fetcher = async (_url: string, init: { body: string }) =>
      ({ ok: true, status: 200, json: async () => ({ result: "ok" }) });

    const checks = await createReadinessChecks({
      cfg: baseConfig, // programId = "PLACEHOLDER"
      db,
      getReconciliationStatus: () => ({ lastRunAt: Date.now(), lastRunOk: true, eventsReplayed: 0 }),
      fetcher,
      timeoutMs: 10
    })();

    const solanaCheck = checks.find((c) => c.name === "solana_rpc");
    expect(solanaCheck).toEqual(
      expect.objectContaining({ name: "solana_rpc", ok: true, detail: "disabled_placeholder" })
    );
  });

  it("probes solana_rpc when programId is a real address", async () => {
    const db = await freshDb();
    const probedUrls: string[] = [];
    const fetcher = async (url: string, _init: { body: string }) => {
      probedUrls.push(url);
      return { ok: true, status: 200, json: async () => ({ result: "ok" }) };
    };

    const configuredCfg: CoordinatorConfig = {
      ...baseConfig,
      solana: {
        ...baseConfig.solana,
        programId: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
      },
    };

    const checks = await createReadinessChecks({
      cfg: configuredCfg,
      db,
      getReconciliationStatus: () => ({ lastRunAt: Date.now(), lastRunOk: true, eventsReplayed: 0 }),
      fetcher,
      timeoutMs: 10
    })();

    // solana_rpc should have been probed this time
    expect(probedUrls).toContain("https://solana.example/rpc");

    const solanaCheck = checks.find((c) => c.name === "solana_rpc");
    expect(solanaCheck?.ok).toBe(true);
    expect(solanaCheck?.detail).toBeUndefined();
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
