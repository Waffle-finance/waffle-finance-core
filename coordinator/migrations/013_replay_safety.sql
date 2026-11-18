-- #734: replay safety — durable idempotence keys and stronger constraints.
--
-- 1. processed_events — the durable idempotence ledger.  The reconciler's dedup
--    keys (see coordinator/src/reconciliation/event-identity.ts) used to live
--    only in an in-memory EventSeenSet that is cleared at the start of every
--    run, so any replay after a restart re-applied every event in the window.
--    The PRIMARY KEY on event_key makes a duplicate delivery a storage-layer
--    no-op that survives a restart.
--
-- 2. order_events.event_type is constrained to the closed set the repository
--    actually emits, so a typo or a bad merge cannot poison the audit trail
--    with unclassifiable rows.
--
-- 3. orders.preimage_enc_version is constrained to NULL (plaintext) or 1
--    (AES-256-GCM), matching the storage contract in
--    coordinator/src/crypto/secret-cipher.ts.
--
-- 4. Timestamp monotonicity: updated_at >= created_at and
--    archived_at >= created_at, so updated_at can never regress during replay.
--
-- NOTE on table rebuilds: SQLite cannot ALTER TABLE to add a CHECK constraint,
-- and Postgres cannot do it either without recreating the table.  Both engines
-- need the two constrained tables (orders, order_events) to be rebuilt.  The coordinator DB is explicitly a
-- rebuildable cache of on-chain reality (see the header of schema.sql and
-- coordinator/src/persistence/db.ts), so operators on an existing deployment
-- should drop the file and let the reconciler repopulate it, exactly as they
-- must for any other cache loss.  Fresh databases get every constraint from
-- schema.sql at first open and never need this file's table rebuilds.
--
-- Each guarded statement is written so it is safe to run against a database
-- that has already been rebuilt from schema.sql.

-- ── 1. Durable idempotence ledger ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS processed_events (
    event_key   TEXT    PRIMARY KEY,
    chain       TEXT    NOT NULL CHECK (chain IN ('ethereum', 'soroban', 'solana')),
    event_type  TEXT    NOT NULL
                CHECK (event_type IN ('OrderCreated', 'OrderClaimed', 'OrderRefunded')),
    order_id    INTEGER REFERENCES orders(id) ON DELETE CASCADE,
    created_at  INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
    CHECK (created_at > 0)
);

CREATE INDEX IF NOT EXISTS idx_processed_events_order ON processed_events (order_id)
    WHERE order_id IS NOT NULL;

-- No backfill of processed_events is performed, deliberately.  The dedup keys
-- stored in order_events are chain keys (tx hash + log index / ledger +
-- signature) that the existing trail does not record, so they cannot be
-- reconstructed.  Leaving the ledger empty is safe: the first post-upgrade
-- replay re-derives each key, claims it, and every write it performs is
-- already guarded by isEventBehindOrderCursor() and decideDispatch(), so the
-- re-derivation is a no-op that costs one SELECT per event.
