/**
 * Relayer load tests for concurrent order processing (issue #1088).
 *
 * Deterministic: fake timers + seeded workload, mock RPC only — no private
 * keys or public endpoints.  Set LOAD_REPORT=1 to print the measurement
 * tables used in docs/load-testing.md:
 *
 *   LOAD_REPORT=1 pnpm --filter @wafflefinance/relayer test:load
 */
import { vi } from 'vitest';

vi.hoisted(() => {
  process.env.LOG_LEVEL = 'silent';
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runLoad, deterministicView, type LoadConfig, type LoadReport } from './harness.js';

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms).then(() => undefined);

const BASE: LoadConfig = {
  seed: 1088,
  orders: 200,
  arrivalIntervalMs: 5,
  refundRatio: 0.3,
  concurrency: 8,
  maxQueueDepth: 50,
  rpcQuota: 16,
};

const report = (title: string, rows: Array<Record<string, unknown>>) => {
  if (process.env.LOAD_REPORT) {
    // eslint-disable-next-line no-console
    console.log(`\n${title}`);
    // eslint-disable-next-line no-console
    console.table(rows);
  }
};

const summarize = (label: Record<string, unknown>, r: LoadReport) => ({
  ...label,
  'orders/s': r.throughputOrdersPerSec,
  'p95 ms': r.p95CompletionMs,
  'rpc/order': r.rpcCallsPerOrder,
  '429s': r.rateLimited,
  'peak queue': r.peakQueueDepth,
  'peak running': r.peakRunning,
  'peak blocked': r.peakBlockedProducers,
  rejected: r.rejectedSubmissions,
  failed: r.failedOrders,
  'nonce gaps': r.nonceGaps,
  'heap MB': +(r.heapGrowthBytes / 1024 / 1024).toFixed(1),
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('relayer order load harness', () => {
  it('is reproducible: the same seed yields identical measurements', async () => {
    const a = await runLoad(BASE, advance);
    vi.setSystemTime(0);
    const b = await runLoad(BASE, advance);
    expect(deterministicView(b)).toEqual(deterministicView(a));

    vi.setSystemTime(0);
    const c = await runLoad({ ...BASE, seed: 7 }, advance);
    expect(deterministicView(c)).not.toEqual(deterministicView(a));
  });

  it('processes a mixed lock / claim / refund workload with unique, gap-free nonces', async () => {
    const r = await runLoad(BASE, advance);
    report('baseline', [summarize({ concurrency: BASE.concurrency }, r)]);

    expect(r.completedOrders).toBe(BASE.orders);
    expect(r.failedOrders).toBe(0);
    expect(r.actions.lock).toBe(BASE.orders);
    expect(r.actions.claim + r.actions.refund).toBe(BASE.orders);
    expect(r.actions.claim).toBeGreaterThan(0);
    expect(r.actions.refund).toBeGreaterThan(0);

    // Every action signs exactly one tx; retries reuse their nonce.
    expect(r.noncesAccepted).toBe(BASE.orders * 2);
    expect(r.nonceRejections).toBe(0);
    expect(r.nonceGaps).toBe(0);

    // Within quota there are no 429s, so RPC cost per order is the floor:
    // lock 3 + claim 3 (or refund 4).
    expect(r.rateLimited).toBe(0);
    expect(r.rpcCallsPerOrder).toBeCloseTo(6 + r.actions.refund / BASE.orders, 2);
    expect(r.maxRpcCallsPerOrder).toBe(7);
  });

  it('never runs more jobs or RPC requests than the configured concurrency', async () => {
    for (const concurrency of [1, 4, 12]) {
      vi.setSystemTime(0);
      const r = await runLoad({ ...BASE, concurrency, orders: 120 }, advance);
      expect(r.completedOrders).toBe(120);
      expect(r.peakRunning).toBeLessThanOrEqual(concurrency);
      expect(r.peakRpcInFlight).toBeLessThanOrEqual(concurrency);
    }
  });

  it('applies backpressure instead of unbounded queue growth when a burst exceeds the limits', async () => {
    const burst: LoadConfig = { ...BASE, orders: 600, arrivalIntervalMs: 0, maxQueueDepth: 25 };
    const bounded = await runLoad(burst, advance);

    vi.setSystemTime(0);
    const unbounded = await runLoad({ ...burst, maxQueueDepth: 1_000_000 }, advance);

    report('burst of 600 orders, concurrency 8', [
      summarize({ maxQueueDepth: 25 }, bounded),
      summarize({ maxQueueDepth: '1e6 (effectively unbounded)' }, unbounded),
    ]);

    // With the cap: the queue stays bounded (retries of admitted jobs may add
    // at most one entry per running slot) and producers are pushed back.
    expect(bounded.peakQueueDepth).toBeLessThanOrEqual(25 + burst.concurrency);
    expect(bounded.rejectedSubmissions).toBeGreaterThan(0);
    expect(bounded.peakBlockedProducers).toBeGreaterThan(0);
    expect(bounded.completedOrders).toBe(600);
    expect(bounded.failedOrders).toBe(0);

    // Without it the whole burst lands in memory at once.
    expect(unbounded.peakQueueDepth).toBeGreaterThanOrEqual(600 - burst.concurrency);
    expect(unbounded.rejectedSubmissions).toBe(0);

    // Backpressure moves waiting out of the queue, not out of the system:
    // throughput is the same either way.
    expect(bounded.throughputOrdersPerSec).toBeGreaterThanOrEqual(
      unbounded.throughputOrdersPerSec * 0.9,
    );
  });

  it('exceeding the RPC quota produces 429s and inflates RPC calls per order', async () => {
    const within = await runLoad({ ...BASE, concurrency: 8, rpcQuota: 8 }, advance);
    vi.setSystemTime(0);
    const over = await runLoad({ ...BASE, concurrency: 24, rpcQuota: 8 }, advance);

    report('rpc quota 8', [
      summarize({ concurrency: 8 }, within),
      summarize({ concurrency: 24 }, over),
    ]);

    expect(within.rateLimited).toBe(0);
    expect(over.rateLimited).toBeGreaterThan(0);
    expect(over.inActionRetries).toBeGreaterThan(0);
    expect(over.rpcCallsPerOrder).toBeGreaterThan(within.rpcCallsPerOrder);
    // Over-subscribing the quota buys no throughput.
    expect(over.throughputOrdersPerSec).toBeLessThanOrEqual(within.throughputOrdersPerSec * 1.1);
    // Over the quota, retries run out and orders fail outright, even though
    // nonces are still never reused (a retried job keeps its nonce).
    expect(within.failedOrders).toBe(0);
    expect(within.nonceGaps).toBe(0);
    expect(over.failedOrders).toBeGreaterThan(0);
    expect(over.nonceRejections).toBe(0);
  });

  it('keeps the job registry bounded by maxRetainedJobs', async () => {
    const r = await runLoad({ ...BASE, orders: 300, maxRetainedJobs: 100 }, advance);
    expect(r.completedOrders).toBe(300);
    expect(r.registrySize).toBeLessThanOrEqual(100);
  });

  it('measures throughput and latency across concurrency levels (rpc quota 16)', async () => {
    const rows: Array<Record<string, unknown>> = [];
    const results = new Map<number, LoadReport>();
    for (const concurrency of [1, 2, 4, 8, 16, 32]) {
      vi.setSystemTime(0);
      const r = await runLoad(
        { ...BASE, orders: 300, arrivalIntervalMs: 2, concurrency, rpcQuota: 16, maxQueueDepth: 100 },
        advance,
      );
      results.set(concurrency, r);
      rows.push(summarize({ concurrency }, r));
    }
    report('concurrency sweep: 300 orders, arrival every 2 ms, rpc quota 16', rows);

    const at = (c: number) => results.get(c)!;
    // Throughput scales with concurrency up to the quota…
    expect(at(2).throughputOrdersPerSec).toBeGreaterThan(at(1).throughputOrdersPerSec * 1.5);
    expect(at(8).throughputOrdersPerSec).toBeGreaterThan(at(4).throughputOrdersPerSec * 1.5);
    expect(at(16).rateLimited).toBe(0);
    // …and past it the extra slots only generate 429s.
    expect(at(32).rateLimited).toBeGreaterThan(0);
    expect(at(32).rpcCallsPerOrder).toBeGreaterThan(at(16).rpcCallsPerOrder);
    for (const r of results.values()) expect(r.completedOrders + r.failedOrders).toBe(300);
  });
});
