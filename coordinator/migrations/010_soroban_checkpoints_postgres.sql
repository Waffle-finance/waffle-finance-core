-- Migration: 010_soroban_checkpoints (Postgres)
-- Durable checkpoint record for the Soroban event listener.  See the SQLite
-- variant (010_soroban_checkpoints.sql) for the full column documentation.
--
-- `last_safe_ledger` is BIGINT here because Stellar ledger sequences can grow
-- past the 32-bit range over the lifetime of the network.
CREATE TABLE IF NOT EXISTS soroban_checkpoints (
    contract_id      TEXT    PRIMARY KEY,
    last_safe_ledger BIGINT  NOT NULL DEFAULT 0,
    effective_cursor TEXT,
    recovery_marker  TEXT    NOT NULL DEFAULT 'clean'
                     CHECK (recovery_marker IN ('clean', 'pending_replay', 'recovering')),
    updated_at       INTEGER NOT NULL DEFAULT 0
);
