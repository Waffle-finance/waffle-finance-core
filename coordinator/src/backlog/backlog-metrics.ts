/**
 * Prometheus metrics for the backlog scheduler.
 *
 * These are intentionally separate from the main metrics.ts file so the
 * backlog module is self-contained and can be imported in isolation.
 */

import { Counter, Gauge, Histogram } from "prom-client";
import { registry } from "../metrics.js";

/**
 * Current number of pending jobs per priority class.
 *
 * Operators can alert on:
 *  - `live_event > N` — listener events are not draining fast enough.
 *  - `replay_job > N` — reconciler is behind on gap recovery.
 *  - `secret_recovery > N` — many missed OrderClaimed events.
 *  - `stale_cleanup > N` — cleanup is backlogged (low urgency).
 */
export const backlogQueueDepth = new Gauge({
  name: "coordinator_backlog_queue_depth",
  help: "Current number of pending jobs per backlog priority class",
  labelNames: ["priority"] as const,
  registers: [registry],
});

/**
 * Cumulative jobs executed (or failed) per priority class.
 * The `result` label is `success` or `failure`.
 */
export const backlogJobsExecuted = new Counter({
  name: "coordinator_backlog_jobs_executed_total",
  help: "Total backlog jobs executed, by priority class and result",
  labelNames: ["priority", "result"] as const,
  registers: [registry],
});

/**
 * Wall-clock time spent executing each job, by priority class.
 * Useful for spotting slow replay jobs starving live events.
 */
export const backlogJobDuration = new Histogram({
  name: "coordinator_backlog_job_duration_seconds",
  help: "Wall-clock time per backlog job execution, by priority class",
  labelNames: ["priority"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

/**
 * Jobs that were dropped because a priority queue reached `maxQueueDepth`.
 * A non-zero rate here is a strong signal that the coordinator is overloaded.
 */
export const backlogDropped = new Counter({
  name: "coordinator_backlog_jobs_dropped_total",
  help: "Jobs dropped because the queue for a priority class was full",
  labelNames: ["priority"] as const,
  registers: [registry],
});

/**
 * Jobs that were killed because they exceeded their configured timeout.
 * A non-zero rate indicates stuck background jobs — investigate which job
 * is timing out and why (RPC stall, DB lock, etc.).
 */
export const backlogJobTimeouts = new Counter({
  name: "coordinator_backlog_job_timeouts_total",
  help: "Jobs aborted because they exceeded the per-job timeout",
  labelNames: ["priority", "name"] as const,
  registers: [registry],
});

/**
 * Whether the BacklogScheduler is currently in RESTRAINED pressure mode.
 * 1 = restrained (queue depth exceeded threshold), 0 = normal.
 * Operators can alert on this gauge to detect sustained overload.
 */
export const backlogPressureRestrained = new Gauge({
  name: "coordinator_backlog_pressure_restrained",
  help: "1 when the backlog pressure controller is in RESTRAINED mode, 0 when NORMAL",
  registers: [registry],
});
