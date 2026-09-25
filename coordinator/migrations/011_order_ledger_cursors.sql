-- Migration: 011_order_ledger_cursors
-- Adds per-order ledger high-water marks so the reconciler can process events
-- incrementally instead of re-scanning a fixed 48-hour lookback every cycle.
--
-- Columns:
--   last_eth_block       highest Ethereum block whose events were fully
--                        processed for this order (forward-only).
--   last_soroban_ledger  highest Soroban/Stellar ledger sequence processed.
--   last_solana_slot     highest Solana slot processed.
--
-- NULL means "never reconciled incrementally for this chain" — the reconciler
-- falls back to the chain-level cursor / lookback window on first pass.
--
-- Rollback plan (Postgres):
--   ALTER TABLE orders DROP COLUMN IF EXISTS last_eth_block;
--   ALTER TABLE orders DROP COLUMN IF EXISTS last_soroban_ledger;
--   ALTER TABLE orders DROP COLUMN IF EXISTS last_solana_slot;
--   DELETE FROM schema_migrations WHERE migration = '011_order_ledger_cursors.sql';
--
-- Rollback plan (SQLite — requires table rebuild; run only if necessary):
--   1. CREATE TABLE orders_backup AS SELECT <columns without cursor cols> FROM orders;
--   2. DROP TABLE orders; recreate from 010-era schema; copy data back.
--   3. DELETE FROM schema_migrations WHERE migration = '011_order_ledger_cursors.sql';
--   Prefer restoring from backup rather than manual rebuild in production.

ALTER TABLE orders ADD COLUMN last_eth_block INTEGER DEFAULT NULL;
ALTER TABLE orders ADD COLUMN last_soroban_ledger INTEGER DEFAULT NULL;
ALTER TABLE orders ADD COLUMN last_solana_slot INTEGER DEFAULT NULL;

-- Backfill from existing on-chain lock positions so cursors start at the
-- highest block/ledger we already know about per order.
UPDATE orders
SET last_eth_block = CASE
  WHEN COALESCE(CASE WHEN src_chain = 'ethereum' THEN src_lock_block END, 0)
       >= COALESCE(CASE WHEN dst_chain = 'ethereum' THEN dst_lock_block END, 0)
  THEN NULLIF(COALESCE(CASE WHEN src_chain = 'ethereum' THEN src_lock_block END, 0), 0)
  ELSE NULLIF(COALESCE(CASE WHEN dst_chain = 'ethereum' THEN dst_lock_block END, 0), 0)
END
WHERE (src_chain = 'ethereum' OR dst_chain = 'ethereum')
  AND last_eth_block IS NULL;

UPDATE orders
SET last_soroban_ledger = CASE
  WHEN COALESCE(CASE WHEN src_chain = 'stellar' THEN src_lock_block END, 0)
       >= COALESCE(CASE WHEN dst_chain = 'stellar' THEN dst_lock_block END, 0)
  THEN NULLIF(COALESCE(CASE WHEN src_chain = 'stellar' THEN src_lock_block END, 0), 0)
  ELSE NULLIF(COALESCE(CASE WHEN dst_chain = 'stellar' THEN dst_lock_block END, 0), 0)
END
WHERE (src_chain = 'stellar' OR dst_chain = 'stellar')
  AND last_soroban_ledger IS NULL;

-- Solana lock blocks are not always populated; leave last_solana_slot NULL
-- until the reconciler processes Solana events for the order.

CREATE INDEX IF NOT EXISTS idx_orders_last_eth_block
  ON orders (last_eth_block)
  WHERE last_eth_block IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_orders_last_soroban_ledger
  ON orders (last_soroban_ledger)
  WHERE last_soroban_ledger IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_orders_last_solana_slot
  ON orders (last_solana_slot)
  WHERE last_solana_slot IS NOT NULL;
