/**
 * @fileoverview Job Manager Prometheus metrics
 * @description Scoped to the shared relayer registry so these counters/gauges
 *              appear in the existing /metrics endpoint without any extra wiring.
 */

import { Counter, Gauge, Histogram } from 'prom-client';
import { registry } from '../../metrics.js';

// ---------------------------------------------------------------------------
// Queue depth and running jobs
// ---------------------------------------------------------------------------

/**
 * Current number of jobs sitting in the priority queue awaiting a slot.
 * Labelled by priority so operators can detect priority-level backlogs.
 */
export const jobQueueDepthGauge = new Gauge({
  name: 'relayer_job_queue_depth',
  help: 'Current number of jobs in the priority queue awaiting execution',
  registers: [registry],
});

/**
 * Current number of concurrently running jobs (across all types).
 */
export const jobRunningGauge = new Gauge({
  name: 'relayer_job_running',
  help: 'Current number of jobs actively executing',
  registers: [registry],
});

/**
 * Fraction of each job type's concurrency cap that is currently consumed.
 * Values near 1.0 indicate that type is saturated; values near 0 are idle.
 */
export const jobQueueCapacityUtilization = new Gauge({
  name: 'relayer_job_capacity_utilization_ratio',
  help: 'Fraction of the per-type concurrency cap currently in use (0–1)',
  labelNames: ['type'] as const,
  registers: [registry],
});

// ---------------------------------------------------------------------------
// Job lifecycle counters
// ---------------------------------------------------------------------------

/**
 * Total jobs submitted to the queue, labelled by type and priority.
 */
export const jobSubmittedTotal = new Counter({
  name: 'relayer_job_submitted_total',
  help: 'Total jobs submitted to the priority queue',
  labelNames: ['type', 'priority'] as const,
  registers: [registry],
});

/**
 * Total jobs that completed successfully, labelled by type.
 */
export const jobCompletedTotal = new Counter({
  name: 'relayer_job_completed_total',
  help: 'Total jobs that completed successfully',
  labelNames: ['type'] as const,
  registers: [registry],
});

/**
 * Total jobs that failed permanently (retries exhausted), labelled by type.
 */
export const jobFailedTotal = new Counter({
  name: 'relayer_job_failed_total',
  help: 'Total jobs that failed after all retry attempts',
  labelNames: ['type'] as const,
  registers: [registry],
});

/**
 * Total jobs cancelled before execution, labelled by type.
 */
export const jobCancelledTotal = new Counter({
  name: 'relayer_job_cancelled_total',
  help: 'Total jobs cancelled before execution began',
  labelNames: ['type'] as const,
  registers: [registry],
});

// ---------------------------------------------------------------------------
// Latency histograms
// ---------------------------------------------------------------------------

/**
 * Time a job spent in the queue before execution started (wait latency).
 * High values indicate the queue is backed up or concurrency limits are too low.
 */
export const jobWaitDurationSeconds = new Histogram({
  name: 'relayer_job_wait_duration_seconds',
  help: 'Time a job waited in the priority queue before execution started',
  labelNames: ['type', 'priority'] as const,
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10, 30, 60],
  registers: [registry],
});

/**
 * Time a job spent executing (processing latency).
 * Useful for detecting slow executors that hog concurrency slots.
 */
export const jobProcessingDurationSeconds = new Histogram({
  name: 'relayer_job_processing_duration_seconds',
  help: 'Time a job spent executing inside its registered executor',
  labelNames: ['type', 'priority'] as const,
  buckets: [0.05, 0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300],
  registers: [registry],
});

// ---------------------------------------------------------------------------
// Bundle
// ---------------------------------------------------------------------------

export const jobManagerMetrics = {
  queueDepth:          jobQueueDepthGauge,
  running:             jobRunningGauge,
  capacityUtilization: jobQueueCapacityUtilization,
  submittedTotal:      jobSubmittedTotal,
  completedTotal:      jobCompletedTotal,
  failedTotal:         jobFailedTotal,
  cancelledTotal:      jobCancelledTotal,
  waitDuration:        jobWaitDurationSeconds,
  processingDuration:  jobProcessingDurationSeconds,
} as const;
