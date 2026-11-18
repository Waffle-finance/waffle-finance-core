/**
 * SseBroker — manages SSE subscriber connections and broadcasts order events.
 *
 * Responsibilities:
 *  - Maintain a per-order subscriber registry (Map<orderId, Set<handle>>)
 *  - Maintain a per-order replay buffer (circular, max 50 events)
 *  - Keep-alive: emit `: ping` on every idle stream every 30 s
 *  - Cap concurrent subscribers at MAX_SUBSCRIBERS (1 000) per process
 *  - On terminal event: send frame, end the response, remove subscriber
 *  - On SIGTERM: send shutdown frame to all streams
 *  - On Redis adapter present: publish after local broadcast, subscribe for remote events
 */

import type { SseRedisAdapter } from "./redis-adapter.js";
import {
  formatSseFrame,
  SSE_PING_FRAME,
  TERMINAL_SSE_EVENT_TYPES,
  buildShutdownPayload,
  type SseEvent,
  type SseEventType,
  type SseEventData,
  type SseResponseHandle,
} from "./event-builders.js";

export const MAX_SUBSCRIBERS = 1_000;
export const REPLAY_BUFFER_SIZE = 50;
export const KEEP_ALIVE_INTERVAL_MS = 30_000;

export class SseBroker {
  /** orderId → set of active response handles */
  private readonly registry = new Map<string, Set<SseResponseHandle>>();
  /** orderId → circular replay buffer (oldest first) */
  private readonly replayBuffers = new Map<string, SseEvent[]>();
  /** orderId → next event id (monotonically increasing) */
  private readonly counters = new Map<string, number>();
  /** Total active subscriber count across all orders */
  private _subscriberCount = 0;
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private redisAdapter: SseRedisAdapter | null = null;

  constructor(options: { redisAdapter?: SseRedisAdapter; keepAliveIntervalMs?: number } = {}) {
    const intervalMs = options.keepAliveIntervalMs ?? KEEP_ALIVE_INTERVAL_MS;

    if (options.redisAdapter) {
      this.redisAdapter = options.redisAdapter;
      // Forward messages from other instances to local subscribers
      options.redisAdapter.onMessage((orderId, event) => {
        this.broadcastLocal(orderId, event);
      });
    }

    // Keep-alive timer — single interval, iterates all subscribers
    this.keepAliveTimer = setInterval(() => {
      for (const [, handles] of this.registry) {
        for (const handle of Array.from(handles)) {
          if (!handle.writableEnded) {
            handle.write(SSE_PING_FRAME);
          }
        }
      }
    }, intervalMs);

    // Prevent the timer from keeping the process alive in tests
    if (this.keepAliveTimer.unref) {
      this.keepAliveTimer.unref();
    }
  }

  get subscriberCount(): number {
    return this._subscriberCount;
  }

  /**
   * Register a new SSE subscriber for an order.
   *
   * Returns false when the subscriber cap is reached (caller should respond 503).
   * Returns a cleanup function otherwise — call it when the client disconnects.
   *
   * If lastEventId is provided, any buffered events with id > lastEventId are
   * replayed immediately after the cleanup is registered.
   */
  subscribe(
    orderId: string,
    handle: SseResponseHandle,
    lastEventId?: number,
  ): false | (() => void) {
    if (this._subscriberCount >= MAX_SUBSCRIBERS) {
      return false;
    }

    if (!this.registry.has(orderId)) {
      this.registry.set(orderId, new Set());
    }
    this.registry.get(orderId)!.add(handle);
    this._subscriberCount++;

    const cleanup = () => {
      const handles = this.registry.get(orderId);
      if (handles) {
        if (!handles.delete(handle)) return;
        if (handles.size === 0) {
          this.registry.delete(orderId);
          // Evict replay buffer when no subscribers remain and order may be terminal
          // (buffer is always evicted on terminal; here we clean up on last disconnect)
        }
      } else {
        return;
      }
      this._subscriberCount = Math.max(0, this._subscriberCount - 1);
    };

    handle.on("close", cleanup);

    // Replay buffered events after the client's last seen id
    if (lastEventId !== undefined) {
      this.replay(orderId, handle, lastEventId);
    }

    return cleanup;
  }

  /**
   * Broadcast an event to all local subscribers for orderId.
   * Assigns the next monotonic id, pushes to the replay buffer, and
   * optionally publishes to Redis for multi-instance delivery.
   */
  broadcast(orderId: string, eventWithoutId: Omit<SseEvent, "id">): void {
    const id = this.nextId(orderId);
    const event: SseEvent = { ...eventWithoutId, id };

    // Push to replay buffer first so reconnecting clients get this event
    this.pushToReplayBuffer(orderId, event);

    // Deliver locally
    this.broadcastLocal(orderId, event);

    // Publish to Redis for other instances
    if (this.redisAdapter) {
      this.redisAdapter.publish(orderId, event).catch(() => {
        // Non-fatal: Redis failure must not interrupt the local broadcast path
      });
    }
  }

  /**
   * Send shutdown frames to all open streams.
   * Called on SIGTERM.
   */
  shutdown(): void {
    const shutdownPayload = buildShutdownPayload();

    for (const [orderId, handles] of this.registry) {
      for (const handle of Array.from(handles)) {
        if (!handle.writableEnded) {
          const id = this.nextId(orderId);
          const frame = formatSseFrame({ ...shutdownPayload, id });
          try {
            handle.write(frame);
            handle.end();
          } catch {
            // Ignore write errors during shutdown
          }
        }
      }
    }

    this.registry.clear();
    this._subscriberCount = 0;

    if (this.keepAliveTimer !== null) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /** Broadcast an already-stamped event to local subscribers only. */
  private broadcastLocal(orderId: string, event: SseEvent): void {
    const handles = this.registry.get(orderId);
    if (!handles || handles.size === 0) return;

    const frame = formatSseFrame(event);
    const isTerminal = TERMINAL_SSE_EVENT_TYPES.has(event.event) ||
      (event.event === "StatusChanged" &&
        isTerminalStatus((event.data as { status?: string }).status));

    for (const handle of Array.from(handles)) {
      if (handle.writableEnded) {
        if (handles.delete(handle)) this._subscriberCount = Math.max(0, this._subscriberCount - 1);
        continue;
      }
      try {
        handle.write(frame);
        if (isTerminal) {
          handle.end();
          if (handles.delete(handle)) this._subscriberCount = Math.max(0, this._subscriberCount - 1);
        }
      } catch {
        // Write failed — connection already gone
        if (handles.delete(handle)) this._subscriberCount = Math.max(0, this._subscriberCount - 1);
      }
    }

    if (handles.size === 0) {
      this.registry.delete(orderId);
    }

    // Evict replay buffer on terminal event when no subscribers remain
    if (isTerminal && !this.registry.has(orderId)) {
      this.replayBuffers.delete(orderId);
      this.counters.delete(orderId);
    }
  }

  private nextId(orderId: string): number {
    const current = this.counters.get(orderId) ?? 0;
    const next = current + 1;
    this.counters.set(orderId, next);
    return next;
  }

  private pushToReplayBuffer(orderId: string, event: SseEvent): void {
    if (!this.replayBuffers.has(orderId)) {
      this.replayBuffers.set(orderId, []);
    }
    const buf = this.replayBuffers.get(orderId)!;
    buf.push(event);
    // Trim to cap — remove oldest entries
    if (buf.length > REPLAY_BUFFER_SIZE) {
      buf.splice(0, buf.length - REPLAY_BUFFER_SIZE);
    }
  }

  private replay(orderId: string, handle: SseResponseHandle, lastEventId: number): void {
    const buf = this.replayBuffers.get(orderId);
    if (!buf || buf.length === 0) return;

    const oldest = buf[0];
    if (oldest && oldest.id > lastEventId + 1) {
      // Gap: events between lastEventId and the oldest buffered are missing
      const gapId = this.nextId(orderId);
      const gapFrame = formatSseFrame({
        id: gapId,
        event: "replay-gap",
        data: { message: `Events missed. Re-fetch current order state via GET /api/orders/${orderId}` },
        timestamp: Date.now(),
      });
      handle.write(gapFrame);
      return;
    }

    const missed = buf.filter((e) => e.id > lastEventId);
    for (const event of missed) {
      if (!handle.writableEnded) {
        handle.write(formatSseFrame(event));
      }
    }
  }

  /** Expose replay buffer for testing. */
  getReplayBuffer(orderId: string): SseEvent[] {
    return this.replayBuffers.get(orderId) ?? [];
  }
}

/** Terminal coordinator statuses that should close the SSE stream. */
function isTerminalStatus(status: string | undefined): boolean {
  return (
    status === "completed" ||
    status === "refunded" ||
    status === "failed"
  );
}
