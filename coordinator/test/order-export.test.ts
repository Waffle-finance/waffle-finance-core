/**
 * Tests for the order lifecycle export service.
 *
 * Validates that:
 *  - Single order exports include all expected fields
 *  - Lifecycle events are ordered chronologically
 *  - Bulk exports respect filters
 *  - Export output is consistent with repository state
 */

import { describe, it, expect, beforeEach } from "vitest";
import { pino } from "pino";
import Database from "better-sqlite3";
import {
  OrdersRepository,
  type OrderRow,
} from "../src/persistence/orders-repo.js";
import { AuditRepository } from "../src/audit/audit-repo.js";
import { OrderExportService, UnsupportedExportFilterError } from "../src/services/order-export.js";
import { buildOrderAuditEntry } from "../src/audit/audit-log.js";
import { readFileSync } from "fs";
import { resolve } from "path";

describe("OrderExportService", () => {
  let db: Database.Database;
  let ordersRepo: OrdersRepository;
  let auditRepo: AuditRepository;
  let exportService: OrderExportService;
  let log: ReturnType<typeof pino>;

  beforeEach(() => {
    // Create in-memory database
    db = new Database(":memory:");

    // Load schema
    const schemaPath = resolve(__dirname, "../src/persistence/schema.sql");
    const schemaSql = readFileSync(schemaPath, "utf-8");
    db.exec(schemaSql);

    // Initialize repositories
    ordersRepo = new OrdersRepository(db);
    auditRepo = new AuditRepository(db);
    log = pino({ level: "silent" });

    // Initialize export service
    exportService = new OrderExportService(ordersRepo, auditRepo, log);
  });

  describe("Single Order Export", () => {
    it("should export a complete order lifecycle", async () => {
      // Arrange: create an order with full lifecycle
      const order = await ordersRepo.announce({
        direction: "eth_to_xlm",
        hashlock: "0x" + "a".repeat(64),
        srcChain: "ethereum",
        srcAddress: "0xSrcAddress",
        srcAsset: "ETH",
        srcAmount: "1000000000000000000",
        srcSafetyDeposit: "10000000000000000",
        dstChain: "stellar",
        dstAddress: "GDST...",
        dstAsset: "XLM",
        dstAmount: "10000",
      });

      // Add audit entries for lifecycle events
      await auditRepo.append(
        buildOrderAuditEntry("order.announced", {
          orderId: order.publicId,
          hashlock: order.hashlock,
          direction: order.direction,
          srcChain: order.srcChain,
          dstChain: order.dstChain,
        })
      );

      await ordersRepo.recordSrcLock({
        publicId: order.publicId,
        orderId: "src_order_123",
        txHash: "0xSrcTxHash",
        blockNumber: 12345,
        timelock: Math.floor(Date.now() / 1000) + 3600,
      });

      await auditRepo.append(
        buildOrderAuditEntry("order.src_locked", {
          orderId: order.publicId,
          hashlock: order.hashlock,
          direction: order.direction,
          srcChain: order.srcChain,
          dstChain: order.dstChain,
          srcOrderId: "src_order_123",
          srcTxHash: "0xSrcTxHash",
        })
      );

      // Act: export the order
      const exported = await exportService.exportOrder(order.publicId);

      // Assert
      expect(exported).toBeDefined();
      expect(exported!.orderId).toBe(order.publicId);
      expect(exported!.status).toBe("src_locked");
      expect(exported!.direction).toBe("eth_to_xlm");
      expect(exported!.hashlock).toBe(order.hashlock);

      // Check src chain details
      expect(exported!.srcChain.chain).toBe("ethereum");
      expect(exported!.srcChain.address).toBe("0xSrcAddress");
      expect(exported!.srcChain.orderId).toBe("src_order_123");
      expect(exported!.srcChain.lockTx).toBe("0xSrcTxHash");

      // Check dst chain details
      expect(exported!.dstChain.chain).toBe("stellar");
      expect(exported!.dstChain.address).toBe("GDST...");

      // Check secret (not revealed yet)
      expect(exported!.secret.revealed).toBe(false);
      expect(exported!.secret.preimage).toBeNull();

      // Check lifecycle events
      expect(exported!.events).toHaveLength(2);
      expect(exported!.events[0].type).toBe("order.announced");
      expect(exported!.events[1].type).toBe("order.src_locked");

      // Events should be chronologically ordered
      expect(exported!.events[0].timestamp).toBeLessThanOrEqual(
        exported!.events[1].timestamp
      );
    });

    it("should return null for non-existent order", async () => {
      const exported = await exportService.exportOrder("wf_nonexistent");
      expect(exported).toBeNull();
    });

    it("should include secret reveal in lifecycle", async () => {
      // Arrange: create and lock order
      const order = await ordersRepo.announce({
        direction: "eth_to_xlm",
        hashlock: "0x" + "b".repeat(64),
        srcChain: "ethereum",
        srcAddress: "0xSrcAddress",
        srcAsset: "ETH",
        srcAmount: "1000000000000000000",
        srcSafetyDeposit: "10000000000000000",
        dstChain: "stellar",
        dstAddress: "GDST...",
        dstAsset: "XLM",
        dstAmount: "10000",
      });

      await ordersRepo.recordSrcLock({
        publicId: order.publicId,
        orderId: "src_order_123",
        txHash: "0xSrcTxHash",
        blockNumber: 12345,
        timelock: Math.floor(Date.now() / 1000) + 3600,
      });

      // Reveal secret
      await ordersRepo.recordSecretRevealed({
        publicId: order.publicId,
        preimage: "0xPreimage123",
        txHash: "0xRevealTxHash",
      });

      await auditRepo.append(
        buildOrderAuditEntry("order.secret_revealed", {
          orderId: order.publicId,
          hashlock: order.hashlock,
          direction: order.direction,
          srcChain: order.srcChain,
          dstChain: order.dstChain,
          preimage: "0xPreimage123",
          revealedTx: "0xRevealTxHash",
        })
      );

      // Act: export the order
      const exported = await exportService.exportOrder(order.publicId);

      // Assert
      expect(exported!.status).toBe("secret_revealed");
      expect(exported!.secret.revealed).toBe(true);
      expect(exported!.secret.preimage).toBeNull();
      expect(exported!.secret.revealedTx).toBe("0xRevealTxHash");

      // Check events include reveal
      const revealEvent = exported!.events.find((e) => e.type === "order.secret_revealed");
      expect(revealEvent).toBeDefined();
      expect(revealEvent!.payload).not.toHaveProperty("preimage");
    });
  });

  describe("Bulk Export", () => {
    it("should export multiple orders by IDs", async () => {
      // Arrange: create multiple orders
      const order1 = await ordersRepo.announce({
        direction: "eth_to_xlm",
        hashlock: "0x" + "a".repeat(64),
        srcChain: "ethereum",
        srcAddress: "0xSrcAddress",
        srcAsset: "ETH",
        srcAmount: "1000000000000000000",
        srcSafetyDeposit: "10000000000000000",
        dstChain: "stellar",
        dstAddress: "GDST...",
        dstAsset: "XLM",
        dstAmount: "10000",
      });

      const order2 = await ordersRepo.announce({
        direction: "xlm_to_eth",
        hashlock: "0x" + "b".repeat(64),
        srcChain: "stellar",
        srcAddress: "GSRC...",
        srcAsset: "XLM",
        srcAmount: "10000",
        srcSafetyDeposit: "100",
        dstChain: "ethereum",
        dstAddress: "0xDstAddress",
        dstAsset: "ETH",
        dstAmount: "1000000000000000000",
      });

      // Act: export both orders
      const result = await exportService.exportOrders({
        orderIds: [order1.publicId, order2.publicId],
      });

      // Assert
      expect(result.orders).toHaveLength(2);
      expect(result.totalCount).toBe(2);

      const exportedIds = result.orders.map((o) => o.orderId);
      expect(exportedIds).toContain(order1.publicId);
      expect(exportedIds).toContain(order2.publicId);

      // Check metadata
      expect(result.metadata.generatedAt).toBeGreaterThan(0);
      expect(result.metadata.filters.orderIds).toEqual([order1.publicId, order2.publicId]);
    });

    it("should respect limit parameter", async () => {
      // Arrange: create 3 orders
      const orders = await Promise.all(
        [0, 1, 2].map((i) =>
          ordersRepo.announce({
            direction: "eth_to_xlm",
            hashlock: `0x${i.toString().repeat(64)}`,
            srcChain: "ethereum",
            srcAddress: "0xSrcAddress",
            srcAsset: "ETH",
            srcAmount: "1000000000000000000",
            srcSafetyDeposit: "10000000000000000",
            dstChain: "stellar",
            dstAddress: "GDST...",
            dstAsset: "XLM",
            dstAmount: "10000",
          })
        )
      );

      // Act: export with limit=2
      const result = await exportService.exportOrders({
        orderIds: orders.map((o) => o.publicId),
        limit: 2,
      });

      // Assert
      expect(result.orders).toHaveLength(2);
      expect(result.totalCount).toBe(2);
    });
  });

  describe("Status Filter", () => {
    it("should export orders matching a status filter", async () => {
      const order = await ordersRepo.announce({
        direction: "eth_to_xlm",
        hashlock: "0x" + "e".repeat(64),
        srcChain: "ethereum",
        srcAddress: "0xSrcAddress",
        srcAsset: "ETH",
        srcAmount: "1000000000000000000",
        srcSafetyDeposit: "10000000000000000",
        dstChain: "stellar",
        dstAddress: "GDST...",
        dstAsset: "XLM",
        dstAmount: "10000",
      });

      const result = await exportService.exportOrders({ status: "announced" });

      expect(result.orders.map((o) => o.orderId)).toContain(order.publicId);
      expect(result.orders.every((o) => o.status === "announced")).toBe(true);
    });

    it("should reject unsupported filter combinations instead of returning an empty export", async () => {
      await ordersRepo.announce({
        direction: "eth_to_xlm",
        hashlock: "0x" + "f".repeat(64),
        srcChain: "ethereum",
        srcAddress: "0xSrcAddress",
        srcAsset: "ETH",
        srcAmount: "1000000000000000000",
        srcSafetyDeposit: "10000000000000000",
        dstChain: "stellar",
        dstAddress: "GDST...",
        dstAsset: "XLM",
        dstAmount: "10000",
      });

      // srcChain alone has no supported repository query path.
      await expect(
        exportService.exportOrders({ srcChain: "ethereum" })
      ).rejects.toThrow(UnsupportedExportFilterError);

      // No orderId/orderIds/status at all is also unsupported.
      await expect(
        exportService.exportOrders({ createdAfter: 0 })
      ).rejects.toThrow(UnsupportedExportFilterError);
    });
  });

  describe("Export Consistency", () => {
    it("should include all state transitions in lifecycle events", async () => {
      // Arrange: create order with multiple state transitions
      const order = await ordersRepo.announce({
        direction: "eth_to_xlm",
        hashlock: "0x" + "c".repeat(64),
        srcChain: "ethereum",
        srcAddress: "0xSrcAddress",
        srcAsset: "ETH",
        srcAmount: "1000000000000000000",
        srcSafetyDeposit: "10000000000000000",
        dstChain: "stellar",
        dstAddress: "GDST...",
        dstAsset: "XLM",
        dstAmount: "10000",
      });

      // Record lifecycle events
      const events = [
        "order.announced",
        "order.src_locked",
        "order.dst_locked",
        "order.secret_revealed",
      ];

      for (const eventType of events) {
        await auditRepo.append(
          buildOrderAuditEntry(eventType as any, {
            orderId: order.publicId,
            hashlock: order.hashlock,
            direction: order.direction,
            srcChain: order.srcChain,
            dstChain: order.dstChain,
          })
        );
      }

      // Act: export the order
      const exported = await exportService.exportOrder(order.publicId);

      // Assert: all events are present
      expect(exported!.events).toHaveLength(events.length);
      const exportedEventTypes = exported!.events.map((e) => e.type);
      for (const eventType of events) {
        expect(exportedEventTypes).toContain(eventType);
      }
    });

    it("should maintain chronological order for events", async () => {
      // Arrange: create order and add events with delays
      const order = await ordersRepo.announce({
        direction: "eth_to_xlm",
        hashlock: "0x" + "d".repeat(64),
        srcChain: "ethereum",
        srcAddress: "0xSrcAddress",
        srcAsset: "ETH",
        srcAmount: "1000000000000000000",
        srcSafetyDeposit: "10000000000000000",
        dstChain: "stellar",
        dstAddress: "GDST...",
        dstAsset: "XLM",
        dstAmount: "10000",
      });

      // Add events (audit repo assigns timestamps)
      await auditRepo.append(
        buildOrderAuditEntry("order.announced", {
          orderId: order.publicId,
          hashlock: order.hashlock,
          direction: order.direction,
          srcChain: order.srcChain,
          dstChain: order.dstChain,
        })
      );

      // Small delay to ensure different timestamps
      await new Promise((resolve) => setTimeout(resolve, 10));

      await auditRepo.append(
        buildOrderAuditEntry("order.src_locked", {
          orderId: order.publicId,
          hashlock: order.hashlock,
          direction: order.direction,
          srcChain: order.srcChain,
          dstChain: order.dstChain,
        })
      );

      // Act: export the order
      const exported = await exportService.exportOrder(order.publicId);

      // Assert: events are in chronological order
      const timestamps = exported!.events.map((e) => e.timestamp);
      for (let i = 1; i < timestamps.length; i++) {
        expect(timestamps[i]).toBeGreaterThanOrEqual(timestamps[i - 1]);
      }
    });
  });
});
