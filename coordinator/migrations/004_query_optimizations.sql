-- Migration: 004_query_optimizations
-- Adds optimized indexes for order history lookups and public_id searches.

-- Composite indexes for address-based history queries. 
-- These optimize queries that filter by address and order by creation time.
CREATE INDEX IF NOT EXISTS idx_orders_src_address_created_at ON orders (src_address, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_dst_address_created_at ON orders (dst_address, created_at DESC);

-- Index on created_at alone for general history sorting.
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders (created_at DESC);

-- Explicit index for public_id to ensure fast lookups (though it is already UNIQUE).
CREATE INDEX IF NOT EXISTS idx_orders_public_id ON orders (public_id);
