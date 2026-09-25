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

describe("FusionEventManager Empty Event Types", () => {
  let ordersServiceMock: OrdersService;
  let eventManager: FusionEventManager;

  beforeEach(() => {
    ordersServiceMock = {
      on: vi.fn(),
      emit: vi.fn(),
    } as unknown as OrdersService;

    eventManager = new FusionEventManager(ordersServiceMock);
  });

  it("rejects registration with an empty event-type set", () => {
    expect(() =>
      eventManager.addEventListener({
        eventTypes: new Set([]),
        filters: {},
        callback: vi.fn(),
      }),
    ).toThrow("At least one event type is required");
  });

  it("accepts registration with a single-element event-type set", () => {
    const id = eventManager.addEventListener({
      eventTypes: new Set([EventType.OrderFilled]),
      filters: {},
      callback: vi.fn(),
    });

    expect(id).toBeTruthy();
    expect(eventManager.getListenerCount()).toBe(1);
  });
});

describe("FusionEventManager Listener Isolation", () => {
  let ordersServiceMock: OrdersService;
  let eventManager: FusionEventManager;

  beforeEach(() => {
    ordersServiceMock = {
      on: vi.fn(),
      emit: vi.fn(),
    } as unknown as OrdersService;

    eventManager = new FusionEventManager(ordersServiceMock);
  });

  it("continues notifying other listeners when one throws", () => {
    const firstCallback = vi.fn(() => {
      throw new Error("boom");
    });
    const secondCallback = vi.fn();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    eventManager.addEventListener({
      eventTypes: new Set([EventType.OrderCreated]),
      filters: {},
      callback: firstCallback,
    });

    eventManager.addEventListener({
      eventTypes: new Set([EventType.OrderCreated]),
      filters: {},
      callback: secondCallback,
    });

    const mockData = { txHash: "0xbeef", amount: "50" };
    const mockMetadata = { orderHash: "0xfail" };

    eventManager.emitEvent(EventType.OrderCreated, mockData, mockMetadata);

    // Both listeners should have been called
    expect(firstCallback).toHaveBeenCalledTimes(1);
    expect(secondCallback).toHaveBeenCalledTimes(1);

    // Error should have been logged
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Error notifying listener"),
      expect.anything(),
    );

    errorSpy.mockRestore();
  });

  it("preserves dispatch ordering", () => {
    const callOrder: number[] = [];

    eventManager.addEventListener({
      eventTypes: new Set([EventType.OrderCreated]),
      filters: {},
      callback: () => { callOrder.push(1); },
    });

    eventManager.addEventListener({
      eventTypes: new Set([EventType.OrderCreated]),
      filters: {},
      callback: () => { callOrder.push(2); },
    });

    eventManager.addEventListener({
      eventTypes: new Set([EventType.OrderCreated]),
      filters: {},
      callback: () => { callOrder.push(3); },
    });

    eventManager.emitEvent(EventType.OrderCreated, { txHash: "0xorder" }, { orderHash: "0xorder" });

    expect(callOrder).toEqual([1, 2, 3]);
  });
});
