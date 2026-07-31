import type { Database } from "./db.js";
import { canTransition, isTerminal } from "../state-machine/order-machine.js";
import { dbQueryDuration, orderTransitionEventsTotal } from "../metrics.js";
import { InMemoryRepositoryTransaction, type RepositoryTransaction } from "./transaction-contract.js";

type DatabaseT = Database;
type Statement = ReturnType<DatabaseT["prepare"]>;
type StatementResult = { changes: number; lastInsertRowid: number };
type AsyncCapableStatement = Statement & {
  runAsync?: (...params: any[]) => Promise<StatementResult>;
  getAsync?: (...params: any[]) => Promise<unknown>;
  allAsync?: (...params: any[]) => Promise<unknown[]>;
};

function orderIdFromHashlock(hashlock: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hashlock)) {
    throw new Error("hashlock must be 0x + 64 hex chars");
  }
  return `wf_${hashlock.toLowerCase()}`;
}

export type OrderStatus =
  | "announced"
  | "src_locked"
  | "dst_locked"
  | "secret_revealed"
  | "completed"
  | "refunded"
  | "failed"
  | "expired";

export type Chain = "ethereum" | "stellar" | "solana";
export type Direction = "eth_to_xlm" | "xlm_to_eth" | "eth_to_sol" | "sol_to_eth";

/**
 * Ingestion-health flag for the durable Soroban listener checkpoint.
 *
 *  - `clean`          steady state; the listener can resume straight from the
 *                     persisted cursor.
 *  - `pending_replay` a gap / stale cursor / restart was observed; a bounded
 *                     replay of the missed ledger range is owed before the
 *                     listener returns to the live event stream.
 *  - `recovering`     a bounded replay is currently in progress.  If the
 *                     process dies mid-replay the marker stays here so the
 *                     next start re-runs the replay (crash-safe recovery).
 */
export type SorobanRecoveryMarker = "clean" | "pending_replay" | "recovering";

/**
 * A durable checkpoint for the Soroban event listener.  See
 * migrations/010_soroban_checkpoints.sql for the storage contract.
 */
export interface SorobanCheckpoint {
  /** Soroban HTLC contract this checkpoint belongs to. */
  contractId: string;
  /** Highest ledger sequence fully processed; safe resume point. */
  lastSafeLedger: number;
  /** Opaque Soroban RPC pagination cursor, or null after a reset/fresh start. */
  effectiveCursor: string | null;
  /** Ingestion-health flag used to drive replay/recovery. */
  recoveryMarker: SorobanRecoveryMarker;
  /** Unix timestamp (seconds) of the last checkpoint write. */
  updatedAt: number;
}

export interface OrderRow {
  id: number;
  publicId: string;
  direction: Direction;
  status: OrderStatus;
  hashlock: string;
  srcChain: Chain;
  srcAddress: string;
  srcAsset: string;
  srcAmount: string;
  srcSafetyDeposit: string;
  srcOrderId: string | null;
  srcLockTx: string | null;
  srcLockBlock: number | null;
  srcTimelock: number | null;
  dstChain: Chain;
  dstAddress: string;
  dstAsset: string;
  dstAmount: string;
  dstOrderId: string | null;
  dstLockTx: string | null;
  dstLockBlock: number | null;
  dstTimelock: number | null;
  preimage: string | null;
  /** NULL = plaintext, 1 = AES-256-GCM encrypted blob. */
  preimageEncVersion: number | null;
  secretRevealedTx: string | null;
  resolverAddress: string | null;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

export interface OrderHistoryResult {
  orders: OrderRow[];
  nextCursor: string | null;
}

export interface CursorInfo {
  createdAt: number;
  id: number;
}

export interface AnnounceOrderInput {
  direction: Direction;
  hashlock: string;
  srcChain: Chain;
  srcAddress: string;
  srcAsset: string;
  srcAmount: string;
  srcSafetyDeposit: string;
  dstChain: Chain;
  dstAddress: string;
  dstAsset: string;
  dstAmount: string;
}

interface OrderDbRow {
  id: number;
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
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

function rowToOrder(r: OrderDbRow): OrderRow {
  return {
    id: Number(r.id),
    publicId: r.public_id,
    direction: r.direction,
    status: r.status,
    hashlock: r.hashlock,
    srcChain: r.src_chain,
    srcAddress: r.src_address,
    srcAsset: r.src_asset,
    srcAmount: r.src_amount,
    srcSafetyDeposit: r.src_safety_deposit,
    srcOrderId: r.src_order_id,
    srcLockTx: r.src_lock_tx,
    srcLockBlock: r.src_lock_block,
    srcTimelock: r.src_timelock,
    dstChain: r.dst_chain,
    dstAddress: r.dst_address,
    dstAsset: r.dst_asset,
    dstAmount: r.dst_amount,
    dstOrderId: r.dst_order_id,
    dstLockTx: r.dst_lock_tx,
    dstLockBlock: r.dst_lock_block,
    dstTimelock: r.dst_timelock,
    preimage: r.preimage,
    preimageEncVersion: r.preimage_enc_version ?? null,
    secretRevealedTx: r.secret_revealed_tx,
    resolverAddress: r.resolver_address,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    archivedAt: r.archived_at ?? null
  };
}

export class OrdersRepository {
  private readonly transactionManager: RepositoryTransaction;
  private readonly insertStmt: Statement;
  private readonly byPublicId: Statement;
  private readonly byHashlock: Statement;
  private readonly byAddress: Statement;
  private readonly byAddressCursor: Statement;
  private readonly bySrcOrderId: Statement;
  private readonly byDstOrderId: Statement;
  private readonly updateStatus: Statement;
  private readonly updateSrcLock: Statement;
  private readonly updateDstLock: Statement;
  private readonly updateSecret: Statement;
  private readonly rollbackSrc: Statement;
  private readonly rollbackDst: Statement;
  private readonly insertEvent: Statement;

  constructor(private readonly db: DatabaseT, transactionManager?: RepositoryTransaction) {
    this.transactionManager = transactionManager ?? new InMemoryRepositoryTransaction();
    this.insertStmt = db.prepare(`
      INSERT INTO orders (
        public_id, direction, status, hashlock,
        src_chain, src_address, src_asset, src_amount, src_safety_deposit,
        dst_chain, dst_address, dst_asset, dst_amount
      ) VALUES (
        :publicId, :direction, 'announced', :hashlock,
        :srcChain, :srcAddress, :srcAsset, :srcAmount, :srcSafetyDeposit,
        :dstChain, :dstAddress, :dstAsset, :dstAmount
      )
    `);
    this.byPublicId = db.prepare("SELECT * FROM orders WHERE public_id = ?");
    this.byHashlock = db.prepare("SELECT * FROM orders WHERE hashlock = ?");
    this.byAddress = db.prepare(`
      SELECT * FROM (
        SELECT * FROM orders WHERE src_address = :addr
        UNION
        SELECT * FROM orders WHERE dst_address = :addr
      )
      ORDER BY created_at DESC
      LIMIT :limit OFFSET :offset
    `);
    this.byAddressCursor = db.prepare(`
      SELECT * FROM orders
      WHERE (src_address = :addr OR dst_address = :addr)
        AND (created_at < :cursorCreatedAt OR (created_at = :cursorCreatedAt AND id < :cursorId))
      ORDER BY created_at DESC, id DESC
      LIMIT :limit
    `);
    this.bySrcOrderId = db.prepare(`
      SELECT * FROM orders WHERE src_chain = :chain AND src_order_id = :orderId
    `);
    this.byDstOrderId = db.prepare(`
      SELECT * FROM orders WHERE dst_chain = :chain AND dst_order_id = :orderId
    `);
    this.updateStatus = db.prepare(`
      UPDATE orders
      SET status = :status, updated_at = CAST(strftime('%s','now') AS INTEGER)
      WHERE public_id = :publicId
    `);
    // Status is computed in TypeScript (see recordSrcLock/recordDstLock) using
    // the order state machine as the single source of truth, then applied here
    // as a discrete value rather than via a brittle SQL CASE expression.
    this.updateSrcLock = db.prepare(`
      UPDATE orders SET
        src_order_id = :orderId,
        src_lock_tx = :txHash,
        src_lock_block = :blockNumber,
        src_timelock = :timelock,
        status = :status,
        updated_at = CAST(strftime('%s','now') AS INTEGER)
      WHERE public_id = :publicId
    `);
    this.updateDstLock = db.prepare(`
      UPDATE orders SET
        dst_order_id = :orderId,
        dst_lock_tx = :txHash,
        dst_lock_block = :blockNumber,
        dst_timelock = :timelock,
        resolver_address = :resolver,
        status = :status,
        updated_at = CAST(strftime('%s','now') AS INTEGER)
      WHERE public_id = :publicId
    `);
    this.updateSecret = db.prepare(`
      UPDATE orders SET
        preimage = :preimage,
        preimage_enc_version = :encVersion,
        secret_revealed_tx = :txHash,
        status = 'secret_revealed',
        updated_at = CAST(strftime('%s','now') AS INTEGER)
      WHERE public_id = :publicId
    `);
    this.rollbackSrc = db.prepare(`
      UPDATE orders SET
        src_order_id = NULL,
        src_lock_tx = NULL,
        src_lock_block = NULL,
        src_timelock = NULL,
        status = 'announced',
        updated_at = CAST(strftime('%s','now') AS INTEGER)
      WHERE public_id = :publicId AND status = 'src_locked'
    `);
    this.rollbackDst = db.prepare(`
      UPDATE orders SET
        dst_order_id = NULL,
        dst_lock_tx = NULL,
        dst_lock_block = NULL,
        dst_timelock = NULL,
        resolver_address = NULL,
        status = 'src_locked',
        updated_at = CAST(strftime('%s','now') AS INTEGER)
      WHERE public_id = :publicId AND status = 'dst_locked'
    `);
    this.insertEvent = db.prepare(`
      INSERT INTO order_events (order_id, event_type, payload_json)
      VALUES (:orderId, :eventType, :payloadJson)
    `);
  }

  private async run(stmt: Statement, ...params: any[]): Promise<StatementResult> {
    return this.withMetrics("run", async () => {
      const asyncStmt = stmt as AsyncCapableStatement;
      if (asyncStmt.runAsync) {
        return asyncStmt.runAsync(...params);
      }
      const result = stmt.run(...params);
      return {
        changes: Number(result.changes),
        lastInsertRowid: Number(result.lastInsertRowid)
      };
    });
  }

  private async withMetrics<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    const end = dbQueryDuration.startTimer({ operation });
    try {
      return await fn();
    } finally {
      end();
    }
  }

  private async get<T>(stmt: Statement, ...params: any[]): Promise<T | undefined> {
    return this.withMetrics("get", async () => {
      const asyncStmt = stmt as AsyncCapableStatement;
      if (asyncStmt.getAsync) {
        return ((await asyncStmt.getAsync(...params)) ?? undefined) as T | undefined;
      }
      return stmt.get(...params) as T | undefined;
    });
  }

  private async all<T>(stmt: Statement, ...params: any[]): Promise<T[]> {
    return this.withMetrics("all", async () => {
      const asyncStmt = stmt as AsyncCapableStatement;
      if (asyncStmt.allAsync) {
        return (await asyncStmt.allAsync(...params)) as T[];
      }
      return stmt.all(...params) as T[];
    });
  }

  /**
   * Append a durable transition event to `order_events`.
   *
   * Every state mutation in this repository passes through this method so
   * the full lifecycle of an order can be reconstructed from the event trail
   * without reading the mutable `orders` row.  The metric counter lets
   * operators monitor replay storms (sustained no-op rates) via Prometheus.
   */
  private async appendTransitionEvent(
    orderId: number,
    eventType: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    await this.run(this.insertEvent, {
      orderId,
      eventType,
      payloadJson: JSON.stringify(payload),
    });
    orderTransitionEventsTotal.inc({ event_type: eventType });
  }

  /** Returns the public id of the new order. */
  async announce(input: AnnounceOrderInput): Promise<OrderRow> {
    const publicId = orderIdFromHashlock(input.hashlock);
    await this.run(this.insertStmt, { publicId, ...input });
    const row = await this.get<OrderDbRow>(this.byPublicId, publicId);
    if (!row) throw new Error("Failed to insert order");
    return rowToOrder(row);
  }

  async findByPublicId(publicId: string): Promise<OrderRow | null> {
    const row = await this.get<OrderDbRow>(this.byPublicId, publicId);
    return row ? rowToOrder(row) : null;
  }

  async findByHashlock(hashlock: string): Promise<OrderRow | null> {
    const row = await this.get<OrderDbRow>(this.byHashlock, hashlock);
    return row ? rowToOrder(row) : null;
  }

  async findBySrcOrderId(chain: Chain, orderId: string): Promise<OrderRow | null> {
    const row = await this.get<OrderDbRow>(this.bySrcOrderId, { chain, orderId });
    return row ? rowToOrder(row) : null;
  }

  async findByDstOrderId(chain: Chain, orderId: string): Promise<OrderRow | null> {
    const row = await this.get<OrderDbRow>(this.byDstOrderId, { chain, orderId });
    return row ? rowToOrder(row) : null;
  }

  async findByAddress(addr: string, limit = 50, offset = 0): Promise<OrderRow[]> {
    const rows = await this.all<OrderDbRow>(this.byAddress, { addr, limit, offset });
    return rows.map(rowToOrder);
  }

  /**
   * Find orders by address using cursor-based pagination.
   * More efficient and consistent than offset pagination for large datasets.
   */
  async findByAddressWithCursor(addr: string, limit = 50, cursor?: string): Promise<OrderHistoryResult> {
    // Treat empty-string cursor as invalid — callers must pass undefined for "no cursor"
    if (cursor !== undefined && cursor === '') {
      throw new Error('Invalid cursor: empty string is not a valid cursor');
    }

    // Fetch one extra row to cheaply detect whether a next page exists
    const fetchLimit = limit + 1;
    let rows: OrderDbRow[];

    if (!cursor) {
      // First page - get latest orders
      const firstPageStmt = this.db.prepare(`
        SELECT * FROM orders
        WHERE src_address = :addr OR dst_address = :addr
        ORDER BY created_at DESC, id DESC
        LIMIT :limit
      `);
      rows = await this.all<OrderDbRow>(firstPageStmt, { addr, limit: fetchLimit });
    } else {
      // Subsequent pages - use cursor
      const cursorInfo = this.decodeCursor(cursor);
      rows = await this.all<OrderDbRow>(this.byAddressCursor, {
        addr,
        limit: fetchLimit,
        cursorCreatedAt: cursorInfo.createdAt,
        cursorId: cursorInfo.id
      });
    }

    const hasMore = rows.length > limit;
    // Trim to the requested limit
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const orders = pageRows.map(rowToOrder);

    // Generate next cursor only if there are genuinely more rows
    let nextCursor: string | null = null;
    if (hasMore) {
      const lastOrder = orders[orders.length - 1];
      if (lastOrder) {
        nextCursor = this.encodeCursor({
          createdAt: lastOrder.createdAt,
          id: lastOrder.id
        });
      }
    }

    return { orders, nextCursor };
  }

  /**
   * Encode cursor information as a base64url string.
   * Format: base64url(JSON.stringify({createdAt, id}))
   */
  private encodeCursor(cursor: CursorInfo): string {
    const json = JSON.stringify(cursor);
    return Buffer.from(json, 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');
  }

  /**
   * Decode cursor string back to cursor information.
   * Validates the cursor format and throws if invalid.
   */
  private decodeCursor(cursor: string): CursorInfo {
    try {
      // Add padding back and convert base64url to base64
      const padded = cursor + '==='.slice((cursor.length + 3) % 4);
      const base64 = padded.replace(/-/g, '+').replace(/_/g, '/');
      const json = Buffer.from(base64, 'base64').toString('utf8');
      const parsed = JSON.parse(json);
      
      if (typeof parsed.createdAt !== 'number' || typeof parsed.id !== 'number') {
        throw new Error('Invalid cursor format: missing or invalid createdAt/id');
      }
      
      return parsed;
    } catch (error) {
      throw new Error(`Invalid cursor: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async setStatus(publicId: string, status: OrderStatus, actor = "system"): Promise<void> {
    await this.transactionManager.runWithRetry("status-update", async () => {
      const order = await this.get<OrderDbRow>(this.byPublicId, publicId);
      await this.run(this.updateStatus, { publicId, status });
      if (order) {
        await this.appendTransitionEvent(order.id, "status.transitioned", {
          actor,
          fromStatus: order.status,
          toStatus: status,
          outcome: "transitioned",
          triggeredAt: Math.floor(Date.now() / 1000),
        });
      }
    });
  }

  /**
   * Decide the status an order should hold after recording a lock event.
   *
   * The state machine is the source of truth: we only advance the status
   * when the transition is allowed, otherwise we keep the current status
   * (so re-recording a lock for an order already past that stage is a
   * status no-op). Callers must skip terminal orders entirely — see
   * `recordSrcLock`/`recordDstLock`.
   */
  private nextLockStatus(current: OrderStatus, target: OrderStatus): OrderStatus {
    return canTransition(current, target) ? target : current;
  }

  async recordSrcLock(input: {
    publicId: string;
    orderId: string;
    txHash: string;
    blockNumber: number;
    timelock: number;
    actor?: string;
  }): Promise<void> {
    await this.transactionManager.runWithRetry("src-lock-update", async () => {
      const order = await this.get<OrderDbRow>(this.byPublicId, input.publicId);
      if (!order) return;
      const actor = input.actor ?? "system";
      const now = Math.floor(Date.now() / 1000);
      if (isTerminal(order.status)) {
        await this.appendTransitionEvent(order.id, "src_lock.no_op", {
          actor,
          fromStatus: order.status,
          toStatus: order.status,
          outcome: "no_op:terminal",
          txHash: input.txHash,
          blockNumber: input.blockNumber,
          triggeredAt: now,
        });
        return;
      }
      const status = this.nextLockStatus(order.status, "src_locked");
      await this.run(this.updateSrcLock, {
        publicId: input.publicId,
        orderId: input.orderId,
        txHash: input.txHash,
        blockNumber: input.blockNumber,
        timelock: input.timelock,
        status,
      });
      const outcome = status === order.status ? "no_op:already_at_target" : "transitioned";
      await this.appendTransitionEvent(order.id, status === order.status ? "src_lock.no_op" : "src_lock.transitioned", {
        actor,
        fromStatus: order.status,
        toStatus: status,
        outcome,
        txHash: input.txHash,
        blockNumber: input.blockNumber,
        triggeredAt: now,
      });
    });
  }

  async recordDstLock(input: {
    publicId: string;
    orderId: string;
    txHash: string;
    blockNumber: number;
    timelock: number;
    resolver: string | null;
    actor?: string;
  }): Promise<void> {
    await this.transactionManager.runWithRetry("dst-lock-update", async () => {
      const order = await this.get<OrderDbRow>(this.byPublicId, input.publicId);
      if (!order) return;
      const actor = input.actor ?? "system";
      const now = Math.floor(Date.now() / 1000);
      if (isTerminal(order.status)) {
        await this.appendTransitionEvent(order.id, "dst_lock.no_op", {
          actor,
          fromStatus: order.status,
          toStatus: order.status,
          outcome: "no_op:terminal",
          txHash: input.txHash,
          blockNumber: input.blockNumber,
          triggeredAt: now,
        });
        return;
      }
      const status = this.nextLockStatus(order.status, "dst_locked");
      await this.run(this.updateDstLock, {
        publicId: input.publicId,
        orderId: input.orderId,
        txHash: input.txHash,
        blockNumber: input.blockNumber,
        timelock: input.timelock,
        resolver: input.resolver,
        status,
      });
      const outcome = status === order.status ? "no_op:already_at_target" : "transitioned";
      await this.appendTransitionEvent(order.id, status === order.status ? "dst_lock.no_op" : "dst_lock.transitioned", {
        actor,
        fromStatus: order.status,
        toStatus: status,
        outcome,
        txHash: input.txHash,
        blockNumber: input.blockNumber,
        triggeredAt: now,
      });
    });
  }

  async recordSecretRevealed(input: {
    publicId: string;
    preimage: string;
    txHash: string;
    encVersion?: number | null;
    actor?: string;
  }): Promise<void> {
    await this.transactionManager.runWithRetry("secret-update", async () => {
      const order = await this.get<OrderDbRow>(this.byPublicId, input.publicId);
      if (!order) return;
      const actor = input.actor ?? "system";
      const now = Math.floor(Date.now() / 1000);
      if (isTerminal(order.status)) {
        await this.appendTransitionEvent(order.id, "secret_revealed.no_op", {
          actor,
          fromStatus: order.status,
          toStatus: order.status,
          outcome: "no_op:terminal",
          txHash: input.txHash,
          triggeredAt: now,
        });
        return;
      }
      // Idempotent: same preimage already recorded — avoid overwriting the tx hash
      // with a replay from a different block while the observable state is identical.
      if (order.preimage !== null && order.preimage === input.preimage) {
        await this.appendTransitionEvent(order.id, "secret_revealed.no_op", {
          actor,
          fromStatus: order.status,
          toStatus: order.status,
          outcome: "no_op:idempotent",
          txHash: input.txHash,
          triggeredAt: now,
        });
        return;
      }
      await this.run(this.updateSecret, {
        publicId: input.publicId,
        preimage: input.preimage,
        txHash: input.txHash,
        encVersion: input.encVersion ?? null,
      });
      await this.appendTransitionEvent(order.id, "secret_revealed.transitioned", {
        actor,
        fromStatus: order.status,
        toStatus: "secret_revealed",
        outcome: "transitioned",
        txHash: input.txHash,
        triggeredAt: now,
      });
    });
  }

  /**
   * Return all transition events recorded for an order in insertion order.
   *
   * Each event carries the `eventType` (e.g. `src_lock.transitioned`), the
   * structured payload (actor, fromStatus, toStatus, outcome, …), and a unix
   * timestamp.  Callers can use this to reconstruct the full lifecycle without
   * reading the mutable `orders` row.
   */
  async findTransitionEvents(publicId: string): Promise<
    { eventType: string; payload: Record<string, unknown>; createdAt: number }[]
  > {
    const rows = await this.all<{
      event_type: string;
      payload_json: string;
      created_at: number;
    }>(
      this.db.prepare(`
        SELECT oe.event_type, oe.payload_json, oe.created_at
        FROM order_events oe
        JOIN orders o ON o.id = oe.order_id
        WHERE o.public_id = ?
        ORDER BY oe.id ASC
      `),
      publicId
    );
    return rows.map((r) => ({
      eventType: r.event_type,
      payload: JSON.parse(r.payload_json) as Record<string, unknown>,
      createdAt: r.created_at,
    }));
  }

  async rollbackSrcLock(publicId: string): Promise<void> {
    await this.run(this.rollbackSrc, { publicId });
  }

  async rollbackDstLock(publicId: string): Promise<void> {
    await this.run(this.rollbackDst, { publicId });
  }

  /**
   * Find announced orders with no source lock that are older than the given
   * retention window and have not yet been archived.  These are candidates for
   * soft-delete by the stale cleanup service.
   */
  async findStaleAnnounced(retentionWindowSeconds: number): Promise<OrderRow[]> {
    const cutoff = Math.floor(Date.now() / 1000) - retentionWindowSeconds;
    const rows = await this.all<OrderDbRow>(
      this.db.prepare(`
        SELECT * FROM orders
        WHERE status = 'announced'
          AND src_order_id IS NULL
          AND archived_at IS NULL
          AND created_at < ?
      `),
      cutoff
    );
    return rows.map(rowToOrder);
  }

  /** Soft-delete a single order by stamping it with the current unix time. */
  async archiveOrder(publicId: string): Promise<void> {
    await this.run(
      this.db.prepare(`
        UPDATE orders
        SET archived_at = CAST(strftime('%s','now') AS INTEGER),
            updated_at  = CAST(strftime('%s','now') AS INTEGER)
        WHERE public_id = ?
          AND archived_at IS NULL
      `),
      publicId
    );
  }

  /**
   * Reactivate a previously-archived order by clearing its `archived_at`
   * timestamp.  Only affects rows where `archived_at IS NOT NULL` so it is
   * safe to call on an already-live order (no-op).
   *
   * Used by the archival recovery path when an on-chain lock event is
   * discovered for an order that was soft-deleted during stale cleanup.
   */
  async unarchiveOrder(publicId: string): Promise<void> {
    await this.run(
      this.db.prepare(`
        UPDATE orders
        SET archived_at = NULL,
            updated_at  = CAST(strftime('%s','now') AS INTEGER)
        WHERE public_id = ?
          AND archived_at IS NOT NULL
      `),
      publicId
    );
  }

  async getLastProcessedBlock(chain: Chain): Promise<number> {
    const srcRow = await this.get<{ max_block: number | null }>(
      this.db.prepare("SELECT MAX(src_lock_block) AS max_block FROM orders WHERE src_chain = ?"),
      chain
    );
    const dstRow = await this.get<{ max_block: number | null }>(
      this.db.prepare("SELECT MAX(dst_lock_block) AS max_block FROM orders WHERE dst_chain = ?"),
      chain
    );
    const srcMax = srcRow?.max_block ?? 0;
    const dstMax = dstRow?.max_block ?? 0;
    return Math.max(srcMax, dstMax);
  }

  /**
   * Return the last position (block/ledger/slot) that the reconciler has
   * confirmed it fully processed for `chain`.  Returns 0 if the reconciler
   * has never run for this chain (no row in chain_cursors).
   *
   * This is the persistent counterpart to `getLastProcessedBlock()`.
   * `getLastProcessedBlock()` derives a position from existing order data,
   * which only advances when an order transitions — blocks with no relevant
   * events are invisible to it.  `getChainCursor()` returns the value
   * explicitly written by `setChainCursor()` so it reflects every scanned
   * block, not just blocks that contained orders.
   */
  async getChainCursor(chain: Chain): Promise<number> {
    const row = await this.get<{ position: number }>(
      this.db.prepare("SELECT position FROM chain_cursors WHERE chain = ?"),
      chain
    );
    return row?.position ?? 0;
  }

  /**
   * Record that the reconciler has fully processed all events up to and
   * including `position` for `chain`.
   *
   * The update is an UPSERT so callers don't have to check whether a row
   * exists.  We only advance the cursor forward — if the incoming position
   * is less than the stored position (e.g. a parallel reconciler ran
   * concurrently), we leave the stored value unchanged.
   */
  async setChainCursor(chain: Chain, position: number): Promise<void> {
    await this.run(
      this.db.prepare(`
        INSERT INTO chain_cursors (chain, position, updated_at)
        VALUES (?, ?, CAST(strftime('%s','now') AS INTEGER))
        ON CONFLICT(chain) DO UPDATE
          SET position   = MAX(chain_cursors.position, excluded.position),
              updated_at = excluded.updated_at
      `),
      chain, position
    );
  }

  // ── Soroban listener checkpoints ──────────────────────────────────────────
  //
  // These three methods are the durable persistence adapter for the Soroban
  // event listener's checkpoint/replay-recovery subsystem.  The listener owns
  // the semantics (when to resume, when to replay); this adapter only owns
  // storage and the forward-only invariant on `last_safe_ledger`.

  /**
   * Load the durable checkpoint for `contractId`, or `null` when the listener
   * has never checkpointed this contract (fresh install, or the coordinator
   * was re-pointed at a different HTLC contract).
   */
  async getSorobanCheckpoint(contractId: string): Promise<SorobanCheckpoint | null> {
    const row = await this.get<{
      contract_id: string;
      last_safe_ledger: number;
      effective_cursor: string | null;
      recovery_marker: SorobanRecoveryMarker;
      updated_at: number;
    }>(
      this.db.prepare(
        `SELECT contract_id, last_safe_ledger, effective_cursor, recovery_marker, updated_at
           FROM soroban_checkpoints
          WHERE contract_id = ?`
      ),
      contractId
    );
    if (!row) return null;
    return {
      contractId: row.contract_id,
      lastSafeLedger: Number(row.last_safe_ledger),
      effectiveCursor: row.effective_cursor,
      recoveryMarker: row.recovery_marker,
      updatedAt: Number(row.updated_at),
    };
  }

  /**
   * Persist (upsert) the Soroban listener checkpoint.
   *
   * `last_safe_ledger` only ever moves forward: a stale-cursor reset or a
   * replay that re-observes older ledgers must never rewind the safe resume
   * point.  The forward-only clamp is enforced in SQL (portable across SQLite
   * and Postgres) so concurrent writers can never regress it either.  The
   * cursor and recovery marker always take the incoming value.
   */
  async saveSorobanCheckpoint(input: {
    contractId: string;
    lastSafeLedger: number;
    effectiveCursor: string | null;
    recoveryMarker: SorobanRecoveryMarker;
  }): Promise<void> {
    await this.run(
      this.db.prepare(`
        INSERT INTO soroban_checkpoints
            (contract_id, last_safe_ledger, effective_cursor, recovery_marker, updated_at)
        VALUES
            (:contractId, :lastSafeLedger, :effectiveCursor, :recoveryMarker,
             CAST(strftime('%s','now') AS INTEGER))
        ON CONFLICT(contract_id) DO UPDATE SET
          last_safe_ledger = CASE
              WHEN excluded.last_safe_ledger > soroban_checkpoints.last_safe_ledger
                THEN excluded.last_safe_ledger
              ELSE soroban_checkpoints.last_safe_ledger
            END,
          effective_cursor = excluded.effective_cursor,
          recovery_marker  = excluded.recovery_marker,
          updated_at       = excluded.updated_at
      `),
      {
        contractId: input.contractId,
        lastSafeLedger: input.lastSafeLedger,
        effectiveCursor: input.effectiveCursor,
        recoveryMarker: input.recoveryMarker,
      }
    );
  }

  /**
   * Flip only the recovery marker for an existing checkpoint, leaving the
   * ledger and cursor untouched.  Used to record that a gap / stale cursor /
   * restart was observed (`pending_replay`) or that a bounded replay has begun
   * (`recovering`) without disturbing the safe resume point.
   *
   * Returns the number of rows changed — 0 when no checkpoint exists yet for
   * `contractId`, in which case there is nothing to recover from.
   */
  async markSorobanRecovery(
    contractId: string,
    marker: SorobanRecoveryMarker
  ): Promise<number> {
    const result = await this.run(
      this.db.prepare(`
        UPDATE soroban_checkpoints
           SET recovery_marker = :marker,
               updated_at      = CAST(strftime('%s','now') AS INTEGER)
         WHERE contract_id = :contractId
      `),
      { contractId, marker }
    );
    return result.changes;
  }

  /**
   * Return orders in `src_locked` or `dst_locked` whose relevant timelock
   * has already passed (timelock < nowSeconds).  These are candidates for
   * the periodic expiry scan.
   *
   * Only non-terminal statuses are returned — completed, refunded, failed
   * orders are excluded because they cannot transition to `expired`.
   */
  async findExpiredCandidates(nowSeconds: number): Promise<OrderRow[]> {
    const rows = await this.all<OrderDbRow>(
      this.db.prepare(`
        SELECT * FROM orders
        WHERE status IN ('src_locked', 'dst_locked')
          AND (
            (src_timelock IS NOT NULL AND src_timelock < :now)
            OR
            (dst_timelock IS NOT NULL AND dst_timelock < :now)
          )
      `),
      { now: nowSeconds }
    );
    return rows.map(rowToOrder);
  }

  /**
   * Return orders in `src_locked` or `dst_locked` state that have no preimage
   * recorded.  These are candidates for secret recovery via on-chain log replay.
   */
  async findOrdersMissingSecret(): Promise<
    { publicId: string; srcOrderId: string | null; hashlock: string; status: string }[]
  > {
    const rows = await this.all<{
      public_id: string;
      src_order_id: string | null;
      hashlock: string;
      status: string;
    }>(
      this.db.prepare(`
        SELECT public_id, src_order_id, hashlock, status
        FROM orders
        WHERE status IN ('src_locked', 'dst_locked')
          AND preimage IS NULL
      `)
    );
    return rows.map((r) => ({
      publicId: r.public_id,
      srcOrderId: r.src_order_id,
      hashlock: r.hashlock,
      status: r.status,
    }));
  }
}
