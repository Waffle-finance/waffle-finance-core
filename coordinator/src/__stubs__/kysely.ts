/**
 * Test-only stub for the `kysely` package.
 *
 * kysely is used in kysely-db.ts (a Postgres query-builder layer added for
 * future migration). The coordinator tests do not exercise any Kysely code
 * path at runtime — kysely-db.ts is imported transitively through the module
 * graph but createKyselyDb() is never called in the SQLite-backed test apps.
 *
 * This stub exports just enough to satisfy the import without the real
 * package being installed.
 */

export class Kysely<_DB = unknown> {}
export class PostgresDialect {}
export class SqliteDialect {}
export type KyselyConfig = Record<string, unknown>;
