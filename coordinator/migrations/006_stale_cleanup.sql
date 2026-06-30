-- Adds archived_at to orders for soft-delete of stale announced records.
-- NULL means the order is live; a unix timestamp means it has been archived.
ALTER TABLE orders ADD COLUMN archived_at INTEGER;
