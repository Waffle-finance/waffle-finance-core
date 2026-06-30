import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import type { Pool, PoolClient } from "pg";

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
 * PostgreSQL wrapper to provide a SQLite-like interface.
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
 * PostgreSQL statement wrapper to provide a SQLite-like interface.
 */
export class PostgresStatement {
  constructor(private pool: Pool, private sql: string) {}

  private convertSqliteToPostgres(sql: string, params: any[]): { sql: string; params: any[] } {
    // Convert strftime expressions first
    let converted = sql.replace(
      /CAST\(strftime\('%s','now'\) AS INTEGER\)/g,
      "CAST(EXTRACT(EPOCH FROM NOW()) AS INTEGER)"
    );

    // Handle named parameters
    const namedParams = Array.from(converted.matchAll(/:(\w+)/g));

    if (namedParams.length > 0) {
      // Build parameter map from first parameter object
      const paramMap: { [key: string]: any } = {};
      if (params.length > 0 && typeof params[0] === 'object' && params[0] !== null && !(params[0] instanceof Array)) {
        Object.assign(paramMap, params[0]);
      }

      // Track parameter order and build positional array
      const positionalParams: any[] = [];
      const paramIndexMap: { [key: string]: number } = {};

      // Replace named parameters in order of appearance
      converted = converted.replace(/:(\w+)/g, (match, paramName) => {
        // If we've seen this parameter before, reuse its index
        if (Object.prototype.hasOwnProperty.call(paramIndexMap, paramName)) {
          return `$${paramIndexMap[paramName]}`;
        }

        // New parameter - add to positional array
        const index = positionalParams.length + 1;
        paramIndexMap[paramName] = index;
        positionalParams.push(paramMap[paramName]);
        return `$${index}`;
      });

      return { sql: converted, params: positionalParams };
    }

    // Handle positional ? parameters
    const questionMarks = Array.from(converted.matchAll(/\?/g));
    if (questionMarks.length > 0) {
      let index = 1;
      converted = converted.replace(/\?/g, () => `$${index++}`);
      return { sql: converted, params };
    }

    return { sql: converted, params };
  }

  run(...params: any[]): { changes: number; lastInsertRowid: number } {
    throw new Error(
      "PostgresStatement.run() should not be called synchronously. Use runAsync() instead."
    );
  }

  get(...params: any[]): any {
    throw new Error(
      "PostgresStatement.get() should not be called synchronously. Use getAsync() instead."
    );
  }

  all(...params: any[]): any[] {
    throw new Error(
      "PostgresStatement.all() should not be called synchronously. Use allAsync() instead."
    );
  }

  /**
   * Async versions for Postgres.
   */
  async runAsync(...params: any[]): Promise<{ changes: number; lastInsertRowid: number }> {
    const { sql, params: convertedParams } = this.convertSqliteToPostgres(this.sql, params);
    const result = await this.pool.query(sql, convertedParams);
    return { changes: result.rowCount || 0, lastInsertRowid: 0 };
  }

  async getAsync(...params: any[]): Promise<any> {
    const { sql, params: convertedParams } = this.convertSqliteToPostgres(this.sql, params);
    const result = await this.pool.query(sql, convertedParams);
    return result.rows[0] || null;
  }

  async allAsync(...params: any[]): Promise<any[]> {
    const { sql, params: convertedParams } = this.convertSqliteToPostgres(this.sql, params);
    const result = await this.pool.query(sql, convertedParams);
    return result.rows;
  }
}

// ── Migration metadata ───────────────────────────────────────────────────────

// The latest migration file name.  Bump this whenever a new migration is
// added so startup validation can detect databases that are missing
// incremental changes.
export const CURRENT_SCHEMA_VERSION = "006_stale_cleanup.sql";

// Logical migrations that schema.sql covers, in application order.
// These names are seeded into the schema_migrations table on first open of a
// SQLite database.  The canonical names match the files under coordinator/migrations/.
const SQLITE_MIGRATIONS = [
  "001_initial.sql",
  "002_solana_support.sql",
  "003_secret_encryption.sql",
  "004_query_optimizations.sql",
  "005_schema_migrations.sql",
  "006_stale_cleanup.sql",
] as const;

// Postgres migration files, applied in order.  Migration 005 creates the
// schema_migrations table (which is already bootstrapped inline, so it runs as
// a no-op) but is still recorded so the history is complete.
const POSTGRES_MIGRATION_FILES = [
  "001_initial.sql",
  "002_solana_support_postgres.sql",
  "003_secret_encryption.sql",
  "004_query_optimizations.sql",
  "005_schema_migrations.sql",
  "006_stale_cleanup_postgres.sql",
] as const;

// ── Public helpers ───────────────────────────────────────────────────────────

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

  // SQLite — synchronous statement execution.
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

/**
 * The set of migration files expected for a given backend, in application
 * order.  Callers compare this against the `schema_migrations` table to
 * detect missing or out-of-order changes.
 */
function getExpectedMigrations(backend: "sqlite" | "postgres"): readonly string[] {
  return backend === "sqlite" ? SQLITE_MIGRATIONS : POSTGRES_MIGRATION_FILES;
}

/**
 * Validate that the database schema matches the coordinator's current
 * expected version.  Throws on any incompatibility so the caller can
 * fail fast before serving traffic.
 *
 * Checks performed:
 *   1. `schema_migrations` table exists and is readable.
 *   2. Every migration in the expected sequence has been applied.
 *   3. Migrations appear in the correct (lexicographic / numeric prefix) order.
 *   4. The latest applied migration matches `CURRENT_SCHEMA_VERSION`.
 */
export async function validateSchemaVersion(db: Database): Promise<void> {
  const backend = isPostgresDatabase(db) ? "postgres" : "sqlite";
  const expected = getExpectedMigrations(backend);

  let applied: MigrationRecord[];
  try {
    applied = await queryMigrations(db);
  } catch (err) {
    throw new Error(
      `Schema validation failed: could not read schema_migrations table. ` +
      `The database may be from a newer version or corrupted. ` +
      `Details: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const appliedNames = applied.map((r) => r.migration);

  // 1. Detect missing migrations
  const missing = expected.filter((m) => !appliedNames.includes(m));
  if (missing.length > 0) {
    throw new Error(
      `Database schema is behind the coordinator code. ` +
      `Missing migrations: ${missing.join(", ")}. ` +
      `Expected latest version: ${CURRENT_SCHEMA_VERSION}. ` +
      `This can happen when a deployment runs an older binary against an ` +
      `upgraded database.`
    );
  }

  // 2. Detect extra migrations (applied but not known to this version)
  const extra = appliedNames.filter((m) => !expected.includes(m));
  if (extra.length > 0) {
    throw new Error(
      `Database schema is ahead of the coordinator code. ` +
      `Unexpected migrations: ${extra.join(", ")}. ` +
      `Expected latest version: ${CURRENT_SCHEMA_VERSION}. ` +
      `Upgrade the coordinator binary before opening this database.`
    );
  }

  // 3. Detect ordering problems
  const sortedExpected = [...expected].sort();
  const sortedApplied = [...appliedNames].sort();
  if (
    expected.length !== appliedNames.length ||
    expected.some((m, i) => m !== appliedNames[i]) ||
    sortedExpected.join(",") !== sortedApplied.join(",")
  ) {
    throw new Error(
      `Migration history is out of order. ` +
      `Expected order: ${expected.join(" -> ")}. ` +
      `Found: ${appliedNames.join(" -> ")}. ` +
      `Rollback is not supported; manual schema repair may be required.`
    );
  }

  // 4. Verify latest version matches code constant
  const latest = applied.at(-1)?.migration ?? null;
  if (latest !== CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Schema version mismatch. ` +
      `Database latest: ${latest ?? "(none)"}, code expects: ${CURRENT_SCHEMA_VERSION}.`
    );
  }
}

// ── openDatabase ─────────────────────────────────────────────────────────────

/**
 * Open (or create) the coordinator's database and apply the
 * schema. The schema is idempotent so calling this on an existing DB
 * is safe.
 *
 * Supports both SQLite (file: URLs) and Postgres (postgres:// URLs).
 *
 * The DB is treated as a CACHE of on-chain state. If it is lost or
 * corrupted, the coordinator can rebuild it by re-reading events from
 * both chains.
 */
export async function openDatabase(url: string): Promise<Database> {
  const db =
    url.startsWith("postgres://") || url.startsWith("postgresql://")
      ? await openPostgresDatabase(url)
      : openSqliteDatabase(url);

  await validateSchemaVersion(db);
  return db;
}

// ── SQLite ───────────────────────────────────────────────────────────────────

function openSqliteDatabase(url: string): Database {
  const filename = url.startsWith("file:") ? url.slice("file:".length) : url;
  const db = new DatabaseSync(filename);

  // Apply the canonical schema (idempotent — uses CREATE TABLE/INDEX IF NOT EXISTS).
  const schema = readFileSync(resolve(__dirname, "schema.sql"), "utf8");
  db.exec(schema);

  // Apply incremental column migrations for tables that already exist.
  // schema.sql only creates tables IF NOT EXISTS, so new columns added later
  // must be applied separately.  Each ALTER TABLE is wrapped in a try/catch
  // so the call is idempotent on databases that already have the column.
  try {
    db.exec("ALTER TABLE orders ADD COLUMN archived_at INTEGER");
  } catch {
    // Column already present — safe to ignore.
  }

  // Seed migration history for all logical migrations covered by schema.sql.
  // INSERT OR IGNORE makes this safe on existing databases: already-recorded
  // migrations are silently skipped so opening the DB twice never creates
  // duplicate rows.  applied_at reflects the real first-open timestamp;
  // duration_ms is 0 because all migrations are applied atomically above.
  const now = Math.floor(Date.now() / 1000);
  const seed = db.prepare(
    "INSERT OR IGNORE INTO schema_migrations (migration, applied_at, duration_ms) VALUES (?, ?, ?)"
  );
  for (const m of SQLITE_MIGRATIONS) {
    seed.run(m, now, 0);
  }

  return db;
}

// ── Postgres ─────────────────────────────────────────────────────────────────

async function openPostgresDatabase(url: string): Promise<PostgresDatabase> {
  const { Pool } = (await import("pg")) as typeof import("pg");
  const pool = new Pool({ connectionString: url });

  // Bootstrap the migration tracking table before running the migration loop.
  // This table must exist so we can (a) check which migrations are already
  // applied and (b) record each new migration after it completes.
  // Using IF NOT EXISTS makes this safe on both fresh and upgraded databases.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
        migration   TEXT    PRIMARY KEY,
        applied_at  BIGINT  NOT NULL,
        duration_ms BIGINT  NOT NULL
    )
  `);

  const migrationsDir = resolve(__dirname, "..", "..", "migrations");

  for (const file of POSTGRES_MIGRATION_FILES) {
    // Skip migrations that were already applied in a previous run.
    const { rows: existing } = await pool.query(
      "SELECT 1 FROM schema_migrations WHERE migration = $1",
      [file]
    );
    if (existing.length > 0) continue;

    const migrationPath = resolve(migrationsDir, file);
    let migration: string;
    try {
      migration = readFileSync(migrationPath, "utf8");
    } catch {
      // Fallback to SQLite version if PostgreSQL-specific version doesn't exist.
      if (file === "002_solana_support_postgres.sql") {
        migration = readFileSync(resolve(migrationsDir, "002_solana_support.sql"), "utf8");
      } else if (file === "006_stale_cleanup_postgres.sql") {
        migration = readFileSync(resolve(migrationsDir, "006_stale_cleanup.sql"), "utf8");
      } else {
        throw new Error(`Migration file not found: ${file}`);
      }
    }

    const t0 = Date.now();
    const client = await pool.connect();
    try {
      await client.query(migration);
    } catch (error: any) {
      // Ignore "already exists" errors from CREATE TABLE IF NOT EXISTS and
      // ADD CONSTRAINT statements that are safe to run multiple times.
      if (!error.message?.includes("already exists")) {
        throw error;
      }
    } finally {
      client.release();
    }
    const durationMs = Date.now() - t0;

    // Record that this migration has been successfully applied.
    // ON CONFLICT DO NOTHING is a safety net for concurrent coordinator starts.
    await pool.query(
      "INSERT INTO schema_migrations (migration, applied_at, duration_ms) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
      [file, Math.floor(Date.now() / 1000), durationMs]
    );
  }

  return new PostgresDatabase(pool);
}
