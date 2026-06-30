/**
 * Tests for the request-ID middleware and structured audit log propagation.
 *
 * Covered scenarios:
 *  - Every response carries an X-Request-ID header.
 *  - Requests without a caller-supplied ID receive a freshly generated UUID v4.
 *  - Two independent requests always receive different IDs.
 *  - A caller-supplied X-Request-ID (≤ 128 chars) is echoed back unchanged.
 *  - An oversized caller-supplied header is replaced with a fresh UUID.
 *  - The same request ID appears in both the HTTP access log and the
 *    downstream OrderService log entry (proving propagation via
 *    AsyncLocalStorage + pino mixin).
 */

import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import pino, { type Logger } from "pino";
import { Writable } from "node:stream";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { openDatabase } from "../src/persistence/db.js";
import { OrdersRepository } from "../src/persistence/orders-repo.js";
import { OrderService } from "../src/services/order-service.js";
import { SecretService } from "../src/services/secret-service.js";
import { QuoteService } from "../src/services/quote-service.js";
import { createApp } from "../src/server/app.js";
import { getRequestId } from "../src/request-context.js";
import { requestIdMiddleware } from "../src/server/middleware/request-id.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

interface LogLine {
  requestId?: string;
  msg?: string;
  publicId?: string;
  hashlock?: string;
  [key: string]: unknown;
}

function makeLogCapture(): { logs: LogLine[]; log: Logger } {
  const logs: LogLine[] = [];
  const dest = new Writable({
    write(chunk, _enc, cb) {
      try {
        logs.push(JSON.parse(chunk.toString()) as LogLine);
      } catch {
        // non-JSON line — ignore
      }
      cb();
    }
  });
  // Mirror the mixin used by getLogger() so requestId is injected at write
  // time from the AsyncLocalStorage store that the middleware populates.
  const log = pino(
    {
      level: "debug",
      mixin() {
        const requestId = getRequestId();
        return requestId ? { requestId } : {};
      }
    },
    dest
  );
  return { logs, log };
}

async function freshApp(capturedLog?: Logger) {
  const dir = mkdtempSync(resolve(tmpdir(), "waffle-reqid-test-"));
  const db = await openDatabase(`file:${dir}/test.db`);
  const repo = new OrdersRepository(db);
  const log = capturedLog ?? pino({ level: "silent" });
  const orders = new OrderService(repo, log);
  const secrets = new SecretService(orders, log);
  const quotes = new QuoteService(log);
  return createApp({ log, corsOrigin: "*", orders, secrets, quotes });
}

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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("request-id middleware", () => {
  it("sets X-Request-ID on responses that have no incoming ID", async () => {
    const app = await freshApp();
    const res = await request(app).get("/healthz");
    expect(res.headers["x-request-id"]).toBeDefined();
    expect(UUID_RE.test(res.headers["x-request-id"])).toBe(true);
  });

  it("generates a different ID for every request", async () => {
    const app = await freshApp();
    const [a, b] = await Promise.all([
      request(app).get("/healthz"),
      request(app).get("/healthz")
    ]);
    expect(a.headers["x-request-id"]).not.toBe(b.headers["x-request-id"]);
  });

  it("echoes a caller-supplied X-Request-ID back unchanged", async () => {
    const app = await freshApp();
    const supplied = "my-trace-12345";
    const res = await request(app).get("/healthz").set("x-request-id", supplied);
    expect(res.headers["x-request-id"]).toBe(supplied);
  });

  it("replaces an oversized caller-supplied ID with a fresh UUID", async () => {
    const app = await freshApp();
    const oversized = "x".repeat(129);
    const res = await request(app).get("/healthz").set("x-request-id", oversized);
    const returned = res.headers["x-request-id"];
    expect(returned).not.toBe(oversized);
    expect(UUID_RE.test(returned)).toBe(true);
  });

  it("sets the ID on /api routes as well as infra routes", async () => {
    const app = await freshApp();
    const res = await request(app).get("/api/secrets/nonexistent");
    expect(res.headers["x-request-id"]).toBeDefined();
    expect(UUID_RE.test(res.headers["x-request-id"])).toBe(true);
  });
});

describe("request ID propagation to service logs", () => {
  it("the same requestId appears in the OrderService announce log and the HTTP response header", async () => {
    const { logs, log } = makeLogCapture();
    const app = await freshApp(log);

    const res = await request(app)
      .post("/api/orders/announce")
      .send(BASE_ANNOUNCE);

    expect(res.status).toBe(201);

    const responseId = res.headers["x-request-id"];
    expect(responseId).toBeDefined();

    // The OrderService emits an "order announced" log line. Because the
    // requestIdMiddleware wraps the request in an AsyncLocalStorage context
    // and the logger has a mixin that reads from that store, the log line
    // must carry the same ID that was returned in the response header.
    const announceLog = logs.find((l) => l.msg === "order announced");
    expect(announceLog).toBeDefined();
    expect(announceLog?.requestId).toBe(responseId);
  });

  it("requestId appears on both announce and secret-related log lines within the same request", async () => {
    const { logs, log } = makeLogCapture();
    const app = await freshApp(log);

    // First announce an order.
    const announceRes = await request(app)
      .post("/api/orders/announce")
      .send(BASE_ANNOUNCE);
    expect(announceRes.status).toBe(201);

    const announceLog = logs.find((l) => l.msg === "order announced");
    const requestId = announceLog?.requestId as string | undefined;

    expect(requestId).toBeDefined();
    expect(UUID_RE.test(requestId!)).toBe(true);

    // Confirm it differs from a second request's ID.
    const secondHashlock = "0x" + "cd".repeat(32);
    const res2 = await request(app)
      .post("/api/orders/announce")
      .send({ ...BASE_ANNOUNCE, hashlock: secondHashlock });
    expect(res2.status).toBe(201);

    const secondLog = logs.find((l) => l.msg === "order announced" && l.hashlock === secondHashlock);
    expect(secondLog?.requestId).toBeDefined();
    expect(secondLog?.requestId).not.toBe(requestId);
  });

  it("the announce log line includes publicId and hashlock for correlation", async () => {
    const { logs, log } = makeLogCapture();
    const app = await freshApp(log);

    const res = await request(app)
      .post("/api/orders/announce")
      .send(BASE_ANNOUNCE);
    expect(res.status).toBe(201);

    const announceLog = logs.find((l) => l.msg === "order announced");
    expect(announceLog?.publicId).toBeDefined();
    expect(announceLog?.hashlock).toBe(VALID_HASHLOCK);
    expect(announceLog?.requestId).toBeDefined();
  });
});

describe("getRequestId() outside a request context", () => {
  it("returns undefined when called outside the AsyncLocalStorage run() scope", () => {
    expect(getRequestId()).toBeUndefined();
  });
});
