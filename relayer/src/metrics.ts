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
 * unhandled error — i.e. the scan loop ran to completion regardless of
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
 *   missing_address  — order has no stellarAddress
 *   refund_error     — refundXlmToUser threw
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
// Convenience re-export
// ---------------------------------------------------------------------------

/** All watchdog metrics in one object — useful for test assertions. */
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
