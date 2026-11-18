/**
 * @file kysely-migrations.ts
 *
 * Kysely migration runner for the WaffleFinance coordinator.
 *
 * Wraps the existing SQL migration files under `coordinator/migrations/`
 * in Kysely's `Migration` interface so a `Migrator` instance can:
 *
 *  1. Apply new migrations exactly once (idempotent).
 *  2. Track applied migrations in the `schema_migrations` table.
 *  3. Support both SQLite and PostgreSQL dialects without hand-rolling
 *     dialect detection logic (see TD-040 / issue #479).
 *
 * ## How it works
 *
 * Each `.sql` file under `migrations/` becomes a `FileMigration` whose `up`
 * function reads the file, runs it through `db.schema.raw()` (Kysely's safe
 * raw-SQL escape hatch), and inserts a row into `schema_migrations`.  No SQL
 * is modified at runtime — the files are already dialect-specific where
 * needed (`*_postgres.sql` vs plain `.sql`).
 *
 * New schema changes SHOULD be written as TypeScript Kysely migrations
 * (using the query builder) so they are type-safe across both dialects.
 * The existing SQL files are wrapped here purely for migration-history
 * continuity.
 *
 * ## Usage (in openDatabase)
 *
 * ```ts
 * const runner = new KyselyMigrationRunner(kyselyDb, isPostgres);
 * await runner.migrateToLatest();
 * ```
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import type { KyselyCoordinatorDb } from './kysely-db.js';
import {
  SQLITE_MIGRATIONS,
  POSTGRES_MIGRATION_FILES,
} from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── Migration file loader ────────────────────────────────────────────────────

function loadMigrationSql(migrationsDir: string, file: string): string {
  const primary = resolve(migrationsDir, file);
  try {
    return readFileSync(primary, 'utf8');
  } catch {
    const genericName = file.replace('_postgres.sql', '.sql');
    if (genericName !== file) {
      try {
        return readFileSync(resolve(migrationsDir, genericName), 'utf8');
      } catch { /* fall through */ }
    }
    throw new Error(
      `Kysely migration file not found: ${file}. Ensure it exists under coordinator/migrations/.`
    );
  }
}

// ─── Runner ───────────────────────────────────────────────────────────────────

export class KyselyMigrationRunner {
  private readonly migrationsDir: string;
  private readonly files: readonly string[];

  constructor(
    private readonly db: KyselyCoordinatorDb,
    private readonly isPostgres: boolean,
  ) {
    this.migrationsDir = resolve(__dirname, '..', '..', 'migrations');
    this.files = isPostgres ? POSTGRES_MIGRATION_FILES : SQLITE_MIGRATIONS;
  }

  /**
   * Ensure the `schema_migrations` tracking table exists, then apply every
   * migration file that has not yet been recorded.  Applied migrations are
   * recorded with the wall-clock duration.
   *
   * Idempotent: calling this multiple times is safe.
   */
  async migrateToLatest(): Promise<void> {
    // Bootstrap the migration tracking table.
    await this._ensureMigrationsTable();

    for (const file of this.files) {
      // Check whether this migration was already applied.
      const existing = await this.db
        .selectFrom('schema_migrations')
        .select('migration')
        .where('migration', '=', file)
        .executeTakeFirst();

      if (existing) continue;

      const migrationSql = loadMigrationSql(this.migrationsDir, file);
      const t0 = Date.now();

      // Execute the raw SQL inside a transaction so a partial migration
      // leaves the schema in a consistent state.
      await this.db.transaction().execute(async (trx) => {
        // Split on semicolons to handle multi-statement migration files.
        // Each statement is executed individually; empty strings are skipped.
        const statements = migrationSql
          .split(';')
          .map((s) => s.trim())
          .filter((s) => s.length > 0 && !s.startsWith('--') && !s.startsWith('PRAGMA'));

        for (const statement of statements) {
          await sql.raw(statement).execute(trx);
        }
      });

      const durationMs = Date.now() - t0;

      // Record the completed migration.
      await this.db
        .insertInto('schema_migrations')
        .values({
          migration: file,
          applied_at: Math.floor(Date.now() / 1000),
          duration_ms: durationMs,
        })
        .onConflict((oc) => oc.column('migration').doNothing())
        .execute();
    }
  }

  /**
   * Return the list of applied migrations in application order.
   */
  async appliedMigrations(): Promise<Array<{ migration: string; appliedAt: number; durationMs: number }>> {
    const rows = await this.db
      .selectFrom('schema_migrations')
      .select(['migration', 'applied_at', 'duration_ms'])
      .orderBy('applied_at', 'asc')
      .orderBy('migration', 'asc')
      .execute();

    return rows.map((r) => ({
      migration: r.migration,
      appliedAt: Number(r.applied_at),
      durationMs: Number(r.duration_ms),
    }));
  }

  /**
   * Return the name of the most recently applied migration, or `null` if
   * none have been applied yet.
   */
  async currentVersion(): Promise<string | null> {
    const applied = await this.appliedMigrations();
    return applied.at(-1)?.migration ?? null;
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  private async _ensureMigrationsTable(): Promise<void> {
    if (this.isPostgres) {
      await sql`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          migration   TEXT    PRIMARY KEY,
          applied_at  BIGINT  NOT NULL,
          duration_ms BIGINT  NOT NULL
        )
      `.execute(this.db);
    } else {
      await sql`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          migration   TEXT    PRIMARY KEY,
          applied_at  INTEGER NOT NULL,
          duration_ms INTEGER NOT NULL
        )
      `.execute(this.db);
    }
  }
}
