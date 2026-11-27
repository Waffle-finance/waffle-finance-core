/**
 * @fileoverview Job Manager Service
 * @description Centralized priority queue with concurrency control for relayer jobs.
 *
 * Priority levels (lower number = higher priority):
 *   0 — live_settlement: orders actively in their settlement window
 *   1 — recovery: orders past timelock that need a refund
 *   2 — cleanup: orphaned / stale order archival
 *   3 — maintenance: health checks, batch reconciliation
 *
 * Concurrency model
 * -----------------
 * Three nested guards prevent RPC overload:
 *   1. Global cap  — total slots across all job types combined
 *   2. Per-type cap — independent quota per JobType
 *   3. Per-priority cap — high-priority work can always make progress even
 *      when lower-priority jobs are saturating the global pool
 *
 * The scheduler loop runs every `tickIntervalMs` (default 50 ms). Each tick:
 *   - Drains the priority queue from highest → lowest priority.
 *   - Skips any job whose slot cannot be reserved (type or priority cap full).
 *   - Stops when the global cap is reached or the queue is empty.
 *
 * Job lifecycle
 * -------------
 *   pending → running → completed | failed
 *   Any state → cancelled  (if cancelJob() is called before execution)
 *
 * Backpressure
 * ------------
 * The pending queue is bounded by `maxQueueDepth`.  When it is full,
 * `submitJob()` rejects with `QueueFullError` instead of growing the queue
 * without limit; producers either shed the work or wait on
 * `whenCapacityAvailable()` before resubmitting.  Retries of jobs that were
 * already admitted are always re-enqueued, so the queue can exceed the cap by
 * at most the global concurrency limit (one retry per running job).
 *
 * Terminal job records (completed / failed / cancelled) are kept for
 * introspection up to `maxRetainedJobs`, oldest pruned first, so the registry
 * does not grow for the life of the process.
 *
 * A freed concurrency slot triggers an immediate dispatch instead of waiting
 * for the next tick, which removes up to `tickIntervalMs` of idle latency per
 * job under load (see test/load/order-load.test.ts).
 *
 * Retry
 * -----
 * Jobs with retryCount < maxRetries are re-enqueued at their original priority
 * after a failed execution. The retry count is incremented before re-enqueue,
 * so retries do not starve higher-priority new work.
 *
 * Metrics
 * -------
 * All queue metrics are updated synchronously on every state transition so
 * the /health endpoint always reflects the live queue state.
 */

import type {
  Job,
  JobPriority,
  JobStatus,
  JobType,
  IJobManagerService,
  JobResult,
  ConcurrencyLimits,
  JobManagerStats,
} from './IJobManagerService.js';
import { DEFAULT_CONCURRENCY_LIMITS } from './IJobManagerService.js';
import { PriorityQueue } from './PriorityQueue.js';
import { ConcurrencyLimiter } from './ConcurrencyLimiter.js';
import {
  jobQueueDepthGauge,
  jobRunningGauge,
  jobSubmittedTotal,
  jobCompletedTotal,
  jobFailedTotal,
  jobCancelledTotal,
  jobRejectedTotal,
  jobWaitDurationSeconds,
  jobProcessingDurationSeconds,
  jobQueueCapacityUtilization,
} from './metrics.js';
import { getLogger } from '../../logger.js';

const log = getLogger().child({ service: 'job-manager' });

// ---------------------------------------------------------------------------
// Executor registry
// ---------------------------------------------------------------------------

/**
 * Executor functions registered per JobType by the application at startup.
 * The job manager calls the matching executor when dequeuing a job.
 */
export type JobExecutor = (job: Job) => Promise<unknown>;

/** Default cap on pending (not yet running) jobs. */
export const DEFAULT_MAX_QUEUE_DEPTH = 1_000;
/** Default number of terminal job records retained for introspection. */
export const DEFAULT_MAX_RETAINED_JOBS = 10_000;

export interface JobManagerOptions {
  limits?: Partial<ConcurrencyLimits>;
  tickIntervalMs?: number;
  /** Maximum pending jobs before submitJob() rejects with QueueFullError. */
  maxQueueDepth?: number;
  /** Maximum terminal job records kept in the registry. */
  maxRetainedJobs?: number;
}

/**
 * Thrown by submitJob()/submitJobs() when admitting the job(s) would push the
 * pending queue past `maxQueueDepth`.  Nothing is enqueued when this is thrown.
 */
export class QueueFullError extends Error {
  readonly code = 'JOB_QUEUE_FULL';
  constructor(
    public readonly queueDepth: number,
    public readonly maxQueueDepth: number,
    public readonly requested = 1,
  ) {
    super(
      `job queue full: ${queueDepth}/${maxQueueDepth} pending, cannot admit ${requested} more`,
    );
    this.name = 'QueueFullError';
  }
}

// ---------------------------------------------------------------------------
// Job Manager Service
// ---------------------------------------------------------------------------

export class JobManagerService implements IJobManagerService {
  private readonly queue = new PriorityQueue<Job>();
  private readonly limiter: ConcurrencyLimiter;
  private readonly registry = new Map<string, Job>(); // id → Job (all states)
  private readonly executors = new Map<JobType, JobExecutor>();

  private tickHandle: NodeJS.Timeout | null = null;
  private readonly tickIntervalMs: number;
  private readonly maxQueueDepth: number;
  private readonly maxRetainedJobs: number;
  /** Ids of terminal jobs in completion order, for retention pruning. */
  private readonly terminalOrder: string[] = [];
  /** Producers waiting for the queue to drop below maxQueueDepth. */
  private capacityWaiters: Array<() => void> = [];
  private paused = false;
  private running = false;

  // Rolling timing samples (last 1000 jobs)
  private readonly waitSamples: number[] = [];
  private readonly processSamples: number[] = [];
  private readonly SAMPLE_WINDOW = 1000;

  // Counters (mirrored in Prometheus, kept here for cheap stats() calls)
  private totalSubmitted = 0;
  private totalCompleted = 0;
  private totalFailed = 0;
  private totalCancelled = 0;
  private totalRejected = 0;

  constructor(options: JobManagerOptions = {}) {
    this.limiter = new ConcurrencyLimiter({
      ...DEFAULT_CONCURRENCY_LIMITS,
      ...options.limits,
    });
    this.tickIntervalMs = options.tickIntervalMs ?? 50;
    this.maxQueueDepth = Math.max(1, options.maxQueueDepth ?? DEFAULT_MAX_QUEUE_DEPTH);
    this.maxRetainedJobs = Math.max(0, options.maxRetainedJobs ?? DEFAULT_MAX_RETAINED_JOBS);
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  start(): void {
    if (this.running) return;
    this.running = true;
    this.tickHandle = setInterval(() => this.tick(), this.tickIntervalMs);
    log.info({ tickIntervalMs: this.tickIntervalMs }, '[job-manager] started');
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
    log.info('[job-manager] stopped');
  }

  pause(): void {
    this.paused = true;
    log.info('[job-manager] paused');
  }

  resume(): void {
    this.paused = false;
    log.info('[job-manager] resumed');
  }

  // --------------------------------------------------------------------------
  // Executor registration
  // --------------------------------------------------------------------------

  /**
   * Register an executor for a job type. Must be called before start().
   * Replaces any previously registered executor for the same type.
   */
  registerExecutor(type: JobType, executor: JobExecutor): void {
    this.executors.set(type, executor);
    log.info({ type }, '[job-manager] executor registered');
  }

  // --------------------------------------------------------------------------
  // Job submission
  // --------------------------------------------------------------------------

  async submitJob(job: Job): Promise<string> {
    this.assertCapacity(job.type, 1);
    return this.admit(job);
  }

  /**
   * Resolve once the pending queue is below `maxQueueDepth`.  Producers use
   * this to wait instead of retrying in a tight loop after QueueFullError.
   */
  whenCapacityAvailable(): Promise<void> {
    if (this.queue.size() < this.maxQueueDepth) return Promise.resolve();
    return new Promise<void>((resolve) => this.capacityWaiters.push(resolve));
  }

  /** Configured pending-queue cap. */
  getMaxQueueDepth(): number {
    return this.maxQueueDepth;
  }

  private assertCapacity(type: JobType, requested: number): void {
    const depth = this.queue.size();
    if (depth + requested > this.maxQueueDepth) {
      this.totalRejected += requested;
      jobRejectedTotal.inc({ type }, requested);
      log.warn(
        { type, queueDepth: depth, maxQueueDepth: this.maxQueueDepth, requested },
        '[job-manager] queue full — rejecting submission',
      );
      throw new QueueFullError(depth, this.maxQueueDepth, requested);
    }
  }

  private admit(job: Job): string {
    const enriched: Job = {
      ...job,
      status: 'pending' as JobStatus,
      createdAt: job.createdAt ?? Date.now(),
      retryCount: job.retryCount ?? 0,
      maxRetries: job.maxRetries ?? 0,
    };

    this.registry.set(enriched.id, enriched);
    this.queue.enqueue(enriched, enriched.priority);

    this.totalSubmitted++;
    jobSubmittedTotal.inc({ type: enriched.type, priority: String(enriched.priority) });
    this.refreshGauges();

    log.debug(
      { jobId: enriched.id, type: enriched.type, priority: enriched.priority },
      '[job-manager] job submitted'
    );

    return enriched.id;
  }

  /**
   * Submit a batch atomically with respect to backpressure: either every job
   * fits under `maxQueueDepth` and all are enqueued, or none are.
   */
  async submitJobs(jobs: Job[], batchId?: string): Promise<string[]> {
    if (jobs.length === 0) return [];
    this.assertCapacity(jobs[0].type, jobs.length);
    return jobs.map((job) => this.admit(batchId ? { ...job, batchId } : job));
  }

  // --------------------------------------------------------------------------
  // Cancellation
  // --------------------------------------------------------------------------

  cancelJob(id: string): boolean {
    const job = this.registry.get(id);
    if (!job) return false;
    if (job.status === 'running') {
      // Cannot cancel in-flight; the executor owns the slot.
      log.warn({ jobId: id }, '[job-manager] cannot cancel running job');
      return false;
    }
    if (job.status !== 'pending') return false;

    const removed = this.queue.remove(id);
    if (removed) {
      job.status = 'cancelled';
      job.completedAt = Date.now();
      this.totalCancelled++;
      jobCancelledTotal.inc({ type: job.type });
      this.retainTerminal(job);
      this.notifyCapacity();
      this.refreshGauges();
      log.info({ jobId: id }, '[job-manager] job cancelled');
    }
    return removed;
  }

  // --------------------------------------------------------------------------
  // Introspection
  // --------------------------------------------------------------------------

  getJob(id: string): Job | undefined {
    const job = this.registry.get(id);
    return job ? { ...job } : undefined;
  }

  getJobs(filters: {
    type?: JobType;
    status?: JobStatus;
    priority?: JobPriority;
    limit?: number;
    offset?: number;
  } = {}): Job[] {
    let results = Array.from(this.registry.values());

    if (filters.type !== undefined)     results = results.filter(j => j.type === filters.type);
    if (filters.status !== undefined)   results = results.filter(j => j.status === filters.status);
    if (filters.priority !== undefined) results = results.filter(j => j.priority === filters.priority);

    const offset = filters.offset ?? 0;
    const limit  = filters.limit  ?? results.length;
    return results.slice(offset, offset + limit).map(j => ({ ...j }));
  }

  getPendingCount(): Record<JobPriority, number> {
    return this.queue.getCounts();
  }

  getRunningCount(): Record<JobType, number> {
    const counts: Record<JobType, number> = {
      live_settlement: 0,
      recovery: 0,
      cleanup: 0,
      maintenance: 0,
      batch: 0,
      reconciliation: 0,
    };
    for (const job of this.registry.values()) {
      if (job.status === 'running') counts[job.type]++;
    }
    return counts;
  }

  getTotalCount(): number {
    return this.registry.size;
  }

  getLimits(): ConcurrencyLimits {
    return this.limiter.getLimits();
  }

  updateLimits(limits: Partial<ConcurrencyLimits>): void {
    this.limiter.updateLimits(limits);
  }

  /** Total submissions rejected by backpressure since construction. */
  getRejectedCount(): number {
    return this.totalRejected;
  }

  getStats(): JobManagerStats {
    const byPriority: Record<JobPriority, number> = { 0: 0, 1: 0, 2: 0, 3: 0 };
    const byType: Record<JobType, number> = {
      live_settlement: 0, recovery: 0, cleanup: 0,
      maintenance: 0, batch: 0, reconciliation: 0,
    };
    const byStatus: Record<JobStatus, number> = {
      pending: 0, running: 0, completed: 0, failed: 0, cancelled: 0,
    };

    for (const job of this.registry.values()) {
      byPriority[job.priority]++;
      byType[job.type]++;
      byStatus[job.status]++;
    }

    const avgWait = this.average(this.waitSamples);
    const avgProcess = this.average(this.processSamples);
    const pendingCounts = this.queue.getCounts();
    const pendingJobs = Object.values(pendingCounts).reduce((a, b) => a + b, 0);

    return {
      totalSubmitted: this.totalSubmitted,
      totalCompleted: this.totalCompleted,
      totalFailed: this.totalFailed,
      totalCancelled: this.totalCancelled,
      avgWaitTime: avgWait,
      avgProcessingTime: avgProcess,
      queueDepth: this.queue.size(),
      runningJobs: byStatus.running,
      pendingJobs,
      byPriority,
      byType,
      byStatus,
    };
  }

  clear(): void {
    this.queue.clear();
    // Keep completed/failed records for audit but remove pending ones from registry
    for (const [id, job] of this.registry.entries()) {
      if (job.status === 'pending') {
        job.status = 'cancelled';
        job.completedAt = Date.now();
        this.totalCancelled++;
        this.retainTerminal(job);
      }
    }
    this.notifyCapacity();
    this.refreshGauges();
    log.warn('[job-manager] queue cleared');
  }

  // --------------------------------------------------------------------------
  // Scheduler tick
  // --------------------------------------------------------------------------

  private tick(): void {
    if (this.paused || this.queue.isEmpty()) return;

    // Drain as many jobs as concurrency allows in one tick.
    let dispatched = 0;

    while (!this.queue.isEmpty()) {
      const next = this.queue.peek();
      if (!next) break;

      if (!this.limiter.canExecute(next.type, next.priority)) {
        // Cannot start this job right now. In a strict priority model we stop —
        // we do not skip ahead to a lower-priority job. This prevents
        // lower-priority work from consuming slots that a high-priority job
        // is waiting for.
        break;
      }

      const job = this.queue.dequeue();
      if (!job) break;

      // Reserve slot and execute asynchronously
      this.limiter.reserve(job.type, job.priority);
      this.execute(job);
      dispatched++;
    }

    if (dispatched > 0) {
      this.notifyCapacity();
      this.refreshGauges();
    }
  }

  // --------------------------------------------------------------------------
  // Execution
  // --------------------------------------------------------------------------

  private async execute(job: Job): Promise<void> {
    const waitMs = Date.now() - job.createdAt;
    this.recordSample(this.waitSamples, waitMs);
    jobWaitDurationSeconds.observe(
      { type: job.type, priority: String(job.priority) },
      waitMs / 1000
    );

    job.status = 'running';
    job.startedAt = Date.now();
    this.refreshGauges();

    log.debug(
      { jobId: job.id, type: job.type, priority: job.priority, waitMs },
      '[job-manager] executing job'
    );

    const executor = this.executors.get(job.type);

    try {
      if (!executor) {
        throw new Error(`No executor registered for job type: ${job.type}`);
      }
      job.result = await executor(job);
      this.completeJob(job);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.failJob(job, message);
    } finally {
      this.limiter.release(job.type, job.priority);
      this.refreshGauges();
      // Hand the freed slot to the next queued job right away rather than
      // leaving it idle until the next scheduler tick.
      if (this.running) this.tick();
    }
  }

  private completeJob(job: Job): void {
    const processMs = Date.now() - (job.startedAt ?? Date.now());
    this.recordSample(this.processSamples, processMs);
    jobProcessingDurationSeconds.observe(
      { type: job.type, priority: String(job.priority) },
      processMs / 1000
    );

    job.status = 'completed';
    job.completedAt = Date.now();
    this.totalCompleted++;
    jobCompletedTotal.inc({ type: job.type });
    this.retainTerminal(job);

    log.debug(
      { jobId: job.id, type: job.type, processMs },
      '[job-manager] job completed'
    );
  }

  private failJob(job: Job, errorMessage: string): void {
    const processMs = Date.now() - (job.startedAt ?? Date.now());
    job.error = errorMessage;

    // Retry if allowed
    if (job.retryCount < job.maxRetries) {
      job.retryCount++;
      job.status = 'pending';
      job.startedAt = undefined;
      job.createdAt = Date.now(); // Reset for wait-time tracking on retry
      this.queue.enqueue(job, job.priority);

      log.warn(
        { jobId: job.id, type: job.type, retryCount: job.retryCount, maxRetries: job.maxRetries, error: errorMessage },
        '[job-manager] job failed, retrying'
      );
      return;
    }

    // No retries left
    this.recordSample(this.processSamples, processMs);
    job.status = 'failed';
    job.completedAt = Date.now();
    this.totalFailed++;
    jobFailedTotal.inc({ type: job.type });
    this.retainTerminal(job);

    log.error(
      { jobId: job.id, type: job.type, error: errorMessage },
      '[job-manager] job failed permanently'
    );
  }

  // --------------------------------------------------------------------------
  // Gauge refresh
  // --------------------------------------------------------------------------

  private refreshGauges(): void {
    const usage = this.limiter.getUsage();
    const limits = this.limiter.getLimits();

    jobQueueDepthGauge.set(this.queue.size());
    jobRunningGauge.set(usage.global);

    // Utilization per type
    for (const [type, active] of Object.entries(usage.byType)) {
      const cap = limits.byType[type as JobType] ?? 1;
      jobQueueCapacityUtilization.set(
        { type },
        cap > 0 ? active / cap : 0
      );
    }
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  /**
   * Wake producers blocked in whenCapacityAvailable(), FIFO, one per free
   * queue slot.  Waking everyone would cause a thundering herd where most
   * producers immediately hit QueueFullError again.
   */
  private notifyCapacity(): void {
    const free = this.maxQueueDepth - this.queue.size();
    if (free <= 0 || this.capacityWaiters.length === 0) return;
    const wake = this.capacityWaiters.splice(0, free);
    for (const resolve of wake) resolve();
  }

  /** Track a terminal job and prune the oldest beyond maxRetainedJobs. */
  private retainTerminal(job: Job): void {
    this.terminalOrder.push(job.id);
    while (this.terminalOrder.length > this.maxRetainedJobs) {
      const oldest = this.terminalOrder.shift()!;
      const record = this.registry.get(oldest);
      // A re-submitted id may be live again; only prune terminal records.
      if (record && record.status !== 'pending' && record.status !== 'running') {
        this.registry.delete(oldest);
      }
    }
  }

  private recordSample(arr: number[], value: number): void {
    arr.push(value);
    if (arr.length > this.SAMPLE_WINDOW) arr.shift();
  }

  private average(arr: number[]): number {
    if (arr.length === 0) return 0;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  }
}

// ---------------------------------------------------------------------------
// Process-wide singleton
// ---------------------------------------------------------------------------

export const globalJobManager = new JobManagerService();
