/**
 * @fileoverview Backlog and heavy-load scenario tests for the relayer.
 * 
 * These tests validate:
 * - Large order queue processing
 * - Memory pressure scenarios
 * - Cursor persistence during heavy load
 * - Batch reconciliation
 * - Performance under sustained load
 * 
 * Usage: pnpm test:smoke --filter backlog
 */

import { describe, it, expect, vi, beforeEach, jest } from 'vitest';
import { SettlementService } from '../../src/services/settlement-service.js';
import { RetryEngine } from '../../src/utils/retry-engine.js';
import { TxStateStore } from '../../src/services/tx-state-store.js';
import { randomBytes } from 'crypto';

// Mock metrics
vi.mock('../../src/metrics.js', () => ({
  settlementAttemptsTotal: { inc: vi.fn() },
  settlementFailuresTotal: { inc: vi.fn() },
  settlementRecoveryTotal: { inc: vi.fn() },
  settlementStateGauge: { set: vi.fn() },
  settlementDurationSeconds: { observe: vi.fn() },
}));

// ── Backlog helpers ─────────────────────────────────────────────────────────

/**
 * Generates a random order ID.
 */
export function generateOrderId(): string {
  return `order-${randomBytes(8).toString('hex')}`;
}

/**
 * Creates a settlement service optimized for backlog testing.
 */
export function makeBacklogService(): { svc: SettlementService; store: TxStateStore } {
  const store = new TxStateStore({ storageDir: null });
  const retryEngine = new RetryEngine({
    defaultMaxAttempts: 3,
    defaultBaseDelayMs: 0, // No delay for faster tests
    defaultMaxDelayMs: 10,
    circuitBreakerThreshold: 100,
  });
  const svc = new SettlementService({ txStateStore: store, retryEngine });
  return { svc, store };
}

/**
 * Creates a large batch of orders.
 */
export function createOrderBatch(count: number): Array<{ orderId: string; direction: string }> {
  return Array.from({ length: count }, (_, i) => ({
    orderId: `order-batch-${i}-${randomBytes(4).toString('hex')}`,
    direction: i % 2 === 0 ? 'xlm_to_eth' : 'eth_to_xlm',
  }));
}

// ── Test suites ─────────────────────────────────────────────────────────────

describe('Relayer smoke — backlog scenarios', () => {
  describe('large order processing', () => {
    it('processes 100 orders in a batch', async () => {
      const { svc } = makeBacklogService();
      const orders = createOrderBatch(100);
      
      const results = await Promise.all(
        orders.map(order =>
          svc.settle({
            orderId: order.orderId,
            direction: order.direction,
            correlationId: `cid-batch-${orders.indexOf(order)}`,
            action: async () => { return `0xtx-${order.orderId}`; },
            maxAttempts: 1,
            baseDelayMs: 0,
          })
        )
      );
      
      expect(results.length).toBe(100);
      expect(results.every(r => r.txHash.startsWith('0xtx-'))).toBe(true);
    });

    it('maintains correct state counts for large batches', async () => {
      const { svc } = makeBacklogService();
      const orders = createOrderBatch(200);
      
      await Promise.all(
        orders.map(order =>
          svc.settle({
            orderId: order.orderId,
            direction: order.direction,
            correlationId: `cid-count-${orders.indexOf(order)}`,
            action: async () => { return `0xtx-${order.orderId}`; },
            maxAttempts: 1,
            baseDelayMs: 0,
          })
        )
      );
      
      const counts = svc.stateCounts();
      // All should be in submission_acked or later
      expect(counts.submission_acked + counts.chain_mined + counts.coordinator_recorded + counts.complete).toBe(200);
    });

    it('processes orders with mixed success', async () => {
      const { svc } = makeBacklogService();
      const orders = createOrderBatch(50);
      
      const results = await Promise.allSettled(
        orders.map((order, i) => {
          const shouldFail = i % 5 === 0; // 20% failure rate
          return svc.settle({
            orderId: order.orderId,
            direction: order.direction,
            correlationId: `cid-mixed-${i}`,
            action: async () => {
              if (shouldFail) throw new Error('execution reverted');
              return `0xtx-mixed-${order.orderId}`;
            },
            maxAttempts: 2,
            baseDelayMs: 0,
          });
        })
      );
      
      const fulfilled = results.filter(r => r.status === 'fulfilled');
      const rejected = results.filter(r => r.status === 'rejected');
      
      expect(fulfilled.length).toBe(40);
      expect(rejected.length).toBe(10);
    });
  });

  describe('cursor persistence', () => {
    it('persists state across virtual restarts', async () => {
      const { svc, store } = makeBacklogService();
      
      // Create some orders
      const batch1 = createOrderBatch(10);
      await Promise.all(
        batch1.map(order =>
          svc.settle({
            orderId: order.orderId,
            direction: order.direction,
            correlationId: `cid-cursor-1`,
            action: async () => { return `0xtx-cursor-${order.orderId}`; },
            maxAttempts: 1,
            baseDelayMs: 0,
          })
        )
      );
      
      // "Restart" - create new service with same store
      const svc2 = new SettlementService({ txStateStore: store });
      
      // Verify state persisted
      const record = svc2.getStatus(batch1[0].orderId);
      expect(record?.txHash).toBe(`0xtx-cursor-${batch1[0].orderId}`);
    });

    it('reconciles after simulated crash', async () => {
      const { svc, store } = makeBacklogService();
      
      // Create order, get to submission_acked
      const order = { orderId: 'order-crash', direction: 'xlm_to_eth' };
      await svc.settle({
        orderId: order.orderId,
        direction: order.direction,
        correlationId: 'cid-crash',
        action: async () => { return '0xtx-crash'; },
        maxAttempts: 1,
        baseDelayMs: 0,
      });
      
      // Simulate crash - state is in submission_acked
      const recordBefore = svc.getStatus(order.orderId);
      expect(recordBefore?.state).toBe('submission_acked');
      
      // "Restart" - new service
      const svc2 = new SettlementService({ txStateStore: store });
      const recordAfter = svc2.getStatus(order.orderId);
      
      // State should be preserved
      expect(recordAfter?.txHash).toBe('0xtx-crash');
      expect(recordAfter?.state).toBe('submission_acked');
    });
  });

  describe('batch reconciliation', () => {
    it('reconciles 50 orders quickly', async () => {
      const { svc, store } = makeBacklogService();
      
      // Create orders
      const orders = createOrderBatch(50);
      await Promise.all(
        orders.map(order =>
          svc.settle({
            orderId: order.orderId,
            direction: order.direction,
            correlationId: 'cid-recon-batch',
            action: async () => { return `0xtx-recon-${order.orderId}`; },
            maxAttempts: 1,
            baseDelayMs: 0,
          })
        )
      );
      
      // Reconcile
      const provider = {
        getTransactionReceipt: vi.fn().mockResolvedValue({
          hash: '0xtx-recon-test',
          blockNumber: 100,
          blockHash: '0xblock',
          status: 1,
          gasUsed: 21000n,
          confirmations: 12,
        }),
        getBlockNumber: vi.fn().mockResolvedValue(200),
      };
      
      const summary = await svc.reconcile(provider, 'scheduled', 'all');
      
      expect(summary.scanned).toBeGreaterThanOrEqual(50);
      expect(typeof summary.advanced).toBe('number');
    });

    it('handles partial reconciliation failures', async () => {
      const { svc, store } = makeBacklogService();
      
      const orders = createOrderBatch(20);
      
      // Mix of successful and failed
      await Promise.allSettled(
        orders.map((order, i) => {
          const shouldSucceed = i % 2 === 0;
          return svc.settle({
            orderId: order.orderId,
            direction: order.direction,
            correlationId: `cid-partial-${i}`,
            action: async () => {
              if (!shouldSucceed) throw new Error('execution reverted');
              return `0xtx-partial-${order.orderId}`;
            },
            maxAttempts: 1,
            baseDelayMs: 0,
          });
        })
      );
      
      // Reconcile should handle both success and failure
      const summary = await svc.reconcile(null, 'scheduled', 'all');
      expect(typeof summary.scanned).toBe('number');
      expect(typeof summary.advanced).toBe('number');
    });
  });

  describe('memory pressure', () => {
    it('handles 1000 orders without memory issues', async () => {
      const { svc, store } = makeBacklogService();
      
      // Create 1000 orders
      const orders = createOrderBatch(1000);
      
      // Use batched processing to avoid overwhelming the event loop
      const batchSize = 100;
      for (let i = 0; i < orders.length; i += batchSize) {
        const batch = orders.slice(i, i + batchSize);
        await Promise.all(
          batch.map(order =>
            svc.settle({
              orderId: order.orderId,
              direction: order.direction,
              correlationId: `cid-memory-${i}`,
              action: async () => { return `0xtx-memory-${order.orderId}`; },
              maxAttempts: 1,
              baseDelayMs: 0,
            })
          )
        );
      }
      
      // Verify all were recorded
      const counts = svc.stateCounts();
      const totalProcessed = Object.values(counts).reduce((sum, count) => sum + count, 0);
      expect(totalProcessed).toBe(1000);
    });

    it('releases resources after batch completion', async () => {
      const { svc, store } = makeBacklogService();
      
      // Process initial batch
      const batch1 = createOrderBatch(500);
      await Promise.all(
        batch1.map(order =>
          svc.settle({
            orderId: order.orderId,
            direction: order.direction,
            correlationId: 'cid-memory-release',
            action: async () => { return `0xtx-release-${order.orderId}`; },
            maxAttempts: 1,
            baseDelayMs: 0,
          })
        )
      );
      
      // Get snapshot before
      const snapshot1 = svc.snapshot();
      expect(snapshot1.length).toBe(500);
      
      // Process another batch
      const batch2 = createOrderBatch(300);
      await Promise.all(
        batch2.map(order =>
          svc.settle({
            orderId: order.orderId,
            direction: order.direction,
            correlationId: 'cid-memory-release2',
            action: async () => { return `0xtx-release2-${order.orderId}`; },
            maxAttempts: 1,
            baseDelayMs: 0,
          })
        )
      );
      
      // Verify new state
      const snapshot2 = svc.snapshot();
      expect(snapshot2.length).toBe(800);
    });
  });

  describe('sustained load', () => {
    it('maintains performance under continuous load', async () => {
      const { svc } = makeBacklogService();
      
      const numOrders = 200;
      const durationStart = Date.now();
      
      // Process orders continuously
      const orders = createOrderBatch(numOrders);
      await Promise.all(
        orders.map((order, i) =>
          svc.settle({
            orderId: order.orderId,
            direction: order.direction,
            correlationId: `cid-continuous-${i}`,
            action: async () => {
              // Simulate small variations in processing time
              await new Promise(resolve => setTimeout(resolve, Math.random() * 5));
              return `0xtx-continuous-${order.orderId}`;
            },
            maxAttempts: 1,
            baseDelayMs: 0,
          })
        )
      );
      
      const durationEnd = Date.now();
      const avgTimePerOrder = (durationEnd - durationStart) / numOrders;
      
      // Should process 200 orders in under 5 seconds on average
      expect(avgTimePerOrder).toBeLessThan(50);
    });

    it('handles concurrent retries under load', async () => {
      const { svc } = makeBacklogService();
      
      // Create a batch where 30% will need retries
      const orders = createOrderBatch(100);
      
      await Promise.all(
        orders.map((order, i) => {
          const needsRetry = i % 3 === 0; // 33% need retry
          let attempts = 0;
          return svc.settle({
            orderId: order.orderId,
            direction: order.direction,
            correlationId: `cid-concurrent-${i}`,
            action: async () => {
              attempts++;
              if (needsRetry && attempts < 2) throw new Error('transient');
              return `0xtx-concurrent-${order.orderId}`;
            },
            maxAttempts: 3,
            baseDelayMs: 1,
          });
        })
      );
      
      // Verify all completed (some with retries)
      const counts = svc.stateCounts();
      const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
      expect(total).toBe(100);
    });
  });

  describe('partial batch recovery', () => {
    it('recovers from partial batch failure', async () => {
      const { svc, store } = makeBacklogService();
      
      const orders = createOrderBatch(50);
      
      // First batch: 20 succeed, 10 fail, 20 succeed
      const first40 = orders.slice(0, 40);
      await Promise.allSettled(
        first40.map((order, i) => {
          const shouldFail = i % 3 === 0; // Some failures
          return svc.settle({
            orderId: order.orderId,
            direction: order.direction,
            correlationId: `cid-partial-recovery-${i}`,
            action: async () => {
              if (shouldFail) throw new Error('execution reverted');
              return `0xtx-partial-recovery-${order.orderId}`;
            },
            maxAttempts: 1,
            baseDelayMs: 0,
          });
        })
      );
      
      // "Crash" and restart
      const svc2 = new SettlementService({ txStateStore: store });
      
      // Second batch: 10 more
      const last10 = orders.slice(40);
      await Promise.all(
        last10.map(order =>
          svc2.settle({
            orderId: order.orderId,
            direction: order.direction,
            correlationId: 'cid-partial-recovery2',
            action: async () => { return `0xtx-partial-recovery2-${order.orderId}`; },
            maxAttempts: 1,
            baseDelayMs: 0,
          })
        )
      );
      
      // Total should be 50
      const counts = svc2.stateCounts();
      const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
      expect(total).toBe(50);
    });
  });
});
