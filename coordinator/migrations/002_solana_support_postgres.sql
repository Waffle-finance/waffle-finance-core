-- Migration: 002_solana_support (PostgreSQL version)
-- Extends direction, src_chain, and dst_chain CHECK constraints to include Solana.
--
-- PostgreSQL supports ALTER TABLE ... DROP CONSTRAINT and ADD CONSTRAINT,
-- so we can update the constraints directly without recreating tables.

-- Drop existing CHECK constraints
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_direction_check;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_src_chain_check;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_dst_chain_check;

-- Add updated CHECK constraints with Solana support
ALTER TABLE orders ADD CONSTRAINT orders_direction_check 
  CHECK (direction IN ('eth_to_xlm', 'xlm_to_eth', 'eth_to_sol', 'sol_to_eth'));

ALTER TABLE orders ADD CONSTRAINT orders_src_chain_check 
  CHECK (src_chain IN ('ethereum', 'stellar', 'solana'));

ALTER TABLE orders ADD CONSTRAINT orders_dst_chain_check 
  CHECK (dst_chain IN ('ethereum', 'stellar', 'solana'));
