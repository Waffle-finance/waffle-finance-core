/**
 * @fileoverview Job Manager Service Interface
 * @description Centralized job scheduling with priority and concurrency control
 */

// ============================================================================
// Job Types
// ============================================================================

export type JobPriority = 0 | 1 | 2 | 3;
export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export type JobType = 
  | 'live_settlement'
  | 'recovery'
  | 'cleanup'
  | 'maintenance'
  | 'batch'
  | 'reconciliation';

export interface Job {
  id: string;
  type: JobType;
  priority: JobPriority;
  status: JobStatus;
  payload: Record<string, unknown>;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  error?: string;
  result?: unknown;
  retryCount: number;
  maxRetries: number;
  batchId?: string;
  tags?: string[];
}

export interface JobResult {
  success: boolean;
  jobId: string;
  result?: unknown;
  error?: string;
}

// ============================================================================
// Concurrency Limits
// ============================================================================

export interface ConcurrencyLimits {
  /**
   * Global maximum concurrent jobs
   */
  global: number;
  /**
   * Per-job-type limits
   */
  byType: Record<JobType, number>;
  /**
   * Per-priority limits (higher priority can preempt lower)
   */
  byPriority: Record<JobPriority, number>;
}

export const DEFAULT_CONCURRENCY_LIMITS: ConcurrencyLimits = {
  global: 10,
  byType: {
    live_settlement: 5,
    recovery: 3,
    cleanup: 2,
    maintenance: 1,
    batch: 4,
    reconciliation: 2,
  },
  byPriority: {
    0: 5, // Critical: live settlement
    1: 3, // High: recovery
    2: 2, // Medium: cleanup
    3: 1, // Low: maintenance
  },
};

// ============================================================================
// Job Manager Service Interface
// ============================================================================

export interface IJobManagerService {
  /**
   * Start the job manager
   */
  start(): void;

  /**
   * Stop the job manager
   */
  stop(): void;

  /**
   * Submit a job to the queue
   */
  submitJob(job: Job): Promise<string>;

  /**
   * Submit multiple jobs with optional batch ID
   */
  submitJobs(jobs: Job[], batchId?: string): Promise<string[]>;

  /**
   * Get pending jobs count by priority
   */
  getPendingCount(): Record<JobPriority, number>;

  /**
   * Get running jobs count by type
   */
  getRunningCount(): Record<JobType, number>;

  /**
   * Get total job count
   */
  getTotalCount(): number;

  /**
   * Get job by ID
   */
  getJob(id: string): Job | undefined;

  /**
   * Get all jobs with optional filters
   */
  getJobs(filters?: {
    type?: JobType;
    status?: JobStatus;
    priority?: JobPriority;
    limit?: number;
    offset?: number;
  }): Job[];

  /**
   * Cancel a job
   */
  cancelJob(id: string): boolean;

  /**
   * Get job statistics
   */
  getStats(): JobManagerStats;

  /**
   * Get concurrency limits
   */
  getLimits(): ConcurrencyLimits;

  /**
   * Update concurrency limits
   */
  updateLimits(limits: Partial<ConcurrencyLimits>): void;

  /**
   * Pause job processing
   */
  pause(): void;

  /**
   * Resume job processing
   */
  resume(): void;

  /**
   * Clear all jobs from the queue
   */
  clear(): void;
}

// ============================================================================
// Job Manager Statistics
// ============================================================================

export interface JobManagerStats {
  /**
   * Total jobs submitted
   */
  totalSubmitted: number;
  /**
   * Total jobs completed
   */
  totalCompleted: number;
  /**
   * Total jobs failed
   */
  totalFailed: number;
  /**
   * Total jobs cancelled
   */
  totalCancelled: number;
  /**
   * Average wait time (ms)
   */
  avgWaitTime: number;
  /**
   * Average processing time (ms)
   */
  avgProcessingTime: number;
  /**
   * Current queue depth
   */
  queueDepth: number;
  /**
   * Current running jobs
   */
  runningJobs: number;
  /**
   * Current pending jobs
   */
  pendingJobs: number;
  /**
   * Jobs by priority
   */
  byPriority: Record<JobPriority, number>;
  /**
   * Jobs by type
   */
  byType: Record<JobType, number>;
  /**
   * Jobs by status
   */
  byStatus: Record<JobStatus, number>;
}

// ============================================================================
// Job Priority Queue Interface
// ============================================================================

export interface IPriorityQueue<T = Job> {
  /**
   * Add item with priority
   */
  enqueue(item: T, priority: JobPriority): void;

  /**
   * Dequeue highest priority item
   */
  dequeue(): T | undefined;

  /**
   * Peek at highest priority item
   */
  peek(): T | undefined;

  /**
   * Get queue size
   */
  size(): number;

  /**
   * Check if queue is empty
   */
  isEmpty(): boolean;

  /**
   * Get items by priority
   */
  getByPriority(priority: JobPriority): T[];

  /**
   * Get all items
   */
  getAll(): T[];

  /**
   * Remove specific item
   */
  remove(id: string): boolean;

  /**
   * Clear the queue
   */
  clear(): void;
}

// ============================================================================
// Concurrency Limiter Interface
// ============================================================================

export interface IConcurrencyLimiter {
  /**
   * Check if a job can be executed
   */
  canExecute(jobType: JobType, priority: JobPriority): boolean;

  /**
   * Reserve a slot for job execution
   */
  reserve(jobType: JobType, priority: JobPriority): boolean;

  /**
   * Release a slot
   */
  release(jobType: JobType, priority: JobPriority): void;

  /**
   * Get current usage
   */
  getUsage(): {
    global: number;
    byType: Record<JobType, number>;
    byPriority: Record<JobPriority, number>;
  };

  /**
   * Get limits
   */
  getLimits(): ConcurrencyLimits;
}

// ============================================================================
// Thread Pool Interface
// ============================================================================

export interface IThreadPoolExecutor {
  /**
   * Start the thread pool
   */
  start(): void;

  /**
   * Stop the thread pool
   */
  stop(): void;

  /**
   * Submit a task for execution
   */
  submit<T>(task: () => Promise<T>): Promise<T>;

  /**
   * Submit a batch of tasks
   */
  submitBatch<T>(tasks: Array<() => Promise<T>>): Promise<T[]>;

  /**
   * Get pool status
   */
  getStatus(): {
    workers: number;
    active: number;
    waiting: number;
    completed: number;
    failed: number;
  };
}

// ============================================================================
// Job Execution Context
// ============================================================================

export interface JobExecutionContext {
  jobId: string;
  jobType: JobType;
  priority: JobPriority;
  payload: Record<string, unknown>;
  batchId?: string;
}
