-- Migration: 013_backlog_indexes_postgres
-- PostgreSQL variant — identical DDL to 013_backlog_indexes.sql.
--
-- Both CREATE INDEX statements use standard SQL; no Postgres-specific syntax
-- is required.  The partial index WHERE clause is supported identically in
-- both SQLite (>= 3.8.9) and PostgreSQL.

CREATE INDEX IF NOT EXISTS idx_order_events_type_time
  ON order_events (event_type, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_orders_direction_status
  ON orders (direction, status)
  WHERE archived_at IS NULL;
