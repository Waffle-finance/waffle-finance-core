/**
 * @file order-intake.ts
 *
 * Composes the per-order safety layers in front of every resolver event
 * handler:
 *
 *   ResolverWorkLimiter   — dedup, per-order budget, per-chain concurrency (#1096)
 *   OrderEligibilityGate  — registry standing: new work vs in-flight duties (#1097)
 *   ResolverKeyRing       — which signing key owns the order (#1091)
 *
 * The handler body only runs when all three agree, and receives the signer
 * bound to the order (when the chain has a key ring).
 */

import type { Logger } from "pino";
import type { ResolverWorkLimiter, WorkOutcome } from "./work-limiter.js";
import type { Eligibility, OrderEligibilityGate, RecoveryAction } from "./order-eligibility.js";
import type { ResolverKeyRing, ResolverSigner } from "./key-rotation.js";

export type IntakeResult =
  | { status: "processed" }
  | { status: "skipped"; reason: string }
  | Exclude<WorkOutcome<unknown>, { status: "completed" }>;

export type IntakeHandler = (signer: ResolverSigner | undefined) => Promise<void> | void;

export interface ResolverOrderIntakeOptions {
  limiter: ResolverWorkLimiter;
  gate: OrderEligibilityGate;
  keyRings?: ReadonlyMap<string, ResolverKeyRing>;
  log: Logger;
}

type Inner = { status: "processed" } | { status: "skipped"; reason: string };

/** Skipped work is not remembered, so a replay after eligibility returns can run. */
const REMEMBER_PROCESSED = { remember: (v: Inner) => v.status === "processed" };

export class ResolverOrderIntake {
  private readonly limiter: ResolverWorkLimiter;
  private readonly gate: OrderEligibilityGate;
  private readonly keyRings: ReadonlyMap<string, ResolverKeyRing>;
  private readonly log: Logger;

  constructor(opts: ResolverOrderIntakeOptions) {
    this.limiter = opts.limiter;
    this.gate = opts.gate;
    this.keyRings = opts.keyRings ?? new Map();
    this.log = opts.log.child({ component: "ResolverOrderIntake" });
  }

  /** A new order was observed: take it only if the resolver is eligible. */
  async onOrderCreated(chain: string, orderId: string, handler: IntakeHandler): Promise<IntakeResult> {
    return this.unwrap(
      await this.limiter.run({ chain, action: "order_created", orderId }, async (): Promise<Inner> => {
        const decision = this.gate.accept(chain, orderId);
        if (!decision.eligible) return skipped(decision);
        const ring = this.keyRings.get(chain);
        try {
          const signer = ring?.signerForNewOrder(orderId);
          await handler(signer);
        } catch (err) {
          // The order was never taken on: drop the acceptance and key binding
          // so a retry starts from scratch instead of inheriting stale state.
          this.gate.complete(chain, orderId);
          ring?.releaseOrder(orderId);
          throw err;
        }
        return { status: "processed" };
      }, REMEMBER_PROCESSED)
    );
  }

  /**
   * A settlement duty (claim or refund) for an order.  In-flight orders are
   * always served with the key they were accepted with.  On success the order
   * is released from the gate and the key ring.
   */
  async onSettlement(
    chain: string,
    orderId: string,
    action: RecoveryAction,
    handler: IntakeHandler
  ): Promise<IntakeResult> {
    return this.unwrap(
      await this.limiter.run({ chain, action, orderId }, async (): Promise<Inner> => {
        const decision = this.gate.checkRecovery(chain, orderId, action);
        if (!decision.eligible) return skipped(decision);
        const ring = this.keyRings.get(chain);
        const signer = ring?.signerForOrder(orderId, action);
        await handler(signer);
        this.gate.complete(chain, orderId);
        ring?.releaseOrder(orderId);
        return { status: "processed" };
      }, REMEMBER_PROCESSED)
    );
  }

  private unwrap(outcome: WorkOutcome<Inner>): IntakeResult {
    if (outcome.status === "completed") return outcome.value;
    this.log.debug({ outcome }, "order work not executed");
    return outcome;
  }
}

function skipped(d: Extract<Eligibility, { eligible: false }>): Inner {
  return { status: "skipped", reason: d.reason };
}
