import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { pino } from "pino";
import { HistoryCache } from "../src/services/history-cache.js";
import type { OrderHistoryResult, OrderRow } from "../src/persistence/orders-repo.js";

const log = pino({ level: "silent" });

function createMockOrder(id: number, createdAt: number): OrderRow {
  return {
    id,
    publicId: `order-${id}`,
    direction: "eth_to_xlm",
    status: "announced",
    hashlock: "0x" + id.toString(16).padStart(64, '0'),
    srcChain: "ethereum",
    srcAddress: "0x742d35Cc6634C0532925a3b8d2A3E5ac6cf7d7d5",
    srcAsset: "native",
    srcAmount: "1000000000000000000",
    srcSafetyDeposit: "1000000000000000",
    srcOrderId: null,
    srcLockTx: null,
    srcLockBlock: null,
    srcTimelock: null,
    dstChain: "stellar",
    dstAddress: "GCKFBEIYTKP6H5HNCFLUOXO47ASPH7HY5PDXDDLGNJYQF5T4G2EWN5TB",
    dstAsset: "native",
    dstAmount: "100000000",
    dstOrderId: null,
    dstLockTx: null,
    dstLockBlock: null,
    dstTimelock: null,
    preimage: null,
    preimageEncVersion: null,
    secretRevealedTx: null,
    resolverAddress: null,
    createdAt,
    updatedAt: createdAt
  };
}

function createMockResult(orderIds: number[], nextCursor: string | null = null): OrderHistoryResult {
  return {
    orders: orderIds.map(id => createMockOrder(id, Date.now() + id)),
    nextCursor
  };
}

describe("HistoryCache", () => {
  let cache: HistoryCache;

  beforeEach(() => {
    cache = new HistoryCache(log, {
      ttlMs: 1000, // 1 second TTL for testing
      maxSize: 10,
      cleanupIntervalMs: 100 // Faster cleanup for testing
    });
  });

  afterEach(() => {
    cache.destroy();
  });

  describe("basic cache operations", () => {
    it("returns null for cache miss", () => {
      const result = cache.get("0x123", 50);
      expect(result).toBeNull();
    });

    it("returns cached result for cache hit", () => {
      const address = "0x123";
      const limit = 50;
      const mockResult = createMockResult([1, 2, 3]);
      
      cache.set(address, limit, undefined, mockResult);
      const retrieved = cache.get(address, limit);
      
      expect(retrieved).toEqual(mockResult);
    });

    it("differentiates between different parameters", () => {
      const address = "0x123";
      const result1 = createMockResult([1, 2]);
      const result2 = createMockResult([3, 4]);
      
      cache.set(address, 25, undefined, result1);
      cache.set(address, 50, undefined, result2);
      
      expect(cache.get(address, 25)).toEqual(result1);
      expect(cache.get(address, 50)).toEqual(result2);
      expect(cache.get(address, 75)).toBeNull(); // Not cached
    });

    it("handles cursor-based cache keys", () => {
      const address = "0x123";
      const cursor = "eyJ0ZXN0IjoidHJ1ZSJ9"; // base64 encoded test cursor
      const result = createMockResult([1, 2, 3]);
      
      cache.set(address, 50, cursor, result);
      
      expect(cache.get(address, 50, cursor)).toEqual(result);
      expect(cache.get(address, 50)).toBeNull(); // Different cursor (undefined)
    });

    it("returns cache statistics", () => {
      const address = "0x123";
      const result = createMockResult([1, 2, 3]);
      
      cache.set(address, 50, undefined, result);
      
      const stats = cache.getStats();
      expect(stats.size).toBe(1);
      expect(stats.maxSize).toBe(10);
      expect(stats.ttlMs).toBe(1000);
    });
  });

  describe("expiration", () => {
    it("expires entries after TTL", async () => {
      const address = "0x123";
      const result = createMockResult([1, 2, 3]);
      
      cache.set(address, 50, undefined, result);
      
      // Should be cached initially
      expect(cache.get(address, 50)).toEqual(result);
      
      // Wait for expiration
      await new Promise(resolve => setTimeout(resolve, 1100));
      
      // Should be expired
      expect(cache.get(address, 50)).toBeNull();
    });

    it("cleans up expired entries automatically", async () => {
      const address = "0x123";
      const result = createMockResult([1, 2, 3]);
      
      cache.set(address, 50, undefined, result);
      expect(cache.getStats().size).toBe(1);
      
      // Wait for expiration and cleanup
      await new Promise(resolve => setTimeout(resolve, 1200));
      
      // Cache should be cleaned up
      expect(cache.getStats().size).toBe(0);
    });
  });

  describe("cache eviction", () => {
    it("does not cache when at max size", () => {
      // Fill cache to max size
      for (let i = 0; i < 10; i++) {
        const address = `0x${i.toString(16).padStart(3, '0')}`;
        const result = createMockResult([i]);
        cache.set(address, 50, undefined, result);
      }
      
      expect(cache.getStats().size).toBe(10);
      
      // Try to add another entry
      const newAddress = "0xaaa";
      const newResult = createMockResult([999]);
      cache.set(newAddress, 50, undefined, newResult);
      
      // Should not be added
      expect(cache.getStats().size).toBe(10);
      expect(cache.get(newAddress, 50)).toBeNull();
    });
  });

  describe("invalidation", () => {
    it("invalidates all entries for an address", () => {
      const address = "0x123";
      
      // Cache multiple entries for the same address
      cache.set(address, 25, undefined, createMockResult([1]));
      cache.set(address, 50, undefined, createMockResult([1, 2]));
      cache.set(address, 50, "cursor1", createMockResult([3, 4]));
      
      // Cache entry for different address
      cache.set("0x456", 50, undefined, createMockResult([5]));
      
      expect(cache.getStats().size).toBe(4);
      
      // Invalidate the first address
      cache.invalidateAddress(address);
      
      // Should only have the other address cached
      expect(cache.getStats().size).toBe(1);
      expect(cache.get(address, 25)).toBeNull();
      expect(cache.get(address, 50)).toBeNull();
      expect(cache.get(address, 50, "cursor1")).toBeNull();
      expect(cache.get("0x456", 50)).not.toBeNull();
    });

    it("handles invalidation of non-existent address", () => {
      const address = "0x123";
      const result = createMockResult([1, 2, 3]);
      
      cache.set(address, 50, undefined, result);
      expect(cache.getStats().size).toBe(1);
      
      // Invalidate different address
      cache.invalidateAddress("0x456");
      
      // Original entry should still be there
      expect(cache.getStats().size).toBe(1);
      expect(cache.get(address, 50)).toEqual(result);
    });

    it("clears all cache entries", () => {
      // Add multiple entries
      for (let i = 0; i < 5; i++) {
        const address = `0x${i.toString(16).padStart(3, '0')}`;
        cache.set(address, 50, undefined, createMockResult([i]));
      }
      
      expect(cache.getStats().size).toBe(5);
      
      cache.clear();
      
      expect(cache.getStats().size).toBe(0);
    });
  });

  describe("cache key generation", () => {
    it("generates different keys for different parameters", () => {
      const address = "0x123";
      
      // Pre-create all results so Date.now() is the same object in set and assertion
      const result1 = createMockResult([1]);
      const result2 = createMockResult([2]);
      const result3 = createMockResult([3]);

      // These should not interfere with each other
      cache.set(address, 50, undefined, result1);
      cache.set(address, 50, "cursor", result2); 
      cache.set(address, 25, undefined, result3);
      
      expect(cache.getStats().size).toBe(3);
      
      expect(cache.get(address, 50)).toEqual(result1);
      expect(cache.get(address, 50, "cursor")).toEqual(result2);
      expect(cache.get(address, 25)).toEqual(result3);
    });
  });

  describe("cleanup and destruction", () => {
    it("stops cleanup timer on destroy", () => {
      const spy = vi.spyOn(global, 'clearInterval');
      
      cache.destroy();
      
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });

    it("clears cache on destroy", () => {
      const address = "0x123";
      cache.set(address, 50, undefined, createMockResult([1, 2, 3]));
      
      expect(cache.getStats().size).toBe(1);
      
      cache.destroy();
      
      expect(cache.getStats().size).toBe(0);
    });
  });

  describe("disabled cache", () => {
    it("works with zero TTL (effectively disabled)", () => {
      const disabledCache = new HistoryCache(log, { ttlMs: 0 });
      
      const address = "0x123";
      const result = createMockResult([1, 2, 3]);
      
      disabledCache.set(address, 50, undefined, result);
      
      // Should immediately be considered expired
      expect(disabledCache.get(address, 50)).toBeNull();
      
      disabledCache.destroy();
    });
  });
});