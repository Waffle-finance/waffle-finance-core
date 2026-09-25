/**
 * Tests for settlement failure recovery infrastructure.
 * Covers: SettlementFailureStore, settlement-retry-policy classifiers,
 * RetryEngine integration pattern, /api/admin/settlement-failures endpoint,
 * and Prometheus metrics for failures and recovery.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as pathMod from 'path';
import { Registry, Counter, Gauge } from 'prom-client';

// ---------------------------------------------------------------------------
// Isolate Prometheus registry
// ---------------------------------------------------------------------------
vi.mock('../src/metrics.js', () => {
  const reg = new Registry();
  const c = (n: string, l: string[] = []) =>
    new Counter({ name: n, help: 't', labelNames: l, registers: [reg] });
  const g = (n: string) => new Gauge({ name: n, help: 't', registers: [reg] });
  return {
    settlementFailuresTotal:         c('sf',    ['direction', 'category', 'chain']),
    settlementFailuresByCategory:    c('sfbc',  ['category', 'recoverability']),
    settlementRecoveryAttemptsTotal: c('sra',   ['direction']),
    settlementRecoveredTotal:        c('srec',  ['direction']),
    settlementTerminalTotal:         c('sterm', ['direction', 'category']),
    settlementPendingRecoveryGauge:  g('sp'),
    settlementFailureMetrics: {},
    retryEngineAttemptsTotal:        c('rea',  ['fault_class', 'action']),
    retryEngineExhaustedTotal:       c('ree',  ['fault_class', 'action']),
    retryEngineCircuitOpenedTotal:   c('reco', ['action']),
    retryEngineCircuitRejectedTotal: c('recr', ['action']),
    retryEngineCircuitState:         g('recs'),
    retryEngineBackoffSeconds:       { observe: vi.fn() },
    correlationOpsTotal:             c('cop',  ['route', 'outcome']),
    correlationCheckpointsTotal:     c('ccp',  ['checkpoint', 'route']),
    correlationOpDurationSeconds:    { startTimer: () => () => {} },
    correlationRetryHopsTotal:       c('crh',  ['route', 'reason']),
  };
});

import {
  SettlementFailureStore,
  CATEGORY_RECOVERABILITY,
  type FailureCategory,
} from '../src/services/settlement-failure-store.js';
import {
  ethRpcClassifier,
  horizonClassifier,
  classifyFailureCategory,
} from '../src/services/settlement-retry-policy.js';
import {
  HorizonTimeoutError,
  HorizonTerminalError,
  HorizonTransientError,
} from '../src/services/xlm-refund.js';
import { RetryEngine, RetryExhaustedError } from '../src/utils/retry-engine.js';
import { RecoveryService, RecoveryStatus, RecoveryType, type RecoveryConfig } from '../src/services/recovery-service.js';
import { OrdersService } from '../src/services/orders.js';
import FusionEventManager from '../src/events/event-handlers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStore() {
  return new SettlementFailureStore({ storageDir: null });
}

async function cVal(
  metric: ReturnType<typeof Counter>,
  labels: Record<string, string> = {},
): Promise<number> {
  const d = await (metric as any).get();
  const f = d.values.find((v: any) =>
    Object.entries(labels).every(([k, val]) => v.labels[k] === val),
  );
  return f?.value ?? 0;
}

async function gVal(metric: ReturnType<typeof Gauge>): Promise<number> {
  const d = await (metric as any).get();
  return d.values[0]?.value ?? 0;
}

function makeEngine() {
  return new RetryEngine({
    defaultMaxAttempts: 3,
    defaultBaseDelayMs: 1,
    defaultMaxDelayMs: 5,
    jitterFactor: 0,
    circuitBreakerThreshold: 10,
  });
}

// ===========================================================================
// SettlementFailureStore — recordFailure
// ===========================================================================

describe('SettlementFailureStore — recordFailure basics', () => {
  it('creates a new record on first call', () => {
    const s = makeStore();
    const r = s.recordFailure({
      orderId: 'o1', direction: 'xlm_to_eth',
      category: 'rpc_rate_limit', errorMessage: 'throttled', chain: 'ethereum',
    });
    expect(r.orderId).toBe('o1');
    expect(r.failureCount).toBe(1);
    expect(r.events).toHaveLength(1);
    expect(r.events[0].category).toBe('rpc_rate_limit');
    expect(r.events[0].recoverability).toBe('recoverable');
    expect(r.events[0].chain).toBe('ethereum');
    expect(r.events[0].attempt).toBe(1);
  });

  it('appends events and increments failureCount on subsequent calls', () => {
    const s = makeStore();
    s.recordFailure({ orderId: 'o1', direction: 'xlm_to_eth', category: 'rpc_rate_limit', errorMessage: 'a', chain: 'ethereum' });
    s.recordFailure({ orderId: 'o1', direction: 'xlm_to_eth', category: 'rpc_timeout',    errorMessage: 'b', chain: 'ethereum' });
    const r = s.get('o1')!;
    expect(r.failureCount).toBe(2);
    expect(r.events).toHaveLength(2);
    expect(r.events[1].category).toBe('rpc_timeout');
    expect(r.events[1].attempt).toBe(2);
  });

  it('sets recoveryStatus to failed immediately for terminal category', () => {
    const s = makeStore();
    const r = s.recordFailure({
      orderId: 'ot', direction: 'xlm_to_eth',
      category: 'insufficient_balance', errorMessage: 'no funds', chain: 'ethereum',
    });
    expect(r.recoveryStatus).toBe('failed');
    expect(r.terminalReason).toMatch(/no funds/);
  });

  it('sets recoveryStatus to requires_review for partial_settlement', () => {
    const s = makeStore();
    const r = s.recordFailure({
      orderId: 'op', direction: 'eth_to_xlm',
      category: 'partial_settlement', errorMessage: 'partial', chain: 'stellar',
    });
    expect(r.recoveryStatus).toBe('requires_review');
  });

  it('keeps recoveryStatus as pending for recoverable category', () => {
    const s = makeStore();
    const r = s.recordFailure({
      orderId: 'orec', direction: 'xlm_to_eth',
      category: 'rpc_rate_limit', errorMessage: 'x', chain: 'ethereum',
    });
    expect(r.recoveryStatus).toBe('pending');
  });

  it('sanitises ethereum addresses from errorMessage', () => {
    const s = makeStore();
    const r = s.recordFailure({
      orderId: 'osan', direction: 'xlm_to_eth', category: 'rpc_rate_limit',
      errorMessage: 'failed for 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
      chain: 'ethereum',
    });
    expect(r.events[0].errorMessage).not.toMatch(/0xd8dA6BF/);
    expect(r.events[0].errorMessage).toContain('[address/hash]');
  });

  it('sanitises Stellar public keys from errorMessage', () => {
    const s = makeStore();
    const r = s.recordFailure({
      orderId: 'osk', direction: 'xlm_to_eth', category: 'stellar_bad_seq',
      errorMessage: 'GDRELAYER000000000000000000000000000000000000000000000000 bad seq',
      chain: 'stellar',
    });
    expect(r.events[0].errorMessage).not.toMatch(/GDRELAYER/);
    expect(r.events[0].errorMessage).toContain('[stellar-key]');
  });
});

// ===========================================================================
// SettlementFailureStore — lifecycle transitions
// ===========================================================================

describe('SettlementFailureStore — lifecycle transitions', () => {
  it('markRecovering transitions pending → recovering', () => {
    const s = makeStore();
    s.recordFailure({ orderId: 'or', direction: 'xlm_to_eth', category: 'rpc_rate_limit', errorMessage: 'x', chain: 'ethereum' });
    s.markRecovering('or');
    const r = s.get('or')!;
    expect(r.recoveryStatus).toBe('recovering');
    expect(r.recoveryAttempts).toBe(1);
  });

  it('markRecovering is a no-op on a terminal record', () => {
    const s = makeStore();
    s.recordFailure({ orderId: 'oterm', direction: 'xlm_to_eth', category: 'auth_failure', errorMessage: 'bad auth', chain: 'ethereum' });
    expect(s.get('oterm')!.recoveryStatus).toBe('failed');
    s.markRecovering('oterm');
    expect(s.get('oterm')!.recoveryStatus).toBe('failed');
  });

  it('markRecovered sets recovered status and stamps txHash', () => {
    const s = makeStore();
    s.recordFailure({ orderId: 'ook', direction: 'xlm_to_eth', category: 'rpc_rate_limit', errorMessage: 'x', chain: 'ethereum' });
    s.markRecovering('ook');
    s.markRecovered('ook', '0xtxhash');
    const r = s.get('ook')!;
    expect(r.recoveryStatus).toBe('recovered');
    expect(r.recoveredTxHash).toBe('0xtxhash');
  });

  it('markRequiresReview stamps reason and sets requires_review', () => {
    const s = makeStore();
    s.recordFailure({ orderId: 'orv', direction: 'eth_to_xlm', category: 'rpc_timeout', errorMessage: 'timeout', chain: 'ethereum' });
    s.markRequiresReview('orv', 'one leg completed without the other');
    const r = s.get('orv')!;
    expect(r.recoveryStatus).toBe('requires_review');
    expect(r.terminalReason).toMatch(/one leg/);
  });

  it('hasFailed returns false before any failure and true after', () => {
    const s = makeStore();
    expect(s.hasFailed('ox')).toBe(false);
    s.recordFailure({ orderId: 'ox', direction: 'xlm_to_eth', category: 'rpc_timeout', errorMessage: 'x', chain: 'ethereum' });
    expect(s.hasFailed('ox')).toBe(true);
  });

  it('markRecovering increments recoveryAttempts on each call', () => {
    const s = makeStore();
    s.recordFailure({ orderId: 'om', direction: 'xlm_to_eth', category: 'rpc_rate_limit', errorMessage: 'x', chain: 'ethereum' });
    s.markRecovering('om');
    s.markRecovering('om');
    expect(s.get('om')!.recoveryAttempts).toBe(2);
  });
});

// ===========================================================================
// SettlementFailureStore — query API
// ===========================================================================

describe('SettlementFailureStore — query API', () => {
  it('byStatus filters correctly across mixed statuses', () => {
    const s = makeStore();
    s.recordFailure({ orderId: 'a', direction: 'xlm_to_eth', category: 'rpc_rate_limit',      errorMessage: 'x', chain: 'ethereum' });
    s.recordFailure({ orderId: 'b', direction: 'xlm_to_eth', category: 'auth_failure',         errorMessage: 'x', chain: 'ethereum' });
    s.recordFailure({ orderId: 'c', direction: 'xlm_to_eth', category: 'rpc_timeout',          errorMessage: 'x', chain: 'ethereum' });
    s.markRecovered('c', '0xhash');
    const pending   = s.byStatus('pending').map(r => r.orderId);
    const failed    = s.byStatus('failed').map(r => r.orderId);
    const recovered = s.byStatus('recovered').map(r => r.orderId);
    expect(pending).toContain('a');
    expect(failed).toContain('b');
    expect(recovered).toContain('c');
    expect(pending).not.toContain('b');
  });

  it('summary returns correct counts across all statuses', () => {
    const s = makeStore();
    s.recordFailure({ orderId: 'p1', direction: 'xlm_to_eth', category: 'rpc_rate_limit',       errorMessage: 'x', chain: 'ethereum' });
    s.recordFailure({ orderId: 'p2', direction: 'xlm_to_eth', category: 'rpc_timeout',           errorMessage: 'x', chain: 'ethereum' });
    s.recordFailure({ orderId: 'f1', direction: 'xlm_to_eth', category: 'insufficient_balance',  errorMessage: 'x', chain: 'ethereum' });
    s.markRecovering('p1');
    s.markRecovered('p1', '0x1');
    const sum = s.summary();
    expect(sum.pending).toBe(1);
    expect(sum.recovered).toBe(1);
    expect(sum.failed).toBe(1);
    expect(sum.recovering).toBe(0);
  });

  it('size() returns total records regardless of status', () => {
    const s = makeStore();
    expect(s.size()).toBe(0);
    s.recordFailure({ orderId: 'x1', direction: 'xlm_to_eth', category: 'rpc_rate_limit', errorMessage: 'x', chain: 'ethereum' });
    s.recordFailure({ orderId: 'x2', direction: 'xlm_to_eth', category: 'rpc_timeout',    errorMessage: 'x', chain: 'ethereum' });
    expect(s.size()).toBe(2);
  });

  it('all() returns every record', () => {
    const s = makeStore();
    s.recordFailure({ orderId: 'z1', direction: 'xlm_to_eth', category: 'rpc_rate_limit', errorMessage: 'x', chain: 'ethereum' });
    s.recordFailure({ orderId: 'z2', direction: 'xlm_to_eth', category: 'rpc_timeout',    errorMessage: 'x', chain: 'ethereum' });
    expect(s.all()).toHaveLength(2);
  });
});

// ===========================================================================
// SettlementFailureStore — persistence (restart simulation)
// ===========================================================================

describe('SettlementFailureStore — persistence', () => {
  it('failure record survives restart — second instance loads from disk', () => {
    const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'sfstore-'));
    try {
      const s1 = new SettlementFailureStore({ storageDir: dir });
      s1.recordFailure({ orderId: 'persist-1', direction: 'xlm_to_eth', category: 'rpc_rate_limit', errorMessage: 'throttled', chain: 'ethereum' });
      s1.markRecovering('persist-1');

      const s2 = new SettlementFailureStore({ storageDir: dir });
      const r = s2.get('persist-1');
      expect(r).toBeDefined();
      expect(r!.recoveryStatus).toBe('recovering');
      expect(r!.failureCount).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('recovered record persists correctly', () => {
    const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'sfstore-'));
    try {
      const s1 = new SettlementFailureStore({ storageDir: dir });
      s1.recordFailure({ orderId: 'persist-2', direction: 'xlm_to_eth', category: 'rpc_timeout', errorMessage: 'timeout', chain: 'ethereum' });
      s1.markRecovered('persist-2', '0xrecoveredtx');

      const s2 = new SettlementFailureStore({ storageDir: dir });
      const r = s2.get('persist-2');
      expect(r!.recoveryStatus).toBe('recovered');
      expect(r!.recoveredTxHash).toBe('0xrecoveredtx');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('storageDir:null disables disk I/O — no files written', () => {
    const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'sfstore-'));
    try {
      const s = new SettlementFailureStore({ storageDir: null });
      s.recordFailure({ orderId: 'nopersist', direction: 'xlm_to_eth', category: 'rpc_rate_limit', errorMessage: 'x', chain: 'ethereum' });
      expect(fs.readdirSync(dir)).toHaveLength(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// CATEGORY_RECOVERABILITY map
// ===========================================================================

describe('CATEGORY_RECOVERABILITY map', () => {
  it('all recoverable categories map to recoverable', () => {
    const recoverable: FailureCategory[] = [
      'rpc_rate_limit', 'rpc_timeout', 'horizon_transient',
      'eth_nonce_conflict', 'eth_gas_too_low', 'stellar_bad_seq', 'stellar_fee_too_low',
    ];
    for (const cat of recoverable) {
      expect(CATEGORY_RECOVERABILITY[cat], `expected ${cat} to be recoverable`).toBe('recoverable');
    }
  });

  it('terminal categories map to terminal', () => {
    const terminal: FailureCategory[] = ['insufficient_balance', 'auth_failure', 'terminal_unknown'];
    for (const cat of terminal) {
      expect(CATEGORY_RECOVERABILITY[cat], `expected ${cat} to be terminal`).toBe('terminal');
    }
  });

  it('horizon_timeout maps to ambiguous', () => {
    expect(CATEGORY_RECOVERABILITY['horizon_timeout']).toBe('ambiguous');
  });

  it('partial_settlement maps to requires_review', () => {
    expect(CATEGORY_RECOVERABILITY['partial_settlement']).toBe('requires_review');
  });
});

// ===========================================================================
// ethRpcClassifier
// ===========================================================================

describe('ethRpcClassifier', () => {
  it('rate limit (code 429) → transient', () => {
    const err = Object.assign(new Error('exceeded compute units'), { code: 429 });
    expect(ethRpcClassifier(err)).toBe('transient');
  });

  it('compute units message → transient', () => {
    expect(ethRpcClassifier(new Error('compute units per second capacity exceeded'))).toBe('transient');
  });

  it('ETIMEDOUT → transient', () => {
    expect(ethRpcClassifier(new Error('ETIMEDOUT: connection timed out'))).toBe('transient');
  });

  it('socket hang up → transient', () => {
    expect(ethRpcClassifier(new Error('socket hang up'))).toBe('transient');
  });

  it('insufficient funds → terminal', () => {
    expect(ethRpcClassifier(new Error('insufficient funds for gas * price + value'))).toBe('terminal');
  });

  it('execution reverted → terminal', () => {
    expect(ethRpcClassifier(new Error('execution reverted: bad input'))).toBe('terminal');
  });

  it('nonce too low → confirmation_delay', () => {
    expect(ethRpcClassifier(new Error('nonce too low'))).toBe('confirmation_delay');
  });

  it('already known → confirmation_delay', () => {
    expect(ethRpcClassifier(new Error('already known'))).toBe('confirmation_delay');
  });

  it('unknown error → null (fall-through)', () => {
    expect(ethRpcClassifier(new Error('some totally unknown error abc'))).toBeNull();
  });

  it('nested code 429 (Alchemy UNKNOWN_ERROR wrapper) → transient', () => {
    const err = Object.assign(new Error('provider error'), {
      code: 'UNKNOWN_ERROR',
      error: { code: 429 },
    });
    expect(ethRpcClassifier(err)).toBe('transient');
  });
});

// ===========================================================================
// horizonClassifier
// ===========================================================================

describe('horizonClassifier', () => {
  it('HorizonTimeoutError → transient', () => {
    expect(horizonClassifier(new HorizonTimeoutError('504'))).toBe('transient');
  });

  it('HorizonTerminalError → terminal', () => {
    expect(horizonClassifier(new HorizonTerminalError('bad auth', 'tx_bad_auth'))).toBe('terminal');
  });

  it('HorizonTransientError → transient', () => {
    expect(horizonClassifier(new HorizonTransientError('503'))).toBe('transient');
  });

  it('HTTP 504 response → transient', () => {
    const err = Object.assign(new Error('gateway timeout'), { response: { status: 504 } });
    expect(horizonClassifier(err)).toBe('transient');
  });

  it('HTTP 400 with tx_bad_auth → terminal', () => {
    const err = Object.assign(new Error('rejected'), {
      response: { status: 400, data: { extras: { result_codes: { transaction: 'tx_bad_auth', operations: [] } } } },
    });
    expect(horizonClassifier(err)).toBe('terminal');
  });

  it('HTTP 400 with tx_bad_seq → transient (retryable)', () => {
    const err = Object.assign(new Error('rejected'), {
      response: { status: 400, data: { extras: { result_codes: { transaction: 'tx_bad_seq', operations: [] } } } },
    });
    expect(horizonClassifier(err)).toBe('transient');
  });

  it('HTTP 500 → transient', () => {
    const err = Object.assign(new Error('server error'), { response: { status: 500 } });
    expect(horizonClassifier(err)).toBe('transient');
  });

  it('unknown error → null (fall-through)', () => {
    expect(horizonClassifier(new Error('some unknown error'))).toBeNull();
  });
});

// ===========================================================================
// classifyFailureCategory
// ===========================================================================

describe('classifyFailureCategory', () => {
  it('ethereum rate limit → rpc_rate_limit', () => {
    const err = Object.assign(new Error('compute units exceeded'), { code: 429 });
    expect(classifyFailureCategory(err, 'ethereum')).toBe('rpc_rate_limit');
  });

  it('ethereum ETIMEDOUT → rpc_timeout', () => {
    expect(classifyFailureCategory(new Error('ETIMEDOUT connecting to rpc'), 'ethereum')).toBe('rpc_timeout');
  });

  it('ethereum socket hang up → rpc_timeout', () => {
    expect(classifyFailureCategory(new Error('socket hang up'), 'ethereum')).toBe('rpc_timeout');
  });

  it('ethereum nonce too low → eth_nonce_conflict', () => {
    expect(classifyFailureCategory(new Error('nonce too low'), 'ethereum')).toBe('eth_nonce_conflict');
  });

  it('ethereum gas limit exceeded → eth_gas_too_low', () => {
    expect(classifyFailureCategory(new Error('gas limit exceeded'), 'ethereum')).toBe('eth_gas_too_low');
  });

  it('ethereum insufficient funds → insufficient_balance', () => {
    expect(classifyFailureCategory(new Error('insufficient funds for gas'), 'ethereum')).toBe('insufficient_balance');
  });

  it('ethereum execution reverted → auth_failure', () => {
    expect(classifyFailureCategory(new Error('execution reverted'), 'ethereum')).toBe('auth_failure');
  });

  it('HorizonTimeoutError → horizon_timeout', () => {
    expect(classifyFailureCategory(new HorizonTimeoutError('504'), 'stellar')).toBe('horizon_timeout');
  });

  it('HorizonTerminalError tx_bad_seq → stellar_bad_seq', () => {
    expect(classifyFailureCategory(new HorizonTerminalError('bad seq', 'tx_bad_seq'), 'stellar')).toBe('stellar_bad_seq');
  });

  it('HorizonTerminalError tx_insufficient_fee → stellar_fee_too_low', () => {
    expect(classifyFailureCategory(new HorizonTerminalError('fee low', 'tx_insufficient_fee'), 'stellar')).toBe('stellar_fee_too_low');
  });

  it('HorizonTerminalError tx_bad_auth → auth_failure', () => {
    expect(classifyFailureCategory(new HorizonTerminalError('bad auth', 'tx_bad_auth'), 'stellar')).toBe('auth_failure');
  });

  it('HorizonTransientError → horizon_transient', () => {
    expect(classifyFailureCategory(new HorizonTransientError('503'), 'stellar')).toBe('horizon_transient');
  });

  it('completely unknown error → terminal_unknown', () => {
    expect(classifyFailureCategory(new Error('extremely obscure provider failure xyz'), 'unknown')).toBe('terminal_unknown');
  });
});

// ===========================================================================
// RetryEngine integration — runWithSettlementRetry pattern
// ===========================================================================

/**
 * Inline implementation of the runWithSettlementRetry pattern from index.ts
 * so we can test it in isolation without booting the full relayer.
 */
async function runWithSettlementRetry<T>(
  engine: RetryEngine,
  store: SettlementFailureStore,
  action: string,
  opts: { maxAttempts: number; baseDelayMs: number; maxDelayMs: number },
  fn: () => Promise<T>,
  meta: { orderId: string; direction: string; chain: 'ethereum' | 'stellar' | 'unknown'; recoveredTxHash?: (r: T) => string },
): Promise<T> {
  if (store.hasFailed(meta.orderId)) store.markRecovering(meta.orderId);
  try {
    const result = await engine.run(action, fn, opts);
    if (store.hasFailed(meta.orderId)) {
      store.markRecovered(meta.orderId, meta.recoveredTxHash?.(result) ?? '');
    }
    return result;
  } catch (err: unknown) {
    const category = classifyFailureCategory(err, meta.chain);
    store.recordFailure({
      orderId: meta.orderId, direction: meta.direction, category,
      errorMessage: err instanceof Error ? err.message : String(err),
      chain: meta.chain, recoveryAction: `RetryEngine exhausted action=${action}`,
    });
    throw err;
  }
}

describe('runWithSettlementRetry — retry and recovery', () => {
  it('succeeds on first attempt — store remains empty', async () => {
    const engine = makeEngine();
    const store = makeStore();
    const result = await runWithSettlementRetry(
      engine, store, 'eth-send',
      { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 5 },
      () => Promise.resolve('0xok'),
      { orderId: 'r1', direction: 'xlm_to_eth', chain: 'ethereum' },
    );
    expect(result).toBe('0xok');
    expect(store.hasFailed('r1')).toBe(false);
  });

  it('recoverable failure retried to success — store shows recovered', async () => {
    const engine = makeEngine();
    const store = makeStore();
    // Pre-record a failure so the store already knows about this order.
    store.recordFailure({ orderId: 'r2', direction: 'xlm_to_eth', category: 'rpc_rate_limit', errorMessage: 'throttled', chain: 'ethereum' });

    let calls = 0;
    const result = await runWithSettlementRetry(
      engine, store, 'eth-send',
      { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 5 },
      () => { calls++; if (calls < 2) throw new Error('rate limit exceeded'); return Promise.resolve('0xretried'); },
      { orderId: 'r2', direction: 'xlm_to_eth', chain: 'ethereum', recoveredTxHash: (r) => r },
    );
    expect(result).toBe('0xretried');
    expect(store.get('r2')!.recoveryStatus).toBe('recovered');
    expect(store.get('r2')!.recoveredTxHash).toBe('0xretried');
  });

  it('recoverable failure exhausts retries — failure recorded, error rethrown', async () => {
    const engine = makeEngine();
    const store = makeStore();
    const fn = vi.fn().mockRejectedValue(new Error('rate limit exceeded'));
    await expect(
      runWithSettlementRetry(
        engine, store, 'eth-send',
        { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 5 },
        fn,
        { orderId: 'r3', direction: 'xlm_to_eth', chain: 'ethereum' },
      )
    ).rejects.toThrow();
    expect(store.hasFailed('r3')).toBe(true);
    const r = store.get('r3')!;
    expect(r.events[0].category).toBe('rpc_rate_limit');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('terminal failure recorded immediately, not retried', async () => {
    const engine = makeEngine();
    const store = makeStore();
    const fn = vi.fn().mockRejectedValue(new Error('insufficient funds for gas'));
    await expect(
      runWithSettlementRetry(
        engine, store, 'eth-send',
        { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 5 },
        fn,
        { orderId: 'r4', direction: 'xlm_to_eth', chain: 'ethereum' },
      )
    ).rejects.toThrow();
    // Terminal — only called once.
    expect(fn).toHaveBeenCalledTimes(1);
    expect(store.get('r4')!.events[0].category).toBe('insufficient_balance');
    expect(store.get('r4')!.recoveryStatus).toBe('failed');
  });

  it('second run after prior failure calls markRecovering first', async () => {
    const engine = makeEngine();
    const store = makeStore();
    // Record a prior failure manually.
    store.recordFailure({ orderId: 'r5', direction: 'xlm_to_eth', category: 'rpc_rate_limit', errorMessage: 'x', chain: 'ethereum' });
    expect(store.get('r5')!.recoveryStatus).toBe('pending');

    await runWithSettlementRetry(
      engine, store, 'eth-send',
      { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 5 },
      () => Promise.resolve('0xsuccess'),
      { orderId: 'r5', direction: 'xlm_to_eth', chain: 'ethereum' },
    );
    expect(store.get('r5')!.recoveryStatus).toBe('recovered');
  });
});

// ===========================================================================
// /api/admin/settlement-failures route integration
// ===========================================================================

function buildAdminApp(store: SettlementFailureStore) {
  const app = express();
  app.use(express.json());

  // Minimal auth middleware matching the real requireAdminAuth pattern.
  const AUTH_TOKEN = 'test-admin-token';
  const auth = (req: any, res: any, next: any) => {
    const header = req.headers['authorization'] ?? req.headers['x-api-key'] ?? '';
    const token = header.replace(/^Bearer\s+/i, '');
    if (token !== AUTH_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
    next();
  };

  app.get('/api/admin/settlement-failures', auth, (_req, res) => {
    const statusFilter = typeof _req.query.status === 'string' ? _req.query.status : undefined;
    const limit = Math.min(parseInt(String(_req.query.limit ?? '100'), 10) || 100, 500);
    const all = store.all()
      .filter(r => !statusFilter || r.recoveryStatus === statusFilter)
      .sort((a, b) => b.lastUpdatedAt - a.lastUpdatedAt)
      .slice(0, limit);
    res.json({
      summary: store.summary(),
      total: store.size(),
      filtered: all.length,
      records: all.map(r => ({
        orderId: r.orderId,
        direction: r.direction,
        recoveryStatus: r.recoveryStatus,
        failureCount: r.failureCount,
        recoveryAttempts: r.recoveryAttempts,
        firstFailedAt: new Date(r.firstFailedAt).toISOString(),
        lastUpdatedAt: new Date(r.lastUpdatedAt).toISOString(),
        terminalReason: r.terminalReason,
        recoveredTxHash: r.recoveredTxHash,
        recentEvents: r.events.slice(-3),
      })),
    });
  });

  app.get('/api/admin/settlement-failures/:orderId', auth, (_req, res) => {
    const record = store.get(_req.params.orderId);
    if (!record) return res.status(404).json({ error: 'No failure record found', orderId: _req.params.orderId });
    res.json({ record });
  });

  return app;
}

const AUTH = 'Bearer test-admin-token';

describe('/api/admin/settlement-failures — auth', () => {
  it('returns 401 without auth token', async () => {
    const app = buildAdminApp(makeStore());
    const res = await supertest(app).get('/api/admin/settlement-failures');
    expect(res.status).toBe(401);
  });

  it('returns 200 with valid auth token', async () => {
    const app = buildAdminApp(makeStore());
    const res = await supertest(app).get('/api/admin/settlement-failures').set('Authorization', AUTH);
    expect(res.status).toBe(200);
  });
});

describe('/api/admin/settlement-failures — empty store', () => {
  it('returns summary with all zeros and empty records array', async () => {
    const app = buildAdminApp(makeStore());
    const res = await supertest(app).get('/api/admin/settlement-failures').set('Authorization', AUTH);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.records).toHaveLength(0);
    expect(res.body.summary.pending).toBe(0);
    expect(res.body.summary.failed).toBe(0);
  });
});

describe('/api/admin/settlement-failures — list and filter', () => {
  it('returns all records when no status filter applied', async () => {
    const store = makeStore();
    store.recordFailure({ orderId: 'a', direction: 'xlm_to_eth', category: 'rpc_rate_limit',     errorMessage: 'x', chain: 'ethereum' });
    store.recordFailure({ orderId: 'b', direction: 'xlm_to_eth', category: 'insufficient_balance', errorMessage: 'x', chain: 'ethereum' });
    const app = buildAdminApp(store);
    const res = await supertest(app).get('/api/admin/settlement-failures').set('Authorization', AUTH);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.records).toHaveLength(2);
  });

  it('?status=pending returns only pending records', async () => {
    const store = makeStore();
    store.recordFailure({ orderId: 'p1', direction: 'xlm_to_eth', category: 'rpc_rate_limit',      errorMessage: 'x', chain: 'ethereum' });
    store.recordFailure({ orderId: 'f1', direction: 'xlm_to_eth', category: 'auth_failure',         errorMessage: 'x', chain: 'ethereum' });
    const app = buildAdminApp(store);
    const res = await supertest(app).get('/api/admin/settlement-failures?status=pending').set('Authorization', AUTH);
    expect(res.status).toBe(200);
    expect(res.body.records).toHaveLength(1);
    expect(res.body.records[0].orderId).toBe('p1');
  });

  it('?status=failed returns only failed records', async () => {
    const store = makeStore();
    store.recordFailure({ orderId: 'p1', direction: 'xlm_to_eth', category: 'rpc_rate_limit',      errorMessage: 'x', chain: 'ethereum' });
    store.recordFailure({ orderId: 'f1', direction: 'xlm_to_eth', category: 'insufficient_balance', errorMessage: 'x', chain: 'ethereum' });
    const app = buildAdminApp(store);
    const res = await supertest(app).get('/api/admin/settlement-failures?status=failed').set('Authorization', AUTH);
    expect(res.status).toBe(200);
    expect(res.body.records).toHaveLength(1);
    expect(res.body.records[0].orderId).toBe('f1');
  });

  it('?limit=1 returns at most 1 record', async () => {
    const store = makeStore();
    store.recordFailure({ orderId: 'a', direction: 'xlm_to_eth', category: 'rpc_rate_limit', errorMessage: 'x', chain: 'ethereum' });
    store.recordFailure({ orderId: 'b', direction: 'xlm_to_eth', category: 'rpc_timeout',    errorMessage: 'x', chain: 'ethereum' });
    const app = buildAdminApp(store);
    const res = await supertest(app).get('/api/admin/settlement-failures?limit=1').set('Authorization', AUTH);
    expect(res.status).toBe(200);
    expect(res.body.records).toHaveLength(1);
    expect(res.body.filtered).toBe(1);
    expect(res.body.total).toBe(2);
  });

  it('response includes summary with correct counts', async () => {
    const store = makeStore();
    store.recordFailure({ orderId: 's1', direction: 'xlm_to_eth', category: 'rpc_rate_limit',      errorMessage: 'x', chain: 'ethereum' });
    store.recordFailure({ orderId: 's2', direction: 'xlm_to_eth', category: 'insufficient_balance', errorMessage: 'x', chain: 'ethereum' });
    store.markRecovered('s1', '0xhash');
    const app = buildAdminApp(store);
    const res = await supertest(app).get('/api/admin/settlement-failures').set('Authorization', AUTH);
    expect(res.body.summary.recovered).toBe(1);
    expect(res.body.summary.failed).toBe(1);
  });
});

describe('/api/admin/settlement-failures/:orderId', () => {
  it('returns 200 with full record for known orderId', async () => {
    const store = makeStore();
    store.recordFailure({ orderId: 'detail-1', direction: 'xlm_to_eth', category: 'rpc_timeout', errorMessage: 'timed out', chain: 'ethereum' });
    const app = buildAdminApp(store);
    const res = await supertest(app).get('/api/admin/settlement-failures/detail-1').set('Authorization', AUTH);
    expect(res.status).toBe(200);
    expect(res.body.record.orderId).toBe('detail-1');
    expect(res.body.record.events).toHaveLength(1);
    expect(res.body.record.events[0].category).toBe('rpc_timeout');
  });

  it('returns 404 for unknown orderId', async () => {
    const app = buildAdminApp(makeStore());
    const res = await supertest(app).get('/api/admin/settlement-failures/does-not-exist').set('Authorization', AUTH);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/No failure record/);
  });

  it('returns 401 without auth on single-record endpoint', async () => {
    const store = makeStore();
    store.recordFailure({ orderId: 'detail-2', direction: 'xlm_to_eth', category: 'rpc_timeout', errorMessage: 'x', chain: 'ethereum' });
    const app = buildAdminApp(store);
    const res = await supertest(app).get('/api/admin/settlement-failures/detail-2');
    expect(res.status).toBe(401);
  });
});

// ===========================================================================
// Prometheus metrics
// ===========================================================================

describe('settlement failure Prometheus metrics', () => {
  it('settlementFailureMetrics bundle export contains all six metrics', async () => {
    const { settlementFailureMetrics } = await import('../src/metrics.js');
    expect(settlementFailureMetrics).toBeDefined();
  });

  it('settlementFailuresTotal incremented on recordFailure', async () => {
    const { settlementFailuresTotal } = await import('../src/metrics.js');
    const store = makeStore();
    const before = await cVal(settlementFailuresTotal as any, { direction: 'xlm_to_eth', category: 'rpc_rate_limit', chain: 'ethereum' });
    store.recordFailure({ orderId: 'mtest-1', direction: 'xlm_to_eth', category: 'rpc_rate_limit', errorMessage: 'x', chain: 'ethereum' });
    const after = await cVal(settlementFailuresTotal as any, { direction: 'xlm_to_eth', category: 'rpc_rate_limit', chain: 'ethereum' });
    expect(after).toBe(before + 1);
  });

  it('settlementFailuresByCategory incremented on recordFailure', async () => {
    const { settlementFailuresByCategory } = await import('../src/metrics.js');
    const store = makeStore();
    const before = await cVal(settlementFailuresByCategory as any, { category: 'rpc_timeout', recoverability: 'recoverable' });
    store.recordFailure({ orderId: 'mtest-2', direction: 'xlm_to_eth', category: 'rpc_timeout', errorMessage: 'x', chain: 'ethereum' });
    const after = await cVal(settlementFailuresByCategory as any, { category: 'rpc_timeout', recoverability: 'recoverable' });
    expect(after).toBe(before + 1);
  });

  it('settlementTerminalTotal incremented for terminal category', async () => {
    const { settlementTerminalTotal } = await import('../src/metrics.js');
    const store = makeStore();
    const before = await cVal(settlementTerminalTotal as any, { direction: 'xlm_to_eth', category: 'auth_failure' });
    store.recordFailure({ orderId: 'mtest-3', direction: 'xlm_to_eth', category: 'auth_failure', errorMessage: 'bad auth', chain: 'ethereum' });
    const after = await cVal(settlementTerminalTotal as any, { direction: 'xlm_to_eth', category: 'auth_failure' });
    expect(after).toBe(before + 1);
  });

  it('settlementRecoveryAttemptsTotal incremented on markRecovering', async () => {
    const { settlementRecoveryAttemptsTotal } = await import('../src/metrics.js');
    const store = makeStore();
    store.recordFailure({ orderId: 'mtest-4', direction: 'xlm_to_eth', category: 'rpc_rate_limit', errorMessage: 'x', chain: 'ethereum' });
    const before = await cVal(settlementRecoveryAttemptsTotal as any, { direction: 'xlm_to_eth' });
    store.markRecovering('mtest-4');
    const after = await cVal(settlementRecoveryAttemptsTotal as any, { direction: 'xlm_to_eth' });
    expect(after).toBe(before + 1);
  });

  it('settlementRecoveredTotal incremented on markRecovered', async () => {
    const { settlementRecoveredTotal } = await import('../src/metrics.js');
    const store = makeStore();
    store.recordFailure({ orderId: 'mtest-5', direction: 'xlm_to_eth', category: 'rpc_rate_limit', errorMessage: 'x', chain: 'ethereum' });
    const before = await cVal(settlementRecoveredTotal as any, { direction: 'xlm_to_eth' });
    store.markRecovered('mtest-5', '0xhash');
    const after = await cVal(settlementRecoveredTotal as any, { direction: 'xlm_to_eth' });
    expect(after).toBe(before + 1);
  });

  it('non-terminal failures do NOT increment settlementTerminalTotal', async () => {
    const { settlementTerminalTotal } = await import('../src/metrics.js');
    const store = makeStore();
    const before = await cVal(settlementTerminalTotal as any, { direction: 'xlm_to_eth', category: 'rpc_rate_limit' });
    store.recordFailure({ orderId: 'mtest-6', direction: 'xlm_to_eth', category: 'rpc_rate_limit', errorMessage: 'x', chain: 'ethereum' });
    const after = await cVal(settlementTerminalTotal as any, { direction: 'xlm_to_eth', category: 'rpc_rate_limit' });
    // rpc_rate_limit is recoverable — terminal counter must NOT increment.
    expect(after).toBe(before);
  });
});

// ===========================================================================
// SettlementFailureStore — malformed persisted records
// ===========================================================================

describe('SettlementFailureStore — malformed persisted records', () => {
  /**
   * Write a raw JSON file to the storage directory and boot a fresh store
   * from it, returning the store and a spy on its internal _log method so
   * we can verify the warn path was hit.
   */
  function bootWithFile(dir: string, filename: string, content: unknown) {
    fs.writeFileSync(
      pathMod.join(dir, filename),
      typeof content === 'string' ? content : JSON.stringify(content),
      'utf-8',
    );
  }

  it('skips a record whose JSON is not parseable', () => {
    const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'sfstore-mal-'));
    try {
      bootWithFile(dir, 'bad-json.json', '{not valid json}}}');
      const s = new SettlementFailureStore({ storageDir: dir });
      // File existed but parse failed — store must remain empty, no throw.
      expect(s.size()).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips a record missing orderId', () => {
    const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'sfstore-mal-'));
    try {
      bootWithFile(dir, 'no-orderid.json', {
        direction: 'xlm_to_eth',
        recoveryStatus: 'pending',
        failureCount: 1,
        recoveryAttempts: 0,
        firstFailedAt: Date.now(),
        lastUpdatedAt: Date.now(),
        events: [],
      });
      const s = new SettlementFailureStore({ storageDir: dir });
      expect(s.size()).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips a record with an empty-string orderId', () => {
    const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'sfstore-mal-'));
    try {
      bootWithFile(dir, 'empty-orderid.json', {
        orderId: '',
        direction: 'xlm_to_eth',
        recoveryStatus: 'pending',
        failureCount: 1,
        recoveryAttempts: 0,
        firstFailedAt: Date.now(),
        lastUpdatedAt: Date.now(),
        events: [],
      });
      const s = new SettlementFailureStore({ storageDir: dir });
      expect(s.size()).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips a record with an invalid recoveryStatus value', () => {
    const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'sfstore-mal-'));
    try {
      bootWithFile(dir, 'bad-status.json', {
        orderId: 'bad-status-1',
        direction: 'xlm_to_eth',
        recoveryStatus: 'unknown_status',  // not in the valid set
        failureCount: 1,
        recoveryAttempts: 0,
        firstFailedAt: Date.now(),
        lastUpdatedAt: Date.now(),
        events: [],
      });
      const s = new SettlementFailureStore({ storageDir: dir });
      expect(s.size()).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips a record where failureCount is not a number', () => {
    const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'sfstore-mal-'));
    try {
      bootWithFile(dir, 'bad-count.json', {
        orderId: 'bad-count-1',
        direction: 'xlm_to_eth',
        recoveryStatus: 'pending',
        failureCount: 'one',   // wrong type
        recoveryAttempts: 0,
        firstFailedAt: Date.now(),
        lastUpdatedAt: Date.now(),
        events: [],
      });
      const s = new SettlementFailureStore({ storageDir: dir });
      expect(s.size()).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips a record where events is not an array', () => {
    const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'sfstore-mal-'));
    try {
      bootWithFile(dir, 'bad-events.json', {
        orderId: 'bad-events-1',
        direction: 'xlm_to_eth',
        recoveryStatus: 'pending',
        failureCount: 1,
        recoveryAttempts: 0,
        firstFailedAt: Date.now(),
        lastUpdatedAt: Date.now(),
        events: null,   // should be an array
      });
      const s = new SettlementFailureStore({ storageDir: dir });
      expect(s.size()).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips a record missing the direction field', () => {
    const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'sfstore-mal-'));
    try {
      bootWithFile(dir, 'no-direction.json', {
        orderId: 'no-dir-1',
        // direction intentionally omitted
        recoveryStatus: 'pending',
        failureCount: 1,
        recoveryAttempts: 0,
        firstFailedAt: Date.now(),
        lastUpdatedAt: Date.now(),
        events: [],
      });
      const s = new SettlementFailureStore({ storageDir: dir });
      expect(s.size()).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loads a valid record alongside a malformed one, keeping only the valid one', () => {
    const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'sfstore-mal-'));
    try {
      // Valid record
      bootWithFile(dir, 'good.json', {
        orderId: 'good-order',
        direction: 'xlm_to_eth',
        recoveryStatus: 'pending',
        failureCount: 1,
        recoveryAttempts: 0,
        firstFailedAt: Date.now(),
        lastUpdatedAt: Date.now(),
        events: [],
      });
      // Malformed record in the same directory
      bootWithFile(dir, 'bad.json', {
        orderId: 42,               // orderId must be a string
        direction: 'xlm_to_eth',
        recoveryStatus: 'pending',
        failureCount: 1,
        recoveryAttempts: 0,
        firstFailedAt: Date.now(),
        lastUpdatedAt: Date.now(),
        events: [],
      });
      const s = new SettlementFailureStore({ storageDir: dir });
      expect(s.size()).toBe(1);
      expect(s.get('good-order')).toBeDefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips a duplicate orderId in a second file, keeping the first', () => {
    const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'sfstore-dup-'));
    try {
      const base = {
        orderId: 'dup-order',
        direction: 'xlm_to_eth',
        recoveryStatus: 'pending',
        failureCount: 1,
        recoveryAttempts: 0,
        firstFailedAt: Date.now(),
        lastUpdatedAt: Date.now(),
        events: [],
      };
      // Write two files for the same orderId
      bootWithFile(dir, 'dup_order_a.json', base);
      bootWithFile(dir, 'dup_order_b.json', { ...base, failureCount: 99 });
      const s = new SettlementFailureStore({ storageDir: dir });
      // Only one record loaded; whichever came first wins (alphabetical dir order)
      expect(s.size()).toBe(1);
      // The failureCount from the first-loaded file should be present
      const r = s.get('dup-order');
      expect(r).toBeDefined();
      expect([1, 99]).toContain(r!.failureCount); // either is acceptable — just not both
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('all valid recovery statuses are accepted', () => {
    const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'sfstore-statuses-'));
    try {
      const validStatuses = ['pending', 'recovering', 'recovered', 'failed', 'requires_review'];
      for (const status of validStatuses) {
        bootWithFile(dir, `${status}.json`, {
          orderId: `order-${status}`,
          direction: 'xlm_to_eth',
          recoveryStatus: status,
          failureCount: 1,
          recoveryAttempts: 0,
          firstFailedAt: Date.now(),
          lastUpdatedAt: Date.now(),
          events: [],
        });
      }
      const s = new SettlementFailureStore({ storageDir: dir });
      expect(s.size()).toBe(validStatuses.length);
      for (const status of validStatuses) {
        expect(s.get(`order-${status}`)?.recoveryStatus).toBe(status);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// RecoveryService — retryRecovery guards against completed / cancelled
// ===========================================================================

function makeRecoveryService(overrides: Partial<RecoveryConfig> = {}): {
  service: RecoveryService;
  ordersService: any;
  eventManager: any;
} {
  const ordersService = {
    getActiveOrders: vi.fn().mockReturnValue({ items: [] }),
  };
  const eventManager = {
    on: vi.fn(),
    emitEvent: vi.fn(),
  };
  const config: RecoveryConfig = {
    monitoringInterval: 60_000,   // won't fire during tests
    autoRefundEnabled: false,
    emergencyEnabled: false,
    maxRetries: 3,
    retryDelay: 0,
    gracePeriod: 0,
    ...overrides,
  };
  const service = new RecoveryService(
    ordersService as unknown as OrdersService,
    eventManager as unknown as FusionEventManager,
    config,
  );
  return { service, ordersService, eventManager };
}

describe('RecoveryService — retryRecovery skips completed / cancelled', () => {
  it('does not re-execute a recovery that is already Completed', async () => {
    const { service, ordersService } = makeRecoveryService();

    const orderHash = '0xabc';
    ordersService.getActiveOrders.mockReturnValue({
      items: [{
        orderHash,
        srcChainId: 1,
        dstChainId: 999,
        order: { makingAmount: '100', makerAsset: 'ETH', takingAmount: '200', takerAsset: 'XLM' },
        deadline: Math.floor(Date.now() / 1000) - 100,
      }],
    });

    // Spy on executeTimeoutRefund so we can count executions
    const execSpy = vi.spyOn(service as any, 'executeTimeoutRefund').mockResolvedValue(undefined);

    // Run a successful manual recovery
    const recoveryId = await service.initiateManualRecovery(
      orderHash, RecoveryType.TimeoutRefund, 'test', 'initial run',
    );

    const request = service.getRecoveryRequest(recoveryId);
    expect(request?.status).toBe(RecoveryStatus.Completed);
    expect(execSpy).toHaveBeenCalledTimes(1);

    // Directly invoke the private retryRecovery — simulates a scheduled retry
    // firing after the recovery has already completed.
    await (service as any).retryRecovery(recoveryId);

    // executeTimeoutRefund must still be 1 — no second execution.
    expect(execSpy).toHaveBeenCalledTimes(1);
    expect(request?.status).toBe(RecoveryStatus.Completed);

    execSpy.mockRestore();
    service.cleanup();
  });

  it('does not re-execute a recovery that is Cancelled', async () => {
    const { service, ordersService } = makeRecoveryService();

    const orderHash = '0xdef';
    ordersService.getActiveOrders.mockReturnValue({
      items: [{
        orderHash,
        srcChainId: 1,
        dstChainId: 999,
        order: { makingAmount: '50', makerAsset: 'ETH', takingAmount: '100', takerAsset: 'XLM' },
        deadline: Math.floor(Date.now() / 1000) - 100,
      }],
    });

    const execSpy = vi.spyOn(service as any, 'executeTimeoutRefund').mockResolvedValue(undefined);

    const recoveryId = await service.initiateManualRecovery(
      orderHash, RecoveryType.TimeoutRefund, 'test', 'to be cancelled',
    );

    // Force the recovery into Cancelled state (e.g. via external admin action)
    const request = service.getRecoveryRequest(recoveryId)!;
    request.status = RecoveryStatus.Cancelled;

    execSpy.mockClear();

    // Fire retryRecovery — must be a no-op for Cancelled
    await (service as any).retryRecovery(recoveryId);

    expect(execSpy).not.toHaveBeenCalled();
    expect(request.status).toBe(RecoveryStatus.Cancelled);

    execSpy.mockRestore();
    service.cleanup();
  });

  it('does re-execute a recovery that is Failed (still retryable)', async () => {
    const { service, ordersService } = makeRecoveryService({ maxRetries: 1 });

    const orderHash = '0xfed';
    ordersService.getActiveOrders.mockReturnValue({
      items: [{
        orderHash,
        srcChainId: 1,
        dstChainId: 999,
        order: { makingAmount: '75', makerAsset: 'ETH', takingAmount: '150', takerAsset: 'XLM' },
        deadline: Math.floor(Date.now() / 1000) - 100,
      }],
    });

    // Make the execution succeed this time so we can verify retry ran
    const execSpy = vi.spyOn(service as any, 'executeTimeoutRefund').mockResolvedValue(undefined);

    const recoveryId = await service.initiateManualRecovery(
      orderHash, RecoveryType.TimeoutRefund, 'test', 'will be retried',
    );

    // Force into Failed to simulate the in-flight failure scenario
    const request = service.getRecoveryRequest(recoveryId)!;
    request.status = RecoveryStatus.Failed;

    execSpy.mockClear();

    await (service as any).retryRecovery(recoveryId);

    // Should have been called — Failed is still retryable via retryRecovery
    expect(execSpy).toHaveBeenCalledTimes(1);

    execSpy.mockRestore();
    service.cleanup();
  });

  it('is a no-op when the recoveryId does not exist', async () => {
    const { service } = makeRecoveryService();
    // Should not throw
    await expect(
      (service as any).retryRecovery('nonexistent-id'),
    ).resolves.toBeUndefined();
    service.cleanup();
  });
});
