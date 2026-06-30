import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { pino } from "pino";
import { resolve } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/persistence/db.js";
import { OrderService } from "../src/services/order-service.js";
import { OrdersRepository } from "../src/persistence/orders-repo.js";
import { ordersRoutes } from "../src/server/routes/orders.js";
import type { AnnounceInput } from "../src/validation/announce.js";

async function freshDb() {
  const dir = mkdtempSync(resolve(tmpdir(), "wafflefinance-cursor-api-test-"));
  return openDatabase(`file:${dir}/test.db`);
}

const log = pino({ level: "silent" });

const VALID_ETH_ADDR = "0x742d35Cc6634C0532925a3b8d2A3E5ac6cf7d7d5";
const VALID_STELLAR_ADDR = "GCKFBEIYTKP6H5HNCFLUOXO47ASPH7HY5PDXDDLGNJYQF5T4G2EWN5TB";
const VALID_HASHLOCK_BASE = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";

async function createTestApp(service: OrderService): Promise<express.Application> {
  const app = express();
  app.use(express.json());
  app.use("/api", ordersRoutes(service, log));
  return app;
}

async function createTestOrders(service: OrderService, count: number, address: string): Promise<void> {
  for (let i = 0; i < count; i++) {
    const input: AnnounceInput = {
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
    await service.announce(input);
    
    // Small delay for different timestamps
    if (i < count - 1) {
      await new Promise(resolve => setTimeout(resolve, 1));
    }
  }
}

describe("Cursor Pagination API", () => {
  let app: express.Application;
  let service: OrderService;

  beforeEach(async () => {
    const db = await freshDb();
    const repo = new OrdersRepository(db);
    service = new OrderService(repo, log);
    app = await createTestApp(service);
  });

  describe("GET /orders/history", () => {
    it("returns empty history for address with no orders", async () => {
      const response = await request(app)
        .get("/api/orders/history")
        .query({ address: VALID_ETH_ADDR })
        .expect(200);

      expect(response.body).toEqual({
        transactions: [],
        pagination: {
          limit: 50,
          offset: 0,
          count: 0
        }
      });
    });

    it("returns cursor-based pagination when cursor parameter is provided", async () => {
      await createTestOrders(service, 5, VALID_ETH_ADDR);

      // First get without cursor to show offset mode
      const offsetResponse = await request(app)
        .get("/api/orders/history")
        .query({ 
          address: VALID_ETH_ADDR,
          limit: 3
        })
        .expect(200);

      expect(offsetResponse.body.pagination).toHaveProperty("offset");
      expect(offsetResponse.body.pagination).not.toHaveProperty("nextCursor");

      // Now request with cursor - get first page  
      const db = await freshDb();
      const repo = new OrdersRepository(db);
      const svc = new OrderService(repo, log);
      await createTestOrders(svc, 5, VALID_ETH_ADDR);
      const app2 = await createTestApp(svc);

      const cursorResult = await svc.historyWithCursor(VALID_ETH_ADDR, 3);
      
      const cursorResponse = await request(app2)
        .get("/api/orders/history")
        .query({ 
          address: VALID_ETH_ADDR,
          limit: 3,
          cursor: cursorResult.nextCursor || 'eyJjcmVhdGVkQXQiOjE3MDAwMDAwMDAsImlkIjoxfQ' // Use valid cursor
        })
        .expect(200);

      expect(cursorResponse.body.pagination).toHaveProperty("nextCursor");
      expect(cursorResponse.body.pagination).not.toHaveProperty("offset");
    });

    it("uses cursor parameter for pagination", async () => {
      await createTestOrders(service, 10, VALID_ETH_ADDR);

      // Get first cursor from the service layer directly
      const firstPage = await service.historyWithCursor(VALID_ETH_ADDR, 4);
      expect(firstPage.orders).toHaveLength(4);
      expect(firstPage.nextCursor).toBeDefined();

      // Get second page using cursor via HTTP
      const cursor = firstPage.nextCursor!;
      const page2Response = await request(app)
        .get("/api/orders/history")
        .query({ 
          address: VALID_ETH_ADDR,
          limit: 4,
          cursor
        })
        .expect(200);

      expect(page2Response.body.transactions).toHaveLength(4);
      
      // Verify no overlap between pages
      const page1Ids = firstPage.orders.map((t: any) => t.id);
      const page2Ids = page2Response.body.transactions.map((t: any) => t.id);
      const intersection = page1Ids.filter((id: string) => page2Ids.includes(id));
      expect(intersection).toHaveLength(0);
    });

    it("handles final page correctly (no nextCursor)", async () => {
      await createTestOrders(service, 3, VALID_ETH_ADDR);

      // Get a cursor first, then use cursor mode for a page that is the last
      const firstPage = await service.historyWithCursor(VALID_ETH_ADDR, 10);
      // 3 orders fit in limit=10, so no nextCursor from the service — the route in cursor
      // mode (pass any valid cursor OR use the first-page approach via service) should
      // also return nextCursor: null. Hit the route with cursor mode by passing an empty
      // first-page cursor workaround: encode a future cursor so all 3 orders are returned.
      const futureCursor = Buffer.from(JSON.stringify({ createdAt: Date.now() + 86400000, id: 999999 }), 'utf8')
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');

      const response = await request(app)
        .get("/api/orders/history")
        .query({ 
          address: VALID_ETH_ADDR,
          limit: 10,
          cursor: futureCursor
        })
        .expect(200);

      expect(response.body.transactions).toHaveLength(3);
      expect(response.body.pagination.nextCursor).toBeNull();
    });

    it("maintains backward compatibility with offset pagination", async () => {
      await createTestOrders(service, 10, VALID_ETH_ADDR);

      const response = await request(app)
        .get("/api/orders/history")
        .query({ 
          address: VALID_ETH_ADDR,
          limit: 5,
          offset: 3
        })
        .expect(200);

      expect(response.body.transactions).toHaveLength(5);
      expect(response.body.pagination).toMatchObject({
        limit: 5,
        offset: 3,
        count: 5
      });
      
      // Should NOT have nextCursor in offset mode
      expect(response.body.pagination.nextCursor).toBeUndefined();
    });

    it("returns error for invalid cursor", async () => {
      await createTestOrders(service, 3, VALID_ETH_ADDR);

      const response = await request(app)
        .get("/api/orders/history")
        .query({ 
          address: VALID_ETH_ADDR,
          cursor: "invalid-cursor"
        })
        .expect(400);

      expect(response.body).toMatchObject({
        error: "invalid_cursor",
        message: "The provided cursor is invalid or expired"
      });
    });

    it("requires address parameter", async () => {
      const response = await request(app)
        .get("/api/orders/history")
        .expect(400);

      expect(response.body.error).toBe("validation_error");
      expect(response.body.details).toBeDefined();
    });

    it("enforces maximum limit", async () => {
      await createTestOrders(service, 250, VALID_ETH_ADDR);

      const response = await request(app)
        .get("/api/orders/history")
        .query({ 
          address: VALID_ETH_ADDR,
          limit: 500 // Above maximum
        })
        .expect(200);

      expect(response.body.pagination.limit).toBe(200); // Capped at maximum
    });

    it("handles concurrent requests correctly", async () => {
      await createTestOrders(service, 20, VALID_ETH_ADDR);

      // Make multiple concurrent requests
      const promises = Array.from({ length: 5 }, () =>
        request(app)
          .get("/api/orders/history")
          .query({ 
            address: VALID_ETH_ADDR,
            limit: 10
          })
      );

      const responses = await Promise.all(promises);

      // All requests should succeed
      responses.forEach(response => {
        expect(response.status).toBe(200);
        expect(response.body.transactions).toHaveLength(10);
      });

      // All responses should be identical (cached)
      const firstResponse = responses[0].body;
      responses.slice(1).forEach(response => {
        expect(response.body).toEqual(firstResponse);
      });
    });
  });

  describe("transaction serialization", () => {
    it("serializes orders correctly in cursor-based responses", async () => {
      await createTestOrders(service, 1, VALID_ETH_ADDR);

      const response = await request(app)
        .get("/api/orders/history")
        .query({ address: VALID_ETH_ADDR })
        .expect(200);

      const transaction = response.body.transactions[0];
      
      expect(transaction).toMatchObject({
        id: expect.any(String),
        direction: "eth_to_xlm",
        status: "announced",
        hashlock: expect.stringMatching(/^0x[a-f0-9]{64}$/),
        src: {
          chain: "ethereum",
          address: VALID_ETH_ADDR,
          asset: "native",
          amount: "1000000000000000000",
          safetyDeposit: "1000000000000000",
          orderId: null,
          lockTx: null,
          lockBlock: null,
          timelock: null
        },
        dst: {
          chain: "stellar",
          address: VALID_STELLAR_ADDR,
          asset: "native",
          amount: "100000000",
          orderId: null,
          lockTx: null,
          lockBlock: null,
          timelock: null
        },
        secret: {
          revealed: false,
          preimage: null,
          revealedTx: null
        },
        resolver: null,
        createdAt: expect.any(Number),
        updatedAt: expect.any(Number)
      });
    });

    it("orders transactions by created_at DESC", async () => {
      await createTestOrders(service, 5, VALID_ETH_ADDR);

      const response = await request(app)
        .get("/api/orders/history")
        .query({ 
          address: VALID_ETH_ADDR,
          limit: 5
        })
        .expect(200);

      const createdAtTimes = response.body.transactions.map((t: any) => t.createdAt);
      
      // Should be in descending order (newest first)
      for (let i = 1; i < createdAtTimes.length; i++) {
        expect(createdAtTimes[i]).toBeLessThanOrEqual(createdAtTimes[i - 1]);
      }
    });
  });

  describe("parameter validation", () => {
    beforeEach(async () => {
      await createTestOrders(service, 5, VALID_ETH_ADDR);
    });

    it("handles string limit parameter", async () => {
      const response = await request(app)
        .get("/api/orders/history")
        .query({ 
          address: VALID_ETH_ADDR,
          limit: "3"
        })
        .expect(200);

      expect(response.body.pagination.limit).toBe(3);
    });

    it("handles default limit", async () => {
      const response = await request(app)
        .get("/api/orders/history")
        .query({ address: VALID_ETH_ADDR })
        .expect(200);

      expect(response.body.pagination.limit).toBe(50);
    });

    it("handles empty cursor as no cursor (falls back to offset mode)", async () => {
      // Note: orders already created by the describe-level beforeEach
      
      const response = await request(app)
        .get("/api/orders/history")
        .query({ 
          address: VALID_ETH_ADDR,
          cursor: ""
        })
        .expect(200);

      // Empty cursor should fall back to offset pagination
      expect(response.body.pagination).toHaveProperty("offset");
      expect(response.body.pagination).not.toHaveProperty("nextCursor");
    });
  });

  describe("performance characteristics", () => {
    it("handles large pagination efficiently", async () => {
      await createTestOrders(service, 100, VALID_ETH_ADDR);

      const start = Date.now();

      // First get a valid cursor by querying the service directly
      const firstPage = await service.historyWithCursor(VALID_ETH_ADDR, 20);
      let cursor: string | undefined | null = firstPage.nextCursor;
      let totalFetched = firstPage.orders.length;
      let requestCount = 1;
      
      // Now paginate through remaining orders using cursors
      while (cursor) {
        const response = await request(app)
          .get("/api/orders/history")
          .query({ 
            address: VALID_ETH_ADDR,
            limit: 20,
            cursor
          })
          .expect(200);

        totalFetched += response.body.transactions.length;
        requestCount++;
        
        if (!response.body.pagination.nextCursor || response.body.transactions.length === 0) {
          break;
        }
        
        cursor = response.body.pagination.nextCursor;
        
        // Prevent infinite loops
        if (requestCount > 10) {
          throw new Error("Too many requests - possible infinite loop");
        }
      }

      const totalTime = Date.now() - start;

      expect(totalFetched).toBe(100);
      expect(requestCount).toBe(5); // 100 orders / 20 per page = 5 requests
      expect(totalTime).toBeLessThan(3000); // Should complete within 3 seconds
    });
  });
});