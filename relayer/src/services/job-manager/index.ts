/**
 * @fileoverview Job Manager Module
 * @description Priority queue and concurrency control for relayer jobs.
 *
 * Priority levels:
 *   0 — live_settlement  (critical — always processed first)
 *   1 — recovery         (high)
 *   2 — cleanup / reconciliation (medium)
 *   3 — maintenance / batch      (low)
 */

export * from './IJobManagerService.js';
export { PriorityQueue } from './PriorityQueue.js';
export { ConcurrencyLimiter } from './ConcurrencyLimiter.js';
export { ThreadPoolExecutor } from './ThreadPoolExecutor.js';
export {
  JobManagerService,
  globalJobManager,
  QueueFullError,
  DEFAULT_MAX_QUEUE_DEPTH,
  DEFAULT_MAX_RETAINED_JOBS,
} from './JobManagerService.js';
export type { JobExecutor, JobManagerOptions } from './JobManagerService.js';
export * from './metrics.js';
