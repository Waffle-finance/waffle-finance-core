/**
 * @file schema-types.ts
 *
 * Kysely database schema type definitions for the WaffleFinance coordinator.
 *
 * Each interface maps 1-to-1 to a coordinator database table.
 * Column names use snake_case (matching the real column names) so Kysely's
 * query builder generates valid SQL without any camelCase→snake_case transform.
 *
 * The `Database` type exported at the bottom is the root type passed to
 * `Kysely<Database>` — it maps table names to their row types.
 *
 * Nullable columns that the DB stores as NULL are typed `string | null`,
 * `number | null`, etc.  `Generated<T>` marks columns that the database
 * auto-populates (AUTOINCREMENT PKs, DEFAULT expressions) so Kysely knows
 * they are optional in INSERT statements.
 */

import type { Generated, ColumnType } from 'kysely';

// ─── orders ──────────────────────────────────────────────────────────────────

export type OrderStatus =
  | 'announced'
  | 'src_locked'
  | 'dst_locked'
  | 'secret_revealed'
  | 'completed'
  | 'refunded'
  | 'failed'
  | 'expired';

export type Chain = 'ethereum' | 'stellar' | 'solana';
export type Direction = 'eth_to_xlm' | 'xlm_to_eth' | 'eth_to_sol' | 'sol_to_eth';

export interface OrdersTable {
  id: Generated<number>;
  public_id: string;
  direction: Direction;
  status: OrderStatus;
  hashlock: string;
  src_chain: Chain;
  src_address: string;
  src_asset: string;
  src_amount: string;
  src_safety_deposit: string;
  src_order_id: string | null;
  src_lock_tx: string | null;
  src_lock_block: number | null;
  src_timelock: number | null;
  dst_chain: Chain;
  dst_address: string;
  dst_asset: string;
  dst_amount: string;
  dst_order_id: string | null;
  dst_lock_tx: string | null;
  dst_lock_block: number | null;
  dst_timelock: number | null;
  preimage: string | null;
  preimage_enc_version: number | null;
  secret_revealed_tx: string | null;
  resolver_address: string | null;
  last_eth_block: number | null;
  last_soroban_ledger: number | null;
  last_solana_slot: number | null;
  /** unix seconds — auto-set by DEFAULT CURRENT_TIMESTAMP or AUTOINCREMENT hook */
  created_at: ColumnType<number, never, never>;
  updated_at: ColumnType<number, never, number>;
  archived_at: number | null;
}

// ─── order_events ────────────────────────────────────────────────────────────

export interface OrderEventsTable {
  id: Generated<number>;
  order_id: number;
  event_type: string;
  payload_json: string;
  created_at: ColumnType<number, never, never>;
}

// ─── secrets ─────────────────────────────────────────────────────────────────

export interface SecretsTable {
  id: Generated<number>;
  order_public_id: string;
  preimage_enc: string;
  enc_version: number;
  created_at: ColumnType<number, never, never>;
}

// ─── audit_log ───────────────────────────────────────────────────────────────

export interface AuditLogTable {
  id: Generated<number>;
  schema_version: number;
  event_type: string;
  order_id: string | null;
  request_id: string | null;
  payload_json: string;
  created_at: ColumnType<number, never, never>;
}

// ─── schema_migrations ───────────────────────────────────────────────────────

export interface SchemaMigrationsTable {
  migration: string;
  applied_at: number;
  duration_ms: number;
}

// ─── chain_cursors ───────────────────────────────────────────────────────────

export interface ChainCursorsTable {
  chain: Chain;
  position: number;
  updated_at: ColumnType<number, number, number>;
}

// ─── soroban_checkpoints ─────────────────────────────────────────────────────

export type SorobanRecoveryMarker = 'clean' | 'pending_replay' | 'recovering';

export interface SorobanCheckpointsTable {
  contract_id: string;
  last_safe_ledger: number;
  effective_cursor: string | null;
  recovery_marker: SorobanRecoveryMarker;
  updated_at: ColumnType<number, number, number>;
}

// ─── Root schema type ─────────────────────────────────────────────────────────

/**
 * Root Kysely database schema.
 * Pass this as the generic parameter: `Kysely<CoordinatorDatabase>`.
 */
export interface CoordinatorDatabase {
  orders: OrdersTable;
  order_events: OrderEventsTable;
  secrets: SecretsTable;
  audit_log: AuditLogTable;
  schema_migrations: SchemaMigrationsTable;
  chain_cursors: ChainCursorsTable;
  soroban_checkpoints: SorobanCheckpointsTable;
}
