import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from "prom-client";

export const registry = new Registry();

collectDefaultMetrics({ register: registry, prefix: "coordinator_" });

/** Total orders by status and direction labels */
export const ordersTotal = new Counter({
  name: "coordinator_orders_total",
  help: "Total number of orders by status and direction",
  labelNames: ["status", "direction"] as const,
  registers: [registry]
});

/** Database query duration histogram */
export const dbQueryDuration = new Histogram({
  name: "coordinator_db_query_duration_seconds",
  help: "Duration of database queries in seconds",
  labelNames: ["operation"] as const,
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5],
  registers: [registry]
});

/** Last block number seen by each listener */
export const listenerLastBlock = new Gauge({
  name: "coordinator_listener_last_block",
  help: "Most recent block processed by each chain listener",
  labelNames: ["chain"] as const,
  registers: [registry]
});

/** Latest chain head observed by each listener */
export const listenerHeadBlock = new Gauge({
  name: "coordinator_listener_head_block",
  help: "Most recent chain head observed by each listener",
  labelNames: ["chain"] as const,
  registers: [registry]
});

/** Difference between the observed chain head and processed listener block */
export const listenerLagBlocks = new Gauge({
  name: "coordinator_listener_lag_blocks",
  help: "Current listener lag in blocks, ledgers, or slots by chain",
  labelNames: ["chain"] as const,
  registers: [registry]
});

/** Event processing duration per chain and event type */
export const listenerEventProcessingDuration = new Histogram({
  name: "coordinator_listener_event_processing_duration_seconds",
  help: "Duration spent processing listener event batches",
  labelNames: ["chain", "event"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [registry]
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
  name: "coordinator_http_request_duration_seconds",
  help: "Duration of HTTP requests in seconds",
  labelNames: ["method", "route", "status_code"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [registry]
});

/** End-to-end swap completion latency in seconds */
export const swapDuration = new Histogram({
  name: "coordinator_swap_duration_seconds",
  help: "Time from order announcement to terminal state (completed or refunded)",
  labelNames: ["direction", "outcome"] as const,
  buckets: [30, 60, 120, 180, 300, 600, 900, 1800, 3600],
  registers: [registry]
});

/** Active orders currently in flight */
export const activeOrders = new Gauge({
  name: "coordinator_active_orders",
  help: "Number of orders not yet in a terminal state",
  labelNames: ["direction"] as const,
  registers: [registry]
});

/** Reconciliation runs by result */
export const reconciliationRuns = new Counter({
  name: "coordinator_reconciliation_runs_total",
  help: "Total reconciliation runs by result (success|failure)",
  labelNames: ["result"] as const,
  registers: [registry]
});

/** Reconciliation errors */
export const reconciliationErrors = new Counter({
  name: "coordinator_reconciliation_errors_total",
  help: "Total reconciliation run failures",
  registers: [registry]
});

/** Unix timestamp of last completed reconciliation run */
export const reconciliationLastRun = new Gauge({
  name: "coordinator_reconciliation_last_run_timestamp_seconds",
  help: "Unix timestamp of the most recent reconciliation run",
  registers: [registry]
});

/** Total events replayed by reconciler */
export const reconciliationEventsReplayed = new Counter({
  name: "coordinator_reconciliation_events_replayed_total",
  help: "Total on-chain events replayed by the reconciler",
  registers: [registry]
});
