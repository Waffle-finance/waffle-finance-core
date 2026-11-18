-- #734: replay safety — durable idempotence keys and stronger constraints.
-- Postgres counterpart of 013_replay_safety.sql.  The DDL differs from the
-- SQLite file only where the engines differ: SQLite cannot add a CHECK to an
-- existing table without a rebuild, so the Postgres variant uses idempotent
-- ADD CONSTRAINT guarded by a pg_constraint lookup instead.
--
-- See 013_replay_safety.sql for the full rationale, including why the two
-- constrained tables (orders, order_events) require a rebuild on an existing
-- deployment rather than an in-place ALTER.

-- ── 1. Durable idempotence ledger ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS processed_events (
    event_key   TEXT        PRIMARY KEY,
    chain       TEXT        NOT NULL CHECK (chain IN ('ethereum', 'soroban', 'solana')),
    event_type  TEXT        NOT NULL
                CHECK (event_type IN ('OrderCreated', 'OrderClaimed', 'OrderRefunded')),
    order_id    BIGINT      REFERENCES orders(id) ON DELETE CASCADE,
    created_at  BIGINT      NOT NULL DEFAULT (CAST(EXTRACT(EPOCH FROM NOW()) AS BIGINT)),
    CHECK (created_at > 0)
);

CREATE INDEX IF NOT EXISTS idx_processed_events_order ON processed_events (order_id)
    WHERE order_id IS NOT NULL;

-- ── 2. order_events.event_type must belong to the closed emitted set ─────────
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'order_events_event_type_check'
    ) THEN
        ALTER TABLE order_events ADD CONSTRAINT order_events_event_type_check
            CHECK (event_type IN (
                'status.transitioned',  'status.no_op',
                'src_lock.transitioned',  'src_lock.no_op',
                'dst_lock.transitioned',  'dst_lock.no_op',
                'secret_revealed.transitioned', 'secret_revealed.no_op',
                'cancel.transitioned',    'cancel.no_op',
                'abandon.transitioned',   'abandon.no_op',
                'src_lock.rolled_back',   'dst_lock.rolled_back'
            ));
    END IF;
END
$$;

-- ── 3. preimage_enc_version is NULL (plaintext) or 1 (AES-256-GCM) ──────────
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'orders_preimage_enc_version_check'
    ) THEN
        ALTER TABLE orders ADD CONSTRAINT orders_preimage_enc_version_check
            CHECK (preimage_enc_version IS NULL OR preimage_enc_version = 1);
    END IF;
END
$$;

-- ── 4. Timestamps may not regress ───────────────────────────────────────────
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'orders_timestamps_monotonic'
    ) THEN
        ALTER TABLE orders ADD CONSTRAINT orders_timestamps_monotonic
            CHECK (created_at > 0
               AND updated_at >= created_at
               AND (archived_at IS NULL OR archived_at >= created_at));
    END IF;
END
$$;
