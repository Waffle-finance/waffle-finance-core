import { describe, it, expect } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { applyPostgresMigration } from "../src/persistence/db.js";

// Requires an explicitly supplied server with CREATE DATABASE permission.
// Never migrate, truncate, or drop anything in the supplied database.
describe.skipIf(!process.env.POSTGRES_TEST_URL)("PostgreSQL migration rollback", () => {
  it("rolls back DDL and leaves the registry unchanged after failure", async () => {
    const admin = new Pool({ connectionString: process.env.POSTGRES_TEST_URL });
    const name = `waffle_rollback_${randomUUID().replaceAll("-", "")}`;
    let isolated: Pool | undefined;
    let created = false;
    try {
      await admin.query(`CREATE DATABASE "${name}"`);
      created = true;
      const url = new URL(process.env.POSTGRES_TEST_URL!);
      url.pathname = `/${name}`;
      isolated = new Pool({ connectionString: url.toString() });
      await isolated.query("CREATE TABLE schema_migrations (migration TEXT PRIMARY KEY, applied_at BIGINT NOT NULL, duration_ms BIGINT NOT NULL)");
      await applyPostgresMigration(isolated, "baseline.sql", "CREATE TABLE baseline (id INTEGER)");
      const before = await isolated.query("SELECT * FROM schema_migrations ORDER BY migration");
      const sql = readFileSync(new URL("./fixtures/migrations/rollback-failure.sql", import.meta.url), "utf8");
      await expect(applyPostgresMigration(isolated, "rollback-failure.sql", sql)).rejects.toThrow("Migration rollback-failure.sql failed");
      expect((await isolated.query("SELECT * FROM schema_migrations ORDER BY migration")).rows).toEqual(before.rows);
      expect((await isolated.query("SELECT to_regclass('rollback_probe') AS probe, to_regclass('baseline') AS baseline")).rows[0]).toEqual({ probe: null, baseline: "baseline" });
      // The failed migration name can be retried successfully.
      await applyPostgresMigration(isolated, "rollback-failure.sql", "CREATE TABLE rollback_probe (id INTEGER)");
      expect((await isolated.query("SELECT migration FROM schema_migrations WHERE migration = 'rollback-failure.sql'")).rowCount).toBe(1);
    } finally {
      await isolated?.end();
      try {
        if (created) await admin.query(`DROP DATABASE "${name}"`);
      } finally {
        await admin.end();
      }
    }
  }, 30_000);
});
