import type { OrderStatus } from "../persistence/orders-repo.js";
import { orderInvalidTransitions } from "../metrics.js";

/**
 * Allowed transitions for an order's lifecycle.
 *
 * The state machine deliberately does NOT branch on direction
 * (eth->xlm vs xlm->eth) — both directions follow the same conceptual
 * stages:
 *
 *   announced
 *     └─ source side locked → src_locked
 *           └─ destination side locked by resolver → dst_locked
 *                 └─ preimage revealed on either side → secret_revealed
 *                       └─ both sides settled → completed
 *
 *   At any point an order can transition to `refunded` (timelock
 *   expired and the user/cleaner called refund) or `failed` (we
 *   detected a fatal condition we cannot recover from).
 *   `expired` is a soft state used by the UI to show "this order's
 *   timelock has passed without a refund yet".
 *   `cancelled` is set when an operator or user explicitly withdraws an
 *   announced-but-unlocked order.
 *   `abandoned` is set by the stale-cleanup service for announced orders
 *   that received no source-chain lock within the retention window.
 */
const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  announced: ["src_locked", "cancelled", "abandoned", "failed", "expired"],
  src_locked: ["dst_locked", "secret_revealed", "refunded", "failed", "expired"],
  dst_locked: ["secret_revealed", "refunded", "failed", "expired"],
  secret_revealed: ["completed", "refunded", "failed"],
  completed: [],
  refunded: [],
  failed: [],
  expired: ["refunded", "failed"],
  cancelled: [],
  abandoned: [],
};

export class InvalidTransitionError extends Error {
  constructor(public readonly from: OrderStatus, public readonly to: OrderStatus) {
    super(`Invalid order transition: ${from} -> ${to}`);
  }
}

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function requireTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransition(from, to)) {
    // Track invalid transition attempts for observability — a non-zero
    // rate here indicates a bug in the listener or manual operator action.
    orderInvalidTransitions.inc({ from, to });
    throw new InvalidTransitionError(from, to);
  }
}

export function isTerminal(status: OrderStatus): boolean {
  return TRANSITIONS[status].length === 0;
}
