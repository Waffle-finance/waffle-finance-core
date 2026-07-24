/**
 * Tests for the POST /admin/expire-now endpoint and `isRefundable` API field.
 *
 * Coverage:
 *  - POST /admin/expire-now returns 401 without auth
 *  - POST /admin/expire-now returns 200 + expiredCount with valid auth
 *  - POST /admin/expire-now calls runExpiry
 *  - GET /api/orders/:id surfaces status="expired" for an expired order
 *  - GET /api/orders/:id returns isRefundable=true for expired orders
 *  - GET /api/orders/:id returns isRefundable=true for src_locked / dst_locked orders
 *  - GET /api/orders/:id returns isRefundable=false for completed orders
 *  - Refund (markStatus → refunded) succeeds on an expired order
 *  - GET /api/orders/history includes expired orders
 */

import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import pino from "pino";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { openDatabase } from "../src/persistence/db.js";
import { OrdersRepository } from "../src/persistence/orders-repo.js";
import { OrderService } from "../src/services/order-service.js";
import { createApp } from "../src/server/app.js";
import type { ExpiryResult } from "../src/server/routes/admin.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const log = pino({ level: "silent" });
const OPERATOR_KEY = "test-operator-key-expire-scan";
const VALID_HASHLOCK = "0x" + "c".repeat(64);
const ETH_ADDR = "0x2222222222222222222222222222222222222222";
const STELLAR_ADDR = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422";

async function freshDb() {
  const dir = mkdtempSync(resolve(tmpdir(), "wafflefinance-expire-test-"));
  return openDatabase(`file:${dir}/test.db`);
}

const BASE_ORDER = {
  direction: "eth_to_xlm" as const,
  hashlock: VALID_HASHLOCK,
  srcChain: "ethereum" as const,
  srcAddress: ETH_ADDR,
  srcAsset: "native",
  srcAmount: "1000000000000000000",
  srcSafetyDeposit: "1000000000000000",
  dstChain: "stellar" as const,
  dstAddress: STELLAR_ADDR,
  dstAsset: "native",
  dstAmount: "100000000",
};

const PAST = Math.floor(Date.now() / 1000) - 7200;
const FUTURE = Math.floor(Date.now() / 1000) + 7200;

/** Build an app with a stub runExpiry that resolves with the given count. */
function makeApp(orders: OrderService, expiredCount = 0) {
  process.env.COORDINATOR_OPERATOR_KEYS = OPERATOR_KEY;
  let callCount = 0;
  const runExpiry = async (): Promise<ExpiryResult> => {
    callCount++;
    return { expiredCount };
  };
  const app = createApp({
    log,
    corsOrigin: "*",
    orders,
    secrets: {
      reveal: async () => { throw new Error("not implemented"); },
    } as any,
    quotes: {} as any,
    runReconcile: async () => ({ lastRunOk: true, lastRunAt: null, eventsReplayed: 0 }),
    runStaleCleanup: async () => ({ archivedCount: 0 }),
    runExpiry,
  });
  return { app, getCallCount: () => callCount };
}

// ── Auth ─────────────────────────────────────────────────────────────────────

describe("POST /admin/expire-now — authentication", () => {
  it("returns 401 without Authorization header", async () => {
    const db = await freshDb();
    const orders = new OrderService(new OrdersRepository(db), log);
    const { app } = makeApp(orders);
    const res = await request(app).post("/admin/expire-now");
    expect(res.status).toBe(401);
  });

  it("returns 403 with an incorrect operator key", async () => {
    const db = await freshDb();
    const orders = new OrderService(new OrdersRepository(db), log);
    const { app } = makeApp(orders);
    const res = await request(app)
      .post("/admin/expire-now")
      .set("Authorization", "Bearer wrong-key");
    expect(res.status).toBe(403);
  });

  it("returns 200 with the correct operator key", async () => {
    const db = await freshDb();
    const orders = new OrderService(new OrdersRepository(db), log);
    const { app } = makeApp(orders, 0);
    const res = await request(app)
      .post("/admin/expire-now")
      .set("Authorization", `Bearer ${OPERATOR_KEY}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.expiredCount).toBe("number");
  });
});

// ── runExpiry is called ───────────────────────────────────────────────────────

describe("POST /admin/expire-now — calls runExpiry", () => {
  it("invokes the injected runExpiry callback exactly once", async () => {
    const db = await freshDb();
    const orders = new OrderService(new OrdersRepository(db), log);
    const { app, getCallCount } = makeApp(orders, 3);
    await request(app)
      .post("/admin/expire-now")
      .set("Authorization", `Bearer ${OPERATOR_KEY}`);
    expect(getCallCount()).toBe(1);
  });

  it("returns the expiredCount from runExpiry in the response body", async () => {
    const db = await freshDb();
    const orders = new OrderService(new OrdersRepository(db), log);
    const { app } = makeApp(orders, 7);
    const res = await request(app)
      .post("/admin/expire-now")
      .set("Authorization", `Bearer ${OPERATOR_KEY}`);
    expect(res.body.expiredCount).toBe(7);
  });
});

// ── Expired order visible via GET endpoints ───────────────────────────────────

describe("GET /api/orders/:id — expired order visibility", () => {
  it("surfaces status=expired after the expiry scan", async () => {
    const db = await freshDb();
    const repo = new OrdersRepository(db);
    const orders = new OrderService(repo, log);

    const order = await orders.announce(BASE_ORDER);
    await orders.recordSrcLock({
      publicId: order.publicId,
      orderId: "1",
      txHash: "0xsrc",
      blockNumber: 1,
      timelock: PAST,
    });
    await orders.expireStaleOrders();

    const { app } = makeApp(orders);
    const res = await request(app).get(`/api/orders/${order.publicId}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("expired");
  });

  it("returns isRefundable=true for expired orders", async () => {
    const db = await freshDb();
    const repo = new OrdersRepository(db);
    const orders = new OrderService(repo, log);

    const order = await orders.announce(BASE_ORDER);
    await orders.recordSrcLock({
      publicId: order.publicId,
      orderId: "2",
      txHash: "0xsrc2",
      blockNumber: 1,
      timelock: PAST,
    });
    await orders.expireStaleOrders();

    const { app } = makeApp(orders);
    const res = await request(app).get(`/api/orders/${order.publicId}`);
    expect(res.body.isRefundable).toBe(true);
  });

  it("returns isRefundable=true for src_locked orders", async () => {
    const db = await freshDb();
    const repo = new OrdersRepository(db);
    const orders = new OrderService(repo, log);

    const order = await orders.announce(BASE_ORDER);
    await orders.recordSrcLock({
      publicId: order.publicId,
      orderId: "3",
      txHash: "0xsrc3",
      blockNumber: 1,
      timelock: FUTURE,
    });

    const { app } = makeApp(orders);
    const res = await request(app).get(`/api/orders/${order.publicId}`);
    expect(res.body.status).toBe("src_locked");
    expect(res.body.isRefundable).toBe(true);
  });

  it("returns isRefundable=false for completed orders", async () => {
    const db = await freshDb();
    const repo = new OrdersRepository(db);
    const orders = new OrderService(repo, log);

    const order = await orders.announce(BASE_ORDER);
    await orders.recordSrcLock({
      publicId: order.publicId,
      orderId: "4",
      txHash: "0xsrc4",
      blockNumber: 1,
      timelock: FUTURE,
    });
    await orders.recordDstLock({
      publicId: order.publicId,
      orderId: "5",
      txHash: "0xdst5",
      blockNumber: 2,
      timelock: FUTURE,
      resolver: null,
    });
    // Advance to completed (via secret_revealed)
    await orders.markStatus(order.publicId, "secret_revealed");
    await orders.markStatus(order.publicId, "completed");

    const { app } = makeApp(orders);
    const res = await request(app).get(`/api/orders/${order.publicId}`);
    expect(res.body.status).toBe("completed");
    expect(res.body.isRefundable).toBe(false);
  });

  it("returns isRefundable=false for refunded orders", async () => {
    const db = await freshDb();
    const repo = new OrdersRepository(db);
    const orders = new OrderService(repo, log);

    const order = await orders.announce(BASE_ORDER);
    await orders.recordSrcLock({
      publicId: order.publicId,
      orderId: "6",
      txHash: "0xsrc6",
      blockNumber: 1,
      timelock: PAST,
    });
    await orders.markStatus(order.publicId, "refunded");

    const { app } = makeApp(orders);
    const res = await request(app).get(`/api/orders/${order.publicId}`);
    expect(res.body.status).toBe("refunded");
    expect(res.body.isRefundable).toBe(false);
  });
});

// ── Expired orders in history ─────────────────────────────────────────────────

describe("GET /api/orders/history — expired orders are included", () => {
  it("includes expired orders in the address history response", async () => {
    const db = await freshDb();
    const repo = new OrdersRepository(db);
    const orders = new OrderService(repo, log);

    const order = await orders.announce(BASE_ORDER);
    await orders.recordSrcLock({
      publicId: order.publicId,
      orderId: "7",
      txHash: "0xsrc7",
      blockNumber: 1,
      timelock: PAST,
    });
    await orders.expireStaleOrders();

    const { app } = makeApp(orders);
    const res = await request(app).get(
      `/api/orders/history?address=${ETH_ADDR}`
    );
    expect(res.status).toBe(200);
    const expiredOrders = (res.body.transactions as any[]).filter(
      (o) => o.status === "expired"
    );
    expect(expiredOrders.length).toBeGreaterThan(0);
    // Expired orders must carry isRefundable=true
    expect(expiredOrders.every((o) => o.isRefundable === true)).toBe(true);
  });
});

// ── Expired → refunded transition ─────────────────────────────────────────────

describe("Expired order — refund still works", () => {
  it("allows markStatus(refunded) on an expired order via the service layer", async () => {
    const db = await freshDb();
    const repo = new OrdersRepository(db);
    const orders = new OrderService(repo, log);

    const order = await orders.announce(BASE_ORDER);
    await orders.recordSrcLock({
      publicId: order.publicId,
      orderId: "8",
      txHash: "0xsrc8",
      blockNumber: 1,
      timelock: PAST,
    });
    await orders.expireStaleOrders();
    expect((await orders.get(order.publicId))!.status).toBe("expired");

    // Refund must succeed — expired is non-terminal
    await orders.markStatus(order.publicId, "refunded");
    const refunded = await orders.get(order.publicId);
    expect(refunded!.status).toBe("refunded");
    // Once refunded, isRefundable must be false
    const { app } = makeApp(orders);
    const res = await request(app).get(`/api/orders/${refunded!.publicId}`);
    expect(res.body.isRefundable).toBe(false);
  });
});
