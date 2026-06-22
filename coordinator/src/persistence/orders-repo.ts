import { randomBytes } from "node:crypto";
import type { Database } from "./db.js";
import { canTransition, isTerminal } from "../state-machine/order-machine.js";
import { dbQueryDuration } from "../metrics.js";

type DatabaseT = Database;
type Statement = ReturnType<DatabaseT["prepare"]>;
type StatementResult = { changes: number; lastInsertRowid: number };
type AsyncCapableStatement = Statement & {
  runAsync?: (...params: any[]) => Promise<StatementResult>;
  getAsync?: (...params: any[]) => Promise<unknown>;
  allAsync?: (...params: any[]) => Promise<unknown[]>;
};

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
    updatedAt: r.updated_at
  };
}

export class OrdersRepository {
  private readonly insertStmt: Statement;
  private readonly byPublicId: Statement;
  private readonly byHashlock: Statement;
  private readonly byAddress: Statement;
  private readonly bySrcOrderId: Statement;
  private readonly byDstOrderId: Statement;
  private readonly updateStatus: Statement;
  private readonly updateSrcLock: Statement;
  private readonly updateDstLock: Statement;
  private readonly updateSecret: Statement;
  private readonly rollbackSrc: Statement;
  private readonly rollbackDst: Statement;

  constructor(private readonly db: DatabaseT) {
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
      SELECT * FROM orders
      WHERE src_address = :addr OR dst_address = :addr
      ORDER BY created_at DESC
      LIMIT :limit OFFSET :offset
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

  /** Returns the public id of the new order. */
  async announce(input: AnnounceOrderInput): Promise<OrderRow> {
    const publicId = randomBytes(16).toString("hex");
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

  async setStatus(publicId: string, status: OrderStatus): Promise<void> {
    await this.run(this.updateStatus, { publicId, status });
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
  }): Promise<void> {
    const order = await this.get<OrderDbRow>(this.byPublicId, input.publicId);
    if (!order) return;
    // Repeated lock events on a terminal order are a no-op: a completed,
    // refunded or failed order must never be dragged back into src_locked
    // under event replay. (`expired` is non-terminal: it falls through to
    // nextLockStatus, which keeps it expired since the transition is invalid.)
    if (isTerminal(order.status)) return;
    const status = this.nextLockStatus(order.status, "src_locked");
    await this.run(this.updateSrcLock, { ...input, status });
  }

  async recordDstLock(input: {
    publicId: string;
    orderId: string;
    txHash: string;
    blockNumber: number;
    timelock: number;
    resolver: string | null;
  }): Promise<void> {
    const order = await this.get<OrderDbRow>(this.byPublicId, input.publicId);
    if (!order) return;
    // Idempotent no-op for terminal orders: a repeated recordDstLock must
    // not move a completed/refunded/failed order into dst_locked. (`expired`
    // is non-terminal but still can't transition to dst_locked, so
    // nextLockStatus keeps it expired.)
    if (isTerminal(order.status)) return;
    const status = this.nextLockStatus(order.status, "dst_locked");
    await this.run(this.updateDstLock, { ...input, status });
  }

  async recordSecretRevealed(input: {
    publicId: string;
    preimage: string;
    txHash: string;
    encVersion?: number | null;
  }): Promise<void> {
    await this.run(this.updateSecret, {
      publicId: input.publicId,
      preimage: input.preimage,
      txHash: input.txHash,
      encVersion: input.encVersion ?? null
    });
  }

  async rollbackSrcLock(publicId: string): Promise<void> {
    await this.run(this.rollbackSrc, { publicId });
  }

  async rollbackDstLock(publicId: string): Promise<void> {
    await this.run(this.rollbackDst, { publicId });
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
}
