export class Mutex {
  private locked = false;
  private queue: Array<() => void> = [];

  async acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true;
      return () => this.release();
    }
    return new Promise((resolve) => {
      this.queue.push(() => resolve(() => this.release()));
    });
  }

  private release() {
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) next();
    } else {
      this.locked = false;
    }
  }
}

export class KeyedMutex {
  private locks = new Map<string, Mutex>();

  async acquire(key: string): Promise<() => void> {
    if (!this.locks.has(key)) {
      this.locks.set(key, new Mutex());
    }
    const mutex = this.locks.get(key)!;
    const release = await mutex.acquire();
    return () => {
      release();
    };
  }

  async runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire(key);
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/**
 * Deduplicator prevents multiple concurrent executions for the same key.
 * If a task is already running for the given key, it immediately returns null
 * instead of waiting.
 */
export class Deduplicator {
  private active = new Set<string>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T | null> {
    if (this.active.has(key)) {
      return null;
    }
    this.active.add(key);
    try {
      return await fn();
    } finally {
      this.active.delete(key);
    }
  }
}
