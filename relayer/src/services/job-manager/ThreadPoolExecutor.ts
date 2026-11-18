/**
 * @fileoverview Thread Pool Executor
 * @description Manages a pool of workers for job execution
 */

import type { IThreadPoolExecutor } from './IJobManagerService.js';
import { getLogger } from '../logger.js';

const logger = getLogger().child({ component: 'thread-pool' });

// ============================================================================
// Thread Pool Executor
// ============================================================================

export class ThreadPoolExecutor implements IThreadPoolExecutor {
  private workers: number;
  private activeWorkers = 0;
  private waitingJobs: Array<() => Promise<unknown>> = [];
  private completedJobs = 0;
  private failedJobs = 0;
  private running = false;

  constructor(workers = 10) {
    this.workers = workers;
  }

  /**
   * Start the thread pool
   */
  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    logger.info({ workers: this.workers }, 'Thread pool started');
    this.processQueue();
  }

  /**
   * Stop the thread pool
   */
  stop(): void {
    this.running = false;
    logger.info('Thread pool stopped');
  }

  /**
   * Submit a task for execution
   */
  async submit<T>(task: () => Promise<T>): Promise<T> {
    if (!this.running) {
      throw new Error('Thread pool is not running');
    }

    return new Promise((resolve, reject) => {
      const wrappedTask = async () => {
        try {
          const result = await task();
          this.completedJobs++;
          resolve(result as T);
        } catch (error) {
          this.failedJobs++;
          reject(error);
        } finally {
          this.activeWorkers--;
          this.processQueue();
        }
      };

      if (this.activeWorkers < this.workers) {
        this.activeWorkers++;
        wrappedTask();
      } else {
        this.waitingJobs.push(wrappedTask);
      }
    });
  }

  /**
   * Submit a batch of tasks
   */
  async submitBatch<T>(tasks: Array<() => Promise<T>>): Promise<T[]> {
    if (!this.running) {
      throw new Error('Thread pool is not running');
    }

    const results: T[] = [];
    for (const task of tasks) {
      try {
        const result = await this.submit(task);
        results.push(result);
      } catch (error) {
        logger.error({ error }, 'Task in batch failed');
        // Continue with other tasks
      }
    }
    return results;
  }

  /**
   * Get pool status
   */
  getStatus(): {
    workers: number;
    active: number;
    waiting: number;
    completed: number;
    failed: number;
  } {
    return {
      workers: this.workers,
      active: this.activeWorkers,
      waiting: this.waitingJobs.length,
      completed: this.completedJobs,
      failed: this.failedJobs,
    };
  }

  /**
   * Process the job queue
   */
  private processQueue(): void {
    if (!this.running || this.activeWorkers >= this.workers) {
      return;
    }

    if (this.waitingJobs.length > 0) {
      const nextJob = this.waitingJobs.shift();
      if (nextJob) {
        this.activeWorkers++;
        nextJob();
      }
    }
  }

  /**
   * Get queue statistics
   */
  getStats(): {
    workers: number;
    active: number;
    waiting: number;
    completed: number;
    failed: number;
    utilization: number;
  } {
    const utilization = this.workers > 0
      ? this.activeWorkers / this.workers
      : 0;

    return {
      workers: this.workers,
      active: this.activeWorkers,
      waiting: this.waitingJobs.length,
      completed: this.completedJobs,
      failed: this.failedJobs,
      utilization,
    };
  }

  /**
   * Set worker count
   */
  setWorkers(count: number): void {
    this.workers = count;
    logger.info({ workers: count }, 'Worker count updated');
  }

  /**
   * Get worker count
   */
  getWorkers(): number {
    return this.workers;
  }
}
