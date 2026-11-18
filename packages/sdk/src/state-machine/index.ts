import type { OrderStatus } from "../types/index.js";

/**
 * Canonical order lifecycle transition table.
 *
 * This is the single source of truth for which transitions an order may
 * take. The coordinator's state machine (`order-machine.ts`) is pinned to
 * this table by a conformance test, so a transition added here without
 * being mirrored backend-side fails at test time instead of at runtime.
 */
export const ORDER_STATUS_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
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

const TRANSITIONS = ORDER_STATUS_TRANSITIONS as Record<OrderStatus, OrderStatus[]>;

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: OrderStatus,
    public readonly to: OrderStatus,
    public readonly reason?: string
  ) {
    super(
      `Invalid order transition: ${from} -> ${to}` +
        (reason ? ` (${reason})` : "")
    );
  }
}

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function requireTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransition(from, to)) {
    throw new InvalidTransitionError(from, to);
  }
}

/**
 * Guard rail validations for critical transition patterns.
 * These catch common integration bugs where services bypass lifecycle checks.
 */
export function validateTransitionGuards(
  from: OrderStatus,
  to: OrderStatus,
  context?: {
    srcLocked?: boolean;
    dstLocked?: boolean;
    secretRevealed?: boolean;
  }
): void {
  // Guard: cannot complete an order that was never locked
  if (to === "completed") {
    if (!context?.srcLocked) {
      throw new InvalidTransitionError(from, to, "source leg was never locked");
    }
    if (!context?.dstLocked) {
      throw new InvalidTransitionError(from, to, "destination leg was never locked");
    }
    if (!context?.secretRevealed) {
      throw new InvalidTransitionError(from, to, "secret was never revealed");
    }
  }

  // Guard: cannot refund before source lock occurs
  if (to === "refunded" && from === "announced") {
    throw new InvalidTransitionError(from, to, "cannot refund before source lock");
  }

  // Guard: cannot transition from terminal states
  if (isTerminal(from) && from !== to) {
    throw new InvalidTransitionError(from, to, `${from} is a terminal state`);
  }
}

/**
 * Full transition validation with guard rails.
 * Use this in coordinator and services for comprehensive validation.
 */
export function requireValidTransition(
  from: OrderStatus,
  to: OrderStatus,
  context?: {
    srcLocked?: boolean;
    dstLocked?: boolean;
    secretRevealed?: boolean;
  }
): void {
  requireTransition(from, to);
  validateTransitionGuards(from, to, context);
}

export function isTerminal(status: OrderStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

export function nextStatesOf(status: OrderStatus): OrderStatus[] {
  return [...TRANSITIONS[status]];
}

/**
 * Get all valid transitions in the order lifecycle.
 * Useful for documentation and testing.
 */
export function getAllTransitions(): Record<OrderStatus, OrderStatus[]> {
  return { ...TRANSITIONS };
}
