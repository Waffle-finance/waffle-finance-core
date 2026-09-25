-- Migration: 011_order_ledger_cursors (Postgres)
-- See 011_order_ledger_cursors.sql for rationale and rollback plan.

ALTER TABLE orders ADD COLUMN IF NOT EXISTS last_eth_block BIGINT DEFAULT NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS last_soroban_ledger BIGINT DEFAULT NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS last_solana_slot BIGINT DEFAULT NULL;

UPDATE orders
SET last_eth_block = GREATEST(
  COALESCE(CASE WHEN src_chain = 'ethereum' THEN src_lock_block END, 0),
  COALESCE(CASE WHEN dst_chain = 'ethereum' THEN dst_lock_block END, 0)
)
WHERE (src_chain = 'ethereum' OR dst_chain = 'ethereum')
  AND last_eth_block IS NULL
  AND GREATEST(
    COALESCE(CASE WHEN src_chain = 'ethereum' THEN src_lock_block END, 0),
    COALESCE(CASE WHEN dst_chain = 'ethereum' THEN dst_lock_block END, 0)
  ) > 0;

UPDATE orders
SET last_soroban_ledger = GREATEST(
  COALESCE(CASE WHEN src_chain = 'stellar' THEN src_lock_block END, 0),
  COALESCE(CASE WHEN dst_chain = 'stellar' THEN dst_lock_block END, 0)
)
WHERE (src_chain = 'stellar' OR dst_chain = 'stellar')
  AND last_soroban_ledger IS NULL
  AND GREATEST(
    COALESCE(CASE WHEN src_chain = 'stellar' THEN src_lock_block END, 0),
    COALESCE(CASE WHEN dst_chain = 'stellar' THEN dst_lock_block END, 0)
  ) > 0;

CREATE INDEX IF NOT EXISTS idx_orders_last_eth_block
  ON orders (last_eth_block)
  WHERE last_eth_block IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_orders_last_soroban_ledger
  ON orders (last_soroban_ledger)
  WHERE last_soroban_ledger IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_orders_last_solana_slot
  ON orders (last_solana_slot)
  WHERE last_solana_slot IS NOT NULL;
