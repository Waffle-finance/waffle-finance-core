import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from "prom-client";

export const registry = new Registry();

collectDefaultMetrics({ register: registry, prefix: "resolver_" });

// ── Listener metrics ──────────────────────────────────────────────────────────

export const eventsTotal = new Counter({
  name: "resolver_events_total",
  help: "Total number of HTLC events observed by chain and type",
  labelNames: ["chain", "event_type"] as const,
  registers: [registry],
});

export const listenerErrorsTotal = new Counter({
  name: "resolver_listener_errors_total",
  help: "Total number of listener errors by chain and error type",
  labelNames: ["chain", "error_type"] as const,
  registers: [registry],
});

export const listenerPollDurationSeconds = new Histogram({
  name: "resolver_listener_poll_duration_seconds",
  help: "Duration of Soroban poll ticks in seconds",
  labelNames: ["chain"] as const,
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [registry],
});

export const listenerPollRunsTotal = new Counter({
  name: "resolver_listener_poll_runs_total",
  help: "Total number of poll runs by chain and result",
  labelNames: ["chain", "result"] as const,
  registers: [registry],
});

export const listenerLastEventTimestampSeconds = new Gauge({
  name: "resolver_listener_last_event_timestamp_seconds",
  help: "Unix timestamp of the most recent event observed per chain",
  labelNames: ["chain"] as const,
  registers: [registry],
});

export const activeListeners = new Gauge({
  name: "resolver_active_listeners",
  help: "Currently active listeners (1 = running, 0 = stopped)",
  labelNames: ["chain"] as const,
  registers: [registry],
});

// ── Missed-event and staleness metrics (issue #769) ───────────────────────────

/**
 * Incremented whenever the listener detects it has skipped a window of events
 * it should have processed — either because the RPC history window overflowed
 * (cursor too old) or because a reconnect dropped an event batch.
 *
 * Alert threshold recommendation: any non-zero value in a 5-minute window
 * should page on-call — it means the resolver may have silently missed a
 * preimage reveal and a user's settlement is delayed.
 */
export const missedEventsTotal = new Counter({
  name: "resolver_missed_events_total",
  help: "Total number of event batches dropped due to RPC history-window overflow or reconnect gaps, by chain",
  labelNames: ["chain", "reason"] as const,
  registers: [registry],
});

/**
 * Set to the unix-seconds timestamp when a chain's listener was last confirmed
 * healthy (i.e. successfully completed a poll or received a live event).
 * A value of 0 means the chain has never reported a healthy tick since startup.
 *
 * Used by the staleness check in telemetry.ts: if
 *   now - resolver_listener_last_healthy_timestamp_seconds{chain} > staleAfterSeconds
 * the chain is considered stale.
 *
 * Alert threshold recommendation: stale after 5 minutes (300 s) for Soroban
 * (poll-based) and after 2 minutes (120 s) for Ethereum (subscription-based).
 */
export const listenerLastHealthyTimestampSeconds = new Gauge({
  name: "resolver_listener_last_healthy_timestamp_seconds",
  help: "Unix timestamp of the most recent successful poll tick or live event per chain. 0 if the chain has never had a healthy tick since startup.",
  labelNames: ["chain"] as const,
  registers: [registry],
});

/**
 * Current staleness window in seconds per chain — how long since the last
 * healthy tick. A snapshot gauge so dashboards can read the lag directly
 * without computing `now - last_healthy_timestamp`.
 *
 * Updated by the telemetry collector on every /telemetry request and on every
 * scheduled staleness check (see telemetry.ts: StalenessMonitor).
 *
 * Alert threshold recommendation: page when > 300 s (5 minutes).
 */
export const listenerStalenessSeconds = new Gauge({
  name: "resolver_listener_staleness_seconds",
  help: "Seconds since the last healthy poll tick or event per chain. Updated by the telemetry collector.",
  labelNames: ["chain"] as const,
  registers: [registry],
});

/**
 * Health state of each chain listener as an enum-style gauge.
 * Exactly one (chain, state) series is 1 at a time; all others for that
 * chain are 0.
 *
 * States:
 *   healthy   — listener is running and making progress within the staleness window.
 *   stale     — listener has not reported a healthy tick within staleAfterSeconds.
 *   stopped   — listener is not running (activeListeners{chain}=0).
 *   degraded  — listener is running but accumulating errors or missing events.
 *
 * Alert threshold recommendation: alert when state != "healthy" for > 3 minutes.
 */
export const listenerHealthState = new Gauge({
  name: "resolver_listener_health_state",
  help: "Health state of each chain listener (1 = current state, 0 = other states). States: healthy, stale, stopped, degraded.",
  labelNames: ["chain", "state"] as const,
  registers: [registry],
});

/**
 * Total number of consecutive poll failures before the most recent recovery.
 * Reset to 0 on any successful poll. Accumulates across restarts within a
 * supervisor lifecycle.
 *
 * Alert threshold recommendation: alert when > 3 consecutive failures on the
 * same chain — indicates persistent RPC degradation that will not self-heal
 * quickly.
 */
export const listenerConsecutiveFailures = new Gauge({
  name: "resolver_listener_consecutive_failures",
  help: "Number of consecutive poll failures on each chain since the last successful tick.",
  labelNames: ["chain"] as const,
  registers: [registry],
});

/**
 * Event processing lag in seconds — the difference between the on-chain event
 * timestamp and the time the resolver processed it. A high lag indicates the
 * listener is behind the chain tip, which can cause settlement delays.
 *
 * Only emitted when the event carries a ledger/block timestamp. Chains that
 * do not include a reliable timestamp in their event payloads (e.g. Ethereum
 * watchEvent) emit lag = 0 as a sentinel.
 *
 * Alert threshold recommendation: alert when p95 lag > 60 s.
 */
export const eventProcessingLagSeconds = new Histogram({
  name: "resolver_event_processing_lag_seconds",
  help: "Seconds between the on-chain event timestamp and the resolver processing it, per chain.",
  labelNames: ["chain"] as const,
  buckets: [0, 1, 5, 10, 30, 60, 120, 300, 600],
  registers: [registry],
});

/**
 * Health-transition events: incremented each time a chain transitions between
 * health states (healthy → stale, stale → healthy, healthy → degraded, etc.).
 *
 * Label `from` and `to` carry the previous and new states so dashboards can
 * chart recovery rate and alert on specific bad transitions (e.g. healthy → stale).
 */
export const listenerHealthTransitionsTotal = new Counter({
  name: "resolver_listener_health_transitions_total",
  help: "Total health-state transitions per chain listener.",
  labelNames: ["chain", "from", "to"] as const,
  registers: [registry],
});

// ── Per-chain progress age metrics (issue #1093) ──────────────────────────────

let progressScrapeHook: (() => void) | undefined;

/**
 * Register a callback that refreshes the progress-age gauges right before
 * each scrape, so the age keeps growing while a listener is stalled even if
 * nothing calls /telemetry. telemetry.ts registers the global monitor here.
 */
export function onProgressScrape(hook: (() => void) | undefined): void {
  progressScrapeHook = hook;
}
//
// All progress metrics carry the stable labels `chain` (ethereum | soroban |
// solana) and `listener` (poll | subscription). Neither label carries order-,
// address- or transaction-specific values, so cardinality is bounded by the
// number of configured chains.

/**
 * Unix timestamp of the most recent poll that completed successfully, whether
 * or not it returned any events. Only poll-based listeners (`listener="poll"`)
 * emit this; subscription listeners have no poll boundary.
 */
export const listenerLastPollSuccessTimestampSeconds = new Gauge({
  name: "resolver_listener_last_poll_success_timestamp_seconds",
  help: "Unix timestamp of the most recent successful poll per chain listener.",
  labelNames: ["chain", "listener"] as const,
  registers: [registry],
});

/**
 * Unix timestamp of the most recent event the listener handed to its handlers.
 * Distinct from the poll timestamp: a healthy idle chain keeps advancing the
 * poll timestamp while this one stays put.
 */
export const listenerLastProcessedEventTimestampSeconds = new Gauge({
  name: "resolver_listener_last_processed_event_timestamp_seconds",
  help: "Unix timestamp of the most recent processed event per chain listener.",
  labelNames: ["chain", "listener"] as const,
  registers: [registry],
});

/**
 * Seconds since the listener last made progress — the most recent of a
 * successful poll or a processed event. Before the first progress it counts
 * from listener start, so a listener that never completes a poll still ages.
 *
 * Alert: `resolver_listener_progress_age_seconds > resolver_listener_progress_stale_threshold_seconds`
 * (see `resolver/ops/resolver-alerts.yml`).
 */
export const listenerProgressAgeSeconds = new Gauge({
  name: "resolver_listener_progress_age_seconds",
  help: "Seconds since the last successful poll or processed event per chain listener.",
  labelNames: ["chain", "listener"] as const,
  registers: [registry],
  collect() {
    progressScrapeHook?.();
  },
});

/**
 * The configured progress-age threshold for each chain listener. Exported so
 * alert rules compare against the deployed configuration instead of a number
 * duplicated in the rules file.
 */
export const listenerProgressStaleThresholdSeconds = new Gauge({
  name: "resolver_listener_progress_stale_threshold_seconds",
  help: "Configured progress-age threshold after which a chain listener is considered stale.",
  labelNames: ["chain", "listener"] as const,
  registers: [registry],
});

/**
 * Progress state per chain listener as an enum-style gauge (exactly one
 * `state` series is 1 per chain/listener):
 *
 *   active   — events processed within the threshold.
 *   idle     — polls succeed within the threshold but no recent events (a quiet chain).
 *   stale    — no successful poll or processed event within the threshold.
 *   degraded — listener stopped or consecutive poll failures at/over threshold.
 */
export const listenerProgressState = new Gauge({
  name: "resolver_listener_progress_state",
  help: "Progress state per chain listener (1 = current state). States: active, idle, stale, degraded.",
  labelNames: ["chain", "listener", "state"] as const,
  registers: [registry],
  collect() {
    progressScrapeHook?.();
  },
});

// ── Registration / participation metrics ──────────────────────────────────────

export const registrationInfo = new Gauge({
  name: "resolver_registration_info",
  help: "Resolver registration status per chain (1 = active, 0 = not active)",
  labelNames: ["chain"] as const,
  registers: [registry],
});

/**
 * Enum-style gauge: exactly one (chain, state) series is 1 at a time, all
 * other states for that chain are 0. See registry-status.ts for the state
 * model (unregistered / active / low_stake / slashed / unbonding / inactive).
 */
export const resolverLifecycleState = new Gauge({
  name: "resolver_registry_lifecycle_state",
  help: "Resolver registry lifecycle state per chain (1 = current state, 0 = other states)",
  labelNames: ["chain", "state"] as const,
  registers: [registry],
});

export const registrationChangesTotal = new Counter({
  name: "resolver_registration_changes_total",
  help: "Total registry lifecycle state transitions, labeled by the state entered (unregistered, active, low_stake, slashed, unbonding, inactive)",
  labelNames: ["action"] as const,
  registers: [registry],
});

export const startTimeSeconds = new Gauge({
  name: "resolver_start_time_seconds",
  help: "Unix timestamp when this resolver instance started",
  registers: [registry],
});

// ── Lifecycle metrics ─────────────────────────────────────────────────────────

/**
 * Enum-style gauge: exactly one `state` series is 1 at a time, all other
 * states are 0. States: idle, starting, running, pausing, paused,
 * restarting, stopping, stopped, failed.
 */
export const lifecycleStateGauge = new Gauge({
  name: "resolver_lifecycle_state",
  help: "Resolver lifecycle state (1 = current state, 0 = other states)",
  labelNames: ["state"] as const,
  registers: [registry],
});

/**
 * Counter for lifecycle state transitions.
 * Labels: `from`, `to` (state names).
 */
export const lifecycleTransitionsTotal = new Counter({
  name: "resolver_lifecycle_transitions_total",
  help: "Total lifecycle state transitions, labeled by from and to states",
  labelNames: ["from", "to"] as const,
  registers: [registry],
});

/**
 * Histogram for time spent in each lifecycle state.
 * Labels: `state`.
 */
export const lifecycleDurationSeconds = new Histogram({
  name: "resolver_lifecycle_duration_seconds",
  help: "Time spent in each lifecycle state in seconds",
  labelNames: ["state"] as const,
  buckets: [0.1, 0.5, 1, 5, 10, 30, 60, 300, 900],
  registers: [registry],
});

// ── Order operation metrics ───────────────────────────────────────────────────

export const ordersProcessedTotal = new Counter({
  name: "resolver_orders_processed_total",
  help: "Total orders processed by chain and action",
  labelNames: ["chain", "action"] as const,
  registers: [registry],
});

export const claimAttemptsTotal = new Counter({
  name: "resolver_claim_attempts_total",
  help: "Total claim attempts by chain and result",
  labelNames: ["chain", "result", "failure_reason"] as const,
  registers: [registry],
});

export const refundAttemptsTotal = new Counter({
  name: "resolver_refund_attempts_total",
  help: "Total refund attempts by chain and result",
  labelNames: ["chain", "result", "failure_reason"] as const,
  registers: [registry],
});

export const retryAttemptsTotal = new Counter({
  name: "resolver_retry_attempts_total",
  help: "Total retry attempts by operation, chain, and result",
  labelNames: ["operation", "chain", "result"] as const,
  registers: [registry],
});

export const operationDurationSeconds = new Histogram({
  name: "resolver_operation_duration_seconds",
  help: "Duration of resolver operations (claim, refund, reveal) in seconds",
  labelNames: ["operation", "chain"] as const,
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120],
  registers: [registry],
});

export const operationFailuresTotal = new Counter({
  name: "resolver_operation_failures_total",
  help: "Total resolver operation failures by chain, operation, and reason",
  labelNames: ["chain", "operation", "failure_reason"] as const,
  registers: [registry],
});

export const activeOperations = new Gauge({
  name: "resolver_active_operations",
  help: "Currently in-flight resolver operations",
  labelNames: ["operation"] as const,
  registers: [registry],
});

// ── Runtime telemetry ─────────────────────────────────────────────────────────

export const resolverRuntimeStateInfo = new Gauge({
  name: "resolver_runtime_state_info",
  help: "Current resolver runtime telemetry state (1 = active state, 0 = otherwise). See src/telemetry.ts.",
  labelNames: ["state"] as const,
  registers: [registry],
});

// ── Work limiting / backpressure (issue #1096) ────────────────────────────────

export const workRejectedTotal = new Counter({
  name: "resolver_work_rejected_total",
  help: "Event-handler work refused by the work limiter, by chain and reason (order_budget_exhausted, queue_full)",
  labelNames: ["chain", "reason"] as const,
  registers: [registry],
});

export const workDeduplicatedTotal = new Counter({
  name: "resolver_work_deduplicated_total",
  help: "Repeated identical events absorbed without running the handler, by chain and reason (in_flight, recently_completed)",
  labelNames: ["chain", "reason"] as const,
  registers: [registry],
});

export const workDeferredTotal = new Counter({
  name: "resolver_work_deferred_total",
  help: "Event-handler work queued because the per-chain concurrency limit was reached",
  labelNames: ["chain"] as const,
  registers: [registry],
});

export const workInFlight = new Gauge({
  name: "resolver_work_in_flight",
  help: "Event-handler work currently executing per chain",
  labelNames: ["chain"] as const,
  registers: [registry],
});

export const workQueueDepth = new Gauge({
  name: "resolver_work_queue_depth",
  help: "Event-handler work waiting for a per-chain concurrency slot",
  labelNames: ["chain"] as const,
  registers: [registry],
});

// ── Registry eligibility (issue #1097) ────────────────────────────────────────

export const orderEligibilityDecisionsTotal = new Counter({
  name: "resolver_order_eligibility_decisions_total",
  help: "Registry-eligibility decisions for order work, by chain, action and result (accepted or a refusal reason)",
  labelNames: ["chain", "action", "result"] as const,
  registers: [registry],
});

// ── Signing key rotation (issue #1091) ────────────────────────────────────────

export const signingKeys = new Gauge({
  name: "resolver_signing_keys",
  help: "Signing keys held per chain by rotation state (active, retiring, revoked). Key identifiers are exposed on /keys, never key material.",
  labelNames: ["chain", "state"] as const,
  registers: [registry],
});

export const keyRotationEventsTotal = new Counter({
  name: "resolver_key_rotation_events_total",
  help: "Signing key rotation events by chain and action (rotate, rollback, retire, revoke)",
  labelNames: ["chain", "action"] as const,
  registers: [registry],
});

export const resolverMetrics = {
  eventsTotal,
  listenerErrorsTotal,
  listenerPollDurationSeconds,
  listenerPollRunsTotal,
  listenerLastEventTimestampSeconds,
  activeListeners,
  // missed-event / staleness metrics (issue #769)
  missedEventsTotal,
  listenerLastHealthyTimestampSeconds,
  listenerStalenessSeconds,
  listenerHealthState,
  listenerConsecutiveFailures,
  eventProcessingLagSeconds,
  listenerHealthTransitionsTotal,
  registrationInfo,
  resolverLifecycleState,
  registrationChangesTotal,
  startTimeSeconds,
  ordersProcessedTotal,
  claimAttemptsTotal,
  refundAttemptsTotal,
  retryAttemptsTotal,
  operationDurationSeconds,
  operationFailuresTotal,
  activeOperations,
  resolverRuntimeStateInfo,
  workRejectedTotal,
  workDeduplicatedTotal,
  workDeferredTotal,
  workInFlight,
  workQueueDepth,
  orderEligibilityDecisionsTotal,
  signingKeys,
  keyRotationEventsTotal,
} as const;
