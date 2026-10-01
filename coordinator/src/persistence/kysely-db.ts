/**
 * @file kysely-db.ts
 *
 * Kysely database factory for the WaffleFinance coordinator.
 *
 * This module provides `createKyselyDb()`, which returns a fully-typed
 * `Kysely<CoordinatorDatabase>` instance backed by either:
 *
 *  - **SQLite** (via `node:sqlite` through `KyselySqliteDialect`) — the
 *    default for local development and CI.
 *  - **PostgreSQL** (via `KyselyPostgresDialect` backed by the `pg` Pool) —
 *    the target for production deployments.
 *
 * Both dialects share the same query-builder call sites; dialect-specific SQL
 * (e.g. `EXTRACT(EPOCH FROM NOW())` vs `strftime('%s','now')`) is generated
 * automatically by Kysely's dialect layer.
 *
 * ## Migration decision (TD-040)
 *
 * The existing `PostgresStatement.convertSqliteToPostgres` hand-rolled
 * translation in `db.ts` is DEPRECATED.  New persistence code should use
 * Kysely query builders exclusively.  Existing raw-SQL code continues to
 * work through the legacy `Database` / `PostgresDatabase` interface until
 * it is migrated query by query.
 *
 * ## Usage
 *
 * ```ts
 * import { createKyselyDb } from './kysely-db.js';
 *
 * const db = await createKyselyDb(process.env.DATABASE_URL!);
 *
 * // Type-safe SELECT
 * const orders = await db
 *   .selectFrom('orders')
 *   .selectAll()
 *   .where('status', '=', 'announced')
 *   .execute();
 *
 * // Type-safe INSERT
 * const { insertId } = await db
 *   .insertInto('audit_log')
 *   .values({ schema_version: 1, event_type: 'order.announced', payload_json: '{}' })
 *   .executeTakeFirst();
 * ```
 *
 * ## Dialect notes
 *
 * - SQLite: uses `BunSqliteDialect` (compatible with node:sqlite via the
 *   `kysely-bun-sqlite` adapter). Falls back to `SqliteDialect` for plain
 *   node environments via a thin adapter.
 * - PostgreSQL: uses Kysely's built-in `PostgresDialect` with the `pg` Pool.
 *
 * @see https://kysely.dev/docs/getting-started
 */

import { Kysely, PostgresDialect, SqliteDialect, type KyselyConfig } from 'kysely';
import type { CoordinatorDatabase } from './schema-types.js';

// ── Re-export CoordinatorDatabase so callers only need one import ─────────────
export type { CoordinatorDatabase };
export type KyselyCoordinatorDb = Kysely<CoordinatorDatabase>;

// ── Dialect factory ───────────────────────────────────────────────────────────

/**
 * Create and return a typed Kysely instance connected to the correct backend.
 *
 * @param url  Database URL.
 *             - `postgres://…` or `postgresql://…` → PostgreSQL via `pg`
 *             - `file:…` or a plain file path → SQLite via node:sqlite
 * @returns    A ready-to-use `Kysely<CoordinatorDatabase>` instance.
 */
export async function createKyselyDb(url: string): Promise<KyselyCoordinatorDb> {
  const isPostgres =
    url.startsWith('postgres://') || url.startsWith('postgresql://');

  let config: KyselyConfig;

  if (isPostgres) {
    const { Pool } = (await import('pg')) as typeof import('pg');
    const pool = new Pool({ connectionString: url });
    config = {
      dialect: new PostgresDialect({ pool }),
    };
  } else {
    // node:sqlite — loaded via createRequire to avoid bundler transforms.
    const { createRequire } = await import('node:module');
    const nodeRequire = createRequire(import.meta.url);
    const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite');

    const filename = url.startsWith('file:') ? url.slice('file:'.length) : url;
    const sqlite = new DatabaseSync(filename);

    // Kysely SqliteDialect requires a driver that matches the `Database`
    // interface (synchronous `.prepare()` + `StatementSync` methods).
    // `node:sqlite`'s `DatabaseSync` is fully compatible.
    config = {
      dialect: new SqliteDialect({
        database: sqlite as any,
      }),
    };
  }

  return new Kysely<CoordinatorDatabase>(config);
}

// ── Kysely-based query helpers ────────────────────────────────────────────────
// These small utility functions reproduce common raw-SQL patterns from the
// legacy db.ts / orders-repo.ts using the Kysely query builder.  They are
// imported by modules that have been migrated away from the legacy interface.

import { sql } from 'kysely';

/**
 * Return a Kysely `sql` expression for the current unix timestamp in seconds.
 * Works for both SQLite (`strftime`) and PostgreSQL (`EXTRACT(EPOCH …)`).
 *
 * SQLite  → `CAST(strftime('%s','now') AS INTEGER)`
 * Postgres → `CAST(EXTRACT(EPOCH FROM NOW()) AS INTEGER)`
 *
 * @param isPostgres  Pass `true` when connected to PostgreSQL.
 */
export function nowSecondsExpr(isPostgres: boolean) {
  return isPostgres
    ? sql<number>`CAST(EXTRACT(EPOCH FROM NOW()) AS INTEGER)`
    : sql<number>`CAST(strftime('%s','now') AS INTEGER)`;
}

// ── Kysely migration system ───────────────────────────────────────────────────
//
// Kysely's `Migrator` is used for new schema changes going forward.
// Existing SQL migration files under coordinator/migrations/ are wrapped in
// a KyselyMigration object so the Migrator can track them alongside any
// future TypeScript migrations.

export { KyselyMigrationRunner } from './kysely-migrations.js';
