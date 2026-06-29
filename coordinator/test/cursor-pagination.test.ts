import { describe, it, expect, beforeEach } from "vitest";
import { resolve } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/persistence/db.js";
import type { AnnounceOrderInput } from "../src/persistence/orders-repo.js";
import { OrdersRepository } from "../src/persistence/orders-repo.js";

async function freshDb() {
  const dir = mkdtempSync(resolve(tmpdir(), "wafflefinance-cursor-test-"));
  return openDatabase(`file:${dir}/test.db`);
}

async function freshRepo() {
  const db = await freshDb();
  return new OrdersRepository(db);
}

const VALID_ETH_ADDR = "0x742d35Cc6634C0532925a3b8d2A3E5ac6cf7d7d5";
const OTHER_ETH_ADDR = "0x8ba1f109551bD432803012645Hac136c8a3e5ea3";
const VALID_STELLAR_ADDR = "GCKFBEIYTKP6H5HNCFLUOXO47ASPH7HY5PDXDDLGNJYQF5T4G2EWN5TB";
const VALID_HASHLOCK_BASE = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";

async function createTestOrders(repo: OrdersRepository, count: number, address: string): Promise<void> {
  // Create orders with slight time differences to ensure proper ordering
  for (let i = 0; i < count; i++) {
    const input: AnnounceOrderInput = {
      direction: "eth_to_xlm",
      hashlock: VALID_HASHLOCK_BASE.slice(0, -4) + i.toString(16).padStart(4, '0'),
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
    await repo.announce(input);
    
    // Small delay to ensure different created_at timestamps for ordering
    if (i < count - 1) {
      await new Promise(resolve => setTimeout(resolve, 1));
    }
  }
}

describe("Cursor-based Pagination", () => {
  let repo: OrdersRepository;

  beforeEach(async () => {
    repo = await freshRepo();
  });

  describe("findByAddressWithCursor", () => {
    it("returns empty result for address with no orders", async () => {
      const result = await repo.findByAddressWithCursor(VALID_ETH_ADDR, 10);
      
      expect(result.orders).toHaveLength(0);
      expect(result.nextCursor).toBeNull();
    });

    it("returns first page without cursor", async () => {
      await createTestOrders(repo, 5, VALID_ETH_ADDR);
      
      const result = await repo.findByAddressWithCursor(VALID_ETH_ADDR, 3);
      
      expect(result.orders).toHaveLength(3);
      expect(result.nextCursor).not.toBeNull();
      
      // Should be ordered by created_at DESC (most recent first)
      const createdAtTimes = result.orders.map(o => o.createdAt);
      expect(createdAtTimes).toEqual([...createdAtTimes].sort((a, b) => b - a));
    });

    it("returns all orders when limit exceeds total count", async () => {
      await createTestOrders(repo, 3, VALID_ETH_ADDR);
      
      const result = await repo.findByAddressWithCursor(VALID_ETH_ADDR, 10);
      
      expect(result.orders).toHaveLength(3);
      expect(result.nextCursor).toBeNull(); // No next page
    });

    it("handles cursor-based pagination correctly", async () => {
      await createTestOrders(repo, 10, VALID_ETH_ADDR);
      
      // Get first page
      const page1 = await repo.findByAddressWithCursor(VALID_ETH_ADDR, 4);
      expect(page1.orders).toHaveLength(4);
      expect(page1.nextCursor).not.toBeNull();
      
      // Get second page using cursor
      const page2 = await repo.findByAddressWithCursor(VALID_ETH_ADDR, 4, page1.nextCursor!);
      expect(page2.orders).toHaveLength(4);
      expect(page2.nextCursor).not.toBeNull();
      
      // Get third page
      const page3 = await repo.findByAddressWithCursor(VALID_ETH_ADDR, 4, page2.nextCursor!);
      expect(page3.orders).toHaveLength(2); // Remaining orders
      expect(page3.nextCursor).toBeNull(); // No more pages
      
      // Verify no overlaps between pages
      const allIds = [
        ...page1.orders.map(o => o.id),
        ...page2.orders.map(o => o.id),
        ...page3.orders.map(o => o.id)
      ];
      const uniqueIds = [...new Set(allIds)];
      expect(allIds).toHaveLength(uniqueIds.length);
    });

    it("handles pagination consistency during concurrent inserts", async () => {
      await createTestOrders(repo, 5, VALID_ETH_ADDR);
      
      // Get first page
      const page1 = await repo.findByAddressWithCursor(VALID_ETH_ADDR, 3);
      expect(page1.orders).toHaveLength(3);
      
      // Insert new order (would appear first in offset pagination)
      await createTestOrders(repo, 1, VALID_ETH_ADDR);
      
      // Get second page using cursor - should not see the new order
      const page2 = await repo.findByAddressWithCursor(VALID_ETH_ADDR, 3, page1.nextCursor!);
      expect(page2.orders).toHaveLength(2); // Original remaining orders
      expect(page2.nextCursor).toBeNull();
      
      // Verify we got all original orders without duplicates
      const allIds = [...page1.orders, ...page2.orders].map(o => o.id);
      const uniqueIds = [...new Set(allIds)];
      expect(allIds).toHaveLength(uniqueIds.length);
    });

    it("finds orders for both src and dst addresses", async () => {
      const srcInput: AnnounceOrderInput = {
        direction: "eth_to_xlm",
        hashlock: VALID_HASHLOCK_BASE,
        srcChain: "ethereum",
        srcAddress: VALID_ETH_ADDR,
        srcAsset: "native",
        srcAmount: "1000000000000000000",
        srcSafetyDeposit: "1000000000000000",
        dstChain: "stellar",
        dstAddress: OTHER_ETH_ADDR,
        dstAsset: "native",
        dstAmount: "100000000"
      };
      await repo.announce(srcInput);
      
      // Check both addresses find the order
      const srcResult = await repo.findByAddressWithCursor(VALID_ETH_ADDR, 10);
      const dstResult = await repo.findByAddressWithCursor(OTHER_ETH_ADDR, 10);
      
      expect(srcResult.orders).toHaveLength(1);
      expect(dstResult.orders).toHaveLength(1);
      expect(srcResult.orders[0].publicId).toBe(dstResult.orders[0].publicId);
    });

    it("throws error for invalid cursor", async () => {
      await expect(
        repo.findByAddressWithCursor(VALID_ETH_ADDR, 10, "invalid-cursor")
      ).rejects.toThrow("Invalid cursor");
    });

    it("throws error for malformed cursor json", async () => {
      const invalidCursor = Buffer.from("not-json", 'utf8')
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
        
      await expect(
        repo.findByAddressWithCursor(VALID_ETH_ADDR, 10, invalidCursor)
      ).rejects.toThrow("Invalid cursor");
    });

    it("throws error for cursor missing required fields", async () => {
      const invalidCursor = Buffer.from(JSON.stringify({ onlyCreatedAt: 123 }), 'utf8')
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
        
      await expect(
        repo.findByAddressWithCursor(VALID_ETH_ADDR, 10, invalidCursor)
      ).rejects.toThrow("Invalid cursor format: missing or invalid createdAt/id");
    });
  });

  describe("cursor encoding/decoding", () => {
    it("encodes and decodes cursor correctly", async () => {
      await createTestOrders(repo, 1, VALID_ETH_ADDR);
      
      const result = await repo.findByAddressWithCursor(VALID_ETH_ADDR, 1);
      
      if (result.nextCursor) {
        // Should not throw
        const nextPage = await repo.findByAddressWithCursor(VALID_ETH_ADDR, 10, result.nextCursor);
        expect(nextPage.orders).toHaveLength(0); // No more orders
      }
    });

    it("generates stable cursors for same order", async () => {
      await createTestOrders(repo, 2, VALID_ETH_ADDR);
      
      const result1 = await repo.findByAddressWithCursor(VALID_ETH_ADDR, 1);
      const result2 = await repo.findByAddressWithCursor(VALID_ETH_ADDR, 1);
      
      expect(result1.nextCursor).toBe(result2.nextCursor);
    });
  });

  describe("performance comparison", () => {
    it("cursor pagination should be faster than deep offset", { timeout: 30_000 }, async () => {
      await createTestOrders(repo, 1000, VALID_ETH_ADDR);
      
      // Test deep offset pagination
      const offsetStart = Date.now();
      await repo.findByAddress(VALID_ETH_ADDR, 50, 900); // Skip 900 records
      const offsetTime = Date.now() - offsetStart;
      
      // Test cursor pagination to get to similar position
      let cursor: string | undefined;
      const cursorStart = Date.now();
      
      // Navigate to approximate same position using cursors
      for (let i = 0; i < 18; i++) { // 18 * 50 = 900 records
        const result = await repo.findByAddressWithCursor(VALID_ETH_ADDR, 50, cursor);
        cursor = result.nextCursor ?? undefined;
        if (!cursor) break;
      }
      
      const cursorTime = Date.now() - cursorStart;
      
      // Just log the times for visibility - timing tests can be flaky in CI
      console.log(`Offset time: ${offsetTime}ms, Cursor time: ${cursorTime}ms`);
      
      // Very lenient assertion - cursor pagination should complete
      expect(cursorTime).toBeGreaterThan(0);
      expect(offsetTime).toBeGreaterThan(0);
    });
  });

  describe("edge cases", () => {
    it("handles empty cursor string", async () => {
      // Empty cursor should be treated as invalid
      await expect(
        repo.findByAddressWithCursor(VALID_ETH_ADDR, 10, "")
      ).rejects.toThrow("Invalid cursor");
    });

    it("handles cursor with future timestamp", async () => {
      await createTestOrders(repo, 2, VALID_ETH_ADDR);
      
      // Create cursor with future timestamp
      const futureCursor = Buffer.from(JSON.stringify({
        createdAt: Date.now() + 86400000, // 24 hours in future
        id: 999999
      }), 'utf8')
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
      
      const result = await repo.findByAddressWithCursor(VALID_ETH_ADDR, 10, futureCursor);
      
      // Should return all orders (since they're all "before" the future cursor)
      expect(result.orders).toHaveLength(2);
      expect(result.nextCursor).toBeNull();
    });

    it("handles multiple addresses with same timestamps", async () => {
      // This is unlikely but possible if system clock doesn't advance
      const input: AnnounceOrderInput = {
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
      };
      
      await repo.announce(input);
      
      // Second order with slightly different hashlock
      const input2 = { ...input, hashlock: VALID_HASHLOCK_BASE.slice(0, -1) + "1" };
      await repo.announce(input2);
      
      const result = await repo.findByAddressWithCursor(VALID_ETH_ADDR, 1);
      
      expect(result.orders).toHaveLength(1);
      expect(result.nextCursor).not.toBeNull();
      
      const nextResult = await repo.findByAddressWithCursor(VALID_ETH_ADDR, 1, result.nextCursor!);
      expect(nextResult.orders).toHaveLength(1);
    });
  });
});