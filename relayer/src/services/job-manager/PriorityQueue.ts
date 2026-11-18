/**
 * @fileoverview Priority Queue Implementation
 * @description Priority queue for job scheduling with multiple priority levels
 */

import type { IPriorityQueue, Job, JobPriority } from './IJobManagerService.js';

// ============================================================================
// Priority Queue
// ============================================================================

export class PriorityQueue<T extends Job> implements IPriorityQueue<T> {
  private queues: Map<JobPriority, T[]> = new Map();
  private sizeCount = 0;

  constructor() {
    // Initialize queues for all priority levels
    for (let p = 0; p <= 3; p++) {
      this.queues.set(p as JobPriority, []);
    }
  }

  /**
   * Add item with priority
   */
  enqueue(item: T, priority: JobPriority): void {
    const queue = this.queues.get(priority);
    if (queue) {
      queue.push(item);
      this.sizeCount++;
    }
  }

  /**
   * Dequeue highest priority item
   */
  dequeue(): T | undefined {
    for (let p = 0; p <= 3; p++) {
      const queue = this.queues.get(p as JobPriority);
      if (queue && queue.length > 0) {
        this.sizeCount--;
        return queue.shift();
      }
    }
    return undefined;
  }

  /**
   * Peek at highest priority item
   */
  peek(): T | undefined {
    for (let p = 0; p <= 3; p++) {
      const queue = this.queues.get(p as JobPriority);
      if (queue && queue.length > 0) {
        return queue[0];
      }
    }
    return undefined;
  }

  /**
   * Get queue size
   */
  size(): number {
    return this.sizeCount;
  }

  /**
   * Check if queue is empty
   */
  isEmpty(): boolean {
    return this.sizeCount === 0;
  }

  /**
   * Get items by priority
   */
  getByPriority(priority: JobPriority): T[] {
    return [...(this.queues.get(priority) || [])];
  }

  /**
   * Get all items
   */
  getAll(): T[] {
    const all: T[] = [];
    for (let p = 0; p <= 3; p++) {
      all.push(...(this.queues.get(p as JobPriority) || []));
    }
    return all;
  }

  /**
   * Remove specific item by ID
   */
  remove(id: string): boolean {
    for (let p = 0; p <= 3; p++) {
      const queue = this.queues.get(p as JobPriority);
      if (queue) {
        const index = queue.findIndex(item => item.id === id);
        if (index !== -1) {
          queue.splice(index, 1);
          this.sizeCount--;
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Clear the queue
   */
  clear(): void {
    for (let p = 0; p <= 3; p++) {
      this.queues.get(p as JobPriority)?.length = 0;
    }
    this.sizeCount = 0;
  }

  /**
   * Get counts by priority
   */
  getCounts(): Record<JobPriority, number> {
    return {
      0: this.queues.get(0)?.length || 0,
      1: this.queues.get(1)?.length || 0,
      2: this.queues.get(2)?.length || 0,
      3: this.queues.get(3)?.length || 0,
    };
  }
}
