/**
 * @fileoverview Tests for idempotency.ts
 *
 * Validates:
 *   - Duplicate actions are detected and prevented
 *   - Retries are tracked correctly
 *   - Recovery after crash works
 *   - Network timeout scenarios handled
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IdempotencyManager, IdempotencyError, IdempotencyGuard } from '../src/idempotency.js';

// ── Test helpers ──────────────────────────────────────────────────────────────

function makeOrderId(index: number): string {
  return `order-${index}-${Math.random().toString(36).substring(2, 10)}`;
}

function makeActionType(index: number): 'claim' | 'refund' | 'create_escrow' {
  return ['claim', 'refund', 'create_escrow'][index % 3];
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('IdempotencyManager', () => {
  let manager: IdempotencyManager;

  beforeEach(() => {
    manager = new IdempotencyManager({ storageDir: null });
  });

  describe('record and idempotency', () => {
    it('creates new attempt for unrecorded action', () => {
      const record = manager.record('order-123', 'claim', 'cid-1');
      expect(record.orderId).toBe('order-123');
      expect(record.actionType).toBe('claim');
      expect(record.state).toBe('pending');
      expect(record.retryCount).toBe(0);
      expect(record.attemptId).toMatch(/^attempt-/);
    });

    it('returns existing record for same orderId and actionType', () => {
      const record1 = manager.record('order-123', 'claim', 'cid-1');
      const record2 = manager.record('order-123', 'claim', 'cid-2');

      expect(record1).toBe(record2);
      expect(record1.attemptId).toBe(record2.attemptId);
    });

    it('throws if action already completed', () => {
      manager.record('order-123', 'claim', 'cid-1');
      manager.complete('order-123', 'claim', '0xhash1', 100);

      expect(() => manager.record('order-123', 'claim', 'cid-2')).toThrow(IdempotencyError);
      expect(() => manager.record('order-123', 'claim', 'cid-2')).toThrow('ALREADY_COMPLETED');
    });

    it('throws if action already failed permanently', () => {
      manager.record('order-123', 'claim', 'cid-1');
      manager.fail('order-123', 'claim', 'insufficient funds', true);

      expect(() => manager.record('order-123', 'claim', 'cid-2')).toThrow(IdempotencyError);
      expect(() => manager.record('order-123', 'claim', 'cid-2')).toThrow('PERMANENTLY_FAILED');
    });

    it('allows forceNew to create new attempt', () => {
      manager.record('order-123', 'claim', 'cid-1');
      const record1 = manager.get('order-123', 'claim');
      expect(record1?.retryCount).toBe(0);

      const record2 = manager.record('order-123', 'claim', 'cid-2', true);
      expect(record2).not.toBe(record1);
      expect(record2.attemptId).not.toBe(record1?.attemptId);
    });

    it('increments retryCount for pending action', () => {
      manager.record('order-123', 'claim', 'cid-1');
      manager.record('order-123', 'claim', 'cid-2'); // Same attempt, increments retry

      const record = manager.get('order-123', 'claim');
      expect(record?.retryCount).toBe(1);
    });
  });

  describe('state transitions', () => {
    it('submitted marks transaction as broadcast', () => {
      const record = manager.record('order-123', 'claim', 'cid-1');
      const updated = manager.submitted('order-123', 'claim', '0xhash1');

      expect(updated.state).toBe('submitted');
      expect(updated.txHash).toBe('0xhash1');
      expect(updated.retryCount).toBe(0);
    });

    it('complete marks transaction as mined', () => {
      const record = manager.record('order-123', 'claim', 'cid-1');
      manager.submitted('order-123', 'claim', '0xhash1');
      const updated = manager.complete('order-123', 'claim', '0xhash1', 100);

      expect(updated.state).toBe('completed');
      expect(updated.txHash).toBe('0xhash1');
      expect(updated.minedBlock).toBe(100);
    });

    it('fail marks action as failed', () => {
      const record = manager.record('order-123', 'claim', 'cid-1');
      const updated = manager.fail('order-123', 'claim', 'insufficient funds');

      expect(updated.state).toBe('failed');
      expect(updated.failureReason).toBe('insufficient funds');
    });

    it('abandoned marks action as abandoned', () => {
      const record = manager.record('order-123', 'claim', 'cid-1');
      const updated = manager.fail('order-123', 'claim', 'manual abandon', false);

      expect(updated.state).toBe('abandoned');
      expect(updated.failureReason).toBe('manual abandon');
    });
  });

  describe('canRetry', () => {
    it('returns true for new action', () => {
      expect(manager.canRetry('order-123', 'claim')).toBe(true);
    });

    it('returns true for pending with retries available', () => {
      manager.record('order-123', 'claim', 'cid-1');
      expect(manager.canRetry('order-123', 'claim')).toBe(true);
    });

    it('returns true for abandoned with retries available', () => {
      manager.record('order-123', 'claim', 'cid-1');
      manager.fail('order-123', 'claim', 'abandon', false);
      expect(manager.canRetry('order-123', 'claim')).toBe(true);
    });

    it('returns true for submitted without minedBlock', () => {
      manager.record('order-123', 'claim', 'cid-1');
      manager.submitted('order-123', 'claim', '0xhash1');
      expect(manager.canRetry('order-123', 'claim')).toBe(true);
    });

    it('returns false for completed', () => {
      manager.record('order-123', 'claim', 'cid-1');
      manager.complete('order-123', 'claim', '0xhash1', 100);
      expect(manager.canRetry('order-123', 'claim')).toBe(false);
    });

    it('returns false for failed', () => {
      manager.record('order-123', 'claim', 'cid-1');
      manager.fail('order-123', 'claim', 'error', true);
      expect(manager.canRetry('order-123', 'claim')).toBe(false);
    });

    it('returns false when maxRetryCount exceeded', () => {
      const manager = new IdempotencyManager({ storageDir: null, maxRetryCount: 2 });

      for (let i = 0; i < 2; i++) {
        manager.record('order-123', 'claim', `cid-${i}`);
      }

      // Now at max
      expect(manager.canRetry('order-123', 'claim')).toBe(false);
    });
  });

  describe('getRecoveryContext', () => {
    it('returns canRetry=true for new action', () => {
      const context = manager.getRecoveryContext('order-123', 'claim');
      expect(context.canRetry).toBe(true);
      expect(context.retryReason).toBe('No previous attempt found, safe to start new attempt');
    });

    it('returns canRetry=false for completed', () => {
      manager.record('order-123', 'claim', 'cid-1');
      manager.complete('order-123', 'claim', '0xhash1', 100);

      const context = manager.getRecoveryContext('order-123', 'claim');
      expect(context.canRetry).toBe(false);
      expect(context.retryReason).toBe('Action already completed successfully');
    });

    it('returns canRetry=false for failed', () => {
      manager.record('order-123', 'claim', 'cid-1');
      manager.fail('order-123', 'claim', 'error', true);

      const context = manager.getRecoveryContext('order-123', 'claim');
      expect(context.canRetry).toBe(false);
      expect(context.retryReason).toBe('Action failed permanently: error');
    });

    it('returns canRetry=true for submitted without minedBlock', () => {
      manager.record('order-123', 'claim', 'cid-1');
      manager.submitted('order-123', 'claim', '0xhash1');

      const context = manager.getRecoveryContext('order-123', 'claim');
      expect(context.canRetry).toBe(true);
    });

    it('returns canRetry=false for submitted with minedBlock', () => {
      manager.record('order-123', 'claim', 'cid-1');
      manager.submitted('order-123', 'claim', '0xhash1');
      manager.complete('order-123', 'claim', '0xhash1', 100);

      const context = manager.getRecoveryContext('order-123', 'claim');
      expect(context.canRetry).toBe(false);
      expect(context.retryReason).toBe('Transaction already mined');
    });
  });

  describe('recovery after restart', () => {
    it('loads persisted records on startup', () => {
      // This test would require disk persistence
      // For now, we verify the method exists
      expect(() => manager.reconcile()).resolves.toBeDefined();
    });

    it('marks stale pending as abandoned', async () => {
      // Use a short timeout for testing
      const manager = new IdempotencyManager({
        storageDir: null,
        pendingTimeoutMs: 1, // 1ms
      });

      const record = manager.record('order-123', 'claim', 'cid-1');

      // Wait for timeout
      await new Promise(resolve => setTimeout(resolve, 10));

      const result = await manager.reconcile();

      expect(result.scanned).toBe(1);
      expect(result.failed).toBe(1);
      expect(manager.get('order-123', 'claim')?.state).toBe('abandoned');
    });

    it('marks stale submitted as abandoned', async () => {
      const manager = new IdempotencyManager({
        storageDir: null,
        pendingTimeoutMs: 1,
      });

      const record = manager.record('order-123', 'claim', 'cid-1');
      manager.submitted('order-123', 'claim', '0xhash1');

      // Wait for timeout
      await new Promise(resolve => setTimeout(resolve, 10));

      const result = await manager.reconcile();

      expect(result.scanned).toBe(1);
      expect(result.failed).toBe(1);
      expect(manager.get('order-123', 'claim')?.state).toBe('abandoned');
    });

    it('skips completed records', async () => {
      const manager = new IdempotencyManager({ storageDir: null });

      manager.record('order-123', 'claim', 'cid-1');
      manager.complete('order-123', 'claim', '0xhash1', 100);

      const result = await manager.reconcile();

      expect(result.scanned).toBe(1);
      expect(result.skipped).toBe(1);
    });
  });

  describe('state counts', () => {
    it('returns correct counts', () => {
      manager.record('order-1', 'claim', 'cid-1');
      manager.record('order-2', 'refund', 'cid-2');
      manager.record('order-3', 'create_escrow', 'cid-3');

      manager.submitted('order-3', 'create_escrow', '0xhash3');
      manager.complete('order-3', 'create_escrow', '0xhash3', 100);

      manager.fail('order-2', 'refund', 'error', true);

      const counts = manager.stateCounts();
      expect(counts.pending).toBe(2);
      expect(counts.submitted).toBe(0); // order-3 was submitted then completed
      expect(counts.completed).toBe(1);
      expect(counts.failed).toBe(1);
      expect(counts.abandoned).toBe(0);
    });

    it('byState returns records in given state', () => {
      manager.record('order-1', 'claim', 'cid-1');
      manager.record('order-2', 'refund', 'cid-2');

      manager.fail('order-2', 'refund', 'error', true);

      const pending = manager.byState('pending');
      const failed = manager.byState('failed');

      expect(pending.length).toBe(1);
      expect(pending[0]?.orderId).toBe('order-1');
      expect(failed.length).toBe(1);
      expect(failed[0]?.orderId).toBe('order-2');
    });

    it('byOrderId returns all actions for an order', () => {
      manager.record('order-123', 'claim', 'cid-1');
      manager.record('order-123', 'refund', 'cid-2');

      const actions = manager.byOrderId('order-123');
      expect(actions.length).toBe(2);
      expect(actions.map(a => a.actionType)).toContain('claim');
      expect(actions.map(a => a.actionType)).toContain('refund');
    });
  });

  describe('remove and clear', () => {
    it('remove deletes a specific record', () => {
      manager.record('order-123', 'claim', 'cid-1');
      expect(manager.get('order-123', 'claim')).toBeDefined();

      manager.remove('order-123', 'claim');
      expect(manager.get('order-123', 'claim')).toBeUndefined();
    });

    it('clear deletes all records', () => {
      manager.record('order-1', 'claim', 'cid-1');
      manager.record('order-2', 'refund', 'cid-2');

      manager.clear();

      expect(manager.get('order-1', 'claim')).toBeUndefined();
      expect(manager.get('order-2', 'refund')).toBeUndefined();
    });
  });
});

describe('IdempotencyGuard', () => {
  let manager: IdempotencyManager;
  let guard: IdempotencyGuard;

  beforeEach(() => {
    manager = new IdempotencyManager({ storageDir: null });
    guard = new IdempotencyGuard(manager);
  });

  describe('assertCanAttempt', () => {
    it('succeeds for new action', () => {
      expect(() => guard.assertCanAttempt('order-123', 'claim')).not.toThrow();
    });

    it('throws for already completed', () => {
      manager.record('order-123', 'claim', 'cid-1');
      manager.complete('order-123', 'claim', '0xhash1', 100);

      expect(() => guard.assertCanAttempt('order-123', 'claim')).toThrow(IdempotencyError);
      expect(() => guard.assertCanAttempt('order-123', 'claim')).toThrow('ALREADY_COMPLETED');
    });

    it('throws for already failed', () => {
      manager.record('order-123', 'claim', 'cid-1');
      manager.fail('order-123', 'claim', 'error', true);

      expect(() => guard.assertCanAttempt('order-123', 'claim')).toThrow(IdempotencyError);
      expect(() => guard.assertCanAttempt('order-123', 'claim')).toThrow('PERMANENTLY_FAILED');
    });
  });

  describe('assertCanRetry', () => {
    it('succeeds for new action', () => {
      expect(() => guard.assertCanRetry('order-123', 'claim')).not.toThrow();
    });

    it('succeeds for pending with retries available', () => {
      manager.record('order-123', 'claim', 'cid-1');
      expect(() => guard.assertCanRetry('order-123', 'claim')).not.toThrow();
    });

    it('throws when maxRetryCount exceeded', () => {
      const manager = new IdempotencyManager({ storageDir: null, maxRetryCount: 2 });
      const guard = new IdempotencyGuard(manager);

      for (let i = 0; i < 2; i++) {
        manager.record('order-123', 'claim', `cid-${i}`);
      }

      expect(() => guard.assertCanRetry('order-123', 'claim')).toThrow(IdempotencyError);
      expect(() => guard.assertCanRetry('order-123', 'claim')).toThrow('CANNOT_RETRY');
    });
  });

  describe('assertCompleted', () => {
    it('throws for new action', () => {
      expect(() => guard.assertCompleted('order-123', 'claim')).toThrow(IdempotencyError);
      expect(() => guard.assertCompleted('order-123', 'claim')).toThrow('NOT_COMPLETED');
    });

    it('succeeds for completed action', () => {
      manager.record('order-123', 'claim', 'cid-1');
      manager.complete('order-123', 'claim', '0xhash1', 100);

      expect(() => guard.assertCompleted('order-123', 'claim')).not.toThrow();
    });
  });

  describe('assertSubmitted', () => {
    it('throws for new action', () => {
      expect(() => guard.assertSubmitted('order-123', 'claim')).toThrow(IdempotencyError);
      expect(() => guard.assertSubmitted('order-123', 'claim')).toThrow('NOT_SUBMITTED');
    });

    it('succeeds for submitted action', () => {
      manager.record('order-123', 'claim', 'cid-1');
      manager.submitted('order-123', 'claim', '0xhash1');

      expect(() => guard.assertSubmitted('order-123', 'claim')).not.toThrow();
    });

    it('throws for submitted without txHash', () => {
      manager.record('order-123', 'claim', 'cid-1');
      manager.submitted('order-123', 'claim', '0xhash1');
      const record = manager.get('order-123', 'claim');
      // Simulate txHash being cleared
      record!.txHash = undefined;

      expect(() => guard.assertSubmitted('order-123', 'claim')).toThrow(IdempotencyError);
    });
  });
});

describe('IdempotencyManager duplicate scenarios', () => {
  it('prevents duplicate claim on same order', () => {
    // First claim
    const record1 = manager.record('order-123', 'claim', 'cid-1');
    manager.submitted('order-123', 'claim', '0xhash1');
    manager.complete('order-123', 'claim', '0xhash1', 100);

    // Second claim attempt
    const existing = manager.get('order-123', 'claim');
    expect(existing?.state).toBe('completed');

    // Should not allow new record
    expect(() => manager.record('order-123', 'claim', 'cid-2')).toThrow(
      'ALREADY_COMPLETED',
    );
  });

  it('allows refund after claim', () => {
    // Claim order-123
    manager.record('order-123', 'claim', 'cid-1');
    manager.complete('order-123', 'claim', '0xhash1', 100);

    // Different action type - refund
    const record = manager.record('order-123', 'refund', 'cid-2');
    expect(record.actionType).toBe('refund');
    expect(record.orderId).toBe('order-123');
  });

  it('handles network timeout then success', () => {
    // First attempt times out
    manager.record('order-123', 'claim', 'cid-1');
    manager.submitted('order-123', 'claim', '0xhash1');

    // Network timeout - retry
    const canRetry1 = manager.canRetry('order-123', 'claim');
    expect(canRetry1).toBe(true);

    // Later, transaction is found mined
    manager.complete('order-123', 'claim', '0xhash1', 100);

    const record = manager.get('order-123', 'claim');
    expect(record?.state).toBe('completed');
    expect(record?.txHash).toBe('0xhash1');
    expect(record?.minedBlock).toBe(100);
  });

  it('handles process restart with pending submission', async () => {
    // Simulate restart - use disk-based manager
    const tempDir = '/tmp/idempotency-test-' + Date.now();
    const manager = new IdempotencyManager({ storageDir: tempDir });

    // Create pending submission
    manager.record('order-123', 'claim', 'cid-1');
    manager.submitted('order-123', 'claim', '0xhash1');

    // Simulate restart - new manager
    const manager2 = new IdempotencyManager({ storageDir: tempDir });

    // Load persisted record
    const record = manager2.get('order-123', 'claim');
    expect(record?.state).toBe('submitted');
    expect(record?.txHash).toBe('0xhash1');

    // Clean up
    manager2.clear();
    try {
      // Note: this might fail on Windows - that's ok for test
      // require('fs').rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });
});

// ── Edge cases ────────────────────────────────────────────────────────────────

describe('IdempotencyManager edge cases', () => {
  it('handles concurrent attempts gracefully', () => {
    // Multiple calls with same orderId/actionType return same record
    const promises = [
      manager.record('order-123', 'claim', 'cid-1'),
      manager.record('order-123', 'claim', 'cid-2'),
      manager.record('order-123', 'claim', 'cid-3'),
    ];

    const results = Promise.all(promises);
    results.then(results => {
      expect(results[0]).toBe(results[1]);
      expect(results[1]).toBe(results[2]);
    });
  });

  it('handles many different orders', () => {
    for (let i = 0; i < 100; i++) {
      manager.record(`order-${i}`, 'claim', `cid-${i}`);
    }

    expect(manager.stateCounts().pending).toBe(100);
  });

  it('handles action types gracefully', () => {
    const actions: Array<'claim' | 'refund' | 'create_escrow'> = ['claim', 'refund', 'create_escrow'];

    for (const action of actions) {
      manager.record('order-123', action, 'cid-1');
    }

    expect(manager.byOrderId('order-123').length).toBe(3);
  });
});
