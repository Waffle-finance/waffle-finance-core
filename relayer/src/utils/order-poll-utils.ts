const TERMINAL_STATUSES = new Set([
  'completed',
  'cancelled',
  'failed',
  'refunded',
  'expired',
  'escrow_creation_failed',
]);

/** Mock / demo orders never need live chain polling. */
const MOCK_STATUSES = new Set(['mock_escrow_created', 'mock_htlc_created']);

const PRE_DEPOSIT_STATUSES = new Set([
  'pending_relayer_escrow',
  'pending_direct_escrow',
  'pending_dst_escrow_deployment',
  'awaiting_xlm_payment',
]);

const DEFAULT_ABANDON_MS = 30 * 60_000;

function parseOrderCreatedMs(created: unknown): number | null {
  if (typeof created === 'number' && Number.isFinite(created)) return created;
  if (typeof created === 'string') {
    const t = Date.parse(created);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

export function hasPendingRelayerEscrow(activeOrders: Map<string, { status?: string }>): boolean {
  for (const order of activeOrders.values()) {
    if (order?.status === 'pending_relayer_escrow') return true;
  }
  return false;
}

export function hasAwaitingXlmPayment(activeOrders: Map<string, { status?: string }>): boolean {
  for (const order of activeOrders.values()) {
    if (order?.status === 'awaiting_xlm_payment') return true;
  }
  return false;
}

/** True while any non-terminal, non-mock order still needs chain listeners. */
export function needsChainMonitoring(activeOrders: Map<string, { status?: string }>): boolean {
  if (activeOrders.size === 0) return false;
  for (const order of activeOrders.values()) {
    const status = order?.status;
    if (!status || TERMINAL_STATUSES.has(status) || MOCK_STATUSES.has(status)) continue;
    return true;
  }
  return false;
}

/** @deprecated Use needsChainMonitoring */
export function hasActiveBridgeOrders(activeOrders: Map<string, { status?: string }>): boolean {
  return needsChainMonitoring(activeOrders);
}

/**
 * Swap forms abandoned before deposit should not keep Infura polling forever
 * (in-memory orders survive until the DO dyno restarts).
 */
export function expireAbandonedOrders(
  activeOrders: Map<string, { status?: string; created?: unknown }>,
  maxAgeMs = DEFAULT_ABANDON_MS
): number {
  const now = Date.now();
  let count = 0;
  for (const order of activeOrders.values()) {
    const status = order?.status;
    if (!status || !PRE_DEPOSIT_STATUSES.has(status)) continue;
    const createdMs = parseOrderCreatedMs(order.created);
    if (createdMs === null || createdMs === undefined || now - createdMs < maxAgeMs) continue;
    order.status = 'expired';
    count++;
  }
  return count;
}
