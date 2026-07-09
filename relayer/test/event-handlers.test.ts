import { describe, it, expect, vi, beforeEach } from "vitest";
import { FusionEventManager, EventType } from "../src/events/event-handlers.js";
import { OrdersService } from "../src/events/orders.js";

describe("FusionEventManager Deduplication", () => {
  let ordersServiceMock: OrdersService;
  let eventManager: FusionEventManager;

  beforeEach(() => {
    // Mock OrdersService since we only want to test EventManager logic
    ordersServiceMock = {
      on: vi.fn(),
      emit: vi.fn(),
    } as unknown as OrdersService;

    eventManager = new FusionEventManager(ordersServiceMock);
  });

  it("should not notify listeners more than once for the same idempotent event", () => {
    const listenerCallback = vi.fn();
    eventManager.addEventListener({
      eventTypes: new Set([EventType.OrderCreated]),
      filters: {},
      callback: listenerCallback
    });

    const mockData = { txHash: "0xdeadbeef", amount: "100" };
    const mockMetadata = { orderHash: "0xhashlock" };

    // Emit the event first time
    eventManager.emitEvent(EventType.OrderCreated, mockData, mockMetadata);
    expect(listenerCallback).toHaveBeenCalledTimes(1);

    // Emit the identical event a second time
    eventManager.emitEvent(EventType.OrderCreated, mockData, mockMetadata);
    // Listener should not have been called again
    expect(listenerCallback).toHaveBeenCalledTimes(1);
    
    // History should only have 1 event
    expect(eventManager.getEventHistorySize()).toBe(1);
  });
});
