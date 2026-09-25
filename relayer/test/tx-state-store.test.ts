/**
 * Tests for relayer/src/services/tx-state-store.ts
 *
 * Covers:
 *  a. Happy-path full lifecycle: create → ackSubmission → recordReceipt
 *        → recordCoordinatorAck → markComplete
 *  b. Terminal failure path from every non-terminal state
 *  c. Invalid transition rejection (TxStateError INVALID_TRANSITION)
 *  d. Duplicate receipt idempotency
 *  e. Duplicate create rejection (TxStateError ALREADY_EXISTS)
 *  f. Reconciliation — startup recovery of submission_acked records
 *  g. Reconciliation — pending_submission timeout → terminal_failure
 *  h. Reconciliation — coordinator_recorded → complete auto-advance
 *  i. Reconciliation — reverted tx (receipt.status = 0) → terminal_failure
 *  j. Restart recovery — records reload from disk on second instantiation
 *  k. stateCounts() and snapshot() helpers
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Isolate metrics so we don't depend on the shared registry
vi.mock('../src/metrics.js', () => ({
  txStateTransitionsTotal: { inc: vi.fn() },
  txStateReconciliationsTotal: { inc: vi.fn() },
  txStateRecoveredTotal: { inc: vi.fn() },
  txStateDuplicateReceiptsTotal: { inc: vi.fn() },
  txStateCurrentByState: { set: vi.fn() },
  txStateReconciliationDurationSeconds: { startTimer: () => () => {} },
  correlationOpsTotal: { inc: vi.fn() },
  correlationCheckpointsTotal: { inc: vi.fn() },
  correlationOpDurationSeconds: { startTimer: () => () => {} },
  correlationRetryHopsTotal: { inc: vi.fn() },
}));

import {
  TxStateStore,
  TxStateError,
  isTerminalState,
  isTransitionAllowed,
  type TxReceipt,
  type ChainProvider,
} from '../src/services/tx-state-store.js';
import os from 'os';
import path from 'path';
import fs from 'fs';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Create an in-memory store (no disk I/O). */
function makeStore(): TxStateStore {
  return new TxStateStore({ storageDir: null });
}

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

/** Minimal ChainProvider stub that returns the given receipt. */
function makeProvider(receipt: TxReceipt | null): ChainProvider {
  return {
    getTransactionReceipt: vi.fn().mockResolvedValue(receipt),
    getBlockNumber: vi.fn().mockResolvedValue(200),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('TxStateStore — state machine', () => {

  describe('isTerminalState()', () => {
    it('marks complete and terminal_failure as terminal', () => {
      expect(isTerminalState('complete')).toBe(true);
      expect(isTerminalState('terminal_failure')).toBe(true);
    });

    it('non-terminal states return false', () => {
      const nonTerminal = ['pending_submission', 'submission_acked', 'chain_mined', 'coordinator_recorded'] as const;
      for (const s of nonTerminal) {
        expect(isTerminalState(s)).toBe(false);
      }
    });
  });

  describe('isTransitionAllowed()', () => {
    it('allows the happy-path sequence', () => {
      expect(isTransitionAllowed('pending_submission', 'submission_acked')).toBe(true);
      expect(isTransitionAllowed('submission_acked', 'chain_mined')).toBe(true);
      expect(isTransitionAllowed('chain_mined', 'coordinator_recorded')).toBe(true);
      expect(isTransitionAllowed('coordinator_recorded', 'complete')).toBe(true);
    });

    it('allows terminal_failure from every non-terminal state', () => {
      const states = ['pending_submission', 'submission_acked', 'chain_mined', 'coordinator_recorded'] as const;
      for (const s of states) {
        expect(isTransitionAllowed(s, 'terminal_failure')).toBe(true);
      }
    });

    it('disallows backwards transitions', () => {
      expect(isTransitionAllowed('submission_acked', 'pending_submission')).toBe(false);
      expect(isTransitionAllowed('chain_mined', 'submission_acked')).toBe(false);
      expect(isTransitionAllowed('complete', 'chain_mined')).toBe(false);
    });

    it('disallows exiting a terminal state', () => {
      expect(isTransitionAllowed('complete', 'complete')).toBe(false);
      expect(isTransitionAllowed('terminal_failure', 'pending_submission')).toBe(false);
    });
  });
});

describe('TxStateStore — happy-path lifecycle', () => {
  it('full lifecycle: pending → acked → mined → coordinator → complete', () => {
    const store = makeStore();
    const orderId = 'order_happy';

    const r1 = store.create({ orderId, correlationId: 'cid-1', route: 'eth_to_xlm' });
    expect(r1.state).toBe('pending_submission');

    const r2 = store.ackSubmission(orderId, '0xtxhash');
    expect(r2.state).toBe('submission_acked');
    expect(r2.txHash).toBe('0xtxhash');

    const { record: r3, accepted } = store.recordReceipt(orderId, makeReceipt({ blockNumber: 42 }));
    expect(accepted).toBe(true);
    expect(r3.state).toBe('chain_mined');
    expect(r3.minedBlock).toBe(42);

    const r4 = store.recordCoordinatorAck(orderId, 'coordinator-ref-xyz');
    expect(r4.state).toBe('coordinator_recorded');
    expect(r4.coordinatorRef).toBe('coordinator-ref-xyz');

    const r5 = store.markComplete(orderId);
    expect(r5.state).toBe('complete');
    expect(r5.transitions).toHaveLength(4); // 4 transitions made
  });

  it('transitions array records every hop', () => {
    const store = makeStore();
    store.create({ orderId: 'ord1', correlationId: 'c1', route: 'xlm_to_eth' });
    store.ackSubmission('ord1', '0xhash');
    const record = store.get('ord1')!;
    expect(record.transitions.length).toBeGreaterThanOrEqual(1);
    expect(record.transitions[0].from).toBe('pending_submission');
    expect(record.transitions[0].to).toBe('submission_acked');
  });

  it('get() returns undefined for unknown orderId', () => {
    const store = makeStore();
    expect(store.get('nonexistent')).toBeUndefined();
  });
});

describe('TxStateStore — terminal failure', () => {
  it('markFailed from pending_submission transitions to terminal_failure', () => {
    const store = makeStore();
    store.create({ orderId: 'fail1', correlationId: 'c', route: 'eth_to_xlm' });
    const rec = store.markFailed('fail1', 'timeout');
    expect(rec.state).toBe('terminal_failure');
    expect(rec.failureReason).toBe('timeout');
  });

  it('markFailed from submission_acked works', () => {
    const store = makeStore();
    store.create({ orderId: 'fail2', correlationId: 'c', route: 'eth_to_xlm' });
    store.ackSubmission('fail2', '0xhash');
    const rec = store.markFailed('fail2', 'rpc dead');
    expect(rec.state).toBe('terminal_failure');
  });

  it('markFailed from chain_mined works', () => {
    const store = makeStore();
    store.create({ orderId: 'fail3', correlationId: 'c', route: 'eth_to_xlm' });
    store.ackSubmission('fail3', '0xhash');
    store.recordReceipt('fail3', makeReceipt());
    const rec = store.markFailed('fail3', 'coordinator down');
    expect(rec.state).toBe('terminal_failure');
  });

  it('cannot transition out of terminal_failure', () => {
    const store = makeStore();
    store.create({ orderId: 'stuck', correlationId: 'c', route: 'eth_to_xlm' });
    store.markFailed('stuck', 'rpc');
    expect(() => store.ackSubmission('stuck', '0x')).toThrow(TxStateError);
  });
});

describe('TxStateStore — error cases', () => {
  it('create() throws ALREADY_EXISTS for duplicate orderId', () => {
    const store = makeStore();
    store.create({ orderId: 'dup', correlationId: 'c', route: 'eth_to_xlm' });
    expect(() =>
      store.create({ orderId: 'dup', correlationId: 'c2', route: 'eth_to_xlm' })
    ).toThrow(TxStateError);

    try {
      store.create({ orderId: 'dup', correlationId: 'c2', route: 'eth_to_xlm' });
    } catch (err) {
      expect((err as TxStateError).code).toBe('ALREADY_EXISTS');
    }
  });

  it('ackSubmission() throws INVALID_TRANSITION when already mined', () => {
    const store = makeStore();
    store.create({ orderId: 'late', correlationId: 'c', route: 'eth_to_xlm' });
    store.ackSubmission('late', '0xhash');
    store.recordReceipt('late', makeReceipt());
    expect(() => store.ackSubmission('late', '0xhash2')).toThrow(TxStateError);
  });

  it('NOT_FOUND thrown when orderId does not exist', () => {
    const store = makeStore();
    try {
      store.ackSubmission('ghost', '0xhash');
    } catch (err) {
      expect((err as TxStateError).code).toBe('NOT_FOUND');
    }
  });
});

describe('TxStateStore — duplicate receipt idempotency', () => {
  it('re-submitting same txHash returns accepted=false', () => {
    const store = makeStore();
    store.create({ orderId: 'idem', correlationId: 'c', route: 'eth_to_xlm' });
    store.ackSubmission('idem', '0xabc');
    const first = store.recordReceipt('idem', makeReceipt({ hash: '0xabc' }));
    expect(first.accepted).toBe(true);

    // Second submission of same receipt
    const second = store.recordReceipt('idem', makeReceipt({ hash: '0xabc' }));
    expect(second.accepted).toBe(false);
    // State must not have changed
    expect(second.record.state).toBe('chain_mined');
  });
});

describe('TxStateStore — stateCounts() and snapshot()', () => {
  it('counts records per state', () => {
    const store = makeStore();
    store.create({ orderId: 'a', correlationId: 'ca', route: 'eth_to_xlm' });
    store.create({ orderId: 'b', correlationId: 'cb', route: 'eth_to_xlm' });
    store.ackSubmission('b', '0xhash');
    const counts = store.stateCounts();
    expect(counts.pending_submission).toBe(1);
    expect(counts.submission_acked).toBe(1);
    expect(counts.complete).toBe(0);
  });

  it('snapshot() returns all records', () => {
    const store = makeStore();
    store.create({ orderId: 'x1', correlationId: 'c', route: 'eth_to_xlm' });
    store.create({ orderId: 'x2', correlationId: 'c', route: 'xlm_to_eth' });
    expect(store.snapshot()).toHaveLength(2);
    expect(store.size()).toBe(2);
  });

  it('byState() filters correctly', () => {
    const store = makeStore();
    store.create({ orderId: 'p1', correlationId: 'c', route: 'eth_to_xlm' });
    store.create({ orderId: 'p2', correlationId: 'c', route: 'eth_to_xlm' });
    store.ackSubmission('p1', '0x1');
    const pending = store.byState('pending_submission');
    const acked = store.byState('submission_acked');
    expect(pending.map(r => r.orderId)).toContain('p2');
    expect(acked.map(r => r.orderId)).toContain('p1');
  });
});

describe('TxStateStore — reconciliation', () => {

  it('reconcile() advances submission_acked → chain_mined when receipt is available', async () => {
    const store = makeStore();
    store.create({ orderId: 'rec1', correlationId: 'c', route: 'eth_to_xlm' });
    store.ackSubmission('rec1', '0xtxhash');

    const provider = makeProvider(makeReceipt({ hash: '0xtxhash', blockNumber: 55 }));
    const summary = await store.reconcile(provider, 'startup');

    expect(summary.advanced).toBeGreaterThanOrEqual(1);
    expect(store.get('rec1')!.state).toBe('chain_mined');
    expect(store.get('rec1')!.minedBlock).toBe(55);
  });

  it('reconcile() marks terminal_failure when receipt.status = 0 (reverted)', async () => {
    const store = makeStore();
    store.create({ orderId: 'rev1', correlationId: 'c', route: 'eth_to_xlm' });
    store.ackSubmission('rev1', '0xrev');

    const provider = makeProvider(makeReceipt({ hash: '0xrev', status: 0 }));
    await store.reconcile(provider, 'startup');

    expect(store.get('rev1')!.state).toBe('terminal_failure');
    expect(store.get('rev1')!.failureReason).toMatch(/reverted/i);
  });

  it('reconcile() skips submission_acked when receipt not yet available (null)', async () => {
    const store = makeStore();
    store.create({ orderId: 'wait1', correlationId: 'c', route: 'eth_to_xlm' });
    store.ackSubmission('wait1', '0xpending');

    const provider = makeProvider(null);
    const summary = await store.reconcile(provider, 'scheduled');

    expect(summary.skipped).toBeGreaterThanOrEqual(1);
    expect(store.get('wait1')!.state).toBe('submission_acked');
  });

  it('reconcile() marks terminal_failure for timed-out pending_submission', async () => {
    const store = new TxStateStore({
      storageDir: null,
      pendingSubmissionTimeoutMs: 1, // 1ms timeout — immediately expires
    });
    store.create({ orderId: 'timeout1', correlationId: 'c', route: 'eth_to_xlm' });

    await new Promise<void>(r => setTimeout(r, 5)); // let timeout expire
    await store.reconcile(null, 'startup');

    expect(store.get('timeout1')!.state).toBe('terminal_failure');
    expect(store.get('timeout1')!.failureReason).toMatch(/timeout/i);
  });

  it('reconcile() auto-advances coordinator_recorded → complete', async () => {
    const store = makeStore();
    store.create({ orderId: 'coord1', correlationId: 'c', route: 'eth_to_xlm' });
    store.ackSubmission('coord1', '0xhash');
    store.recordReceipt('coord1', makeReceipt());
    store.recordCoordinatorAck('coord1', 'ref-abc');

    await store.reconcile(null, 'startup');

    expect(store.get('coord1')!.state).toBe('complete');
  });

  it('reconcile() skips terminal records', async () => {
    const store = makeStore();
    store.create({ orderId: 'done1', correlationId: 'c', route: 'eth_to_xlm' });
    store.markFailed('done1', 'already failed');

    const summary = await store.reconcile(null, 'startup');
    expect(summary.scanned).toBe(0); // terminal records are not scanned
    expect(store.get('done1')!.state).toBe('terminal_failure');
  });

  it('reconcile() returns a populated ReconcileSummary', async () => {
    const store = makeStore();
    store.create({ orderId: 's1', correlationId: 'c', route: 'eth_to_xlm' });
    store.ackSubmission('s1', '0xhash');

    const summary = await store.reconcile(makeProvider(makeReceipt()), 'manual');
    expect(summary.trigger).toBe('manual');
    expect(typeof summary.scanned).toBe('number');
    expect(typeof summary.advanced).toBe('number');
    expect(typeof summary.startedAt).toBe('number');
  });

  it('stops after maxRecoveryAttempts', async () => {
    const store = new TxStateStore({
      storageDir: null,
      maxRecoveryAttempts: 1,
    });
    store.create({ orderId: 'max1', correlationId: 'c', route: 'eth_to_xlm' });
    store.ackSubmission('max1', '0xtx');

    // First reconcile — uses the 1 allowed attempt with no receipt
    await store.reconcile(makeProvider(null), 'scheduled');
    // Second reconcile — exceeds limit → terminal_failure
    await store.reconcile(makeProvider(null), 'scheduled');

    expect(store.get('max1')!.state).toBe('terminal_failure');
  });
});

describe('TxStateStore — disk persistence and restart recovery', () => {
  it('reloads persisted records on second instantiation', async () => {
    const dir = path.join(os.tmpdir(), `waffle-tx-store-test-${Date.now()}`);
    try {
      // First store — create and advance a record
      const store1 = new TxStateStore({ storageDir: dir });
      store1.create({ orderId: 'persist1', correlationId: 'cid', route: 'eth_to_xlm' });
      store1.ackSubmission('persist1', '0xtxhash');

      // Second store — simulate restart, same storageDir
      const store2 = new TxStateStore({ storageDir: dir });
      const reloaded = store2.get('persist1');

      expect(reloaded).toBeDefined();
      expect(reloaded!.state).toBe('submission_acked');
      expect(reloaded!.txHash).toBe('0xtxhash');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reconcile() after restart recovers submission_acked → chain_mined', async () => {
    const dir = path.join(os.tmpdir(), `waffle-tx-store-test-${Date.now()}`);
    try {
      const store1 = new TxStateStore({ storageDir: dir });
      store1.create({ orderId: 'restart1', correlationId: 'cid', route: 'eth_to_xlm' });
      store1.ackSubmission('restart1', '0xhash');

      // Simulate restart
      const store2 = new TxStateStore({ storageDir: dir });
      const provider = makeProvider(makeReceipt({ hash: '0xhash', blockNumber: 77 }));
      await store2.reconcile(provider, 'startup');

      expect(store2.get('restart1')!.state).toBe('chain_mined');
      expect(store2.get('restart1')!.minedBlock).toBe(77);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not duplicate records on reload', async () => {
    const dir = path.join(os.tmpdir(), `waffle-tx-store-test-${Date.now()}`);
    try {
      const store1 = new TxStateStore({ storageDir: dir });
      store1.create({ orderId: 'nodup', correlationId: 'c', route: 'eth_to_xlm' });

      const store2 = new TxStateStore({ storageDir: dir });
      expect(store2.size()).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resumes mid-submission after restart without duplicating receipt work', async () => {
    const dir = path.join(os.tmpdir(), `waffle-tx-store-test-${Date.now()}`);
    try {
      const store1 = new TxStateStore({ storageDir: dir });
      store1.create({ orderId: 'resume-mid-submit', correlationId: 'cid', route: 'xlm_to_eth' });
      store1.ackSubmission('resume-mid-submit', '0xresume');

      // Simulate process restart with an in-flight submission_acked record.
      const store2 = new TxStateStore({ storageDir: dir });
      expect(store2.get('resume-mid-submit')!.state).toBe('submission_acked');

      const provider = makeProvider(makeReceipt({ hash: '0xresume', blockNumber: 88 }));
      await store2.reconcile(provider, 'startup');
      expect(store2.get('resume-mid-submit')!.state).toBe('chain_mined');

      // A second sweep with the same receipt must not re-apply transitions.
      await store2.reconcile(provider, 'scheduled');
      expect(store2.get('resume-mid-submit')!.state).toBe('chain_mined');
      expect(store2.get('resume-mid-submit')!.transitions.filter((t) => t.to === 'chain_mined')).toHaveLength(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// TxStateStore — persisted block number validation (issue #610)
// ===========================================================================

describe('TxStateStore — persisted block number validation', () => {
  function writeRawRecord(dir: string, record: object): void {
    const orderId = (record as any).orderId as string;
    const safe = orderId.replace(/[^a-zA-Z0-9_\-]/g, '_').substring(0, 120);
    const fpath = path.join(dir, `${safe}.json`);
    fs.writeFileSync(fpath, JSON.stringify({ ...record, savedAt: Date.now() }), 'utf-8');
  }

  it('rejects a record with a negative minedBlock', () => {
    const dir = path.join(os.tmpdir(), `waffle-tx-store-blockval-${Date.now()}`);
    try {
      fs.mkdirSync(dir, { recursive: true });
      writeRawRecord(dir, {
        orderId: 'neg-block',
        correlationId: 'cid',
        route: 'eth_to_xlm',
        state: 'chain_mined',
        txHash: '0xabc',
        minedBlock: -1,          // invalid: negative
        createdAt: Date.now(),
        updatedAt: Date.now(),
        transitions: [],
        recoveryAttempts: 0,
      });

      const store = new TxStateStore({ storageDir: dir });
      // The corrupt record must NOT be loaded.
      expect(store.get('neg-block')).toBeUndefined();
      expect(store.size()).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a record with a fractional minedBlock', () => {
    const dir = path.join(os.tmpdir(), `waffle-tx-store-blockval-${Date.now()}`);
    try {
      fs.mkdirSync(dir, { recursive: true });
      writeRawRecord(dir, {
        orderId: 'frac-block',
        correlationId: 'cid',
        route: 'eth_to_xlm',
        state: 'chain_mined',
        txHash: '0xabc',
        minedBlock: 100.5,       // invalid: fractional
        createdAt: Date.now(),
        updatedAt: Date.now(),
        transitions: [],
        recoveryAttempts: 0,
      });

      const store = new TxStateStore({ storageDir: dir });
      expect(store.get('frac-block')).toBeUndefined();
      expect(store.size()).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a record with NaN as minedBlock', () => {
    const dir = path.join(os.tmpdir(), `waffle-tx-store-blockval-${Date.now()}`);
    try {
      fs.mkdirSync(dir, { recursive: true });
      // JSON.stringify(NaN) => 'null'; write raw to simulate corrupt file
      const orderId = 'nan-block';
      const fpath = path.join(dir, `${orderId}.json`);
      const raw = JSON.stringify({
        orderId,
        correlationId: 'cid',
        route: 'eth_to_xlm',
        state: 'chain_mined',
        txHash: '0xabc',
        minedBlock: null,        // null is treated as absent → valid, so test non-finite via string injection
        createdAt: Date.now(),
        updatedAt: Date.now(),
        transitions: [],
        recoveryAttempts: 0,
        savedAt: Date.now(),
      }).replace('"minedBlock":null', '"minedBlock":"not-a-number"');
      fs.writeFileSync(fpath, raw, 'utf-8');

      const store = new TxStateStore({ storageDir: dir });
      // "not-a-number" is not a valid block number — record must be rejected.
      expect(store.get(orderId)).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts a record with a valid nonnegative integer minedBlock', () => {
    const dir = path.join(os.tmpdir(), `waffle-tx-store-blockval-${Date.now()}`);
    try {
      fs.mkdirSync(dir, { recursive: true });
      writeRawRecord(dir, {
        orderId: 'valid-block',
        correlationId: 'cid',
        route: 'eth_to_xlm',
        state: 'chain_mined',
        txHash: '0xabc',
        minedBlock: 42,          // valid: nonnegative integer
        createdAt: Date.now(),
        updatedAt: Date.now(),
        transitions: [],
        recoveryAttempts: 0,
      });

      const store = new TxStateStore({ storageDir: dir });
      const record = store.get('valid-block');
      expect(record).toBeDefined();
      expect(record!.minedBlock).toBe(42);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts a record with minedBlock = 0 (genesis edge case)', () => {
    const dir = path.join(os.tmpdir(), `waffle-tx-store-blockval-${Date.now()}`);
    try {
      fs.mkdirSync(dir, { recursive: true });
      writeRawRecord(dir, {
        orderId: 'zero-block',
        correlationId: 'cid',
        route: 'eth_to_xlm',
        state: 'chain_mined',
        txHash: '0xabc',
        minedBlock: 0,           // valid: zero is a nonnegative integer
        createdAt: Date.now(),
        updatedAt: Date.now(),
        transitions: [],
        recoveryAttempts: 0,
      });

      const store = new TxStateStore({ storageDir: dir });
      const record = store.get('zero-block');
      expect(record).toBeDefined();
      expect(record!.minedBlock).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts a record with no minedBlock (pre-mined state)', () => {
    const dir = path.join(os.tmpdir(), `waffle-tx-store-blockval-${Date.now()}`);
    try {
      fs.mkdirSync(dir, { recursive: true });
      writeRawRecord(dir, {
        orderId: 'no-block',
        correlationId: 'cid',
        route: 'eth_to_xlm',
        state: 'submission_acked',
        txHash: '0xabc',
        // minedBlock absent — normal for submission_acked
        createdAt: Date.now(),
        updatedAt: Date.now(),
        transitions: [],
        recoveryAttempts: 0,
      });

      const store = new TxStateStore({ storageDir: dir });
      const record = store.get('no-block');
      expect(record).toBeDefined();
      expect(record!.minedBlock).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects corrupt record but loads adjacent valid records', () => {
    const dir = path.join(os.tmpdir(), `waffle-tx-store-blockval-${Date.now()}`);
    try {
      fs.mkdirSync(dir, { recursive: true });

      // Invalid record
      writeRawRecord(dir, {
        orderId: 'bad-block',
        correlationId: 'cid',
        route: 'eth_to_xlm',
        state: 'chain_mined',
        txHash: '0xbad',
        minedBlock: -999,        // invalid
        createdAt: Date.now(),
        updatedAt: Date.now(),
        transitions: [],
        recoveryAttempts: 0,
      });

      // Valid adjacent record
      writeRawRecord(dir, {
        orderId: 'good-block',
        correlationId: 'cid2',
        route: 'eth_to_xlm',
        state: 'chain_mined',
        txHash: '0xgood',
        minedBlock: 777,         // valid
        createdAt: Date.now(),
        updatedAt: Date.now(),
        transitions: [],
        recoveryAttempts: 0,
      });

      const store = new TxStateStore({ storageDir: dir });
      expect(store.get('bad-block')).toBeUndefined();
      expect(store.get('good-block')).toBeDefined();
      expect(store.size()).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
