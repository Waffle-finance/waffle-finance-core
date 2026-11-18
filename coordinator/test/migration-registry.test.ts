/**
 * Migration registry drift validation (Issue 48).
 *
 * `validateSchemaVersion` catches a DB whose *recorded history* disagrees with
 * the coordinator binary, but it cannot catch the registry silently drifting
 * from the migration files on disk.  `validateMigrationRegistry` closes that
 * gap: it is a static, pre-deployment check that a misordered migration or a
 * schema change that was never wired through the registry (or whose file was
 * deleted) is caught before it ever reaches production.
 *
 * This file tests:
 *   1. Sequence validation on synthetic lists (duplicates, reorders, malformed
 *      names).
 *   2. Conformance of the real repository registry against the real migrations
 *      directory.
 *   3. Drift detection: a registered file missing on disk, and an unregistered
 *      file present on disk, both fail with REGISTRY_DRIFT.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { FatalStartupError } from "../src/retry.js";
import {
  validateMigrationRegistry,
  validateMigrationSequence,
  migrationNumber,
  isMigrationFileName,
  listMigrationFiles,
  getMigrationsDir,
  MigrationValidationError,
  SQLITE_MIGRATIONS,
  POSTGRES_MIGRATION_FILES,
} from "../src/persistence/db.js";

function driftCodeOf(err: unknown): string | undefined {
  if (err instanceof FatalStartupError) {
    return (err.cause as MigrationValidationError | undefined)?.code;
  }
  if (err instanceof MigrationValidationError) return err.code;
  return undefined;
}

function tmpDirWith(files: Array<[name: string, content?: string]>): string {
  const dir = mkdtempSync(resolve(tmpdir(), "wafflefinance-migreg-"));
  for (const [name, content] of files) {
    writeFileSync(resolve(dir, name), content ?? "SELECT 1;\n");
  }
  return dir;
}

describe("validateMigrationSequence", () => {
  it("accepts the real SQLite and Postgres registries", () => {
    expect(() => validateMigrationSequence(SQLITE_MIGRATIONS, "SQLITE_MIGRATIONS")).not.toThrow();
    expect(() =>
      validateMigrationSequence(POSTGRES_MIGRATION_FILES, "POSTGRES_MIGRATION_FILES")
    ).not.toThrow();
  });

  it("accepts a well-formed synthetic sequence", () => {
    const files = ["001_a.sql", "002_b.sql", "010_c.sql"];
    expect(() => validateMigrationSequence(files, "TEST")).not.toThrow();
  });

  it("accepts the adjacent-shared-number convention (e.g. 005a / 005b)", () => {
    // The repository uses two migrations prefixed 005; adjacent duplicates of a
    // number are a valid convention, and their array order is the apply order.
    const files = ["005_cursor_pagination.sql", "005_schema_migrations.sql", "006_b.sql"];
    expect(() => validateMigrationSequence(files, "TEST")).not.toThrow();
  });

  it("rejects a non-adjacent duplicate migration number with REGISTRY_DRIFT", () => {
    const files = ["001_a.sql", "002_b.sql", "001_c.sql"];
    try {
      validateMigrationSequence(files, "TEST");
      throw new Error("expected to throw");
    } catch (err) {
      expect(driftCodeOf(err)).toBe("REGISTRY_DRIFT");
      expect(err instanceof Error && err.message).toMatch(/not in numeric-prefix order/i);
    }
  });

  it("rejects an out-of-order sequence with REGISTRY_DRIFT", () => {
    const files = ["002_b.sql", "001_a.sql"];
    try {
      validateMigrationSequence(files, "TEST");
      throw new Error("expected to throw");
    } catch (err) {
      expect(driftCodeOf(err)).toBe("REGISTRY_DRIFT");
      expect(err instanceof Error && err.message).toMatch(/not in numeric-prefix order/i);
    }
  });

  it("rejects a non-conforming file name with REGISTRY_DRIFT", () => {
    const files = ["001_a.sql", "not_a_migration.txt"];
    try {
      validateMigrationSequence(files, "TEST");
      throw new Error("expected to throw");
    } catch (err) {
      expect(driftCodeOf(err)).toBe("REGISTRY_DRIFT");
    }
  });
});

describe("migrationNumber / isMigrationFileName", () => {
  it("parses the numeric prefix from a migration name", () => {
    expect(migrationNumber("012_order_cancellation.sql")).toBe(12);
    expect(migrationNumber("999_future.sql")).toBe(999);
  });

  it("returns NaN for non-numeric-prefixed names", () => {
    expect(migrationNumber("order_cancellation.sql")).toBeNaN();
    expect(migrationNumber("README.md")).toBeNaN();
  });

  it("recognises only ^\\d+_.*\\.sql$ names", () => {
    expect(isMigrationFileName("001_initial.sql")).toBe(true);
    expect(isMigrationFileName("001_initial_postgres.sql")).toBe(true);
    expect(isMigrationFileName("initial.sql")).toBe(false);
    expect(isMigrationFileName("001_initial.txt")).toBe(false);
  });
});

describe("validateMigrationRegistry — real repository conformance", () => {
  it("passes against the real migrations directory", () => {
    const report = validateMigrationRegistry(getMigrationsDir());
    expect(report.sqliteSequenceValid).toBe(true);
    expect(report.postgresSequenceValid).toBe(true);
    expect(report.versionAligned).toBe(true);
    expect(report.registeredFilesMissingOnDisk).toEqual([]);
    expect(report.unregisteredFilesOnDisk).toEqual([]);
    expect(report.currentSchemaVersion).toBe(report.sqliteLatest);
    expect(report.currentSchemaVersion).toBe(report.postgresLatest.replace("_postgres.sql", ".sql"));
  });

  it("fully accounts for every numbered .sql file on disk", () => {
    const files = listMigrationFiles(getMigrationsDir());
    expect(files.length).toBeGreaterThan(0);
    // Every on-disk file must be a member of the sqlite or postgres list.
    const registered = new Set([...SQLITE_MIGRATIONS, ...POSTGRES_MIGRATION_FILES]);
    for (const f of files) {
      expect(registered.has(f), `expected ${f} to be registered`).toBe(true);
    }
  });
});

describe("validateMigrationRegistry — drift detection", () => {
  it("fails with REGISTRY_DRIFT when a registered file is missing on disk", () => {
    const dir = tmpDirWith([]);
    try {
      validateMigrationRegistry(dir);
      throw new Error("expected to throw");
    } catch (err) {
      expect(driftCodeOf(err)).toBe("REGISTRY_DRIFT");
      expect(err instanceof Error && err.message).toMatch(/missing on disk/i);
    }
  });

  it("fails with REGISTRY_DRIFT when an unregistered numbered file sits on disk", () => {
    // Contains every check-driving file except none registered: the report
    // must surface the unregistered file explicitly.
    const dir = tmpDirWith([["999_new_chain.sql", "SELECT 1;\n"]]);
    try {
      validateMigrationRegistry(dir);
      throw new Error("expected to throw");
    } catch (err) {
      expect(driftCodeOf(err)).toBe("REGISTRY_DRIFT");
      expect(err instanceof Error && err.message).toContain("999_new_chain.sql");
    }
  });

  it("error is a FatalStartupError so startup retry short-circuits", () => {
    const dir = tmpDirWith([]);
    try {
      validateMigrationRegistry(dir);
      throw new Error("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(FatalStartupError);
    }
  });
});