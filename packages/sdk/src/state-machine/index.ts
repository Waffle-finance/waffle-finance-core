import type { OrderStatus } from "../types/index.js";

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
    throw new InvalidTransitionError(from, to);
  }
}

export function isTerminal(status: OrderStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

export function nextStatesOf(status: OrderStatus): OrderStatus[] {
  return [...TRANSITIONS[status]];
}
