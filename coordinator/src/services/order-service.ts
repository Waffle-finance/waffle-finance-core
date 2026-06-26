import type { Logger } from "pino";
import {
  OrdersRepository,
  type OrderRow,
  type AnnounceOrderInput,
  type Chain
} from "../persistence/orders-repo.js";
import { canTransition } from "../state-machine/order-machine.js";
import { ordersTotal } from "../metrics.js";
import { announceSchema, type AnnounceInput } from "../validation/announce.js";

// Re-exported so existing importers (routes, services barrel) keep working
// while the schema itself now lives in the shared validation module.
export { announceSchema };
export type { AnnounceInput };

export class OrderValidationError extends Error {}

export class OrderService {
  constructor(
    private readonly repo: OrdersRepository,
    private readonly log: Logger
  ) {}

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
    ordersTotal.inc({ status: "announced" });
    return order;
  }

  get(publicId: string): Promise<OrderRow | null> {
    return this.repo.findByPublicId(publicId);
  }

  history(address: string, limit?: number, offset?: number): Promise<OrderRow[]> {
    return this.repo.findByAddress(address, limit, offset);
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
    if (!canTransition(order.status, "src_locked") && order.status !== "src_locked") {
      throw new OrderValidationError(`cannot record src lock from status ${order.status}`);
    }
    await this.repo.recordSrcLock(input);
    this.log.info({ publicId: input.publicId, srcOrderId: input.orderId }, "src lock recorded");
    ordersTotal.inc({ status: "src_locked" });
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
    if (!canTransition(order.status, "dst_locked") && order.status !== "dst_locked") {
      throw new OrderValidationError(`cannot record dst lock from status ${order.status}`);
    }
    await this.repo.recordDstLock(input);
    this.log.info({ publicId: input.publicId, dstOrderId: input.orderId }, "dst lock recorded");
    ordersTotal.inc({ status: "dst_locked" });
  }

  async recordSecret(publicId: string, preimage: string, txHash: string, encVersion: number | null = null): Promise<void> {
    const order = await this.repo.findByPublicId(publicId);
    if (!order) throw new OrderValidationError(`unknown order ${publicId}`);
    if (!canTransition(order.status, "secret_revealed") && order.status !== "secret_revealed") {
      throw new OrderValidationError(`cannot record secret from status ${order.status}`);
    }
    await this.repo.recordSecretRevealed({ publicId, preimage, txHash, encVersion });
    this.log.info({ publicId }, "secret recorded");
    ordersTotal.inc({ status: "secret_revealed" });
  }

  async markStatus(publicId: string, status: OrderRow["status"]): Promise<void> {
    const order = await this.repo.findByPublicId(publicId);
    if (!order) throw new OrderValidationError(`unknown order ${publicId}`);
    if (!canTransition(order.status, status)) {
      throw new OrderValidationError(`cannot transition from ${order.status} to ${status}`);
    }
    await this.repo.setStatus(publicId, status);
    this.log.info({ publicId, status }, "status updated");
    ordersTotal.inc({ status });
  }

  async rollbackSrcLock(publicId: string): Promise<void> {
    await this.repo.rollbackSrcLock(publicId);
    this.log.warn({ publicId }, "rolled back src lock");
  }

  async rollbackDstLock(publicId: string): Promise<void> {
    await this.repo.rollbackDstLock(publicId);
    this.log.warn({ publicId }, "rolled back dst lock");
  }

  async getLastProcessedBlock(chain: Chain): Promise<number> {
    return this.repo.getLastProcessedBlock(chain);
  }

  findOrdersMissingSecret(): Promise<
    { publicId: string; srcOrderId: string | null; hashlock: string; status: string }[]
  > {
    return this.repo.findOrdersMissingSecret();
  }

  /**
   * Scan for orders whose timelock has passed and mark them `expired`.
   *
   * `expired` is a soft, non-terminal state: the order can still be
   * refunded or fail afterwards.  The scan deliberately skips terminal
   * orders (completed / refunded / failed) — see `findExpiredCandidates`.
   *
   * Returns the number of orders that were successfully transitioned.
   */
  async expireStaleOrders(nowSeconds?: number): Promise<number> {
    const now = nowSeconds ?? Math.floor(Date.now() / 1000);
    const candidates = await this.repo.findExpiredCandidates(now);
    let count = 0;
    for (const order of candidates) {
      try {
        await this.markStatus(order.publicId, "expired");
        this.log.info({ publicId: order.publicId }, "order marked expired by timelock");
        count++;
      } catch (err: any) {
        this.log.warn(
          { publicId: order.publicId, err: err?.message },
          "cannot expire order — skipping"
        );
      }
    }
    return count;
  }
}
