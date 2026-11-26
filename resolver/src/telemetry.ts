import type { Logger } from "pino";
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
  listenerLastPollSuccessTimestampSeconds,
  listenerLastProcessedEventTimestampSeconds,
  listenerProgressAgeSeconds,
  listenerProgressStaleThresholdSeconds,
  listenerProgressState,
  onProgressScrape,
} from "./metrics.js";

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Coarse-grained resolver runtime telemetry state, distinct from
 * `SupervisorState`: the supervisor describes its own restart lifecycle,
 * while this describes whether the resolver is actually fulfilling its
 * role from an operator's point of view.
 *
 * ### State definitions and threshold criteria
 *
 * | State      | Criteria                                                                       |
 * |------------|--------------------------------------------------------------------------------|
 * | CONNECTED  | Supervisor is running, all monitored chains have emitted an event within       |
 * |            | `staleAfterSeconds` (default 300 s), and recent failures are below the         |
 * |            | `degradedFailureThreshold` (default 3).                                        |
 * | STALE      | Supervisor is running but one or more chains have not emitted an event for     |
 * |            | longer than `staleAfterSeconds`. Stale is checked before degraded because     |
 * |            | a quiet chain requires immediate attention to prevent missed settlements.      |
 * | DEGRADED   | Supervisor is running or actively restarting AND one of the following is true: |
 * |            | (a) supervisor is in `restarting` state; OR                                    |
 * |            | (b) `recentFailureCount >= degradedFailureThreshold`; OR                       |
 * |            | (c) `consecutiveRpcErrors >= consecutiveRpcErrorThreshold` (default 3).        |
 * | STALE      | Supervisor is running but one or more chains have not emitted an event for     |
 * |            | longer than `staleAfterSeconds`. Chain is considered stale before degraded     |
 * |            | because a quiet chain is a weaker operational signal than active failures.     |
 * | INACTIVE   | Supervisor is in `idle`, `stopping`, `stopped`, or `failed` state — the       |
 * |            | resolver is not performing any work at all.                                    |
 *
 * ### Precedence (strongest signal first)
 * INACTIVE > DEGRADED > STALE > CONNECTED
 *
 * INACTIVE is the clearest problem (the process isn't running). DEGRADED
 * (active failures/restarts) is stronger than STALE (just quiet) because a
 * chain can be genuinely quiet without any fault.
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

// ── Listener progress state (issue #1093) ─────────────────────────────────────

/**
 * Per-chain progress state. Separates a healthy quiet chain from a listener
 * that is connected but no longer advancing.
 *
 * - `active`   — an event was processed within the progress threshold.
 * - `idle`     — polls keep succeeding within the threshold, but no recent
 *                events. The chain is quiet; nothing is wrong.
 * - `stale`    — no successful poll and no processed event within the
 *                threshold. The listener has stopped advancing.
 * - `degraded` — the listener is stopped, or consecutive poll failures have
 *                reached the failure threshold.
 *
 * Precedence: degraded > stale > active > idle.
 */
export type ListenerProgressState = "active" | "idle" | "stale" | "degraded";

export const LISTENER_PROGRESS_STATES: readonly ListenerProgressState[] = [
  "active",
  "idle",
  "stale",
  "degraded",
];

/**
 * How a listener observes its chain. Used as the stable `listener` metric
 * label. Poll listeners emit a heartbeat on every successful poll, so idle
 * and stale can be told apart; subscription listeners only advance when an
 * event arrives, so they need a longer threshold.
 */
export type ListenerKind = "poll" | "subscription";

export const DEFAULT_LISTENER_KINDS: Readonly<Record<string, ListenerKind>> = {
  ethereum: "subscription",
  soroban: "poll",
  solana: "poll",
};

/**
 * Default progress-age thresholds.
 *
 * - poll (300 s): Soroban and Solana poll every few seconds, so 300 s is
 *   many missed polls in a row. That is long enough to ride out a brief RPC
 *   blip and short enough to catch a stall well before HTLC timelocks
 *   (hours) are at risk.
 * - subscription (1800 s): an event subscription has no heartbeat, so a quiet
 *   contract looks the same as a dead subscription. The longer window keeps
 *   ordinary quiet periods from paging; tune it per deployment from observed
 *   event rates.
 */
export const DEFAULT_PROGRESS_STALE_AFTER_SECONDS: Readonly<Record<ListenerKind, number>> = {
  poll: 300,
  subscription: 1800,
};

/** Consecutive poll failures at or above this mark a listener degraded. */
export const DEFAULT_DEGRADED_CONSECUTIVE_FAILURES = 3;

export interface ListenerProgressInput {
  isActive: boolean;
  consecutiveFailures: number;
  secondsSinceLastPoll: number | null;
  secondsSinceLastEvent: number | null;
  /** Seconds since the listener started; used as the age before any progress. */
  secondsSinceStart: number | null;
  staleAfterSeconds: number;
  degradedConsecutiveFailureThreshold?: number;
}

/**
 * Seconds since the most recent progress (successful poll or processed
 * event). Before any progress, falls back to time since start so a listener
 * that never completes a poll still ages. null when nothing is known.
 */
export function computeProgressAgeSeconds(
  input: Pick<ListenerProgressInput, "secondsSinceLastPoll" | "secondsSinceLastEvent" | "secondsSinceStart">,
): number | null {
  const candidates = [input.secondsSinceLastPoll, input.secondsSinceLastEvent].filter(
    (v): v is number => v !== null,
  );
  if (candidates.length > 0) return Math.min(...candidates);
  return input.secondsSinceStart;
}

/** Pure classification of a listener's progress state. */
export function classifyListenerProgress(input: ListenerProgressInput): ListenerProgressState {
  const threshold =
    input.degradedConsecutiveFailureThreshold ?? DEFAULT_DEGRADED_CONSECUTIVE_FAILURES;

  if (!input.isActive) return "degraded";
  if (input.consecutiveFailures >= threshold) return "degraded";

  const age = computeProgressAgeSeconds(input);
  if (age === null || age > input.staleAfterSeconds) return "stale";

  if (input.secondsSinceLastEvent !== null && input.secondsSinceLastEvent <= input.staleAfterSeconds) {
    return "active";
  }
  return "idle";
}

/**
 * Read per-chain threshold overrides from the environment:
 * `RESOLVER_PROGRESS_STALE_AFTER_SECONDS_<CHAIN>` (e.g. `..._ETHEREUM=900`).
 * Values that are not positive integers are ignored; the effective threshold
 * is always visible on `resolver_listener_progress_stale_threshold_seconds`.
 */
export function progressThresholdsFromEnv(
  env: Record<string, string | undefined> = process.env,
): Record<string, number> {
  const prefix = "RESOLVER_PROGRESS_STALE_AFTER_SECONDS_";
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(env)) {
    if (!key.startsWith(prefix) || raw === undefined) continue;
    const chain = key.slice(prefix.length).toLowerCase();
    if (!/^\d+$/.test(raw.trim())) continue;
    const seconds = Number(raw.trim());
    if (chain && seconds > 0) out[chain] = seconds;
  }
  return out;
}

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
  // Progress-age fields (issue #1093)
  /** How the listener observes the chain (stable metric label). */
  listener: ListenerKind;
  /** Progress state: active, idle, stale or degraded. */
  progressState: ListenerProgressState;
  /** Seconds since the last successful poll or processed event (or since start). */
  progressAgeSeconds: number | null;
  /** Threshold after which progressState becomes stale. */
  progressStaleAfterSeconds: number;
  /** Seconds since the last successful poll; null for subscription listeners or before the first poll. */
  secondsSinceLastPoll: number | null;
  /** Seconds since the last event handed to handlers; null if none yet. */
  secondsSinceLastProcessedEvent: number | null;
}

export interface ChainHealthData {
  chain: string;
  lastHealthyTickSeconds: number | null;
  consecutiveFailures: number;
  missedEventBatches: number;
  isActive: boolean;
  // Progress-age inputs (issue #1093). Optional so older callers keep working.
  listener?: ListenerKind;
  lastPollSuccessSeconds?: number | null;
  lastProcessedEventSeconds?: number | null;
  startedAtSeconds?: number | null;
  progressStaleAfterSeconds?: number;
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
  consecutiveRpcErrors: number;
  chains: ChainTelemetry[];
  /** Total missed event batches across all chains since process start. */
  totalMissedEventBatches: number;
  /** Chains with health state != healthy (for quick at-a-glance alerting). */
  unhealthyChains: string[];
  /** Chains whose progress state is stale or degraded (not advancing). */
  stalledChains: string[];
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
  /** recentFailureCount at or above this trips "degraded". Default: 3. */
  degradedFailureThreshold: number;
  /**
   * Consecutive RPC errors at or above this trips "degraded". Default: 3.
   * Set to 0 to disable this check.
   */
  consecutiveRpcErrors?: number;
  /** consecutiveRpcErrors at or above this trips "degraded". Default: 3. */
  consecutiveRpcErrorThreshold?: number;
  // Extended inputs for issue #769 per-chain health (+ #1093 progress age)
  chainHealthData?: ChainHealthData[];
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
 * ### Precedence when multiple conditions hold:
 * inactive > stale > degraded > connected
 *
 * A resolver that isn't running at all (INACTIVE) is the strongest signal.
 * A chain that has gone quiet (STALE) is checked before active errors (DEGRADED)
 * because a stale chain may prevent settlements even if the supervisor is active.
 * A resolver with no recent events but no active errors is STALE.
 * Everything healthy is CONNECTED.
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

  const consecutiveRpcErrors = input.consecutiveRpcErrors ?? 0;
  const consecutiveRpcErrorThreshold = input.consecutiveRpcErrorThreshold ?? 3;

  // Build a lookup map for the extended health data.
  const healthMap = new Map(chainHealthData.map((d) => [d.chain, d]));

  const chains: ChainTelemetry[] = chainLastEventSeconds.map(({ chain, lastEventSeconds }) => {
    const health = healthMap.get(chain);

    const secondsSinceLastEvent =
      lastEventSeconds === null ? null : Math.max(0, nowSeconds - lastEventSeconds);

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

    // ── Progress age (issue #1093) ─────────────────────────────────────────
    const listener = health?.listener ?? DEFAULT_LISTENER_KINDS[chain] ?? "poll";
    const progressStaleAfterSeconds =
      health?.progressStaleAfterSeconds ?? DEFAULT_PROGRESS_STALE_AFTER_SECONDS[listener];
    const ageFrom = (ts: number | null | undefined) =>
      ts === null || ts === undefined ? null : Math.max(0, nowSeconds - ts);
    const secondsSinceLastPoll = ageFrom(health?.lastPollSuccessSeconds);
    // Fall back to the event-timestamp metric when the monitor has no event record.
    const secondsSinceLastProcessedEvent =
      ageFrom(health?.lastProcessedEventSeconds) ?? secondsSinceLastEvent;
    const progressInput = {
      isActive,
      consecutiveFailures,
      secondsSinceLastPoll,
      secondsSinceLastEvent: secondsSinceLastProcessedEvent,
      secondsSinceStart: ageFrom(health?.startedAtSeconds),
      staleAfterSeconds: progressStaleAfterSeconds,
    };
    const progressState = classifyListenerProgress(progressInput);
    const progressAgeSeconds = computeProgressAgeSeconds(progressInput);

    // A chain is live when it has a recent event. When the monitor reports
    // poll progress for the chain, a quiet chain whose polls keep succeeding
    // (idle) also counts as live, so quiet periods no longer read as stale.
    const hasPollProgress =
      health?.lastPollSuccessSeconds !== null && health?.lastPollSuccessSeconds !== undefined;
    const eventLive = secondsSinceLastEvent !== null && secondsSinceLastEvent <= staleAfterSeconds;
    const live = eventLive || (hasPollProgress && progressState === "idle");

    return {
      chain,
      secondsSinceLastEvent,
      live,
      secondsSinceLastHealthyTick,
      healthState,
      consecutiveFailures,
      missedEventBatches,
      listener,
      progressState,
      progressAgeSeconds,
      progressStaleAfterSeconds,
      secondsSinceLastPoll,
      secondsSinceLastProcessedEvent,
    };
  });

  const totalMissedEventBatches = chains.reduce((sum, c) => sum + c.missedEventBatches, 0);
  const unhealthyChains = chains.filter((c) => c.healthState !== "healthy").map((c) => c.chain);
  const stalledChains = chains
    .filter((c) => c.progressState === "stale" || c.progressState === "degraded")
    .map((c) => c.chain);

  const base = {
    supervisorState,
    restarts,
    commandQueueDepth,
    recentFailureCount,
    recentRetryCount,
    consecutiveRpcErrors,
    chains,
    totalMissedEventBatches,
    unhealthyChains,
    stalledChains,
  };

  // ── INACTIVE: supervisor is not running ───────────────────────────────────
  if (INACTIVE_SUPERVISOR_STATES.includes(supervisorState)) {
    return {
      ...base,
      state: "inactive",
      reason: `supervisor is ${supervisorState}`,
    };
  }

  // ── STALE: chain(s) have gone quiet ───────────────────────────────────────
  // Check stale before degraded: a chain that has gone quiet is a stronger
  // operational signal than active-but-restarting — operators must act on
  // stale chains to prevent missed settlements.
  const staleChains = chains.filter((c) => !c.live);
  if (staleChains.length > 0) {
    const details = staleChains.map((c) =>
      c.secondsSinceLastEvent !== null
        ? `${c.chain} (${c.secondsSinceLastEvent}s ago, threshold ${staleAfterSeconds}s)`
        : `${c.chain} (no events yet)`
    );
    return {
      ...base,
      state: "stale",
      reason: `no recent events from: ${details.join("; ")}`,
    };
  }

  // ── DEGRADED: active failures or consecutive RPC errors ───────────────────
  if (supervisorState === "restarting") {
    return {
      ...base,
      state: "degraded",
      reason: `supervisor is restarting (restart ${restarts})`,
    };
  }

  if (recentFailureCount >= degradedFailureThreshold) {
    return {
      ...base,
      state: "degraded",
      reason: `elevated failure count since last check (${recentFailureCount} >= threshold ${degradedFailureThreshold})`,
    };
  }

  if (consecutiveRpcErrors >= consecutiveRpcErrorThreshold) {
    return {
      ...base,
      state: "degraded",
      reason: `consecutive RPC errors (${consecutiveRpcErrors} >= threshold ${consecutiveRpcErrorThreshold})`,
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
export interface StalenessMonitorOptions {
  /** Per-chain progress-age threshold overrides, in seconds. */
  progressStaleAfterSeconds?: Record<string, number>;
  /** Per-chain listener kind overrides. */
  listenerKinds?: Record<string, ListenerKind>;
}

export class StalenessMonitor {
  private readonly lastHealthyTick = new Map<string, number>();
  private readonly consecutiveFailures = new Map<string, number>();
  private readonly missedBatches = new Map<string, number>();
  private readonly activeState = new Map<string, boolean>();
  private readonly prevHealthState = new Map<string, ListenerHealthState>();
  // Progress tracking (issue #1093)
  private readonly lastPollSuccess = new Map<string, number>();
  private readonly lastProcessedEvent = new Map<string, number>();
  private readonly startedAt = new Map<string, number>();
  private readonly listenerKinds = new Map<string, ListenerKind>();
  private readonly progressThresholds = new Map<string, number>();

  constructor(opts: StalenessMonitorOptions = {}) {
    for (const [chain, seconds] of Object.entries(opts.progressStaleAfterSeconds ?? {})) {
      this.progressThresholds.set(chain, seconds);
    }
    for (const [chain, kind] of Object.entries(opts.listenerKinds ?? {})) {
      this.listenerKinds.set(chain, kind);
    }
  }

  /** The listener kind used as the `listener` label for `chain`. */
  listenerKindFor(chain: string): ListenerKind {
    return this.listenerKinds.get(chain) ?? DEFAULT_LISTENER_KINDS[chain] ?? "poll";
  }

  /** The effective progress-age threshold for `chain`, in seconds. */
  progressThresholdFor(chain: string): number {
    return (
      this.progressThresholds.get(chain) ??
      DEFAULT_PROGRESS_STALE_AFTER_SECONDS[this.listenerKindFor(chain)]
    );
  }

  /** Override the progress-age threshold for `chain`. */
  setProgressThreshold(chain: string, seconds: number): void {
    if (!Number.isFinite(seconds) || seconds <= 0) {
      throw new RangeError(`progress threshold for ${chain} must be a positive number, got ${seconds}`);
    }
    this.progressThresholds.set(chain, seconds);
    this._publishProgress(chain);
  }

  /**
   * Record a healthy tick for `chain`: a successful poll (`source="poll"`, the
   * default) or a live event (`source="event"`). Resets the consecutive-failure
   * counter, updates the healthy-tick timestamp and the matching progress
   * timestamp, and publishes updated Prometheus metrics.
   */
  recordHealthyTick(chain: string, source: "poll" | "event" = "poll"): void {
    const nowSeconds = Math.floor(Date.now() / 1000);
    this.lastHealthyTick.set(chain, nowSeconds);
    this.consecutiveFailures.set(chain, 0);
    this.activeState.set(chain, true);

    listenerLastHealthyTimestampSeconds.set({ chain }, nowSeconds);
    listenerStalenessSeconds.set({ chain }, 0);
    listenerConsecutiveFailures.set({ chain }, 0);

    this._publishHealthState(chain, "healthy");

    if (source === "event") {
      this._stampProcessedEvent(chain, nowSeconds);
    } else {
      this.lastPollSuccess.set(chain, nowSeconds);
      listenerLastPollSuccessTimestampSeconds.set(
        { chain, listener: this.listenerKindFor(chain) },
        nowSeconds,
      );
    }
    this._publishProgress(chain, nowSeconds);
  }

  /**
   * Record that an event was handed to the listener's handlers. Poll-based
   * listeners call this per event and `recordHealthyTick(chain)` once the
   * poll completes.
   */
  recordEventProcessed(chain: string): void {
    const nowSeconds = Math.floor(Date.now() / 1000);
    this._stampProcessedEvent(chain, nowSeconds);
    this._publishProgress(chain, nowSeconds);
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
    this._publishProgress(chain);
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
    this._publishProgress(chain);
  }

  /**
   * Mark a chain listener as started / reactivated. `kind` sets the
   * `listener` label; it defaults to the chain's known listener kind.
   */
  recordStarted(chain: string, kind?: ListenerKind): void {
    this.activeState.set(chain, true);
    if (kind) this.listenerKinds.set(chain, kind);
    // Progress age counts from start until the first poll or event.
    const nowSeconds = Math.floor(Date.now() / 1000);
    this.startedAt.set(chain, nowSeconds);
    // Do not automatically mark as healthy — wait for first successful tick.
    this._publishProgress(chain, nowSeconds);
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

    // Progress age must keep counting even when nothing new is recorded.
    this.refreshProgressGauges(nowSeconds);
  }

  /**
   * Snapshot the current per-chain health data for use by the telemetry collector.
   */
  snapshotChainData(): Required<ChainHealthData>[] {
    return this._knownChains().map((chain) => ({
      chain,
      lastHealthyTickSeconds: this.lastHealthyTick.get(chain) ?? null,
      consecutiveFailures: this.consecutiveFailures.get(chain) ?? 0,
      missedEventBatches: this.missedBatches.get(chain) ?? 0,
      isActive: this.activeState.get(chain) ?? true,
      listener: this.listenerKindFor(chain),
      lastPollSuccessSeconds: this.lastPollSuccess.get(chain) ?? null,
      lastProcessedEventSeconds: this.lastProcessedEvent.get(chain) ?? null,
      startedAtSeconds: this.startedAt.get(chain) ?? null,
      progressStaleAfterSeconds: this.progressThresholdFor(chain),
    }));
  }

  /** Recompute progress age/state gauges for every known chain. */
  refreshProgressGauges(nowSeconds = Math.floor(Date.now() / 1000)): void {
    for (const chain of this._knownChains()) {
      this._publishProgress(chain, nowSeconds);
    }
  }

  /**
   * Progress state for `chain` at `nowSeconds` (defaults to the current time).
   */
  progressStateFor(chain: string, nowSeconds = Math.floor(Date.now() / 1000)): ListenerProgressState {
    return classifyListenerProgress(this._progressInput(chain, nowSeconds));
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private _knownChains(): string[] {
    return Array.from(
      new Set([
        ...this.lastHealthyTick.keys(),
        ...this.consecutiveFailures.keys(),
        ...this.missedBatches.keys(),
        ...this.activeState.keys(),
        ...this.lastPollSuccess.keys(),
        ...this.lastProcessedEvent.keys(),
        ...this.startedAt.keys(),
      ]),
    );
  }

  private _stampProcessedEvent(chain: string, nowSeconds: number): void {
    this.lastProcessedEvent.set(chain, nowSeconds);
    listenerLastProcessedEventTimestampSeconds.set(
      { chain, listener: this.listenerKindFor(chain) },
      nowSeconds,
    );
  }

  private _progressInput(chain: string, nowSeconds: number): ListenerProgressInput {
    const ageFrom = (ts: number | undefined) =>
      ts === undefined ? null : Math.max(0, nowSeconds - ts);
    return {
      isActive: this.activeState.get(chain) ?? true,
      consecutiveFailures: this.consecutiveFailures.get(chain) ?? 0,
      secondsSinceLastPoll: ageFrom(this.lastPollSuccess.get(chain)),
      secondsSinceLastEvent: ageFrom(this.lastProcessedEvent.get(chain)),
      secondsSinceStart: ageFrom(this.startedAt.get(chain)),
      staleAfterSeconds: this.progressThresholdFor(chain),
    };
  }

  /** Publish progress age, threshold and enum-style progress state for `chain`. */
  private _publishProgress(chain: string, nowSeconds = Math.floor(Date.now() / 1000)): void {
    const labels = { chain, listener: this.listenerKindFor(chain) };
    const input = this._progressInput(chain, nowSeconds);
    const state = classifyListenerProgress(input);
    const age = computeProgressAgeSeconds(input);

    listenerProgressStaleThresholdSeconds.set(labels, input.staleAfterSeconds);
    if (age !== null) listenerProgressAgeSeconds.set(labels, age);
    for (const candidate of LISTENER_PROGRESS_STATES) {
      listenerProgressState.set({ ...labels, state: candidate }, candidate === state ? 1 : 0);
    }
  }

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
export const globalStalenessMonitor = new StalenessMonitor({
  progressStaleAfterSeconds: progressThresholdsFromEnv(),
});

// Keep progress-age gauges current on every /metrics scrape.
onProgressScrape(() => globalStalenessMonitor.refreshProgressGauges());

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
  /** Optional logger for state-transition log lines. */
  log?: Pick<Logger, "info" | "warn" | "error">;
}

/**
 * Tracks cumulative counter totals across calls so `recentFailureCount` /
 * `recentRetryCount` reflect activity since the *last* collection rather
 * than an ever-growing total that would eventually trip "degraded"
 * permanently on any long-lived process.
 *
 * Also tracks state transitions and emits log lines on every change so
 * operators can see exactly when and why the resolver's liveness state
 * changed without having to correlate metrics dashboards.
 */
export class ResolverTelemetryCollector {
  private lastFailureTotal = 0;
  private lastRetryTotal = 0;
  private lastState: ResolverTelemetryState | null = null;

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

    // ── State-transition logging ──────────────────────────────────────────
    if (snapshot.state !== this.lastState) {
      if (deps.log) {
        const level = stateLogLevel(snapshot.state);
        deps.log[level](
          {
            previousState: this.lastState ?? "unknown",
            newState: snapshot.state,
            reason: snapshot.reason,
            supervisorState: snapshot.supervisorState,
            restarts: snapshot.restarts,
            recentFailureCount: snapshot.recentFailureCount,
            consecutiveRpcErrors: snapshot.consecutiveRpcErrors,
            chains: snapshot.chains,
          },
          `resolver liveness state transition: ${this.lastState ?? "unknown"} → ${snapshot.state}`,
        );
      }
      this.lastState = snapshot.state;
    }

    return snapshot;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sumValues(values: Array<{ value: number }>): number {
  return values.reduce((sum, v) => sum + v.value, 0);
}

/** Set the `resolver_runtime_state_info` gauge so only the current state reads 1. */
function publishResolverTelemetryMetric(state: ResolverTelemetryState): void {
  for (const candidate of RESOLVER_TELEMETRY_STATES) {
    resolverRuntimeStateInfo.set({ state: candidate }, candidate === state ? 1 : 0);
  }
}

/**
 * Map a telemetry state to the appropriate log level.
 *
 * - CONNECTED  → info  (normal operation, worth noting on first transition)
 * - STALE      → warn  (chain has gone quiet; investigate but not urgent)
 * - DEGRADED   → warn  (active errors or restarts; needs attention)
 * - INACTIVE   → error (resolver has stopped entirely)
 */
function stateLogLevel(state: ResolverTelemetryState): "info" | "warn" | "error" {
  switch (state) {
    case "connected":
      return "info";
    case "stale":
      return "warn";
    case "degraded":
      return "warn";
    case "inactive":
      return "error";
  }
}
