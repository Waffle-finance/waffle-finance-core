/**
 * @file orders-repo-kysely.ts
 *
 * Kysely-native implementation of the coordinator orders repository (issue #479).
 *
 * Replaces all raw SQL queries in `orders-repo.ts` with type-safe Kysely
 * query-builder calls.  No dialect-specific SQL escaping is required — Kysely
 * generates correct SQL for both SQLite and PostgreSQL automatically.
 *
 * Public API is identical to `OrdersRepository` so existing call sites
 * (state machine, reconciler, services) can switch with a one-line import change.
 */

import { sql } from 'kysely';
import type { KyselyCoordinatorDb } from './schema-types.js';
import { canTransition, isTerminal } from '../state-machine/order-machine.js';
import { dbQueryDuration, orderTransitionEventsTotal } from '../metrics.js';
import type {
  OrderStatus,
  Chain,
  Direction,
  SorobanRecoveryMarker,
  SorobanCheckpoint,
  OrderRow,
  OrderHistoryResult,
  CursorInfo,
  AnnounceOrderInput,
} from './orders-repo.js';

// ── Row helper ────────────────────────────────────────────────────────────────

function rowToOrder(r: any): OrderRow {
  return {
    id: Number(r.id),
    publicId: r.public_id,
    direction: r.direction as Direction,
    status: r.status as OrderStatus,
    hashlock: r.hashlock,
    srcChain: r.src_chain as Chain,
    srcAddress: r.src_address,
    srcAsset: r.src_asset,
    srcAmount: r.src_amount,
    srcSafetyDeposit: r.src_safety_deposit,
    srcOrderId: r.src_order_id ?? null,
    srcLockTx: r.src_lock_tx ?? null,
    srcLockBlock: r.src_lock_block ?? null,
    srcTimelock: r.src_timelock ?? null,
    dstChain: r.dst_chain as Chain,
    dstAddress: r.dst_address,
    dstAsset: r.dst_asset,
    dstAmount: r.dst_amount,
    dstOrderId: r.dst_order_id ?? null,
    dstLockTx: r.dst_lock_tx ?? null,
    dstLockBlock: r.dst_lock_block ?? null,
    dstTimelock: r.dst_timelock ?? null,
    preimage: r.preimage ?? null,
    preimageEncVersion: r.preimage_enc_version ?? null,
    secretRevealedTx: r.secret_revealed_tx ?? null,
    resolverAddress: r.resolver_address ?? null,
    lastEthBlock: r.last_eth_block ?? null,
    lastSorobanLedger: r.last_soroban_ledger ?? null,
    lastSolanaSlot: r.last_solana_slot ?? null,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    archivedAt: r.archived_at ?? null,
  };
}

function orderIdFromHashlock(hashlock: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hashlock)) {
    throw new Error('hashlock must be 0x + 64 hex chars');
  }
  return `wf_${hashlock.toLowerCase()}`;
}

// ── Cursor helpers ────────────────────────────────────────────────────────────

function encodeCursor(cursor: CursorInfo): string {
  const json = JSON.stringify(cursor);
  return Buffer.from(json, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function decodeCursor(cursor: string): CursorInfo {
  try {
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

// ── Unix-now helper ───────────────────────────────────────────────────────────

/** Portable `now()` in unix seconds via Kysely sql tag — dialect agnostic. */
const nowSql = sql<number>`CAST(strftime('%s','now') AS INTEGER)`;

// ── Repository ────────────────────────────────────────────────────────────────

export class KyselyOrdersRepository {
  constructor(private readonly db: KyselyCoordinatorDb) {}

  // ── Metrics wrapper ───────────────────────────────────────────────────────

  private async withMetrics<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    const end = dbQueryDuration.startTimer({ operation });
    try {
      return await fn();
    } finally {
      end();
    }
  }

  private async appendTransitionEvent(
    orderId: number,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.db
      .insertInto('order_events')
      .values({
        order_id: orderId,
        event_type: eventType,
        payload_json: JSON.stringify(payload),
      })
      .execute();
    orderTransitionEventsTotal.inc({ event_type: eventType });
  }

  // ── Write operations ──────────────────────────────────────────────────────

  async announce(input: AnnounceOrderInput): Promise<OrderRow> {
    const publicId = orderIdFromHashlock(input.hashlock);

    await this.withMetrics('insert_order', () =>
      this.db
        .insertInto('orders')
        .values({
          public_id: publicId,
          direction: input.direction,
          status: 'announced',
          hashlock: input.hashlock,
          src_chain: input.srcChain,
          src_address: input.srcAddress,
          src_asset: input.srcAsset,
          src_amount: input.srcAmount,
          src_safety_deposit: input.srcSafetyDeposit,
          dst_chain: input.dstChain,
          dst_address: input.dstAddress,
          dst_asset: input.dstAsset,
          dst_amount: input.dstAmount,
        } as any)
        .execute()
    );

    const row = await this.db
      .selectFrom('orders')
      .selectAll()
      .where('public_id', '=', publicId)
      .executeTakeFirst();

    if (!row) throw new Error('Failed to insert order');
    return rowToOrder(row);
  }

  async setStatus(
    publicId: string,
    status: OrderStatus,
    actor = 'system',
    expectedStatus?: OrderStatus,
  ): Promise<void> {
    const order = await this.db
      .selectFrom('orders')
      .selectAll()
      .where('public_id', '=', publicId)
      .executeTakeFirst();

    let changes: number;

    if (expectedStatus !== undefined) {
      const result = await this.db
        .updateTable('orders')
        .set({ status, updated_at: nowSql } as any)
        .where('public_id', '=', publicId)
        .where('status', '=', expectedStatus)
        .executeTakeFirst();
      changes = Number(result.numUpdatedRows);
    } else {
      const result = await this.db
        .updateTable('orders')
        .set({ status, updated_at: nowSql } as any)
        .where('public_id', '=', publicId)
        .executeTakeFirst();
      changes = Number(result.numUpdatedRows);
    }

    if (changes === 0) {
      if (!order) {
        const err = new Error(`Order not found: ${publicId}`);
        (err as any).code = 'NOT_FOUND';
        throw err;
      }
      const err = new Error(
        `Status update conflict for ${publicId}: current status "${order.status}" does not match expected "${expectedStatus}"`
      );
      (err as any).code = 'STALE_STATUS';
      (err as any).currentStatus = order.status;
      throw err;
    }

    if (order) {
      await this.appendTransitionEvent(Number(order.id), 'status.transitioned', {
        actor,
        fromStatus: order.status,
        toStatus: status,
        outcome: 'transitioned',
        triggeredAt: Math.floor(Date.now() / 1000),
      });
    }
  }

  async recordSrcLock(input: {
    publicId: string;
    orderId: string;
    txHash: string;
    blockNumber: number;
    timelock: number;
    actor?: string;
  }): Promise<void> {
    const order = await this.db
      .selectFrom('orders')
      .selectAll()
      .where('public_id', '=', input.publicId)
      .executeTakeFirst();

    if (!order) return;
    const actor = input.actor ?? 'system';
    const now = Math.floor(Date.now() / 1000);

    if (isTerminal(order.status as OrderStatus)) {
      await this.appendTransitionEvent(Number(order.id), 'src_lock.no_op', {
        actor, fromStatus: order.status, toStatus: order.status,
        outcome: 'no_op:terminal', txHash: input.txHash,
        blockNumber: input.blockNumber, triggeredAt: now,
      });
      return;
    }

    const nextStatus = canTransition(order.status as OrderStatus, 'src_locked')
      ? 'src_locked'
      : (order.status as OrderStatus);

    await this.db
      .updateTable('orders')
      .set({
        src_order_id: input.orderId,
        src_lock_tx: input.txHash,
        src_lock_block: input.blockNumber,
        src_timelock: input.timelock,
        status: nextStatus,
        updated_at: nowSql,
      } as any)
      .where('public_id', '=', input.publicId)
      .execute();

    const outcome = nextStatus === order.status ? 'no_op:already_at_target' : 'transitioned';
    await this.appendTransitionEvent(
      Number(order.id),
      nextStatus === order.status ? 'src_lock.no_op' : 'src_lock.transitioned',
      { actor, fromStatus: order.status, toStatus: nextStatus, outcome, txHash: input.txHash, blockNumber: input.blockNumber, triggeredAt: now },
    );
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
    const order = await this.db
      .selectFrom('orders')
      .selectAll()
      .where('public_id', '=', input.publicId)
      .executeTakeFirst();

    if (!order) return;
    const actor = input.actor ?? 'system';
    const now = Math.floor(Date.now() / 1000);

    if (isTerminal(order.status as OrderStatus)) {
      await this.appendTransitionEvent(Number(order.id), 'dst_lock.no_op', {
        actor, fromStatus: order.status, toStatus: order.status,
        outcome: 'no_op:terminal', txHash: input.txHash,
        blockNumber: input.blockNumber, triggeredAt: now,
      });
      return;
    }

    const nextStatus = canTransition(order.status as OrderStatus, 'dst_locked')
      ? 'dst_locked'
      : (order.status as OrderStatus);

    await this.db
      .updateTable('orders')
      .set({
        dst_order_id: input.orderId,
        dst_lock_tx: input.txHash,
        dst_lock_block: input.blockNumber,
        dst_timelock: input.timelock,
        resolver_address: input.resolver,
        status: nextStatus,
        updated_at: nowSql,
      } as any)
      .where('public_id', '=', input.publicId)
      .execute();

    const outcome = nextStatus === order.status ? 'no_op:already_at_target' : 'transitioned';
    await this.appendTransitionEvent(
      Number(order.id),
      nextStatus === order.status ? 'dst_lock.no_op' : 'dst_lock.transitioned',
      { actor, fromStatus: order.status, toStatus: nextStatus, outcome, txHash: input.txHash, blockNumber: input.blockNumber, triggeredAt: now },
    );
  }

  async recordSecretRevealed(input: {
    publicId: string;
    preimage: string;
    txHash: string;
    encVersion?: number | null;
    actor?: string;
  }): Promise<void> {
    const order = await this.db
      .selectFrom('orders')
      .selectAll()
      .where('public_id', '=', input.publicId)
      .executeTakeFirst();

    if (!order) return;
    const actor = input.actor ?? 'system';
    const now = Math.floor(Date.now() / 1000);

    if (isTerminal(order.status as OrderStatus)) {
      await this.appendTransitionEvent(Number(order.id), 'secret_revealed.no_op', {
        actor, fromStatus: order.status, toStatus: order.status,
        outcome: 'no_op:terminal', txHash: input.txHash, triggeredAt: now,
      });
      return;
    }

    if (order.preimage !== null && order.preimage === input.preimage) {
      await this.appendTransitionEvent(Number(order.id), 'secret_revealed.no_op', {
        actor, fromStatus: order.status, toStatus: order.status,
        outcome: 'no_op:idempotent', txHash: input.txHash, triggeredAt: now,
      });
      return;
    }

    await this.db
      .updateTable('orders')
      .set({
        preimage: input.preimage,
        preimage_enc_version: input.encVersion ?? null,
        secret_revealed_tx: input.txHash,
        status: 'secret_revealed',
        updated_at: nowSql,
      } as any)
      .where('public_id', '=', input.publicId)
      .execute();

    await this.appendTransitionEvent(Number(order.id), 'secret_revealed.transitioned', {
      actor, fromStatus: order.status, toStatus: 'secret_revealed',
      outcome: 'transitioned', txHash: input.txHash, triggeredAt: now,
    });
  }

  // ── Read operations ───────────────────────────────────────────────────────

  async findByPublicId(publicId: string): Promise<OrderRow | null> {
    const row = await this.withMetrics('find_by_public_id', () =>
      this.db
        .selectFrom('orders')
        .selectAll()
        .where('public_id', '=', publicId)
        .executeTakeFirst()
    );
    return row ? rowToOrder(row) : null;
  }

  async findByHashlock(hashlock: string): Promise<OrderRow | null> {
    const row = await this.db
      .selectFrom('orders')
      .selectAll()
      .where('hashlock', '=', hashlock)
      .executeTakeFirst();
    return row ? rowToOrder(row) : null;
  }

  async findBySrcOrderId(chain: Chain, orderId: string): Promise<OrderRow | null> {
    const row = await this.db
      .selectFrom('orders')
      .selectAll()
      .where('src_chain', '=', chain)
      .where('src_order_id', '=', orderId)
      .executeTakeFirst();
    return row ? rowToOrder(row) : null;
  }

  async findByDstOrderId(chain: Chain, orderId: string): Promise<OrderRow | null> {
    const row = await this.db
      .selectFrom('orders')
      .selectAll()
      .where('dst_chain', '=', chain)
      .where('dst_order_id', '=', orderId)
      .executeTakeFirst();
    return row ? rowToOrder(row) : null;
  }

  async findByAddress(addr: string, limit = 50, offset = 0): Promise<OrderRow[]> {
    const rows = await this.db
      .selectFrom('orders')
      .selectAll()
      .where((eb) =>
        eb.or([
          eb('src_address', '=', addr),
          eb('dst_address', '=', addr),
        ])
      )
      .orderBy('created_at', 'desc')
      .limit(limit)
      .offset(offset)
      .execute();
    return rows.map(rowToOrder);
  }

  async findByAddressWithCursor(
    addr: string,
    limit = 50,
    cursor?: string,
  ): Promise<OrderHistoryResult> {
    if (cursor !== undefined && cursor === '') {
      throw new Error('Invalid cursor: empty string is not a valid cursor');
    }

    const fetchLimit = limit + 1;
    let rows: any[];

    if (!cursor) {
      rows = await this.db
        .selectFrom('orders')
        .selectAll()
        .where((eb) =>
          eb.or([eb('src_address', '=', addr), eb('dst_address', '=', addr)])
        )
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(fetchLimit)
        .execute();
    } else {
      const cursorInfo = decodeCursor(cursor);
      rows = await this.db
        .selectFrom('orders')
        .selectAll()
        .where((eb) =>
          eb.and([
            eb.or([eb('src_address', '=', addr), eb('dst_address', '=', addr)]),
            eb.or([
              eb('created_at', '<', cursorInfo.createdAt),
              eb.and([
                eb('created_at', '=', cursorInfo.createdAt),
                eb('id', '<', cursorInfo.id),
              ]),
            ]),
          ])
        )
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(fetchLimit)
        .execute();
    }

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const orders = pageRows.map(rowToOrder);

    let nextCursor: string | null = null;
    if (hasMore) {
      const last = orders[orders.length - 1];
      if (last) nextCursor = encodeCursor({ createdAt: last.createdAt, id: last.id });
    }

    return { orders, nextCursor };
  }

  async findTransitionEvents(publicId: string): Promise<
    { eventType: string; payload: Record<string, unknown>; createdAt: number }[]
  > {
    const rows = await this.db
      .selectFrom('order_events as oe')
      .innerJoin('orders as o', 'o.id', 'oe.order_id')
      .select(['oe.event_type', 'oe.payload_json', 'oe.created_at'])
      .where('o.public_id', '=', publicId)
      .orderBy('oe.id', 'asc')
      .execute();

    return rows.map((r) => ({
      eventType: r.event_type,
      payload: JSON.parse(r.payload_json) as Record<string, unknown>,
      createdAt: Number(r.created_at),
    }));
  }

  async findStaleAnnounced(retentionWindowSeconds: number): Promise<OrderRow[]> {
    const cutoff = Math.floor(Date.now() / 1000) - retentionWindowSeconds;
    const rows = await this.db
      .selectFrom('orders')
      .selectAll()
      .where('status', '=', 'announced')
      .where('src_order_id', 'is', null)
      .where('archived_at', 'is', null)
      .where('created_at', '<', cutoff)
      .execute();
    return rows.map(rowToOrder);
  }

  async archiveOrder(publicId: string): Promise<void> {
    await this.db
      .updateTable('orders')
      .set({ archived_at: nowSql, updated_at: nowSql } as any)
      .where('public_id', '=', publicId)
      .where('archived_at', 'is', null)
      .execute();
  }

  async unarchiveOrder(publicId: string): Promise<void> {
    await this.db
      .updateTable('orders')
      .set({ archived_at: null, updated_at: nowSql } as any)
      .where('public_id', '=', publicId)
      .where('archived_at', 'is not', null)
      .execute();
  }

  async rollbackSrcLock(publicId: string): Promise<void> {
    await this.db
      .updateTable('orders')
      .set({
        src_order_id: null, src_lock_tx: null, src_lock_block: null, src_timelock: null,
        status: 'announced', updated_at: nowSql,
      } as any)
      .where('public_id', '=', publicId)
      .where('status', '=', 'src_locked')
      .execute();
  }

  async rollbackDstLock(publicId: string): Promise<void> {
    await this.db
      .updateTable('orders')
      .set({
        dst_order_id: null, dst_lock_tx: null, dst_lock_block: null, dst_timelock: null,
        resolver_address: null, status: 'src_locked', updated_at: nowSql,
      } as any)
      .where('public_id', '=', publicId)
      .where('status', '=', 'dst_locked')
      .execute();
  }

  // ── Chain cursor operations ───────────────────────────────────────────────

  async getChainCursor(chain: Chain): Promise<number> {
    const row = await this.db
      .selectFrom('chain_cursors')
      .select('position')
      .where('chain', '=', chain)
      .executeTakeFirst();
    return row?.position ?? 0;
  }

  async setChainCursor(chain: Chain, position: number): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    await this.db
      .insertInto('chain_cursors')
      .values({ chain, position, updated_at: now })
      .onConflict((oc) =>
        oc.column('chain').doUpdateSet((eb) => ({
          position: sql`MAX(chain_cursors.position, ${eb.ref('excluded.position')})`,
          updated_at: eb.ref('excluded.updated_at'),
        }))
      )
      .execute();
  }

  async getLastProcessedBlock(chain: Chain): Promise<number> {
    const srcRow = await this.db
      .selectFrom('orders')
      .select((eb) => eb.fn.max('src_lock_block').as('max_block'))
      .where('src_chain', '=', chain)
      .executeTakeFirst();
    const dstRow = await this.db
      .selectFrom('orders')
      .select((eb) => eb.fn.max('dst_lock_block').as('max_block'))
      .where('dst_chain', '=', chain)
      .executeTakeFirst();
    return Math.max(Number(srcRow?.max_block ?? 0), Number(dstRow?.max_block ?? 0));
  }

  async listChainCursors(): Promise<Array<{ chain: Chain; position: number; updatedAt: number }>> {
    const rows = await this.db
      .selectFrom('chain_cursors')
      .selectAll()
      .orderBy('chain', 'asc')
      .execute();
    return rows.map((r) => ({
      chain: r.chain as Chain,
      position: Number(r.position),
      updatedAt: Number(r.updated_at),
    }));
  }

  // ── Soroban checkpoints ───────────────────────────────────────────────────

  async getSorobanCheckpoint(contractId: string): Promise<SorobanCheckpoint | null> {
    const row = await this.db
      .selectFrom('soroban_checkpoints')
      .selectAll()
      .where('contract_id', '=', contractId)
      .executeTakeFirst();
    if (!row) return null;
    return {
      contractId: row.contract_id,
      lastSafeLedger: Number(row.last_safe_ledger),
      effectiveCursor: row.effective_cursor,
      recoveryMarker: row.recovery_marker as SorobanRecoveryMarker,
      updatedAt: Number(row.updated_at),
    };
  }

  async saveSorobanCheckpoint(input: {
    contractId: string;
    lastSafeLedger: number;
    effectiveCursor: string | null;
    recoveryMarker: SorobanRecoveryMarker;
  }): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    await this.db
      .insertInto('soroban_checkpoints')
      .values({
        contract_id: input.contractId,
        last_safe_ledger: input.lastSafeLedger,
        effective_cursor: input.effectiveCursor,
        recovery_marker: input.recoveryMarker,
        updated_at: now,
      })
      .onConflict((oc) =>
        oc.column('contract_id').doUpdateSet((eb) => ({
          last_safe_ledger: sql`CASE WHEN ${eb.ref('excluded.last_safe_ledger')} > soroban_checkpoints.last_safe_ledger THEN ${eb.ref('excluded.last_safe_ledger')} ELSE soroban_checkpoints.last_safe_ledger END`,
          effective_cursor: eb.ref('excluded.effective_cursor'),
          recovery_marker: eb.ref('excluded.recovery_marker'),
          updated_at: eb.ref('excluded.updated_at'),
        }))
      )
      .execute();
  }

  async markSorobanRecovery(contractId: string, marker: SorobanRecoveryMarker): Promise<number> {
    const result = await this.db
      .updateTable('soroban_checkpoints')
      .set({ recovery_marker: marker, updated_at: nowSql } as any)
      .where('contract_id', '=', contractId)
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }

  // ── Expiry / missing-secret helpers ──────────────────────────────────────

  async findExpiredCandidates(nowSeconds: number): Promise<OrderRow[]> {
    const rows = await this.db
      .selectFrom('orders')
      .selectAll()
      .where('status', 'in', ['src_locked', 'dst_locked'])
      .where((eb) =>
        eb.or([
          eb.and([eb('src_timelock', 'is not', null), eb('src_timelock', '<', nowSeconds)]),
          eb.and([eb('dst_timelock', 'is not', null), eb('dst_timelock', '<', nowSeconds)]),
        ])
      )
      .execute();
    return rows.map(rowToOrder);
  }

  async findOrdersMissingSecret(): Promise<
    { publicId: string; srcOrderId: string | null; hashlock: string; status: string }[]
  > {
    const rows = await this.db
      .selectFrom('orders')
      .select(['public_id', 'src_order_id', 'hashlock', 'status'])
      .where('status', 'in', ['src_locked', 'dst_locked'])
      .where('preimage', 'is', null)
      .execute();
    return rows.map((r) => ({
      publicId: r.public_id,
      srcOrderId: r.src_order_id,
      hashlock: r.hashlock,
      status: r.status,
    }));
  }

  async findNonTerminalSample(limit: number): Promise<OrderRow[]> {
    const rows = await this.db
      .selectFrom('orders')
      .selectAll()
      .where('status', 'not in', ['completed', 'refunded', 'failed'])
      .where('archived_at', 'is', null)
      .orderBy('updated_at', 'desc')
      .limit(Math.min(Math.max(limit, 1), 1000))
      .execute();
    return rows.map(rowToOrder);
  }

  // ── Order ledger cursors ─────────────────────────────────────────────────

  async getOrderLedgerCursor(publicId: string): Promise<{
    lastEthBlock: number | null;
    lastSorobanLedger: number | null;
    lastSolanaSlot: number | null;
  } | null> {
    const row = await this.db
      .selectFrom('orders')
      .select(['last_eth_block', 'last_soroban_ledger', 'last_solana_slot'])
      .where('public_id', '=', publicId)
      .executeTakeFirst();
    if (!row) return null;
    return {
      lastEthBlock: row.last_eth_block ?? null,
      lastSorobanLedger: row.last_soroban_ledger ?? null,
      lastSolanaSlot: row.last_solana_slot ?? null,
    };
  }

  async advanceOrderLedgerCursor(
    publicId: string,
    update: { lastEthBlock?: number; lastSorobanLedger?: number; lastSolanaSlot?: number },
  ): Promise<void> {
    const sets: Record<string, any> = { updated_at: nowSql };

    if (update.lastEthBlock != null && update.lastEthBlock > 0) {
      sets.last_eth_block = sql`CASE WHEN last_eth_block IS NULL THEN ${update.lastEthBlock} ELSE MAX(last_eth_block, ${update.lastEthBlock}) END`;
    }
    if (update.lastSorobanLedger != null && update.lastSorobanLedger > 0) {
      sets.last_soroban_ledger = sql`CASE WHEN last_soroban_ledger IS NULL THEN ${update.lastSorobanLedger} ELSE MAX(last_soroban_ledger, ${update.lastSorobanLedger}) END`;
    }
    if (update.lastSolanaSlot != null && update.lastSolanaSlot > 0) {
      sets.last_solana_slot = sql`CASE WHEN last_solana_slot IS NULL THEN ${update.lastSolanaSlot} ELSE MAX(last_solana_slot, ${update.lastSolanaSlot}) END`;
    }

    if (Object.keys(sets).length <= 1) return; // only updated_at, nothing to do

    await this.db
      .updateTable('orders')
      .set(sets)
      .where('public_id', '=', publicId)
      .execute();
  }

  async listOrderLedgerCursors(limit = 200): Promise<Array<{
    publicId: string;
    status: OrderStatus;
    lastEthBlock: number | null;
    lastSorobanLedger: number | null;
    lastSolanaSlot: number | null;
    updatedAt: number;
  }>> {
    const rows = await this.db
      .selectFrom('orders')
      .select(['public_id', 'status', 'last_eth_block', 'last_soroban_ledger', 'last_solana_slot', 'updated_at'])
      .where('archived_at', 'is', null)
      .where((eb) =>
        eb.or([
          eb('last_eth_block', 'is not', null),
          eb('last_soroban_ledger', 'is not', null),
          eb('last_solana_slot', 'is not', null),
        ])
      )
      .orderBy('updated_at', 'desc')
      .limit(Math.min(Math.max(limit, 1), 1000))
      .execute();

    return rows.map((r) => ({
      publicId: r.public_id,
      status: r.status as OrderStatus,
      lastEthBlock: r.last_eth_block ?? null,
      lastSorobanLedger: r.last_soroban_ledger ?? null,
      lastSolanaSlot: r.last_solana_slot ?? null,
      updatedAt: Number(r.updated_at),
    }));
  }

  async updateOrderCursor(publicId: string, chain: Chain, position: number): Promise<void> {
    let col: 'last_eth_block' | 'last_soroban_ledger' | 'last_solana_slot';
    if (chain === 'ethereum') col = 'last_eth_block';
    else if (chain === 'stellar') col = 'last_soroban_ledger';
    else if (chain === 'solana') col = 'last_solana_slot';
    else return;

    await this.db
      .updateTable('orders')
      .set({
        [col]: sql`MAX(COALESCE(${sql.ref(col)}, 0), ${position})`,
        updated_at: nowSql,
      } as any)
      .where('public_id', '=', publicId)
      .execute();
  }

  async getMinActiveOrderCursor(chain: Chain): Promise<number | null> {
    let col: 'last_eth_block' | 'last_soroban_ledger' | 'last_solana_slot';
    if (chain === 'ethereum') col = 'last_eth_block';
    else if (chain === 'stellar') col = 'last_soroban_ledger';
    else if (chain === 'solana') col = 'last_solana_slot';
    else return null;

    const row = await this.db
      .selectFrom('orders')
      .select((eb) => eb.fn.min(col).as('min_cursor'))
      .where((eb) =>
        eb.or([eb('src_chain', '=', chain), eb('dst_chain', '=', chain)])
      )
      .where('status', 'not in', ['completed', 'refunded', 'failed', 'expired'])
      .where(col, 'is not', null)
      .where(col, '>', 0)
      .executeTakeFirst();

    return row?.min_cursor != null ? Number(row.min_cursor) : null;
  }
}
