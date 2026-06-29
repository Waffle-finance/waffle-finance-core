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
