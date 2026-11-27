/**
 * @file work-limiter.ts
 *
 * Bounded retry and concurrency budgets for resolver event handlers
 * (issue #1096).
 *
 * Listener event sources and their existing retry behavior:
 *
 *   - Ethereum (`listeners/ethereum.ts`) — viem `watchContractEvent`
 *     subscriptions.  Reconnects and reorgs can re-deliver the same log.
 *   - Soroban (`listeners/soroban.ts`) — cursor-based polling.  A poll that
 *     fails after partially dispatching a page re-reads from the persisted
 *     cursor, so the page's events are dispatched again.
 *   - Supervisor restarts (`supervisor.ts`) replay from the last cursor too.
 *   - RPC calls inside handlers go through `retry.ts` (`withRetry`, 5 attempts
 *     with exponential backoff) — a per-CALL budget, not a per-order one.
 *
 * Nothing above bounded how many times one order's handler could run, or how
 * many handlers could hit RPC/signing at once.  `ResolverWorkLimiter` sits in
 * front of every handler and enforces:
 *
 *   1. **Per-order deduplication.**  Work is keyed by `chain:action:orderId`.
 *      An identical key already running is absorbed (the running attempt
 *      covers it); one that completed successfully within `dedupTtlMs` is
 *      absorbed.  Failures are NOT remembered as completed, so a legitimate
 *      retry still runs.
 *   2. **Per-order attempt budget.**  At most `maxAttemptsPerOrder` handler
 *      executions per key in any `attemptWindowMs`.  Budgets are per action,
 *      so a burst of `order_created` replays can never use up the budget of a
 *      time-sensitive claim or refund for the same order.
 *   3. **Per-chain concurrency.**  At most `maxConcurrentPerChain` handlers
 *      run per chain; excess work is queued (deferred) up to
 *      `maxQueuedPerChain`, then rejected.  Settlement actions (claim/refund)
 *      jump the queue so backpressure from new-order bursts never delays them.
 *      Chains have independent slots — one chain's backlog never blocks
 *      another's.
 *
 * Every refusal is counted in metrics (`resolver_work_rejected_total`,
 * `resolver_work_deduplicated_total`, `resolver_work_deferred_total`).
 */

import type { Logger } from "pino";
import {
  workDeduplicatedTotal,
  workDeferredTotal,
  workInFlight,
  workQueueDepth,
  workRejectedTotal,
} from "./metrics.js";

export interface WorkKey {
  chain: string;
  action: string;
  orderId?: string;
}

export type WorkOutcome<T> =
  | { status: "completed"; value: T }
  | { status: "deduplicated"; reason: "in_flight" | "recently_completed" }
  | { status: "rejected"; reason: "order_budget_exhausted" | "queue_full" };

export interface WorkLimiterOptions {
  log?: Logger;
  /** Handlers allowed to run at once per chain.  Default 4. */
  maxConcurrentPerChain?: number;
  /** Handlers allowed to wait for a slot per chain.  Default 256. */
  maxQueuedPerChain?: number;
  /** Handler executions allowed per work key within `attemptWindowMs`.  Default 5. */
  maxAttemptsPerOrder?: number;
  /** Sliding window for the per-order attempt budget.  Default 60s. */
  attemptWindowMs?: number;
  /** How long a successful completion absorbs identical work.  Default 30s. */
  dedupTtlMs?: number;
  /** Actions that skip ahead of queued work.  Default: settlement actions. */
  priorityActions?: Iterable<string>;
  /** Injectable clock for tests. */
  now?: () => number;
}

export const DEFAULT_PRIORITY_ACTIONS = [
  "claim",
  "refund",
  "order_claimed",
  "order_refunded",
] as const;

interface ChainSlots {
  active: number;
  queue: Array<{ priority: boolean; start: () => void }>;
}

export class ResolverWorkLimiter {
  private readonly log?: Logger;
  private readonly maxConcurrent: number;
  private readonly maxQueued: number;
  private readonly maxAttempts: number;
  private readonly attemptWindowMs: number;
  private readonly dedupTtlMs: number;
  private readonly priority: Set<string>;
  private readonly now: () => number;

  private readonly inFlight = new Map<string, Promise<WorkOutcome<unknown>>>();
  private readonly completedAt = new Map<string, number>();
  private readonly attempts = new Map<string, number[]>();
  private readonly chains = new Map<string, ChainSlots>();

  constructor(opts: WorkLimiterOptions = {}) {
    this.log = opts.log?.child({ component: "ResolverWorkLimiter" });
    this.maxConcurrent = positiveInt(opts.maxConcurrentPerChain ?? 4, "maxConcurrentPerChain");
    this.maxQueued = nonNegativeInt(opts.maxQueuedPerChain ?? 256, "maxQueuedPerChain");
    this.maxAttempts = positiveInt(opts.maxAttemptsPerOrder ?? 5, "maxAttemptsPerOrder");
    this.attemptWindowMs = opts.attemptWindowMs ?? 60_000;
    this.dedupTtlMs = opts.dedupTtlMs ?? 30_000;
    this.priority = new Set(opts.priorityActions ?? DEFAULT_PRIORITY_ACTIONS);
    this.now = opts.now ?? Date.now;
  }

  /**
   * Run `fn` under the limiter.  Resolves with the outcome; rejects only when
   * `fn` itself throws (so callers keep their existing error handling).
   * `opts.remember` decides whether a successful result absorbs identical
   * work for `dedupTtlMs` (default: always).
   */
  run<T>(
    key: WorkKey,
    fn: () => Promise<T>,
    opts: { remember?: (value: T) => boolean } = {}
  ): Promise<WorkOutcome<T>> {
    const dedupKey = key.orderId !== undefined ? `${key.chain}:${key.action}:${key.orderId}` : null;

    if (dedupKey) {
      this.prune(dedupKey);

      if (this.inFlight.has(dedupKey)) {
        return Promise.resolve(this.dedup(key, "in_flight"));
      }
      const done = this.completedAt.get(dedupKey);
      if (done !== undefined && this.now() - done < this.dedupTtlMs) {
        return Promise.resolve(this.dedup(key, "recently_completed"));
      }
      const history = this.attempts.get(dedupKey) ?? [];
      if (history.length >= this.maxAttempts) {
        workRejectedTotal.inc({ chain: key.chain, reason: "order_budget_exhausted" });
        this.log?.warn(
          { ...key, attempts: history.length, windowMs: this.attemptWindowMs },
          "order attempt budget exhausted — dropping repeated work"
        );
        return Promise.resolve({ status: "rejected", reason: "order_budget_exhausted" });
      }
    }

    const slots = this.slotsFor(key.chain);
    const mustQueue = slots.active >= this.maxConcurrent;
    if (mustQueue && slots.queue.length >= this.maxQueued) {
      workRejectedTotal.inc({ chain: key.chain, reason: "queue_full" });
      this.log?.warn({ ...key, queued: slots.queue.length }, "work queue full — rejecting work");
      return Promise.resolve({ status: "rejected", reason: "queue_full" });
    }

    const execution = new Promise<WorkOutcome<T>>((resolve, reject) => {
      const start = () => {
        slots.active++;
        this.publish(key.chain);
        if (dedupKey) {
          const h = this.attempts.get(dedupKey) ?? [];
          h.push(this.now());
          this.attempts.set(dedupKey, h);
        }
        let result: Promise<T>;
        try {
          result = fn();
        } catch (err) {
          result = Promise.reject(err);
        }
        result.then(
          (value) => {
            // Only successful work that actually did something absorbs replays;
            // e.g. work skipped for ineligibility must be able to run again.
            if (dedupKey && (opts.remember?.(value) ?? true)) {
              this.completedAt.set(dedupKey, this.now());
            }
            this.release(key.chain);
            resolve({ status: "completed", value });
          },
          (err) => {
            this.release(key.chain);
            reject(err);
          }
        );
      };

      if (mustQueue) {
        const entry = { priority: this.priority.has(key.action), start };
        if (entry.priority) {
          // Insert after any priority work already waiting, ahead of the rest.
          const idx = slots.queue.findIndex((q) => !q.priority);
          if (idx === -1) slots.queue.push(entry);
          else slots.queue.splice(idx, 0, entry);
        } else {
          slots.queue.push(entry);
        }
        workDeferredTotal.inc({ chain: key.chain });
        this.publish(key.chain);
      } else {
        start();
      }
    });

    if (dedupKey) {
      this.inFlight.set(dedupKey, execution as Promise<WorkOutcome<unknown>>);
      const clear = () => {
        if (this.inFlight.get(dedupKey) === execution) this.inFlight.delete(dedupKey);
      };
      execution.then(clear, clear);
    }
    return execution;
  }

  /** Current per-chain load, for diagnostics and tests. */
  load(chain: string): { active: number; queued: number } {
    const s = this.chains.get(chain);
    return { active: s?.active ?? 0, queued: s?.queue.length ?? 0 };
  }

  private dedup(key: WorkKey, reason: "in_flight" | "recently_completed"): WorkOutcome<never> {
    workDeduplicatedTotal.inc({ chain: key.chain, reason });
    this.log?.debug({ ...key, reason }, "duplicate work absorbed");
    return { status: "deduplicated", reason };
  }

  private slotsFor(chain: string): ChainSlots {
    let s = this.chains.get(chain);
    if (!s) {
      s = { active: 0, queue: [] };
      this.chains.set(chain, s);
    }
    return s;
  }

  private release(chain: string): void {
    const slots = this.slotsFor(chain);
    slots.active--;
    const next = slots.queue.shift();
    if (next) next.start();
    this.publish(chain);
  }

  private publish(chain: string): void {
    const s = this.slotsFor(chain);
    workInFlight.set({ chain }, s.active);
    workQueueDepth.set({ chain }, s.queue.length);
  }

  /** Drop expired history for one key, and opportunistically bound map sizes. */
  private prune(dedupKey: string): void {
    const now = this.now();
    const h = this.attempts.get(dedupKey);
    if (h) {
      const fresh = h.filter((t) => now - t < this.attemptWindowMs);
      if (fresh.length) this.attempts.set(dedupKey, fresh);
      else this.attempts.delete(dedupKey);
    }
    if (this.completedAt.size > 10_000) {
      for (const [k, t] of this.completedAt) if (now - t >= this.dedupTtlMs) this.completedAt.delete(k);
    }
    if (this.attempts.size > 10_000) {
      for (const [k, ts] of this.attempts) {
        if (ts.every((t) => now - t >= this.attemptWindowMs)) this.attempts.delete(k);
      }
    }
  }
}

function positiveInt(v: number, name: string): number {
  if (!Number.isInteger(v) || v < 1) throw new RangeError(`${name} must be a positive integer, got ${v}`);
  return v;
}

function nonNegativeInt(v: number, name: string): number {
  if (!Number.isInteger(v) || v < 0) throw new RangeError(`${name} must be a non-negative integer, got ${v}`);
  return v;
}

/** Read limiter options from the environment (all optional). */
export function workLimiterOptionsFromEnv(env: NodeJS.ProcessEnv): WorkLimiterOptions {
  const num = (name: string): number | undefined => {
    const raw = env[name];
    if (raw === undefined || raw === "") return undefined;
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new RangeError(`${name} must be a number, got "${raw}"`);
    return n;
  };
  return {
    maxConcurrentPerChain: num("RESOLVER_MAX_CONCURRENT_PER_CHAIN"),
    maxQueuedPerChain: num("RESOLVER_MAX_QUEUED_PER_CHAIN"),
    maxAttemptsPerOrder: num("RESOLVER_MAX_ATTEMPTS_PER_ORDER"),
    attemptWindowMs: num("RESOLVER_ORDER_ATTEMPT_WINDOW_MS"),
    dedupTtlMs: num("RESOLVER_DEDUP_TTL_MS"),
  };
}
