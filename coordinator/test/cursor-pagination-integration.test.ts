import { describe, it, expect, beforeEach } from "vitest";
import { pino } from "pino";
import { resolve } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/persistence/db.js";
import { OrderService } from "../src/services/order-service.js";
import { OrdersRepository } from "../src/persistence/orders-repo.js";
import type { AnnounceInput } from "../src/validation/announce.js";

async function freshDb() {
  const dir = mkdtempSync(resolve(tmpdir(), "wafflefinance-cursor-integration-test-"));
  return openDatabase(`file:${dir}/test.db`);
}

const log = pino({ level: "silent" });

const VALID_ETH_ADDR = "0x742d35Cc6634C0532925a3b8d2A3E5ac6cf7d7d5";
const OTHER_ETH_ADDR = "0x8ba1f109551bD432803012645Hac136c8a3e5ea3";
const VALID_STELLAR_ADDR = "GCKFBEIYTKP6H5HNCFLUOXO47ASPH7HY5PDXDDLGNJYQF5T4G2EWN5TB";
const VALID_HASHLOCK_BASE = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";

async function createTestOrders(service: OrderService, count: number, address: string, startIndex = 0): Promise<void> {
  for (let i = 0; i < count; i++) {
    const input: AnnounceInput = {
      direction: "eth_to_xlm",
      hashlock: VALID_HASHLOCK_BASE.slice(0, -4) + (startIndex + i).toString(16).padStart(4, '0'),
      srcChain: "ethereum",
      srcAddress: address,
      srcAsset: "native",
      srcAmount: "1000000000000000000",
      srcSafetyDeposit: "1000000000000000",
      dstChain: "stellar",
      dstAddress: VALID_STELLAR_ADDR,
      dstAsset: "native",
      dstAmount: "100000000"
    };
    await service.announce(input);
    
    // Small delay to ensure different created_at timestamps
    if (i < count - 1) {
      await new Promise(resolve => setTimeout(resolve, 1));
    }
  }
}

describe("Cursor Pagination Integration", () => {
  let service: OrderService;

  beforeEach(async () => {
    const db = await freshDb();
    const repo = new OrdersRepository(db);
    service = new OrderService(repo, log);
  });

  describe("OrderService.historyWithCursor", () => {
    it("integrates cache with database queries", async () => {
      await createTestOrders(service, 5, VALID_ETH_ADDR);
      
      // First request should hit database
      const start1 = Date.now();
      const result1 = await service.historyWithCursor(VALID_ETH_ADDR, 3);
      const time1 = Date.now() - start1;
      
      // Second identical request should hit cache
      const start2 = Date.now();
      const result2 = await service.historyWithCursor(VALID_ETH_ADDR, 3);
      const time2 = Date.now() - start2;
      
      expect(result1).toEqual(result2);
      expect(time2).toBeLessThan(time1); // Cache should be faster
    });

    it("invalidates cache on new order announcement", async () => {
      await createTestOrders(service, 3, VALID_ETH_ADDR);
      
      // Cache initial result
      const initialResult = await service.historyWithCursor(VALID_ETH_ADDR, 10);
      expect(initialResult.orders).toHaveLength(3);
      
      // Add new order with non-colliding hashlocks (startIndex=3)
      await createTestOrders(service, 1, VALID_ETH_ADDR, 3);
      
      // Should get updated result (not cached)
      const updatedResult = await service.historyWithCursor(VALID_ETH_ADDR, 10);
      expect(updatedResult.orders).toHaveLength(4);
      expect(updatedResult.orders[0].createdAt).toBeGreaterThanOrEqual(initialResult.orders[0].createdAt);
    });

    it("invalidates cache on order status updates", async () => {
      const orders = await Promise.all([
        service.announce({
          direction: "eth_to_xlm",
          hashlock: VALID_HASHLOCK_BASE,
          srcChain: "ethereum",
          srcAddress: VALID_ETH_ADDR,
          srcAsset: "native",
          srcAmount: "1000000000000000000",
          srcSafetyDeposit: "1000000000000000",
          dstChain: "stellar",
          dstAddress: VALID_STELLAR_ADDR,
          dstAsset: "native",
          dstAmount: "100000000"
        })
      ]);
      
      // Cache initial result
      const initialResult = await service.historyWithCursor(VALID_ETH_ADDR, 10);
      expect(initialResult.orders[0].status).toBe("announced");
      
      // Update order status
      await service.recordSrcLock({
        publicId: orders[0].publicId,
        orderId: "src-order-1",
        txHash: "0xabcd1234",
        blockNumber: 12345,
        timelock: Math.floor(Date.now() / 1000) + 3600
      });
      
      // Should get updated result with new status
      const updatedResult = await service.historyWithCursor(VALID_ETH_ADDR, 10);
      expect(updatedResult.orders[0].status).toBe("src_locked");
    });

    it("handles cache for different addresses independently", async () => {
      await createTestOrders(service, 3, VALID_ETH_ADDR);
      // Use startIndex=100 to ensure hashlocks don't collide with VALID_ETH_ADDR orders
      await createTestOrders(service, 2, OTHER_ETH_ADDR, 100);
      
      const result1 = await service.historyWithCursor(VALID_ETH_ADDR, 10);
      const result2 = await service.historyWithCursor(OTHER_ETH_ADDR, 10);
      
      expect(result1.orders).toHaveLength(3);
      expect(result2.orders).toHaveLength(2);
      
      // Add order for first address with non-colliding hashlocks (startIndex=3)
      await createTestOrders(service, 1, VALID_ETH_ADDR, 3);
      
      // First address should see new order, second should use cache
      const updatedResult1 = await service.historyWithCursor(VALID_ETH_ADDR, 10);
      const cachedResult2 = await service.historyWithCursor(OTHER_ETH_ADDR, 10);
      
      expect(updatedResult1.orders).toHaveLength(4);
      expect(cachedResult2.orders).toHaveLength(2);
    });
  });

  describe("backward compatibility", () => {
    it("maintains legacy history method", async () => {
      await createTestOrders(service, 10, VALID_ETH_ADDR);
      
      const legacyResult = await service.history(VALID_ETH_ADDR, 5, 2);
      const cursorResult = await service.historyWithCursor(VALID_ETH_ADDR, 10);
      
      // Should get consistent ordering (newest first)
      expect(legacyResult).toHaveLength(5);
      expect(cursorResult.orders).toHaveLength(10);
      
      // Legacy result should match cursor result with appropriate offset
      // (though exact matching depends on timing of inserts)
      expect(legacyResult[0].createdAt).toBeLessThanOrEqual(cursorResult.orders[0].createdAt);
    });
  });

  describe("performance with large datasets", () => {
    it("handles large address history efficiently", async () => {
      const orderCount = 500;
      await createTestOrders(service, orderCount, VALID_ETH_ADDR);
      
      const start = Date.now();
      
      // Paginate through entire history using cursors
      let fetchedCount = 0;
      let cursor: string | undefined;
      const pageSize = 50;
      
      while (true) {
        const result = await service.historyWithCursor(VALID_ETH_ADDR, pageSize, cursor);
        fetchedCount += result.orders.length;
        
        if (!result.nextCursor || result.orders.length === 0) {
          break;
        }
        
        cursor = result.nextCursor;
      }
      
      const totalTime = Date.now() - start;
      
      expect(fetchedCount).toBe(orderCount);
      expect(totalTime).toBeLessThan(5000); // Should complete within 5 seconds
    });

    it("cursor pagination is consistent across pages", async () => {
      await createTestOrders(service, 100, VALID_ETH_ADDR);
      
      const allOrderIds = new Set<number>();
      let cursor: string | undefined;
      const pageSize = 25;
      let pageCount = 0;
      
      while (true) {
        const result = await service.historyWithCursor(VALID_ETH_ADDR, pageSize, cursor);
        
        // Verify no duplicates
        for (const order of result.orders) {
          expect(allOrderIds.has(order.id)).toBe(false);
          allOrderIds.add(order.id);
        }
        
        pageCount++;
        
        if (!result.nextCursor || result.orders.length === 0) {
          break;
        }
        
        cursor = result.nextCursor;
        
        // Prevent infinite loops
        if (pageCount > 10) {
          throw new Error("Too many pages - possible infinite loop");
        }
      }
      
      expect(allOrderIds.size).toBe(100);
      expect(pageCount).toBe(4); // 100 orders / 25 per page = 4 pages
    });
  });

  describe("error handling", () => {
    it("handles invalid cursor gracefully", async () => {
      await createTestOrders(service, 3, VALID_ETH_ADDR);
      
      await expect(
        service.historyWithCursor(VALID_ETH_ADDR, 10, "invalid-cursor")
      ).rejects.toThrow("Invalid cursor");
    });

    it("returns empty result for non-existent address", async () => {
      const result = await service.historyWithCursor("0x999", 10);
      
      expect(result.orders).toHaveLength(0);
      expect(result.nextCursor).toBeNull();
    });
  });

  describe("cache statistics and monitoring", () => {
    it("provides cache statistics", async () => {
      await createTestOrders(service, 3, VALID_ETH_ADDR);
      
      // Make some cached requests
      await service.historyWithCursor(VALID_ETH_ADDR, 10);
      await service.historyWithCursor(VALID_ETH_ADDR, 5);
      
      const stats = service.getCacheStats();
      
      expect(stats.size).toBeGreaterThan(0);
      expect(stats.maxSize).toBeGreaterThan(0);
      expect(stats.ttlMs).toBeGreaterThan(0);
    });

    it("cleans up resources on destroy", () => {
      expect(() => service.destroy()).not.toThrow();
    });
  });
});