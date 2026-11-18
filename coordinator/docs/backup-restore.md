# Coordinator backup and restore

The coordinator persists operational state in the database configured by
`DATABASE_URL`. SQLite is used for local/dev deployments, and PostgreSQL is the
recommended production backend. These scripts provide a repeatable way to take a
verified backup before risky maintenance, migrations, or incident recovery.

## Backup

SQLite example:

```bash
DATABASE_URL=file:./wafflefinance.db pnpm --filter @wafflefinance/coordinator db:backup
```

PostgreSQL example:

```bash
DATABASE_URL=postgresql://user:pass@db.example.com:5432/wafflefinance pnpm --filter @wafflefinance/coordinator db:backup -- --out ./backups
```

The backup script:

- creates a timestamped file under `backups/` unless `--out` is provided
- uses SQLite `VACUUM INTO` for a consistent SQLite copy
- uses `pg_dump --format=custom` for PostgreSQL
- verifies SQLite backups with `PRAGMA integrity_check`
- verifies PostgreSQL dumps with `pg_restore --list`
- refuses to overwrite an existing backup file

## Restore

Restore is intentionally guarded by `--force`.

SQLite example:

```bash
DATABASE_URL=file:./wafflefinance.db pnpm --filter @wafflefinance/coordinator db:restore -- --from ./backups/coordinator-sqlite-2026-06-30T00-00-00-000Z.db --force
```

PostgreSQL example:

```bash
DATABASE_URL=postgresql://user:pass@db.example.com:5432/wafflefinance pnpm --filter @wafflefinance/coordinator db:restore -- --from ./backups/coordinator-postgres-2026-06-30T00-00-00-000Z.dump --force
```

The restore script:

- verifies the backup before restore unless `--no-verify` is passed
- moves an existing SQLite database aside as `*.pre-restore-<timestamp>.bak`
- uses `pg_restore --clean --if-exists` for PostgreSQL
- verifies the restored SQLite database after copying

## Operational checklist

### 1. Preserve recovery material and rehearse in isolation

Keep the original backup immutable outside the deployment directory and make a
separate working copy. Record its checksum, timestamp, coordinator release, and
the snapshot's order/event counts, if available. Never use the backup path as
the restore target, and never replace the only backup. Before production cutover,
take a fresh `db:backup` of the current database to a new destination as well.

Use a new SQLite path or a separately provisioned PostgreSQL database with an
isolated role. Confirm the resolved target is not production. Stop all writers
to that target; for SQLite, keep the database and any WAL/SHM files together and
never move or replace a database while it is open. The following are operator
commands, run from the repository root (Bash syntax):

```bash
DATABASE_URL=file:./restore-check/coordinator.db pnpm --filter @wafflefinance/coordinator db:restore -- --from /safe/working-copy.db --force
# PostgreSQL alternative: RESTORE_DATABASE_URL must identify the isolated DB.
DATABASE_URL="$RESTORE_DATABASE_URL" pnpm --filter @wafflefinance/coordinator db:restore -- --from /safe/working-copy.dump --force
```

Keep verification enabled; do not use `--no-verify`. PostgreSQL's restore uses
`--clean --if-exists`, so a mistaken target can destroy existing tables. A dump
passing `pg_restore --list` only proves its archive is readable, not that its
rows have been restored correctly. Any nonzero restore exit status is a stop
condition; do not start the service against a partially restored target.

### 2. Verify schema and records before starting the coordinator

Check the registry shipped with the exact release to be deployed:

```bash
pnpm --filter @wafflefinance/coordinator db:validate-migrations
```

This command validates files and registry consistency, **not** the restored DB.
Inspect `CURRENT_SCHEMA_VERSION`, `SQLITE_MIGRATIONS`, and
`POSTGRES_MIGRATION_FILES` in `src/persistence/db.ts`. At the time of this guide,
the latest version is `013_replay_safety.sql`. Compare the entire restored
history to the appropriate backend registry, including PostgreSQL file suffixes;
checking only the last row misses gaps or unexpected migrations.

Open SQLite read-only, or connect to the isolated PostgreSQL database using
your protected connection configuration (for example, a PostgreSQL service entry):

```bash
sqlite3 -readonly ./restore-check/coordinator.db
# PostgreSQL alternative; configure this service to reference only the isolated DB.
psql 'service=coordinator_restore_check' -v ON_ERROR_STOP=1
```

Run these read-only queries in the selected client:

```sql
SELECT migration, applied_at, duration_ms
FROM schema_migrations ORDER BY applied_at, migration;
SELECT COUNT(*) AS orders FROM orders;
SELECT status, COUNT(*) AS orders FROM orders GROUP BY status ORDER BY status;
SELECT COUNT(*) AS order_events FROM order_events;
SELECT COUNT(*) AS duplicate_public_ids FROM (
  SELECT public_id FROM orders GROUP BY public_id HAVING COUNT(*) > 1
) AS duplicates;
SELECT COUNT(*) AS orphan_events FROM order_events AS e
LEFT JOIN orders AS o ON o.id = e.order_id WHERE o.id IS NULL;
SELECT COUNT(*) AS invalid_timestamps FROM orders
WHERE created_at <= 0 OR updated_at < created_at
   OR (archived_at IS NOT NULL AND archived_at < created_at);
```

For SQLite also run `PRAGMA integrity_check;` (must return `ok`) and
`PRAGMA foreign_key_check;` (must return no rows). Duplicate IDs, orphan events,
and invalid timestamps must all be zero. Compare totals and status counts with
the backup snapshot's baseline, not a live database that has advanced since the
backup. If no baseline exists, obtain independent evidence for expected counts
and inspect known public order IDs and their event histories before approval.
Do not select secret preimages or dump complete order rows into tickets.

If history is behind, follow [the migration strategy](migration-strategy.md)
on another disposable copy and repeat every check. Do not fabricate migration
rows to satisfy validation. Unknown migrations, integrity failures, unexplained
count differences, or failed schema validation block cutover. Preserve the failed
copy for investigation and retry with a known-good backup or matching release.

### 3. Validate the service and decide whether to resume traffic

Only after the offline checks pass, start a coordinator with the matching release
against the verified isolated database, a private port, and isolated dependencies.
Keep it out of the load balancer and prevent unintended production chain writes.
For a process configured on port 3001:

```bash
curl --fail-with-body http://127.0.0.1:3001/healthz
curl --fail-with-body http://127.0.0.1:3001/readyz
curl --fail-with-body http://127.0.0.1:3001/metrics
```

`/healthz` confirms liveness only. Require `/readyz` HTTP 200, `status: "ok"`,
and passing dependency checks, including `database`. Missing migrations produce
`database` detail `missing_migrations`; other incompatible histories produce
`schema_mismatch`. HTTP 503 blocks traffic even when liveness is HTTP 200.
Confirm reconciliation completes successfully and inspect a few known orders
through the normal read API before accepting the rehearsal.

For production cutover, drain traffic and stop all coordinator writers, preserve
the fresh pre-cutover backup, restore to the confirmed target, and repeat the
offline checks **before restart**. Then start privately and repeat the health and
reconciliation gates before routing traffic. If any gate fails, keep traffic
drained and stop the candidate. Restore the preserved pre-cutover backup to a
separate target with its matching release and verify it using the same gates;
for SQLite the `*.pre-restore-<timestamp>.bak` is additional recovery material.
PostgreSQL has no automatic pre-restore safety copy. Do not blindly downgrade a
migrated database or resume traffic until the selected recovery target passes.

## Notes

- The coordinator database is designed as a cache of on-chain state, but backups
  reduce recovery time and preserve local reconciliation context.
- PostgreSQL restore requires `pg_dump` and `pg_restore` to be installed on the
  operator machine.
- Do not paste database URLs with credentials into logs, tickets, or public
  issue comments.
