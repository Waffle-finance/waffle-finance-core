-- Migration: Add richer history metadata fields (SQLite)
ALTER TABLE orders ADD COLUMN lifecycle_phase TEXT DEFAULT 'announced';
ALTER TABLE orders ADD COLUMN last_updated_timestamp INTEGER;
ALTER TABLE orders ADD COLUMN error_state TEXT;
ALTER TABLE orders ADD COLUMN correlation_id TEXT;

-- Backfill existing orders
UPDATE orders SET 
  lifecycle_phase = status, 
  last_updated_timestamp = updated_at 
WHERE lifecycle_phase IS NULL OR last_updated_timestamp IS NULL;
