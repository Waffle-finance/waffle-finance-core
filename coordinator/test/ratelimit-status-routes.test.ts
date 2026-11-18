/**
 * Rate-limit — order status query endpoints.
 *
 * Issue 51 (resilience): order *announcement*, status *queries*, and *secret
 * retrieval* must all be protected against abusive / runaway clients.  The
 * announce and secret endpoints already had dedicated buckets; the status
 * query surface (`GET /orders/history` and `GET /orders/:id`) was previously
 * unlimited, leaving the most frequently hit endpoints open to abusive
 * polling.
 *
 * This file pins the behaviour of the shared `orders/status` budget:
 *   1. Both status-query routes are rate limited (429 after the budget is
 *      exhausted).
 *   2. History and detail share the same per-IP bucket within one app
 *      instance, so a client cannot rotate between endpoints to evade the
 *      limit.
 *   3. The standard `X-RateLimit-*` headers are present on every decision.
 *   4. A valid API key bypasses the limit; a malformed one does not.
 *   5. Each app instance has an independent store (no cross-test bleed).
 *
 * A minimal stub `OrderService` is used so the middleware is exercised through
 * the real route wiring without the full boot sequence.
 */

import { describe, it, expect } from "vitest";
import supertest from "supertest";
import pino from "pino";
import { ordersRoutes } from "../src/server/routes/orders.js";
import express from "express";

const log = pino({ level: "silent" });

const VALID_API_KEY = "valid-api-key-abc123";

/** Supported Ethereum address used as the required `address` query param. */
const VALID_ADDRESS = "0x1234567890123456789012345678901234567890";

/** Supported order ID used for the detail-route tests. */
const ORDER_ID = "wf_0x" + "1".repeat(64);

/** Minimal OrderService-shaped stub for the routes. */
function stubOrders() {
  return {
    announce: async () => ({}),
    history: async () => [],
    historyWithCursor: async () => ({ orders: [], nextCursor: null }),
    get: async () => null,
    recordSrcLock: async () => undefined,
    recordDstLock: async () => undefined,
  } as any;
}

// The bucket limit for the status routes.
const STATUS_MAX = 240;
/** Number of requests needed to guarantee a 429 for the next request. */
const STATUS_EXHAUST = STATUS_MAX;

describe("orders/status rate limit — status-query endpoints", () => {
  it("returns 429 on /orders/history once the per-IP budget is exhausted", async () => {
    const app = express();
    app.use("/api", ordersRoutes(stubOrders(), log));

    let last = 200;
    for (let i = 0; i < STATUS_EXHAUST; i++) {
      last = (await supertest(app).get(`/api/orders/history?address=${VALID_ADDRESS}`)).status;
    }
    expect(last).toBe(200);
    for (let i = 0; i < 5; i++) {
      last = (await supertest(app).get(`/api/orders/history?address=${VALID_ADDRESS}`)).status;
      if (last === 429) break;
    }
    expect(last).toBe(429);
  });

  it("returns 429 on /orders/:id once the same per-IP budget is exhausted", async () => {
    const app = express();
    app.use("/api", ordersRoutes(stubOrders(), log));

    for (let i = 0; i < STATUS_EXHAUST; i++) {
      await supertest(app).get("/api/orders/${ORDER_ID}");
    }
    const res = await supertest(app).get("/api/orders/${ORDER_ID}");
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ error: "too_many_requests" });
  });

  it("history and detail share one per-IP bucket (no endpoint rotation evasion)", async () => {
    const app = express();
    app.use("/api", ordersRoutes(stubOrders(), log));

    // Exhaust the shared budget on history.
    for (let i = 0; i < STATUS_EXHAUST; i++) {
      await supertest(app).get(`/api/orders/history?address=${VALID_ADDRESS}`);
    }
    // The first detail request is already blocked by the shared budget.
    const res = await supertest(app).get(
      "/api/orders/${ORDER_ID}"
    );
    expect(res.status).toBe(429);
  });

  it("emits X-RateLimit headers on allowed requests", async () => {
    const app = express();
    app.use("/api", ordersRoutes(stubOrders(), log));

    const res = await supertest(app).get(`/api/orders/history?address=${VALID_ADDRESS}`);
    expect(res.status).toBe(200);
    expect(res.headers["x-ratelimit-limit"]).toBe(String(STATUS_MAX));
    expect(res.headers["x-ratelimit-remaining"]).toBe(String(STATUS_MAX - 1));
    expect(Number(res.headers["x-ratelimit-reset"])).toBeGreaterThan(0);
  });

  it("sets Retry-After on a blocked request", async () => {
    const app = express();
    app.use("/api", ordersRoutes(stubOrders(), log));

    for (let i = 0; i < STATUS_EXHAUST; i++) {
      await supertest(app).get(`/api/orders/history?address=${VALID_ADDRESS}`);
    }
    const res = await supertest(app).get(`/api/orders/history?address=${VALID_ADDRESS}`);
    expect(res.status).toBe(429);
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("a valid API key bypasses the status-query budget", async () => {
    const app = express();
    process.env.COORDINATOR_API_KEYS = VALID_API_KEY;
    process.env.COORDINATOR_TRUSTED_PROXIES = "";
    app.use("/api", ordersRoutes(stubOrders(), log));
    delete process.env.COORDINATOR_API_KEYS;

    for (let i = 0; i < STATUS_EXHAUST + 10; i++) {
      const res = await supertest(app)
        .get(`/api/orders/history?address=${VALID_ADDRESS}`)
        .set("Authorization", `Bearer ${VALID_API_KEY}`);
      expect(res.status).toBe(200);
    }
  });

  it("a malformed bearer token does not bypass the budget", async () => {
    const app = express();
    process.env.COORDINATOR_API_KEYS = VALID_API_KEY;
    process.env.COORDINATOR_TRUSTED_PROXIES = "";
    app.use("/api", ordersRoutes(stubOrders(), log));
    delete process.env.COORDINATOR_API_KEYS;

    for (let i = 0; i < STATUS_EXHAUST; i++) {
      await supertest(app)
        .get(`/api/orders/history?address=${VALID_ADDRESS}`)
        .set("Authorization", "Bearer wrong-token");
    }
    const res = await supertest(app)
      .get(`/api/orders/history?address=${VALID_ADDRESS}`)
      .set("Authorization", "Bearer wrong-token");
    expect(res.status).toBe(429);
  });

  it("rate-limit state is per app instance (no bleed between instances)", async () => {
    const app1 = express();
    app1.use("/api", ordersRoutes(stubOrders(), log));
    const app2 = express();
    app2.use("/api", ordersRoutes(stubOrders(), log));

    for (let i = 0; i < STATUS_EXHAUST; i++) {
      await supertest(app1).get(`/api/orders/history?address=${VALID_ADDRESS}`);
    }
    expect((await supertest(app1).get(`/api/orders/history?address=${VALID_ADDRESS}`)).status).toBe(429);
    // A separate instance has its own store and is unaffected.
    expect((await supertest(app2).get(`/api/orders/history?address=${VALID_ADDRESS}`)).status).toBe(200);
  });
});