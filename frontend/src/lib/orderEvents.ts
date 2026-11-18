/**
 * Frontend ↔ coordinator subscription contract: the event schema.
 *
 * Why this exists
 * ───────────────
 * Order status reaches the UI through three unrelated paths today, each with
 * its own vocabulary and its own shape:
 *
 *  1. `useTransactionHistoryCache` polls `GET /api/orders/history` on a stale
 *     timer and writes rows straight into React state + localStorage.
 *  2. `BridgeForm` writes status transitions imperatively into localStorage as
 *     a swap progresses (submitted → receipt → cross-chain processed), which
 *     the history hook does not observe until its next poll tick.
 *  3. `@wafflefinance/sdk/coordinator` exposes `OrderSubscriber`, whose typed
 *     events speak the *coordinator* status union (`announced`, `src_locked`,
 *     `secret_revealed`, …) rather than the union the UI renders.
 *
 * Three producers, three vocabularies, no shared shape. This module defines the
 * one event schema all three normalise into, so a consumer can be written once
 * and keep working when the transport underneath it changes — including the day
 * the coordinator grows a real SSE/WebSocket channel and polling goes away.
 *
 * What is guaranteed
 * ──────────────────
 * • `OrderEventPayload` fields listed as required are always present, whatever
 *   the source. Fields that a given backend path may not know are typed
 *   `| null` — never `undefined`, never omitted.
 * • `OrderEventStatus` is a closed union matching what the UI already renders,
 *   so consumers never have to widen a switch when a new source is added.
 * • Everything is JSON-serialisable (no Date, no bigint), so events survive a
 *   round trip through localStorage or a future postMessage/BroadcastChannel
 *   transport without loss.
 *
 * What is explicitly NOT guaranteed
 * ─────────────────────────────────
 * `OrderEventPayload.details` is a passthrough bag of whatever extra fields the
 * producing path happened to have (amount, addresses, refund metadata, …).
 * Consumers must treat it as best-effort: present it if useful, never depend on
 * it for correctness. Keeping it quarantined behind one field is what lets the
 * guaranteed part of the schema stay stable.
 *
 * Order failure vs. stream failure
 * ────────────────────────────────
 * These are different things and the contract keeps them apart:
 *  • An *order* failed → a `status` event with `status: 'failed'` (or
 *    `'expired'` / `'timed_out'`) and a non-null `payload.error`. The order is
 *    settled; there is nothing more to wait for.
 *  • The *stream* failed → an `error` event. The order's real status is
 *    unchanged and simply unknown right now. Consumers must keep rendering the
 *    last known state rather than showing the order as broken.
 *
 * Conflating the two is the bug this split is designed to prevent.
 */

// ── Status vocabulary ────────────────────────────────────────────────────────

/**
 * The canonical status set the UI renders.
 *
 * Deliberately identical to `Transaction['status']` in
 * `useTransactionHistoryCache`, so adopting the event contract requires no
 * change to `TransactionHistory`'s label/colour/icon switches.
 */
export type OrderEventStatus =
  | 'pending'
  | 'confirmed'
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'refunded'
  | 'expired'
  | 'timed_out';

const ORDER_EVENT_STATUSES: readonly OrderEventStatus[] = [
  'pending',
  'confirmed',
  'completed',
  'cancelled',
  'failed',
  'refunded',
  'expired',
  'timed_out',
];

/**
 * Coordinator status union → canonical status.
 *
 * Mirrors `ORDER_STATUS_TO_DISPLAY` from `@wafflefinance/sdk/status-display`.
 * Kept as a plain map rather than an import so this contract has no
 * build-order dependency on the SDK's `dist/`, and so a coordinator-side
 * rename surfaces here as an explicit mapping decision rather than a silent
 * type error. The conformance suite (`statusConformance.test.ts`) pins this
 * map to the SDK's canonical table, so the two cannot drift out of sync.
 *
 * The HTLC lifecycle collapses as follows:
 *  • `announced` / `src_locked` — funds committed on one side only. From the
 *    user's point of view the swap is in flight: `pending`.
 *  • `dst_locked` / `secret_revealed` — both legs exist on chain and the swap
 *    can no longer be unilaterally abandoned. That is what `confirmed` means
 *    to the UI: irreversible, but not yet final.
 *  • Terminal coordinator states map one-to-one.
 */
const COORDINATOR_STATUS_MAP: Readonly<Record<string, OrderEventStatus>> = {
  announced: 'pending',
  src_locked: 'pending',
  dst_locked: 'confirmed',
  secret_revealed: 'confirmed',
  completed: 'completed',
  refunded: 'refunded',
  failed: 'failed',
  expired: 'expired',
  cancelled: 'cancelled',
  // Stale-cleanup path: funds were never locked, so it reads as cancelled.
  abandoned: 'cancelled',
};

/** True when `value` is already a canonical status. */
export function isOrderEventStatus(value: unknown): value is OrderEventStatus {
  return typeof value === 'string' && ORDER_EVENT_STATUSES.includes(value as OrderEventStatus);
}

/**
 * Statuses after which no further progression is possible.
 *
 * A subscription may stop polling once every watched order is terminal — see
 * `stopWhenAllSettled` in the polling transport.
 */
const TERMINAL_STATUSES: readonly OrderEventStatus[] = [
  'completed',
  'cancelled',
  'failed',
  'refunded',
  'expired',
  'timed_out',
];

/** True when the order can no longer progress and the UI can stop waiting. */
export function isTerminalOrderStatus(status: OrderEventStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** True for terminal statuses that represent a swap that did not deliver. */
export function isFailureStatus(status: OrderEventStatus): boolean {
  return status === 'failed' || status === 'expired' || status === 'timed_out';
}

/**
 * Normalise any producer's status string into the canonical union.
 *
 * Accepts canonical values (identity), coordinator values (mapped), and
 * anything else. Unrecognised non-empty strings resolve to `'pending'`: we know
 * the order exists but cannot classify its state, and "still in flight" is the
 * only honest thing to show a user — showing `failed` for a status string we
 * simply haven't taught the UI about would be actively wrong.
 *
 * Callers that need to distinguish "genuinely pending" from "unclassifiable"
 * should check `isOrderEventStatus(raw) || raw in COORDINATOR_STATUS_MAP` via
 * {@link isKnownOrderStatusInput} first.
 */
export function normalizeOrderStatus(raw: unknown): OrderEventStatus {
  if (isOrderEventStatus(raw)) return raw;
  if (typeof raw === 'string') {
    const mapped = COORDINATOR_STATUS_MAP[raw];
    if (mapped) return mapped;
  }
  return 'pending';
}

/** True when `raw` maps onto the canonical union without falling back. */
export function isKnownOrderStatusInput(raw: unknown): boolean {
  if (isOrderEventStatus(raw)) return true;
  return typeof raw === 'string' && raw in COORDINATOR_STATUS_MAP;
}

// ── Errors ───────────────────────────────────────────────────────────────────

/**
 * Coarse failure classes. Deliberately small: the UI branches on `retryable`
 * and shows `message`; finer detail belongs in `message`, not in more codes.
 */
export type OrderEventErrorCode =
  /** Transport never reached the coordinator (offline, DNS, CORS, abort). */
  | 'network'
  /** Coordinator answered with a non-2xx status. */
  | 'http'
  /** Response arrived but was not the shape we expect. */
  | 'parse'
  /** The order itself ended in a failure state. Not a stream problem. */
  | 'order_failed'
  /** The subscription gave up after repeated consecutive failures. */
  | 'exhausted'
  | 'unknown';

export interface OrderEventError {
  code: OrderEventErrorCode;
  /** Human-readable, safe to surface directly in the UI. */
  message: string;
  /**
   * Whether retrying could plausibly succeed. `false` for `order_failed`
   * (settled) and `parse` (retrying yields the same malformed body).
   */
  retryable: boolean;
}

const RETRYABLE_CODES: readonly OrderEventErrorCode[] = ['network', 'http', 'unknown'];

/** Build a normalised error from an arbitrary thrown value. */
export function toOrderEventError(
  cause: unknown,
  code: OrderEventErrorCode = 'unknown'
): OrderEventError {
  const message =
    cause instanceof Error
      ? cause.message
      : typeof cause === 'string' && cause.trim()
        ? cause
        : 'Unknown subscription error';

  return { code, message, retryable: RETRYABLE_CODES.includes(code) };
}

// ── Event payload ────────────────────────────────────────────────────────────

/**
 * Which producer emitted an event.
 *
 * Informational only: it never changes the payload shape. Consumers may use it
 * for provenance display or debug logging, but branching on it defeats the
 * point of the contract.
 */
export type OrderEventSource =
  /** Periodic fetch of coordinator history. */
  | 'poll'
  /** Pushed by a live channel (SSE/WebSocket today: in-app publisher). */
  | 'live'
  /** Emitted by the bridge form as it drives a swap in this tab. */
  | 'local'
  /** Replayed from the local cache, e.g. the first paint before any fetch. */
  | 'cache';

/**
 * The normalised view of one order at one point in time.
 *
 * Every field below the `details` line is guaranteed across all sources.
 */
export interface OrderEventPayload {
  /**
   * Stable identifier for the order. Whatever the source calls it internally
   * (`orderId`, `publicId`, `id`) it arrives here as `orderId`, and it is what
   * consumers key their state maps on.
   */
  orderId: string;
  /** Canonical current status. */
  status: OrderEventStatus;
  /**
   * Status immediately before this event, or null when the order is being
   * reported for the first time. `previousStatus === status` never happens on a
   * `status` event — the stream suppresses no-op transitions.
   */
  previousStatus: OrderEventStatus | null;
  /** Which path produced this. Provenance only. */
  source: OrderEventSource;
  /** Unix ms when the event was produced. */
  at: number;
  /** Source-chain transaction hash, once known. */
  srcTxHash: string | null;
  /** Destination-chain transaction hash, once known. */
  dstTxHash: string | null;
  /**
   * Failure detail. Non-null only when `status` is a failure status; always
   * null otherwise, so `payload.error && …` is a safe test.
   */
  error: OrderEventError | null;
  /**
   * Best-effort passthrough of whatever else the producing path knew (amount,
   * addresses, refund metadata, …). NOT part of the guaranteed contract — see
   * the module header.
   */
  details: Readonly<Record<string, unknown>>;
}

// ── Events ───────────────────────────────────────────────────────────────────

/** Why a subscription ended. */
export type OrderUnsubscribeReason =
  /** Consumer called `unsubscribe()`, or the owning component unmounted. */
  | 'manual'
  /** Every watched order reached a terminal status. */
  | 'settled'
  /** Consecutive stream failures hit the configured ceiling. */
  | 'exhausted';

/** Acknowledges that the subscription is live. Always the first event. */
export interface OrderSubscribedEvent {
  type: 'subscribed';
  at: number;
  subscriptionId: string;
}

/**
 * Full current state of every watched order.
 *
 * Emitted on the first successful read from a source, and again after a source
 * recovers from an error, so a consumer that missed intermediate `status`
 * events can resynchronise without tracking gaps itself.
 */
export interface OrderSnapshotEvent {
  type: 'snapshot';
  at: number;
  source: OrderEventSource;
  orders: OrderEventPayload[];
}

/** A single order changed status. Suppressed when the status did not change. */
export interface OrderStatusEvent {
  type: 'status';
  at: number;
  order: OrderEventPayload;
}

/**
 * The stream failed. The watched orders' real statuses are unchanged and simply
 * unknown right now — consumers must keep showing last known state.
 */
export interface OrderStreamErrorEvent {
  type: 'error';
  at: number;
  error: OrderEventError;
  /** Consecutive failures including this one. Resets to 0 on any success. */
  consecutiveFailures: number;
}

/** The subscription ended. Always the last event; emitted exactly once. */
export interface OrderUnsubscribedEvent {
  type: 'unsubscribed';
  at: number;
  subscriptionId: string;
  reason: OrderUnsubscribeReason;
}

export type OrderEvent =
  | OrderSubscribedEvent
  | OrderSnapshotEvent
  | OrderStatusEvent
  | OrderStreamErrorEvent
  | OrderUnsubscribedEvent;

export type OrderEventType = OrderEvent['type'];

// ── Payload construction ─────────────────────────────────────────────────────

/** Fields a producer supplies; everything else is defaulted by the builder. */
export interface OrderEventPayloadInput {
  orderId: string;
  status: unknown;
  source: OrderEventSource;
  previousStatus?: OrderEventStatus | null;
  at?: number;
  srcTxHash?: string | null;
  dstTxHash?: string | null;
  error?: OrderEventError | null;
  details?: Record<string, unknown>;
}

/**
 * Build a guaranteed-shape payload from a producer's partial input.
 *
 * This is the single funnel every source goes through — normalising status,
 * coercing absent optionals to null, and synthesising an `order_failed` error
 * when a producer reports a failure status without supplying one. Going through
 * the funnel is what makes "stable event shape regardless of the backend path"
 * true by construction rather than by convention.
 */
export function createOrderEventPayload(input: OrderEventPayloadInput): OrderEventPayload {
  const status = normalizeOrderStatus(input.status);

  // A failure status with no error attached would leave the UI unable to say
  // *why*. Synthesise one so `isFailureStatus(status) === (error !== null)`
  // always holds, and drop any error that arrived on a non-failure status so
  // the same invariant holds in the other direction.
  let error: OrderEventError | null = input.error ?? null;
  if (isFailureStatus(status)) {
    error = error ?? {
      code: 'order_failed',
      message: `Order ${input.orderId} ended in state "${status}".`,
      retryable: false,
    };
  } else {
    error = null;
  }

  return {
    orderId: input.orderId,
    status,
    previousStatus: input.previousStatus ?? null,
    source: input.source,
    at: input.at ?? Date.now(),
    srcTxHash: input.srcTxHash ?? null,
    dstTxHash: input.dstTxHash ?? null,
    error,
    details: Object.freeze({ ...(input.details ?? {}) }),
  };
}

// ── Source adapters ──────────────────────────────────────────────────────────

/**
 * Shape of a row as it comes back from `GET /api/orders/history` and as it is
 * cached in localStorage. Structurally compatible with `Transaction` from
 * `useTransactionHistoryCache`, but declared independently so this contract
 * does not import from the hook it feeds (which would be circular).
 */
export interface HistoryRowLike {
  id: string;
  status?: unknown;
  txHash?: string;
  ethTxHash?: string;
  stellarTxHash?: string;
  direction?: string;
}

/**
 * Adapt a history row (poll response or cache read) into a payload.
 *
 * Tx-hash resolution follows the direction of the swap: for `eth-to-*` the
 * Ethereum hash is the source leg, for everything else it is the destination
 * leg. Rows that carry only the generic `txHash` fall back to it for the source
 * side, which is what the bridge form writes for single-leg records.
 */
export function orderEventFromHistoryRow<T extends HistoryRowLike>(
  row: T,
  source: OrderEventSource = 'poll',
  previousStatus: OrderEventStatus | null = null
): OrderEventPayload {
  const isEthSource = typeof row.direction === 'string' && row.direction.startsWith('eth');

  const srcTxHash = (isEthSource ? row.ethTxHash : row.stellarTxHash) ?? row.txHash ?? null;
  const dstTxHash = (isEthSource ? row.stellarTxHash : row.ethTxHash) ?? null;

  // Everything except the fields promoted into the guaranteed schema. The UI
  // still needs amount/addresses/refund metadata to render a row, and this is
  // how they travel without widening the contract.
  //
  // Generic over the row type rather than taking an index signature, so
  // interfaces declared elsewhere (`Transaction` in the history cache) satisfy
  // it without a cast — TypeScript does not give interfaces implicit index
  // signatures. The widening happens here, once, instead of at every call site.
  const { id, status, txHash, ethTxHash, stellarTxHash, ...rest } = row as HistoryRowLike &
    Record<string, unknown>;
  void id;
  void status;
  void txHash;
  void ethTxHash;
  void stellarTxHash;

  return createOrderEventPayload({
    orderId: row.id,
    status: row.status,
    source,
    previousStatus,
    srcTxHash,
    dstTxHash,
    details: rest,
  });
}

/**
 * Shape of a normalised coordinator record — structurally the SDK's
 * `HistoryRecord` from `@wafflefinance/sdk/coordinator`, redeclared for the
 * same build-order reason as `COORDINATOR_STATUS_MAP`.
 */
export interface CoordinatorRecordLike {
  id: string;
  status?: unknown;
  direction?: string;
  src?: { lockTx?: string | null; amount?: string | null; address?: string | null };
  dst?: { lockTx?: string | null; amount?: string | null; address?: string | null };
  updatedAt?: number;
}

/**
 * Adapt an SDK `HistoryRecord` (or an `OrderSubscriber` event's `.record`) into
 * a payload, so the SDK's coordinator-vocabulary events land in the same shape
 * as a poll tick.
 *
 * `updatedAt` is coordinator-side unix *seconds*; the contract uses unix ms.
 */
export function orderEventFromCoordinatorRecord(
  record: CoordinatorRecordLike,
  source: OrderEventSource = 'live',
  previousStatus: OrderEventStatus | null = null
): OrderEventPayload {
  return createOrderEventPayload({
    orderId: record.id,
    status: record.status,
    source,
    previousStatus,
    at: typeof record.updatedAt === 'number' ? record.updatedAt * 1000 : undefined,
    srcTxHash: record.src?.lockTx ?? null,
    dstTxHash: record.dst?.lockTx ?? null,
    details: {
      direction: record.direction,
      srcAmount: record.src?.amount ?? null,
      dstAmount: record.dst?.amount ?? null,
      srcAddress: record.src?.address ?? null,
      dstAddress: record.dst?.address ?? null,
    },
  });
}
