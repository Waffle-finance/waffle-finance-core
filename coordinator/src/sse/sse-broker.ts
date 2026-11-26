/**
 * SseBroker — manages SSE subscriber connections and broadcasts order events.
 *
 * Responsibilities:
 *  - Maintain a per-order subscriber registry (Map<orderId, Set<handle>>)
 *  - Maintain a per-order replay buffer (circular, max 50 events)
 *  - Keep-alive: emit `: ping` on every idle stream every 30 s
 *  - Cap concurrent subscribers at MAX_SUBSCRIBERS (1 000) per process
 *  - Backpressure: track writes the socket refuses; evict a subscriber once it
 *    has been refused more than MAX_QUEUED_FRAMES_PER_SUBSCRIBER frames in a
 *    row, so one stalled client cannot grow broker memory without bound
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
import {
  sseActiveStreams,
  sseBackpressureEvents,
  sseSlowClientEvictions,
} from "../metrics.js";

export const MAX_SUBSCRIBERS = 1_000;
export const REPLAY_BUFFER_SIZE = 50;
export const KEEP_ALIVE_INTERVAL_MS = 30_000;
/**
 * Consecutive frames a subscriber may be refused by its socket before it is
 * evicted. A client that drains between frames never reaches this limit.
 */
export const MAX_QUEUED_FRAMES_PER_SUBSCRIBER = 256;

/** Per-connection write state, kept off the handle so the handle type stays narrow. */
interface SubscriberFlowState {
  /** Frames refused since the socket last reported it could accept data. */
  refusedFrames: number;
}

export interface SseBrokerOptions {
  redisAdapter?: SseRedisAdapter;
  keepAliveIntervalMs?: number;
  /** Override the per-subscriber refused-frame limit (positive integer). */
  maxQueuedFrames?: number;
}

export interface SseBrokerStats {
  activeSubscribers: number;
  /** Writes refused by a socket since the broker started. */
  backpressureEvents: number;
  /** Subscribers evicted for exceeding the queue limit since the broker started. */
  slowClientEvictions: number;
}

export class SseBroker {
  /** orderId → set of active response handles */
  private readonly registry = new Map<string, Set<SseResponseHandle>>();
  /** orderId → circular replay buffer (oldest first) */
  private readonly replayBuffers = new Map<string, SseEvent[]>();
  /** orderId → next event id (monotonically increasing) */
  private readonly counters = new Map<string, number>();
  /** handle → backpressure state; weak so closed connections are collected */
  private readonly flow = new WeakMap<SseResponseHandle, SubscriberFlowState>();
  /** Total active subscriber count across all orders */
  private _subscriberCount = 0;
  private _backpressureEvents = 0;
  private _slowClientEvictions = 0;
  private readonly maxQueuedFrames: number;
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private redisAdapter: SseRedisAdapter | null = null;

  constructor(options: SseBrokerOptions = {}) {
    const intervalMs = options.keepAliveIntervalMs ?? KEEP_ALIVE_INTERVAL_MS;

    const maxQueued = options.maxQueuedFrames ?? MAX_QUEUED_FRAMES_PER_SUBSCRIBER;
    if (!Number.isInteger(maxQueued) || maxQueued < 1) {
      throw new RangeError(`maxQueuedFrames must be a positive integer, received ${maxQueued}`);
    }
    this.maxQueuedFrames = maxQueued;

    if (options.redisAdapter) {
      this.redisAdapter = options.redisAdapter;
      // Forward messages from other instances to local subscribers
      options.redisAdapter.onMessage((orderId, event) => {
        this.broadcastLocal(orderId, event);
      });
    }

    // Keep-alive timer — single interval, iterates all subscribers
    this.keepAliveTimer = setInterval(() => {
      for (const orderId of Array.from(this.registry.keys())) {
        const handles = this.registry.get(orderId);
        if (!handles) continue;
        for (const handle of Array.from(handles)) {
          if (handle.writableEnded) {
            this.removeHandle(orderId, handle);
            continue;
          }
          this.writeFrame(orderId, handle, SSE_PING_FRAME);
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

  /** Point-in-time backpressure and subscriber counters for this broker. */
  get stats(): SseBrokerStats {
    return {
      activeSubscribers: this._subscriberCount,
      backpressureEvents: this._backpressureEvents,
      slowClientEvictions: this._slowClientEvictions,
    };
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
    this.syncActiveGauge();

    const cleanup = () => {
      const handles = this.registry.get(orderId);
      if (!handles || !handles.has(handle)) return;
      this.removeHandle(orderId, handle);
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
    this.syncActiveGauge();

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
        this.removeHandle(orderId, handle);
        continue;
      }
      try {
        // A false return means the subscriber was evicted for backpressure;
        // its response has already been torn down, so there is nothing to end.
        const stillConnected = this.writeFrame(orderId, handle, frame);
        if (isTerminal && stillConnected) {
          handle.end();
          this.removeHandle(orderId, handle);
        }
      } catch {
        // Write failed — connection already gone
        this.removeHandle(orderId, handle);
      }
    }

    // Evict replay buffer on terminal event when no subscribers remain
    if (isTerminal && !this.registry.has(orderId)) {
      this.replayBuffers.delete(orderId);
      this.counters.delete(orderId);
    }
  }

  /**
   * Write one frame to a subscriber and track whether the socket accepted it.
   *
   * Returns false only when the subscriber was evicted by this call.
   */
  private writeFrame(orderId: string, handle: SseResponseHandle, frame: string): boolean {
    const state = this.getFlowState(handle);
    const accepted = handle.write(frame);
    if (accepted) {
      state.refusedFrames = 0;
      return true;
    }

    this._backpressureEvents++;
    sseBackpressureEvents.inc();
    state.refusedFrames++;
    if (state.refusedFrames > this.maxQueuedFrames) {
      this.evictSlowSubscriber(orderId, handle);
      return false;
    }
    return true;
  }

  /**
   * Remove a subscriber that stayed backpressured past the queue limit.
   * Only this subscriber is affected; other handles in the registry are untouched.
   */
  private evictSlowSubscriber(orderId: string, handle: SseResponseHandle): void {
    this.removeHandle(orderId, handle);
    this._slowClientEvictions++;
    sseSlowClientEvictions.inc();
    try {
      if (typeof handle.destroy === "function") {
        handle.destroy();
      } else {
        handle.end();
      }
    } catch {
      // Connection already gone; removal from the registry is what matters
    }
  }

  /** Remove one subscriber from the registry and keep counters in step. */
  private removeHandle(orderId: string, handle: SseResponseHandle): void {
    const handles = this.registry.get(orderId);
    if (!handles || !handles.delete(handle)) return;
    if (handles.size === 0) {
      this.registry.delete(orderId);
    }
    this._subscriberCount = Math.max(0, this._subscriberCount - 1);
    this.syncActiveGauge();
  }

  /**
   * Return the flow state for a handle, creating it on first use. The drain
   * listener resets the refused-frame count once the socket flushes, so the
   * count only reflects a client that has stopped reading.
   */
  private getFlowState(handle: SseResponseHandle): SubscriberFlowState {
    let state = this.flow.get(handle);
    if (!state) {
      state = { refusedFrames: 0 };
      this.flow.set(handle, state);
      const current = state;
      handle.on("drain", () => {
        current.refusedFrames = 0;
      });
    }
    return state;
  }

  private syncActiveGauge(): void {
    sseActiveStreams.set(this._subscriberCount);
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
      this.writeFrame(orderId, handle, gapFrame);
      return;
    }

    const missed = buf.filter((e) => e.id > lastEventId);
    for (const event of missed) {
      if (handle.writableEnded) break;
      // Stop replaying into a subscriber that was just evicted for backpressure
      if (!this.writeFrame(orderId, handle, formatSseFrame(event))) break;
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
