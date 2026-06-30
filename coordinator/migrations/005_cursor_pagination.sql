-- Migration: 005_cursor_pagination
-- Adds optimized indexes for cursor-based pagination on order history lookups.
-- Ensures stable sorting and efficient range queries for paginated results.

-- Composite index for cursor-based pagination: (created_at DESC, id DESC)
-- This ensures stable ordering and efficient cursor boundary queries.
-- The existing address-specific indexes remain for address filtering.
CREATE INDEX IF NOT EXISTS idx_orders_cursor_pagination ON orders (created_at DESC, id DESC);

-- Address-specific cursor indexes for direct cursor queries
-- These optimize WHERE (src_address = ? OR dst_address = ?) AND cursor conditions
CREATE INDEX IF NOT EXISTS idx_orders_src_cursor ON orders (src_address, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_orders_dst_cursor ON orders (dst_address, created_at DESC, id DESC);