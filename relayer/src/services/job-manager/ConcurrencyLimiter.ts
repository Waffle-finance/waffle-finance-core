/**
 * @fileoverview Concurrency Limiter
 * @description Manages concurrent job execution with global and per-type limits
 */

import type {
  ConcurrencyLimits,
  JobType,
  JobPriority,
  IConcurrencyLimiter,
} from './IJobManagerService.js';
import { DEFAULT_CONCURRENCY_LIMITS } from './IJobManagerService.js';
import { getLogger } from '../logger.js';

const logger = getLogger().child({ component: 'concurrency-limiter' });

// ============================================================================
// Concurrency Limiter
// ============================================================================

export class ConcurrencyLimiter implements IConcurrencyLimiter {
  private limits: ConcurrencyLimits;
  private usage: {
    global: number;
    byType: Record<JobType, number>;
    byPriority: Record<JobPriority, number>;
  } = {
    global: 0,
    byType: {
      live_settlement: 0,
      recovery: 0,
      cleanup: 0,
      maintenance: 0,
      batch: 0,
      reconciliation: 0,
    },
    byPriority: {
      0: 0,
      1: 0,
      2: 0,
      3: 0,
    },
  };

  constructor(limits?: Partial<ConcurrencyLimits>) {
    this.limits = {
      ...DEFAULT_CONCURRENCY_LIMITS,
      ...limits,
    };
  }

  /**
   * Check if a job can be executed
   */
  canExecute(jobType: JobType, priority: JobPriority): boolean {
    // Check global limit
    if (this.usage.global >= this.limits.global) {
      return false;
    }

    // Check per-type limit
    const typeLimit = this.limits.byType[jobType];
    if (this.usage.byType[jobType] >= typeLimit) {
      return false;
    }

    // Check per-priority limit
    const priorityLimit = this.limits.byPriority[priority];
    if (this.usage.byPriority[priority] >= priorityLimit) {
      return false;
    }

    return true;
  }

  /**
   * Reserve a slot for job execution
   */
  reserve(jobType: JobType, priority: JobPriority): boolean {
    if (!this.canExecute(jobType, priority)) {
      return false;
    }

    this.usage.global++;
    this.usage.byType[jobType]++;
    this.usage.byPriority[priority]++;

    return true;
  }

  /**
   * Release a slot
   */
  release(jobType: JobType, priority: JobPriority): void {
    if (this.usage.global > 0) {
      this.usage.global--;
    }
    if (this.usage.byType[jobType] > 0) {
      this.usage.byType[jobType]--;
    }
    if (this.usage.byPriority[priority] > 0) {
      this.usage.byPriority[priority]--;
    }
  }

  /**
   * Get current usage
   */
  getUsage(): {
    global: number;
    byType: Record<JobType, number>;
    byPriority: Record<JobPriority, number>;
  } {
    return {
      global: this.usage.global,
      byType: { ...this.usage.byType },
      byPriority: { ...this.usage.byPriority },
    };
  }

  /**
   * Get limits
   */
  getLimits(): ConcurrencyLimits {
    return { ...this.limits };
  }

  /**
   * Update limits
   */
  updateLimits(limits: Partial<ConcurrencyLimits>): void {
    this.limits = {
      ...this.limits,
      ...limits,
    };
    logger.info(
      { limits: this.limits },
      'Concurrency limits updated'
    );
  }

  /**
   * Get usage statistics
   */
  getStats(): {
    global: number;
    byType: Record<JobType, number>;
    byPriority: Record<JobPriority, number>;
    capacity: {
      global: number;
      byType: Record<JobType, number>;
      byPriority: Record<JobPriority, number>;
    };
  } {
    return {
      global: this.usage.global,
      byType: { ...this.usage.byType },
      byPriority: { ...this.usage.byPriority },
      capacity: {
        global: this.limits.global,
        byType: { ...this.limits.byType },
        byPriority: { ...this.limits.byPriority },
      },
    };
  }

  /**
   * Reset usage (for testing)
   */
  reset(): void {
    this.usage = {
      global: 0,
      byType: {
        live_settlement: 0,
        recovery: 0,
        cleanup: 0,
        maintenance: 0,
        batch: 0,
        reconciliation: 0,
      },
      byPriority: {
        0: 0,
        1: 0,
        2: 0,
        3: 0,
      },
    };
  }
}
