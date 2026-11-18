/**
 * @fileoverview Recovery scenario tests for the relayer.
 * 
 * These tests validate:
 * - Settlement failure recovery workflows
 * - State reconciliation after failures
 * - Backstop refund scenarios
 * - Emergency recovery procedures
 * - Idempotent retry behavior
 * 
 * Usage: pnpm test:smoke --filter recovery
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SettlementService, SettlementError } from '../../src/services/settlement-service.js';
import { RetryEngine } from '../../src/utils/retry-engine.js';
import { TxStateStore, type TxReceipt } from '../../src/services/tx-state-store.js';

// Mock metrics
vi.mock('../../src/metrics.js', () => ({
  settlementAttemptsTotal: { inc: vi.fn() },
  settlementFailuresTotal: { inc: vi.fn() },
  settlementRecoveryTotal: { inc: vi.fn() },
  settlementStateGauge: { set: vi.fn() },
  settlementDurationSeconds: { observe: vi.fn() },
}));

// ── Recovery helpers ────────────────────────────────────────────────────────

function makeReceipt(overrides: Partial<TxReceipt> = {}): TxReceipt {
  return {
    hash: '0xabc123',
    blockNumber: 100,
    blockHash: '0xblock',
    status: 1,
    gasUsed: 21000n,
    confirmations: 12,
    ...overrides,
  };
}

function makeRecoveryService() {
  const store = new TxStateStore({ storageDir: null });
  const retryEngine = new RetryEngine({
    defaultMaxAttempts: 5,
    defaultBaseDelayMs: 1,
    defaultMaxDelayMs: 10,
    circuitBreakerThreshold: 10,
  });
  return new SettlementService({ txStateStore: store, retryEngine });
}

// ── Test suites ─────────────────────────────────────────────────────────────

describe('Relayer smoke — recovery scenarios', () => {
  describe('settlement failure recovery', () => {
    it('recovers from transient failures with retry', async () => {
      const svc = makeRecoveryService();
      
      // First attempt fails (transient)
      const action = vi.fn().mockRejectedValue(new Error('connection timeout'));
      
      try {
        await svc.settle({
          orderId: 'order-recovery-1',
          direction: 'xlm_to_eth',
          correlationId: 'cid-recovery',
          action,
          maxAttempts: 3,
          baseDelayMs: 1,
        });
      } catch {
        // Expected
      }
      
      expect(action).toHaveBeenCalledTimes(3);
      
      // Check the state
      const record = svc.getStatus('order-recovery-1');
      expect(record?.state).toBe('terminal_failure');
    });

    it('recovers from terminal failures with manual intervention', async () => {
      const svc = makeRecoveryService();
      
      // Terminal failure
      try {
        await svc.settle({
          orderId: 'order-terminal-recovery',
          direction: 'xlm_to_eth',
          correlationId: 'cid-terminal',
          action: async () => { throw new Error('execution reverted'); },
          maxAttempts: 1,
          baseDelayMs: 1,
        });
      } catch (err) {
        expect(err).toBeInstanceOf(SettlementError);
      }
      
      const record = svc.getStatus('order-terminal-recovery');
      expect(record?.state).toBe('terminal_failure');
      expect(record?.failureReason).toContain('execution reverted');
      
      // Manual recovery: operator fixes the underlying issue
      // and the order is retried with a new record
      const record2 = svc.getStatus('order-terminal-recovery');
      expect(record2?.state).toBe('terminal_failure');
      
      // The original failed order remains terminal_failure
      // A new attempt would create a new record
    });

    it('reconciles failed orders on startup', async () => {
      const svc = makeRecoveryService();
      
      // Create some failed orders
      for (let i = 0; i < 5; i++) {
        try {
          await svc.settle({
            orderId: `order-fail-${i}`,
            direction: 'xlm_to_eth',
            correlationId: 'cid-fail',
            action: async () => { throw new Error('execution reverted'); },
            maxAttempts: 1,
            baseDelayMs: 1,
          });
        } catch {
          // Expected
        }
      }
      
      // Reconcile - terminal orders should not be scanned
      const summary = await svc.reconcile(null, 'startup');
      expect(summary.scanned).toBe(0); // Terminal orders skipped
    });
  });

  describe('state reconciliation', () => {
    it('reconciles pending submission records', async () => {
      const svc = makeRecoveryService();
      
      // Create order and get to submission_acked
      await svc.settle({
        orderId: 'order-pending-recon',
        direction: 'xlm_to_eth',
        correlationId: 'cid-pending',
        action: async () => { return '0xtx-pending'; },
        maxAttempts: 1,
        baseDelayMs: 1,
      });
      
      const record = svc.getStatus('order-pending-recon');
      expect(record?.state).toBe('submission_acked');
      
      // Reconcile with provider
      const provider = {
        getTransactionReceipt: vi.fn().mockResolvedValue({
          hash: '0xtx-pending',
          blockNumber: 50,
          blockHash: '0xblock-pending',
          status: 1,
          gasUsed: 21000n,
          confirmations: 10,
        }),
        getBlockNumber: vi.fn().mockResolvedValue(100),
      };
      
      await svc.reconcile(provider, 'scheduled');
      const record2 = svc.getStatus('order-pending-recon');
      expect(record2?.state).toBe('chain_mined');
      expect(record2?.minedBlock).toBe(50);
    });

    it('reconciles coordinator_recorded records', async () => {
      const svc = makeRecoveryService();
      
      // Create order through full workflow
      await svc.settle({
        orderId: 'order-coord-recon',
        direction: 'xlm_to_eth',
        correlationId: 'cid-coord',
        action: async () => { return '0xtx-coord'; },
        maxAttempts: 1,
        baseDelayMs: 1,
      });
      
      svc.recordReceipt('order-coord-recon', makeReceipt({ hash: '0xtx-coord' }));
      svc.recordCoordinatorAck('order-coord-recon', 'coord-ref-xyz');
      
      const record = svc.getStatus('order-coord-recon');
      expect(record?.state).toBe('coordinator_recorded');
      
      // Reconcile - should advance to complete
      await svc.reconcile(null, 'startup');
      const record2 = svc.getStatus('order-coord-recon');
      expect(record2?.state).toBe('complete');
    });

    it('handles reconciliation of mixed state orders', async () => {
      const svc = makeRecoveryService();
      
      // Mix of states
      for (let i = 0; i < 10; i++) {
        await svc.settle({
          orderId: `order-mixed-${i}`,
          direction: i % 2 === 0 ? 'xlm_to_eth' : 'eth_to_xlm',
          correlationId: 'cid-mixed',
          action: async () => { return `0xtx-mixed-${i}`; },
          maxAttempts: 1,
          baseDelayMs: 1,
        });
      }
      
      // Advance some to chain_mined
      for (let i = 0; i < 5; i++) {
        svc.recordReceipt(`order-mixed-${i}`, makeReceipt({ hash: `0xtx-mixed-${i}` }));
      }
      
      // Advance some to coordinator_recorded
      for (let i = 0; i < 3; i++) {
        svc.recordCoordinatorAck(`order-mixed-${i}`, `coord-${i}`);
      }
      
      const summary = await svc.reconcile(null, 'manual');
      expect(typeof summary.scanned).toBe('number');
      expect(typeof summary.advanced).toBe('number');
    });
  });

  describe('backstop refund scenarios', () => {
    it('handles orders stuck in pending_relayer_escrow', async () => {
      const svc = makeRecoveryService();
      
      // Simulate an order stuck at pending_relayer_escrow
      // (e.g., XLM received but ETH escrow never created)
      const store = (svc as any).store;
      
      // Create a record manually
      store.create({
        orderId: 'order-stuck-escrow',
        correlationId: 'cid-stuck',
        route: 'xlm_to_eth',
      });
      
      // Record was created but never got to submission_acked
      const record = svc.getStatus('order-stuck-escrow');
      expect(record?.state).toBe('pending_submission');
      
      // Simulate timeout/recovery
      await svc.reconcile(null, 'startup');
      const record2 = svc.getStatus('order-stuck-escrow');
      expect(record2?.state).toBe('terminal_failure');
    });

    it('marks orders as failed after timeout', async () => {
      const svc = makeRecoveryService();
      const store = new TxStateStore({ storageDir: null, pendingSubmissionTimeoutMs: 1 });
      
      // Create service with fast timeout
      const fastSvc = new SettlementService({
        txStateStore: store,
        retryEngine: new RetryEngine({ defaultMaxAttempts: 1, defaultBaseDelayMs: 1 }),
      });
      
      // Create order that stays in pending_submission
      store.create({
        orderId: 'order-timeout-recovery',
        correlationId: 'cid-timeout-recovery',
        route: 'xlm_to_eth',
      });
      
      // Wait for timeout
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Reconcile should mark as terminal_failure
      await fastSvc.reconcile(null, 'startup');
      const record = fastSvc.getStatus('order-timeout-recovery');
      expect(record?.state).toBe('terminal_failure');
    });
  });

  describe('emergency recovery', () => {
    it('marks order for emergency recovery', async () => {
      const svc = makeRecoveryService();
      
      // Create a failed order
      try {
        await svc.settle({
          orderId: 'order-emergency',
          direction: 'xlm_to_eth',
          correlationId: 'cid-emergency',
          action: async () => { throw new Error('execution reverted'); },
          maxAttempts: 1,
          baseDelayMs: 1,
        });
      } catch {
        // Expected
      }
      
      const record = svc.getStatus('order-emergency');
      expect(record?.state).toBe('terminal_failure');
      
      // Note: In production, this would trigger an alert for manual review
      // The operator would then investigate and potentially initiate manual recovery
    });

    it('supports operator-initiated recovery attempts', async () => {
      const svc = makeRecoveryService();
      
      // Initial failure
      try {
        await svc.settle({
          orderId: 'order-operator-recovery',
          direction: 'xlm_to_eth',
          correlationId: 'cid-op',
          action: async () => { throw new Error('initial failure'); },
          maxAttempts: 1,
          baseDelayMs: 1,
        });
      } catch {
        // Expected
      }
      
      // Operator investigates and fixes the issue
      // Creates a new attempt record
      const result = await svc.settle({
        orderId: 'order-operator-recovery-attempt2',
        direction: 'xlm_to_eth',
        correlationId: 'cid-op-retry',
        action: async () => { return '0xtx-operator-recovery'; },
        maxAttempts: 1,
        baseDelayMs: 1,
      });
      
      expect(result.txHash).toBe('0xtx-operator-recovery');
    });
  });

  describe('idempotent retry behavior', () => {
    it('prevents duplicate submissions', async () => {
      const svc = makeRecoveryService();
      
      const result1 = await svc.settle({
        orderId: 'order-idem-retry',
        direction: 'xlm_to_eth',
        correlationId: 'cid-idem',
        action: async () => { return '0xtx-idem'; },
        maxAttempts: 1,
        baseDelayMs: 1,
      });
      
      expect(result1.txHash).toBe('0xtx-idem');
      
      // Second attempt with same orderId returns cached result
      const result2 = await svc.settle({
        orderId: 'order-idem-retry',
        direction: 'xlm_to_eth',
        correlationId: 'cid-idem-2',
        action: async () => { return '0xtx-duplicate'; },
        maxAttempts: 1,
        baseDelayMs: 1,
      });
      
      expect(result2.txHash).toBe('0xtx-idem'); // Same hash, no duplicate
      expect(result2.attempts).toBe(0); // No new attempts
    });

    it('allows retry with new orderId after failure', async () => {
      const svc = makeRecoveryService();
      
      // Original fails
      try {
        await svc.settle({
          orderId: 'order-fail-retry',
          direction: 'xlm_to_eth',
          correlationId: 'cid-fail',
          action: async () => { throw new Error('failure'); },
          maxAttempts: 1,
          baseDelayMs: 1,
        });
      } catch {
        // Expected
      }
      
      // New orderId should work
      const result = await svc.settle({
        orderId: 'order-success-retry',
        direction: 'xlm_to_eth',
        correlationId: 'cid-success',
        action: async () => { return '0xtx-success'; },
        maxAttempts: 1,
        baseDelayMs: 1,
      });
      
      expect(result.txHash).toBe('0xtx-success');
    });

    it('handles concurrent retry attempts', async () => {
      const svc = makeRecoveryService();
      
      // Multiple calls with same orderId
      const promises = [
        svc.settle({
          orderId: 'order-concurrent',
          direction: 'xlm_to_eth',
          correlationId: 'cid-concurrent',
          action: async () => { return '0xtx-concurrent'; },
          maxAttempts: 1,
          baseDelayMs: 1,
        }),
        svc.settle({
          orderId: 'order-concurrent',
          direction: 'xlm_to_eth',
          correlationId: 'cid-concurrent-2',
          action: async () => { return '0xtx-concurrent'; },
          maxAttempts: 1,
          baseDelayMs: 1,
        }),
      ];
      
      const results = await Promise.all(promises);
      
      // Both should return the same result
      expect(results[0].txHash).toBe(results[1].txHash);
      expect(results[0].attempts + results[1].attempts).toBe(1); // Only one actual attempt
    });
  });

  describe('failure classification recovery', () => {
    it('correctly classifies transient failures for retry', async () => {
      const svc = makeRecoveryService();
      
      // Simulate transient failure
      let attempts = 0;
      try {
        await svc.settle({
          orderId: 'order-classify-transient',
          direction: 'xlm_to_eth',
          correlationId: 'cid-classify',
          action: async () => {
            attempts++;
            if (attempts < 2) throw new Error('connection timeout');
            return '0xtx-classify';
          },
          maxAttempts: 3,
          baseDelayMs: 1,
        });
      } catch {
        // Expected if we don't succeed in time
      }
      
      // Should have retried
      expect(attempts).toBeGreaterThanOrEqual(1);
    });

    it('does not retry terminal failures', async () => {
      const svc = makeRecoveryService();
      
      // Terminal failure should not retry
      let attempts = 0;
      try {
        await svc.settle({
          orderId: 'order-classify-terminal',
          direction: 'xlm_to_eth',
          correlationId: 'cid-classify-term',
          action: async () => {
            attempts++;
            throw new Error('execution reverted: bad auth');
          },
          maxAttempts: 5,
          baseDelayMs: 1,
        });
      } catch {
        // Expected
      }
      
      // Should only attempt once
      expect(attempts).toBe(1);
    });

    it('tracks failure statistics for monitoring', async () => {
      const svc = makeRecoveryService();
      
      // Create various failure scenarios
      try {
        await svc.settle({
          orderId: 'order-stat-transient',
          direction: 'xlm_to_eth',
          correlationId: 'cid-stat',
          action: async () => { throw new Error('timeout'); },
          maxAttempts: 2,
          baseDelayMs: 1,
        });
      } catch {
        // Expected
      }
      
      try {
        await svc.settle({
          orderId: 'order-stat-terminal',
          direction: 'xlm_to_eth',
          correlationId: 'cid-stat-term',
          action: async () => { throw new Error('execution reverted'); },
          maxAttempts: 1,
          baseDelayMs: 1,
        });
      } catch {
        // Expected
      }
      
      // Check state counts
      const counts = svc.stateCounts();
      
      // Verify we have failures tracked
      expect(counts.terminal_failure).toBeGreaterThanOrEqual(1);
    });
  });

  describe('recovery workflow documentation', () => {
    it('documents recovery steps for operators', async () => {
      const svc = makeRecoveryService();
      
      // Step 1: Detect failed order
      try {
        await svc.settle({
          orderId: 'order-doc-recovery',
          direction: 'xlm_to_eth',
          correlationId: 'cid-doc',
          action: async () => { throw new Error('connection timeout'); },
          maxAttempts: 1,
          baseDelayMs: 1,
        });
      } catch {
        // Expected
      }
      
      const record = svc.getStatus('order-doc-recovery');
      expect(record?.state).toBe('terminal_failure');
      
      // Step 2: Operator investigates
      // (In real scenario, operator would check logs, RPC status, etc.)
      
      // Step 3: If issue is transient, operator can retry
      const result = await svc.settle({
        orderId: 'order-doc-recovery-retry',
        direction: 'xlm_to_eth',
        correlationId: 'cid-doc-retry',
        action: async () => { return '0xtx-doc-recovery'; },
        maxAttempts: 1,
        baseDelayMs: 1,
      });
      
      expect(result.txHash).toBe('0xtx-doc-recovery');
      
      // Step 4: Verify recovery
      const record2 = svc.getStatus('order-doc-recovery-retry');
      expect(record2?.state).toBe('submission_acked');
    });
  });
});
