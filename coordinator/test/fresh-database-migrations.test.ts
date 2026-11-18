import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CURRENT_SCHEMA_VERSION,
  SQLITE_MIGRATIONS,
  SQLITE_MIGRATION_OVERRIDES,
  getMigrationsDir,
  getCurrentSchemaVersion,
  isPostgresDatabase,
  openDatabase,
  queryMigrations,
  validateSchemaVersion,
} from "../src/persistence/db.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

function assertRequiredSchema(db: InstanceType<typeof DatabaseSync>) {
  const objects = db.prepare(
    "SELECT type, name FROM sqlite_master WHERE type IN ('table', 'index')"
  ).all();
  for (const name of ["orders", "order_events", "schema_migrations", "audit_log",
    "chain_cursors", "soroban_checkpoints", "processed_events"]) {
    expect(objects).toContainEqual({ type: "table", name });
  }
  for (const name of ["idx_orders_cursor_pagination", "idx_orders_stale_announced",
    "idx_processed_events_order"]) {
    expect(objects).toContainEqual({ type: "index", name });
  }
}

describe("fresh SQLite database migrations", () => {
  it("executes every registered migration in order without schema.sql", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "waffle-fresh-migrations-"));
    let db: InstanceType<typeof DatabaseSync> | undefined;
    try {
      db = new DatabaseSync(resolve(dir, "empty.db"));
      expect(db.prepare("SELECT name FROM sqlite_master").all()).toEqual([]);
      // Match the production runner's tracking-table bootstrap, but execute
      // whole SQL files so migration-owned transactions are preserved.
      db.exec("CREATE TABLE schema_migrations (migration TEXT PRIMARY KEY, applied_at INTEGER NOT NULL, duration_ms INTEGER NOT NULL)");
      for (const [index, migration] of SQLITE_MIGRATIONS.entries()) {
        const file = SQLITE_MIGRATION_OVERRIDES[migration] ?? migration;
        db.exec(readFileSync(resolve(getMigrationsDir(), file), "utf8"));
        db.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?)").run(migration, index + 1, 0);
        expect((await queryMigrations(db)).map((row) => row.migration))
          .toEqual(SQLITE_MIGRATIONS.slice(0, index + 1));
      }
      expect(await getCurrentSchemaVersion(db)).toBe(SQLITE_MIGRATIONS.at(-1));
      expect(await getCurrentSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
      await validateSchemaVersion(db);
      assertRequiredSchema(db);
    } finally {
      try { db?.close(); } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  });

  it("initializes the default SQLite startup path from an absent file", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "waffle-fresh-startup-"));
    let db: Awaited<ReturnType<typeof openDatabase>> | undefined;
    try {
      db = await openDatabase(`file:${resolve(dir, "startup.db")}`);
      if (isPostgresDatabase(db)) throw new Error("Expected SQLite");
      expect((await queryMigrations(db)).map((row) => row.migration)).toEqual([...SQLITE_MIGRATIONS]);
      expect(await getCurrentSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
      await validateSchemaVersion(db);
      assertRequiredSchema(db);
    } finally {
      try { if (db && !isPostgresDatabase(db)) db.close(); }
      finally { rmSync(dir, { recursive: true, force: true }); }
    }
  });
});
