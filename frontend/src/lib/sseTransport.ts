/**
 * SSE transport for the WaffleFinance order-event subscription contract.
 *
 * Implements `OrderEventTransport` using the browser's native `EventSource` API.
 * Each named coordinator event type (OrderCreated, OrderClaimed, etc.) is wired
 * to `emitter.update` via a typed listener; errors map to `emitter.fail`.
 *
 * Compose with `createPollingTransport` via `mergeTransports` for automatic
 * polling fallback when SSE is unavailable (use `useOrderStream` for that).
 */

import { createOrderEventPayload } from "./orderEvents";
import {
  type OrderEventTransport,
  type OrderObservationEmitter,
} from "./orderEventStream";

/** The SSE event names the coordinator emits for HTLC lifecycle events. */
const HTLC_EVENT_NAMES = [
  "OrderCreated",
  "OrderClaimed",
  "OrderRefunded",
  "SecretRevealed",
  "StatusChanged",
] as const;

/**
 * Map coordinator SSE event names to canonical `OrderEventStatus` values.
 * Falls back to the `status` field inside the payload data when present.
 */
const EVENT_NAME_TO_STATUS: Record<string, string> = {
  OrderCreated:   "src_locked",
  OrderClaimed:   "dst_locked",
  OrderRefunded:  "refunded",
  SecretRevealed: "secret_revealed",
  StatusChanged:  "", // resolved from data.status
};

/**
 * Create an `OrderEventTransport` that connects to the coordinator SSE endpoint
 * for the given `orderId`.
 *
 * @param orderId    The coordinator public order ID (wf_0x...).
 * @param apiBaseUrl The coordinator API base URL (e.g. http://localhost:3001).
 */
export function createSseTransport(
  orderId: string,
  apiBaseUrl: string,
): OrderEventTransport {
  return {
    start(emitter: OrderObservationEmitter): () => void {
      // Guard: EventSource is not available in all environments (Node.js, old browsers)
      if (typeof EventSource === "undefined") {
        emitter.fail({
          code: "network",
          message: "EventSource is not available in this environment",
          retryable: false,
        });
        return () => {};
      }

      const url = `${apiBaseUrl.replace(/\/$/, "")}/api/orders/${encodeURIComponent(orderId)}/events`;

      let es: EventSource;
      try {
        es = new EventSource(url);
      } catch (err) {
        emitter.fail({
          code: "network",
          message: err instanceof Error ? err.message : "Failed to open SSE connection",
          retryable: true,
        });
        return () => {};
      }

      // Wire each named HTLC event type
      for (const eventName of HTLC_EVENT_NAMES) {
        es.addEventListener(eventName, (e: Event) => {
          const messageEvent = e as MessageEvent;
          try {
            const raw = JSON.parse(messageEvent.data) as Record<string, unknown>;

            // Resolve the canonical status: prefer the payload's `status` field,
            // fall back to the mapping from the event name.
            const status =
              (typeof raw.status === "string" && raw.status) ||
              EVENT_NAME_TO_STATUS[eventName] ||
              eventName;

            const srcTxHash =
              typeof raw.srcTxHash === "string" ? raw.srcTxHash : null;
            const dstTxHash =
              typeof raw.dstTxHash === "string" ? raw.dstTxHash : null;

            emitter.update(
              createOrderEventPayload({
                orderId,
                status,
                source: "live",
                srcTxHash,
                dstTxHash,
                details: raw,
              }),
            );
          } catch {
            // Malformed frame — skip silently. Do not fail the stream over
            // one bad frame; the next event may be fine.
          }
        });
      }

      // Stream-level error handler
      es.onerror = () => {
        const online =
          typeof navigator !== "undefined" ? navigator.onLine : true;
        emitter.fail({
          code: "network",
          message: "SSE connection error",
          retryable: !online,
        });
      };

      // Return teardown
      return () => {
        es.close();
      };
    },
  };
}
