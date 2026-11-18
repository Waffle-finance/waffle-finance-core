# Database Durability and Isolation Assumptions

This document describes the exact database engine assumptions the coordinator
depends on, the durability and isolation guarantees provided by each backend,
and the operational requirements operators must satisfy.

> **Note:** The coordinator treats its database as a **cache of on-chain
> truth**. If the database is lost or corrupted the coordinator can rebuild
> it by replaying events from the configured chain RPCs. The critical
> invariant is that no user funds are lost if the DB is wiped — settlement
> is always governed by the on-chain HTLC contracts.

---

## Supported Backends

The coordinator supports two database backends selected by the `DATABASE_URL`
environment variable:

| URL prefix | Backend |
|---|---|
| `file:` or bare path | SQLite via Node.js built-in `node:sqlite` |
| `postgres://` or `postgresql://` | PostgreSQL via `pg` connection pool |

---

## SQLite

### Runtime requirement

The coordinator uses the `node:sqlite` built-in module, which was stabilised
in **Node.js 22.5**. Running on an earlier Node.js version will produce a
`MODULE_NOT_FOUND` error at startup. This is enforced in `.nvmrc` and
`package.json` `engines` fields.

### WAL mode (mandatory)

The coordinator sets `PRAGMA journal_mode = WAL` unconditionally on every
database open (via `schema.sql`). WAL mode is required because:

- Without WAL, a write transaction blocks all concurrent readers. The
  coordinator's HTTP request handlers (reads) and background reconciler
  (writes) would serialize completely, producing frequent `SQLITE_BUSY`
  errors under load.
- With WAL, readers see a consistent snapshot and never block writers.
  Only one writer runs at a time, but reads are always non-blocking.

**Startup assertion:** after applying `schema.sql`, the coordinator reads
back `PRAGMA journal_mode` and throws a `FatalStartupError` if the result
is not `wal`. This can happen on network filesystems (NFS, some Docker volume
mounts, SMB shares) where SQLite WAL is unsupported. **Use a local filesystem
for the SQLite database file.**

### Transactions and the TOCTOU window

SQLite mutations in `OrdersRepository` are wrapped in
`InMemoryRepositoryTransaction.runWithRetry`, which retries up to **3 times**
on `SQLITE_BUSY`, `SQLITE_LOCKED`, and deadlock errors with exponential
backoff.

However, the pre-read + update pattern used by `recordSrcLock`,
`recordDstLock`, and `recordSecretRevealed` is **not wrapped in an explicit
`BEGIN`/`COMMIT` transaction**. Each statement runs in autocommit mode. This
means there is a narrow TOCTOU (time-of-check/time-of-use) window: if two
concurrent writes race on the same order, the second write may read stale
state before issuing its update.

**Why this is acceptable in practice:**

1. The state machine and idempotency guards in `OrderService` detect and
   reject conflicting writes with `OrderValidationError` ("conflicting src
   lock for…"). The 409 HTTP response tells the caller to re-fetch.
2. The reconciler is single-goroutine per run and does not issue concurrent
   mutations for the same order.
3. SQLite's single-writer lock means two *simultaneous* autocommit writes on
   the same row will serialize naturally; the retry wrapper handles transient
   contention.

If you require strictly serializable multi-statement operations, migrate to
PostgreSQL (see below) or wrap the repository methods in explicit transactions.

### Foreign keys

`PRAGMA foreign_keys = ON` is set on every open. SQLite foreign key
enforcement is **per-connection** and off by default; omitting this pragma
would silently allow orphaned `order_events` rows.

### Crash recovery

SQLite WAL mode provides crash-safe writes: a crash mid-write leaves the WAL
file in a consistent state, and the next open automatically rolls back any
incomplete transaction. The coordinator's idempotent mutation methods
(all use `IF NOT EXISTS` guards or `INSERT OR IGNORE`) ensure that re-running
after a crash never produces duplicate or contradictory state.

### Backup

Use SQLite's online backup API or `sqlite3 .backup` command while the
coordinator is running. Do **not** copy the raw `.db` file while the process
is running — the WAL and SHM files must be included or the backup will be
corrupt. The recommended approach:

```sh
sqlite3 coordinator.db ".backup coordinator-backup.db"
```

---

## PostgreSQL

### Connection pool

The coordinator uses `pg.Pool` with default settings. For production
deployments set:

```
PGPOOL_MAX=10          # maximum simultaneous connections
PGPOOL_IDLE_TIMEOUT=30000  # idle connection timeout (ms)
```

Consider setting a `statement_timeout` at the Postgres role level to cap
runaway queries:

```sql
ALTER ROLE coordinator_user SET statement_timeout = '30s';
```

### Transaction semantics

Each migration runs inside an explicit `BEGIN`/`COMMIT` block with `ROLLBACK`
on failure. `schema_migrations` inserts use `ON CONFLICT DO NOTHING` so
concurrent coordinator startups don't race on migration records.

Application-level mutations (`recordSrcLock`, etc.) use the same
`InMemoryRepositoryTransaction.runWithRetry` wrapper as SQLite, which retries
on `deadlock` and `lock timeout` keywords. For strictly serializable
isolation consider upgrading individual transaction managers to use
`BEGIN SERIALIZABLE`.

### Durability guarantees

Postgres with default `fsync=on` and `synchronous_commit=on` provides full
durability: a committed row survives a server crash. For read replicas used
in readiness probes, be aware of replication lag — readiness checks query
`chain_cursors` which may be stale on a replica.

### WAL note

Postgres has its own WAL (Write-Ahead Log) for crash recovery — this is
distinct from SQLite WAL mode and is always active. No coordinator-specific
configuration is required.

---

## Migration system

Both backends use the same migration tracking table (`schema_migrations`).
The canonical migration sequence is defined in `coordinator/src/persistence/db.ts`
as `SQLITE_MIGRATIONS` and `POSTGRES_MIGRATION_FILES`. On startup,
`validateSchemaVersion` checks:

1. The `schema_migrations` table is readable.
2. No expected migrations are missing.
3. No unexpected extra migrations are present.
4. Migrations are recorded in the correct numeric-prefix order.
5. The latest applied migration matches `CURRENT_SCHEMA_VERSION`.

Any mismatch throws a `FatalStartupError` and **the startup retry loop
short-circuits immediately** — schema mismatches are never fixed by retrying.
Run the pending migrations then restart the coordinator.

See [migrations.md](./migrations.md) for the migration runbook and
[migration-strategy.md](./migration-strategy.md) for rollback guidance.

---

## Summary of guarantees

| Property | SQLite (WAL) | PostgreSQL |
|---|---|---|
| Crash-safe writes | Yes (WAL rollback) | Yes (fsync=on) |
| Concurrent readers | Yes (non-blocking) | Yes |
| Single writer at a time | Yes (OS-level lock) | No (MVCC) |
| TOCTOU-safe multi-stmt | No (autocommit) | No (autocommit, use explicit txn) |
| Foreign key enforcement | Yes (pragma required) | Yes (always) |
| Network filesystem support | No (WAL unsupported) | Yes |
| Node.js version requirement | ≥ 22.5 | Any (uses `pg`) |
