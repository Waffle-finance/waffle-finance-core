# Coordinator Schema Contract

This document is the single source of truth for what the coordinator's
persistence schema is *supposed to look like* — every table, column, index,
and constraint that a contributor can rely on being present, on both SQLite
and PostgreSQL, once the coordinator has finished applying migrations.

It complements [`migration-strategy.md`](./migration-strategy.md), which
covers *process* (how to author, deploy, and roll back a migration). This
document covers *shape*: the contract those migrations must converge on.

If code in `coordinator/src/persistence/` or `coordinator/src/audit/` assumes
a column, index, or constraint that isn't listed here, either the code is
wrong or this document is stale — treat the mismatch as a bug.

---

## Sources of truth, and how they relate

There are three places the schema is expressed, and they must always agree:

1. **`coordinator/migrations/*.sql`** — the ordered, incremental history.
   This is what an *upgrading* Postgres database replays, one file at a time.
2. **`coordinator/src/persistence/schema.sql`** — the canonical, merged
   snapshot. This is what a *fresh* SQLite database gets in one shot
   (`CREATE TABLE/INDEX IF NOT EXISTS`), plus a short list of
   `incrementalAlters` in `db.ts` for columns added after the table was
   first created.
3. **This document** — the human-readable contract derived from both.

`schema.sql` is hand-maintained, not generated from the migrations
directory, so it can drift silently (see the [Testing](#testing-the-contract)
section for the regression test that now guards against this — a cursor-
pagination index set was previously missing from `schema.sql` despite being
recorded as applied; see `coordinator/migrations/005_cursor_pagination.sql`).
Whenever you touch one of the three, touch all three.

---

## Tables

### `orders`

The central table: one row per cross-chain swap order.

| Column                 | Type (SQLite / Postgres)   | Nullable | Notes                                                                 |
|-------------------------|-----------------------------|----------|------------------------------------------------------------------------|
| `id`                    | `INTEGER` / `BIGSERIAL`     | no       | Internal primary key. Never exposed to clients.                       |
| `public_id`              | `TEXT`                      | no       | `UNIQUE`. Client-facing id, `wf_0x<64 hex>` shaped.                   |
| `direction`              | `TEXT`                      | no       | `CHECK IN ('eth_to_xlm','xlm_to_eth','eth_to_sol','sol_to_eth')`.      |
| `status`                 | `TEXT`                      | no       | `CHECK IN ('announced','src_locked','dst_locked','secret_revealed','completed','refunded','failed','expired')`. Mirrors `state-machine/order-machine.ts`. |
| `hashlock`               | `TEXT`                       | no       | 0x-prefixed 32-byte hex. Cross-chain link.                            |
| `src_chain` / `dst_chain`| `TEXT`                       | no       | `CHECK IN ('ethereum','stellar','solana')`.                           |
| `src_address` / `dst_address` | `TEXT`                  | no       | User address on that chain.                                           |
| `src_asset` / `dst_asset`| `TEXT`                       | no       | `"native"` or a contract/asset id.                                    |
| `src_amount` / `dst_amount` | `TEXT`                    | no       | Decimal string, atomic units. Never stored as a numeric type.         |
| `src_safety_deposit`     | `TEXT`                       | no       | Decimal string.                                                       |
| `src_order_id` / `dst_order_id` | `TEXT`                | yes      | On-chain order id, set once locked.                                   |
| `src_lock_tx` / `dst_lock_tx` | `TEXT`                  | yes      |                                                                          |
| `src_lock_block` / `dst_lock_block` | `INTEGER`          | yes      |                                                                          |
| `src_timelock` / `dst_timelock` | `INTEGER`              | yes      | Unix seconds, absolute.                                                |
| `preimage`               | `TEXT`                       | yes      | NULL until revealed. May be an AES-256-GCM blob — see `preimage_enc_version`. |
| `preimage_enc_version`   | `INTEGER`                    | yes      | `NULL` = plaintext/legacy, `1` = AES-256-GCM (`crypto/secret-cipher.ts`). Added by `003_secret_encryption.sql`. |
| `secret_revealed_tx`     | `TEXT`                       | yes      |                                                                          |
| `resolver_address`       | `TEXT`                       | yes      | Resolver that filled the destination side.                            |
| `created_at` / `updated_at` | `INTEGER` / `INTEGER`     | no       | Unix seconds, DB-assigned default (`strftime`/`EXTRACT(EPOCH …)`).     |
| `archived_at`            | `INTEGER` / `BIGINT`         | yes      | Soft-delete timestamp. `NULL` = live. Added by `006_stale_cleanup.sql`. Note the intentional `INTEGER` vs `BIGINT` divergence — SQLite's `INTEGER` is already 64-bit; Postgres's is 32-bit. |

Indexes: `idx_orders_hashlock`, `idx_orders_src_address`, `idx_orders_dst_address`,
`idx_orders_status`, `idx_orders_src_order_id (src_chain, src_order_id)`,
`idx_orders_dst_order_id (dst_chain, dst_order_id)`, `idx_orders_public_id`,
`idx_orders_created_at (created_at DESC)`,
`idx_orders_src_address_created_at (src_address, created_at DESC)`,
`idx_orders_dst_address_created_at (dst_address, created_at DESC)`,
`idx_orders_cursor_pagination (created_at DESC, id DESC)`,
`idx_orders_src_cursor (src_address, created_at DESC, id DESC)`,
`idx_orders_dst_cursor (dst_address, created_at DESC, id DESC)`.

### `order_events`

Append-mostly log of raw chain events tied to an order.

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `INTEGER` / `BIGSERIAL` | no | |
| `order_id` | `INTEGER` / `BIGINT` | no | `REFERENCES orders(id) ON DELETE CASCADE`. |
| `event_type` | `TEXT` | no | |
| `payload_json` | `TEXT` | no | |
| `created_at` | `INTEGER` | no | DB-assigned default. |

Index: `idx_order_events_order (order_id, created_at)`.

### `resolver_heartbeats`

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `address` | `TEXT` | no | `PRIMARY KEY`. |
| `chain` | `TEXT` | no | `CHECK IN ('ethereum','stellar')`. **Not** extended for `solana` — resolver heartbeats are not yet tracked per-chain for Solana; extending this CHECK is a normal additive migration when that support lands. |
| `last_seen` | `INTEGER` | no | Unix seconds. |

### `schema_migrations`

The migration-tracking table itself. See `migration-strategy.md` for how it's
populated. Its own DDL is intentionally duplicated in `001`-era bootstrap code
paths and `005_schema_migrations.sql`; both are `CREATE TABLE IF NOT EXISTS`
and therefore safe to run more than once.

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `migration` | `TEXT` | no | `PRIMARY KEY`. The file name, e.g. `007_audit_log.sql`. |
| `applied_at` | `BIGINT` | no | Unix seconds. |
| `duration_ms` | `BIGINT` | no | `0` for SQLite (applied atomically); wall-clock time for Postgres. |

### `audit_log`

Durable, **append-only** record of order lifecycle transitions and recovery
actions (`coordinator/src/audit/audit-log.ts` owns the typed payload
contract; `AUDIT_SCHEMA_VERSION` there must match the row's `schema_version`
semantics described below). Added by `007_audit_log.sql`.

| Column | Type (SQLite / Postgres) | Nullable | Notes |
|---|---|---|---|
| `id` | `INTEGER PRIMARY KEY AUTOINCREMENT` / `BIGSERIAL` | no | |
| `schema_version` | `INTEGER` | no | Default `1`. Bump `AUDIT_SCHEMA_VERSION` in `audit-log.ts` and this default together when the payload shape changes in a breaking way. |
| `event_type` | `TEXT` | no | One of `AuditEventType` (`audit-log.ts`). |
| `order_id` | `TEXT` | yes | Correlation anchor — **not** a foreign key. Deliberately loose so audit rows outlive an archived or hard-deleted order. |
| `request_id` | `TEXT` | yes | Correlation anchor for non-order (system/reconciliation) events. |
| `payload_json` | `TEXT` | no | Serialized `AuditPayload`. |
| `created_at` | `INTEGER` | no | DB-assigned default. |

Indexes: `idx_audit_log_order_id (order_id, id ASC) WHERE order_id IS NOT NULL`,
`idx_audit_log_id_asc (id ASC)` (replay-from-cursor),
`idx_audit_log_event_type (event_type, created_at DESC)`,
`idx_audit_log_created_at (created_at DESC)`.

**Rows in `audit_log` are never updated or deleted.** Any code path that
issues `UPDATE audit_log` or `DELETE FROM audit_log` violates the contract —
flag it in review.

### `soroban_checkpoints`

Durable checkpoint for the Soroban event listener's replay-recovery subsystem
(`coordinator/src/listeners/soroban-listener.ts`). Lets ingestion resume from
the last safe ledger after a restart, redeploy, or temporary RPC inconsistency
without reprocessing from scratch or skipping a missed range. Added by
`010_soroban_checkpoints.sql`. The DB remains a cache — a lost checkpoint only
costs a wider reconciler backfill, never correctness.

| Column | Type (SQLite / Postgres) | Nullable | Notes |
|---|---|---|---|
| `contract_id` | `TEXT` | no | `PRIMARY KEY`. Keyed per HTLC contract, so re-pointing the coordinator at a new contract starts from a clean checkpoint. |
| `last_safe_ledger` | `INTEGER` / `BIGINT` | no | Highest ledger fully processed; the safe resume point. **Advances forward only** — a stale-cursor reset or replay never rewinds it. Default `0`. |
| `effective_cursor` | `TEXT` | yes | Opaque Soroban RPC pagination cursor, or `NULL` after a reset / fresh start. |
| `recovery_marker` | `TEXT` | no | `CHECK IN ('clean','pending_replay','recovering')`, default `'clean'`. Drives replay on the next poll/restart; `'recovering'` is crash-safe (a mid-replay crash re-runs on next start). |
| `updated_at` | `INTEGER` | no | Unix seconds; DB-assigned default. |

The forward-only invariant on `last_safe_ledger` is enforced in SQL (a portable
`CASE` in the upsert), so a late or out-of-order write can never regress the
resume point.

---

## Cross-cutting rules

These rules bind every future migration, not just the tables above.

### Additive changes — always allowed

New tables, new nullable columns, new indexes, and new CHECK values (widening
an existing `IN (...)` constraint) are additive and require no special review
beyond the standard idempotency checklist in `migration-strategy.md`. Prefer
additive changes whenever the requirement can be satisfied by one.

### Dropping or renaming columns — never allowed in place

Never `DROP COLUMN` or `RENAME COLUMN` on a table with production data. Both
break `validateSchemaVersion()`'s implicit assumption that older rows remain
readable by both the previous and next coordinator binary during a rolling
deploy. Instead:

1. Add the new column alongside the old one (additive).
2. Migrate/backfill data into the new column (see below).
3. Update `orders-repo.ts` / `audit-repo.ts` to stop reading the old column.
4. Leave the old column in place, unused, for at least one full deploy cycle
   before considering a follow-up migration to drop it — and only drop it
   once no rolled-back binary can still be running against the database.

### Backfills

A backfill (populating a new/changed column for existing rows) is allowed
only when:

- It runs inside the same transaction as the migration that adds the column
  (Postgres), or as part of the `incrementalAlters` step (SQLite) — never as
  an ad hoc one-off script run by hand against production.
- It is idempotent — re-running it must not double-apply or corrupt values.
- It does not require reading on-chain state synchronously during startup.
  The coordinator's DB is a cache of on-chain state (see `schema.sql`'s
  header comment); if a backfill needs on-chain data, do it as a background
  reconciliation job (see `reconciliation/`), not inline in the migration.

### Soft-deletes

`archived_at` on `orders` is the model soft-delete: a nullable timestamp
column, `NULL` meaning "live," queried via `WHERE archived_at IS NULL` /
`IS NOT NULL`, never a hard `DELETE`. Any future soft-delete need (e.g. on
another table) should follow this exact shape — a nullable `*_at` timestamp,
not a boolean flag — so "when was it removed" is always answerable from the
row itself. `audit_log` is the one table where soft-delete does not apply:
it has no delete path at all, soft or hard.

### Constraints

- `CHECK` constraints enumerate closed sets (`direction`, `status`,
  `src_chain`/`dst_chain`, `resolver_heartbeats.chain`). Widening a `CHECK`
  to add a new value is additive; narrowing one (removing a value that rows
  may still hold) is a breaking change and needs a backfill/migration path
  for existing rows first.
- Foreign keys are used only where the referenced row's lifecycle strictly
  bounds the referencing row's (`order_events.order_id → orders.id ON DELETE
  CASCADE`). Correlation-only relationships (`audit_log.order_id`) are
  intentionally plain columns, not foreign keys, so that archiving or
  removing an order can never silently delete its audit trail.

---

## Testing the contract

`coordinator/test/db-migrations.test.ts` validates the migration *history*
(every expected migration recorded, in order, matching `CURRENT_SCHEMA_VERSION`).
`coordinator/test/schema-contract.test.ts` validates the *shape* described in
this document directly against a freshly opened SQLite database — table and
column presence, nullability, and index names — so a change to `schema.sql`
that silently drops or renames something is caught the same way a change to
the migration registry is. When you add a column, index, or table, update
both this document and that test in the same change.

Run both:

```bash
# From the coordinator directory
npm test -- --reporter=verbose coordinator/test/db-migrations.test.ts coordinator/test/schema-contract.test.ts
```
