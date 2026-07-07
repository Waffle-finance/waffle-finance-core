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

1. Stop the coordinator before restore.
2. Take a fresh backup and keep it outside the deployment directory.
3. Confirm `DATABASE_URL` points at the intended environment.
4. Run restore with `--force`.
5. Start the coordinator.
6. Check `/healthz`, `/readyz`, and `/metrics`.
7. Confirm `schema_migrations` contains the expected latest migration.

## Notes

- The coordinator database is designed as a cache of on-chain state, but backups
  reduce recovery time and preserve local reconciliation context.
- PostgreSQL restore requires `pg_dump` and `pg_restore` to be installed on the
  operator machine.
- Do not paste database URLs with credentials into logs, tickets, or public
  issue comments.
