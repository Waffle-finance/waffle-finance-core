/**
 * Backpressure and slow-client limits for SseBroker.
 *
 * A "stalled" handle models a client that stopped reading: its socket refuses
 * writes (write returns false) until a drain event is emitted. Healthy handles
 * accept every write. These tests check that a stalled subscriber is evicted
 * after the configured number of refused frames, that the eviction affects no
 * other subscriber, and that the counter resets once the socket drains.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  SseBroker,
  MAX_QUEUED_FRAMES_PER_SUBSCRIBER,
} from "../src/sse/sse-broker.js";
import {
  buildStatusChangedPayload,
  type SseResponseHandle,
} from "../src/sse/event-builders.js";
import { sseActiveStreams } from "../src/metrics.js";

interface TestHandle extends SseResponseHandle {
  written: string[];
  ended: boolean;
  destroyed: boolean;
  accepting: boolean;
  closeListeners: Array<() => void>;
  drainListeners: Array<() => void>;
  emitDrain(): void;
  disconnect(): void;
}

function makeHandle(options: { accepting?: boolean; withDestroy?: boolean } = {}): TestHandle {
  const { accepting = true, withDestroy = true } = options;
  const handle: TestHandle = {
    written: [],
    ended: false,
    destroyed: false,
    accepting,
    writableEnded: false,
    closeListeners: [],
    drainListeners: [],
    write(chunk: string) {
      this.written.push(chunk);
      return this.accepting;
    },
    end() {
      this.ended = true;
      this.writableEnded = true;
    },
    on(event: "close" | "drain", listener: () => void) {
      if (event === "close") this.closeListeners.push(listener);
      if (event === "drain") this.drainListeners.push(listener);
      return this;
    },
    emitDrain() {
      for (const l of this.drainListeners) l();
    },
    disconnect() {
      this.writableEnded = true;
      for (const l of this.closeListeners) l();
    },
  } as TestHandle;
  if (withDestroy) {
    handle.destroy = () => {
      handle.destroyed = true;
      handle.writableEnded = true;
    };
  } else {
    delete handle.destroy;
  }
  return handle;
}

const ORDER_ID = "wf_0x" + "c".repeat(64);
const OTHER_ORDER_ID = "wf_0x" + "d".repeat(64);

function statusEvent(status = "announced") {
  return buildStatusChangedPayload(ORDER_ID, status, "src_locked");
}

describe("SseBroker — slow subscriber eviction", () => {
  let broker: SseBroker;

  beforeEach(() => {
    vi.useFakeTimers();
    broker = new SseBroker({ keepAliveIntervalMs: 60_000, maxQueuedFrames: 3 });
  });

  afterEach(() => {
    broker.shutdown();
    vi.useRealTimers();
  });

  it("keeps a subscriber whose socket accepts every write", () => {
    const healthy = makeHandle();
    broker.subscribe(ORDER_ID, healthy);
    for (let i = 0; i < 50; i++) {
      broker.broadcast(ORDER_ID, statusEvent());
    }
    expect(broker.subscriberCount).toBe(1);
    expect(healthy.destroyed).toBe(false);
    expect(broker.stats.backpressureEvents).toBe(0);
    expect(broker.stats.slowClientEvictions).toBe(0);
  });

  it("does not evict until the refused-frame count exceeds the limit", () => {
    const stalled = makeHandle({ accepting: false });
    broker.subscribe(ORDER_ID, stalled);
    // Limit is 3: three refusals are tolerated, the fourth evicts
    for (let i = 0; i < 3; i++) broker.broadcast(ORDER_ID, statusEvent());
    expect(broker.subscriberCount).toBe(1);
    expect(stalled.destroyed).toBe(false);

    broker.broadcast(ORDER_ID, statusEvent());
    expect(broker.subscriberCount).toBe(0);
    expect(stalled.destroyed).toBe(true);
    expect(broker.stats.slowClientEvictions).toBe(1);
    expect(broker.stats.backpressureEvents).toBe(4);
  });

  it("stops writing to an evicted subscriber", () => {
    const stalled = makeHandle({ accepting: false });
    broker.subscribe(ORDER_ID, stalled);
    for (let i = 0; i < 10; i++) broker.broadcast(ORDER_ID, statusEvent());
    // 4 writes reached the handle before eviction; none after
    expect(stalled.written.length).toBe(4);
  });

  it("does not interrupt delivery to other subscribers of the same order", () => {
    const stalled = makeHandle({ accepting: false });
    const healthy = makeHandle();
    broker.subscribe(ORDER_ID, stalled);
    broker.subscribe(ORDER_ID, healthy);

    for (let i = 0; i < 10; i++) broker.broadcast(ORDER_ID, statusEvent());

    expect(stalled.destroyed).toBe(true);
    expect(healthy.written.length).toBe(10);
    expect(healthy.destroyed).toBe(false);
    expect(broker.subscriberCount).toBe(1);
  });

  it("does not affect subscribers of a different order", () => {
    const stalled = makeHandle({ accepting: false });
    const otherOrder = makeHandle();
    broker.subscribe(ORDER_ID, stalled);
    broker.subscribe(OTHER_ORDER_ID, otherOrder);

    for (let i = 0; i < 6; i++) broker.broadcast(ORDER_ID, statusEvent());
    broker.broadcast(OTHER_ORDER_ID, statusEvent());

    expect(stalled.destroyed).toBe(true);
    expect(otherOrder.written.length).toBe(1);
    expect(otherOrder.destroyed).toBe(false);
  });

  it("resets the refused-frame count when a write is accepted", () => {
    const flaky = makeHandle({ accepting: false });
    broker.subscribe(ORDER_ID, flaky);
    for (let i = 0; i < 3; i++) broker.broadcast(ORDER_ID, statusEvent());
    flaky.accepting = true;
    broker.broadcast(ORDER_ID, statusEvent());
    flaky.accepting = false;
    for (let i = 0; i < 3; i++) broker.broadcast(ORDER_ID, statusEvent());

    expect(flaky.destroyed).toBe(false);
    expect(broker.subscriberCount).toBe(1);
  });

  it("resets the refused-frame count on drain", () => {
    const stalled = makeHandle({ accepting: false });
    broker.subscribe(ORDER_ID, stalled);
    for (let i = 0; i < 3; i++) broker.broadcast(ORDER_ID, statusEvent());
    stalled.emitDrain();
    for (let i = 0; i < 3; i++) broker.broadcast(ORDER_ID, statusEvent());
    expect(stalled.destroyed).toBe(false);

    // A fourth refusal without a drain in between is over the limit
    broker.broadcast(ORDER_ID, statusEvent());
    expect(stalled.destroyed).toBe(true);
  });

  it("falls back to end() when the handle has no destroy()", () => {
    const stalled = makeHandle({ accepting: false, withDestroy: false });
    broker.subscribe(ORDER_ID, stalled);
    for (let i = 0; i < 4; i++) broker.broadcast(ORDER_ID, statusEvent());
    expect(stalled.ended).toBe(true);
    expect(broker.subscriberCount).toBe(0);
  });

  it("does not throw out of broadcast when destroy() itself throws", () => {
    const stalled = makeHandle({ accepting: false });
    stalled.destroy = () => {
      throw new Error("socket already closed");
    };
    broker.subscribe(ORDER_ID, stalled);
    expect(() => {
      for (let i = 0; i < 5; i++) broker.broadcast(ORDER_ID, statusEvent());
    }).not.toThrow();
    expect(broker.subscriberCount).toBe(0);
  });

  it("ignores a late close event after eviction without going negative", () => {
    const stalled = makeHandle({ accepting: false });
    broker.subscribe(ORDER_ID, stalled);
    for (let i = 0; i < 4; i++) broker.broadcast(ORDER_ID, statusEvent());
    expect(broker.subscriberCount).toBe(0);

    stalled.disconnect();
    expect(broker.subscriberCount).toBe(0);
  });

  it("evicts a terminal-event subscriber once, without ending it twice", () => {
    const stalled = makeHandle({ accepting: false });
    const healthy = makeHandle();
    broker.subscribe(ORDER_ID, stalled);
    broker.subscribe(ORDER_ID, healthy);
    for (let i = 0; i < 3; i++) broker.broadcast(ORDER_ID, statusEvent());

    const endSpy = vi.spyOn(stalled, "end");
    // Fourth refusal evicts the stalled handle; the terminal frame still reaches healthy
    broker.broadcast(ORDER_ID, buildStatusChangedPayload(ORDER_ID, "completed", "secret_revealed"));

    expect(stalled.destroyed).toBe(true);
    expect(endSpy).not.toHaveBeenCalled();
    expect(healthy.ended).toBe(true);
    expect(broker.subscriberCount).toBe(0);
  });

  it("stops replaying buffered events once the subscriber is evicted", () => {
    // Fill the replay buffer while nobody is listening
    const seed = makeHandle();
    broker.subscribe(ORDER_ID, seed);
    for (let i = 0; i < 10; i++) broker.broadcast(ORDER_ID, statusEvent());

    const stalled = makeHandle({ accepting: false });
    broker.subscribe(ORDER_ID, stalled, 0);

    expect(stalled.destroyed).toBe(true);
    // Replay wrote at most limit+1 frames before the socket was evicted
    expect(stalled.written.length).toBe(4);
    expect(broker.subscriberCount).toBe(1);
  });

  it("counts keep-alive pings toward the limit for an idle stalled client", () => {
    broker.shutdown();
    broker = new SseBroker({ keepAliveIntervalMs: 1_000, maxQueuedFrames: 2 });

    const stalled = makeHandle({ accepting: false });
    broker.subscribe(ORDER_ID, stalled);

    vi.advanceTimersByTime(2_000);
    expect(stalled.destroyed).toBe(false);
    vi.advanceTimersByTime(1_000);
    expect(stalled.destroyed).toBe(true);
    expect(broker.subscriberCount).toBe(0);
  });

  it("reports active streams through the gauge", async () => {
    const a = makeHandle();
    const b = makeHandle();
    broker.subscribe(ORDER_ID, a);
    broker.subscribe(ORDER_ID, b);
    const afterSubscribe = await sseActiveStreams.get();
    expect(afterSubscribe.values[0]?.value).toBe(2);

    a.disconnect();
    const afterDisconnect = await sseActiveStreams.get();
    expect(afterDisconnect.values[0]?.value).toBe(1);
  });
});

describe("SseBroker — queue limit configuration", () => {
  it("uses the exported default limit when no option is given", () => {
    const broker = new SseBroker({ keepAliveIntervalMs: 60_000 });
    try {
      const stalled = makeHandle({ accepting: false });
      broker.subscribe(ORDER_ID, stalled);
      for (let i = 0; i < MAX_QUEUED_FRAMES_PER_SUBSCRIBER; i++) {
        broker.broadcast(ORDER_ID, statusEvent());
      }
      expect(stalled.destroyed).toBe(false);
      broker.broadcast(ORDER_ID, statusEvent());
      expect(stalled.destroyed).toBe(true);
    } finally {
      broker.shutdown();
    }
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects maxQueuedFrames=%s", (value) => {
    expect(() => new SseBroker({ maxQueuedFrames: value, keepAliveIntervalMs: 60_000 })).toThrow(
      RangeError,
    );
  });

  it("accepts a limit of exactly one", () => {
    const broker = new SseBroker({ maxQueuedFrames: 1, keepAliveIntervalMs: 60_000 });
    try {
      const stalled = makeHandle({ accepting: false });
      broker.subscribe(ORDER_ID, stalled);
      broker.broadcast(ORDER_ID, statusEvent());
      expect(stalled.destroyed).toBe(false);
      broker.broadcast(ORDER_ID, statusEvent());
      expect(stalled.destroyed).toBe(true);
    } finally {
      broker.shutdown();
    }
  });
});
