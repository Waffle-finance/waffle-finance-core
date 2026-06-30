-- Migration: 006_stale_cleanup (PostgreSQL version)
-- Adds archived_at to orders for soft-delete of stale announced records.
-- NULL means the order is live; a unix timestamp means it has been archived.
-- Uses BIGINT to match PostgreSQL conventions for unix timestamps.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS archived_at BIGINT;
