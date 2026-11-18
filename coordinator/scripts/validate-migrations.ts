#!/usr/bin/env tsx
/**
 * Migration drift validation for operators (Issue 48).
 *
 * Runs the same static registry checks that `openDatabase()` performs at
 * startup, plus a full disk-conformance audit, and prints a structured report
 * suitable for a pre-deploy CI gate or a manual pre-flight step:
 *
 *   - SQLite / Postgres migration sequences are unique + strictly ordered.
 *   - CURRENT_SCHEMA_VERSION equals the latest entry of BOTH lists.
 *   - Every registered migration file exists on disk.
 *   - Every numbered *.sql file on disk is registered in a list (no forgotten
 *     registrations).
 *
 * Exits 0 when the registry is consistent, 1 with a detailed report when it
 * drifts — so "a misordered migration or incompatible schema change is caught
 * before it reaches production".
 *
 * Usage:
 *   pnpm --filter @wafflefinance/coordinator db:validate-migrations
 */
import {
  SQLITE_MIGRATIONS,
  POSTGRES_MIGRATION_FILES,
  CURRENT_SCHEMA_VERSION,
  validateMigrationRegistry,
  listMigrationFiles,
  getMigrationsDir,
  MigrationValidationError,
} from "../src/persistence/db.js";

function pad(name: string, width = 34): string {
  return name.padEnd(width);
}

function printReport(): { ok: boolean } {
  const dir = getMigrationsDir();
  const diskFiles = listMigrationFiles(dir);

  console.log("Migration registry drift audit");
  console.log("==============================");
  console.log(`migrations dir        : ${dir}`);
  console.log(`files on disk         : ${diskFiles.length} (${diskFiles.join(", ")})`);
  console.log(`sqlite list count     : ${SQLITE_MIGRATIONS.length}`);
  console.log(`postgres list count   : ${POSTGRES_MIGRATION_FILES.length}`);
  console.log(`current schema version: ${CURRENT_SCHEMA_VERSION}`);
  console.log("");

  try {
    const report = validateMigrationRegistry(dir);

    console.table([
      {
        check: "sqlite sequence",
        status: report.sqliteSequenceValid ? "ok" : "FAIL",
      },
      {
        check: "postgres sequence",
        status: report.postgresSequenceValid ? "ok" : "FAIL",
      },
      {
        check: "version aligned (CURRENT_SCHEMA_VERSION = latest of both lists)",
        status: report.versionAligned ? "ok" : "FAIL",
      },
      {
        check: "registered files present on disk",
        status: report.registeredFilesMissingOnDisk.length === 0 ? "ok" : "FAIL",
      },
      {
        check: "no unregistered files on disk",
        status: report.unregisteredFilesOnDisk.length === 0 ? "ok" : "FAIL",
      },
    ]);

    if (report.registeredFilesMissingOnDisk.length > 0) {
      console.error(`\nMissing on disk: ${report.registeredFilesMissingOnDisk.join(", ")}`);
    }
    if (report.unregisteredFilesOnDisk.length > 0) {
      console.error(`\nUnregistered on disk: ${report.unregisteredFilesOnDisk.join(", ")}`);
    }

    console.log("\nMigration registry is consistent.");
    return { ok: true };
  } catch (err) {
    if (err instanceof MigrationValidationError) {
      console.error(`\n${err.message}\n`);
    } else if (err instanceof Error) {
      console.error(`\nMigration validation failed: ${err.message}\n`);
    } else {
      console.error(`\nMigration validation failed: ${String(err)}\n`);
    }
    console.error(`${pad("sqlite sequence")} not run to completion (aborted on drift)`);
    console.error(`${pad("postgres sequence")} not run to completion (aborted on drift)`);
    console.error(
      `${pad("version aligned")}: ${CURRENT_SCHEMA_VERSION} (see error above)`
    );
    return { ok: false };
  }
}

const result = printReport();
if (!result.ok) {
  console.error(
    "\nRESULT: DRIFT DETECTED — fix the migration registry before deploying.\n" +
      "See coordinator/docs/migration-strategy.md for the required workflow."
  );
  process.exit(1);
}
console.log("\nRESULT: OK");