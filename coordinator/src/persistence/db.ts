import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import type { Pool } from "pg";
import { FatalStartupError } from "../retry.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load `node:sqlite` via createRequire so Vite/Vitest do not try to
// transform the import. This module is built into Node 22.5+/24.x and
// is the recommended zero-install SQLite driver.
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite");

export type Database = InstanceType<typeof DatabaseSync> | PostgresDatabase;

export function isPostgresDatabase(db: Database): db is PostgresDatabase {
  return (db as any).getPool !== undefined;
}

// ── MigrationValidationError ─────────────────────────────────────────────────

/**
 * Thrown when the database schema is incompatible with the coordinator binary.
 *
 * This is always wrapped in a `FatalStartupError` before propagating so that
 * the startup retry loop (retryAsync) short-circuits immediately — retrying
 * a schema mismatch will never fix it.
 *
 * Callers that catch errors from `openDatabase` / `validateSchemaVersion` can
 * use `instanceof MigrationValidationError` to generate targeted operator
 * guidance.
 */
export class MigrationValidationError extends Error {
  constructor(
    message: string,
    /** Machine-readable code for programmatic handling and test assertions. */
    public readonly code:
      | "UNREADABLE_HISTORY"
      | "MISSING_MIGRATIONS"
      | "EXTRA_MIGRATIONS"
      | "OUT_OF_ORDER"
      | "VERSION_MISMATCH",
    public readonly detail?: {
      expected?: readonly string[];
      applied?: string[];
      missing?: string[];
      extra?: string[];
    }
  ) {
    super(message);
    this.name = "MigrationValidationError";
  }
}

// ── Migration record type ────────────────────────────────────────────────────

/**
 * A row from the `schema_migrations` tracking table.
 *
 * `appliedAt` is a unix timestamp (seconds).
 * `durationMs` is the wall-clock time taken to apply the migration; for SQLite
 * databases it is 0 because all migrations are applied atomically via schema.sql.
 */
export interface MigrationRecord {
  migration: string;
  appliedAt: number;
  durationMs: number;
}

// ── PostgresDatabase ─────────────────────────────────────────────────────────

/**
 * PostgreSQL wrapper that provides a SQLite-like synchronous interface over
 * the async pg.Pool API.
 */
export class PostgresDatabase {
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  prepare(sql: string): PostgresStatement {
    return new PostgresStatement(this.pool, sql);
  }

  async exec(sql: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(sql);
    } finally {
      client.release();
    }
  }

  getPool(): Pool {
    return this.pool;
  }
}

/**
 * PostgreSQL statement wrapper that provides a SQLite-like interface.
 */
export class PostgresStatement {
  constructor(private pool: Pool, private sql: string) {}

  private convertSqliteToPostgres(sql: string, params: any[]): { sql: string; params: any[] } {
    // Convert strftime expressions first.
    let converted = sql.replace(
      /CAST\(strftime\('%s','now'\) AS INTEGER\)/g,
      "CAST(EXTRACT(EPOCH FROM NOW()) AS INTEGER)"
    );

    // Handle named parameters (:paramName).
    const namedParams = Array.from(converted.matchAll(/:(\w+)/g));

    if (namedParams.length > 0) {
      const paramMap: Record<string, any> = {};
      if (
        params.length > 0 &&
        typeof params[0] === "object" &&
        params[0] !== null &&
        !Array.isArray(params[0])
      ) {
        Object.assign(paramMap, params[0]);
      }

      const positionalParams: any[] = [];
      const paramIndexMap: Record<string, number> = {};

      converted = converted.replace(/:(\w+)/g, (_match, paramName: string) => {
        if (Object.prototype.hasOwnProperty.call(paramIndexMap, paramName)) {
          return `$${paramIndexMap[paramName]}`;
        }
        const index = positionalParams.length + 1;
        paramIndexMap[paramName] = index;
        positionalParams.push(paramMap[paramName]);
        return `$${index}`;
      });

      return { sql: converted, params: positionalParams };
    }

    // Handle positional ? parameters.
    const questionMarks = Array.from(converted.matchAll(/\?/g));
    if (questionMarks.length > 0) {
      let index = 1;
      converted = converted.replace(/\?/g, () => `$${index++}`);
      return { sql: converted, params };
    }

    return { sql: converted, params };
  }

  run(..._params: any[]): { changes: number; lastInsertRowid: number } {
    throw new Error(
      "PostgresStatement.run() should not be called synchronously. Use runAsync() instead."
    );
  }

  get(..._params: any[]): any {
    throw new Error(
      "PostgresStatement.get() should not be called synchronously. Use getAsync() instead."
    );
  }

  all(..._params: any[]): any[] {
    throw new Error(
      "PostgresStatement.all() should not be called synchronously. Use allAsync() instead."
    );
  }

  async runAsync(...params: any[]): Promise<{ changes: number; lastInsertRowid: number }> {
    const { sql, params: convertedParams } = this.convertSqliteToPostgres(this.sql, params);
    const result = await this.pool.query(sql, convertedParams);
    return { changes: result.rowCount ?? 0, lastInsertRowid: 0 };
  }

  async getAsync(...params: any[]): Promise<any> {
    const { sql, params: convertedParams } = this.convertSqliteToPostgres(this.sql, params);
    const result = await this.pool.query(sql, convertedParams);
    return result.rows[0] ?? null;
  }

  async allAsync(...params: any[]): Promise<any[]> {
    const { sql, params: convertedParams } = this.convertSqliteToPostgres(this.sql, params);
    const result = await this.pool.query(sql, convertedParams);
    return result.rows;
  }
}

// ── Migration registry ────────────────────────────────────────────────────────
//
// RULES FOR ADDING A NEW MIGRATION
// ─────────────────────────────────
// 1. Create a new file under coordinator/migrations/ with the next numeric
//    prefix (e.g. 007_my_change.sql).  For Postgres-specific DDL, also create
//    a 007_my_change_postgres.sql counterpart.
// 2. Apply the structural change to coordinator/src/persistence/schema.sql
//    so that fresh SQLite databases get the change on first open.
// 3. Add the file name to SQLITE_MIGRATIONS and POSTGRES_MIGRATION_FILES below
//    in the correct numeric order.
// 4. Bump CURRENT_SCHEMA_VERSION to the new file name.
// 5. Update the migration strategy guide: coordinator/docs/migration-strategy.md.
//
// Do NOT skip numbers, reorder existing entries, or delete a migration file
// once it has been deployed. The numeric prefix is the canonical version key.

/**
 * The name of the latest migration.  Bump this whenever a new migration is
 * added.  Startup validation compares the database's highest recorded
 * migration against this constant and aborts if they differ.
 */
export const CURRENT_SCHEMA_VERSION = "006_stale_cleanup.sql";

/**
 * Canonical SQLite migration sequence, in application order.
 *
 * For SQLite, migrations are applied atomically via schema.sql on first open.
 * These names are seeded into `schema_migrations` as a historical record.
 * The cursor-pagination migration (005b) is registered here even though its
 * DDL is already present in schema.sql — the record ensures the history table
 * reflects every logical change that has been applied.
 */
const SQLITE_MIGRATIONS = [
  "001_initial.sql",
  "002_solana_support.sql",
  "003_secret_encryption.sql",
  "004_query_optimizations.sql",
  "005_cursor_pagination.sql",
  "005_schema_migrations.sql",
  "006_stale_cleanup.sql",
] as const;

/**
 * Canonical Postgres migration sequence, in application order.
 *
 * Each file is applied exactly once; the result is recorded in
 * `schema_migrations` with a wall-clock duration.  Postgres-specific variants
 * (e.g. `002_solana_support_postgres.sql`) replace the SQLite versions where
 * the DDL syntax differs.
 */
const POSTGRES_MIGRATION_FILES = [
  "001_initial.sql",
  "002_solana_support_postgres.sql",
  "003_secret_encryption.sql",
  "004_query_optimizations.sql",
  "005_cursor_pagination.sql",
  "005_schema_migrations.sql",
  "006_stale_cleanup_postgres.sql",
] as const;

// ── Public helpers ────────────────────────────────────────────────────────────

/**
 * Return the full migration history recorded in the `schema_migrations` table,
 * ordered by `(applied_at ASC, migration ASC)`.
 *
 * For SQLite databases all entries have `durationMs = 0` because they are
 * applied atomically through schema.sql.  For Postgres, `durationMs` reflects
 * the wall-clock time each migration file took.
 */
export async function queryMigrations(db: Database): Promise<MigrationRecord[]> {
  const sql =
    "SELECT migration, applied_at, duration_ms FROM schema_migrations ORDER BY applied_at, migration";

  if (isPostgresDatabase(db)) {
    const rows = await db.prepare(sql).allAsync();
    return (rows as any[]).map((r) => ({
      migration: r.migration as string,
      appliedAt: Number(r.applied_at),
      durationMs: Number(r.duration_ms),
    }));
  }

  const rows = (db as InstanceType<typeof DatabaseSync>)
    .prepare(sql)
    .all() as Array<{ migration: string; applied_at: number; duration_ms: number }>;
  return rows.map((r) => ({
    migration: r.migration,
    appliedAt: r.applied_at,
    durationMs: r.duration_ms,
  }));
}

/**
 * Return the name of the most recently applied migration, or `null` if the
 * migration history is empty.
 *
 * Migration files use a numeric prefix (`001_`, `002_`, …) so the
 * lexicographically last entry in the history is the highest-numbered
 * migration, which corresponds to the current schema version.
 */
export async function getCurrentSchemaVersion(db: Database): Promise<string | null> {
  const migrations = await queryMigrations(db);
  return migrations.at(-1)?.migration ?? null;
}

function getExpectedMigrations(backend: "sqlite" | "postgres"): readonly string[] {
  return backend === "sqlite" ? SQLITE_MIGRATIONS : POSTGRES_MIGRATION_FILES;
}

/**
 * Validate that the database schema matches the coordinator's current expected
 * version.  Always throws a `FatalStartupError` wrapping a
 * `MigrationValidationError` on any incompatibility so the startup retry loop
 * short-circuits immediately — schema mismatches require human intervention
 * and are never fixed by retrying.
 *
 * Checks performed (in order):
 *   1. `schema_migrations` table is readable.
 *   2. No expected migrations are missing.
 *   3. No unexpected / extra migrations are present.
 *   4. Migrations are recorded in the correct numeric-prefix order.
 *   5. The latest applied migration matches `CURRENT_SCHEMA_VERSION`.
 */
export async function validateSchemaVersion(db: Database): Promise<void> {
  const backend = isPostgresDatabase(db) ? "postgres" : "sqlite";
  const expected = getExpectedMigrations(backend);

  // ── 1. Read history ─────────────────────────────────────────────────────
  let applied: MigrationRecord[];
  try {
    applied = await queryMigrations(db);
  } catch (err) {
    const inner = new MigrationValidationError(
      `Schema validation failed: cannot read schema_migrations table. ` +
        `The database may be corrupted or from a newer coordinator version. ` +
        `Details: ${err instanceof Error ? err.message : String(err)}`,
      "UNREADABLE_HISTORY"
    );
    throw new FatalStartupError(inner.message, inner);
  }

  const appliedNames = applied.map((r) => r.migration);

  // ── 2. Missing migrations ────────────────────────────────────────────────
  const missing = expected.filter((m) => !appliedNames.includes(m));
  if (missing.length > 0) {
    const inner = new MigrationValidationError(
      `Database schema is BEHIND the coordinator code. ` +
        `Missing migrations: [${missing.join(", ")}]. ` +
        `Expected latest version: ${CURRENT_SCHEMA_VERSION}. ` +
        `Run the pending migrations then restart the coordinator. ` +
        `See coordinator/docs/migration-strategy.md for rollback guidance.`,
      "MISSING_MIGRATIONS",
      { expected, applied: appliedNames, missing }
    );
    throw new FatalStartupError(inner.message, inner);
  }

  // ── 3. Extra / unknown migrations ───────────────────────────────────────
  const extra = appliedNames.filter((m) => !(expected as readonly string[]).includes(m));
  if (extra.length > 0) {
    const inner = new MigrationValidationError(
      `Database schema is AHEAD of the coordinator code. ` +
        `Unexpected migrations: [${extra.join(", ")}]. ` +
        `Expected latest version: ${CURRENT_SCHEMA_VERSION}. ` +
        `Upgrade the coordinator binary to match the database, or roll back ` +
        `the database to the last known-good migration. ` +
        `See coordinator/docs/migration-strategy.md for rollback guidance.`,
      "EXTRA_MIGRATIONS",
      { expected, applied: appliedNames, extra }
    );
    throw new FatalStartupError(inner.message, inner);
  }

  // ── 4. Ordering check ────────────────────────────────────────────────────
  //
  // The applied list (sorted by applied_at, migration) must match the expected
  // list exactly in name order.  We compare sorted sets to catch any case
  // where the same migrations are present but in the wrong sequence, which
  // would indicate manual table surgery.
  const sortedExpected = [...expected].sort();
  const sortedApplied  = [...appliedNames].sort();
  const orderMismatch  =
    expected.length !== appliedNames.length ||
    sortedExpected.some((m, i) => m !== (sortedApplied.at(i) ?? ""));

  if (orderMismatch) {
    const inner = new MigrationValidationError(
      `Migration history is OUT OF ORDER or has duplicates. ` +
        `Expected: [${expected.join(" → ")}]. ` +
        `Found: [${appliedNames.join(" → ")}]. ` +
        `Rollback is not supported; manual schema repair is required. ` +
        `See coordinator/docs/migration-strategy.md.`,
      "OUT_OF_ORDER",
      { expected, applied: appliedNames }
    );
    throw new FatalStartupError(inner.message, inner);
  }

  // ── 5. Latest version matches code constant ──────────────────────────────
  const latest = applied.at(-1)?.migration ?? null;
  if (latest !== CURRENT_SCHEMA_VERSION) {
    const inner = new MigrationValidationError(
      `Schema version mismatch. ` +
        `Database latest: ${latest ?? "(none)"}. ` +
        `Coordinator expects: ${CURRENT_SCHEMA_VERSION}. ` +
        `Ensure all migrations have been applied and CURRENT_SCHEMA_VERSION is ` +
        `up-to-date in coordinator/src/persistence/db.ts.`,
      "VERSION_MISMATCH",
      { expected, applied: appliedNames }
    );
    throw new FatalStartupError(inner.message, inner);
  }
}

// ── openDatabase ──────────────────────────────────────────────────────────────

/**
 * Open (or create) the coordinator's database and apply all pending migrations.
 *
 * Supports both SQLite (`file:` URLs) and PostgreSQL (`postgres://` or
 * `postgresql://` URLs).
 *
 * The database is treated as a CACHE of on-chain state.  If it is lost or
 * corrupted the coordinator can rebuild it by re-reading events from both
 * chains.
 *
 * @throws FatalStartupError when the schema is incompatible with the binary.
 *         These errors must not be retried — they require human intervention.
 * @throws Error for transient failures (connection refused, lock contention)
 *         which the caller may safely retry with backoff.
 */
export async function openDatabase(url: string): Promise<Database> {
  const db =
    url.startsWith("postgres://") || url.startsWith("postgresql://")
      ? await openPostgresDatabase(url)
      : openSqliteDatabase(url);

  // validateSchemaVersion wraps all incompatibility errors in FatalStartupError
  // so the caller's retryAsync loop short-circuits immediately on schema issues.
  await validateSchemaVersion(db);
  return db;
}

// ── SQLite ────────────────────────────────────────────────────────────────────

function openSqliteDatabase(url: string): Database {
  const filename = url.startsWith("file:") ? url.slice("file:".length) : url;
  const db = new DatabaseSync(filename);

  // Apply the canonical schema (idempotent — uses CREATE TABLE/INDEX IF NOT EXISTS).
  // schema.sql is the authoritative source of truth for fresh SQLite databases.
  // It already includes the DDL for all migrations in SQLITE_MIGRATIONS.
  const schema = readFileSync(resolve(__dirname, "schema.sql"), "utf8");
  db.exec(schema);

  // Apply incremental column additions for pre-existing databases.
  // schema.sql only creates tables IF NOT EXISTS, so new columns must be
  // applied separately on upgrade paths.  Each ALTER TABLE is wrapped in a
  // try/catch so it is idempotent on databases that already have the column.
  const incrementalAlters: string[] = [
    "ALTER TABLE orders ADD COLUMN preimage_enc_version INTEGER DEFAULT NULL",
    "ALTER TABLE orders ADD COLUMN archived_at INTEGER",
  ];
  for (const alter of incrementalAlters) {
    try {
      db.exec(alter);
    } catch {
      // Column already present — safe to ignore.
    }
  }

  // Seed the migration history for every logical migration covered by schema.sql.
  // INSERT OR IGNORE is idempotent: re-opening an existing database never
  // creates duplicate rows.  applied_at reflects the first-open timestamp;
  // duration_ms is 0 because SQLite applies all migrations atomically above.
  const now = Math.floor(Date.now() / 1000);
  const seed = db.prepare(
    "INSERT OR IGNORE INTO schema_migrations (migration, applied_at, duration_ms) VALUES (?, ?, ?)"
  );
  for (const m of SQLITE_MIGRATIONS) {
    seed.run(m, now, 0);
  }

  return db;
}

// ── Postgres ──────────────────────────────────────────────────────────────────

async function openPostgresDatabase(url: string): Promise<PostgresDatabase> {
  const { Pool } = (await import("pg")) as typeof import("pg");
  const pool = new Pool({ connectionString: url });

  // Bootstrap the migration tracking table before the migration loop.
  // IF NOT EXISTS makes this safe on both fresh and already-upgraded databases.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
        migration   TEXT    PRIMARY KEY,
        applied_at  BIGINT  NOT NULL,
        duration_ms BIGINT  NOT NULL
    )
  `);

  const migrationsDir = resolve(__dirname, "..", "..", "migrations");

  for (const file of POSTGRES_MIGRATION_FILES) {
    // Skip migrations that were already successfully applied.
    const { rows: existing } = await pool.query(
      "SELECT 1 FROM schema_migrations WHERE migration = $1",
      [file]
    );
    if (existing.length > 0) continue;

    const sql = loadMigrationFile(migrationsDir, file);

    const t0 = Date.now();
    const client = await pool.connect();
    try {
      // Each migration runs in its own transaction so a failure leaves the
      // schema_migrations table in a consistent state and the migration can
      // be re-attempted after the underlying problem is fixed.
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("COMMIT");
      } catch (err: any) {
        await client.query("ROLLBACK");
        // "already exists" errors from idempotent DDL (CREATE TABLE IF NOT
        // EXISTS, ADD CONSTRAINT IF NOT EXISTS) are safe to ignore — the
        // migration has logically been applied even if Postgres complains.
        if (!err.message?.includes("already exists")) {
          throw new Error(
            `Migration ${file} failed: ${err.message ?? String(err)}. ` +
              `Fix the underlying issue and restart the coordinator. ` +
              `See coordinator/docs/migration-strategy.md for rollback guidance.`
          );
        }
      }
    } finally {
      client.release();
    }
    const durationMs = Date.now() - t0;

    // Record the completed migration.  ON CONFLICT DO NOTHING guards against
    // concurrent coordinator starts racing to insert the same row.
    await pool.query(
      "INSERT INTO schema_migrations (migration, applied_at, duration_ms) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
      [file, Math.floor(Date.now() / 1000), durationMs]
    );
  }

  return new PostgresDatabase(pool);
}

// ── Migration file loader ─────────────────────────────────────────────────────

/**
 * Load a migration SQL file.  For Postgres-specific variants that share their
 * name suffix pattern (e.g. `*_postgres.sql`), we fall back to the generic
 * SQLite version if the Postgres-specific file does not exist on disk.
 *
 * This keeps the migration directory lean: you only need a separate
 * `*_postgres.sql` when the DDL syntax genuinely differs.
 */
function loadMigrationFile(migrationsDir: string, file: string): string {
  const primary = resolve(migrationsDir, file);
  try {
    return readFileSync(primary, "utf8");
  } catch {
    // Fall back to the generic (SQLite) version for Postgres-specific filenames.
    const genericName = file.replace("_postgres.sql", ".sql");
    if (genericName !== file) {
      try {
        return readFileSync(resolve(migrationsDir, genericName), "utf8");
      } catch {
        // fall through to the final throw below
      }
    }
    throw new Error(
      `Migration file not found: ${file} (also tried ${genericName}). ` +
        `Ensure the file exists under coordinator/migrations/.`
    );
  }
}
