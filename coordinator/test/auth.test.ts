import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import pino from "pino";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { openDatabase } from "../src/persistence/db.js";
import { OrdersRepository } from "../src/persistence/orders-repo.js";
import { OrderService } from "../src/services/order-service.js";
import { SecretService } from "../src/services/secret-service.js";
import { QuoteService } from "../src/services/quote-service.js";
import { createApp, type AppDeps } from "../src/server/app.js";

const log = pino({ level: "silent" });

const VALID_HASHLOCK = "0x" + "ab".repeat(32);
const VALID_ETH_ADDR = "0x1111111111111111111111111111111111111111";
const VALID_STELLAR_ADDR = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422";

const BASE_ANNOUNCE = {
  direction: "eth_to_xlm",
  hashlock: VALID_HASHLOCK,
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

type FreshAppOptions = Partial<
  Pick<AppDeps, "getReadinessChecks" | "getReconciliationStatus">
>;

async function freshApp(overrides: FreshAppOptions = {}) {
  const dir = mkdtempSync(resolve(tmpdir(), "waffle-auth-test-"));
  const db = await openDatabase(`file:${dir}/test.db`);
  const ordersRepo = new OrdersRepository(db);
  const orders = new OrderService(ordersRepo, log);
  const secrets = new SecretService(orders, log);
  const quotes = new QuoteService(log);
  return createApp({ log, corsOrigin: "*", orders, secrets, quotes, ...overrides });
}

describe("Role-aware Authorization", () => {
  let app: any;
  const originalOperatorKeys = process.env.COORDINATOR_OPERATOR_KEYS;

  beforeEach(async () => {
    process.env.COORDINATOR_OPERATOR_KEYS = "valid-operator-token,second-token";
    app = await freshApp();
  });

  afterEach(() => {
    if (originalOperatorKeys === undefined) {
      delete process.env.COORDINATOR_OPERATOR_KEYS;
    } else {
      process.env.COORDINATOR_OPERATOR_KEYS = originalOperatorKeys;
    }
  });

  describe("POST /api/orders/:id/src-locked", () => {
    const payload = {
      orderId: "src-order-1",
      txHash: "0xlock1",
      blockNumber: 100,
      timelock: 99999
    };

    it("rejects with 401 when no Authorization header is present", async () => {
      const res = await request(app)
        .post("/api/orders/order-1/src-locked")
        .send(payload);

      expect(res.status).toBe(401);
      expect(res.body).toEqual({
        error: "unauthorized",
        message: "Missing or malformed authorization header"
      });
    });

    it("rejects with 403 when token is present but not in the operator set", async () => {
      const res = await request(app)
        .post("/api/orders/order-1/src-locked")
        .set("Authorization", "Bearer invalid-token")
        .send(payload);

      expect(res.status).toBe(403);
      expect(res.body).toEqual({
        error: "forbidden",
        message: "Insufficient permissions or invalid operator key"
      });
    });

    it("accepts with 200 when a valid operator token is presented", async () => {
      // First, announce an order so it exists and can be locked.
      const announceRes = await request(app)
        .post("/api/orders/announce")
        .send(BASE_ANNOUNCE);
      expect(announceRes.status).toBe(201);
      const publicId = announceRes.body.id;

      const res = await request(app)
        .post(`/api/orders/${publicId}/src-locked`)
        .set("Authorization", "Bearer valid-operator-token")
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });
  });

  describe("POST /api/orders/:id/dst-locked", () => {
    const payload = {
      orderId: "dst-order-1",
      txHash: "0xlock2",
      blockNumber: 200,
      timelock: 88888,
      resolver: VALID_ETH_ADDR
    };

    it("rejects with 401 when no Authorization header is present", async () => {
      const res = await request(app)
        .post("/api/orders/order-1/dst-locked")
        .send(payload);

      expect(res.status).toBe(401);
      expect(res.body).toEqual({
        error: "unauthorized",
        message: "Missing or malformed authorization header"
      });
    });

    it("rejects with 403 when token is present but not in the operator set", async () => {
      const res = await request(app)
        .post("/api/orders/order-1/dst-locked")
        .set("Authorization", "Bearer invalid-token")
        .send(payload);

      expect(res.status).toBe(403);
      expect(res.body).toEqual({
        error: "forbidden",
        message: "Insufficient permissions or invalid operator key"
      });
    });

    it("accepts with 200 when a valid operator token is presented", async () => {
      // First, announce an order.
      const announceRes = await request(app)
        .post("/api/orders/announce")
        .send(BASE_ANNOUNCE);
      expect(announceRes.status).toBe(201);
      const publicId = announceRes.body.id;

      // Lock on source chain first since recordDstLock requires src_locked status.
      const srcLockRes = await request(app)
        .post(`/api/orders/${publicId}/src-locked`)
        .set("Authorization", "Bearer valid-operator-token")
        .send({
          orderId: "src-order-1",
          txHash: "0xlock1",
          blockNumber: 100,
          timelock: 99999
        });
      expect(srcLockRes.status).toBe(200);

      const res = await request(app)
        .post(`/api/orders/${publicId}/dst-locked`)
        .set("Authorization", "Bearer valid-operator-token")
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });
  });

  describe("GET /metrics", () => {
    it("rejects with 401 when no Authorization header is present", async () => {
      const res = await request(app).get("/metrics");

      expect(res.status).toBe(401);
      expect(res.body).toEqual({
        error: "unauthorized",
        message: "Missing or malformed authorization header"
      });
    });

    it("rejects with 403 when token is present but not in the operator set", async () => {
      const res = await request(app)
        .get("/metrics")
        .set("Authorization", "Bearer invalid-token");

      expect(res.status).toBe(403);
      expect(res.body).toEqual({
        error: "forbidden",
        message: "Insufficient permissions or invalid operator key"
      });
    });

    it("accepts with 200 and returns Prometheus metrics when a valid operator token is presented", async () => {
      const res = await request(app)
        .get("/metrics")
        .set("Authorization", "Bearer valid-operator-token");

      expect(res.status).toBe(200);
      expect(res.text).toContain("coordinator_");
    });
  });

  describe("Public routes check (unauthenticated)", () => {
    it("allows POST /api/orders/announce without headers", async () => {
      const res = await request(app)
        .post("/api/orders/announce")
        .send(BASE_ANNOUNCE);
      expect(res.status).toBe(201);
    });

    it("allows GET /healthz without headers", async () => {
      const res = await request(app).get("/healthz");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ok");
    });

    it("allows GET /readyz without headers", async () => {
      const res = await request(app).get("/readyz");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ok");
    });
  });
});
