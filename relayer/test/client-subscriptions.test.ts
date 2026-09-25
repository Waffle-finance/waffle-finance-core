import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ClientSubscriptionManager } from '../src/events/client-subscriptions.js';
import { FusionEventManager, EventType } from '../src/events/event-handlers.js';
import { OrdersService } from '../src/events/orders.js';

function createManager(): ClientSubscriptionManager {
  const ordersServiceMock = {
    on: vi.fn(),
    emit: vi.fn(),
  } as unknown as OrdersService;

  const eventManager = new FusionEventManager(ordersServiceMock);
  return new ClientSubscriptionManager(eventManager);
}

describe('ClientSubscriptionManager', () => {
  let manager: ClientSubscriptionManager;

  beforeEach(() => {
    manager = createManager();
  });

  describe('unregisterClient', () => {
    it('returns true and removes an existing client', () => {
      manager.registerClient({ id: 'client-1', connectionType: 'websocket', connected: true, metadata: {} });

      expect(manager.unregisterClient('client-1')).toBe(true);
      expect(manager.getClient('client-1')).toBeUndefined();
    });

    it('returns false and logs warning for unknown client', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = manager.unregisterClient('unknown-id');

      expect(result).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('unknown-id'));
      warnSpy.mockRestore();
    });

    it('is idempotent for repeated cleanup of the same client', () => {
      manager.registerClient({ id: 'client-2', connectionType: 'sse', connected: true, metadata: {} });

      expect(manager.unregisterClient('client-2')).toBe(true);
      expect(manager.unregisterClient('client-2')).toBe(false);
    });
  });

  describe('createSubscription', () => {
    it('rejects empty event-type sets', () => {
      manager.registerClient({ id: 'client-4', connectionType: 'websocket', connected: true, metadata: {} });

      expect(() =>
        manager.createSubscription({ clientId: 'client-4', eventTypes: [] }),
      ).toThrow('At least one event type is required');
    });

    it('rejects missing event types (defaults to empty array)', () => {
      manager.registerClient({ id: 'client-5', connectionType: 'sse', connected: true, metadata: {} });

      expect(() =>
        manager.createSubscription({ clientId: 'client-5' }),
      ).toThrow('At least one event type is required');
    });

    it('accepts a single-element event-type set', () => {
      manager.registerClient({ id: 'client-6', connectionType: 'polling', connected: true, metadata: {} });

      const subId = manager.createSubscription({
        clientId: 'client-6',
        eventTypes: [EventType.OrderCreated],
      });

      expect(subId).toBeTruthy();
      expect(manager.getSubscription('client-6')).toBeDefined();
    });
  });

  describe('cancelSubscription', () => {
    it('returns false when subscription does not exist', () => {
      const result = manager.cancelSubscription('nonexistent-client');
      expect(result).toBe(false);
    });

    it('returns true and removes subscription for existing client', () => {
      manager.registerClient({ id: 'client-3', connectionType: 'polling', connected: true, metadata: {} });
      manager.createSubscription({
        clientId: 'client-3',
        eventTypes: [EventType.OrderCreated],
      });

      expect(manager.cancelSubscription('client-3')).toBe(true);
      expect(manager.getSubscription('client-3')).toBeUndefined();
    });
  });
});
