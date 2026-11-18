-- Migration: 013_backlog_indexes
-- Adds missing indexes for replay/recovery queries and the phase-ratio gauge.
--
-- Gap 1 — order_events replay queries
--   SELECT * FROM order_events WHERE event_type = ? ORDER BY created_at ASC
--   The existing idx_order_events_order (order_id, created_at) does not help
--   event_type filters; a dedicated composite index enables the event replay and
--   recovery scan paths to seek directly without a full-table scan.
--
-- Gap 2 — direction+status counts for refreshPhaseRatios
--   SELECT COUNT(*) FROM orders WHERE direction = ? AND status = ?
--   Currently forces a status-filtered scan even when combined with
--   idx_orders_status. A covering partial index on (direction, status) for
--   non-archived rows eliminates the scan entirely.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Covering index on order_events for event-type replay queries
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_order_events_type_time
  ON order_events (event_type, created_at ASC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Partial covering index on orders for direction+status gauge refresh
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_orders_direction_status
  ON orders (direction, status)
  WHERE archived_at IS NULL;
