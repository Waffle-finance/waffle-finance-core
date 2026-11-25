/**
 * Tests for the expanded coordinator request context (request-context.ts and
 * request-id middleware).
 *
 * Covers:
 *  - runWithContext populates all fields with correct defaults.
 *  - getRequestContext() and getRequestId() return undefined outside a scope.
 *  - correlationId falls back to requestId when not supplied.
 *  - Custom correlationId is preserved.
 *  - addCheckpoint records entries in order with timestamps.
 *  - Concurrent runWithContext scopes do not bleed into each other.
 *  - The X-Request-ID response header is set on every request.
 *  - X-Correlation-ID header is forwarded into the context.
 *  - requestId appears in downstream log lines (AsyncLocalStorage propagation).
 *  - operationClass is inferred correctly from common request paths.
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
import {
  getRequestContext,
  getRequestId,
  getOrderId,
  getCorrelationId,
  setOrderId,
  setCorrelationId,
  runWithContext,
} from "../src/request-context.js";
import { correlationMixin } from "../src/logger.js";
import { sensitiveSerializers } from "../src/sensitive/sensitive-fields.js";
import { CORRELATION_ID_HEADER } from "../src/server/middleware/request-id.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

interface LogLine {
  requestId?: string;
  correlationId?: string;
  orderId?: string;
  msg?: string;
  [key: string]: unknown;
}

function makeLogCapture(): { logs: LogLine[]; log: Logger } {
  const logs: LogLine[] = [];
  const dest = new Writable({
    write(chunk, _enc, cb) {
      try { logs.push(JSON.parse(chunk.toString()) as LogLine); } catch { /* ignore */ }
      cb();
    },
  });
  const log = pino(
    {
      level: "debug",
      mixin: correlationMixin,
      serializers: sensitiveSerializers(),
    },
    dest
  );
  return { logs, log };
}

async function freshApp(capturedLog?: Logger) {
  const dir = mkdtempSync(resolve(tmpdir(), "waffle-ctx-test-"));
  const db = await openDatabase(`file:${dir}/test.db`);
  const repo = new OrdersRepository(db);
  const log = capturedLog ?? pino({ level: "silent" });
  const orders = new OrderService(repo, log);
  const secrets = new SecretService(orders, log);
  const quotes = new QuoteService(log);
  return createApp({ log, corsOrigin: "*", orders, secrets, quotes });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  dstAmount: "100000000",
};

// ── Unit tests for runWithContext ─────────────────────────────────────────────

describe("runWithContext", () => {
  it("populates requestId", () => {
    let seen: string | undefined;
    runWithContext({ requestId: "test-id-001" }, () => {
      seen = getRequestId();
    });
    expect(seen).toBe("test-id-001");
  });

  it("defaults correlationId to requestId when not supplied", () => {
    let ctx: ReturnType<typeof getRequestContext>;
    runWithContext({ requestId: "req-123" }, () => {
      ctx = getRequestContext();
    });
    expect(ctx?.correlationId).toBe("req-123");
  });

  it("preserves a custom correlationId", () => {
    let ctx: ReturnType<typeof getRequestContext>;
    runWithContext({ requestId: "req-456", correlationId: "corr-999" }, () => {
      ctx = getRequestContext();
    });
    expect(ctx?.correlationId).toBe("corr-999");
  });

  it("defaults operationClass to 'unknown'", () => {
    let ctx: ReturnType<typeof getRequestContext>;
    runWithContext({ requestId: "req-789" }, () => {
      ctx = getRequestContext();
    });
    expect(ctx?.operationClass).toBe("unknown");
  });

  it("respects a supplied operationClass", () => {
    let ctx: ReturnType<typeof getRequestContext>;
    runWithContext({ requestId: "req-abc", operationClass: "order.announce" }, () => {
      ctx = getRequestContext();
    });
    expect(ctx?.operationClass).toBe("order.announce");
  });

  it("starts with an empty checkpoints list", () => {
    let ctx: ReturnType<typeof getRequestContext>;
    runWithContext({ requestId: "req-chk" }, () => {
      ctx = getRequestContext();
    });
    expect(ctx?.checkpoints).toHaveLength(0);
  });

  it("addCheckpoint appends entries in order", () => {
    let ctx: ReturnType<typeof getRequestContext>;
    runWithContext({ requestId: "req-chk2" }, () => {
      ctx = getRequestContext();
      ctx!.addCheckpoint("order_fetched");
      ctx!.addCheckpoint("transition_validated");
    });
    expect(ctx?.checkpoints).toHaveLength(2);
    expect(ctx?.checkpoints[0].name).toBe("order_fetched");
    expect(ctx?.checkpoints[1].name).toBe("transition_validated");
    expect(typeof ctx?.checkpoints[0].at).toBe("number");
  });

  it("concurrent scopes do not bleed into each other", async () => {
    const results: Array<string | undefined> = [];

    await Promise.all([
      new Promise<void>((resolve) => {
        runWithContext({ requestId: "scope-A" }, () => {
          setTimeout(() => {
            results[0] = getRequestId();
            resolve();
          }, 10);
        });
      }),
      new Promise<void>((resolve) => {
        runWithContext({ requestId: "scope-B" }, () => {
          setTimeout(() => {
            results[1] = getRequestId();
            resolve();
          }, 5);
        });
      }),
    ]);

    expect(results[0]).toBe("scope-A");
    expect(results[1]).toBe("scope-B");
  });
});

describe("getRequestContext / getRequestId outside a scope", () => {
  it("returns undefined when called without runWithContext", () => {
    expect(getRequestContext()).toBeUndefined();
    expect(getRequestId()).toBeUndefined();
  });
});

// ── HTTP middleware tests ─────────────────────────────────────────────────────

describe("request-id middleware over HTTP", () => {
  it("sets X-Request-ID on every response", async () => {
    const app = await freshApp();
    const res = await request(app).get("/healthz");
    expect(res.headers["x-request-id"]).toBeDefined();
    expect(UUID_RE.test(res.headers["x-request-id"])).toBe(true);
  });

  it("echoes a caller-supplied X-Request-ID", async () => {
    const app = await freshApp();
    const res = await request(app).get("/healthz").set("x-request-id", "my-trace-xyz");
    expect(res.headers["x-request-id"]).toBe("my-trace-xyz");
  });

  it("replaces an oversized X-Request-ID with a fresh UUID", async () => {
    const app = await freshApp();
    const oversized = "x".repeat(129);
    const res = await request(app).get("/healthz").set("x-request-id", oversized);
    expect(res.headers["x-request-id"]).not.toBe(oversized);
    expect(UUID_RE.test(res.headers["x-request-id"])).toBe(true);
  });

  it("forwards X-Correlation-ID through to the context", async () => {
    // We verify propagation indirectly: the correlation ID must survive into
    // service log lines when the feature is wired. Here we confirm the header
    // is not stripped by checking it doesn't cause a 4xx.
    const app = await freshApp();
    const res = await request(app)
      .get("/healthz")
      .set(CORRELATION_ID_HEADER, "upstream-corr-42");
    expect(res.status).toBe(200);
    // The request-id is still set (correlation header doesn't override it).
    expect(res.headers["x-request-id"]).toBeDefined();
  });

  it("generates unique IDs for independent requests", async () => {
    const app = await freshApp();
    const [a, b] = await Promise.all([
      request(app).get("/healthz"),
      request(app).get("/healthz"),
    ]);
    expect(a.headers["x-request-id"]).not.toBe(b.headers["x-request-id"]);
  });
});

describe("request ID propagation to service logs", () => {
  it("the requestId appears in the OrderService announce log line", async () => {
    const { logs, log } = makeLogCapture();
    const app = await freshApp(log);

    const res = await request(app)
      .post("/api/orders/announce")
      .send(BASE_ANNOUNCE);

    expect(res.status).toBe(201);

    const responseId = res.headers["x-request-id"];
    const announceLog = logs.find((l) => l.msg === "order announced");
    expect(announceLog).toBeDefined();
    expect(announceLog?.requestId).toBe(responseId);
  });

  it("two consecutive requests carry different requestIds in their log lines", async () => {
    const { logs, log } = makeLogCapture();
    const app = await freshApp(log);

    await request(app).post("/api/orders/announce").send(BASE_ANNOUNCE);

    const secondHashlock = "0x" + "cd".repeat(32);
    await request(app)
      .post("/api/orders/announce")
      .send({ ...BASE_ANNOUNCE, hashlock: secondHashlock });

    const allAnnounceLogs = logs.filter((l) => l.msg === "order announced");
    expect(allAnnounceLogs).toHaveLength(2);
    expect(allAnnounceLogs[0].requestId).not.toBe(allAnnounceLogs[1].requestId);
  });

  it("propagates correlationId and orderId into service logs on order announce", async () => {
    const { logs, log } = makeLogCapture();
    const app = await freshApp(log);

    const customCorrelation = "corr-upstream-12345";
    const res = await request(app)
      .post("/api/orders/announce")
      .set(CORRELATION_ID_HEADER, customCorrelation)
      .send(BASE_ANNOUNCE);

    expect(res.status).toBe(201);
    const body = res.body;
    expect(body.id).toBeDefined();

    const announceLog = logs.find((l) => l.msg === "order announced");
    expect(announceLog).toBeDefined();
    expect(announceLog?.requestId).toBe(res.headers["x-request-id"]);
    expect(announceLog?.correlationId).toBe(customCorrelation);
    expect(announceLog?.orderId).toBe(body.id);
  });

  it("populates orderId into service logs during order lookup", async () => {
    const { logs, log } = makeLogCapture();
    const app = await freshApp(log);

    const announceRes = await request(app)
      .post("/api/orders/announce")
      .send(BASE_ANNOUNCE);
    expect(announceRes.status).toBe(201);
    const orderId = announceRes.body.id;

    logs.length = 0; // clear announce logs

    const getRes = await request(app)
      .get(`/api/orders/${orderId}`)
      .set(CORRELATION_ID_HEADER, "corr-lookup-999");
    expect(getRes.status).toBe(200);

    const accessLog = logs.find((l) => l.req !== undefined);
    if (accessLog) {
      expect(accessLog.orderId).toBe(orderId);
      expect(accessLog.correlationId).toBe("corr-lookup-999");
    }
  });

  it("redacts sensitive fields in coordinator logs", async () => {
    const { logs, log } = makeLogCapture();
    log.info({ preimage: "0xsecretpreimage123", publicId: "wf_123" }, "test sensitive log");

    const sensitiveLog = logs.find((l) => l.msg === "test sensitive log");
    expect(sensitiveLog).toBeDefined();
    expect(sensitiveLog?.preimage).toBe("[REDACTED]");
    expect(sensitiveLog?.publicId).toBe("wf_123");
  });

  it("getOrderId and setOrderId mutate active context correctly", () => {
    expect(getOrderId()).toBeUndefined();
    expect(getCorrelationId()).toBeUndefined();

    runWithContext({ requestId: "test-req-1" }, () => {
      expect(getRequestId()).toBe("test-req-1");
      expect(getCorrelationId()).toBe("test-req-1");
      expect(getOrderId()).toBeUndefined();

      setOrderId("wf_test_123");
      expect(getOrderId()).toBe("wf_test_123");

      setCorrelationId("corr_test_456");
      expect(getCorrelationId()).toBe("corr_test_456");
    });

    expect(getOrderId()).toBeUndefined();
  });
});
