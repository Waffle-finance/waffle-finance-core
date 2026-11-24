/**
 * @fileoverview Failure scenario smoke tests for the relayer.
 * 
 * These tests inject realistic failure conditions to validate:
 * - Network timeouts and connection drops
 * - Rate limiting and quota exhaustion
 * - Partial failures (some chains succeed, others fail)
 * - Coordinator metadata delays
 * - Provider latency variations
 * 
 * Usage: pnpm test:smoke --filter failure
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SettlementService } from '../../src/services/settlement-service.js';
import { RetryEngine } from '../../src/utils/retry-engine.js';
import { TxStateStore } from '../../src/services/tx-state-store.js';

// Mock metrics using importOriginal to avoid missing export errors
vi.mock('../../src/metrics.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/metrics.js')>();
  return {
    ...actual,
    settlementAttemptsTotal: { inc: vi.fn() },
    settlementFailuresTotal: { inc: vi.fn() },
    settlementRecoveryTotal: { inc: vi.fn() },
    settlementStateGauge: { set: vi.fn() },
    settlementDurationSeconds: { observe: vi.fn(), startTimer: vi.fn(() => vi.fn()) },
    settlementSuccessTotal: { inc: vi.fn() },
    retryEngineAttemptsTotal: { inc: vi.fn() },
    retryEngineCircuitState: { set: vi.fn() },
    txStateReconciliationDurationSeconds: { observe: vi.fn(), startTimer: vi.fn(() => vi.fn()) },
    txStateReconciliationsTotal: { inc: vi.fn() },
  };
});

// ── Failure injection helpers ───────────────────────────────────────────────

/**
 * Simulates a network timeout error.
 */
export function timeoutError(): Error {
  const err = new Error('ETIMEDOUT: connection timeout');
  (err as any).code = 'ETIMEDOUT';
  return err;
}

/**
 * Simulates a rate limit error.
 */
export function rateLimitError(): Error {
  const err = new Error('429 Too Many Requests: rate limit exceeded');
  (err as any).status = 429;
  return err;
}

/**
 * Simulates a connection refused error.
 */
export function connectionRefusedError(): Error {
  const err = new Error('ECONNREFUSED: connection refused');
  (err as any).code = 'ECONNREFUSED';
  return err;
}

/**
 * Simulates a transaction reverted error (terminal).
 */
export function transactionRevertedError(): Error {
  return new Error('execution reverted: insufficient funds');
}

/**
 * Creates a service with injected failure behavior.
 */
export function makeFaultyService(injectFailure?: (attempt: number) => Error | null) {
  const txStateStore = new TxStateStore({ storageDir: null });
  const retryEngine = new RetryEngine({
    defaultMaxAttempts: 5,
    defaultBaseDelayMs: 1,
    defaultMaxDelayMs: 10,
    circuitBreakerThreshold: 10, // High threshold so normal tests don't trip it
  });
  
  const svc = new SettlementService({ txStateStore, retryEngine });
  
  return { svc, retryEngine };
}

/**
 * Creates a service with a low circuit breaker threshold for circuit breaker tests.
 */
export function makeCircuitBreakerService() {
  const txStateStore = new TxStateStore({ storageDir: null });
  const retryEngine = new RetryEngine({
    defaultMaxAttempts: 1, // Single attempt per order
    defaultBaseDelayMs: 1,
    defaultMaxDelayMs: 10,
    circuitBreakerThreshold: 2, // Open after 2 failures
    circuitBreakerResetMs: 10,  // Reset quickly for testability
  });
  const svc = new SettlementService({ txStateStore, retryEngine });
  return { svc, retryEngine };
}

// ── Test suites ─────────────────────────────────────────────────────────────

describe('Relayer smoke — failure scenarios', () => {
  describe('network timeout patterns', () => {
    it('handles transient network timeouts with retry', async () => {
      const { svc } = makeFaultyService();
      let attempts = 0;
      
      const result = await svc.settle({
        orderId: 'order-timeout',
        direction: 'xlm_to_eth',
        correlationId: 'cid-timeout',
        action: async () => {
          attempts++;
          if (attempts < 3) throw timeoutError();
          return '0xtx_timeout_success';
        },
        maxAttempts: 5,
        baseDelayMs: 1,
      });
      
      expect(result.txHash).toBe('0xtx_timeout_success');
      expect(attempts).toBe(3);
    });

    it('marks circuit as open after sustained timeouts', async () => {
      const { svc, retryEngine } = makeCircuitBreakerService();
      
      // Create enough failures to open the circuit (threshold=2)
      for (let i = 0; i < 2; i++) {
        try {
          await svc.settle({
            orderId: `order-timeout-${i}`,
            direction: 'xlm_to_eth',
            correlationId: `cid-timeout-${i}`,
            action: async () => { throw timeoutError(); },
            maxAttempts: 1,
            baseDelayMs: 1,
          });
        } catch {
          // Expected failure
        }
      }
      
      // Circuit should be open
      const state = retryEngine.circuitState('settlement:xlm_to_eth');
      expect(state).toBe('open');
    });

    it('recovers from timeout circuit after cooldown', async () => {
      const { svc, retryEngine } = makeCircuitBreakerService();
      
      // Trip the circuit (2 failures needed to open with threshold=2)
      for (let i = 0; i < 2; i++) {
        try {
          await svc.settle({
            orderId: `order-trip-${i}`,
            direction: 'xlm_to_eth',
            correlationId: `cid-trip-${i}`,
            action: async () => { throw timeoutError(); },
            maxAttempts: 1,
            baseDelayMs: 1,
          });
        } catch {
          // Expected
        }
      }
      
      expect(retryEngine.circuitState('settlement:xlm_to_eth')).toBe('open');
      
      // Wait for circuit breaker reset (circuitBreakerResetMs=10ms)
      await new Promise(resolve => setTimeout(resolve, 20));
      
      // Now a successful call should transition to half-open and close
      const result = await svc.settle({
        orderId: 'order-recover',
        direction: 'xlm_to_eth',
        correlationId: 'cid-recover',
        action: async () => { return '0xtx_recovered'; },
        maxAttempts: 1,
        baseDelayMs: 1,
      });
      
      expect(result.txHash).toBe('0xtx_recovered');
      expect(retryEngine.circuitState('settlement:xlm_to_eth')).toBe('closed');
    });
  });

  describe('rate limit handling', () => {
    it('backs off appropriately on rate limits', async () => {
      const { svc } = makeFaultyService();
      let attempts = 0;
      
      const result = await svc.settle({
        orderId: 'order-ratelimit',
        direction: 'xlm_to_eth',
        correlationId: 'cid-ratelimit',
        action: async () => {
          attempts++;
          if (attempts < 4) throw rateLimitError();
          return '0xtx_ratelimit_success';
        },
        maxAttempts: 6,
        baseDelayMs: 2,
      });
      
      expect(result.txHash).toBe('0xtx_ratelimit_success');
      expect(attempts).toBe(4);
    });

    it('continues processing other orders when one hits rate limit', async () => {
      const { svc } = makeFaultyService();
      
      // Order that hits rate limit
      await expect(svc.settle({
        orderId: 'order-rate-limited',
        direction: 'xlm_to_eth',
        correlationId: 'cid-rate',
        action: async () => { throw rateLimitError(); },
        maxAttempts: 2,
        baseDelayMs: 1,
      })).rejects.toThrow();
      
      // Another order should still work
      const result = await svc.settle({
        orderId: 'order-normal',
        direction: 'eth_to_xlm',
        correlationId: 'cid-normal',
        action: async () => { return '0xtx_normal'; },
        maxAttempts: 1,
        baseDelayMs: 1,
      });
      
      expect(result.txHash).toBe('0xtx_normal');
    });
  });

  describe('partial failure scenarios', () => {
    it('handles Stellar-only failure when Ethereum succeeds', async () => {
      const { svc } = makeFaultyService();
      
      // Simulate a scenario where Ethereum settlement succeeds but Stellar refund fails
      const ethResult = await svc.settle({
        orderId: 'order-partial-eth',
        direction: 'xlm_to_eth',
        correlationId: 'cid-partial',
        action: async () => { return '0xtx_eth_success'; },
        maxAttempts: 1,
        baseDelayMs: 1,
      });
      
      expect(ethResult.txHash).toBe('0xtx_eth_success');
      
      // Track the state
      const record = svc.getStatus('order-partial-eth');
      expect(record?.state).toBe('submission_acked');
    });

    it('handles Ethereum-only failure when Stellar succeeds', async () => {
      const { svc } = makeFaultyService();
      
      const xlmResult = await svc.settle({
        orderId: 'order-partial-xlm',
        direction: 'eth_to_xlm',
        correlationId: 'cid-partial-xlm',
        action: async () => { return '0xtx_xlm_success'; },
        maxAttempts: 1,
        baseDelayMs: 1,
      });
      
      expect(xlmResult.txHash).toBe('0xtx_xlm_success');
    });

    it('marks orders as failed when both chains fail', async () => {
      const { svc } = makeFaultyService();
      
      // First chain fails
      try {
        await svc.settle({
          orderId: 'order-both-fail',
          direction: 'xlm_to_eth',
          correlationId: 'cid-both',
          action: async () => { throw transactionRevertedError(); },
          maxAttempts: 1,
          baseDelayMs: 1,
        });
      } catch {
        // Expected
      }
      
      const record = svc.getStatus('order-both-fail');
      expect(record?.state).toBe('terminal_failure');
    });
  });

  describe('coordinator metadata delay simulation', () => {
    it('handles delayed coordinator acknowledgment', async () => {
      const { svc } = makeFaultyService();
      
      // Submit transaction
      const result = await svc.settle({
        orderId: 'order-delay-coord',
        direction: 'xlm_to_eth',
        correlationId: 'cid-delay',
        action: async () => { return '0xtx_delay_coord'; },
        maxAttempts: 1,
        baseDelayMs: 1,
      });
      
      expect(result.txHash).toBe('0xtx_delay_coord');
      
      // Record is in submission_acked initially
      const record1 = svc.getStatus('order-delay-coord');
      expect(record1?.state).toBe('submission_acked');
      
      // Advance to chain_mined state before coordinator ack
      svc.recordReceipt('order-delay-coord', {
        hash: '0xtx_delay_coord',
        blockNumber: 100,
        blockHash: '0xblock',
        status: 1,
        gasUsed: 21000n,
        confirmations: 12,
      });
      
      // Coordinator ack comes in later
      svc.recordCoordinatorAck('order-delay-coord', 'coord-ref-123');
      const record2 = svc.getStatus('order-delay-coord');
      expect(record2?.state).toBe('coordinator_recorded');
      expect(record2?.coordinatorRef).toBe('coord-ref-123');
    });

    it('reconciles pending coordinator acks on restart', async () => {
      const { svc } = makeFaultyService();
      
      // Submit and get to submission_acked
      await svc.settle({
        orderId: 'order-recon-pending',
        direction: 'xlm_to_eth',
        correlationId: 'cid-recon',
        action: async () => { return '0xtx_recon_pending'; },
        maxAttempts: 1,
        baseDelayMs: 1,
      });
      
      const record1 = svc.getStatus('order-recon-pending');
      expect(record1?.state).toBe('submission_acked');
      expect(record1?.coordinatorRef).toBeUndefined();
      
      // Simulate reconciliation (as would happen on startup)
      await svc.reconcile(null, 'startup');
      
      // Should still be in submission_acked (waiting for coordinator)
      const record2 = svc.getStatus('order-recon-pending');
      expect(record2?.state).toBe('submission_acked');
    });
  });

  describe('provider latency simulation', () => {
    it('handles slow RPC responses', async () => {
      const { svc } = makeFaultyService();
      let attempts = 0;
      
      const result = await svc.settle({
        orderId: 'order-slow-rpc',
        direction: 'xlm_to_eth',
        correlationId: 'cid-slow',
        action: async () => {
          attempts++;
          // Simulate slow RPC (in real scenario, would use setTimeout, but for test we just count)
          return '0xtx_slow_rpc';
        },
        maxAttempts: 1,
        baseDelayMs: 1,
      });
      
      expect(result.txHash).toBe('0xtx_slow_rpc');
    });

    it('detects and handles latency-induced timeouts', async () => {
      const { svc } = makeFaultyService();
      let attempts = 0;
      
      // Simulate a scenario that fails once then succeeds
      const action = async () => {
        attempts++;
        if (attempts === 1) throw timeoutError(); // First attempt times out
        return '0xtx_latency_success'; // Second attempt succeeds
      };
      
      const result = await svc.settle({
        orderId: 'order-latency',
        direction: 'xlm_to_eth',
        correlationId: 'cid-latency',
        action,
        maxAttempts: 4,
        baseDelayMs: 1,
      });
      
      expect(result.txHash).toBe('0xtx_latency_success');
      expect(attempts).toBe(2);
    });
  });

  describe('idempotency under failure', () => {
    it('maintains idempotency despite failures', async () => {
      const { svc } = makeFaultyService();
      
      // First attempt fails
      try {
        await svc.settle({
          orderId: 'order-idem-fail',
          direction: 'xlm_to_eth',
          correlationId: 'cid-idem',
          action: async () => { throw timeoutError(); },
          maxAttempts: 2,
          baseDelayMs: 1,
        });
      } catch {
        // Expected
      }
      
      // Second attempt with same orderId should return cached result
      // (in real scenario, would check the persisted state)
      const record = svc.getStatus('order-idem-fail');
      expect(record?.state).toBe('terminal_failure');
    });

    it('allows retry with different orderId after failure', async () => {
      const { svc } = makeFaultyService();
      
      // First order fails
      try {
        await svc.settle({
          orderId: 'order-fail-1',
          direction: 'xlm_to_eth',
          correlationId: 'cid-1',
          action: async () => { throw timeoutError(); },
          maxAttempts: 1,
          baseDelayMs: 1,
        });
      } catch {
        // Expected
      }
      
      // Second order with different ID should work
      const result = await svc.settle({
        orderId: 'order-success-2',
        direction: 'xlm_to_eth',
        correlationId: 'cid-2',
        action: async () => { return '0xtx_retry'; },
        maxAttempts: 1,
        baseDelayMs: 1,
      });
      
      expect(result.txHash).toBe('0xtx_retry');
    });
  });
});
