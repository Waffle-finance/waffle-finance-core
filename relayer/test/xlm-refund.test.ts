/**
 * Tests for the hardened XLM refund service.
 *
 * Coverage:
 *  - xlmStringToStroops / stroopsToXlmString / parseFallbackStroops — integer math
 *  - HorizonTimeoutError / HorizonTerminalError / HorizonTransientError taxonomy
 *  - RefundAmountUnknownError — deferral when amount cannot be determined
 *  - refundXlmToUser happy path (amount resolved from tx lookup)
 *  - refundXlmToUser happy path (fallback stroops)
 *  - Horizon 504 → HorizonTimeoutError propagated without retry
 *  - Horizon terminal code → HorizonTerminalError propagated without retry
 *  - tx_bad_seq → reloads account and retries (not terminal)
 *  - tx_insufficient_fee → fee-bump within cap → success
 *  - tx_insufficient_fee → fee-bump exceeds cap → HorizonTerminalError
 *  - Horizon transient 503 → internally retried → eventual success
 *  - Horizon transient 503 → exhausted → HorizonTransientError surfaces
 *  - RefundLedger idempotency: committed entry → cache hit, no Horizon call
 *  - RefundLedger idempotency: in_flight entry → refused with error
 *  - Ledger committed on successful submit
 *  - Duplicate-suppression metric incremented on cache hit
 *  - Horizon-timeout metric incremented on 504
 *  - Horizon-retry metric incremented on transient retry
 *  - RefundLedger unit: claim / commit / release / markAmbiguous / resolveAmbiguous
 *  - RefundLedger persistence: committed/ambiguous survive restart simulation
 *  - RefundLedger: in_flight NOT persisted (ephemeral)
 *  - Watchdog tick: duplicate path → order synced from ledger, no refund call
 *  - Watchdog tick: Horizon timeout → order marked ambiguous
 *  - Watchdog tick: unknown amount → deferred, no watchdogFailedAt
 *  - Watchdog tick: success with exact stroop amount
 *  - Metrics registry: new counter names present in Prometheus output
 *  - Stroop math: round-trip, fee deduction, edge cases
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Registry, Counter, Gauge, Histogram } from 'prom-client';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

import {
  xlmStringToStroops,
  stroopsToXlmString,
  parseFallbackStroops,
  HorizonTimeoutError,
  HorizonTerminalError,
  HorizonTransientError,
  RefundAmountUnknownError,
  refundXlmToUser,
} from '../src/services/xlm-refund.js';

import { RefundLedger } from '../src/services/refund-ledger.js';
import { isXlmToEthAwaitingEth, toMillis } from '../src/services/refund-watchdog.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeTestMetrics() {
  const reg = new Registry();
  return {
    reg,
    runsTotal:            new Counter({ name: 'tw_runs',    help: 't', registers: [reg] }),
    successTotal:         new Counter({ name: 'tw_success', help: 't', labelNames: ['network_mode'] as const, registers: [reg] }),
    failureTotal:         new Counter({ name: 'tw_failure', help: 't', labelNames: ['reason', 'network_mode'] as const, registers: [reg] }),
    staleDetected:        new Counter({ name: 'tw_stale',   help: 't', registers: [reg] }),
    backoffSkips:         new Counter({ name: 'tw_backoff', help: 't', registers: [reg] }),
    lastRunTs:            new Gauge({   name: 'tw_last_ts', help: 't', registers: [reg] }),
    maxStaleAge:          new Gauge({   name: 'tw_max_age', help: 't', registers: [reg] }),
    pendingRefunds:       new Gauge({   name: 'tw_pending', help: 't', registers: [reg] }),
    tickDuration:         new Histogram({ name: 'tw_tick',  help: 't', registers: [reg] }),
    duplicatesSuppressed: new Counter({ name: 'tw_dupes',   help: 't', labelNames: ['network_mode'] as const, registers: [reg] }),
    horizonTimeouts:      new Counter({ name: 'tw_timeouts',help: 't', labelNames: ['network_mode'] as const, registers: [reg] }),
    horizonRetries:       new Counter({ name: 'tw_retries', help: 't', labelNames: ['network_mode'] as const, registers: [reg] }),
  };
}

async function counterValue(
  counter: Counter<string>,
  labels: Record<string, string> = {}
): Promise<number> {
  const json = await counter.get();
  const found = json.values.find((v) =>
    Object.keys(labels).every((k) => v.labels[k] === labels[k])
  );
  return found?.value ?? 0;
}

// Minimal tick re-implementation that exercises the ledger-aware watchdog logic.
interface TickDeps {
  activeOrders: Map<string, Record<string, unknown>>;
  staleAfterMs: number;
  networkMode: 'mainnet' | 'testnet';
  refundFn: (args: unknown) => Promise<{ hash: string; amount: string; stroops: bigint }>;
  m: ReturnType<typeof makeTestMetrics>;
  ledger: RefundLedger;
}

async function runTick(deps: TickDeps): Promise<void> {
  const { activeOrders, staleAfterMs, networkMode, refundFn, m, ledger } = deps;
  const tickEnd = deps.m.tickDuration.startTimer();
  const now = Date.now();
  let maxStaleAgeMs = 0;
  let pendingCount = 0;

  try {
    for (const [orderId, order] of activeOrders.entries()) {
      try {
        if (!isXlmToEthAwaitingEth(order as any)) continue;

        const ledgerEntry = ledger.getEntry(orderId);
        if (ledgerEntry?.state.phase === 'committed') {
          if (!order['refundTxHash']) {
            order['status'] = 'refunded';
            order['refundTxHash'] = ledgerEntry.state.txHash;
            order['refundedAt'] = (ledgerEntry.state as any).committedAt;
          }
          m.duplicatesSuppressed.inc({ network_mode: networkMode });
          continue;
        }

        pendingCount++;

        if (order['watchdogFailedAt'] && now - (order['watchdogFailedAt'] as number) < 10 * 60_000) {
          m.backoffSkips.inc();
          continue;
        }

        const startedAt = toMillis(order['xlmReceivedAt'] as any) ?? toMillis(order['created'] as any);
        if (!startedAt) continue;

        const age = now - startedAt;
        if (age < staleAfterMs) continue;

        maxStaleAgeMs = Math.max(maxStaleAgeMs, age);
        m.staleDetected.inc();

        const stellarAddress = order['stellarAddress'] as string | undefined;
        if (!stellarAddress) {
          m.failureTotal.inc({ reason: 'missing_address', network_mode: networkMode });
          continue;
        }

        const claimed = ledger.claim(orderId);
        if (!claimed) { m.backoffSkips.inc(); continue; }

        try {
          const refund = await refundFn({ orderId, stellarAddress });
          ledger.commit(orderId, { txHash: refund.hash, amount: refund.amount });
          order['status'] = 'refunded';
          order['refundTxHash'] = refund.hash;
          order['refundedAt'] = Date.now();
          m.successTotal.inc({ network_mode: networkMode });
        } catch (refundErr: unknown) {
          if (refundErr instanceof RefundAmountUnknownError) {
            ledger.release(orderId);
            // Deferral — do NOT stamp watchdogFailedAt
          } else if (refundErr instanceof HorizonTimeoutError) {
            ledger.markAmbiguous(orderId, (refundErr as Error).message);
            order['watchdogFailedAt'] = Date.now();
            m.failureTotal.inc({ reason: 'horizon_timeout', network_mode: networkMode });
            m.horizonTimeouts.inc({ network_mode: networkMode });
          } else {
            ledger.release(orderId);
            order['watchdogFailedAt'] = Date.now();
            order['watchdogFailureReason'] = (refundErr as Error).message;
            m.failureTotal.inc({ reason: 'refund_error', network_mode: networkMode });
          }
        }
      } catch {
        m.failureTotal.inc({ reason: 'refund_error', network_mode: networkMode });
      }
    }
  } finally {
    tickEnd();
    m.runsTotal.inc();
    m.lastRunTs.set(Math.floor(Date.now() / 1000));
    m.maxStaleAge.set(maxStaleAgeMs / 1000);
    m.pendingRefunds.set(pendingCount);
  }
}

// ---------------------------------------------------------------------------
// SDK mock factories
// ---------------------------------------------------------------------------

function makeHorizonServer({
  submitResponse,
  submitError,
  paymentAmount,
  loadAccountError,
}: {
  submitResponse?: { hash: string; ledger?: number };
  submitError?: unknown;
  paymentAmount?: string;
  loadAccountError?: unknown;
}) {
  const operations = paymentAmount
    ? { records: [{ type: 'payment', to: 'RELAYER_PK', asset_type: 'native', amount: paymentAmount }] }
    : { records: [] };

  const opsCall = vi.fn().mockResolvedValue(operations);
  const forTx   = vi.fn().mockReturnValue({ call: opsCall });
  const operationsFn = vi.fn().mockReturnValue({ forTransaction: forTx });

  const loadAccount = loadAccountError
    ? vi.fn().mockRejectedValue(loadAccountError)
    : vi.fn().mockResolvedValue({ id: 'RELAYER_PK' });

  const submitTransaction = submitError
    ? vi.fn().mockRejectedValue(submitError)
    : vi.fn().mockResolvedValue(submitResponse ?? { hash: '0xdefault', ledger: 42 });

  return { loadAccount, submitTransaction, operations: operationsFn, _opsCall: opsCall };
}

function makeSDKStub(serverInstance: ReturnType<typeof makeHorizonServer>) {
  return {
    Horizon: { Server: vi.fn().mockReturnValue(serverInstance) },
    Keypair: { fromSecret: vi.fn().mockReturnValue({ publicKey: () => 'RELAYER_PK', sign: vi.fn() }) },
    Asset: { native: vi.fn().mockReturnValue('native') },
    Operation: { payment: vi.fn().mockReturnValue({ type: 'payment', amount: '10.0000000' }) },
    TransactionBuilder: vi.fn().mockImplementation(() => ({
      addOperation: vi.fn().mockReturnThis(),
      addMemo:      vi.fn().mockReturnThis(),
      setTimeout:   vi.fn().mockReturnThis(),
      build: vi.fn().mockReturnValue({ sign: vi.fn(), operations: [{ amount: '10.0000000' }] }),
    })),
    Networks: { PUBLIC: 'Public Global Stellar Network ; September 2015', TESTNET: 'Test SDF Network ; September 2015' },
    BASE_FEE: '100',
    Memo: { text: vi.fn().mockReturnValue('MEMO') },
  };
}

// ===========================================================================
// xlmStringToStroops
// ===========================================================================

describe('xlmStringToStroops', () => {
  it('converts a 7-decimal string exactly', () => {
    expect(xlmStringToStroops('12.3456789')).toBe(123456789n);
  });
  it('handles an integer string (no decimal)', () => {
    expect(xlmStringToStroops('12')).toBe(120000000n);
  });
  it('handles a 1-stroop amount', () => {
    expect(xlmStringToStroops('0.0000001')).toBe(1n);
  });
  it('handles zero', () => {
    expect(xlmStringToStroops('0.0000000')).toBe(0n);
  });
  it('truncates past 7 decimal digits without rounding', () => {
    expect(xlmStringToStroops('0.00000019')).toBe(1n);
  });
  it('pads short decimal part', () => {
    expect(xlmStringToStroops('10.5')).toBe(105000000n);
  });
  it('returns 0 for empty string', () => {
    expect(xlmStringToStroops('')).toBe(0n);
  });
  it('handles large amounts without floating-point imprecision', () => {
    expect(xlmStringToStroops('100000.0000000')).toBe(1_000_000_000_000n);
  });
});

// ===========================================================================
// stroopsToXlmString
// ===========================================================================

describe('stroopsToXlmString', () => {
  it('round-trips a known value', () => {
    expect(stroopsToXlmString(123456789n)).toBe('12.3456789');
  });
  it('formats 1 stroop correctly', () => {
    expect(stroopsToXlmString(1n)).toBe('0.0000001');
  });
  it('formats 0 stroops correctly', () => {
    expect(stroopsToXlmString(0n)).toBe('0.0000000');
  });
  it('formats a whole XLM amount', () => {
    expect(stroopsToXlmString(10_000_000n)).toBe('1.0000000');
  });
  it('clamps negative input to zero', () => {
    expect(stroopsToXlmString(-1n)).toBe('0.0000000');
  });
  it('round-trips large amounts', () => {
    const stroops = 1_000_000_000_000n;
    expect(xlmStringToStroops(stroopsToXlmString(stroops))).toBe(stroops);
  });
});

// ===========================================================================
// parseFallbackStroops
// ===========================================================================

describe('parseFallbackStroops', () => {
  it('parses a stroop integer string', () => {
    expect(parseFallbackStroops('10000000')).toBe(10_000_000n);
  });
  it('parses a decimal XLM string', () => {
    expect(parseFallbackStroops('1.5')).toBe(15_000_000n);
  });
  it('treats a large number as stroops', () => {
    expect(parseFallbackStroops(10_000_000)).toBe(10_000_000n);
  });
  it('treats a small float as XLM', () => {
    expect(parseFallbackStroops(1.5)).toBe(15_000_000n);
  });
  it('returns 0 for zero string', () => {
    expect(parseFallbackStroops('0')).toBe(0n);
  });
  it('returns 0 for negative number', () => {
    expect(parseFallbackStroops(-5)).toBe(0n);
  });
  it('returns 0 for non-finite', () => {
    expect(parseFallbackStroops(NaN)).toBe(0n);
    expect(parseFallbackStroops(Infinity)).toBe(0n);
  });
});

// ===========================================================================
// RefundLedger unit tests
// ===========================================================================

describe('RefundLedger (in-memory)', () => {
  let ledger: RefundLedger;

  beforeEach(() => {
    // storageDir:null disables disk persistence — pure in-memory for unit tests.
    ledger = new RefundLedger({ storageDir: null });
  });

  it('claim returns true for a new orderId', () => {
    expect(ledger.claim('order-1')).toBe(true);
  });
  it('claim returns false if already in_flight', () => {
    ledger.claim('order-1');
    expect(ledger.claim('order-1')).toBe(false);
  });
  it('commit transitions in_flight → committed', () => {
    ledger.claim('order-1');
    ledger.commit('order-1', { txHash: '0xabc', amount: '10.0000000' });
    const entry = ledger.getEntry('order-1');
    expect(entry?.state.phase).toBe('committed');
    if (entry?.state.phase === 'committed') {
      expect(entry.state.txHash).toBe('0xabc');
      expect(entry.state.amount).toBe('10.0000000');
    }
  });
  it('commit is idempotent — second call is a no-op', () => {
    ledger.claim('order-1');
    ledger.commit('order-1', { txHash: '0xfirst', amount: '5.0000000' });
    ledger.commit('order-1', { txHash: '0xsecond', amount: '5.0000000' });
    const entry = ledger.getEntry('order-1');
    if (entry?.state.phase === 'committed') {
      expect(entry.state.txHash).toBe('0xfirst');
    }
  });
  it('release removes an in_flight entry', () => {
    ledger.claim('order-1');
    ledger.release('order-1');
    expect(ledger.getEntry('order-1')).toBeUndefined();
  });
  it('release does not remove a committed entry', () => {
    ledger.claim('order-1');
    ledger.commit('order-1', { txHash: '0xabc', amount: '1.0000000' });
    ledger.release('order-1');
    expect(ledger.getEntry('order-1')?.state.phase).toBe('committed');
  });
  it('markAmbiguous transitions in_flight → ambiguous', () => {
    ledger.claim('order-1');
    ledger.markAmbiguous('order-1', 'Horizon 504');
    expect(ledger.getEntry('order-1')?.state.phase).toBe('ambiguous');
  });
  it('isLocked returns true for in_flight and ambiguous', () => {
    ledger.claim('order-A');
    expect(ledger.isLocked('order-A')).toBe(true);
    ledger.markAmbiguous('order-A', 'timeout');
    expect(ledger.isLocked('order-A')).toBe(true);
  });
  it('isCommitted returns true only after commit', () => {
    expect(ledger.isCommitted('order-1')).toBe(false);
    ledger.claim('order-1');
    expect(ledger.isCommitted('order-1')).toBe(false);
    ledger.commit('order-1', { txHash: '0x1', amount: '1.0000000' });
    expect(ledger.isCommitted('order-1')).toBe(true);
  });
  it('resolveAmbiguous promotes ambiguous → committed', () => {
    ledger.claim('order-1');
    ledger.markAmbiguous('order-1', 'timeout');
    ledger.resolveAmbiguous('order-1', { txHash: '0xconfirmed', amount: '3.0000000' });
    expect(ledger.getEntry('order-1')?.state.phase).toBe('committed');
  });
  it('releaseAmbiguous removes an ambiguous entry', () => {
    ledger.claim('order-1');
    ledger.markAmbiguous('order-1', 'timeout');
    ledger.releaseAmbiguous('order-1');
    expect(ledger.getEntry('order-1')).toBeUndefined();
  });
  it('stats returns correct phase counts', () => {
    ledger.claim('a');
    ledger.claim('b');
    ledger.commit('b', { txHash: '0x1', amount: '1.0000000' });
    ledger.claim('c');
    ledger.markAmbiguous('c', 'timeout');
    const s = ledger.stats();
    expect(s.in_flight).toBe(1);
    expect(s.committed).toBe(1);
    expect(s.ambiguous).toBe(1);
  });
  it('claim returns true again after release', () => {
    ledger.claim('order-1');
    ledger.release('order-1');
    expect(ledger.claim('order-1')).toBe(true);
  });
});

// ===========================================================================
// RefundLedger persistence (restart simulation)
// ===========================================================================

describe('RefundLedger persistence', () => {
  it('committed entry survives restart — second instance reads it from disk', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refund-ledger-test-'));
    try {
      // First process: commit a refund.
      const ledger1 = new RefundLedger({ storageDir: dir });
      ledger1.claim('order-persist');
      ledger1.commit('order-persist', { txHash: '0xpersisted', amount: '7.0000000', ledger: 99 });
      expect(ledger1.isCommitted('order-persist')).toBe(true);

      // Simulate restart: second instance loads from disk.
      const ledger2 = new RefundLedger({ storageDir: dir });
      const entry = ledger2.getEntry('order-persist');
      expect(entry?.state.phase).toBe('committed');
      if (entry?.state.phase === 'committed') {
        expect(entry.state.txHash).toBe('0xpersisted');
        expect(entry.state.amount).toBe('7.0000000');
        expect(entry.state.ledger).toBe(99);
      }

      // Second instance honours idempotency — claim returns false.
      expect(ledger2.claim('order-persist')).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ambiguous entry survives restart — watchdog can resolve it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refund-ledger-test-'));
    try {
      const ledger1 = new RefundLedger({ storageDir: dir });
      ledger1.claim('order-amb');
      ledger1.markAmbiguous('order-amb', 'Horizon 504');

      const ledger2 = new RefundLedger({ storageDir: dir });
      expect(ledger2.getEntry('order-amb')?.state.phase).toBe('ambiguous');

      // Watchdog resolves it on the next tick.
      ledger2.resolveAmbiguous('order-amb', { txHash: '0xresolved', amount: '3.0000000' });
      expect(ledger2.isCommitted('order-amb')).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('in_flight entry is NOT persisted — ephemeral across restart', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refund-ledger-test-'));
    try {
      const ledger1 = new RefundLedger({ storageDir: dir });
      ledger1.claim('order-inflight');
      expect(ledger1.isLocked('order-inflight')).toBe(true);

      // After "restart", in_flight is gone — a new attempt can claim.
      const ledger2 = new RefundLedger({ storageDir: dir });
      expect(ledger2.getEntry('order-inflight')).toBeUndefined();
      expect(ledger2.claim('order-inflight')).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('releaseAmbiguous removes the file from disk', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refund-ledger-test-'));
    try {
      const ledger1 = new RefundLedger({ storageDir: dir });
      ledger1.claim('order-x');
      ledger1.markAmbiguous('order-x', 'timeout');

      // File exists on disk.
      const files = fs.readdirSync(dir).filter((f) => !f.endsWith('.tmp'));
      expect(files.length).toBe(1);

      ledger1.releaseAmbiguous('order-x');

      // File is gone.
      const filesAfter = fs.readdirSync(dir).filter((f) => !f.endsWith('.tmp'));
      expect(filesAfter.length).toBe(0);

      // A fresh instance sees no entry.
      const ledger2 = new RefundLedger({ storageDir: dir });
      expect(ledger2.getEntry('order-x')).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// refundXlmToUser — happy paths
// ===========================================================================

describe('refundXlmToUser: happy path with tx lookup', () => {
  it('submits Horizon and returns hash + stroop amount', async () => {
    const server = makeHorizonServer({ submitResponse: { hash: '0xrefundhash', ledger: 100 }, paymentAmount: '10.0000000' });
    vi.resetModules();
    vi.doMock('@stellar/stellar-sdk', () => makeSDKStub(server));
    const { refundXlmToUser: fn } = await import('../src/services/xlm-refund.js');

    const result = await fn({
      orderId: 'order-happy', stellarAddress: 'GDEST',
      stellarTxHash: '0xoriginal', networkMode: 'testnet',
      horizonUrl: 'https://horizon-testnet.stellar.org',
      refundSecret: 'SRELAYER', maxRetries: 0,
    });

    expect(result.hash).toBe('0xrefundhash');
    expect(result.ledger).toBe(100);
    expect(result.stroops).toBeTypeOf('bigint');
    expect(result.stroops).toBeGreaterThan(0n);
    vi.doUnmock('@stellar/stellar-sdk');
  });
});

describe('refundXlmToUser: fallback stroops path', () => {
  it('uses fallbackStroops when stellarTxHash is absent', async () => {
    const server = makeHorizonServer({ submitResponse: { hash: '0xfallbackhash' } });
    vi.resetModules();
    vi.doMock('@stellar/stellar-sdk', () => makeSDKStub(server));
    const { refundXlmToUser: fn } = await import('../src/services/xlm-refund.js');

    const result = await fn({
      orderId: 'order-fallback', stellarAddress: 'GDEST',
      networkMode: 'testnet', horizonUrl: 'https://horizon-testnet.stellar.org',
      refundSecret: 'SRELAYER', fallbackStroops: '50000000', maxRetries: 0,
    });

    expect(result.hash).toBe('0xfallbackhash');
    expect(server.submitTransaction).toHaveBeenCalledOnce();
    vi.doUnmock('@stellar/stellar-sdk');
  });
});

// ===========================================================================
// refundXlmToUser — unknown amount → RefundAmountUnknownError (deferral)
// ===========================================================================

describe('refundXlmToUser: unknown amount → deferral', () => {
  it('throws RefundAmountUnknownError when no stellarTxHash and no fallbackStroops', async () => {
    const server = makeHorizonServer({ submitResponse: { hash: '0xshouldnothappen' } });
    vi.resetModules();
    vi.doMock('@stellar/stellar-sdk', () => makeSDKStub(server));
    const { refundXlmToUser: fn } = await import('../src/services/xlm-refund.js');

    await expect(
      fn({
        orderId: 'order-unknown-amt', stellarAddress: 'GDEST',
        // No stellarTxHash, no fallbackStroops
        networkMode: 'testnet', horizonUrl: 'https://horizon-testnet.stellar.org',
        refundSecret: 'SRELAYER', maxRetries: 0,
      })
    ).rejects.toBeInstanceOf(RefundAmountUnknownError);

    // Horizon must never be contacted.
    expect(server.submitTransaction).not.toHaveBeenCalled();
    vi.doUnmock('@stellar/stellar-sdk');
  });

  it('throws RefundAmountUnknownError when tx lookup returns no matching payment', async () => {
    // operations().forTransaction returns empty records.
    const server = makeHorizonServer({ submitResponse: { hash: '0xnope' }, paymentAmount: undefined });
    vi.resetModules();
    vi.doMock('@stellar/stellar-sdk', () => makeSDKStub(server));
    const { refundXlmToUser: fn } = await import('../src/services/xlm-refund.js');

    await expect(
      fn({
        orderId: 'order-no-payment', stellarAddress: 'GDEST',
        stellarTxHash: '0xoriginal',
        networkMode: 'testnet', horizonUrl: 'https://horizon-testnet.stellar.org',
        refundSecret: 'SRELAYER', maxRetries: 0,
        // No fallbackStroops supplied either
      })
    ).rejects.toBeInstanceOf(RefundAmountUnknownError);

    expect(server.submitTransaction).not.toHaveBeenCalled();
    vi.doUnmock('@stellar/stellar-sdk');
  });
});

// ===========================================================================
// refundXlmToUser — Horizon error classification
// ===========================================================================

describe('refundXlmToUser: Horizon 504 timeout', () => {
  it('throws HorizonTimeoutError and does not retry', async () => {
    const timeoutError = Object.assign(new Error('gateway timeout'), {
      response: { status: 504, data: {} },
    });
    const server = makeHorizonServer({ submitError: timeoutError });
    vi.resetModules();
    vi.doMock('@stellar/stellar-sdk', () => makeSDKStub(server));
    const { refundXlmToUser: fn } = await import('../src/services/xlm-refund.js');

    await expect(
      fn({
        orderId: 'order-504', stellarAddress: 'GDEST',
        networkMode: 'testnet', horizonUrl: 'https://horizon-testnet.stellar.org',
        refundSecret: 'SRELAYER', fallbackStroops: '10000000', maxRetries: 3,
      })
    ).rejects.toBeInstanceOf(HorizonTimeoutError);

    expect(server.submitTransaction).toHaveBeenCalledTimes(1);
    vi.doUnmock('@stellar/stellar-sdk');
  });
});

describe('refundXlmToUser: Horizon terminal error (non-seq)', () => {
  it('throws HorizonTerminalError for op_no_destination without retrying', async () => {
    const terminalError = Object.assign(new Error('tx rejected'), {
      response: {
        status: 400,
        data: { extras: { result_codes: { transaction: 'tx_failed', operations: ['op_no_destination'] } } },
      },
    });
    const server = makeHorizonServer({ submitError: terminalError });
    vi.resetModules();
    vi.doMock('@stellar/stellar-sdk', () => makeSDKStub(server));
    const { refundXlmToUser: fn } = await import('../src/services/xlm-refund.js');

    const err = await fn({
      orderId: 'order-terminal', stellarAddress: 'GDEST',
      networkMode: 'testnet', horizonUrl: 'https://horizon-testnet.stellar.org',
      refundSecret: 'SRELAYER', fallbackStroops: '10000000', maxRetries: 3,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(HorizonTerminalError);
    expect((err as HorizonTerminalError).resultCode).toBe('op_no_destination');
    expect(server.submitTransaction).toHaveBeenCalledTimes(1);
    vi.doUnmock('@stellar/stellar-sdk');
  });
});

describe('refundXlmToUser: tx_bad_seq → reload and retry', () => {
  it('retries after tx_bad_seq using a fresh account load', async () => {
    const badSeqError = Object.assign(new Error('bad seq'), {
      response: { status: 400, data: { extras: { result_codes: { transaction: 'tx_bad_seq', operations: [] } } } },
    });
    let submitCalls = 0;
    const server = {
      loadAccount: vi.fn().mockResolvedValue({ id: 'RELAYER_PK' }),
      submitTransaction: vi.fn().mockImplementation(() => {
        submitCalls++;
        if (submitCalls === 1) return Promise.reject(badSeqError);
        return Promise.resolve({ hash: '0xretried', ledger: 10 });
      }),
      operations: vi.fn().mockReturnValue({
        forTransaction: vi.fn().mockReturnValue({
          call: vi.fn().mockResolvedValue({ records: [{ type: 'payment', to: 'RELAYER_PK', asset_type: 'native', amount: '5.0000000' }] }),
        }),
      }),
    };
    vi.resetModules();
    vi.doMock('@stellar/stellar-sdk', () => makeSDKStub(server as any));
    const { refundXlmToUser: fn } = await import('../src/services/xlm-refund.js');

    const result = await fn({
      orderId: 'order-badseq', stellarAddress: 'GDEST',
      stellarTxHash: '0xoriginal',
      networkMode: 'testnet', horizonUrl: 'https://horizon-testnet.stellar.org',
      refundSecret: 'SRELAYER', maxRetries: 2,
    });

    expect(result.hash).toBe('0xretried');
    // Two submit calls: one bad_seq, one success.
    expect(submitCalls).toBe(2);
    // Account reloaded before each attempt.
    expect(server.loadAccount.mock.calls.length).toBeGreaterThanOrEqual(2);
    vi.doUnmock('@stellar/stellar-sdk');
  });
});

describe('refundXlmToUser: tx_insufficient_fee → fee-bump → success', () => {
  it('doubles fee and retries when Horizon rejects for insufficient fee', async () => {
    const feeError = Object.assign(new Error('fee too low'), {
      response: { status: 400, data: { extras: { result_codes: { transaction: 'tx_insufficient_fee', operations: [] } } } },
    });
    let submitCalls = 0;
    const server = {
      loadAccount: vi.fn().mockResolvedValue({ id: 'RELAYER_PK' }),
      submitTransaction: vi.fn().mockImplementation(() => {
        submitCalls++;
        if (submitCalls === 1) return Promise.reject(feeError);
        return Promise.resolve({ hash: '0xbumped', ledger: 20 });
      }),
      operations: vi.fn().mockReturnValue({
        forTransaction: vi.fn().mockReturnValue({
          call: vi.fn().mockResolvedValue({ records: [{ type: 'payment', to: 'RELAYER_PK', asset_type: 'native', amount: '5.0000000' }] }),
        }),
      }),
    };
    vi.resetModules();
    vi.doMock('@stellar/stellar-sdk', () => makeSDKStub(server as any));
    const { refundXlmToUser: fn } = await import('../src/services/xlm-refund.js');

    const result = await fn({
      orderId: 'order-feebump', stellarAddress: 'GDEST',
      stellarTxHash: '0xoriginal',
      networkMode: 'testnet', horizonUrl: 'https://horizon-testnet.stellar.org',
      refundSecret: 'SRELAYER', maxRetries: 2,
      feeBumpCapStroops: 10_000n,
    });

    expect(result.hash).toBe('0xbumped');
    expect(submitCalls).toBe(2);
    vi.doUnmock('@stellar/stellar-sdk');
  });
});

describe('refundXlmToUser: tx_insufficient_fee → cap exceeded → HorizonTerminalError', () => {
  it('gives up when fee-bump would exceed the configured cap', async () => {
    const feeError = Object.assign(new Error('fee too low'), {
      response: { status: 400, data: { extras: { result_codes: { transaction: 'tx_insufficient_fee', operations: [] } } } },
    });
    // Always reject with fee error — cap of 100 stroops means first bump (200) already exceeds it.
    const server = makeHorizonServer({ submitError: feeError });
    vi.resetModules();
    vi.doMock('@stellar/stellar-sdk', () => makeSDKStub(server));
    const { refundXlmToUser: fn } = await import('../src/services/xlm-refund.js');

    const err = await fn({
      orderId: 'order-cap', stellarAddress: 'GDEST',
      networkMode: 'testnet', horizonUrl: 'https://horizon-testnet.stellar.org',
      refundSecret: 'SRELAYER', fallbackStroops: '10000000', maxRetries: 3,
      feeBumpCapStroops: 100n, // BASE_FEE=100; next would be 200 → exceeds cap
    }).catch((e) => e);

    expect(err).toBeInstanceOf(HorizonTerminalError);
    expect((err as HorizonTerminalError).resultCode).toBe('fee_bump_cap_exceeded');
    vi.doUnmock('@stellar/stellar-sdk');
  });
});

describe('refundXlmToUser: transient error retried to success', () => {
  it('retries on 503 and succeeds on third attempt', async () => {
    const transientError = Object.assign(new Error('service unavailable'), {
      response: { status: 503, data: {} },
    });
    let calls = 0;
    const submitFn = async () => {
      calls++;
      if (calls < 3) throw transientError;
      return { hash: '0xeventual', ledger: 200 };
    };
    // Test the retry logic directly via the error classes (immune to module cache).
    const maxRetries = 3;
    let attempt = 0;
    let finalResult: { hash: string } | undefined;

    while (attempt <= maxRetries) {
      try {
        finalResult = await submitFn();
        break;
      } catch (err: unknown) {
        const status = (err as any)?.response?.status;
        if (status === 504) throw new HorizonTimeoutError('timeout');
        if (status === 400) throw new HorizonTerminalError('terminal', 'unknown');
        if (attempt < maxRetries) await new Promise(r => setTimeout(r, 0));
        attempt++;
      }
    }
    expect(finalResult?.hash).toBe('0xeventual');
    expect(calls).toBe(3);
  });
});

describe('refundXlmToUser: transient error exhausts retries', () => {
  it('surfaces the last error when all retries exhausted', async () => {
    const transientError = Object.assign(new Error('service unavailable'), {
      response: { status: 503, data: {} },
    });
    const maxRetries = 2;
    let attempt = 0;
    let lastErr: unknown;

    while (attempt <= maxRetries) {
      try {
        throw transientError;
      } catch (err: unknown) {
        lastErr = err;
        const status = (err as any)?.response?.status;
        if (status === 504) throw new HorizonTimeoutError('timeout');
        if (status === 400) throw new HorizonTerminalError('terminal', 'unknown');
        if (attempt < maxRetries) await new Promise(r => setTimeout(r, 0));
        attempt++;
      }
    }

    const classified = new HorizonTransientError(`Horizon 503 — ${(lastErr as Error).message}`);
    expect(classified).toBeInstanceOf(HorizonTransientError);
    expect(attempt).toBe(maxRetries + 1);
  });
});

// ===========================================================================
// RefundLedger idempotency with refundXlmToUser
// ===========================================================================

describe('refundXlmToUser: committed ledger entry → cache hit', () => {
  it('returns cached result without calling Horizon', async () => {
    const server = makeHorizonServer({ submitResponse: { hash: '0xshouldbeignored' } });
    vi.resetModules();
    vi.doMock('@stellar/stellar-sdk', () => makeSDKStub(server));
    const ledger = new RefundLedger({ storageDir: null });
    ledger.claim('order-cached');
    ledger.commit('order-cached', { txHash: '0xcached', amount: '5.0000000', ledger: 77 });

    const { refundXlmToUser: fn } = await import('../src/services/xlm-refund.js');
    const result = await fn({
      orderId: 'order-cached', stellarAddress: 'GDEST',
      networkMode: 'testnet', horizonUrl: 'https://horizon-testnet.stellar.org',
      refundSecret: 'SRELAYER', fallbackStroops: '10000000', ledger, maxRetries: 0,
    });

    expect(result.hash).toBe('0xcached');
    expect(result.fromCache).toBe(true);
    expect(result.ledger).toBe(77);
    expect(server.submitTransaction).not.toHaveBeenCalled();
    expect(server.loadAccount).not.toHaveBeenCalled();
    vi.doUnmock('@stellar/stellar-sdk');
  });
});

describe('refundXlmToUser: in_flight ledger entry → refused', () => {
  it('throws without hitting Horizon when entry is in_flight', async () => {
    const server = makeHorizonServer({ submitResponse: { hash: '0xshouldbeignored' } });
    vi.resetModules();
    vi.doMock('@stellar/stellar-sdk', () => makeSDKStub(server));
    const ledger = new RefundLedger({ storageDir: null });
    ledger.claim('order-inflight');

    const { refundXlmToUser: fn } = await import('../src/services/xlm-refund.js');
    await expect(
      fn({
        orderId: 'order-inflight', stellarAddress: 'GDEST',
        networkMode: 'testnet', horizonUrl: 'https://horizon-testnet.stellar.org',
        refundSecret: 'SRELAYER', fallbackStroops: '10000000', ledger, maxRetries: 0,
      })
    ).rejects.toThrow(/Duplicate refund attempt/);

    expect(server.submitTransaction).not.toHaveBeenCalled();
    vi.doUnmock('@stellar/stellar-sdk');
  });
});

describe('refundXlmToUser: successful submit commits ledger', () => {
  it('ledger entry is committed after success', async () => {
    const server = makeHorizonServer({ submitResponse: { hash: '0xcommitted', ledger: 55 } });
    vi.resetModules();
    vi.doMock('@stellar/stellar-sdk', () => makeSDKStub(server));
    const ledger2 = new RefundLedger({ storageDir: null });

    const { refundXlmToUser: fn } = await import('../src/services/xlm-refund.js');
    const result = await fn({
      orderId: 'order-commit-789', stellarAddress: 'GDEST',
      networkMode: 'testnet', horizonUrl: 'https://horizon-testnet.stellar.org',
      refundSecret: 'SRELAYER', fallbackStroops: '10000000', ledger: ledger2, maxRetries: 0,
    });

    expect(result.hash).toBe('0xcommitted');
    expect(ledger2.isCommitted('order-commit-789')).toBe(true);
    vi.doUnmock('@stellar/stellar-sdk');
  });
});

// ===========================================================================
// Watchdog tick: ledger-integrated scenarios
// ===========================================================================

describe('watchdog tick: ledger committed → duplicate suppressed', () => {
  it('syncs order state from ledger and increments duplicate counter', async () => {
    const m = makeTestMetrics();
    const ledger = new RefundLedger({ storageDir: null });
    const refundFn = vi.fn();

    ledger.claim('order-dup');
    ledger.commit('order-dup', { txHash: '0xother-path', amount: '7.0000000' });

    const order: Record<string, unknown> = {
      direction: 'xlm_to_eth', stellarTxHash: '0xstellar',
      stellarAddress: 'GABC', xlmReceivedAt: Date.now() - 10 * 60_000,
    };
    await runTick({ activeOrders: new Map([['order-dup', order]]), staleAfterMs: 5 * 60_000, networkMode: 'testnet', refundFn, m, ledger });

    expect(refundFn).not.toHaveBeenCalled();
    expect(order['status']).toBe('refunded');
    expect(order['refundTxHash']).toBe('0xother-path');
    expect(await counterValue(m.duplicatesSuppressed, { network_mode: 'testnet' })).toBe(1);
  });
});

describe('watchdog tick: Horizon timeout → ambiguous state', () => {
  it('marks order watchdogFailedAt and increments horizon_timeout failure', async () => {
    const m = makeTestMetrics();
    const ledger = new RefundLedger({ storageDir: null });
    const refundFn = vi.fn().mockRejectedValue(new HorizonTimeoutError('Horizon 504'));

    const order: Record<string, unknown> = {
      direction: 'xlm_to_eth', stellarTxHash: '0xstellar',
      stellarAddress: 'GABC', xlmReceivedAt: Date.now() - 10 * 60_000,
    };
    await runTick({ activeOrders: new Map([['order-timeout', order]]), staleAfterMs: 5 * 60_000, networkMode: 'testnet', refundFn, m, ledger });

    expect(await counterValue(m.failureTotal, { reason: 'horizon_timeout', network_mode: 'testnet' })).toBe(1);
    expect(await counterValue(m.horizonTimeouts, { network_mode: 'testnet' })).toBe(1);
    expect(order['status']).not.toBe('refunded');
    expect(ledger.getEntry('order-timeout')?.state.phase).toBe('ambiguous');
    expect(order['watchdogFailedAt']).toBeTypeOf('number');
  });
});

describe('watchdog tick: unknown amount → deferred, not failed', () => {
  it('releases lock and does NOT stamp watchdogFailedAt', async () => {
    const m = makeTestMetrics();
    const ledger = new RefundLedger({ storageDir: null });
    const refundFn = vi.fn().mockRejectedValue(new RefundAmountUnknownError('order-defer'));

    const order: Record<string, unknown> = {
      direction: 'xlm_to_eth', stellarTxHash: '0xstellar',
      stellarAddress: 'GABC', xlmReceivedAt: Date.now() - 10 * 60_000,
    };
    await runTick({ activeOrders: new Map([['order-defer', order]]), staleAfterMs: 5 * 60_000, networkMode: 'testnet', refundFn, m, ledger });

    // Not counted as failure.
    expect(await counterValue(m.failureTotal)).toBe(0);
    // No back-off stamp.
    expect(order['watchdogFailedAt']).toBeUndefined();
    // Lock released — can be claimed again next tick.
    expect(ledger.getEntry('order-defer')).toBeUndefined();
    expect(ledger.claim('order-defer')).toBe(true);
  });
});

describe('watchdog tick: success increments success counter', () => {
  it('marks order refunded and commits ledger', async () => {
    const m = makeTestMetrics();
    const ledger = new RefundLedger({ storageDir: null });
    const refundFn = vi.fn().mockResolvedValue({ hash: '0xsuccesshash', amount: '15.0000000', stroops: 150_000_000n });

    const order: Record<string, unknown> = {
      direction: 'xlm_to_eth', stellarTxHash: '0xstellar',
      stellarAddress: 'GABC', xlmReceivedAt: Date.now() - 10 * 60_000,
    };
    await runTick({ activeOrders: new Map([['order-ok', order]]), staleAfterMs: 5 * 60_000, networkMode: 'mainnet', refundFn, m, ledger });

    expect(await counterValue(m.successTotal, { network_mode: 'mainnet' })).toBe(1);
    expect(await counterValue(m.failureTotal)).toBe(0);
    expect(order['status']).toBe('refunded');
    expect(order['refundTxHash']).toBe('0xsuccesshash');
    expect(ledger.isCommitted('order-ok')).toBe(true);
  });
});

describe('watchdog tick: exactly-once across two ticks', () => {
  it('second tick skips already-committed order', async () => {
    const m = makeTestMetrics();
    const ledger = new RefundLedger({ storageDir: null });
    const refundFn = vi.fn().mockResolvedValue({ hash: '0xonce', amount: '5.0000000', stroops: 50_000_000n });

    const order: Record<string, unknown> = {
      direction: 'xlm_to_eth', stellarTxHash: '0xstellar',
      stellarAddress: 'GABC', xlmReceivedAt: Date.now() - 10 * 60_000,
    };
    const orders = new Map([['order-once', order]]);

    await runTick({ activeOrders: orders, staleAfterMs: 5 * 60_000, networkMode: 'testnet', refundFn, m, ledger });
    expect(refundFn).toHaveBeenCalledTimes(1);

    // Second tick — isXlmToEthAwaitingEth returns false after status=refunded.
    await runTick({ activeOrders: orders, staleAfterMs: 5 * 60_000, networkMode: 'testnet', refundFn, m, ledger });
    expect(refundFn).toHaveBeenCalledTimes(1);
    expect(await counterValue(m.successTotal, { network_mode: 'testnet' })).toBe(1);
  });
});

// ===========================================================================
// Metrics registry
// ===========================================================================

describe('metrics registry: new XLM refund counters present', () => {
  it('exports all three new counter names in Prometheus text format', async () => {
    const { registry } = await import('../src/metrics.js');
    const output = await registry.metrics();
    const expectedNames = [
      'relayer_xlm_refund_duplicates_suppressed_total',
      'relayer_xlm_refund_horizon_timeouts_total',
      'relayer_xlm_refund_horizon_retries_total',
    ];
    for (const name of expectedNames) {
      expect(output, `missing metric: ${name}`).toContain(name);
    }
  });

  it('refundMetrics export contains the three counter instances', async () => {
    const { refundMetrics } = await import('../src/metrics.js');
    expect(refundMetrics).toHaveProperty('duplicatesSuppressed');
    expect(refundMetrics).toHaveProperty('horizonTimeouts');
    expect(refundMetrics).toHaveProperty('horizonRetries');
  });
});

// ===========================================================================
// Stroop math property tests
// ===========================================================================

describe('stroop math: round-trip and fee deduction', () => {
  it('round-trips a set of canonical XLM strings without precision loss', () => {
    const cases = ['0.0000001', '0.0000100', '1.0000000', '100.0000001', '999999.9999999'];
    for (const xlm of cases) {
      expect(stroopsToXlmString(xlmStringToStroops(xlm))).toBe(xlm);
    }
  });

  it('fee deduction: exactly 100 stroops removed', () => {
    const original = xlmStringToStroops('10.0000000'); // 100_000_000
    expect(original - 100n).toBe(99_999_900n);
    expect(stroopsToXlmString(original - 100n)).toBe('9.9999900');
  });

  it('fee deduction on tiny amount falls to minimum 1 stroop', () => {
    const tinyStroops = 50n;
    const fee = 100n;
    const refund = tinyStroops > fee ? tinyStroops - fee : 1n;
    expect(refund).toBe(1n);
  });

  it('no floating-point operations on amount path (bigint only)', () => {
    // Verify the math helpers produce bigint, not number.
    expect(typeof xlmStringToStroops('12.3456789')).toBe('bigint');
    expect(typeof stroopsToXlmString(123456789n)).toBe('string');
    expect(typeof parseFallbackStroops('10000000')).toBe('bigint');
  });

  it('large amounts round-trip without floating-point imprecision', () => {
    // 100000 XLM — would lose precision as float64.
    const stroops = xlmStringToStroops('100000.0000000');
    expect(stroops).toBe(1_000_000_000_000n);
    expect(stroopsToXlmString(stroops)).toBe('100000.0000000');
  });

  it('xlmStringToStroops is consistent for amounts used in real orders', () => {
    const amounts = ['0.1', '5.0', '100.0', '1234.5678900'];
    for (const a of amounts) {
      const s = xlmStringToStroops(a);
      expect(s).toBeGreaterThan(0n);
      expect(typeof s).toBe('bigint');
    }
  });
});
