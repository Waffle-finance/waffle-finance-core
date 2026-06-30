import type { Logger } from "pino";
import type { OrderRow, OrderHistoryResult } from "../persistence/orders-repo.js";

/**
 * Cache key for address history requests
 */
interface HistoryCacheKey {
  address: string;
  limit: number;
  cursor?: string;
}

/**
 * Cached history result with expiration
 */
interface CachedResult {
  result: OrderHistoryResult;
  expiresAt: number;
}

/**
 * In-memory cache for order history requests.
 * Improves performance for frequently accessed address histories.
 */
export class HistoryCache {
  private readonly cache = new Map<string, CachedResult>();
  private readonly ttlMs: number;
  private readonly maxSize: number;
  private cleanupTimer?: NodeJS.Timeout;

  constructor(
    private readonly log: Logger,
    options: {
      ttlMs?: number;
      maxSize?: number;
      cleanupIntervalMs?: number;
    } = {}
  ) {
    this.ttlMs = options.ttlMs ?? 60_000; // 1 minute default
    this.maxSize = options.maxSize ?? 1000; // 1000 entries default
    
    // Start cleanup timer
    const cleanupInterval = options.cleanupIntervalMs ?? 30_000; // 30 seconds
    this.cleanupTimer = setInterval(() => this.cleanup(), cleanupInterval);
  }

  /**
   * Generate cache key from request parameters
   */
  private makeCacheKey(address: string, limit: number, cursor?: string): string {
    return `${address}:${limit}:${cursor || 'first'}`;
  }

  /**
   * Get cached result if available and not expired
   */
  get(address: string, limit: number, cursor?: string): OrderHistoryResult | null {
    const key = this.makeCacheKey(address, limit, cursor);
    const cached = this.cache.get(key);
    
    if (!cached) {
      return null;
    }
    
    if (Date.now() >= cached.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    
    return cached.result;
  }

  /**
   * Store result in cache
   */
  set(address: string, limit: number, cursor: string | undefined, result: OrderHistoryResult): void {
    // Don't cache if at max size (simple eviction strategy)
    if (this.cache.size >= this.maxSize) {
      this.log.debug({ cacheSize: this.cache.size }, "Cache at max size, not caching new entry");
      return;
    }

    const key = this.makeCacheKey(address, limit, cursor);
    const expiresAt = Date.now() + this.ttlMs;
    
    this.cache.set(key, { result, expiresAt });
    
    this.log.debug({
      cacheKey: key,
      orderCount: result.orders.length,
      hasNextCursor: result.nextCursor !== null,
      expiresAt
    }, "Cached history result");
  }

  /**
   * Invalidate all cache entries for a specific address.
   * Call this when new orders are created for the address.
   */
  invalidateAddress(address: string): void {
    let deletedCount = 0;
    
    for (const [key, _] of this.cache.entries()) {
      if (key.startsWith(`${address}:`)) {
        this.cache.delete(key);
        deletedCount++;
      }
    }
    
    if (deletedCount > 0) {
      this.log.debug({ address, deletedCount }, "Invalidated cache entries for address");
    }
  }

  /**
   * Clear all cache entries
   */
  clear(): void {
    const size = this.cache.size;
    this.cache.clear();
    this.log.debug({ clearedEntries: size }, "Cleared all cache entries");
  }

  /**
   * Remove expired entries from cache
   */
  private cleanup(): void {
    const now = Date.now();
    let removedCount = 0;
    
    for (const [key, cached] of this.cache.entries()) {
      if (now > cached.expiresAt) {
        this.cache.delete(key);
        removedCount++;
      }
    }
    
    if (removedCount > 0) {
      this.log.debug({
        removedCount,
        remainingEntries: this.cache.size
      }, "Cache cleanup completed");
    }
  }

  /**
   * Get cache statistics
   */
  getStats(): { size: number; maxSize: number; ttlMs: number } {
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      ttlMs: this.ttlMs
    };
  }

  /**
   * Cleanup resources
   */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    this.cache.clear();
  }
}