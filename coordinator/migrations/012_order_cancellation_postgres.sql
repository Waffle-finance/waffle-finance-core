-- Adds cancellation_reason to record why an order transitioned to
-- 'cancelled' (operator/user-triggered) or 'abandoned' (stale cleanup).
ALTER TABLE orders ADD COLUMN cancellation_reason TEXT;
