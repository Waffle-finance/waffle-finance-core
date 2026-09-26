import type { Supervisor, SupervisorState } from "./supervisor.js";
import {
  listenerLastEventTimestampSeconds,
  listenerLastHealthyTimestampSeconds,
  listenerStalenessSeconds,
  listenerHealthState,
  listenerConsecutiveFailures,
  listenerHealthTransitionsTotal,
  missedEventsTotal,
  operationFailuresTotal,
  retryAttemptsTotal,
  activeOperations,
  resolverRuntimeStateInfo,
} from "./metrics.js";

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Coarse-grained resolver runtime telemetry state, distinct from
 * `SupervisorState`: the supervisor describes its own restart lifecycle,
 * while this describes whether the resolver is actually fulfilling its
 * role from an operator's point of view.
 *
 * - `connected` — running, all chains reporting recent events, no elevated failures.
 * - `degraded`  — running but actively retrying/restarting through transient errors.
 * - `stale`     — running, but one or more chains have gone quiet longer than expected.
 * - `inactive`  — not running at all (idle, stopping, stopped, or failed).
 */
export type ResolverTelemetryState = "connected" | "degraded" | "stale" | "inactive";

export const RESOLVER_TELEMETRY_STATES: readonly ResolverTelemetryState[] = [
  "connected",
  "degraded",
  "stale",
  "inactive",
];

/** Supervisor states that mean "not actually doing the resolver's job right now". */
const INACTIVE_SUPERVISOR_STATES: readonly SupervisorState[] = [
  "idle",
  "stopping",
  "stopped",
  "failed",
];

// ── Listener health state type (issue #769) ───────────────────────────────────

/**
 * Per-chain listener health state, distinct from the coarse telemetry state.
 *
 * - `healthy`  — listener is running and produced a successful tick within staleAfterSeconds.
 * - `stale`    — listener is running but hasn't produced a healthy tick recently.
 * - `degraded` — listener is running but has accumulated consecutive failures or missed events.
 * - `stopped`  — listener is not running (activeListeners gauge = 0).
 */
export type ListenerHealthState = "healthy" | "stale" | "degraded" | "stopped";

export const LISTENER_HEALTH_STATES: readonly ListenerHealthState[] = [
  "healthy",
  "stale",
  "degraded",
  "stopped",
];

// ── ChainTelemetry (extended for issue #769) ──────────────────────────────────

export interface ChainTelemetry {
  chain: string;
  /** Seconds since the last observed event on this chain, or null if none yet. */
  secondsSinceLastEvent: number | null;
  /** True when the chain has reported an event within the staleness window. */
  live: boolean;
  /** Seconds since the last healthy poll tick (not just any event). null if never healthy. */
  secondsSinceLastHealthyTick: number | null;
  /** Coarse per-chain health state. */
  healthState: ListenerHealthState;
  /** Number of consecutive poll failures since the last successful tick. */
  consecutiveFailures: number;
  /** Total missed event batches since process start. */
  missedEventBatches: number;
}

export interface ResolverTelemetrySnapshot {
  state: ResolverTelemetryState;
  /** Short human-readable explanation of why `state` was chosen. */
  reason: string;
  supervisorState: SupervisorState;
  restarts: number;
  commandQueueDepth: number;
  recentFailureCount: number;
  recentRetryCount: number;
  chains: ChainTelemetry[];
  /** Total missed event batches across all chains since process start. */
  totalMissedEventBatches: number;
  /** Chains with health state != healthy (for quick at-a-glance alerting). */
  unhealthyChains: string[];
}

export interface ComputeTelemetryInput {
  supervisorState: SupervisorState;
  restarts: number;
  nowSeconds: number;
  chainLastEventSeconds: Array<{ chain: string; lastEventSeconds: number | null }>;
  /** A chain is considered stale once this many seconds pass with no event. */
  staleAfterSeconds: number;
  /** Failures observed since the last telemetry collection. */
  recentFailureCount: number;
  /** Retry attempts observed since the last telemetry collection. */
  recentRetryCount: number;
  commandQueueDepth: number;
  /** recentFailureCount at or above this trips "degraded". */
  degradedFailureThreshold: number;
  // Extended inputs for issue #769 per-chain health
  chainHealthData?: Array<{
    chain: string;
    lastHealthyTickSeconds: number | null;
    consecutiveFailures: number;
    missedEventBatches: number;
    isActive: boolean;
  }>;
}

// ── Per-chain health state computation ───────────────────────────────────────

/**
 * Derive the per-chain listener health state from available data.
 *
 * Precedence: stopped > degraded > stale > healthy.
 * A stopped listener is always the strongest signal regardless of other data.
 */
function computeChainHealthState(opts: {
  isActive: boolean;
  secondsSinceLastHealthyTick: number | null;
  consecutiveFailures: number;
  staleAfterSeconds: number;
  degradedConsecutiveFailureThreshold?: number;
}): ListenerHealthState {
  const { isActive, secondsSinceLastHealthyTick, consecutiveFailures, staleAfterSeconds } = opts;
  const degradedThreshold = opts.degradedConsecutiveFailureThreshold ?? 3;

  if (!isActive) return "stopped";

  if (consecutiveFailures >= degradedThreshold) return "degraded";

  if (secondsSinceLastHealthyTick === null || secondsSinceLastHealthyTick > staleAfterSeconds) {
    return "stale";
  }

  return "healthy";
}

// ── Pure computation ──────────────────────────────────────────────────────────

/**
 * Derive a single telemetry snapshot from already-gathered inputs. Kept pure
 * (no clock reads, no metrics registry access) so state-transition logic can
 * be tested deterministically.
 *
 * Precedence when multiple conditions hold: inactive > stale > degraded >
 * connected. A resolver that isn't running at all is a stronger signal than
 * one that is running but has gone quiet, which is a stronger signal than one
 * that is actively retrying through transient errors while still making
 * progress.
 */
export function computeResolverTelemetry(input: ComputeTelemetryInput): ResolverTelemetrySnapshot {
  const {
    supervisorState,
    restarts,
    nowSeconds,
    chainLastEventSeconds,
    staleAfterSeconds,
    recentFailureCount,
    recentRetryCount,
    commandQueueDepth,
    degradedFailureThreshold,
    chainHealthData = [],
  } = input;

  // Build a lookup map for the extended health data.
  const healthMap = new Map(chainHealthData.map((d) => [d.chain, d]));

  const chains: ChainTelemetry[] = chainLastEventSeconds.map(({ chain, lastEventSeconds }) => {
    const health = healthMap.get(chain);

    const secondsSinceLastEvent =
      lastEventSeconds === null ? null : Math.max(0, nowSeconds - lastEventSeconds);
    const live = secondsSinceLastEvent !== null && secondsSinceLastEvent <= staleAfterSeconds;

    const lastHealthyTickSeconds = health?.lastHealthyTickSeconds ?? null;
    const secondsSinceLastHealthyTick =
      lastHealthyTickSeconds === null ? null : Math.max(0, nowSeconds - lastHealthyTickSeconds);

    const consecutiveFailures = health?.consecutiveFailures ?? 0;
    const missedEventBatches = health?.missedEventBatches ?? 0;
    const isActive = health?.isActive ?? true; // assume active if no data

    const healthState = computeChainHealthState({
      isActive,
      secondsSinceLastHealthyTick,
      consecutiveFailures,
      staleAfterSeconds,
    });

    return {
      chain,
      secondsSinceLastEvent,
      live,
      secondsSinceLastHealthyTick,
      healthState,
      consecutiveFailures,
      missedEventBatches,
    };
  });

  const totalMissedEventBatches = chains.reduce((sum, c) => sum + c.missedEventBatches, 0);
  const unhealthyChains = chains.filter((c) => c.healthState !== "healthy").map((c) => c.chain);

  const base = {
    supervisorState,
    restarts,
    commandQueueDepth,
    recentFailureCount,
    recentRetryCount,
    chains,
    totalMissedEventBatches,
    unhealthyChains,
  };

  if (INACTIVE_SUPERVISOR_STATES.includes(supervisorState)) {
    return { ...base, state: "inactive", reason: `supervisor is ${supervisorState}` };
  }

  const staleChains = chains.filter((c) => !c.live);
  if (staleChains.length > 0) {
    return {
      ...base,
      state: "stale",
      reason: `no recent events from: ${staleChains.map((c) => c.chain).join(", ")}`,
    };
  }

  if (supervisorState === "restarting") {
    return { ...base, state: "degraded", reason: `supervisor is restarting (restart ${restarts})` };
  }

  if (recentFailureCount >= degradedFailureThreshold) {
    return {
      ...base,
      state: "degraded",
      reason: `elevated failure count since last check (${recentFailureCount})`,
    };
  }

  // Check per-chain degraded / stale states even when the coarse event-based
  // check passes — a chain can have missed event batches without the staleness
  // window having expired yet.
  const degradedChains = chains.filter(
    (c) => c.healthState === "degraded" || c.missedEventBatches > 0,
  );
  if (degradedChains.length > 0) {
    return {
      ...base,
      state: "degraded",
      reason: `chain health issues on: ${degradedChains.map((c) => c.chain).join(", ")}`,
    };
  }

  return { ...base, state: "connected", reason: "all chains live, no elevated failures" };
}

// ── StalenessMonitor (issue #769) ─────────────────────────────────────────────

/**
 * Per-chain staleness and health tracking.
 *
 * Updated by listener callbacks via `recordHealthyTick()` and
 * `recordFailure()`. The telemetry collector reads from this monitor to
 * populate the extended chain health fields in the snapshot.
 *
 * Thread-safety: Node.js is single-threaded; no locking is needed.
 */
export class StalenessMonitor {
  private readonly lastHealthyTick = new Map<string, number>();
  private readonly consecutiveFailures = new Map<string, number>();
  private readonly missedBatches = new Map<string, number>();
  private readonly activeState = new Map<string, boolean>();
  private readonly prevHealthState = new Map<string, ListenerHealthState>();

  /**
   * Record a successful poll tick or live event for `chain`.
   * Resets the consecutive-failure counter and updates the healthy-tick timestamp.
   * Publishes updated Prometheus metrics.
   */
  recordHealthyTick(chain: string): void {
    const nowSeconds = Math.floor(Date.now() / 1000);
    this.lastHealthyTick.set(chain, nowSeconds);
    this.consecutiveFailures.set(chain, 0);
    this.activeState.set(chain, true);

    listenerLastHealthyTimestampSeconds.set({ chain }, nowSeconds);
    listenerStalenessSeconds.set({ chain }, 0);
    listenerConsecutiveFailures.set({ chain }, 0);

    this._publishHealthState(chain, "healthy");
  }

  /**
   * Record a poll failure for `chain`.
   * Increments the consecutive-failure counter and publishes updated metrics.
   */
  recordFailure(chain: string): void {
    const current = this.consecutiveFailures.get(chain) ?? 0;
    const next = current + 1;
    this.consecutiveFailures.set(chain, next);

    listenerConsecutiveFailures.set({ chain }, next);

    // State transitions after threshold
    if (next >= 3) {
      this._publishHealthState(chain, "degraded");
    }
  }

  /**
   * Record that a batch of events was missed (RPC history-window overflow or
   * reconnect gap) for `chain`. `reason` is the error classification for
   * the `resolver_missed_events_total` counter label.
   */
  recordMissedBatch(chain: string, reason: string): void {
    const current = this.missedBatches.get(chain) ?? 0;
    this.missedBatches.set(chain, current + 1);

    missedEventsTotal.inc({ chain, reason });
    this._publishHealthState(chain, "degraded");
  }

  /**
   * Mark a chain listener as stopped (activeListeners went to 0).
   */
  recordStopped(chain: string): void {
    this.activeState.set(chain, false);
    this._publishHealthState(chain, "stopped");
  }

  /**
   * Mark a chain listener as started / reactivated.
   */
  recordStarted(chain: string): void {
    this.activeState.set(chain, true);
    // Do not automatically mark as healthy — wait for first successful tick.
  }

  /**
   * Update the staleness gauge for all known chains. Called periodically
   * (e.g. every telemetry collection cycle) to keep the gauge current even
   * when no new events arrive.
   */
  updateStalenessGauges(staleAfterSeconds: number): void {
    const nowSeconds = Math.floor(Date.now() / 1000);
    for (const [chain, lastTick] of this.lastHealthyTick) {
      const staleness = Math.max(0, nowSeconds - lastTick);
      listenerStalenessSeconds.set({ chain }, staleness);

      const isActive = this.activeState.get(chain) ?? true;
      const consecutiveFails = this.consecutiveFailures.get(chain) ?? 0;
      const healthState = computeChainHealthState({
        isActive,
        secondsSinceLastHealthyTick: staleness,
        consecutiveFailures: consecutiveFails,
        staleAfterSeconds,
      });
      this._publishHealthState(chain, healthState);
    }
  }

  /**
   * Snapshot the current per-chain health data for use by the telemetry collector.
   */
  snapshotChainData(): Array<{
    chain: string;
    lastHealthyTickSeconds: number | null;
    consecutiveFailures: number;
    missedEventBatches: number;
    isActive: boolean;
  }> {
    const chains = new Set([
      ...this.lastHealthyTick.keys(),
      ...this.consecutiveFailures.keys(),
      ...this.missedBatches.keys(),
      ...this.activeState.keys(),
    ]);
    return Array.from(chains).map((chain) => ({
      chain,
      lastHealthyTickSeconds: this.lastHealthyTick.get(chain) ?? null,
      consecutiveFailures: this.consecutiveFailures.get(chain) ?? 0,
      missedEventBatches: this.missedBatches.get(chain) ?? 0,
      isActive: this.activeState.get(chain) ?? true,
    }));
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  /** Publish health state as enum-style gauge and emit a transition counter if the state changed. */
  private _publishHealthState(chain: string, newState: ListenerHealthState): void {
    const prevState = this.prevHealthState.get(chain);

    // Emit transition counter only on actual state change.
    if (prevState !== undefined && prevState !== newState) {
      listenerHealthTransitionsTotal.inc({ chain, from: prevState, to: newState });
    }

    this.prevHealthState.set(chain, newState);

    // Set enum-style gauge: 1 for current state, 0 for all others.
    for (const candidate of LISTENER_HEALTH_STATES) {
      listenerHealthState.set({ chain, state: candidate }, candidate === newState ? 1 : 0);
    }
  }
}

// ── Global singleton monitor (shared across listeners) ────────────────────────

/**
 * Process-level singleton `StalenessMonitor`.
 *
 * Listeners import this directly to record ticks and failures without needing
 * to thread the monitor through every call site. The telemetry collector reads
 * from it via `globalStalenessMonitor.snapshotChainData()`.
 */
export const globalStalenessMonitor = new StalenessMonitor();

// ── Metrics-backed collection ─────────────────────────────────────────────────

export interface CollectTelemetryDeps {
  supervisor: Supervisor;
  /** Chains to report liveness for, e.g. ["ethereum", "soroban"]. */
  chains: string[];
  /** Defaults to 300s (5 minutes). */
  staleAfterSeconds?: number;
  /** Defaults to 3. */
  degradedFailureThreshold?: number;
  /**
   * Optional staleness monitor override. Defaults to the global singleton.
   * Pass an explicit instance in tests to isolate state.
   */
  stalenessMonitor?: StalenessMonitor;
}

/**
 * Tracks cumulative counter totals across calls so `recentFailureCount` /
 * `recentRetryCount` reflect activity since the *last* collection rather
 * than an ever-growing total that would eventually trip "degraded"
 * permanently on any long-lived process.
 */
export class ResolverTelemetryCollector {
  private lastFailureTotal = 0;
  private lastRetryTotal = 0;

  async collect(deps: CollectTelemetryDeps): Promise<ResolverTelemetrySnapshot> {
    const staleAfterSeconds = deps.staleAfterSeconds ?? 300;
    const degradedFailureThreshold = deps.degradedFailureThreshold ?? 3;
    const monitor = deps.stalenessMonitor ?? globalStalenessMonitor;
    const nowSeconds = Math.floor(Date.now() / 1000);

    const [lastEventMetric, failuresMetric, retriesMetric, activeOpsMetric] = await Promise.all([
      listenerLastEventTimestampSeconds.get(),
      operationFailuresTotal.get(),
      retryAttemptsTotal.get(),
      activeOperations.get(),
    ]);

    const chainLastEventSeconds = deps.chains.map((chain) => {
      const match = lastEventMetric.values.find((v) => v.labels.chain === chain);
      return { chain, lastEventSeconds: match ? match.value : null };
    });

    const failureTotal = sumValues(failuresMetric.values);
    const retryTotal = sumValues(retriesMetric.values);
    const commandQueueDepth = sumValues(activeOpsMetric.values);

    const recentFailureCount = Math.max(0, failureTotal - this.lastFailureTotal);
    const recentRetryCount = Math.max(0, retryTotal - this.lastRetryTotal);
    this.lastFailureTotal = failureTotal;
    this.lastRetryTotal = retryTotal;

    // Pull per-chain health data from the staleness monitor.
    const chainHealthData = monitor.snapshotChainData();

    // Update staleness gauges as a side-effect of collection.
    monitor.updateStalenessGauges(staleAfterSeconds);

    const snapshot = computeResolverTelemetry({
      supervisorState: deps.supervisor.state,
      restarts: deps.supervisor.restarts,
      nowSeconds,
      chainLastEventSeconds,
      staleAfterSeconds,
      recentFailureCount,
      recentRetryCount,
      commandQueueDepth,
      degradedFailureThreshold,
      chainHealthData,
    });

    publishResolverTelemetryMetric(snapshot.state);
    return snapshot;
  }
}

function sumValues(values: Array<{ value: number }>): number {
  return values.reduce((sum, v) => sum + v.value, 0);
}

/** Set the `resolver_runtime_state_info` gauge so only the current state reads 1. */
function publishResolverTelemetryMetric(state: ResolverTelemetryState): void {
  for (const candidate of RESOLVER_TELEMETRY_STATES) {
    resolverRuntimeStateInfo.set({ state: candidate }, candidate === state ? 1 : 0);
  }
}
