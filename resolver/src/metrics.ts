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

// ── Registration / participation metrics ──────────────────────────────────────

export const registrationInfo = new Gauge({
  name: "resolver_registration_info",
  help: "Resolver registration status (1 = registered, 0 = not registered)",
  registers: [registry],
});

export const registrationChangesTotal = new Counter({
  name: "resolver_registration_changes_total",
  help: "Total registration state changes (register, unregister, slash)",
  labelNames: ["action"] as const,
  registers: [registry],
});

export const startTimeSeconds = new Gauge({
  name: "resolver_start_time_seconds",
  help: "Unix timestamp when this resolver instance started",
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

export const resolverMetrics = {
  eventsTotal,
  listenerErrorsTotal,
  listenerPollDurationSeconds,
  listenerPollRunsTotal,
  listenerLastEventTimestampSeconds,
  activeListeners,
  registrationInfo,
  registrationChangesTotal,
  startTimeSeconds,
  ordersProcessedTotal,
  claimAttemptsTotal,
  refundAttemptsTotal,
  retryAttemptsTotal,
  operationDurationSeconds,
  operationFailuresTotal,
  activeOperations,
} as const;
