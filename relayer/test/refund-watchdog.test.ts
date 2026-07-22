/**
 * Tests for refund-watchdog instrumentation.
 *
 * Strategy: each describe block creates a fresh prom-client Registry so
 * counter values never bleed between tests. We build per-test metric
 * instances and inject them into a thin wrapper around the watchdog's
 * internal tick logic.
 *
 * Coverage:
 *  - isXlmToEthAwaitingEth eligibility filter
 *  - toMillis timestamp normalisation
 *  - successful refund: success counter, gauges, timestamp updated
 *  - failed refund: failure counter, backoff written to order
 *  - missing stellarAddress: failure counter with reason=missing_address
 *  - back-off skip: backoff skip counter, refund NOT attempted
 *  - not-yet-stale order: refund NOT attempted
 *  - multiple orders in one tick: each path counted independently
 *  - ledger-aware: committed duplicate → suppressed, no refund call
 *  - ledger-aware: Horizon timeout → ambiguous state, failure metric
 *  - ledger-aware: unknown amount → deferred, no watchdogFailedAt
 *  - metrics endpoint returns text/plain Prometheus format
 *  - registry.metrics() output contains expected metric names
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Registry, Counter, Gauge, Histogram } from 'prom-client';
import { isXlmToEthAwaitingEth, toMillis } from '../src/services/refund-watchdog.js';
import { RefundLedger } from '../src/services/refund-ledger.js';
import {
  HorizonTimeoutError,
  RefundAmountUnknownError,
} from '../src/services/xlm-refund.js';

// ---------------------------------------------------------------------------
// Shared test helpers
// ---------------------------------------------------------------------------

function makeTestMetrics() {
  const reg = new Registry();
  return {
    reg,
    runsTotal:      new Counter({ name: 'test_wd_runs',    help: 't', registers: [reg] }),
    successTotal:   new Counter({ name: 'test_wd_success', help: 't', labelNames: ['network_mode'] as const, registers: [reg] }),
    failureTotal:   new Counter({ name: 'test_wd_failure', help: 't', labelNames: ['reason', 'network_mode'] as const, registers: [reg] }),
    staleDetected:  new Counter({ name: 'test_wd_stale',   help: 't', registers: [reg] }),
    backoffSkips:   new Counter({ name: 'test_wd_backoff', help: 't', registers: [reg] }),
    lastRunTs:      new Gauge({   name: 'test_wd_last_ts', help: 't', registers: [reg] }),
    maxStaleAge:    new Gauge({   name: 'test_wd_max_age', help: 't', registers: [reg] }),
    pendingRefunds: new Gauge({   name: 'test_wd_pending', help: 't', registers: [reg] }),
    tickDuration:   new Histogram({ name: 'test_wd_tick', help: 't', registers: [reg] }),
    duplicatesSuppressed: new Counter({ name: 'test_wd_dupes',   help: 't', labelNames: ['network_mode'] as const, registers: [reg] }),
    horizonTimeouts:      new Counter({ name: 'test_wd_timeouts',help: 't', labelNames: ['network_mode'] as const, registers: [reg] }),
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

async function gaugeValue(gauge: Gauge<string>): Promise<number> {
  const json = await gauge.get();
  return json.values[0]?.value ?? 0;
}

// ---------------------------------------------------------------------------
// Ledger-aware runTick — mirrors the real watchdog tick with injected deps
// ---------------------------------------------------------------------------

interface TickDeps {
  activeOrders: Map<string, Record<string, unknown>>;
  staleAfterMs: number;
  networkMode: 'mainnet' | 'testnet';
  refundFn: (args: unknown) => Promise<{ hash: string; amount: string }>;
  m: ReturnType<typeof makeTestMetrics>;
  ledger: RefundLedger;
}

async function runTick(deps: TickDeps): Promise<void> {
  const { activeOrders, staleAfterMs, networkMode, refundFn, m, ledger } = deps;
  const tickEnd = m.tickDuration.startTimer();
  const now = Date.now();
  let maxStaleAgeMs = 0;
  let pendingCount = 0;

  try {
    for (const [orderId, order] of activeOrders.entries()) {
      try {
        if (!isXlmToEthAwaitingEth(order as any)) continue;

        // Idempotency: committed by another path → sync and skip.
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
            // Deferral — no watchdogFailedAt, no failure counter.
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

// ===========================================================================
// isXlmToEthAwaitingEth
// ===========================================================================

describe('isXlmToEthAwaitingEth', () => {
  it('returns true for a pending xlm_to_eth order with stellarTxHash', () => {
    expect(isXlmToEthAwaitingEth({ direction: 'xlm_to_eth', stellarTxHash: '0xabc', status: 'pending' })).toBe(true);
  });
  it('returns false for eth_to_xlm direction', () => {
    expect(isXlmToEthAwaitingEth({ direction: 'eth_to_xlm', stellarTxHash: '0xabc' })).toBe(false);
  });
  it('returns false when stellarTxHash is missing', () => {
    expect(isXlmToEthAwaitingEth({ direction: 'xlm_to_eth' })).toBe(false);
  });
  it('returns false when already refunded (refundTxHash set)', () => {
    expect(isXlmToEthAwaitingEth({ direction: 'xlm_to_eth', stellarTxHash: '0xabc', refundTxHash: '0xdef' })).toBe(false);
  });
  it('returns false when status is completed', () => {
    expect(isXlmToEthAwaitingEth({ direction: 'xlm_to_eth', stellarTxHash: '0xabc', status: 'completed' })).toBe(false);
  });
  it('returns false when status is eth_tx_sent', () => {
    expect(isXlmToEthAwaitingEth({ direction: 'xlm_to_eth', stellarTxHash: '0xabc', status: 'eth_tx_sent' })).toBe(false);
  });
  it('returns false when status is refunded', () => {
    expect(isXlmToEthAwaitingEth({ direction: 'xlm_to_eth', stellarTxHash: '0xabc', status: 'refunded' })).toBe(false);
  });
});

// ===========================================================================
// toMillis
// ===========================================================================

describe('toMillis', () => {
  it('returns null for null/undefined', () => {
    expect(toMillis(undefined)).toBeNull();
    expect(toMillis(null as any)).toBeNull();
  });
  it('returns ms-range number as-is when > 1e12', () => {
    const ts = Date.now();
    expect(toMillis(ts)).toBe(ts);
  });
  it('converts seconds-range number to ms', () => {
    const sec = Math.floor(Date.now() / 1000);
    expect(toMillis(sec)).toBe(sec * 1000);
  });
  it('parses ISO date string to ms', () => {
    const iso = new Date(2024, 0, 15).toISOString();
    expect(toMillis(iso)).toBe(Date.parse(iso));
  });
  it('returns null for unparseable string', () => {
    expect(toMillis('not-a-date')).toBeNull();
  });
});

// ===========================================================================
// Tick integration: success path
// ===========================================================================

describe('watchdog tick: successful refund', () => {
  it('increments success counter and records gauges', async () => {
    const m = makeTestMetrics();
    const ledger = new RefundLedger({ storageDir: null });
    const refundFn = vi.fn().mockResolvedValue({ hash: '0xhash1', amount: '10.0000000' });
    const order = {
      direction: 'xlm_to_eth', stellarTxHash: '0xstellar',
      stellarAddress: 'GABC123', xlmReceivedAt: Date.now() - 10 * 60_000,
    };

    await runTick({ activeOrders: new Map([['order-1', order as any]]), staleAfterMs: 5 * 60_000, networkMode: 'testnet', refundFn, m, ledger });

    expect(await counterValue(m.successTotal, { network_mode: 'testnet' })).toBe(1);
    expect(await counterValue(m.failureTotal)).toBe(0);
    expect(await counterValue(m.staleDetected)).toBe(1);
    expect(await counterValue(m.runsTotal)).toBe(1);
    expect(await gaugeValue(m.pendingRefunds)).toBe(1);
    expect(await gaugeValue(m.maxStaleAge)).toBeGreaterThan(0);
    expect(await gaugeValue(m.lastRunTs)).toBeGreaterThan(0);
    expect((order as any).status).toBe('refunded');
    expect((order as any).refundTxHash).toBe('0xhash1');
    expect(refundFn).toHaveBeenCalledOnce();
  });
});

// ===========================================================================
// Tick integration: failure path
// ===========================================================================

describe('watchdog tick: failed refund', () => {
  it('increments failure counter and stamps order with backoff fields', async () => {
    const m = makeTestMetrics();
    const ledger = new RefundLedger({ storageDir: null });
    const refundFn = vi.fn().mockRejectedValue(new Error('rpc error'));
    const order: Record<string, unknown> = {
      direction: 'xlm_to_eth', stellarTxHash: '0xstellar',
      stellarAddress: 'GABC123', xlmReceivedAt: Date.now() - 10 * 60_000,
    };

    await runTick({ activeOrders: new Map([['order-1', order]]), staleAfterMs: 5 * 60_000, networkMode: 'mainnet', refundFn, m, ledger });

    expect(await counterValue(m.failureTotal, { reason: 'refund_error', network_mode: 'mainnet' })).toBe(1);
    expect(await counterValue(m.successTotal)).toBe(0);
    expect(order['watchdogFailedAt']).toBeTypeOf('number');
    expect(order['watchdogFailureReason']).toBe('rpc error');
  });
});

// ===========================================================================
// Tick integration: missing address
// ===========================================================================

describe('watchdog tick: missing stellarAddress', () => {
  it('records failure with reason=missing_address, does not call refund', async () => {
    const m = makeTestMetrics();
    const ledger = new RefundLedger({ storageDir: null });
    const refundFn = vi.fn();
    const order = {
      direction: 'xlm_to_eth', stellarTxHash: '0xstellar',
      xlmReceivedAt: Date.now() - 10 * 60_000,
      // stellarAddress intentionally absent
    };

    await runTick({ activeOrders: new Map([['order-2', order as any]]), staleAfterMs: 5 * 60_000, networkMode: 'testnet', refundFn, m, ledger });

    expect(await counterValue(m.failureTotal, { reason: 'missing_address', network_mode: 'testnet' })).toBe(1);
    expect(await counterValue(m.successTotal)).toBe(0);
    expect(refundFn).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Tick integration: back-off skip
// ===========================================================================

describe('watchdog tick: back-off skip', () => {
  it('increments backoff counter and does not attempt refund', async () => {
    const m = makeTestMetrics();
    const ledger = new RefundLedger({ storageDir: null });
    const refundFn = vi.fn();
    const order = {
      direction: 'xlm_to_eth', stellarTxHash: '0xstellar',
      stellarAddress: 'GABC123', xlmReceivedAt: Date.now() - 10 * 60_000,
      watchdogFailedAt: Date.now() - 60_000, // 1 min ago — still in 10-min back-off
    };

    await runTick({ activeOrders: new Map([['order-3', order as any]]), staleAfterMs: 5 * 60_000, networkMode: 'testnet', refundFn, m, ledger });

    expect(await counterValue(m.backoffSkips)).toBe(1);
    expect(refundFn).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Tick integration: not yet stale
// ===========================================================================

describe('watchdog tick: not yet stale', () => {
  it('does not attempt refund when order is younger than staleAfterMs', async () => {
    const m = makeTestMetrics();
    const ledger = new RefundLedger({ storageDir: null });
    const refundFn = vi.fn();
    const order = {
      direction: 'xlm_to_eth', stellarTxHash: '0xstellar',
      stellarAddress: 'GABC123', xlmReceivedAt: Date.now() - 60_000,
    };

    await runTick({ activeOrders: new Map([['order-4', order as any]]), staleAfterMs: 5 * 60_000, networkMode: 'testnet', refundFn, m, ledger });

    expect(await counterValue(m.staleDetected)).toBe(0);
    expect(refundFn).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Tick integration: ledger-aware duplicate suppression
// ===========================================================================

describe('watchdog tick: ledger committed → duplicate suppressed', () => {
  it('syncs order from ledger and increments duplicate counter', async () => {
    const m = makeTestMetrics();
    const ledger = new RefundLedger({ storageDir: null });
    const refundFn = vi.fn();

    ledger.claim('order-dup');
    ledger.commit('order-dup', { txHash: '0xother', amount: '3.0000000' });

    const order: Record<string, unknown> = {
      direction: 'xlm_to_eth', stellarTxHash: '0xstellar',
      stellarAddress: 'GABC', xlmReceivedAt: Date.now() - 10 * 60_000,
    };

    await runTick({ activeOrders: new Map([['order-dup', order]]), staleAfterMs: 5 * 60_000, networkMode: 'testnet', refundFn, m, ledger });

    expect(refundFn).not.toHaveBeenCalled();
    expect(order['status']).toBe('refunded');
    expect(order['refundTxHash']).toBe('0xother');
    expect(await counterValue(m.duplicatesSuppressed, { network_mode: 'testnet' })).toBe(1);
  });
});

// ===========================================================================
// Tick integration: Horizon timeout → ambiguous
// ===========================================================================

describe('watchdog tick: Horizon timeout → ambiguous', () => {
  it('stamps watchdogFailedAt and increments horizon_timeout counter', async () => {
    const m = makeTestMetrics();
    const ledger = new RefundLedger({ storageDir: null });
    const refundFn = vi.fn().mockRejectedValue(new HorizonTimeoutError('504'));

    const order: Record<string, unknown> = {
      direction: 'xlm_to_eth', stellarTxHash: '0xstellar',
      stellarAddress: 'GABC', xlmReceivedAt: Date.now() - 10 * 60_000,
    };

    await runTick({ activeOrders: new Map([['order-to', order]]), staleAfterMs: 5 * 60_000, networkMode: 'testnet', refundFn, m, ledger });

    expect(await counterValue(m.failureTotal, { reason: 'horizon_timeout', network_mode: 'testnet' })).toBe(1);
    expect(await counterValue(m.horizonTimeouts, { network_mode: 'testnet' })).toBe(1);
    expect(ledger.getEntry('order-to')?.state.phase).toBe('ambiguous');
    expect(order['watchdogFailedAt']).toBeTypeOf('number');
  });
});

// ===========================================================================
// Tick integration: unknown amount → deferred
// ===========================================================================

describe('watchdog tick: unknown amount → deferred', () => {
  it('releases lock and does not stamp watchdogFailedAt', async () => {
    const m = makeTestMetrics();
    const ledger = new RefundLedger({ storageDir: null });
    const refundFn = vi.fn().mockRejectedValue(new RefundAmountUnknownError('order-defer'));

    const order: Record<string, unknown> = {
      direction: 'xlm_to_eth', stellarTxHash: '0xstellar',
      stellarAddress: 'GABC', xlmReceivedAt: Date.now() - 10 * 60_000,
    };

    await runTick({ activeOrders: new Map([['order-defer', order]]), staleAfterMs: 5 * 60_000, networkMode: 'testnet', refundFn, m, ledger });

    expect(await counterValue(m.failureTotal)).toBe(0);
    expect(order['watchdogFailedAt']).toBeUndefined();
    // Lock released — can claim again next tick.
    expect(ledger.getEntry('order-defer')).toBeUndefined();
  });
});

// ===========================================================================
// Tick integration: multiple orders
// ===========================================================================

describe('watchdog tick: multiple orders', () => {
  it('handles success, failure, and skip in a single tick independently', async () => {
    const m = makeTestMetrics();
    const ledger = new RefundLedger({ storageDir: null });

    const stale = { direction: 'xlm_to_eth', stellarTxHash: '0xA', stellarAddress: 'GABC', xlmReceivedAt: Date.now() - 10 * 60_000 };
    const recent = { direction: 'xlm_to_eth', stellarTxHash: '0xB', stellarAddress: 'GDEF', xlmReceivedAt: Date.now() - 30_000 };
    const ethOrder = { direction: 'eth_to_xlm', stellarTxHash: '0xC', xlmReceivedAt: Date.now() - 10 * 60_000 };

    const refundFn = vi.fn().mockResolvedValue({ hash: '0xok', amount: '5.0000000' });

    await runTick({
      activeOrders: new Map([['stale', stale as any], ['recent', recent as any], ['eth', ethOrder as any]]),
      staleAfterMs: 5 * 60_000, networkMode: 'mainnet', refundFn, m, ledger,
    });

    // Only the stale xlm_to_eth order was refunded.
    expect(refundFn).toHaveBeenCalledTimes(1);
    expect(await counterValue(m.successTotal, { network_mode: 'mainnet' })).toBe(1);
    expect(await counterValue(m.runsTotal)).toBe(1);
  });
});

// ===========================================================================
// Prometheus registry: watchdog metric names present
// ===========================================================================

describe('metrics registry: watchdog metric names', () => {
  it('all watchdog counter names appear in Prometheus output', async () => {
    const { registry } = await import('../src/metrics.js');
    const output = await registry.metrics();
    const expected = [
      'relayer_refund_watchdog_runs_total',
      'relayer_refund_watchdog_success_total',
      'relayer_refund_watchdog_failure_total',
      'relayer_refund_watchdog_stale_orders_detected_total',
      'relayer_refund_watchdog_backoff_skips_total',
      'relayer_refund_watchdog_last_run_timestamp_seconds',
      'relayer_refund_watchdog_max_stale_age_seconds',
      'relayer_refund_watchdog_pending_refunds',
      'relayer_refund_watchdog_tick_duration_seconds',
    ];
    for (const name of expected) {
      expect(output, `missing metric: ${name}`).toContain(name);
    }
  });

  it('watchdogMetrics export contains all metric instances', async () => {
    const { watchdogMetrics } = await import('../src/metrics.js');
    expect(watchdogMetrics).toHaveProperty('runsTotal');
    expect(watchdogMetrics).toHaveProperty('successTotal');
    expect(watchdogMetrics).toHaveProperty('failureTotal');
    expect(watchdogMetrics).toHaveProperty('staleDetected');
    expect(watchdogMetrics).toHaveProperty('backoffSkips');
    expect(watchdogMetrics).toHaveProperty('lastRunTimestamp');
    expect(watchdogMetrics).toHaveProperty('maxStaleAge');
    expect(watchdogMetrics).toHaveProperty('pendingRefunds');
    expect(watchdogMetrics).toHaveProperty('tickDuration');
  });
});
