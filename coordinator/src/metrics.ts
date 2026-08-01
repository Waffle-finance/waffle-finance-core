import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();

collectDefaultMetrics({ register: registry, prefix: 'coordinator_' });

// ── Rate-limit & abuse analytics ──────────────────────────────────────────────

/** Rate-limit decision (pass vs block) per route */
export const rateLimitDecisions = new Counter({
  name: 'coordinator_rate_limit_decisions_total',
  help: 'Rate-limit decisions by route and outcome (pass|block)',
  labelNames: ['route', 'decision'] as const,
  registers: [registry],
});

/** How close a request got to the limit (0 = empty bucket, 1 = at limit) */
export const rateLimitWindowUsage = new Histogram({
  name: 'coordinator_rate_limit_window_usage_ratio',
  help: 'Bucket fullness ratio when each request arrives (0–1)',
  labelNames: ['route'] as const,
  buckets: [0.25, 0.5, 0.75, 0.9, 0.95, 0.99, 1],
  registers: [registry],
});

/** Blocked IPs *actively* rate-limited in the last window (tracked by abuse detector) */
export const rateLimitActiveBlocks = new Gauge({
  name: 'coordinator_rate_limit_active_blocks',
  help: 'Number of unique IPs currently rate-limited by route',
  labelNames: ['route'] as const,
  registers: [registry],
});

/** IPs that hit rate limits on ≥2 distinct routes within the abuse window */
export const rateLimitMultiRouteAbusers = new Gauge({
  name: 'coordinator_rate_limit_multi_route_abusers',
  help: 'IPs hitting rate limits on multiple routes (enumeration signal)',
  registers: [registry],
});

/** Total orders by status and direction labels */
export const ordersTotal = new Counter({
  name: 'coordinator_orders_total',
  help: 'Total number of orders by status and direction',
  labelNames: ['status', 'direction'] as const,
  registers: [registry],
});

/** Database query duration histogram */
export const dbQueryDuration = new Histogram({
  name: 'coordinator_db_query_duration_seconds',
  help: 'Duration of database queries in seconds',
  labelNames: ['operation'] as const,
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5],
  registers: [registry],
});

/** Repository transaction retries by operation */
export const repositoryTransactionRetries = new Counter({
  name: 'coordinator_repository_transaction_retries_total',
  help: 'Number of repository transaction retries by operation',
  labelNames: ['operation'] as const,
  registers: [registry],
});

/** Repository transaction deadlocks */
export const repositoryTransactionDeadlocks = new Counter({
  name: 'coordinator_repository_transaction_deadlocks_total',
  help: 'Number of repository transaction deadlocks detected',
  registers: [registry],
});

/** Last block number seen by each listener */
export const listenerLastBlock = new Gauge({
  name: 'coordinator_listener_last_block',
  help: 'Most recent block processed by each chain listener',
  labelNames: ['chain'] as const,
  registers: [registry],
});

/** Coordinator dependency health mode exposed for operators and dashboards */
export const coordinatorDependencyHealth = new Gauge({
  name: 'coordinator_dependency_health',
  help: 'Current coordinator dependency health mode (healthy=1, partially_healthy=1, degraded=1)',
  labelNames: ['mode'] as const,
  registers: [registry],
});

/** Latest chain head observed by each listener */
export const listenerHeadBlock = new Gauge({
  name: 'coordinator_listener_head_block',
  help: 'Most recent chain head observed by each listener',
  labelNames: ['chain'] as const,
  registers: [registry],
});

/** Difference between the observed chain head and processed listener block */
export const listenerLagBlocks = new Gauge({
  name: 'coordinator_listener_lag_blocks',
  help: 'Current listener lag in blocks, ledgers, or slots by chain',
  labelNames: ['chain'] as const,
  registers: [registry],
});

/** Event processing duration per chain and event type */
export const listenerEventProcessingDuration = new Histogram({
  name: 'coordinator_listener_event_processing_duration_seconds',
  help: 'Duration spent processing listener event batches',
  labelNames: ['chain', 'event'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [registry],
});

export function recordListenerProgress(
  chain: string,
  processedBlock: number,
  headBlock = processedBlock
): void {
  listenerLastBlock.set({ chain }, processedBlock);
  listenerHeadBlock.set({ chain }, headBlock);
  listenerLagBlocks.set({ chain }, Math.max(headBlock - processedBlock, 0));
}

export function observeListenerEventProcessing(
  chain: string,
  event: string,
  startedAtMs: number
): void {
  listenerEventProcessingDuration.observe(
    { chain, event },
    Math.max(Date.now() - startedAtMs, 0) / 1000
  );
}

/** HTTP request duration histogram */
export const httpRequestDuration = new Histogram({
  name: 'coordinator_http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [registry],
});

/** End-to-end swap completion latency in seconds */
export const swapDuration = new Histogram({
  name: 'coordinator_swap_duration_seconds',
  help: 'Time from order announcement to terminal state (completed or refunded)',
  labelNames: ['direction', 'outcome'] as const,
  buckets: [30, 60, 120, 180, 300, 600, 900, 1800, 3600],
  registers: [registry],
});

/** Active orders currently in flight */
export const activeOrders = new Gauge({
  name: 'coordinator_active_orders',
  help: 'Number of orders not yet in a terminal state',
  labelNames: ['direction'] as const,
  registers: [registry],
});

/**
 * Order lifecycle transitions counter.
 *
 * Records every successful order status transition with the direction,
 * source state, and destination state.  Enables dashboards showing
 * the flow of orders through the state machine, conversion funnels,
 * and anomaly detection (e.g. unexpected surge of `announced→failed`).
 */
export const orderLifecycleTransitions = new Counter({
  name: 'coordinator_order_lifecycle_transitions_total',
  help: 'Total successful order lifecycle transitions by direction and (from→to) state pair',
  labelNames: ['direction', 'from', 'to'] as const,
  registers: [registry],
});

/**
 * Duration an order spent in a given non-terminal state before transitioning.
 *
 * Measured as the wall-clock time (seconds) between the last state change
 * and the current transition.  Use this to build heatmaps of state dwell
 * times and alert on abnormally long lock periods.
 *
 * Only recorded when transitioning OUT of a state, so the initial
 * `announced` state is captured on the first transition.
 */
export const orderStateDuration = new Histogram({
  name: 'coordinator_order_state_duration_seconds',
  help: 'Wall-clock seconds an order spent in a given state before transitioning',
  labelNames: ['direction', 'state'] as const,
  buckets: [5, 10, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200],
  registers: [registry],
});

/**
 * Invalid transition attempts counter.
 *
 * Incremented whenever an order tries to transition from one status to
 * another in a way that violates the state machine rules.  A non-zero
 * rate indicates a bug in the listener or manual operator action.
 */
export const orderInvalidTransitions = new Counter({
  name: 'coordinator_order_invalid_transitions_total',
  help: 'Total invalid state transition attempts by (from→to) pair',
  labelNames: ['from', 'to'] as const,
  registers: [registry],
});

/**
 * Current order state distribution.
 *
 * A gauge set per (direction, status) pair reflecting the instantaneous
 * count of orders in each state.  Useful for at-a-glance dashboards and
 * alerting on orders stuck in intermediate states.
 */
export const orderCurrentState = new Gauge({
  name: 'coordinator_order_current_state',
  help: 'Instantaneous count of orders in each state by direction',
  labelNames: ['direction', 'state'] as const,
  registers: [registry],
});

/** Reconciliation runs by result */
export const reconciliationRuns = new Counter({
  name: 'coordinator_reconciliation_runs_total',
  help: 'Total reconciliation runs by result (success|failure)',
  labelNames: ['result'] as const,
  registers: [registry],
});

/** Reconciliation errors */
export const reconciliationErrors = new Counter({
  name: 'coordinator_reconciliation_errors_total',
  help: 'Total reconciliation run failures',
  registers: [registry],
});

/** Unix timestamp of last completed reconciliation run */
export const reconciliationLastRun = new Gauge({
  name: 'coordinator_reconciliation_last_run_timestamp_seconds',
  help: 'Unix timestamp of the most recent reconciliation run',
  registers: [registry],
});

/** Total events replayed by reconciler */
export const reconciliationEventsReplayed = new Counter({
  name: 'coordinator_reconciliation_events_replayed_total',
  help: 'Total on-chain events replayed by the reconciler',
  registers: [registry],
});

/**
 * Events skipped during replay/reconciliation, by chain and reason.
 *
 * `reason` values:
 *  - `already_applied`  — the event had already been recorded in the DB
 *  - `stale_sequence`   — the incoming block/ledger/slot is older than what was last recorded
 *  - `lower_priority`   — a live-path event already claimed this slot (same sequence, lower priority path)
 *  - `order_not_found`  — the referenced hashlock/orderId has no matching order in the DB
 *  - `preimage_mismatch`— the claimed preimage does not hash to the order's hashlock
 */
export const reconciliationEventsSkipped = new Counter({
  name: 'coordinator_reconciliation_events_skipped_total',
  help: 'Total on-chain events skipped during reconciliation, by chain and reason',
  labelNames: ['chain', 'reason'] as const,
  registers: [registry],
});

/**
 * Orders whose DB state disagrees with chain-history evidence.
 *
 * Emitted during the conflict-resolution pass when the chain reports an
 * event (e.g. OrderRefunded) but the DB already has a conflicting terminal
 * state (e.g. completed).  This counter is actionable: a non-zero rate
 * warrants manual review of the named order.
 *
 * `conflict_type` values:
 *  - `chain_ahead`   — chain says more progress than DB (normal catch-up scenario)
 *  - `db_ahead`      — DB has a later-stage state than chain evidence supports
 *  - `terminal_clash`— DB is terminal but chain shows a conflicting terminal event
 */
export const reconciliationConflicts = new Counter({
  name: 'coordinator_reconciliation_conflicts_total',
  help: 'Total order state conflicts detected during reconciliation, by chain and conflict type',
  labelNames: ['chain', 'conflict_type'] as const,
  registers: [registry],
});

/**
 * Block/ledger/slot gap detected at reconciliation startup vs. the last
 * recorded processed position, by chain.
 *
 * A large gap after a restart is expected (the coordinator was offline);
 * a large gap during steady-state operation indicates a stalled listener.
 */
export const reconciliationGapBlocks = new Gauge({
  name: 'coordinator_reconciliation_gap_blocks',
  help: 'Gap between last-processed and current chain tip at reconciliation start, by chain',
  labelNames: ['chain'] as const,
  registers: [registry],
});

/**
 * Lookback window actually covered by the most recent reconciliation pass,
 * expressed in blocks/ledgers/slots, by chain.
 *
 * Allows operators to verify the reconciler is scanning a meaningful range
 * after a restart (e.g. if the gap was 50 000 blocks but the lookback window
 * is only 14 400, some events may have been permanently missed).
 */
export const reconciliationLookbackCoverage = new Gauge({
  name: 'coordinator_reconciliation_lookback_coverage_blocks',
  help: 'Number of blocks/ledgers/slots covered by the most recent reconciliation lookback window, by chain',
  labelNames: ['chain'] as const,
  registers: [registry],
});

/**
 * Recovery events processed by restart-recovery path, by chain.
 *
 * Incremented once per on-chain event successfully applied during the
 * post-restart catch-up window (gap > normal lookback).  Distinct from
 * `reconciliation_events_replayed_total` which covers steady-state replay.
 */
export const reconciliationRestartRecoveryEvents = new Counter({
  name: 'coordinator_reconciliation_restart_recovery_events_total',
  help: 'Total events applied during post-restart gap recovery, by chain',
  labelNames: ['chain'] as const,
  registers: [registry],
});

/**
 * Ambiguous order states detected: orders whose current DB status cannot be
 * deterministically confirmed against chain history (e.g. appears in two
 * different terminal states across listeners).  Requires manual operator action.
 */
export const reconciliationAmbiguousStates = new Counter({
  name: 'coordinator_reconciliation_ambiguous_states_total',
  help: 'Orders whose state could not be deterministically resolved during reconciliation, by chain',
  labelNames: ['chain'] as const,
  registers: [registry],
});

/** Dispatch outcomes for live/replay/recovery event paths */
export const workflowDispatchDecisions = new Counter({
  name: 'coordinator_workflow_dispatch_decisions_total',
  help: 'Event dispatch decisions by path, mutation, and outcome',
  labelNames: ['path', 'mutation', 'outcome'] as const,
  registers: [registry],
});

/** Stale cleanup runs (success | failure) */
export const staleCleanupRuns = new Counter({
  name: 'coordinator_stale_cleanup_runs_total',
  help: 'Total stale order cleanup runs by result',
  labelNames: ['result'] as const,
  registers: [registry],
});

/** Orders archived (soft-deleted) by the stale cleanup service */
export const staleOrdersArchived = new Counter({
  name: 'coordinator_stale_orders_archived_total',
  help: 'Total stale announced orders archived by the cleanup service (no src lock within retention window)',
  registers: [registry],
});

/**
 * Orders skipped by stale cleanup because they already had an archived_at timestamp.
 *
 * Distinct from `staleOrdersArchived` — this counter captures re-runs landing
 * on already-archived rows, which are excluded by the candidate query.  In
 * normal operation this should always be zero; a non-zero value indicates
 * the candidate query is returning already-archived rows.
 */
export const staleCleanupAlreadyArchivedSkipped = new Counter({
  name: 'coordinator_stale_cleanup_already_archived_skipped_total',
  help: 'Stale cleanup passes that found orders already archived (indicates candidate query drift)',
  registers: [registry],
});

/** Unix timestamp of the last completed stale cleanup run */
export const staleCleanupLastRun = new Gauge({
  name: 'coordinator_stale_cleanup_last_run_timestamp_seconds',
  help: 'Unix timestamp of the most recent stale order cleanup run (archival of orphaned announced orders)',
  registers: [registry],
});

/** Resolver participation per operation */
export const resolverLockActionsTotal = new Counter({
  name: 'coordinator_resolver_lock_actions_total',
  help: 'Total resolver lock actions by resolver address and action type',
  labelNames: ['resolver_address', 'action'] as const,
  registers: [registry],
});

/** Expiry scan runs (success | failure) */
export const expiryScanRuns = new Counter({
  name: 'coordinator_expiry_scan_runs_total',
  help: 'Total order expiry scan runs by result (success|failure)',
  labelNames: ['result'] as const,
  registers: [registry],
});

/** Orders transitioned to `expired` by the periodic expiry scan */
export const ordersExpiredTotal = new Counter({
  name: 'coordinator_orders_expired_total',
  help: 'Total orders marked expired by the periodic timelock scan',
  registers: [registry],
});

/**
 * Orders skipped by expireStaleOrders because they were already in the
 * `expired` state when the scan ran.
 *
 * Distinct from `ordersExpiredTotal` — this counter captures idempotent
 * no-op skips (already expired) rather than newly-expired transitions.
 * A high ratio of skipped:expired indicates the scan is running more
 * frequently than orders are being resolved or refunded after expiry.
 */
export const ordersExpiredSkippedTotal = new Counter({
  name: 'coordinator_orders_expired_skipped_total',
  help: 'Orders skipped by the expiry scan because they were already in the expired state',
  registers: [registry],
});

/**
 * Orders skipped by expireStaleOrders because they are in a terminal state
 * (completed / refunded / failed) that cannot be expired.
 *
 * Distinct from stale-cleanup, which operates on announced-only orders.
 * This counter represents timelock-scan candidates that were already settled,
 * and is expected to be zero in normal operation (the candidate query should
 * filter these out).  A non-zero count indicates a query correctness issue.
 */
export const ordersExpiredTerminalSkippedTotal = new Counter({
  name: 'coordinator_orders_expired_terminal_skipped_total',
  help: 'Orders skipped by the expiry scan because they are already in a terminal state',
  registers: [registry],
});

/** Unix timestamp of the last completed expiry scan */
export const expiryScanLastRun = new Gauge({
  name: 'coordinator_expiry_scan_last_run_timestamp_seconds',
  help: 'Unix timestamp of the most recent successful order expiry scan',
  registers: [registry],
});

/**
 * Soroban event decode failures.
 *
 * Incremented whenever a Soroban contract event cannot be decoded —
 * either because `scValToNative` throws on malformed XDR, or because
 * the first topic is an unknown symbol not matching our HTLC events.
 * A non-zero rate here indicates a contract ABI drift or a bad RPC node.
 */
export const sorobanDecodeErrors = new Counter({
  name: 'coordinator_soroban_decode_errors_total',
  help: 'Total Soroban contract events that could not be decoded, by reason',
  labelNames: ['reason'] as const,
  registers: [registry],
});

// ── Cache verifier metrics ────────────────────────────────────────────────────

/**
 * Total cache verification runs by result.
 *
 * A "run" is one complete pass of the CacheVerifier comparing a sample of
 * cached coordinator order state against authoritative on-chain evidence.
 */
export const cacheVerifierRuns = new Counter({
  name: 'coordinator_cache_verifier_runs_total',
  help: 'Total cache verification runs by result (success|failure|skipped)',
  labelNames: ['result'] as const,
  registers: [registry],
});

/**
 * Total mismatch events detected by the cache verifier, by chain and mismatch type.
 *
 * A mismatch is any discrepancy where the coordinator's DB status for an order
 * does not agree with the status implied by the on-chain evidence (e.g. DB
 * says `announced` but chain has an `OrderCreated` event with that hashlock).
 */
export const cacheVerifierMismatches = new Counter({
  name: 'coordinator_cache_verifier_mismatches_total',
  help: 'Total cache/chain mismatches detected by the cache verifier, by chain and mismatch type',
  labelNames: ['chain', 'mismatch_type'] as const,
  registers: [registry],
});

/**
 * Number of orders sampled during the most recent cache verification run.
 *
 * Allows operators to confirm the verifier is actually checking a non-trivial
 * sample rather than trivially succeeding because no orders were inspected.
 */
export const cacheVerifierSampleSize = new Gauge({
  name: 'coordinator_cache_verifier_sample_size',
  help: 'Number of orders sampled in the most recent cache verification run',
  registers: [registry],
});

/**
 * Unix timestamp of the most recently completed cache verification run.
 */
export const cacheVerifierLastRun = new Gauge({
  name: 'coordinator_cache_verifier_last_run_timestamp_seconds',
  help: 'Unix timestamp of the most recent cache verification run',
  registers: [registry],
});

/**
 * Number of mismatches found in the most recent run.
 *
 * Exposed as a gauge (not a counter) so an alert can fire when this value is
 * > 0 after a fresh run, and auto-resolve when the cache re-synchronises.
 */
export const cacheVerifierLastRunMismatches = new Gauge({
  name: 'coordinator_cache_verifier_last_run_mismatches',
  help: 'Number of cache/chain mismatches found in the most recent verification run',
  registers: [registry],
});

/**
 * Set to 1 when SOLANA_HTLC_PROGRAM is a placeholder and the Solana
 * listener is disabled; 0 when a real program address is configured.
 *
 * Mirrors the `relayer_solana_placeholder_mode` gauge in the relayer so
 * both services expose the same observable signal.  An alert on this
 * gauge lets operators know Solana flows are inactive before they start
 * wondering why SOL→ETH swaps never complete.
 */
export const solanaPlaceholderMode = new Gauge({
  name: 'coordinator_solana_placeholder_mode',
  help: '1 when SOLANA_HTLC_PROGRAM is a placeholder and Solana flows are disabled, 0 when configured',
  registers: [registry],
});

// ── Maintenance scheduler metrics ─────────────────────────────────────────────

/**
 * Total maintenance job executions by job name and result.
 *
 * `job` label values correspond to the names registered with
 * `MaintenanceScheduler.register()` — e.g. `expiry_scan`, `stale_cleanup`,
 * `archival_policy`.
 *
 * `result` is `success` or `failure`.
 *
 * Use this to alert when a job's failure rate rises above a threshold, or
 * when a job stops running altogether (counter stops incrementing).
 */
export const maintenanceRunsTotal = new Counter({
  name: 'coordinator_maintenance_runs_total',
  help: 'Total maintenance job executions by job name and result',
  labelNames: ['job', 'result'] as const,
  registers: [registry],
});

/**
 * Wall-clock seconds each maintenance job took per execution.
 *
 * Useful for spotting regressions where a cleanup job is suddenly taking
 * much longer than normal — often a sign of table-scan performance
 * degradation as the orders table grows.
 */
export const maintenanceJobDuration = new Histogram({
  name: 'coordinator_maintenance_job_duration_seconds',
  help: 'Wall-clock seconds each maintenance job execution took',
  labelNames: ['job'] as const,
  buckets: [0.005, 0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [registry],
});

/**
 * Unix timestamp (seconds) of the last successful completion of each
 * maintenance job.
 *
 * Alert rule: `time() - coordinator_maintenance_last_run_timestamp_seconds{job="expiry_scan"} > 2 * cadence`
 * fires when the job has not run within twice its configured cadence.
 */
export const maintenanceLastRun = new Gauge({
  name: 'coordinator_maintenance_last_run_timestamp_seconds',
  help: 'Unix timestamp of the last successful maintenance job run, by job name',
  labelNames: ['job'] as const,
  registers: [registry],
});

/**
 * Total maintenance job invocations that were skipped because the previous
 * run of the same job was still in flight at tick time.
 *
 * A non-zero rate is normal under transient load spikes.  A sustained high
 * rate means the job's cadence is shorter than its execution time — the
 * cadence multiplier should be increased or the job should be made faster.
 */
export const maintenanceSkippedTotal = new Counter({
  name: 'coordinator_maintenance_skipped_total',
  help: 'Maintenance job tick invocations skipped because the previous run was still in flight',
  labelNames: ['job'] as const,
  registers: [registry],
});

/** All maintenance scheduler metrics in one object — useful for test assertions. */
export const maintenanceMetrics = {
  runsTotal: maintenanceRunsTotal,
  jobDuration: maintenanceJobDuration,
  lastRun: maintenanceLastRun,
  skippedTotal: maintenanceSkippedTotal,
} as const;

// ── Event-state transition metrics ────────────────────────────────────────────

/**
 * Total transition events appended to the order_events durable audit trail.
 *
 * `event_type` corresponds to the values written by OrdersRepository, e.g.
 * `src_lock.transitioned`, `src_lock.no_op`, `secret_revealed.transitioned`.
 * A sustained no_op rate for a given event_type signals replay storms or a
 * misconfigured listener delivering stale events.
 */
export const orderTransitionEventsTotal = new Counter({
  name: 'coordinator_order_transition_events_total',
  help: 'Total transition events appended to the order_events table, by event_type',
  labelNames: ['event_type'] as const,
  registers: [registry],
});

// ── Secret recovery metrics ───────────────────────────────────────────────────

/**
 * Total secret recovery attempts, classified by outcome.
 *
 * `outcome` values: `recovered`, `already_known`, `invalid_preimage`,
 * `state_conflict`, `error`.
 *
 * Use this to track the health of the recovery engine over time and alert
 * when `invalid_preimage` or `error` rates rise unexpectedly.
 */
export const secretRecoveryOutcomeTotal = new Counter({
  name: 'coordinator_secret_recovery_outcome_total',
  help: 'Total secret recovery attempts classified by outcome',
  labelNames: ['outcome'] as const,
  registers: [registry],
});
