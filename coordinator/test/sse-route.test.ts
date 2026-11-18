/**
 * Integration tests for GET /api/orders/:id/events (SSE route).
 *
 * Uses supertest with a real Express app wired to an in-memory SQLite DB.
 * SSE connections are tested by reading the response body from supertest
 * directly — no real EventSource client needed for these integration checks.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { EventEmitter } from "node:events";
import { sseRoutes } from "../src/server/routes/sse.js";
import pino from "pino";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { openDatabase } from "../src/persistence/db.js";
import { OrdersRepository } from "../src/persistence/orders-repo.js";
import { OrderService } from "../src/services/order-service.js";
import { SecretService } from "../src/services/secret-service.js";
import { QuoteService } from "../src/services/quote-service.js";
import { createApp } from "../src/server/app.js";
import { SseBroker, MAX_SUBSCRIBERS } from "../src/sse/sse-broker.js";
import { buildOrderCreatedPayload } from "../src/sse/event-builders.js";

const log = pino({ level: "silent" });

describe("SSE disconnect cleanup without sockets", () => {
  it.each(["close", "aborted"])("removes a client exactly once after %s", async (event) => {
    vi.useFakeTimers();
    const broker = new SseBroker({ keepAliveIntervalMs: 30_000 });
    try {
      const id = "wf_0x" + "a".repeat(64);
      const orders = { get: vi.fn().mockResolvedValue({ publicId: id }) };
      const router = sseRoutes(orders as unknown as OrderService, broker);
      const handler = router.stack.find(layer => layer.route?.path === "/orders/:id/events")!
        .route.stack[0].handle;
      const connect = async () => {
        const req = Object.assign(new EventEmitter(), { params: { id }, headers: {}, aborted: false });
        const res = Object.assign(new EventEmitter(), {
          writableEnded: false,
          status: vi.fn().mockReturnThis(), set: vi.fn().mockReturnThis(),
          flushHeaders: vi.fn(), write: vi.fn().mockReturnValue(true), end: vi.fn(),
        });
        await handler(req, res, () => {});
        res.write.mockClear();
        return { req, res };
      };
      const closed = await connect();
      const remaining = await connect();
      expect(broker.subscriberCount).toBe(2);
      if (event === "aborted") closed.req.emit("aborted");
      else closed.res.emit("close");
      expect(broker.subscriberCount).toBe(1);
      closed.req.emit("aborted");
      closed.res.emit("close");
      closed.res.emit("close");
      expect(broker.subscriberCount).toBe(1);
      broker.broadcast(id, buildOrderCreatedPayload({
        publicId: id, srcChain: "ethereum", srcLockTx: "0xfake", srcLockBlock: 1, srcTimelock: 100,
      }));
      expect(closed.res.write).not.toHaveBeenCalled();
      expect(remaining.res.write).toHaveBeenCalledTimes(1);
      expect(remaining.res.write.mock.calls[0][0]).toContain("OrderCreated");
      remaining.res.emit("close");
      expect(broker.subscriberCount).toBe(0);
    } finally {
      broker.shutdown();
      vi.useRealTimers();
    }
  });
});

const VALID_HASHLOCK = "0x" + "ab".repeat(32);
const VALID_ETH_ADDR = "0x1111111111111111111111111111111111111111";
const VALID_STELLAR   = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422";

const ANNOUNCE_BODY = {
  direction: "eth_to_xlm",
  hashlock: VALID_HASHLOCK,
  srcChain: "ethereum",
  srcAddress: VALID_ETH_ADDR,
  srcAsset: "native",
  srcAmount: "1000000000000000000",
  srcSafetyDeposit: "1000000000000000",
  dstChain: "stellar",
  dstAddress: VALID_STELLAR,
  dstAsset: "native",
  dstAmount: "100000000",
};

async function buildApp(brokerOverride?: SseBroker) {
  const dir = mkdtempSync(resolve(tmpdir(), "sse-route-test-"));
  const db = await openDatabase(`file:${dir}/test.db`);
  const repo = new OrdersRepository(db);
  const sseBroker = brokerOverride ?? new SseBroker({ keepAliveIntervalMs: 30_000 });
  const orders = new OrderService(repo, log, { sseBroker });
  const secrets = new SecretService(orders, log);
  const quotes = new QuoteService(log);
  const app = createApp({ log, corsOrigin: "*", orders, secrets, quotes, sseBroker });
  return { app, orders, sseBroker, db };
}

describe("GET /api/orders/:id/events — response headers", () => {
  it("returns 200 with Content-Type text/event-stream for a valid order", async () => {
    const { app, orders } = await buildApp();
    const order = await orders.announce(ANNOUNCE_BODY as any);

    // Use a raw http request to check headers without waiting for stream end
    await new Promise<void>((resolve, reject) => {
      const url = new URL(`/api/orders/${order.publicId}/events`, "http://127.0.0.1");
      const server = (app as any).listen(0, "127.0.0.1", () => {
        const addr = server.address() as { port: number };
        const req = require("http").request(
          { hostname: "127.0.0.1", port: addr.port, path: url.pathname, method: "GET",
            headers: { Accept: "text/event-stream" } },
          (res: any) => {
            const ct: string = res.headers["content-type"] ?? "";
            const status: number = res.statusCode;
            res.destroy();
            server.close();
            try {
              expect(status).toBe(200);
              expect(ct).toContain("text/event-stream");
              resolve();
            } catch (e) { reject(e); }
          },
        );
        req.on("error", (e: Error) => { server.close(); reject(e); });
        req.end();
      });
    });
  });

  it("sets X-Accel-Buffering: no", async () => {
    const { app, orders } = await buildApp();
    const order = await orders.announce(ANNOUNCE_BODY as any);

    await new Promise<void>((resolve, reject) => {
      const server = (app as any).listen(0, "127.0.0.1", () => {
        const addr = server.address() as { port: number };
        const req = require("http").request(
          { hostname: "127.0.0.1", port: addr.port,
            path: `/api/orders/${order.publicId}/events`, method: "GET",
            headers: { Accept: "text/event-stream" } },
          (res: any) => {
            const header: string = res.headers["x-accel-buffering"] ?? "";
            res.destroy();
            server.close();
            try {
              expect(header).toBe("no");
              resolve();
            } catch (e) { reject(e); }
          },
        );
        req.on("error", (e: Error) => { server.close(); reject(e); });
        req.end();
      });
    });
  });
});

describe("GET /api/orders/:id/events — error cases", () => {
  it("returns 404 for an unknown order id", async () => {
    const { app } = await buildApp();
    const unknownId = "wf_0x" + "d".repeat(64);
    const res = await request(app).get(`/api/orders/${unknownId}/events`);
    expect(res.status).toBe(404);
  });

  it("returns 400 for a malformed order id", async () => {
    const { app } = await buildApp();
    const res = await request(app).get("/api/orders/not-a-valid-id/events");
    expect(res.status).toBe(400);
  });

  it("returns 503 when the subscriber cap is reached", async () => {
    const { app, orders, sseBroker } = await buildApp();
    const order = await orders.announce(ANNOUNCE_BODY as any);

    // Override subscriberCount to simulate full cap
    vi.spyOn(sseBroker, "subscriberCount", "get").mockReturnValue(MAX_SUBSCRIBERS);

    const res = await request(app).get(`/api/orders/${order.publicId}/events`);
    expect(res.status).toBe(503);
    expect(res.headers["x-wf-error"]).toBe("subscriber-limit");
  });
});

describe("GET /api/orders/:id/events — SSE frame delivery", () => {
  it("delivers an OrderCreated frame when the broker broadcasts", async () => {
    const { app, orders, sseBroker } = await buildApp();
    const order = await orders.announce(ANNOUNCE_BODY as any);

    const frames: string[] = [];
    let serverInstance: any;

    await new Promise<void>((resolve, reject) => {
      const http = require("http");
      serverInstance = http.createServer(app).listen(0, "127.0.0.1", () => {
        const addr = serverInstance.address() as { port: number };
        let buffer = "";

        const req = http.request(
          { hostname: "127.0.0.1", port: addr.port,
            path: `/api/orders/${order.publicId}/events`, method: "GET",
            headers: { Accept: "text/event-stream" } },
          (res: any) => {
            res.setEncoding("utf8");
            res.on("data", (chunk: string) => {
              buffer += chunk;
              const parts = buffer.split("\n\n");
              buffer = parts.pop() ?? "";
              for (const part of parts) {
                if (part.trim()) frames.push(part);
              }
              if (frames.some((f) => f.includes("OrderCreated"))) {
                req.destroy();
                resolve();
              }
            });
            res.on("error", reject);

            // After connection registers, broadcast
            setTimeout(() => {
              sseBroker.broadcast(order.publicId, buildOrderCreatedPayload({
                publicId: order.publicId,
                srcChain: "ethereum",
                srcLockTx: "0xabc",
                srcLockBlock: 100,
                srcTimelock: 9999999,
              }));
              // Allow 1s for delivery before giving up
              setTimeout(() => resolve(), 1000);
            }, 100);
          },
        );
        req.on("error", reject);
        req.end();
      });
    });

    serverInstance?.close();
    expect(frames.some((f) => f.includes("OrderCreated"))).toBe(true);
  }, 5000);
});
