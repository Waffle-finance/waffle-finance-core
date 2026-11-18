/**
 * @file listener-state.ts
 *
 * Bounded, self-cleaning data structures for long-running resolver listeners.
 *
 * ## Problem
 *
 * Listener processes accumulate state over time:
 *   - Dedup caches grow without bound if events keep arriving.
 *   - Retry contexts for failed operations stay alive even after resolution.
 *   - Per-event records (e.g. "seen orderId X at ledger Y") are never evicted.
 *
 * In a long-running process (days / weeks) under degraded network conditions
 * this results in steady memory growth.  The structures below enforce size
 * ceilings and time-based eviction windows so the process footprint stays
 * predictable regardless of uptime.
 *
 * ## Structures provided
 *
 * - `BoundedSet<K>`      — set with a hard size cap; evicts oldest entry on
 *                          overflow.  Drop-in for the dedup sets in the
 *                          Soroban / Solana listeners.
 * - `BoundedMap<K,V>`    — map with a hard size cap; same eviction policy.
 * - `TimedEvictionMap<K,V>` — map where entries expire after a configurable
 *                          TTL.  Eviction is lazy (checked on access and on
 *                          explicit `purge()` calls) so it never blocks the
 *                          event loop.
 * - `RetryContextStore`  — tracks in-flight retry attempts per logical key
 *                          (e.g. orderId).  Bounds both the number of active
 *                          contexts and the per-key retry count, and provides
 *                          `purgeStale()` for periodic cleanup.
 *
 * All structures are synchronous, zero-dependency, and designed to be used
 * as drop-in replacements or composition targets inside the listeners.
 */

// ── BoundedSet ────────────────────────────────────────────────────────────────

/**
 * A `Set`-like structure with a hard upper bound.
 *
 * When `maxSize` is exceeded the oldest entry is evicted (insertion order).
 * This mirrors the LRU-style eviction already used in Soroban/Solana listeners
 * but wraps it in a reusable, testable class.
 */
export class BoundedSet<K> {
  private readonly set = new Set<K>();
  private readonly queue: K[] = [];

  constructor(private readonly maxSize: number) {
    if (maxSize < 1) throw new RangeError(`BoundedSet maxSize must be ≥ 1 (got ${maxSize})`);
  }

  add(key: K): void {
    if (this.set.has(key)) return; // already present — no eviction needed
    if (this.queue.length >= this.maxSize) {
      const evicted = this.queue.shift()!;
      this.set.delete(evicted);
    }
    this.set.add(key);
    this.queue.push(key);
  }

  has(key: K): boolean {
    return this.set.has(key);
  }

  delete(key: K): boolean {
    if (!this.set.has(key)) return false;
    this.set.delete(key);
    const idx = this.queue.indexOf(key);
    if (idx !== -1) this.queue.splice(idx, 1);
    return true;
  }

  clear(): void {
    this.set.clear();
    this.queue.length = 0;
  }

  get size(): number {
    return this.set.size;
  }

  /** Iterate in insertion order (oldest first). */
  [Symbol.iterator](): Iterator<K> {
    return this.set[Symbol.iterator]();
  }
}

// ── BoundedMap ────────────────────────────────────────────────────────────────

/**
 * A `Map`-like structure with a hard upper bound on key count.
 *
 * Evicts the oldest entry (by insertion order) when the cap is reached.
 */
export class BoundedMap<K, V> {
  private readonly map = new Map<K, V>();
  private readonly queue: K[] = [];

  constructor(private readonly maxSize: number) {
    if (maxSize < 1) throw new RangeError(`BoundedMap maxSize must be ≥ 1 (got ${maxSize})`);
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      // Update value without changing insertion order.
      this.map.set(key, value);
      return;
    }
    if (this.queue.length >= this.maxSize) {
      const evicted = this.queue.shift()!;
      this.map.delete(evicted);
    }
    this.map.set(key, value);
    this.queue.push(key);
  }

  get(key: K): V | undefined {
    return this.map.get(key);
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  delete(key: K): boolean {
    if (!this.map.has(key)) return false;
    this.map.delete(key);
    const idx = this.queue.indexOf(key);
    if (idx !== -1) this.queue.splice(idx, 1);
    return true;
  }

  clear(): void {
    this.map.clear();
    this.queue.length = 0;
  }

  get size(): number {
    return this.map.size;
  }

  entries(): IterableIterator<[K, V]> {
    return this.map.entries();
  }

  keys(): IterableIterator<K> {
    return this.map.keys();
  }

  values(): IterableIterator<V> {
    return this.map.values();
  }
}

// ── TimedEvictionMap ──────────────────────────────────────────────────────────

interface TimedEntry<V> {
  value: V;
  expiresAt: number;
}

/**
 * A map where entries expire after a configurable TTL.
 *
 * Eviction is lazy: expired entries are removed when accessed (`get`, `has`)
 * and during explicit `purge()` calls.  No background timer is created so
 * this structure never prevents the process from exiting cleanly.
 *
 * Use `purge()` at a regular interval (e.g. once per poll tick) to reclaim
 * memory from expired but unaccessed entries.
 */
export class TimedEvictionMap<K, V> {
  private readonly map = new Map<K, TimedEntry<V>>();

  constructor(private readonly ttlMs: number) {
    if (ttlMs < 1) throw new RangeError(`TimedEvictionMap ttlMs must be ≥ 1 (got ${ttlMs})`);
  }

  set(key: K, value: V, now = Date.now()): void {
    this.map.set(key, { value, expiresAt: now + this.ttlMs });
  }

  get(key: K, now = Date.now()): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now) {
      this.map.delete(key);
      return undefined;
    }
    return entry.value;
  }

  has(key: K, now = Date.now()): boolean {
    return this.get(key, now) !== undefined;
  }

  delete(key: K): void {
    this.map.delete(key);
  }

  /**
   * Remove all expired entries.  Call this periodically (e.g. once per poll
   * tick) so memory does not grow from entries that were set but never read.
   *
   * Returns the number of entries removed.
   */
  purge(now = Date.now()): number {
    let removed = 0;
    for (const [key, entry] of this.map) {
      if (entry.expiresAt <= now) {
        this.map.delete(key);
        removed++;
      }
    }
    return removed;
  }

  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }
}

// ── RetryContextStore ─────────────────────────────────────────────────────────

export interface RetryContext {
  /** Logical key identifying the work being retried (e.g. orderId). */
  key: string;
  /** Number of attempts so far. */
  attempts: number;
  /** Timestamp of the first attempt (ms since epoch). */
  startedAt: number;
  /** Timestamp of the most recent attempt. */
  lastAttemptAt: number;
  /** The last error message, for log context. */
  lastError: string | null;
}

/**
 * Bounded store for in-flight retry contexts.
 *
 * Bounds:
 *   - `maxContexts`  — max number of concurrent retry keys.  Oldest entry is
 *                      evicted when the cap is reached.
 *   - `maxAttempts`  — a context that has exceeded this count is considered
 *                      exhausted and removed; `record()` returns false.
 *   - `staleTtlMs`   — contexts not updated within this window are pruned by
 *                      `purgeStale()`.  Prevents phantom entries from keys that
 *                      resolved without calling `remove()`.
 *
 * This does NOT drive the actual retry scheduling — it only tracks state so
 * the listener can make decisions (should I retry? how many times?) and so
 * operators can observe the retry depth through metrics or logs.
 */
export class RetryContextStore {
  private readonly contexts = new BoundedMap<string, RetryContext>(
    Math.max(1, 0) // placeholder; overwritten in constructor
  );
  // We need a real BoundedMap constructed with the caller's maxContexts,
  // but TypeScript field initialisation runs before the constructor body.
  // Re-assign in the constructor instead.
  private store!: BoundedMap<string, RetryContext>;

  private readonly maxAttempts: number;
  private readonly staleTtlMs: number;

  constructor(opts: {
    maxContexts?: number;
    maxAttempts?: number;
    /** How long (ms) a context can go without an update before it is stale. */
    staleTtlMs?: number;
  } = {}) {
    this.store = new BoundedMap<string, RetryContext>(opts.maxContexts ?? 1_000);
    this.maxAttempts = opts.maxAttempts ?? 10;
    this.staleTtlMs = opts.staleTtlMs ?? 5 * 60 * 1000; // 5 minutes default
  }

  /**
   * Record an attempt for `key`.
   *
   * Returns `true` if the attempt was recorded (caller may retry again).
   * Returns `false` when `maxAttempts` has been reached — the context is
   * removed and the caller should give up.
   */
  record(key: string, error?: string): boolean {
    const now = Date.now();
    const existing = this.store.get(key);
    if (existing) {
      existing.attempts++;
      existing.lastAttemptAt = now;
      existing.lastError = error ?? null;
      if (existing.attempts >= this.maxAttempts) {
        this.store.delete(key);
        return false; // exhausted
      }
      return true;
    }

    // First attempt for this key.
    this.store.set(key, {
      key,
      attempts: 1,
      startedAt: now,
      lastAttemptAt: now,
      lastError: error ?? null,
    });
    return true; // may retry
  }

  /** Remove a context when the operation succeeds or is abandoned. */
  remove(key: string): void {
    this.store.delete(key);
  }

  /** Current attempt count for `key`, or 0 if not tracked. */
  attempts(key: string): number {
    return this.store.get(key)?.attempts ?? 0;
  }

  /**
   * Remove all contexts whose `lastAttemptAt` is older than `staleTtlMs`.
   * Call this periodically from the poll loop to bound memory usage.
   *
   * Returns the number of stale contexts removed.
   */
  purgeStale(now = Date.now()): number {
    let removed = 0;
    for (const [key, ctx] of this.store.entries()) {
      if (now - ctx.lastAttemptAt > this.staleTtlMs) {
        this.store.delete(key);
        removed++;
      }
    }
    return removed;
  }

  get size(): number {
    return this.store.size;
  }

  /** Read-only snapshot of all active contexts (for logs / metrics). */
  snapshot(): RetryContext[] {
    return Array.from(this.store.values()).map((c) => ({ ...c }));
  }
}
