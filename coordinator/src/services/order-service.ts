import type { Logger } from "pino";
import {
  OrdersRepository,
  type OrderRow,
  type OrderHistoryResult,
  type AnnounceOrderInput,
  type Chain,
  type OrderStatus,
  type SorobanCheckpoint,
  type SorobanRecoveryMarker
} from "../persistence/orders-repo.js";
import { canTransition, isTerminal } from "../state-machine/order-machine.js";
import {
  ordersTotal,
  orderLifecycleTransitions,
  orderStateDuration,
  orderCurrentState,
  resolverLockActionsTotal,
  ordersExpiredSkippedTotal,
  ordersExpiredTerminalSkippedTotal,
  reconciliationEventsSkipped,
} from "../metrics.js";
import { announceSchema, type AnnounceInput } from "../validation/announce.js";
import { HistoryCache } from "./history-cache.js";
import type { AuditRepository } from "../audit/audit-repo.js";
import { buildOrderAuditEntry } from "../audit/audit-log.js";
import { getRequestId } from "../request-context.js";

// Re-exported so existing importers (routes, services barrel) keep working
// while the schema itself now lives in the shared validation module.
export { announceSchema };
export type { AnnounceInput };

export class OrderValidationError extends Error {}

/* ── Observability helpers ───────────────────────────────────────────────── */

/**
 * Record lifecycle transition metrics for an order moving from one state
 * to another.  Updates:
 *  - `orderLifecycleTransitions` counter (direction, from, to)
 *  - `orderStateDuration` histogram for the time spent in the previous state
 *  - `orderCurrentState` gauge (+1 for the new state, -1 for the old state)
 *  - `ordersTotal` counter (cumulative count per status)
 */
function recordTransition(
  direction: string,
  from: OrderStatus,
  to: OrderStatus,
  updatedAtSeconds: number
): void {
  // Per-transition counter.
  orderLifecycleTransitions.inc({ direction, from, to });

  // Time in previous state: updatedAt is the timestamp the NEW state is being
  // recorded, so we approximate duration using `createdAt` in the actual
  // call sites.  This is a placeholder; the call site passes the order's
  // `updatedAt` as a proxy for when the order entered `from`.
  orderStateDuration.observe({ direction, state: from }, Math.max(Date.now() / 1000 - updatedAtSeconds, 0));

  // Update instantaneous state distribution.
  orderCurrentState.dec({ direction, state: from });
  orderCurrentState.inc({ direction, state: to });
}

export class OrderService {
  private readonly historyCache: HistoryCache;

  constructor(
    private readonly repo: OrdersRepository,
    private readonly log: Logger,
    options: { enableCache?: boolean; cacheTtlMs?: number; auditRepo?: AuditRepository } = {},
    private readonly auditRepo?: AuditRepository
  ) {
    this.auditRepo = options.auditRepo;
    // Initialize cache if enabled (default: enabled)
    if (options.enableCache !== false) {
      this.historyCache = new HistoryCache(log.child({ component: 'history-cache' }), {
        ttlMs: options.cacheTtlMs
      });
    } else {
      this.historyCache = new HistoryCache(log, { ttlMs: 0 }); // Disabled cache
    }
  }

  /** Fire-and-forget audit write — never throws into the caller. */
  private audit(entry: Parameters<AuditRepository['append']>[0]): void {
    if (!this.auditRepo) return;
    this.auditRepo.append(entry).catch((err: unknown) => {
      this.log.warn({ err }, 'audit write failed (non-fatal)');
    });
  }

  /**
   * Record a new order announcement. The coordinator does NOT lock any
   * funds — it simply records the intent so the order book is visible
   * to all resolvers and the user can later attach the on-chain
   * `srcOrderId` once they have locked.
   */
  async announce(input: AnnounceInput): Promise<OrderRow> {
    // Field-shape, address and direction/chain validation is enforced by
    // `announceSchema` at the route boundary; the service only owns the
    // business-level uniqueness check below.
    const existing = await this.repo.findByHashlock(input.hashlock);
    if (existing) {
      throw new OrderValidationError(
        `An order with hashlock ${input.hashlock} already exists (publicId=${existing.publicId})`
      );
    }

    const order = await this.repo.announce(input as AnnounceOrderInput);
    this.log.info(
      { publicId: order.publicId, direction: order.direction, hashlock: order.hashlock },
      "order announced"
    );

    // ── Observability ───────────────────────────────────────────────────
    // The order enters the system in the "announced" state.  Since there is
    // no previous state to decrement, we only increment the new state gauge
    // and the cumulative total counter.
    ordersTotal.inc({ status: "announced", direction: order.direction });
    orderLifecycleTransitions.inc({ direction: order.direction, from: "none", to: "announced" });
    orderCurrentState.inc({ direction: order.direction, state: "announced" });
    
    // Invalidate cache for both source and destination addresses
    this.historyCache.invalidateAddress(order.srcAddress);
    this.historyCache.invalidateAddress(order.dstAddress);
    
    return order;
  }

  get(publicId: string): Promise<OrderRow | null> {
    return this.repo.findByPublicId(publicId);
  }

  history(address: string, limit?: number, offset?: number): Promise<OrderRow[]> {
    const finalLimit = Math.min(Math.max(limit ?? 50, 1), 200);
    const finalOffset = Math.max(offset ?? 0, 0);

    // Use cache for offset-based pages as well by encoding offset into the cursor string
    const cursorForCache = `offset:${finalOffset}`;
    const cached = this.historyCache.get(address, finalLimit, cursorForCache);
    if (cached) {
      this.log.debug({ address, limit: finalLimit, offset: finalOffset }, "Cache hit for offset history request");
      return Promise.resolve(cached.orders);
    }

    return this.repo.findByAddress(address, finalLimit, finalOffset).then((rows) => {
      if (rows.length > 0) {
        // store a synthetic OrderHistoryResult for uniformity
        this.historyCache.set(address, finalLimit, cursorForCache, { orders: rows, nextCursor: null });
      }
      return rows;
    });
  }

  /**
   * Get order history for an address using cursor-based pagination.
   * More efficient and consistent than offset pagination for large datasets.
   */
  async historyWithCursor(address: string, limit = 50, cursor?: string): Promise<OrderHistoryResult> {
    // Enforce sane limits at service boundary
    const finalLimit = Math.min(Math.max(limit, 1), 200);

    // Check cache first (cache key uses finalLimit)
    const cached = this.historyCache.get(address, finalLimit, cursor);
    if (cached) {
      this.log.debug({ address, limit: finalLimit, cursor: cursor || 'first' }, "Cache hit for history request");
      return cached;
    }

    // Cache miss - fetch from database
    this.log.debug({ address, limit: finalLimit, cursor: cursor || 'first' }, "Cache miss for history request");
    const result = await this.repo.findByAddressWithCursor(address, finalLimit, cursor);

    // Cache the result (only cache non-empty pages to avoid caching many empty results)
    if (result.orders.length > 0) {
      this.historyCache.set(address, finalLimit, cursor, result);
    }

    return result;
  }

  findByHashlock(hashlock: string): Promise<OrderRow | null> {
    return this.repo.findByHashlock(hashlock);
  }

  findBySrcOrderId(chain: Chain, orderId: string): Promise<OrderRow | null> {
    return this.repo.findBySrcOrderId(chain, orderId);
  }

  async recordSrcLock(input: {
    publicId: string;
    orderId: string;
    txHash: string;
    blockNumber: number;
    timelock: number;
  }): Promise<void> {
    const order = await this.repo.findByPublicId(input.publicId);
    if (!order) throw new OrderValidationError(`unknown order ${input.publicId}`);

    // Idempotency check
    if (order.srcOrderId === input.orderId && order.srcLockTx === input.txHash) {
      this.log.info({ publicId: input.publicId, srcOrderId: input.orderId }, "duplicate src lock ignored");
      return;
    }
    if (
      order.srcOrderId !== null &&
      (order.srcOrderId !== input.orderId || order.srcLockTx !== input.txHash)
    ) {
      throw new OrderValidationError(
        `conflicting src lock for ${input.publicId}: existing=${order.srcOrderId}/${order.srcLockTx} incoming=${input.orderId}/${input.txHash}`
      );
    }

    // Terminal-state guard — a replay or late event must not back-fill src lock
    // data onto an order that has already reached a terminal state.
    if (isTerminal(order.status)) {
      throw new OrderValidationError(
        `cannot record src lock for terminal order ${input.publicId} (status=${order.status})`
      );
    }

    if (!canTransition(order.status, "src_locked") && order.status !== "src_locked") {
      throw new OrderValidationError(`cannot record src lock from status ${order.status}`);
    }
    await this.repo.recordSrcLock(input);
    this.log.info({ publicId: input.publicId, srcOrderId: input.orderId }, "src lock recorded");

    // ── Observability ───────────────────────────────────────────────────
    recordTransition(order.direction, order.status, "src_locked", order.updatedAt);
    ordersTotal.inc({ status: "src_locked", direction: order.direction });
    
    // Invalidate cache for both addresses since order status changed
    this.historyCache.invalidateAddress(order.srcAddress);
    this.historyCache.invalidateAddress(order.dstAddress);
  }

  async recordDstLock(input: {
    publicId: string;
    orderId: string;
    txHash: string;
    blockNumber: number;
    timelock: number;
    resolver: string | null;
  }): Promise<void> {
    const order = await this.repo.findByPublicId(input.publicId);
    if (!order) throw new OrderValidationError(`unknown order ${input.publicId}`);

    // Idempotency check — exact duplicate is a no-op.
    if (order.dstOrderId === input.orderId && order.dstLockTx === input.txHash) {
      this.log.info({ publicId: input.publicId, dstOrderId: input.orderId }, "duplicate dst lock ignored");
      return;
    }

    // Conflict detection — a different dstOrderId or txHash means two
    // listeners (or a replay) are trying to record conflicting dst lock data.
    // The first write wins; later conflicting writes are rejected with a
    // structured error so callers can emit the appropriate metric.
    if (
      order.dstOrderId !== null &&
      (order.dstOrderId !== input.orderId || order.dstLockTx !== input.txHash)
    ) {
      throw new OrderValidationError(
        `conflicting dst lock for ${input.publicId}: existing=${order.dstOrderId}/${order.dstLockTx} incoming=${input.orderId}/${input.txHash}`
      );
    }

    // Terminal-state guard — once an order reaches completed/refunded/failed
    // it must not be moved backwards by a late dst-lock event.
    if (isTerminal(order.status)) {
      throw new OrderValidationError(
        `cannot record dst lock for terminal order ${input.publicId} (status=${order.status})`
      );
    }

    if (!canTransition(order.status, "dst_locked") && order.status !== "dst_locked") {
      throw new OrderValidationError(`cannot record dst lock from status ${order.status}`);
    }
    await this.repo.recordDstLock(input);
    this.log.info({ publicId: input.publicId, dstOrderId: input.orderId, resolver: input.resolver }, "dst lock recorded");

    // ── Observability ───────────────────────────────────────────────────
    recordTransition(order.direction, order.status, "dst_locked", order.updatedAt);
    ordersTotal.inc({ status: "dst_locked", direction: order.direction });
    
    // Invalidate cache for both addresses since order status changed
    this.historyCache.invalidateAddress(order.srcAddress);
    this.historyCache.invalidateAddress(order.dstAddress);

    if (input.resolver) {
      resolverLockActionsTotal.inc({ resolver_address: input.resolver, action: "dst_lock" });
    }
  }

  async recordSecret(publicId: string, preimage: string, txHash: string, encVersion: number | null = null): Promise<void> {
    const order = await this.repo.findByPublicId(publicId);
    if (!order) throw new OrderValidationError(`unknown order ${publicId}`);

    // Idempotency check
    if (order.preimage === preimage) {
      this.log.info({ publicId }, "duplicate secret ignored");
      return;
    }
    if (order.preimage !== null && order.preimage !== preimage) {
      throw new OrderValidationError(
        `conflicting preimage for ${publicId}: existing=${order.preimage} incoming=${preimage}`
      );
    }

    // Terminal-state guard — once completed/refunded/failed the secret is
    // already known or irrelevant; reject to preserve determinism.
    if (isTerminal(order.status)) {
      throw new OrderValidationError(
        `cannot record secret for terminal order ${publicId} (status=${order.status})`
      );
    }

    if (!canTransition(order.status, "secret_revealed") && order.status !== "secret_revealed") {
      throw new OrderValidationError(`cannot record secret from status ${order.status}`);
    }
    await this.repo.recordSecretRevealed({ publicId, preimage, txHash, encVersion });
    this.log.info({ publicId }, "secret recorded");

    // ── Observability ───────────────────────────────────────────────────
    recordTransition(order.direction, order.status, "secret_revealed", order.updatedAt);
    ordersTotal.inc({ status: "secret_revealed", direction: order.direction });
    
    // Invalidate cache for both addresses since order status changed
    this.historyCache.invalidateAddress(order.srcAddress);
    this.historyCache.invalidateAddress(order.dstAddress);
  }

  async markStatus(publicId: string, status: OrderRow["status"]): Promise<void> {
    const order = await this.repo.findByPublicId(publicId);
    if (!order) throw new OrderValidationError(`unknown order ${publicId}`);

    // Idempotency check
    if (order.status === status) {
      this.log.info({ publicId, status }, "duplicate status update ignored");
      return;
    }

    // Terminal-state guard — explicit early error with a clear message rather
    // than relying on canTransition returning false, which would produce a
    // generic "cannot transition" message that conflates this case with
    // out-of-order events.
    if (isTerminal(order.status)) {
      throw new OrderValidationError(
        `cannot transition terminal order ${publicId} from ${order.status} to ${status}`
      );
    }

    if (!canTransition(order.status, status)) {
      throw new OrderValidationError(`cannot transition from ${order.status} to ${status}`);
    }
    await this.repo.setStatus(publicId, status);
    this.log.info({ publicId, status }, "status updated");

    // ── Observability ───────────────────────────────────────────────────
    recordTransition(order.direction, order.status, status, order.updatedAt);
    ordersTotal.inc({ status, direction: order.direction });
    
    // Invalidate cache for both addresses since order status changed
    this.historyCache.invalidateAddress(order.srcAddress);
    this.historyCache.invalidateAddress(order.dstAddress);
  }

  async rollbackSrcLock(publicId: string): Promise<void> {
    await this.repo.rollbackSrcLock(publicId);
    this.log.warn({ publicId }, "rolled back src lock");
    this.audit(buildOrderAuditEntry('order.src_lock_rolled_back', {
      orderId: publicId,
      hashlock: '',
      direction: '',
      fromStatus: 'src_locked',
      toStatus: 'announced',
      srcChain: '',
      dstChain: '',
      detail: 'reorg or duplicate event triggered rollback',
      requestId: getRequestId(),
    }));
  }

  async rollbackDstLock(publicId: string): Promise<void> {
    await this.repo.rollbackDstLock(publicId);
    this.log.warn({ publicId }, "rolled back dst lock");
    this.audit(buildOrderAuditEntry('order.dst_lock_rolled_back', {
      orderId: publicId,
      hashlock: '',
      direction: '',
      fromStatus: 'dst_locked',
      toStatus: 'src_locked',
      srcChain: '',
      dstChain: '',
      detail: 'reorg or duplicate event triggered rollback',
      requestId: getRequestId(),
    }));
  }

  async getLastProcessedBlock(chain: Chain): Promise<number> {
    return this.repo.getLastProcessedBlock(chain);
  }

  async getChainCursor(chain: Chain): Promise<number> {
    return this.repo.getChainCursor(chain);
  }

  async setChainCursor(chain: Chain, position: number): Promise<void> {
    return this.repo.setChainCursor(chain, position);
  }

  // ── Soroban listener checkpoints ──────────────────────────────────────────
  // Thin delegators over the persistence adapter so the Soroban listener can
  // load/persist its durable checkpoint without a direct database handle,
  // mirroring the getChainCursor/setChainCursor pattern above.

  getSorobanCheckpoint(contractId: string): Promise<SorobanCheckpoint | null> {
    return this.repo.getSorobanCheckpoint(contractId);
  }

  saveSorobanCheckpoint(input: {
    contractId: string;
    lastSafeLedger: number;
    effectiveCursor: string | null;
    recoveryMarker: SorobanRecoveryMarker;
  }): Promise<void> {
    return this.repo.saveSorobanCheckpoint(input);
  }

  markSorobanRecovery(
    contractId: string,
    marker: SorobanRecoveryMarker
  ): Promise<number> {
    return this.repo.markSorobanRecovery(contractId, marker);
  }

  findOrdersMissingSecret(): Promise<
    { publicId: string; srcOrderId: string | null; hashlock: string; status: string }[]
  > {
    return this.repo.findOrdersMissingSecret();
  }

  /**
   * Scan for orders whose timelock has passed and mark them `expired`.
   *
   * This is **timelock-based expiry** — distinct from stale-cleanup (which
   * archives orphaned announced orders that never received a source lock).
   * Timelock-based expiry operates on `src_locked`, `dst_locked`, and
   * `secret_revealed` orders whose timelock has elapsed; the order can still
   * transition to `refunded` or `failed` afterwards.
   *
   * The scan deliberately skips terminal orders (completed / refunded / failed)
   * — see `findExpiredCandidates`.
   *
   * Returns the number of orders successfully transitioned to `expired`.
   */
  async expireStaleOrders(nowSeconds?: number): Promise<number> {
    const now = nowSeconds ?? Math.floor(Date.now() / 1000);
    const candidates = await this.repo.findExpiredCandidates(now);
    let count = 0;
    for (const order of candidates) {
      // Fast idempotency path: if the order is already expired, skip it and
      // emit a metric rather than calling markStatus (which would throw).
      if (order.status === "expired") {
        ordersExpiredSkippedTotal.inc();
        this.log.debug(
          { publicId: order.publicId },
          "expireStaleOrders: order already expired — skipping (idempotent)"
        );
        continue;
      }

      // Terminal state guard: the candidate query should never return terminal
      // orders, but defend in depth.  If one slips through, skip with a metric
      // rather than throwing into the scan loop.
      if (isTerminal(order.status)) {
        ordersExpiredTerminalSkippedTotal.inc();
        this.log.warn(
          { publicId: order.publicId, status: order.status },
          "expireStaleOrders: candidate is already terminal — skipping (candidate query drift)"
        );
        continue;
      }

      try {
        await this.markStatus(order.publicId, "expired");
        this.log.info(
          { publicId: order.publicId, status: order.status },
          "order marked expired by timelock (expireStaleOrders)"
        );
        count++;
      } catch (err: any) {
        this.log.warn(
          { publicId: order.publicId, err: err?.message },
          "expireStaleOrders: cannot expire order — skipping"
        );
      }
    }
    return count;
  }

  /**
   * Get cache statistics for monitoring
   */
  getCacheStats() {
    return this.historyCache.getStats();
  }

  /**
   * Cleanup resources
   */
  destroy(): void {
    this.historyCache.destroy();
  }
}
