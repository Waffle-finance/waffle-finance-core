export { openDatabase } from './db.js';
export { OrdersRepository } from './orders-repo.js';
export type {
  OrderRow,
  OrderStatus,
  Chain,
  Direction,
  AnnounceOrderInput,
  SorobanCheckpoint,
  SorobanRecoveryMarker,
} from './orders-repo.js';

// ── Kysely ORM exports (issue #479) ──────────────────────────────────────────
export { createKyselyDb, KyselyMigrationRunner } from './kysely-db.js';
export { KyselyOrdersRepository } from './orders-repo-kysely.js';
export type { CoordinatorDatabase, KyselyCoordinatorDb } from './schema-types.js';
