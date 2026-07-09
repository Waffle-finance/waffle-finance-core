# Coordinator Schema Migration Guide

## Overview

The coordinator uses a versioned SQL migration system to evolve its database schema.
Both SQLite (development) and PostgreSQL (production) are supported.

### Migration files

Migrations live in `coordinator/migrations/` and are applied in lexicographic
order by numeric prefix (`001_`, `002_`, …). Each file is idempotent where
possible (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE … ADD COLUMN IF NOT EXISTS`).

| File                          | Purpose                                                      |
| ----------------------------- | ------------------------------------------------------------ |
| `001_initial.sql`             | Base schema: `orders`, `order_events`, `resolver_heartbeats` |
| `002_solana_support.sql`      | Adds `solana` to chain CHECK constraints                     |
| `003_secret_encryption.sql`   | Adds `preimage_enc_version` to `orders`                      |
| `004_query_optimizations.sql` | Adds composite indexes for history lookups                   |
| `005_schema_migrations.sql`   | Creates the `schema_migrations` tracking table               |
| `006_stale_cleanup.sql`       | Adds `archived_at` to `orders`                               |

PostgreSQL uses parallel files where SQL syntax differs (e.g. `002_solana_support_postgres.sql`).

### Version tracking

Every applied migration is recorded in `schema_migrations`:

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
    migration   TEXT    PRIMARY KEY,
    applied_at  BIGINT  NOT NULL,
    duration_ms BIGINT  NOT NULL
);
```

The coordinator seeds this table on first open (SQLite) or records each migration
after it runs (Postgres). The latest entry corresponds to the current schema
version constant `CURRENT_SCHEMA_VERSION` in `persistence/db.ts`.

## Supported upgrade path

Before applying a production migration, create a verified coordinator database
backup with `pnpm --filter @wafflefinance/coordinator db:backup`. See
[`backup-restore.md`](./backup-restore.md) for SQLite and PostgreSQL examples.

1. **Add a new migration file** with the next numeric prefix (e.g. `007_new_feature.sql`).
2. **Update `CURRENT_SCHEMA_VERSION`** in `coordinator/src/persistence/db.ts` to match the new file name.
3. **Deploy the coordinator** — startup automatically applies the new migration and validates the schema.
4. **Rollback is not supported.** If a migration must be reversed, manually edit the database
   and create a compensating migration (e.g. `008_rollback_007.sql`).

## Startup validation

On every startup the coordinator:

1. Opens the database.
2. Applies any pending migrations (SQLite) or runs the migration loop (Postgres).
3. Calls `validateSchemaVersion(db)` which checks:
   - `schema_migrations` is readable.
   - Every expected migration is present.
   - No unexpected (future) migrations are present.
   - Migrations are in the correct order.
   - The latest applied migration equals `CURRENT_SCHEMA_VERSION`.

If any check fails, startup aborts with a clear error message and the process exits
with a non-zero code. This prevents partial-migration states from serving traffic.

## Developer checklist

- [ ] New columns use `ADD COLUMN IF NOT EXISTS`.
- [ ] New constraints use `ADD CONSTRAINT IF NOT EXISTS` (or guarded `ALTER TABLE`).
- [ ] Do not remove or rename columns in-place; add a new column and migrate data.
- [ ] Do not depend on migration order other than the numeric prefix.
- [ ] Always update `CURRENT_SCHEMA_VERSION`.
