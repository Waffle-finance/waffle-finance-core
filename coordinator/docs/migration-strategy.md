# Coordinator Schema Migration Strategy

This document defines the rules for authoring, deploying, and rolling back
database schema changes in the WaffleFinance coordinator.

---

## Overview

The coordinator supports two database backends:

| Backend    | URL prefix              | Migration mechanism         |
|------------|-------------------------|-----------------------------|
| SQLite     | `file:` or bare path    | Atomic apply via `schema.sql` on first open; incremental columns via `ALTER TABLE` |
| PostgreSQL | `postgres://` / `postgresql://` | Sequential file-based migration runner in `openPostgresDatabase()` |

Both backends record every applied migration in the `schema_migrations` table.
Startup validation (`validateSchemaVersion`) compares this table against the
migration registry in `coordinator/src/persistence/db.ts` and **aborts with a
fatal error** if any mismatch is detected.

---

## Migration file naming

```
NNN_short_description.sql
NNN_short_description_postgres.sql   # optional Postgres-specific DDL
```

- `NNN` is a **zero-padded 3-digit sequence number** (`001`, `002`, …).
- Numbers must be contiguous and must not be reused.
- The Postgres variant (`*_postgres.sql`) is only needed when the DDL syntax
  genuinely differs from SQLite (e.g. `ALTER TABLE … DROP CONSTRAINT`).  When
  a Postgres-specific file is absent, the runner falls back to the generic file.

---

## Adding a new migration — checklist

Follow these steps in order. Skipping any step will cause startup validation
to abort.

1. **Create the migration file(s).**
   - `coordinator/migrations/NNN_my_change.sql` — always required.
   - `coordinator/migrations/NNN_my_change_postgres.sql` — only when Postgres
     DDL differs.
   - Write the migration to be **idempotent** (`CREATE TABLE IF NOT EXISTS`,
     `CREATE INDEX IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `ON CONFLICT DO
     NOTHING`).

2. **Update `schema.sql`.**
   - Apply the structural change to `coordinator/src/persistence/schema.sql`.
   - SQLite fresh databases are created from `schema.sql`; the migration file
     is only used for upgrade paths on pre-existing Postgres databases.

3. **Register the migration in `db.ts`.**
   - Add the file name to `SQLITE_MIGRATIONS` and `POSTGRES_MIGRATION_FILES`
     in `coordinator/src/persistence/db.ts`, in numeric order.
   - Bump `CURRENT_SCHEMA_VERSION` to the new file name.

4. **Update this document.**
   - Add a row to the [Migration history](#migration-history) table below.

5. **Write a migration test.**
   - Add a test case to `coordinator/test/db-migrations.test.ts` that:
     - Verifies the new migration name appears in `queryMigrations()` output.
     - Asserts the schema change is present (e.g. column exists, index visible).
     - Checks `getCurrentSchemaVersion()` returns the new version string.

---

## Deployment procedure

### PostgreSQL (incremental runner)

The coordinator applies pending migrations automatically on startup. No
separate migration command is needed. The runner is:

- **Sequential** — migrations run in `POSTGRES_MIGRATION_FILES` order.
- **Idempotent** — already-applied migrations are skipped via a `SELECT`
  check before each file is executed.
- **Transactional** — each file runs inside its own `BEGIN / COMMIT` block.
  A failure triggers `ROLLBACK` and aborts startup with a clear error.
- **Concurrent-safe** — `ON CONFLICT DO NOTHING` on the history insert
  prevents duplicate rows when two coordinators race at start.

### SQLite (atomic apply)

Fresh SQLite databases are created from `schema.sql` in a single `db.exec()`
call, which SQLite treats atomically (all-or-nothing under WAL mode).  On
an **existing** database, additive column changes are applied one at a time
via `ALTER TABLE … ADD COLUMN` wrapped in try/catch (idempotent).

---

## Startup validation

`validateSchemaVersion()` runs immediately after the database is opened,
**before the HTTP server binds and before any listeners start**.

| Error code            | Meaning                                                    | Action required                              |
|-----------------------|------------------------------------------------------------|----------------------------------------------|
| `UNREADABLE_HISTORY`  | `schema_migrations` table is missing or corrupt            | Restore from backup or re-run from scratch   |
| `MISSING_MIGRATIONS`  | Database is behind; pending migrations have not been run   | Apply the missing migration files            |
| `EXTRA_MIGRATIONS`    | Database is ahead; binary is older than the schema         | Upgrade the coordinator binary               |
| `OUT_OF_ORDER`        | History rows exist but in an unexpected sequence           | Manual repair; see rollback guidance below   |
| `VERSION_MISMATCH`    | Latest recorded migration ≠ `CURRENT_SCHEMA_VERSION`      | Check `CURRENT_SCHEMA_VERSION` in `db.ts`    |

All validation failures throw a `FatalStartupError` wrapping a
`MigrationValidationError`.  The startup retry loop (`retryAsync`) recognises
`FatalStartupError` and exits immediately without further retries — retrying a
schema mismatch will never fix it.

---

## Rollback guidance

> **Rollback is not supported at the DDL level.**  The coordinator does not
> implement down-migrations. This is intentional: down-migrations for additive
> changes (new columns, new indexes) are almost never needed, and for
> destructive changes (dropping columns, altering constraints) they are risky.

Instead, use one of the following recovery strategies:

### Strategy 1 — Roll back the binary (recommended for additive migrations)

1. Stop the coordinator.
2. Deploy the previous binary version.
3. The older binary's `CURRENT_SCHEMA_VERSION` will match the previous
   migration.  Any new columns added by the newer migration are simply unused.
4. Restart.

This works when the new migration is **purely additive** (new columns with
defaults, new indexes).

### Strategy 2 — Restore from backup (required for constraint or type changes)

1. Stop the coordinator (no writes in-flight).
2. Restore the database from a pre-migration backup (see `npm run db:backup`).
3. Deploy the previous binary.
4. Restart.

Always take a database snapshot before applying any migration in production.

### Strategy 3 — Manual SQL repair (last resort)

If no backup is available and the migration caused data loss or corruption:

1. Connect to the database with a SQL client.
2. Manually reverse the DDL change (drop the new column, restore the old
   constraint, etc.).
3. Delete the offending row from `schema_migrations`:
   ```sql
   DELETE FROM schema_migrations WHERE migration = '007_my_change.sql';
   ```
4. Restart the coordinator with the previous binary.

---

## Idempotency requirements

Every migration file **must** be idempotent so that:

- The Postgres runner can safely re-attempt a partially applied migration
  after a crash.
- Concurrent coordinator starts don't leave the schema in an inconsistent state.

Required idioms:

```sql
-- Tables
CREATE TABLE IF NOT EXISTS …;

-- Columns
ALTER TABLE orders ADD COLUMN IF NOT EXISTS …;   -- Postgres
-- (SQLite: wrap ALTER TABLE in try/catch in openSqliteDatabase())

-- Indexes
CREATE INDEX IF NOT EXISTS …;

-- Constraints (Postgres)
ALTER TABLE orders DROP CONSTRAINT IF EXISTS …;
ALTER TABLE orders ADD CONSTRAINT … IF NOT EXISTS;

-- Inserts
INSERT INTO … ON CONFLICT DO NOTHING;
```

---

## Migration history

| Version | File                           | Description                                                  |
|---------|--------------------------------|--------------------------------------------------------------|
| 001     | `001_initial.sql`              | Initial orders, order_events, resolver_heartbeats tables     |
| 002     | `002_solana_support.sql`       | Extends direction/src_chain/dst_chain constraints for Solana |
| 003     | `003_secret_encryption.sql`    | Adds `preimage_enc_version` column for AES-256-GCM storage   |
| 004     | `004_query_optimizations.sql`  | Composite indexes for address-based history queries          |
| 005a    | `005_cursor_pagination.sql`    | Cursor-pagination composite indexes on (created_at, id)      |
| 005b    | `005_schema_migrations.sql`    | Creates `schema_migrations` audit table                      |
| 006     | `006_stale_cleanup.sql`        | Adds `archived_at` column for soft-delete of stale orders    |

---

## Testing migrations

Migration tests live in `coordinator/test/db-migrations.test.ts`.

Required test cases for every new migration:

1. **Record presence** — `queryMigrations()` includes the new migration name.
2. **Idempotency** — opening the same database twice produces exactly
   `EXPECTED_MIGRATIONS.length` rows (no duplicates).
3. **Schema change visible** — query the `pragma_table_info` (SQLite) or
   `information_schema.columns` (Postgres) to assert the new column/index
   exists.
4. **Version string** — `getCurrentSchemaVersion()` returns the new file name.
5. **Validation passes** — `validateSchemaVersion()` resolves without throwing.

Run the full migration test suite:

```bash
# From the coordinator directory
npm test -- --reporter=verbose coordinator/test/db-migrations.test.ts
```

Run Postgres-specific migration tests (requires a running Postgres instance):

```bash
TEST_WITH_POSTGRES=true DATABASE_URL=postgres://... npm test
```
