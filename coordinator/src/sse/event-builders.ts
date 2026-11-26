/**
 * SSE event type definitions and payload builder functions.
 *
 * Every SSE frame sent to a client is built through one of the typed builder
 * functions here, so the wire format and payload shapes are defined once and
 * enforced at compile time rather than scattered across call sites.
 */

import type { OrderRow } from "../persistence/orders-repo.js";

// ── Wire types ────────────────────────────────────────────────────────────────

export type SseEventType =
  | "OrderCreated"
  | "OrderClaimed"
  | "OrderRefunded"
  | "SecretRevealed"
  | "StatusChanged"
  | "ping"
  | "shutdown"
  | "replay-gap";

/** Terminal SSE event types that signal the order's lifecycle is over. */
export const TERMINAL_SSE_EVENT_TYPES = new Set<SseEventType>([
  "OrderRefunded",
  "shutdown",
]);

// ── Payload interfaces ────────────────────────────────────────────────────────

export interface OrderCreatedData {
  orderId: string;
  status: "src_locked";
  srcChain: string;
  srcTxHash: string | null;
  blockNumber: number;
  timelock: number;
  timestamp: number;
}

export interface OrderClaimedData {
  orderId: string;
  status: "dst_locked" | "secret_revealed";
  dstChain: string;
  dstTxHash: string | null;
  blockNumber: number;
  timelock: number;
  resolver: string | null;
  timestamp: number;
}

export interface OrderRefundedData {
  orderId: string;
  status: "refunded";
  txHash: string | null;
  timestamp: number;
}

export interface SecretRevealedData {
  orderId: string;
  preimage: string;
  revealedTx: string | null;
  timestamp: number;
}

export interface StatusChangedData {
  orderId: string;
  status: string;
  previousStatus: string | null;
  timestamp: number;
}

export interface ReplayGapData {
  message: string;
}

export type SseEventData =
  | OrderCreatedData
  | OrderClaimedData
  | OrderRefundedData
  | SecretRevealedData
  | StatusChangedData
  | ReplayGapData
  | Record<string, never>; // ping / shutdown carry no data

// ── Core event shape ──────────────────────────────────────────────────────────

/** A fully-resolved SSE event ready for serialisation. */
export interface SseEvent {
  /** Monotonically increasing integer scoped to one orderId. */
  id: number;
  event: SseEventType;
  data: SseEventData;
  /** Unix milliseconds. */
  timestamp: number;
}

// ── Response handle ───────────────────────────────────────────────────────────

/**
 * Minimal subset of `http.ServerResponse` that the broker needs.
 * Keeping this narrow makes the broker unit-testable without a real HTTP server.
 */
export interface SseResponseHandle {
  /** Returns false when the underlying socket is above its high-water mark. */
  write(chunk: string): boolean;
  end(): void;
  on(event: "close" | "drain", listener: () => void): this;
  writableEnded: boolean;
  /**
   * Tears the connection down immediately, discarding buffered data. Used to
   * evict slow subscribers; handles without it fall back to `end()`.
   */
  destroy?(): void;
}

// ── Wire serialisation ────────────────────────────────────────────────────────

/**
 * Serialise a complete `SseEvent` to the SSE text protocol.
 *
 * Format:
 *   id: <n>\n
 *   event: <type>\n
 *   data: <json>\n
 *   \n
 */
export function formatSseFrame(event: SseEvent): string {
  return `id: ${event.id}\nevent: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

/** Serialise a keep-alive comment line. */
export const SSE_PING_FRAME = ": ping\n\n";

/** Serialise a connected comment line (sent once on subscribe). */
export const SSE_CONNECTED_FRAME = ": connected\n\n";

// ── Builder functions ─────────────────────────────────────────────────────────
// Each returns Omit<SseEvent, 'id'> — the broker assigns the monotonic id.

export function buildOrderCreatedPayload(
  order: Pick<OrderRow, "publicId" | "srcChain" | "srcLockTx" | "srcLockBlock" | "srcTimelock">,
): Omit<SseEvent, "id"> {
  return {
    event: "OrderCreated",
    timestamp: Date.now(),
    data: {
      orderId: order.publicId,
      status: "src_locked",
      srcChain: order.srcChain,
      srcTxHash: order.srcLockTx,
      blockNumber: order.srcLockBlock ?? 0,
      timelock: order.srcTimelock ?? 0,
      timestamp: Date.now(),
    } satisfies OrderCreatedData,
  };
}

export function buildOrderClaimedPayload(
  order: Pick<
    OrderRow,
    "publicId" | "dstChain" | "dstLockTx" | "dstLockBlock" | "dstTimelock" | "resolverAddress" | "status"
  >,
): Omit<SseEvent, "id"> {
  const status = order.status === "secret_revealed" ? "secret_revealed" : "dst_locked";
  return {
    event: "OrderClaimed",
    timestamp: Date.now(),
    data: {
      orderId: order.publicId,
      status,
      dstChain: order.dstChain,
      dstTxHash: order.dstLockTx,
      blockNumber: order.dstLockBlock ?? 0,
      timelock: order.dstTimelock ?? 0,
      resolver: order.resolverAddress,
      timestamp: Date.now(),
    } satisfies OrderClaimedData,
  };
}

export function buildOrderRefundedPayload(
  orderId: string,
  txHash: string | null = null,
): Omit<SseEvent, "id"> {
  return {
    event: "OrderRefunded",
    timestamp: Date.now(),
    data: {
      orderId,
      status: "refunded",
      txHash,
      timestamp: Date.now(),
    } satisfies OrderRefundedData,
  };
}

export function buildSecretRevealedPayload(
  orderId: string,
  preimage: string,
  revealedTx: string | null,
): Omit<SseEvent, "id"> {
  return {
    event: "SecretRevealed",
    timestamp: Date.now(),
    data: {
      orderId,
      preimage,
      revealedTx,
      timestamp: Date.now(),
    } satisfies SecretRevealedData,
  };
}

export function buildStatusChangedPayload(
  orderId: string,
  status: string,
  previousStatus: string | null,
): Omit<SseEvent, "id"> {
  return {
    event: "StatusChanged",
    timestamp: Date.now(),
    data: {
      orderId,
      status,
      previousStatus,
      timestamp: Date.now(),
    } satisfies StatusChangedData,
  };
}

export function buildReplayGapPayload(orderId: string): Omit<SseEvent, "id"> {
  return {
    event: "replay-gap",
    timestamp: Date.now(),
    data: {
      message: `Events missed. Re-fetch current order state via GET /api/orders/${orderId}`,
    } satisfies ReplayGapData,
  };
}

export function buildShutdownPayload(): Omit<SseEvent, "id"> {
  return {
    event: "shutdown",
    timestamp: Date.now(),
    data: {} as Record<string, never>,
  };
}
