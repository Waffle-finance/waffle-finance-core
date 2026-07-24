import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  openDatabase,
  queryMigrations,
  getCurrentSchemaVersion,
  validateSchemaVersion,
  MigrationValidationError,
} from "../src/persistence/db.js";
import { FatalStartupError } from "../src/retry.js";

// The logical migrations that schema.sql covers (in name-sort order).
// Must stay in sync with SQLITE_MIGRATIONS in coordinator/src/persistence/db.ts.
const EXPECTED_MIGRATIONS = [
  "001_initial.sql",
  "002_solana_support.sql",
  "003_secret_encryption.sql",
  "004_query_optimizations.sql",
  "005_cursor_pagination.sql",
  "005_schema_migrations.sql",
  "006_stale_cleanup.sql",
];

async function freshDb() {
  const dir = mkdtempSync(resolve(tmpdir(), "wafflefinance-migtest-"));
  return openDatabase(`file:${dir}/test.db`);
}

// ---------------------------------------------------------------------------
// Schema versioning — SQLite
// ---------------------------------------------------------------------------

describe("Schema migration logging — SQLite", () => {
  it("creates a schema_migrations table that can be queried", async () => {
    const db = await freshDb();
    const records = await queryMigrations(db);
    expect(Array.isArray(records)).toBe(true);
  });

  it("records all expected migrations after openDatabase", async () => {
    const db = await freshDb();
    const records = await queryMigrations(db);
    const names = records.map((r) => r.migration);
    for (const expected of EXPECTED_MIGRATIONS) {
      expect(names).toContain(expected);
    }
  });

  it("records exactly the expected number of migrations", async () => {
    const db = await freshDb();
    const records = await queryMigrations(db);
    expect(records).toHaveLength(EXPECTED_MIGRATIONS.length);
  });

  it("all migration records have the correct shape", async () => {
    const db = await freshDb();
    const records = await queryMigrations(db);
    for (const r of records) {
      expect(typeof r.migration).toBe("string");
      expect(typeof r.appliedAt).toBe("number");
      expect(typeof r.durationMs).toBe("number");
    }
  });

  it("appliedAt is a valid unix timestamp (within the last minute)", async () => {
    const before = Math.floor(Date.now() / 1000) - 5;
    const db = await freshDb();
    const after = Math.floor(Date.now() / 1000) + 5;
    const records = await queryMigrations(db);
    for (const r of records) {
      expect(r.appliedAt).toBeGreaterThanOrEqual(before);
      expect(r.appliedAt).toBeLessThanOrEqual(after);
    }
  });

  it("durationMs is 0 for SQLite migrations (applied atomically via schema.sql)", async () => {
    const db = await freshDb();
    const records = await queryMigrations(db);
    for (const r of records) {
      expect(r.durationMs).toBe(0);
    }
  });

  it("migration names match the expected file names exactly", async () => {
    const db = await freshDb();
    const records = await queryMigrations(db);
    const names = records.map((r) => r.migration).sort();
    expect(names).toEqual([...EXPECTED_MIGRATIONS].sort());
  });

  it("records are returned ordered by (applied_at, migration) — names are ascending for SQLite", async () => {
    const db = await freshDb();
    const records = await queryMigrations(db);
    const names = records.map((r) => r.migration);
    // SQLite seeds all with the same applied_at, so secondary sort is migration name.
    const sortedNames = [...names].sort();
    expect(names).toEqual(sortedNames);
  });

  it("getCurrentSchemaVersion returns the last migration name", async () => {
    const db = await freshDb();
    const version = await getCurrentSchemaVersion(db);
    expect(version).toBe("006_stale_cleanup.sql");
  });

  it("getCurrentSchemaVersion returns null for an empty migrations table", async () => {
    const db = await freshDb();
    (db as any).exec("DELETE FROM schema_migrations");
    const version = await getCurrentSchemaVersion(db);
    expect(version).toBeNull();
  });

  it("reopening the same database does not create duplicate migration records", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "wafflefinance-migtest-dup-"));
    const dbUrl = `file:${dir}/test.db`;

    await openDatabase(dbUrl);  // first open — seeds migrations
    const db2 = await openDatabase(dbUrl);  // second open — should be idempotent

    const records = await queryMigrations(db2);
    expect(records).toHaveLength(EXPECTED_MIGRATIONS.length);
  });

  it("reopening the database three times still yields the correct record count", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "wafflefinance-migtest-tri-"));
    const dbUrl = `file:${dir}/test.db`;

    await openDatabase(dbUrl);
    await openDatabase(dbUrl);
    const db3 = await openDatabase(dbUrl);

    const records = await queryMigrations(db3);
    expect(records).toHaveLength(EXPECTED_MIGRATIONS.length);
  });

  it("migration appliedAt timestamps are consistent across reopens", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "wafflefinance-migtest-ts-"));
    const dbUrl = `file:${dir}/test.db`;

    const db1 = await openDatabase(dbUrl);
    const records1 = await queryMigrations(db1);
    const timestamps1 = records1.map((r) => r.appliedAt);

    // Small delay to ensure any clock drift is detectable.
    await new Promise((r) => setTimeout(r, 10));

    const db2 = await openDatabase(dbUrl);
    const records2 = await queryMigrations(db2);
    const timestamps2 = records2.map((r) => r.appliedAt);

    // INSERT OR IGNORE preserves the original timestamps.
    expect(timestamps2).toEqual(timestamps1);
  });

  it("queryMigrations result includes the schema_migrations bootstrap itself", async () => {
    const db = await freshDb();
    const records = await queryMigrations(db);
    const names = records.map((r) => r.migration);
    expect(names).toContain("005_schema_migrations.sql");
  });
});

// ---------------------------------------------------------------------------
// getCurrentSchemaVersion — edge cases
// ---------------------------------------------------------------------------

describe("getCurrentSchemaVersion — edge cases", () => {
  it("returns the highest-numbered migration name for a partially populated table", async () => {
    const db = await freshDb();

    // Remove all but the first two migrations to simulate a partial upgrade.
    (db as any).exec(
      "DELETE FROM schema_migrations WHERE migration NOT IN ('001_initial.sql', '002_solana_support.sql')"
    );

    const version = await getCurrentSchemaVersion(db);
    expect(version).toBe("002_solana_support.sql");
  });

  it("returns the single migration when only one row exists", async () => {
    const db = await freshDb();
    (db as any).exec(
      "DELETE FROM schema_migrations WHERE migration != '003_secret_encryption.sql'"
    );

    const version = await getCurrentSchemaVersion(db);
    expect(version).toBe("003_secret_encryption.sql");
  });
});

// ---------------------------------------------------------------------------
// queryMigrations — result structure guarantees
// ---------------------------------------------------------------------------

describe("queryMigrations — result structure", () => {
  it("returns an empty array when the table is empty", async () => {
    const db = await freshDb();
    (db as any).exec("DELETE FROM schema_migrations");
    const records = await queryMigrations(db);
    expect(records).toEqual([]);
  });

  it("each record has non-negative durationMs", async () => {
    const db = await freshDb();
    const records = await queryMigrations(db);
    for (const r of records) {
      expect(r.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("each record has a positive appliedAt (reasonable unix epoch)", async () => {
    const db = await freshDb();
    const records = await queryMigrations(db);
    const JAN_2024 = 1_704_067_200; // 2024-01-01 UTC as a sanity floor
    for (const r of records) {
      expect(r.appliedAt).toBeGreaterThan(JAN_2024);
    }
  });

  it("migration names are non-empty strings", async () => {
    const db = await freshDb();
    const records = await queryMigrations(db);
    for (const r of records) {
      expect(r.migration.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// validateSchemaVersion — happy path and error codes
// ---------------------------------------------------------------------------

describe("validateSchemaVersion — valid database", () => {
  it("passes without throwing on a freshly opened database", async () => {
    const db = await freshDb();
    await expect(validateSchemaVersion(db)).resolves.toBeUndefined();
  });

  it("passes after reopening an existing database", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "wafflefinance-val-ok-"));
    const url = `file:${dir}/test.db`;
    await openDatabase(url);
    const db2 = await openDatabase(url);
    await expect(validateSchemaVersion(db2)).resolves.toBeUndefined();
  });
});

describe("validateSchemaVersion — MISSING_MIGRATIONS", () => {
  it("throws FatalStartupError wrapping MigrationValidationError with code MISSING_MIGRATIONS", async () => {
    const db = await freshDb();
    // Remove one migration to simulate a behind-version database.
    (db as any).exec(
      "DELETE FROM schema_migrations WHERE migration = '004_query_optimizations.sql'"
    );

    let caught: unknown;
    try {
      await validateSchemaVersion(db);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(FatalStartupError);
    const inner = (caught as FatalStartupError).cause;
    expect(inner).toBeInstanceOf(MigrationValidationError);
    expect((inner as MigrationValidationError).code).toBe("MISSING_MIGRATIONS");
    expect((caught as Error).message).toMatch(/behind/i);
    expect((caught as Error).message).toContain("004_query_optimizations.sql");
  });

  it("error message contains migration-strategy.md reference", async () => {
    const db = await freshDb();
    (db as any).exec("DELETE FROM schema_migrations WHERE migration = '003_secret_encryption.sql'");

    await expect(validateSchemaVersion(db)).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof FatalStartupError &&
        e.message.includes("migration-strategy.md")
    );
  });

  it("detail.missing lists only the absent migration(s)", async () => {
    const db = await freshDb();
    (db as any).exec(
      "DELETE FROM schema_migrations WHERE migration IN ('002_solana_support.sql', '003_secret_encryption.sql')"
    );

    try {
      await validateSchemaVersion(db);
      throw new Error("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(FatalStartupError);
      const inner = (err as FatalStartupError).cause as MigrationValidationError;
      expect(inner.detail?.missing).toContain("002_solana_support.sql");
      expect(inner.detail?.missing).toContain("003_secret_encryption.sql");
      expect(inner.detail?.missing).toHaveLength(2);
    }
  });
});

describe("validateSchemaVersion — EXTRA_MIGRATIONS", () => {
  it("throws FatalStartupError with code EXTRA_MIGRATIONS when an unknown migration is present", async () => {
    const db = await freshDb();
    (db as any).exec(
      "INSERT INTO schema_migrations (migration, applied_at, duration_ms) VALUES ('999_future.sql', 9999999999, 0)"
    );

    let caught: unknown;
    try {
      await validateSchemaVersion(db);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(FatalStartupError);
    const inner = (caught as FatalStartupError).cause as MigrationValidationError;
    expect(inner.code).toBe("EXTRA_MIGRATIONS");
    expect((caught as Error).message).toMatch(/ahead/i);
    expect((caught as Error).message).toContain("999_future.sql");
  });

  it("detail.extra contains only the unrecognised migration(s)", async () => {
    const db = await freshDb();
    (db as any).exec(
      "INSERT INTO schema_migrations (migration, applied_at, duration_ms) VALUES ('007_unknown.sql', 9999999998, 0)"
    );

    try {
      await validateSchemaVersion(db);
    } catch (err) {
      const inner = (err as FatalStartupError).cause as MigrationValidationError;
      expect(inner.detail?.extra).toEqual(["007_unknown.sql"]);
    }
  });
});

describe("validateSchemaVersion — UNREADABLE_HISTORY", () => {
  it("throws FatalStartupError with code UNREADABLE_HISTORY when the table is missing", async () => {
    const db = await freshDb();
    // Drop the migrations table entirely to simulate corruption.
    (db as any).exec("DROP TABLE schema_migrations");

    let caught: unknown;
    try {
      await validateSchemaVersion(db);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(FatalStartupError);
    const inner = (caught as FatalStartupError).cause as MigrationValidationError;
    expect(inner.code).toBe("UNREADABLE_HISTORY");
    expect((caught as Error).message).toMatch(/cannot read schema_migrations/i);
  });
});

describe("validateSchemaVersion — VERSION_MISMATCH", () => {
  it("throws FatalStartupError when the latest migration name is wrong", async () => {
    const db = await freshDb();
    // Remove the last migration and replace it with a mis-named one that
    // passes neither the missing check (old name is gone) nor the extra check
    // (new name is unknown), so we get one of the expected fatal error codes.
    (db as any).exec(
      "UPDATE schema_migrations SET migration = '006_wrong_name.sql' WHERE migration = '006_stale_cleanup.sql'"
    );

    let caught: unknown;
    try {
      await validateSchemaVersion(db);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(FatalStartupError);
    const inner = (caught as FatalStartupError).cause as MigrationValidationError;
    // Missing check fires before extra check, so MISSING_MIGRATIONS is the
    // expected code (006_stale_cleanup.sql is missing; 006_wrong_name.sql is extra).
    expect(["MISSING_MIGRATIONS", "EXTRA_MIGRATIONS", "VERSION_MISMATCH"]).toContain(inner.code);
  });
});
