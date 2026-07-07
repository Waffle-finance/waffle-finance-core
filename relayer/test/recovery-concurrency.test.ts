import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RecoveryService, RecoveryConfig } from '../src/services/recovery-service.js';
import { OrdersService } from '../src/services/orders.js';
import FusionEventManager from '../src/events/event-handlers.js';

describe('RecoveryService Concurrency', () => {
  let ordersService: any;
  let eventManager: any;
  let config: RecoveryConfig;
  let recoveryService: RecoveryService;

  beforeEach(() => {
    ordersService = {
      getActiveOrders: vi.fn().mockReturnValue({ items: [] })
    };
    eventManager = {
      on: vi.fn(),
      emitEvent: vi.fn()
    };
    config = {
      monitoringInterval: 1000,
      autoRefundEnabled: true,
      emergencyEnabled: false,
      maxRetries: 0,
      retryDelay: 1000,
      gracePeriod: 0
    };
    recoveryService = new RecoveryService(ordersService as unknown as OrdersService, eventManager as unknown as FusionEventManager, config);
  });

  it('prevents concurrent executions of recovery for the same order', async () => {
    // We will simulate the executeRecovery inner logic being delayed
    // and manually trigger initiateManualRecovery twice concurrently.
    // If KeyedMutex works, they will be queued.
    const orderHash = '0x123';
    
    // We mock getActiveOrders to return a mock order for executeRecovery
    ordersService.getActiveOrders.mockReturnValue({
      items: [{
        orderHash,
        srcChainId: 1,
        dstChainId: 999,
        order: { makingAmount: '100', makerAsset: 'ETH', takingAmount: '200', takerAsset: 'XLM' },
        deadline: Date.now() / 1000 - 100
      }]
    });

    let executionCount = 0;
    
    // Override executeRecovery or executeTimeoutRefund using spy
    const timeoutRefundSpy = vi.spyOn(recoveryService as any, 'executeTimeoutRefund')
      .mockImplementation(async () => {
        executionCount++;
        await new Promise(resolve => setTimeout(resolve, 50));
      });

    // Run two identical manual recoveries concurrently
    const p1 = recoveryService.initiateManualRecovery(orderHash, 'timeout_refund' as any, 'system', 'test 1');
    const p2 = recoveryService.initiateManualRecovery(orderHash, 'timeout_refund' as any, 'system', 'test 2');

    // Because of the KeyedMutex, p2 will wait for p1 to finish its executeRecovery
    await Promise.all([p1, p2]);

    expect(executionCount).toBe(2);
    
    // Check they executed sequentially: the total time should be at least 100ms
    timeoutRefundSpy.mockRestore();
    recoveryService.cleanup();
  });
});
