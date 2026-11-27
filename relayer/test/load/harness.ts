/**
 * @fileoverview Concurrent order-processing load harness (issue #1088).
 *
 * Drives the real `JobManagerService` (priority queue + concurrency limiter +
 * retry queue) with a seeded workload of mixed lock / claim / refund actions
 * against `MockRpc`.  Every run is deterministic for a given config: timing
 * comes from fake timers, randomness from a seeded PRNG.
 *
 * Order lifecycle modelled per order:
 *   lock  (live_settlement, P0): estimateGas → sendRawTransaction → receipt
 *   then either
 *   claim (live_settlement, P0): eth_call → sendRawTransaction → receipt
 *   or
 *   refund (recovery, P1):       eth_call → getBlock → sendRawTransaction → receipt
 *
 * Producers honour backpressure: on `QueueFullError` they park on
 * `whenCapacityAvailable()` instead of growing the queue.
 */

import {
  JobManagerService,
  QueueFullError,
  type Job,
  type ConcurrencyLimits,
  type JobType,
  type JobPriority,
} from '../../src/services/job-manager/index.js';
import { KeyedMutex } from '../../src/utils/concurrency.js';
import { MockRpc, RpcRateLimitError, seededRng, type MockRpcOptions } from './mock-rpc.js';

export type OrderAction = 'lock' | 'claim' | 'refund';

export interface LoadConfig {
  seed: number;
  orders: number;
  /** Virtual ms between order arrivals. 0 = everything arrives at once. */
  arrivalIntervalMs: number;
  /** Fraction of orders that end in a refund instead of a claim. */
  refundRatio: number;
  /** Global concurrent job cap (per-type / per-priority caps derive from it). */
  concurrency: number;
  maxQueueDepth: number;
  /** Provider concurrency quota for the mock RPC. */
  rpcQuota: number;
  rpcLatencyMs?: MockRpcOptions['latencyMs'];
  rpcJitterMs?: number;
  /** In-action retries on 429 before failing the job attempt. */
  rpcRetries?: number;
  rpcRetryBaseMs?: number;
  /** Job-level retries (JobManager retry queue) after an attempt fails. */
  jobMaxRetries?: number;
  tickIntervalMs?: number;
  maxRetainedJobs?: number;
}

export interface LoadReport {
  orders: number;
  completedOrders: number;
  failedOrders: number;
  actions: Record<OrderAction, number>;
  makespanMs: number;
  throughputOrdersPerSec: number;
  p50CompletionMs: number;
  p95CompletionMs: number;
  maxCompletionMs: number;
  totalRpcCalls: number;
  rpcCallsPerOrder: number;
  maxRpcCallsPerOrder: number;
  rateLimited: number;
  inActionRetries: number;
  jobRetries: number;
  peakQueueDepth: number;
  peakRunning: number;
  peakRpcInFlight: number;
  rejectedSubmissions: number;
  peakBlockedProducers: number;
  nonceRejections: number;
  nonceGaps: number;
  noncesAccepted: number;
  registrySize: number;
  /** Real (non-deterministic) heap growth across the run, in bytes. */
  heapGrowthBytes: number;
}

/** Advances (fake) time by `ms`, flushing timers and microtasks. */
export type AdvanceFn = (ms: number) => Promise<void>;

const SIGNER = '0xRelayerSigner';

export function limitsFor(concurrency: number): Partial<ConcurrencyLimits> {
  const recovery = Math.max(1, Math.ceil(concurrency / 2));
  return {
    global: concurrency,
    byType: {
      live_settlement: concurrency,
      recovery,
      cleanup: 1,
      maintenance: 1,
      batch: 1,
      reconciliation: 1,
    },
    byPriority: { 0: concurrency, 1: recovery, 2: 1, 3: 1 },
  };
}

interface OrderPlan {
  id: string;
  arrivalMs: number;
  followUp: 'claim' | 'refund';
}

/** Build the deterministic workload for `cfg`. */
export function buildWorkload(cfg: LoadConfig): OrderPlan[] {
  const rng = seededRng(cfg.seed ^ 0x9e3779b9);
  return Array.from({ length: cfg.orders }, (_, i) => ({
    id: `order-${i.toString().padStart(5, '0')}`,
    arrivalMs: i * cfg.arrivalIntervalMs,
    followUp: rng() < cfg.refundRatio ? 'refund' : 'claim',
  }));
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Run one load scenario.  `advance` must move fake time forward; the harness
 * keeps calling it until every order settles or `maxVirtualMs` elapses.
 */
export async function runLoad(
  cfg: LoadConfig,
  advance: AdvanceFn,
  opts: { stepMs?: number; maxVirtualMs?: number } = {},
): Promise<LoadReport> {
  const stepMs = opts.stepMs ?? 10;
  const maxVirtualMs = opts.maxVirtualMs ?? 10 * 60_000;
  const rpcRetries = cfg.rpcRetries ?? 3;
  const rpcRetryBaseMs = cfg.rpcRetryBaseMs ?? 25;

  const rpc = new MockRpc({
    maxConcurrentRequests: cfg.rpcQuota,
    latencyMs: cfg.rpcLatencyMs,
    jitterMs: cfg.rpcJitterMs,
    rng: seededRng(cfg.seed),
  });
  const jm = new JobManagerService({
    limits: limitsFor(cfg.concurrency),
    tickIntervalMs: cfg.tickIntervalMs ?? 50,
    maxQueueDepth: cfg.maxQueueDepth,
    maxRetainedJobs: cfg.maxRetainedJobs,
  });

  // ── Nonce allocation (mirrors a production nonce manager) ───────────────
  const nonceMutex = new KeyedMutex();
  let nextNonce = 0;
  const allocatedNonces = new Map<string, number>(); // jobId → nonce
  const allocateNonce = (jobId: string) =>
    nonceMutex.runExclusive(SIGNER, async () => {
      // A retried job reuses its nonce so retries never leave gaps.
      const existing = allocatedNonces.get(jobId);
      if (existing !== undefined) return existing;
      const n = nextNonce++;
      allocatedNonces.set(jobId, n);
      return n;
    });

  // ── Observations ────────────────────────────────────────────────────────
  let running = 0;
  let peakRunning = 0;
  let peakQueueDepth = 0;
  let blocked = 0;
  let peakBlocked = 0;
  let inActionRetries = 0;
  let jobRetries = 0;
  const actions: Record<OrderAction, number> = { lock: 0, claim: 0, refund: 0 };
  const completionMs: number[] = [];
  let completedOrders = 0;
  let failedOrders = 0;
  let settledOrders = 0;

  const queueDepth = () => {
    const c = jm.getPendingCount();
    return c[0] + c[1] + c[2] + c[3];
  };
  const sample = () => {
    peakQueueDepth = Math.max(peakQueueDepth, queueDepth());
  };

  // ── RPC with bounded retry on 429 ───────────────────────────────────────
  async function withRpcRetry<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (!(err instanceof RpcRateLimitError) || attempt >= rpcRetries) throw err;
        inActionRetries++;
        await sleep(rpcRetryBaseMs * 2 ** attempt);
      }
    }
  }

  async function perform(job: Job): Promise<void> {
    const orderId = job.payload.orderId as string;
    const action = job.payload.action as OrderAction;
    const call = (m: Parameters<MockRpc['request']>[0]) => withRpcRetry(() => rpc.request(m, orderId));

    if (action === 'lock') await call('eth_estimateGas');
    else await call('eth_call');
    if (action === 'refund') await call('eth_getBlockByNumber');

    const nonce = await allocateNonce(job.id);
    await withRpcRetry(() => rpc.sendRawTransaction({ from: SIGNER, nonce, orderId, action }));
    await call('eth_getTransactionReceipt');
  }

  // ── Job completion plumbing ─────────────────────────────────────────────
  const waiters = new Map<string, (ok: boolean) => void>();
  const executor = async (job: Job): Promise<unknown> => {
    running++;
    peakRunning = Math.max(peakRunning, running);
    try {
      await perform(job);
      actions[job.payload.action as OrderAction]++;
      jobRetries += job.retryCount;
      waiters.get(job.id)?.(true);
      waiters.delete(job.id);
      return undefined;
    } catch (err) {
      if (job.retryCount >= job.maxRetries) {
        jobRetries += job.retryCount;
        waiters.get(job.id)?.(false);
        waiters.delete(job.id);
      }
      throw err;
    } finally {
      running--;
    }
  };
  jm.registerExecutor('live_settlement', executor);
  jm.registerExecutor('recovery', executor);

  async function submitAndWait(orderId: string, action: OrderAction): Promise<boolean> {
    const type: JobType = action === 'refund' ? 'recovery' : 'live_settlement';
    const priority: JobPriority = action === 'refund' ? 1 : 0;
    const job: Job = {
      id: `${orderId}:${action}`,
      type,
      priority,
      status: 'pending',
      payload: { orderId, action },
      createdAt: Date.now(),
      retryCount: 0,
      maxRetries: cfg.jobMaxRetries ?? 2,
    };
    const done = new Promise<boolean>((resolve) => waiters.set(job.id, resolve));
    for (;;) {
      try {
        await jm.submitJob({ ...job, createdAt: Date.now() });
        break;
      } catch (err) {
        if (!(err instanceof QueueFullError)) throw err;
        blocked++;
        peakBlocked = Math.max(peakBlocked, blocked);
        await jm.whenCapacityAvailable();
        blocked--;
      }
    }
    sample();
    return done;
  }

  async function drive(order: OrderPlan): Promise<void> {
    const arrived = Date.now();
    const ok =
      (await submitAndWait(order.id, 'lock')) && (await submitAndWait(order.id, order.followUp));
    if (ok) {
      completedOrders++;
      completionMs.push(Date.now() - arrived);
    } else {
      failedOrders++;
    }
    settledOrders++;
  }

  // ── Run ─────────────────────────────────────────────────────────────────
  const plan = buildWorkload(cfg);
  const heapStart = process.memoryUsage().heapUsed;
  let heapPeak = heapStart;
  const startMs = Date.now();
  jm.start();
  const sampler = setInterval(() => {
    sample();
    heapPeak = Math.max(heapPeak, process.memoryUsage().heapUsed);
  }, 5);

  for (const order of plan) {
    setTimeout(() => void drive(order), order.arrivalMs);
  }

  let elapsed = 0;
  while (settledOrders < plan.length && elapsed < maxVirtualMs) {
    await advance(stepMs);
    elapsed += stepMs;
  }
  const makespanMs = Date.now() - startMs;
  clearInterval(sampler);
  jm.stop();

  const accepted = rpc.acceptedNonces(SIGNER);
  const nonceGaps = accepted.length === 0 ? 0 : accepted[accepted.length - 1] + 1 - accepted.length;
  const sorted = [...completionMs].sort((a, b) => a - b);
  const perOrder = [...rpc.callsByOrder.values()];

  return {
    orders: plan.length,
    completedOrders,
    failedOrders,
    actions,
    makespanMs,
    throughputOrdersPerSec: makespanMs > 0 ? +(completedOrders / (makespanMs / 1000)).toFixed(2) : 0,
    p50CompletionMs: percentile(sorted, 50),
    p95CompletionMs: percentile(sorted, 95),
    maxCompletionMs: sorted[sorted.length - 1] ?? 0,
    totalRpcCalls: rpc.totalCalls,
    rpcCallsPerOrder: plan.length > 0 ? +(rpc.totalCalls / plan.length).toFixed(2) : 0,
    maxRpcCallsPerOrder: perOrder.length > 0 ? Math.max(...perOrder) : 0,
    rateLimited: rpc.rateLimited,
    inActionRetries,
    jobRetries,
    peakQueueDepth,
    peakRunning,
    peakRpcInFlight: rpc.peakInFlight,
    rejectedSubmissions: jm.getRejectedCount(),
    peakBlockedProducers: peakBlocked,
    nonceRejections: rpc.nonceRejections,
    nonceGaps,
    noncesAccepted: accepted.length,
    registrySize: jm.getTotalCount(),
    heapGrowthBytes: heapPeak - heapStart,
  };
}

/** The report minus fields that legitimately vary between runs. */
export function deterministicView(r: LoadReport): Omit<LoadReport, 'heapGrowthBytes'> {
  const { heapGrowthBytes: _ignored, ...rest } = r;
  return rest;
}
