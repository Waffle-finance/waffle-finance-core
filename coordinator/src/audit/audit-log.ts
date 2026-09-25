/**
 * @file audit-log.ts
 *
 * Durable, replayable audit log for the WaffleFinance coordinator.
 *
 * Design goals
 * ────────────
 * 1. Every significant order lifecycle transition and recovery action is
 *    recorded as an immutable AuditEntry row.
 * 2. Each entry carries a stable correlation anchor (orderId / requestId)
 *    so every event can be tied back to the originating order.
 * 3. The log is append-only — existing rows are never mutated.
 * 4. The stream can be replayed or exported without a live database session
 *    (see audit-exporter.ts).
 * 5. The schema is versioned so consumers can detect format changes.
 */

// ─── Schema version ───────────────────────────────────────────────────────────

/** Increment when the AuditEntry payload shape changes in a breaking way. */
export const AUDIT_SCHEMA_VERSION = 1 as const;

// ─── Event types ─────────────────────────────────────────────────────────────

/**
 * Exhaustive union of every audit event type the coordinator emits.
 *
 * Naming convention:  <noun>.<verb>  (noun = entity, verb = past-tense action)
 *
 * ORDER lifecycle events mirror the state machine in order-machine.ts:
 *   announced → src_locked → dst_locked → secret_revealed → completed
 *   Any state → refunded | failed | expired
 *
 * RECOVERY events reflect coordinator/relayer internal repair actions.
 * SYSTEM events reflect service-level operational changes.
 */
export type AuditEventType =
  // Order lifecycle — forward transitions
  | 'order.announced'
  | 'order.src_locked'
  | 'order.dst_locked'
  | 'order.secret_revealed'
  | 'order.completed'
  // Order lifecycle — terminal/recovery transitions
  | 'order.refunded'
  | 'order.failed'
  | 'order.expired'
  // Recovery actions
  | 'order.src_lock_rolled_back'
  | 'order.dst_lock_rolled_back'
  | 'order.secret_recovered'
  | 'order.stale_archived'
  // Reconciliation
  | 'reconciliation.started'
  | 'reconciliation.completed'
  | 'reconciliation.gap_detected'
  | 'reconciliation.order_repaired'
  // System / operational
  | 'system.startup'
  | 'system.shutdown'
  | 'system.listener_error'
  | 'system.db_migration';

/**
 * Exhaustive runtime list of every `AuditEventType` value, kept in sync with
 * the union above. Used to validate untrusted input (e.g. query params)
 * against the known event taxonomy without duplicating the list elsewhere.
 */
export const AUDIT_EVENT_TYPES: readonly AuditEventType[] = [
  'order.announced',
  'order.src_locked',
  'order.dst_locked',
  'order.secret_revealed',
  'order.completed',
  'order.refunded',
  'order.failed',
  'order.expired',
  'order.src_lock_rolled_back',
  'order.dst_lock_rolled_back',
  'order.secret_recovered',
  'order.stale_archived',
  'reconciliation.started',
  'reconciliation.completed',
  'reconciliation.gap_detected',
  'reconciliation.order_repaired',
  'system.startup',
  'system.shutdown',
  'system.listener_error',
  'system.db_migration',
] as const;

// ─── Payload shapes ───────────────────────────────────────────────────────────

/** Payload attached to every order.* event. */
export interface OrderEventPayload {
  /** Coordinator-assigned public order identifier (wf_0x…). */
  orderId: string;
  /** Stable hashlock that ties the order to on-chain HTLCs. */
  hashlock: string;
  /** Direction of the swap at announcement time. */
  direction: string;
  /** The status the order moved TO as a result of this event. */
  toStatus: string;
  /** The status the order was in BEFORE this event (null for announced). */
  fromStatus: string | null;
  /** On-chain transaction hash that triggered this transition, if any. */
  txHash: string | null;
  /** Block number at which the triggering tx was included, if known. */
  blockNumber: number | null;
  /** Source chain identifier. */
  srcChain: string;
  /** Destination chain identifier. */
  dstChain: string;
  /** Resolver address involved in the transition, if any. */
  resolverAddress: string | null;
  /** Free-form additional context (e.g. rollback reason, recovery source). */
  detail: string | null;
}

export interface ReconciliationEventPayload {
  chain: string;
  blocksScanned: number | null;
  ordersInspected: number | null;
  ordersRepaired: number | null;
  gapStartBlock: number | null;
  gapEndBlock: number | null;
  durationMs: number | null;
  detail: string | null;
}

export interface SystemEventPayload {
  detail: string;
  errorMessage: string | null;
  /** Semver string of the coordinator binary, if available. */
  serviceVersion: string | null;
}

/** Discriminated union of all possible audit payloads. */
export type AuditPayload =
  | OrderEventPayload
  | ReconciliationEventPayload
  | SystemEventPayload;

// ─── Core entry type ──────────────────────────────────────────────────────────

/**
 * An AuditEntry is the single unit of the audit stream.
 * Once written, it is never mutated.
 */
export interface AuditEntry {
  /** Auto-incremented DB surrogate key — used as a stable replay cursor. */
  id: number;
  /**
   * Schema version of this entry's payload shape.
   * Consumers must reject entries whose schemaVersion > their supported max.
   */
  schemaVersion: typeof AUDIT_SCHEMA_VERSION;
  /** Event classification. */
  eventType: AuditEventType;
  /**
   * Primary correlation anchor.
   * For order.* events: the coordinator public_id (wf_0x…).
   * For other events: a descriptive identifier (e.g. 'reconciler', 'startup').
   */
  orderId: string | null;
  /**
   * Secondary correlation anchor.
   * Populated when the event originates inside an HTTP request context
   * (see coordinator/src/request-context.ts).
   */
  requestId: string | null;
  /** Serialised AuditPayload — stored as JSON text in the database. */
  payloadJson: string;
  /** Unix epoch seconds — set by the database DEFAULT, not by the app. */
  createdAt: number;
}

// ─── Input type for writing ───────────────────────────────────────────────────

/**
 * Everything the caller must supply when writing an audit entry.
 * `id`, `schemaVersion`, and `createdAt` are set automatically.
 */
export type AuditEntryInput = Omit<AuditEntry, 'id' | 'schemaVersion' | 'createdAt'>;

// ─── Builder helpers ──────────────────────────────────────────────────────────

/**
 * Build an AuditEntryInput for an order lifecycle transition.
 *
 * @example
 * const entry = buildOrderAuditEntry('order.src_locked', order, {
 *   txHash: '0xabc…',
 *   blockNumber: 12345678,
 * });
 */
export function buildOrderAuditEntry(
  eventType: Extract<AuditEventType, `order.${string}`>,
  params: {
    orderId: string;
    hashlock: string;
    direction: string;
    fromStatus: string | null;
    toStatus: string;
    srcChain: string;
    dstChain: string;
    txHash?: string | null;
    blockNumber?: number | null;
    resolverAddress?: string | null;
    detail?: string | null;
    requestId?: string | null;
  },
): AuditEntryInput {
  const payload: OrderEventPayload = {
    orderId: params.orderId,
    hashlock: params.hashlock,
    direction: params.direction,
    fromStatus: params.fromStatus,
    toStatus: params.toStatus,
    srcChain: params.srcChain,
    dstChain: params.dstChain,
    txHash: params.txHash ?? null,
    blockNumber: params.blockNumber ?? null,
    resolverAddress: params.resolverAddress ?? null,
    detail: params.detail ?? null,
  };

  return {
    eventType,
    orderId: params.orderId,
    requestId: params.requestId ?? null,
    payloadJson: JSON.stringify(payload),
  };
}

/**
 * Build an AuditEntryInput for a reconciliation event.
 */
export function buildReconciliationAuditEntry(
  eventType: Extract<AuditEventType, `reconciliation.${string}`>,
  params: Partial<ReconciliationEventPayload> & { chain: string },
  requestId?: string | null,
): AuditEntryInput {
  const payload: ReconciliationEventPayload = {
    chain: params.chain,
    blocksScanned: params.blocksScanned ?? null,
    ordersInspected: params.ordersInspected ?? null,
    ordersRepaired: params.ordersRepaired ?? null,
    gapStartBlock: params.gapStartBlock ?? null,
    gapEndBlock: params.gapEndBlock ?? null,
    durationMs: params.durationMs ?? null,
    detail: params.detail ?? null,
  };

  return {
    eventType,
    orderId: null,
    requestId: requestId ?? null,
    payloadJson: JSON.stringify(payload),
  };
}

/**
 * Build an AuditEntryInput for a system/operational event.
 */
export function buildSystemAuditEntry(
  eventType: Extract<AuditEventType, `system.${string}`>,
  detail: string,
  opts: { errorMessage?: string | null; serviceVersion?: string | null; requestId?: string | null } = {},
): AuditEntryInput {
  const payload: SystemEventPayload = {
    detail,
    errorMessage: opts.errorMessage ?? null,
    serviceVersion: opts.serviceVersion ?? null,
  };

  return {
    eventType,
    orderId: null,
    requestId: opts.requestId ?? null,
    payloadJson: JSON.stringify(payload),
  };
}

// ─── Parsed entry helper ──────────────────────────────────────────────────────

/**
 * Parse the payloadJson field of an AuditEntry back into a typed object.
 * Returns null if JSON.parse fails (should never happen for well-formed rows).
 */
export function parseAuditPayload(entry: AuditEntry): AuditPayload | null {
  try {
    return JSON.parse(entry.payloadJson) as AuditPayload;
  } catch {
    return null;
  }
}
