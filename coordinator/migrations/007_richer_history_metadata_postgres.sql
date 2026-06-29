-- Migration: Add richer history metadata fields (Postgres)
ALTER TABLE orders ADD COLUMN IF NOT EXISTS lifecycle_phase TEXT DEFAULT 'announced';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS last_updated_timestamp BIGINT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS error_state TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS correlation_id TEXT;

-- Backfill existing orders
UPDATE orders SET 
  lifecycle_phase = status, 
  last_updated_timestamp = updated_at 
WHERE lifecycle_phase IS NULL OR last_updated_timestamp IS NULL;
