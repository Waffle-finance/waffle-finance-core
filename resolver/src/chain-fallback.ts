/**
 * @file chain-fallback.ts
 *
 * Fallback policy for a resolver operating in a cross-chain topology where
 * one or more chains may be degraded at the same time.
 *
 * ## Design goals
 *
 * 1. **Operators always know what to do.**  Every degraded state maps to a
 *    clear, named action: `hold`, `retry`, or `suspend`.
 * 2. **No runaway loops.**  A chain that is persistently unreachable stops
 *    being retried immediately and is marked suspended until it recovers.
 * 3. **Independent per-chain tracking.**  Ethereum going down does not force
 *    Soroban into suspension and vice versa.
 * 4. **Safe by default.**  When a chain is suspended the resolver stops
 *    issuing any action that depends on it, but continues watching the other
 *    chains and processing events where it can.
 *
 * ## State machine (per chain)
 *
 *   healthy  ──failure──▶  degraded  ──threshold──▶  suspended
 *      ▲                      │                          │
 *      └──────────recover──────┘◀─────────recover────────┘
 *
 * - **healthy**   — chain is responding normally; no action needed.
 * - **degraded**  — one or more recent failures, but below the suspension
 *                   threshold.  Resolver retries with backoff.  Operator
 *                   action: monitor; no intervention needed yet.
 * - **suspended** — consecutive failure count has reached
 *                   `suspendAfterConsecutiveFailures`.  Resolver stops
 *                   sending actions on this chain until recovery is confirmed.
 *                   Operator action: check RPC endpoint; manually call
 *                   `reportSuccess(chain)` once connectivity is restored, or
 *                   wait for the next successful poll to auto-recover.
 *
 * ## Operational policy summary
 *
 * | Chain state  | Listener behaviour        | Action behaviour              | Operator action                    |
 * |-------------|---------------------------|-------------------------------|------------------------------------|
 * | healthy     | polling / watching        | claims / refunds proceed      | none                               |
 * | degraded    | polling with backoff      | claims / refunds proceed      | monitor error rate                 |
 * | suspended   | polling paused            | no claims / refunds issued    | verify RPC; wait for auto-recover  |
 *
 * See `docs/operational-policy.md` for the full runbook.
 */

import type { Logger } from "pino";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Per-chain health state tracked by the fallback policy. */
export type ChainHealthState = "healthy" | "degraded" | "suspended";

/** Chain identifiers used as keys in the fallback policy. */
export type FallbackChain = string;

export interface ChainHealthEntry {
  chain: FallbackChain;
  state: ChainHealthState;
  /** Total consecutive failures without a successful call. */
  consecutiveFailures: number;
  /** Wall-clock time of the most recent failure (ms since epoch), or null. */
  lastFailureAt: number | null;
  /** Wall-clock time when the chain entered the current state (ms since epoch). */
  enteredStateAt: number;
}

export interface ChainFallbackPolicyOptions {
  /**
   * Number of consecutive failures that promote a chain from degraded →
   * suspended.  Default: 5.
   */
  suspendAfterConsecutiveFailures?: number;
  /**
   * Number of consecutive failures that promote a chain from healthy →
   * degraded.  Default: 2.
   */
  degradeAfterConsecutiveFailures?: number;
  /** Optional logger for state-transition events. */
  log?: Logger;
}

// ── Policy ────────────────────────────────────────────────────────────────────

/**
 * Tracks per-chain health and applies the hold/retry/suspend policy.
 *
 * Thread-safety note: Node.js is single-threaded, so no explicit locking
 * is needed.  All mutations happen synchronously inside `reportFailure` /
 * `reportSuccess`.
 */
export class ChainFallbackPolicy {
  private readonly suspendThreshold: number;
  private readonly degradeThreshold: number;
  private readonly log: Logger | undefined;
  private readonly chains = new Map<FallbackChain, ChainHealthEntry>();

  constructor(opts: ChainFallbackPolicyOptions = {}) {
    this.suspendThreshold = opts.suspendAfterConsecutiveFailures ?? 5;
    this.degradeThreshold = opts.degradeAfterConsecutiveFailures ?? 2;
    this.log = opts.log;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Report a successful RPC call for `chain`.
   *
   * Clears the consecutive-failure counter and transitions the chain back to
   * `healthy` regardless of its current state.
   */
  reportSuccess(chain: FallbackChain): void {
    const entry = this.getOrCreate(chain);
    if (entry.consecutiveFailures === 0 && entry.state === "healthy") return;

    const previous = entry.state;
    entry.consecutiveFailures = 0;
    entry.state = "healthy";
    entry.enteredStateAt = Date.now();

    if (previous !== "healthy") {
      this.log?.info(
        { chain, previousState: previous, newState: "healthy" },
        `chain-fallback: ${chain} recovered — resuming normal operation`
      );
    }
  }

  /**
   * Report an RPC failure for `chain`.
   *
   * Increments the consecutive-failure counter and may transition the chain
   * to `degraded` or `suspended` based on configured thresholds.
   *
   * Returns the resulting health state so callers can act immediately.
   */
  reportFailure(chain: FallbackChain): ChainHealthState {
    const entry = this.getOrCreate(chain);
    entry.consecutiveFailures++;
    entry.lastFailureAt = Date.now();

    const previous = entry.state;
    let next: ChainHealthState = entry.state;

    if (entry.consecutiveFailures >= this.suspendThreshold) {
      next = "suspended";
    } else if (entry.consecutiveFailures >= this.degradeThreshold) {
      next = "degraded";
    }

    if (next !== previous) {
      entry.state = next;
      entry.enteredStateAt = Date.now();
      this.logTransition(chain, previous, next, entry.consecutiveFailures);
    }

    return entry.state;
  }

  /**
   * Whether the resolver should issue actions (claims, refunds) on `chain`.
   *
   * Returns `false` when the chain is suspended — the resolver must not
   * attempt on-chain writes when connectivity cannot be confirmed.
   */
  canAct(chain: FallbackChain): boolean {
    return this.getOrCreate(chain).state !== "suspended";
  }

  /**
   * Whether the resolver should continue polling / listening on `chain`.
   *
   * Listening is paused on suspended chains to avoid hammering an endpoint
   * that is known to be down.  The listener should schedule a delayed retry
   * (governed by the supervisor's restart backoff) rather than spinning.
   */
  canListen(chain: FallbackChain): boolean {
    return this.getOrCreate(chain).state !== "suspended";
  }

  /** Current health state for `chain`, or `"healthy"` if never touched. */
  getState(chain: FallbackChain): ChainHealthState {
    return this.chains.get(chain)?.state ?? "healthy";
  }

  /** Full entry for `chain`, creating a default-healthy entry if absent. */
  getEntry(chain: FallbackChain): ChainHealthEntry {
    return this.getOrCreate(chain);
  }

  /**
   * Snapshot of all tracked chains.  Returns a new array each time so
   * callers cannot mutate the internal state.
   */
  snapshot(): ChainHealthEntry[] {
    return Array.from(this.chains.values()).map((e) => ({ ...e }));
  }

  /**
   * True when ALL tracked chains are healthy.
   * An untracked chain is assumed healthy.
   */
  allHealthy(): boolean {
    for (const entry of this.chains.values()) {
      if (entry.state !== "healthy") return false;
    }
    return true;
  }

  /**
   * True when at least one tracked chain is suspended.
   * Useful for the telemetry/health endpoint.
   */
  hasAnySuspended(): boolean {
    for (const entry of this.chains.values()) {
      if (entry.state === "suspended") return true;
    }
    return false;
  }

  /**
   * Forced reset of a chain's state to healthy.  Use only in tests or after
   * a manual operator intervention has confirmed the chain is back up.
   */
  forceReset(chain: FallbackChain): void {
    this.reportSuccess(chain);
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private getOrCreate(chain: FallbackChain): ChainHealthEntry {
    let entry = this.chains.get(chain);
    if (!entry) {
      entry = {
        chain,
        state: "healthy",
        consecutiveFailures: 0,
        lastFailureAt: null,
        enteredStateAt: Date.now(),
      };
      this.chains.set(chain, entry);
    }
    return entry;
  }

  private logTransition(
    chain: FallbackChain,
    previous: ChainHealthState,
    next: ChainHealthState,
    consecutiveFailures: number
  ): void {
    if (!this.log) return;
    const level = next === "suspended" ? "error" : "warn";
    const action =
      next === "suspended"
        ? "SUSPEND: no actions will be issued on this chain until recovery"
        : "DEGRADE: actions continue but failure rate is elevated — monitor closely";

    this.log[level](
      { chain, previousState: previous, newState: next, consecutiveFailures },
      `chain-fallback: ${chain} → ${next}. ${action}`
    );
  }
}
