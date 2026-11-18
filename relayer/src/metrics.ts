/**
 * Prometheus-compatible metrics for the WaffleFinance relayer.
 *
 * All metrics live in a dedicated registry (not the global default) so
 * tests can instantiate a clean registry per-run without cross-
 * contamination, and so the relayer can be embedded in other processes
 * without polluting their default metrics.
 *
 * Metric naming follows the Prometheus convention:
 *   <namespace>_<subsystem>_<name>_<unit>
 *
 * Security note: no metric label carries order-level data (addresses,
 * amounts, hashlocks). Labels are limited to reason codes and status
 * strings so the /metrics endpoint is safe to expose internally.
 */

import {
  Registry,
  Counter,
  Gauge,
  Histogram,
  collectDefaultMetrics,
} from 'prom-client';

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Shared registry for all relayer metrics. Export it so the /metrics
 * HTTP handler can call `registry.metrics()`.
 */
export const registry = new Registry();

// Attach Node.js process metrics (heap, GC, event loop lag, etc.) to our
// registry rather than the global default. Pass `register: registry` so
// they are scoped to this relayer instance.
collectDefaultMetrics({ register: registry });

// ---------------------------------------------------------------------------
// Refund Watchdog counters
// ---------------------------------------------------------------------------

/**
 * Total number of watchdog tick executions that completed without an
 * unhandled error ΓÇö i.e. the scan loop ran to completion regardless of
 * whether any individual order refund inside the tick succeeded or failed.
 */
export const watchdogRunsTotal = new Counter({
  name: 'relayer_refund_watchdog_runs_total',
  help: 'Total number of refund watchdog scan ticks executed',
  registers: [registry],
});

/**
 * Total number of individual order refunds that succeeded (Stellar tx
 * submitted and confirmed hash returned).
 */
export const watchdogRefundSuccessTotal = new Counter({
  name: 'relayer_refund_watchdog_success_total',
  help: 'Total number of XLM refunds successfully submitted by the watchdog',
  labelNames: ['network_mode'] as const,
  registers: [registry],
});

/**
 * Total number of individual order refunds that failed. The `reason`
 * label holds a short, sanitised error category (not the raw error
 * message) to keep the cardinality of label combinations bounded.
 *
 * Defined reason values:
 *   missing_address  ΓÇö order has no stellarAddress
 *   refund_error     ΓÇö refundXlmToUser threw
 */
export const watchdogRefundFailureTotal = new Counter({
  name: 'relayer_refund_watchdog_failure_total',
  help: 'Total number of XLM refund attempts that failed in the watchdog',
  labelNames: ['reason', 'network_mode'] as const,
  registers: [registry],
});

/**
 * Total number of stale orders detected (age >= staleAfterMs) during
 * any tick, regardless of whether refund was attempted or skipped
 * (e.g. due to back-off).
 */
export const watchdogStaleOrdersDetected = new Counter({
  name: 'relayer_refund_watchdog_stale_orders_detected_total',
  help: 'Total number of stale orders identified by the refund watchdog',
  registers: [registry],
});

/**
 * Total number of orders skipped during a tick because they were still
 * within the 10-minute back-off window after a previous failure.
 */
export const watchdogBackoffSkipsTotal = new Counter({
  name: 'relayer_refund_watchdog_backoff_skips_total',
  help: 'Total number of stale orders skipped due to post-failure back-off',
  registers: [registry],
});

// ---------------------------------------------------------------------------
// Refund Watchdog gauges
// ---------------------------------------------------------------------------

/**
 * Unix timestamp (seconds) of the last successful watchdog tick.
 * Stays at 0 until the first tick completes. An alert rule can fire
 * when `time() - relayer_refund_watchdog_last_run_timestamp_seconds > 2 * interval`.
 */
export const watchdogLastRunTimestamp = new Gauge({
  name: 'relayer_refund_watchdog_last_run_timestamp_seconds',
  help: 'Unix timestamp of the last completed refund watchdog scan tick',
  registers: [registry],
});

/**
 * Age in seconds of the oldest stale order found in the last tick.
 * Useful for alert rules: if this keeps climbing, refunds are not landing.
 * Resets to 0 when no stale orders are found.
 */
export const watchdogMaxStaleAgeSeconds = new Gauge({
  name: 'relayer_refund_watchdog_max_stale_age_seconds',
  help: 'Age in seconds of the oldest stale order seen in the last watchdog tick',
  registers: [registry],
});

/**
 * Current number of orders in the active map that are in a stale/pending
 * refund state. Sampled at each tick.
 */
export const watchdogPendingRefundsGauge = new Gauge({
  name: 'relayer_refund_watchdog_pending_refunds',
  help: 'Number of orders currently awaiting a watchdog refund attempt',
  registers: [registry],
});

// ---------------------------------------------------------------------------
// Refund Watchdog histogram
// ---------------------------------------------------------------------------

/**
 * Duration in seconds of each full watchdog tick (scanning all active
 * orders). Lets you spot ticks that are unusually slow.
 */
export const watchdogTickDurationSeconds = new Histogram({
  name: 'relayer_refund_watchdog_tick_duration_seconds',
  help: 'Duration of a full refund watchdog tick in seconds',
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10],
  registers: [registry],
});

// ---------------------------------------------------------------------------
// Solana configuration
// ---------------------------------------------------------------------------

/**
 * Set to 1 when SOLANA_HTLC_PROGRAM is a placeholder (Solana flows
 * disabled), or 0 when a real program address is configured.
 * Useful for alerting operators that Solana support is inactive.
 */
export const solanaPlaceholderMode = new Gauge({
  name: 'relayer_solana_placeholder_mode',
  help: '1 when SOLANA_HTLC_PROGRAM is a placeholder and Solana flows are disabled, 0 when configured',
  registers: [registry],
});

// ---------------------------------------------------------------------------
// XLM refund service counters
// ---------------------------------------------------------------------------

/**
 * Total refund submissions suppressed because the RefundLedger already
 * holds a committed or in-flight entry for that orderId. This is the
 * primary signal for exactly-once compliance.
 */
export const refundDuplicatesSuppressed = new Counter({
  name: 'relayer_xlm_refund_duplicates_suppressed_total',
  help: 'Total XLM refund attempts suppressed by the RefundLedger idempotency guard',
  labelNames: ['network_mode'] as const,
  registers: [registry],
});

/**
 * Total Horizon submit calls that returned a 504, 408, or network-level
 * timeout. These are *ambiguous* — the tx may have landed. Callers should
 * mark the order ambiguous in the RefundLedger and not retry immediately.
 */
export const refundHorizonTimeouts = new Counter({
  name: 'relayer_xlm_refund_horizon_timeouts_total',
  help: 'Total Horizon submit calls that returned a timeout or 504 (ambiguous outcome)',
  labelNames: ['network_mode'] as const,
  registers: [registry],
});

/**
 * Total intra-call retries performed for transient (non-terminal, non-timeout)
 * Horizon errors inside refundXlmToUser. One unit = one retry attempt, not
 * one overall refund invocation.
 */
export const refundHorizonRetries = new Counter({
  name: 'relayer_xlm_refund_horizon_retries_total',
  help: 'Total transient-error retries inside refundXlmToUser',
  labelNames: ['network_mode'] as const,
  registers: [registry],
});

// ---------------------------------------------------------------------------
// Convenience re-export
// ---------------------------------------------------------------------------

/** All watchdog metrics in one object ΓÇö useful for test assertions. */
export const watchdogMetrics = {
  runsTotal: watchdogRunsTotal,
  successTotal: watchdogRefundSuccessTotal,
  failureTotal: watchdogRefundFailureTotal,
  staleDetected: watchdogStaleOrdersDetected,
  backoffSkips: watchdogBackoffSkipsTotal,
  lastRunTimestamp: watchdogLastRunTimestamp,
  maxStaleAge: watchdogMaxStaleAgeSeconds,
  pendingRefunds: watchdogPendingRefundsGauge,
  tickDuration: watchdogTickDurationSeconds,
} as const;

/** All XLM refund service metrics in one object — useful for test assertions. */
export const refundMetrics = {
  duplicatesSuppressed: refundDuplicatesSuppressed,
  horizonTimeouts: refundHorizonTimeouts,
  horizonRetries: refundHorizonRetries,
} as const;

// ---------------------------------------------------------------------------
// XLM→ETH settlement path counters
// ---------------------------------------------------------------------------

/**
 * Total Horizon verification attempts on the XLM→ETH settlement path.
 *
 * `result` label values:
 *   success          — payment verified; ETH release proceeded
 *   tx_not_found     — stellarTxHash unknown to Horizon (StellarTxNotFoundError)
 *   tx_failed        — tx was submitted but failed on-chain (StellarTxFailedError)
 *   payment_mismatch — tx exists but payment shape is wrong (StellarPaymentMismatch)
 *   horizon_error    — unexpected Horizon / network error
 */
export const settlementVerificationTotal = new Counter({
  name: 'relayer_xlm_to_eth_verification_total',
  help: 'Total Horizon verification attempts on the XLM→ETH settlement path',
  labelNames: ['result', 'network_mode'] as const,
  registers: [registry],
});

/**
 * Total requests rejected because the stellarTxHash was already consumed.
 * Each increment represents one replayed (or retried) proof that was blocked
 * before any ETH was sent.
 */
export const settlementProofReplaysTotal = new Counter({
  name: 'relayer_xlm_to_eth_proof_replays_total',
  help: 'Total XLM→ETH settlement requests rejected due to a replayed stellarTxHash',
  labelNames: ['network_mode'] as const,
  registers: [registry],
});

/** All XLM→ETH settlement metrics in one object — useful for test assertions. */
export const settlementMetrics = {
  verificationTotal: settlementVerificationTotal,
  proofReplaysTotal: settlementProofReplaysTotal,
} as const;

// ---------------------------------------------------------------------------
// Correlation context metrics  (feature a)
// ---------------------------------------------------------------------------

/**
 * Total relay operations entered via `withCorrelation`, labelled by outcome
 * and route. Lets operators count how many relay attempts succeeded / failed
 * per bridge direction.
 */
export const correlationOpsTotal = new Counter({
  name: 'relayer_correlation_ops_total',
  help: 'Total relay operations tracked by the correlation context',
  labelNames: ['route', 'outcome'] as const,
  registers: [registry],
});

/**
 * Total lifecycle checkpoints reached across all relay operations, labelled
 * by checkpoint name and route. A checkpoint series per order lets operators
 * reconstruct the path taken through the relay pipeline from logs + metrics.
 */
export const correlationCheckpointsTotal = new Counter({
  name: 'relayer_correlation_checkpoints_total',
  help: 'Total relay lifecycle checkpoints recorded by the correlation context',
  labelNames: ['checkpoint', 'route'] as const,
  registers: [registry],
});

/**
 * Duration histogram for relay operations. Separate from individual RPC
 * timings — measures total wall-clock time from withCorrelation entry to exit.
 */
export const correlationOpDurationSeconds = new Histogram({
  name: 'relayer_correlation_op_duration_seconds',
  help: 'Wall-clock duration of a full relay operation from start to completion or failure',
  labelNames: ['route'] as const,
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120],
  registers: [registry],
});

/**
 * Total retry hops recorded inside correlation scopes, labelled by route and
 * reason. Operators can track whether retries are dominated by RPC rate limits,
 * chain confirmation gaps, or Horizon timeouts.
 */
export const correlationRetryHopsTotal = new Counter({
  name: 'relayer_correlation_retry_hops_total',
  help: 'Total intra-correlation retry hops (each incrementRetry call)',
  labelNames: ['route', 'reason'] as const,
  registers: [registry],
});

/** Correlation metrics bundle — useful for test assertions. */
export const correlationMetrics = {
  opsTotal: correlationOpsTotal,
  checkpointsTotal: correlationCheckpointsTotal,
  opDuration: correlationOpDurationSeconds,
  retryHops: correlationRetryHopsTotal,
} as const;

// ---------------------------------------------------------------------------
// Fee / profitability model metrics  (feature b)
// ---------------------------------------------------------------------------

/**
 * Total relay decisions made by the fee model, labelled by verdict
 * (profitable | neutral | unprofitable | error) and route.
 */
export const feeRelayDecisionsTotal = new Counter({
  name: 'relayer_fee_relay_decisions_total',
  help: 'Total relay decisions emitted by the fee model, by verdict and route',
  labelNames: ['verdict', 'route'] as const,
  registers: [registry],
});

/**
 * Estimated gas cost in USD for each relay decision. Helps operators track
 * total gas spend over time and spot fee spikes.
 */
export const feeGasCostUsdHistogram = new Histogram({
  name: 'relayer_fee_gas_cost_usd',
  help: 'Estimated gas cost in USD for each relay decision',
  labelNames: ['route'] as const,
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10, 25],
  registers: [registry],
});

/**
 * Net profit (or loss) in USD for each relay decision. Negative values
 * indicate unprofitable relays (gas + safety deposit > expected payout).
 * The histogram uses signed buckets to capture loss regions.
 */
export const feeNetProfitUsdHistogram = new Histogram({
  name: 'relayer_fee_net_profit_usd',
  help: 'Estimated net profit (payout - gas - safety deposit) in USD per relay decision',
  labelNames: ['route'] as const,
  buckets: [-10, -5, -2, -1, -0.5, 0, 0.5, 1, 2, 5, 10, 25, 50],
  registers: [registry],
});

/**
 * Safety deposit amount in USD observed at relay decision time. Useful for
 * confirming the dynamic deposit model is within expected bounds.
 */
export const feeSafetyDepositUsdHistogram = new Histogram({
  name: 'relayer_fee_safety_deposit_usd',
  help: 'Safety deposit amount in USD at relay decision time',
  labelNames: ['route'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [registry],
});

/**
 * Total number of relays skipped because the fee model determined they were
 * economically unattractive (verdict = unprofitable), labelled by route.
 */
export const feeSkippedRelaysTotal = new Counter({
  name: 'relayer_fee_skipped_relays_total',
  help: 'Total relay actions skipped by the fee model due to unprofitable verdict',
  labelNames: ['route'] as const,
  registers: [registry],
});

/** Fee model metrics bundle — useful for test assertions. */
export const feeMetrics = {
  decisionsTotal: feeRelayDecisionsTotal,
  gasCostUsd: feeGasCostUsdHistogram,
  netProfitUsd: feeNetProfitUsdHistogram,
  safetyDepositUsd: feeSafetyDepositUsdHistogram,
  skippedRelays: feeSkippedRelaysTotal,
} as const;

// ---------------------------------------------------------------------------
// Transaction state reconciliation metrics  (feature c)
// ---------------------------------------------------------------------------

/**
 * Total state transitions recorded in the TxStateStore, labelled by
 * from_state → to_state. Lets operators build a state-flow graph and spot
 * orders stuck in unexpected states.
 */
export const txStateTransitionsTotal = new Counter({
  name: 'relayer_tx_state_transitions_total',
  help: 'Total transaction state transitions in the TxStateStore',
  labelNames: ['from_state', 'to_state'] as const,
  registers: [registry],
});

/**
 * Total reconciliation sweeps run by the TxStateStore. Each sweep walks
 * all in-flight records and attempts to advance or recover them.
 */
export const txStateReconciliationsTotal = new Counter({
  name: 'relayer_tx_state_reconciliations_total',
  help: 'Total TxStateStore reconciliation sweep executions',
  labelNames: ['trigger'] as const,   // 'startup' | 'scheduled' | 'manual'
  registers: [registry],
});

/**
 * Total records recovered during a reconciliation sweep (state advanced after
 * restart or missed receipt).
 */
export const txStateRecoveredTotal = new Counter({
  name: 'relayer_tx_state_recovered_total',
  help: 'Total TxStateStore records successfully recovered during reconciliation',
  labelNames: ['recovered_to_state'] as const,
  registers: [registry],
});

/**
 * Total duplicate receipts rejected by the TxStateStore (idempotency guard).
 */
export const txStateDuplicateReceiptsTotal = new Counter({
  name: 'relayer_tx_state_duplicate_receipts_total',
  help: 'Total duplicate receipt submissions rejected by the TxStateStore',
  registers: [registry],
});

/**
 * Current number of records in each state, sampled at each reconciliation sweep.
 */
export const txStateCurrentByState = new Gauge({
  name: 'relayer_tx_state_current_by_state',
  help: 'Current count of TxStateStore records in each state',
  labelNames: ['state'] as const,
  registers: [registry],
});

/**
 * Duration of each reconciliation sweep in seconds.
 */
export const txStateReconciliationDurationSeconds = new Histogram({
  name: 'relayer_tx_state_reconciliation_duration_seconds',
  help: 'Duration of a full TxStateStore reconciliation sweep',
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5],
  registers: [registry],
});

/** TxState metrics bundle — useful for test assertions. */
export const txStateMetrics = {
  transitionsTotal: txStateTransitionsTotal,
  reconciliationsTotal: txStateReconciliationsTotal,
  recoveredTotal: txStateRecoveredTotal,
  duplicateReceipts: txStateDuplicateReceiptsTotal,
  currentByState: txStateCurrentByState,
  reconciliationDuration: txStateReconciliationDurationSeconds,
} as const;

// ---------------------------------------------------------------------------
// Retry engine metrics  (feature d)
// ---------------------------------------------------------------------------

/**
 * Total retry attempts made by the RetryEngine, labelled by fault_class
 * (transient | confirmation_delay | terminal) and action (the operation name).
 */
export const retryEngineAttemptsTotal = new Counter({
  name: 'relayer_retry_engine_attempts_total',
  help: 'Total retry attempts made by the RetryEngine',
  labelNames: ['fault_class', 'action'] as const,
  registers: [registry],
});

/**
 * Total operations that permanently failed after exhausting all retries,
 * labelled by fault_class and action.
 */
export const retryEngineExhaustedTotal = new Counter({
  name: 'relayer_retry_engine_exhausted_total',
  help: 'Total RetryEngine operations that permanently failed after all retry attempts',
  labelNames: ['fault_class', 'action'] as const,
  registers: [registry],
});

/**
 * Total operations where the circuit breaker opened (tripped after repeated
 * failures), labelled by action (the operation namespace protected).
 */
export const retryEngineCircuitOpenedTotal = new Counter({
  name: 'relayer_retry_engine_circuit_opened_total',
  help: 'Total circuit-breaker trips in the RetryEngine',
  labelNames: ['action'] as const,
  registers: [registry],
});

/**
 * Total operations blocked by an open circuit breaker (fast-fail before
 * attempting the underlying operation), labelled by action.
 */
export const retryEngineCircuitRejectedTotal = new Counter({
  name: 'relayer_retry_engine_circuit_rejected_total',
  help: 'Total calls fast-failed by an open circuit breaker in the RetryEngine',
  labelNames: ['action'] as const,
  registers: [registry],
});

/**
 * Current circuit breaker state as a gauge: 0 = closed (healthy), 1 = open
 * (failing fast). Useful for alerting on persistent circuit trips.
 */
export const retryEngineCircuitState = new Gauge({
  name: 'relayer_retry_engine_circuit_state',
  help: '1 when the circuit breaker is open (failing fast), 0 when closed',
  labelNames: ['action'] as const,
  registers: [registry],
});

/**
 * Backoff delay duration histogram. Records the actual delay applied before
 * each retry so operators can verify the backoff progression.
 */
export const retryEngineBackoffSeconds = new Histogram({
  name: 'relayer_retry_engine_backoff_seconds',
  help: 'Backoff delay applied before each retry attempt',
  labelNames: ['fault_class', 'action'] as const,
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
  registers: [registry],
});

/** Retry engine metrics bundle — useful for test assertions. */
export const retryEngineMetrics = {
  attemptsTotal: retryEngineAttemptsTotal,
  exhaustedTotal: retryEngineExhaustedTotal,
  circuitOpenedTotal: retryEngineCircuitOpenedTotal,
  circuitRejectedTotal: retryEngineCircuitRejectedTotal,
  circuitState: retryEngineCircuitState,
  backoffSeconds: retryEngineBackoffSeconds,
} as const;

// ---------------------------------------------------------------------------
// Settlement service metrics
// ---------------------------------------------------------------------------

/**
 * Total settlement attempts made by the SettlementService, labelled by
 * direction (eth_to_xlm / xlm_to_eth) and failure_category.
 *
 * failure_category values:
 *   none              — attempt succeeded (no failure)
 *   transient         — retryable error (RPC timeout, rate limit, etc.)
 *   terminal          — non-retryable error (bad auth, insufficient funds)
 *   confirmation_delay — tx submitted but not yet mined
 *   unknown           — unclassified error
 */
export const settlementAttemptsTotal = new Counter({
  name: 'relayer_settlement_attempts_total',
  help: 'Total settlement attempts by direction and failure category',
  labelNames: ['direction', 'failure_category'] as const,
  registers: [registry],
});

/**
 * Total settlement failures (exhausted all retries or hit a terminal error),
 * labelled by direction and failure_category.
 */
export const settlementFailuresTotal = new Counter({
  name: 'relayer_settlement_failures_total',
  help: 'Total settlement failures after retries exhausted, by direction and failure category',
  labelNames: ['direction', 'failure_category'] as const,
  registers: [registry],
});

/**
 * Total settlement recoveries initiated via the recovery endpoint or
 * automatic reconciliation, labelled by direction and trigger
 * (manual / scheduled / startup).
 */
export const settlementRecoveryTotal = new Counter({
  name: 'relayer_settlement_recovery_total',
  help: 'Total settlement recovery actions initiated',
  labelNames: ['direction', 'trigger'] as const,
  registers: [registry],
});

/**
 * Current number of orders in each intermediate settlement state.
 * Sampled after every state transition.
 */
export const settlementStateGauge = new Gauge({
  name: 'relayer_settlement_state_current',
  help: 'Current count of settlement orders in each intermediate state',
  labelNames: ['state'] as const,
  registers: [registry],
});

/**
 * Duration histogram for the full settlement lifecycle, from order acceptance
 * to terminal state (complete or terminal_failure).
 */
export const settlementDurationSeconds = new Histogram({
  name: 'relayer_settlement_duration_seconds',
  help: 'Duration of full settlement lifecycle in seconds',
  labelNames: ['direction', 'outcome'] as const,
  buckets: [1, 5, 15, 30, 60, 120, 300, 600],
  registers: [registry],
});

/** Settlement service metrics bundle. */
export const settlementServiceMetrics = {
  attemptsTotal: settlementAttemptsTotal,
  failuresTotal: settlementFailuresTotal,
  recoveryTotal: settlementRecoveryTotal,
  stateGauge: settlementStateGauge,
  durationSeconds: settlementDurationSeconds,
} as const;

// ---------------------------------------------------------------------------
// Settlement success counter (#756)
// ---------------------------------------------------------------------------

/**
 * Total settlement actions that reached terminal success (txHash confirmed
 * on the destination chain). Complements settlementAttemptsTotal — success
 * is identifiable directly without a negative filter on failure_category.
 */
export const settlementSuccessTotal = new Counter({
  name: 'relayer_settlement_success_total',
  help: 'Total settlement actions that reached terminal success (txHash confirmed)',
  labelNames: ['direction'] as const,
  registers: [registry],
});

// ---------------------------------------------------------------------------
// Refund latency histogram (#756)
// ---------------------------------------------------------------------------

/**
 * Time in seconds from when the watchdog first detects a stale order to when
 * the XLM refund is confirmed on Stellar.
 */
export const refundLatencySeconds = new Histogram({
  name: 'relayer_refund_latency_seconds',
  help: 'Time in seconds from stale-order detection to refund confirmation',
  labelNames: ['chain', 'network_mode'] as const,
  buckets: [1, 5, 15, 30, 60, 120, 300, 600, 1800],
  registers: [registry],
});

// ---------------------------------------------------------------------------
// Recovery time histogram (#756)
// ---------------------------------------------------------------------------

/**
 * Wall-clock time in seconds for a full recovery operation from initiation to
 * completion (success or failure). Labels distinguish recovery type and outcome.
 */
export const recoveryTimeSeconds = new Histogram({
  name: 'relayer_recovery_time_seconds',
  help: 'Wall-clock time in seconds for a full recovery operation (initiation to completion)',
  labelNames: ['recovery_type', 'outcome'] as const,
  buckets: [0.5, 1, 2, 5, 10, 30, 60, 120, 300],
  registers: [registry],
});

// ---------------------------------------------------------------------------
// RPC error counter (#756)
// ---------------------------------------------------------------------------

/**
 * Total RPC call errors by chain and error type. Provides a chain-dimensioned
 * view of RPC errors that complements the RetryEngine's fault_class label.
 *
 * error_type values:
 *   rpc_timeout       — the RPC call exceeded its timeout budget
 *   rpc_error         — the RPC returned an error response
 *   connection_error  — network-level connection failure
 */
export const rpcErrorsTotal = new Counter({
  name: 'relayer_rpc_errors_total',
  help: 'Total RPC call errors by chain and error type',
  labelNames: ['chain', 'error_type'] as const,
  registers: [registry],
});

// ---------------------------------------------------------------------------
// Order queue depth by direction gauge (#756)
// ---------------------------------------------------------------------------

/**
 * Current number of in-memory active orders broken down by direction.
 * Enables alerting on a direction-specific backlog (e.g. Stellar-only stall)
 * without requiring a filter on the aggregate orderQueueDepth gauge.
 */
export const orderQueueDepthByDirection = new Gauge({
  name: 'relayer_order_queue_depth_by_direction',
  help: 'Current number of in-memory active orders, by direction',
  labelNames: ['direction'] as const,
  registers: [registry],
});

/** Refund + recovery + rpc metrics bundle — useful for test assertions. */
export const refundAndRecoveryMetrics = {
  refundLatency: refundLatencySeconds,
  recoveryTime: recoveryTimeSeconds,
  rpcErrors: rpcErrorsTotal,
  queueDepthByDirection: orderQueueDepthByDirection,
} as const;

// ---------------------------------------------------------------------------
// Pipeline metrics (order ingestion, relay decisions, latency)
// ---------------------------------------------------------------------------

export const orderIngestionTotal = new Counter({
  name: 'relayer_order_ingestion_total',
  help: 'Total orders received at the ingestion boundary, before any policy checks',
  labelNames: ['direction'] as const,
  registers: [registry],
});

export const orderQueueDepth = new Gauge({
  name: 'relayer_order_queue_depth',
  help: 'Current number of in-memory active orders',
  registers: [registry],
});

export const relayDecisionTotal = new Counter({
  name: 'relayer_relay_decision_total',
  help: 'Total relay decisions (accepted / rejected_route / rejected_permissions)',
  labelNames: ['direction', 'result'] as const,
  registers: [registry],
});

export const submissionLatencySeconds = new Histogram({
  name: 'relayer_submission_latency_seconds',
  help: 'Time from order acceptance to ETH/XLM transaction broadcast',
  labelNames: ['direction', 'result'] as const,
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
  registers: [registry],
});

export const receiptLatencySeconds = new Histogram({
  name: 'relayer_receipt_latency_seconds',
  help: 'Time to receive on-chain confirmation after broadcast',
  labelNames: ['result'] as const,
  buckets: [1, 5, 15, 30, 60, 120, 300],
  registers: [registry],
});

export const retryAttemptsHistogram = new Histogram({
  name: 'relayer_retry_attempts',
  help: 'Number of retry attempts per operation',
  labelNames: ['operation', 'result'] as const,
  buckets: [0, 1, 2, 3, 4, 5],
  registers: [registry],
});

export const droppedOrdersTotal = new Counter({
  name: 'relayer_dropped_orders_total',
  help: 'Total orders permanently dropped (fatal failure, no recovery)',
  labelNames: ['direction', 'reason'] as const,
  registers: [registry],
});

export const chainDelayGauge = new Gauge({
  name: 'relayer_chain_delay_seconds',
  help: 'Observed chain head lag or confirmation delay',
  labelNames: ['chain'] as const,
  registers: [registry],
});

// ---------------------------------------------------------------------------
// Pipeline metrics bundle
// ---------------------------------------------------------------------------

/**
 * Convenience bundle that groups all eight pipeline observability metrics.
 * Used by the pipeline-metrics test to verify the bundle is exported and
 * contains the correct metric instances.
 */
export const pipelineMetrics = {
  ingestionTotal:    orderIngestionTotal,
  queueDepth:        orderQueueDepth,
  relayDecisionTotal,
  submissionLatency: submissionLatencySeconds,
  receiptLatency:    receiptLatencySeconds,
  retryAttempts:     retryAttemptsHistogram,
  droppedOrders:     droppedOrdersTotal,
  chainDelay:        chainDelayGauge,
} as const;

// ---------------------------------------------------------------------------
// Coordinator state client metrics (#754)
// ---------------------------------------------------------------------------

/**
 * Total coordinator health fetches, by result (success|failure|timeout).
 * Lets operators detect a relayer that cannot reach its coordinator.
 */
export const coordinatorStateFetchTotal = new Counter({
  name: 'relayer_coordinator_state_fetch_total',
  help: 'Total coordinator health fetches, by result (success|failure|timeout)',
  labelNames: ['result'] as const,
  registers: [registry],
});

/**
 * Age in seconds of the last successfully fetched coordinator health check.
 * An increasing value indicates the coordinator is unreachable.
 */
export const coordinatorStalenessSeconds = new Gauge({
  name: 'relayer_coordinator_staleness_seconds',
  help: 'Age in seconds of the last successfully fetched coordinator health check',
  registers: [registry],
});

/**
 * Total settlement actions skipped because the coordinator state was stale or
 * unavailable. Each increment represents a refused on-chain write.
 */
export const coordinatorFallbacksTotal = new Counter({
  name: 'relayer_coordinator_fallbacks_total',
  help: 'Total settlement actions skipped because coordinator state was stale or unavailable',
  labelNames: ['reason'] as const,
  registers: [registry],
});
