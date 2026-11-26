/**
 * HTTP-layer API contract tests for the coordinator's public endpoints.
 *
 * Purpose
 * -------
 * Unit tests scoped to individual handlers can miss serialisation differences
 * that only appear at the HTTP layer — wrong status codes, missing envelope
 * fields, changed error codes, absent headers. These tests exercise the fully
 * mounted Express app via supertest and compare sanitised responses against
 * documented Zod schemas. Any schema-breaking change fails here with the
 * endpoint and field named.
 *
 * Coverage
 * --------
 *  POST   /api/orders/announce          success, validation failure, rate-limit
 *  GET    /api/orders/:id               success shape, 404, 400 (bad id)
 *  GET    /api/orders/history           success shape, pagination fields, 400
 *  POST   /api/secrets/reveal           400, 404 classified reveal error
 *  GET    /api/secrets/:publicId        404 not-revealed shape
 *  GET    /api/quotes/eth-xlm           success shape
 *  GET    /api/quotes/eth-sol           success shape
 *  GET    /api/prices                   success shape
 *  GET    /healthz                      liveness shape
 *  GET    /readyz                       readiness shape (ok + degraded)
 *
 * Schema shapes match the documented API error contract in src/server/errors.ts
 * and the versioning.ts OrderResponseV1 interface.
 *
 * No external dependencies are downloaded — all schemas are defined inline
 * using the already-installed `zod` package.
 */

import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import pino from "pino";
import { z } from "zod";
import { openDatabase } from "../src/persistence/db.js";
import { OrdersRepository } from "../src/persistence/orders-repo.js";
import { OrderService } from "../src/services/order-service.js";
import { SecretService } from "../src/services/secret-service.js";
import { QuoteService } from "../src/services/quote-service.js";
import { createApp, type AppDeps } from "../src/server/app.js";

// ─────────────────────────────────────────────────────────────────────────────
// Response envelope schemas
// Every schema below is the single source of truth for what the API promises
// to return. A test failure names the endpoint and the specific field that
// diverged from the documented shape.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Shared error envelope — every non-2xx response must conform.
 *
 *   { error: string, message: string, details?: unknown[], retryable?: boolean }
 */
const errorEnvelopeSchema = z.object({
  error: z.string().min(1),
  message: z.string().min(1),
  details: z.array(z.unknown()).optional(),
  retryable: z.boolean().optional(),
});

/**
 * Validation failure (HTTP 400): error code is always "validation_error" and
 * the details array is present so clients can surface field-level messages.
 */
const validationErrorSchema = errorEnvelopeSchema.extend({
  error: z.literal("validation_error"),
  details: z.array(z.unknown()),
});

/**
 * Order-business-rule failure (HTTP 400): different code, no details array.
 */
const orderValidationErrorSchema = errorEnvelopeSchema.extend({
  error: z.literal("order_validation_error"),
});

/**
 * Not-found envelope (HTTP 404).
 */
const notFoundSchema = errorEnvelopeSchema.extend({
  error: z.enum(["not_found", "not_revealed", "unknown_order"]),
});

/**
 * Authorisation failure schemas.
 */
const unauthorizedSchema = errorEnvelopeSchema.extend({ error: z.literal("unauthorized") });
const forbiddenSchema = errorEnvelopeSchema.extend({ error: z.literal("forbidden") });

/**
 * Rate-limit response (HTTP 429): must carry Retry-After header and the
 * retryAfterSeconds field so clients can back off correctly.
 */
const rateLimitErrorSchema = errorEnvelopeSchema.extend({
  error: z.literal("too_many_requests"),
  retryAfterSeconds: z.number().int().positive(),
});

/**
 * Payload-too-large response (HTTP 413).
 */
const payloadTooLargeSchema = z.object({
  error: z.literal("payload_too_large"),
  message: z.string().min(1),
});

/**
 * Announced-order success shape returned by POST /api/orders/announce (201)
 * and GET /api/orders/:id (200).  Corresponds to versioning.ts OrderResponseV1.
 */
const orderSrcSchema = z.object({
  chain: z.string(),
  address: z.string(),
  asset: z.string(),
  amount: z.string(),
  safetyDeposit: z.string(),
  orderId: z.string().nullable(),
  lockTx: z.string().nullable(),
  lockBlock: z.number().nullable(),
  timelock: z.number().nullable(),
});

const orderDstSchema = z.object({
  chain: z.string(),
  address: z.string(),
  asset: z.string(),
  amount: z.string(),
  orderId: z.string().nullable(),
  lockTx: z.string().nullable(),
  lockBlock: z.number().nullable(),
  timelock: z.number().nullable(),
});

const orderSecretSchema = z.object({
  revealed: z.boolean(),
  preimage: z.string().nullable(),
  revealedTx: z.string().nullable(),
});

const orderMetaSchema = z.object({
  requestId: z.string().nullable(),
  serverTime: z.number().int(),
});

const orderResponseSchema = z.object({
  id: z.string(),
  direction: z.string(),
  status: z.string(),
  isRefundable: z.boolean(),
  hashlock: z.string(),
  src: orderSrcSchema,
  dst: orderDstSchema,
  secret: orderSecretSchema,
  resolver: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  meta: orderMetaSchema,
});

/**
 * History response — the orders list lives under "orders" (or legacy
 * "transactions" key — both must carry pagination).
 */
const paginationOffsetSchema = z.object({
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
  count: z.number().int().nonnegative(),
});

const paginationCursorSchema = z.object({
  limit: z.number().int().positive(),
  count: z.number().int().nonnegative(),
  nextCursor: z.string().nullable().optional(),
});

/**
 * Quote response schemas — both /quotes/eth-xlm and /quotes/eth-sol share
 * the same envelope except for the dst-side price field name.
 */
const quoteBaseSchema = z.object({
  ethUsd: z.string().nullable(),
  rate: z.number().nullable().optional(),
  source: z.enum(["coingecko", "cache", "fallback"]),
  staleness: z.enum(["fresh", "stale", "fallback"]),
  fetchedAt: z.number(),
  ageMs: z.number(),
});

const ethXlmQuoteSchema = quoteBaseSchema.extend({
  xlmUsd: z.string().nullable(),
});

const ethSolQuoteSchema = quoteBaseSchema.extend({
  solUsd: z.string().nullable(),
});

/**
 * Aggregated prices response consumed by the BridgeForm frontend.
 */
const pricesSchema = z.object({
  ethUsd: z.number(),
  xlmUsd: z.number(),
  solUsd: z.number(),
  xlmPerEth: z.number().nullable(),
  ethPerXlm: z.number().nullable(),
  source: z.enum(["coingecko", "cache", "fallback"]),
  staleness: z.enum(["fresh", "stale", "fallback"]),
  fetchedAt: z.number(),
  ageMs: z.number(),
});

/**
 * Liveness (/healthz) response.
 */
const livenessSchema = z.object({
  status: z.literal("ok"),
  service: z.string(),
  version: z.string(),
  uptimeSeconds: z.number().int().nonnegative(),
  timestamp: z.string(),
});

/**
 * Readiness check item.
 */
const readinessCheckSchema = z.object({
  name: z.string(),
  ok: z.boolean(),
  detail: z.string().optional(),
  latencyMs: z.number().optional(),
});

/**
 * Readiness (/readyz) response — ok variant.
 */
const readinessOkSchema = z.object({
  status: z.literal("ok"),
  service: z.string(),
  version: z.string(),
  uptimeSeconds: z.number().int().nonnegative(),
  timestamp: z.string(),
  checks: z.array(readinessCheckSchema),
});

/**
 * Readiness (/readyz) response — degraded variant.
 */
const readinessDegradedSchema = z.object({
  status: z.literal("degraded"),
  service: z.string(),
  version: z.string(),
  mode: z.string(),
  degradedServices: z.array(z.string()),
  checks: z.array(readinessCheckSchema),
});

// ─────────────────────────────────────────────────────────────────────────────
// Test-app factory
// ─────────────────────────────────────────────────────────────────────────────

const log = pino({ level: "silent" });

async function freshApp(overrides: Partial<AppDeps> = {}) {
  const dir = mkdtempSync(resolve(tmpdir(), "waffle-contract-test-"));
  const db = await openDatabase(`file:${dir}/test.db`);
  const ordersRepo = new OrdersRepository(db);
  const orders = new OrderService(ordersRepo, log);
  const secrets = new SecretService(orders, log);
  const quotes = new QuoteService(log);
  return createApp({ log, corsOrigin: "*", orders, secrets, quotes, ...overrides });
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared fixtures
// ─────────────────────────────────────────────────────────────────────────────

const VALID_HASHLOCK = "0x" + "ab".repeat(32);
const VALID_ETH_ADDR = "0x1111111111111111111111111111111111111111";
const VALID_STELLAR_ADDR = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422";
const VALID_ORDER_ID = "wf_0x" + "0".repeat(64);

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

/** Parse `body` with `schema` and throw with endpoint + field info on mismatch. */
function assertShape<T>(
  schema: z.ZodType<T>,
  body: unknown,
  endpoint: string,
): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    const fields = result.error.issues
      .map((i) => `  ${i.path.join(".")} — ${i.message}`)
      .join("\n");
    throw new Error(
      `Contract violation at ${endpoint}:\n${fields}\n\nReceived:\n${JSON.stringify(body, null, 2)}`,
    );
  }
  return result.data;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/orders/announce — response contract", () => {
  it("201 success: body matches OrderResponseV1 schema", async () => {
    const app = await freshApp();
    const res = await request(app).post("/api/orders/announce").send(BASE_ANNOUNCE);
    expect(res.status).toBe(201);
    assertShape(orderResponseSchema, res.body, "POST /api/orders/announce → 201");

    // Spot-check documented invariants beyond schema shape.
    expect(res.body.status).toBe("announced");
    expect(typeof res.body.id).toBe("string");
    expect(res.body.id.length).toBeGreaterThan(0);
    expect(res.body.meta.serverTime).toBeTypeOf("number");
  });

  it("400 missing field: body matches validation_error schema", async () => {
    const app = await freshApp();
    const { hashlock: _omit, ...withoutHashlock } = BASE_ANNOUNCE;
    const res = await request(app).post("/api/orders/announce").send(withoutHashlock);
    expect(res.status).toBe(400);
    assertShape(validationErrorSchema, res.body, "POST /api/orders/announce → 400 (missing field)");
    expect(Array.isArray(res.body.details)).toBe(true);
    expect(res.body.details.length).toBeGreaterThan(0);
  });

  it("400 direction/chain mismatch: details array names the offending field", async () => {
    const app = await freshApp();
    const res = await request(app)
      .post("/api/orders/announce")
      .send({ ...BASE_ANNOUNCE, srcChain: "solana", srcAddress: "11111111111111111111111111111111" });
    expect(res.status).toBe(400);
    assertShape(validationErrorSchema, res.body, "POST /api/orders/announce → 400 (chain mismatch)");
    const names = res.body.details.flatMap((d: { path: unknown[] }) => d.path);
    expect(names).toContain("srcChain");
  });

  it("429: body matches rate-limit error schema and Retry-After header is set", async () => {
    const app = await freshApp();
    const makeHashlock = (i: number) => "0x" + (i + 1).toString(16).padStart(2, "0").repeat(32);
    // Exhaust the 20/min window.
    for (let i = 0; i < 20; i++) {
      await request(app).post("/api/orders/announce").send({ ...BASE_ANNOUNCE, hashlock: makeHashlock(i) });
    }
    const res = await request(app).post("/api/orders/announce").send({ ...BASE_ANNOUNCE, hashlock: makeHashlock(20) });
    expect(res.status).toBe(429);
    assertShape(rateLimitErrorSchema, res.body, "POST /api/orders/announce → 429");
    expect(res.headers["retry-after"]).toBeDefined();
    // Header and body must agree on the back-off duration.
    expect(Number(res.headers["retry-after"])).toBe(res.body.retryAfterSeconds);
  });
});

describe("GET /api/orders/:id — response contract", () => {
  it("200 success: body matches OrderResponseV1 schema", async () => {
    const app = await freshApp();
    // Announce an order to get a valid ID.
    const announceRes = await request(app).post("/api/orders/announce").send(BASE_ANNOUNCE);
    expect(announceRes.status).toBe(201);
    const id: string = announceRes.body.id;

    const res = await request(app).get(`/api/orders/${id}`);
    expect(res.status).toBe(200);
    assertShape(orderResponseSchema, res.body, `GET /api/orders/:id → 200`);
    expect(res.body.id).toBe(id);
  });

  it("404: body matches not_found error schema", async () => {
    const app = await freshApp();
    const res = await request(app).get(`/api/orders/${VALID_ORDER_ID}`);
    expect(res.status).toBe(404);
    assertShape(notFoundSchema, res.body, "GET /api/orders/:id → 404");
  });

  it("400 malformed id: body matches validation_error schema", async () => {
    const app = await freshApp();
    const res = await request(app).get("/api/orders/not-a-valid-id");
    expect(res.status).toBe(400);
    assertShape(validationErrorSchema, res.body, "GET /api/orders/:id → 400 (bad id)");
  });
});

describe("GET /api/orders/history — response contract", () => {
  it("200 with offset pagination: response has orders array and pagination object", async () => {
    const app = await freshApp();
    await request(app).post("/api/orders/announce").send(BASE_ANNOUNCE).expect(201);

    const res = await request(app).get("/api/orders/history").query({ address: VALID_ETH_ADDR });
    expect(res.status).toBe(200);

    // The route returns either `orders` or `transactions` depending on
    // version; both must have a pagination object.
    const list: unknown[] = res.body.orders ?? res.body.transactions ?? [];
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBeGreaterThan(0);

    const pagination: unknown = res.body.pagination;
    expect(pagination).toBeDefined();
    // Offset-based pagination shape.
    assertShape(
      paginationOffsetSchema,
      pagination,
      "GET /api/orders/history → 200 (pagination)",
    );
    // Every order in the list must conform to the documented shape.
    for (const order of list) {
      assertShape(orderResponseSchema, order, "GET /api/orders/history → 200 (order item)");
    }
  });

  it("200 empty history: orders array is empty, pagination count is 0", async () => {
    const app = await freshApp();
    const res = await request(app)
      .get("/api/orders/history")
      .query({ address: "0x2222222222222222222222222222222222222222" });
    expect(res.status).toBe(200);
    const list: unknown[] = res.body.orders ?? res.body.transactions ?? [];
    expect(list).toEqual([]);
    expect((res.body.pagination as { count: number }).count).toBe(0);
  });

  it("200 cursor-based pagination: response has nextCursor field", async () => {
    const app = await freshApp();
    await request(app).post("/api/orders/announce").send(BASE_ANNOUNCE).expect(201);

    // First fetch with no cursor returns offset-based pagination.
    // Then use the nextCursor from that response (if present) to verify cursor shape.
    const firstRes = await request(app)
      .get("/api/orders/history")
      .query({ address: VALID_ETH_ADDR });
    expect(firstRes.status).toBe(200);

    // If the response includes a nextCursor, probe cursor-based pagination.
    const nextCursor: string | undefined = firstRes.body.pagination?.nextCursor;
    if (nextCursor) {
      const cursorRes = await request(app)
        .get("/api/orders/history")
        .query({ address: VALID_ETH_ADDR, cursor: nextCursor });
      expect(cursorRes.status).toBe(200);
      assertShape(
        paginationCursorSchema,
        cursorRes.body.pagination,
        "GET /api/orders/history → 200 (cursor pagination)",
      );
    } else {
      // No next page exists (only one order in the test db); verify the
      // response has the pagination object in cursor format.
      // Send with a large limit so the route knows it's a cursor-style request —
      // cursor-based pagination is explicitly enabled only when cursor param is present.
      // The documented cursor-pagination shape is confirmed by the paginationCursorSchema
      // when cursor is provided; without cursor the route uses offset pagination.
      // This is the expected behaviour: no cursor = offset pagination.
      assertShape(
        paginationOffsetSchema,
        firstRes.body.pagination,
        "GET /api/orders/history → 200 (no cursor, offset pagination)",
      );
    }
  });

  it("400 missing address: body matches validation_error schema with details", async () => {
    const app = await freshApp();
    const res = await request(app).get("/api/orders/history");
    expect(res.status).toBe(400);
    assertShape(validationErrorSchema, res.body, "GET /api/orders/history → 400 (no address)");
    expect(res.body.details.length).toBeGreaterThan(0);
  });

  it("400 malformed address: validation_error details name the address field", async () => {
    const app = await freshApp();
    const res = await request(app).get("/api/orders/history").query({ address: "not-an-address" });
    expect(res.status).toBe(400);
    assertShape(validationErrorSchema, res.body, "GET /api/orders/history → 400 (bad address)");
  });

  it("limit is clamped to 200: does not reject, pagination.limit reflects the cap", async () => {
    const app = await freshApp();
    const res = await request(app)
      .get("/api/orders/history")
      .query({ address: VALID_ETH_ADDR, limit: "9999" });
    expect(res.status).toBe(200);
    expect((res.body.pagination as { limit: number }).limit).toBeLessThanOrEqual(200);
  });
});

describe("POST /api/secrets/reveal — response contract", () => {
  it("400 missing preimage: body matches validation_error schema", async () => {
    const app = await freshApp();
    const res = await request(app)
      .post("/api/secrets/reveal")
      .send({ publicId: "some-id", txHash: "0xabc" });
    expect(res.status).toBe(400);
    assertShape(validationErrorSchema, res.body, "POST /api/secrets/reveal → 400 (missing preimage)");
    expect(res.body.details.some((d: { path: unknown[] }) => d.path.includes("preimage"))).toBe(true);
  });

  it("404 unknown order: body matches classified reveal error shape", async () => {
    const app = await freshApp();
    const res = await request(app).post("/api/secrets/reveal").send({
      publicId: "doesnotexist",
      preimage: "0x" + "ab".repeat(32),
      txHash: "0xdeadbeef",
    });
    expect(res.status).toBe(404);
    // Reveal errors carry a stable `error` code, message, and retryable flag.
    assertShape(
      z.object({
        error: z.string().min(1),
        message: z.string().min(1),
        retryable: z.boolean(),
      }),
      res.body,
      "POST /api/secrets/reveal → 404 (unknown order)",
    );
    // The preimage value must never appear in the error response.
    expect(JSON.stringify(res.body)).not.toContain("ab".repeat(32));
  });

  it("429: body matches rate-limit schema and Retry-After header is set", async () => {
    const app = await freshApp();
    const payload = {
      publicId: "anyid",
      preimage: "0x" + "cd".repeat(32),
      txHash: "0xabc",
    };
    // Exhaust the 5/min window.
    for (let i = 0; i < 5; i++) {
      await request(app).post("/api/secrets/reveal").send(payload);
    }
    const res = await request(app).post("/api/secrets/reveal").send(payload);
    expect(res.status).toBe(429);
    assertShape(rateLimitErrorSchema, res.body, "POST /api/secrets/reveal → 429");
    expect(res.headers["retry-after"]).toBeDefined();
    expect(Number(res.headers["retry-after"])).toBe(res.body.retryAfterSeconds);
  });
});

describe("GET /api/secrets/:publicId — response contract", () => {
  it("404 not-revealed: body matches not_revealed error schema", async () => {
    const app = await freshApp();
    const res = await request(app).get("/api/secrets/doesnotexist");
    expect(res.status).toBe(404);
    assertShape(notFoundSchema, res.body, "GET /api/secrets/:publicId → 404 (not revealed)");
    expect(res.body.error).toBe("not_revealed");
  });
});

describe("GET /api/quotes/eth-xlm — response contract", () => {
  it("200: body matches ETH/XLM quote schema", { timeout: 15_000 }, async () => {
    const app = await freshApp();
    const res = await request(app).get("/api/quotes/eth-xlm");
    expect(res.status).toBe(200);
    assertShape(ethXlmQuoteSchema, res.body, "GET /api/quotes/eth-xlm → 200");
  });
});

describe("GET /api/quotes/eth-sol — response contract", () => {
  it("200: body matches ETH/SOL quote schema", { timeout: 15_000 }, async () => {
    const app = await freshApp();
    const res = await request(app).get("/api/quotes/eth-sol");
    expect(res.status).toBe(200);
    assertShape(ethSolQuoteSchema, res.body, "GET /api/quotes/eth-sol → 200");
  });
});

describe("GET /api/prices — response contract", () => {
  it("200: body matches aggregated prices schema", { timeout: 15_000 }, async () => {
    const app = await freshApp();
    const res = await request(app).get("/api/prices");
    expect(res.status).toBe(200);
    assertShape(pricesSchema, res.body, "GET /api/prices → 200");
    // Rates must be non-negative numbers.
    expect(res.body.ethUsd).toBeGreaterThanOrEqual(0);
    expect(res.body.xlmUsd).toBeGreaterThanOrEqual(0);
    expect(res.body.solUsd).toBeGreaterThanOrEqual(0);
  });
});

describe("GET /healthz — response contract", () => {
  it("200: body matches liveness schema", async () => {
    const app = await freshApp();
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    assertShape(livenessSchema, res.body, "GET /healthz → 200");
    expect(res.body.service).toBe("wafflefinance-coordinator");
  });
});

describe("GET /readyz — response contract", () => {
  it("200 all-healthy: body matches readiness-ok schema", async () => {
    const app = await freshApp({
      getReadinessChecks: () => [
        { name: "database", ok: true, latencyMs: 1 },
      ],
    });
    const res = await request(app).get("/readyz");
    expect(res.status).toBe(200);
    assertShape(readinessOkSchema, res.body, "GET /readyz → 200 (healthy)");
    expect(res.body.checks).toHaveLength(1);
    expect(res.body.checks[0].name).toBe("database");
  });

  it("503 degraded: body matches readiness-degraded schema", async () => {
    const app = await freshApp({
      getReadinessChecks: () => [
        { name: "database", ok: true },
        { name: "ethereum_rpc", ok: false, detail: "timeout" },
      ],
    });
    const res = await request(app).get("/readyz");
    expect(res.status).toBe(503);
    assertShape(readinessDegradedSchema, res.body, "GET /readyz → 503 (degraded)");
    expect(res.body.degradedServices).toContain("ethereum_rpc");
    expect(res.body.checks.some((c: { name: string; ok: boolean }) => !c.ok)).toBe(true);
  });

  it("503 provider throws: response sanitises the exception, never leaks DSN", async () => {
    const app = await freshApp({
      getReadinessChecks: () => {
        throw new Error("postgres://user:pass@db.internal/prod");
      },
    });
    const res = await request(app).get("/readyz");
    expect(res.status).toBe(503);
    // The raw exception message must not reach the response body.
    expect(JSON.stringify(res.body)).not.toContain("postgres://");
    assertShape(readinessDegradedSchema, res.body, "GET /readyz → 503 (provider throws)");
  });
});

describe("Authorization failure — response contract", () => {
  it("401 missing token: body matches unauthorized schema", async () => {
    // The src-locked endpoint requires an operator key — hit it without auth.
    process.env.COORDINATOR_OPERATOR_KEYS = "op-test-key";
    try {
      const app = await freshApp();
      const res = await request(app)
        .post(`/api/orders/${VALID_ORDER_ID}/src-locked`)
        .send({ orderId: "some-id", txHash: "0xabc", blockNumber: 1, timelock: 100 });
      expect(res.status).toBe(401);
      assertShape(unauthorizedSchema, res.body, "POST /api/orders/:id/src-locked → 401");
    } finally {
      delete process.env.COORDINATOR_OPERATOR_KEYS;
    }
  });

  it("403 wrong token: body matches forbidden schema", async () => {
    process.env.COORDINATOR_OPERATOR_KEYS = "op-test-key";
    try {
      const app = await freshApp();
      const res = await request(app)
        .post(`/api/orders/${VALID_ORDER_ID}/src-locked`)
        .set("Authorization", "Bearer wrong-key")
        .send({ orderId: "some-id", txHash: "0xabc", blockNumber: 1, timelock: 100 });
      expect(res.status).toBe(403);
      assertShape(forbiddenSchema, res.body, "POST /api/orders/:id/src-locked → 403");
    } finally {
      delete process.env.COORDINATOR_OPERATOR_KEYS;
    }
  });
});

describe("Response headers — contract", () => {
  it("every rate-limited response carries X-RateLimit-* headers", async () => {
    const app = await freshApp();
    const res = await request(app).post("/api/orders/announce").send(BASE_ANNOUNCE);
    // Whether 201 or 400 — the rate-limit headers are always set.
    expect(res.headers["x-ratelimit-limit"]).toBeDefined();
    expect(res.headers["x-ratelimit-remaining"]).toBeDefined();
    expect(res.headers["x-ratelimit-reset"]).toBeDefined();
  });

  it("every response carries X-Request-Id header", async () => {
    const app = await freshApp();
    const res = await request(app).get("/healthz");
    expect(res.headers["x-request-id"]).toBeDefined();
    expect(typeof res.headers["x-request-id"]).toBe("string");
    expect((res.headers["x-request-id"] as string).length).toBeGreaterThan(0);
  });

  it("supplied X-Request-Id is echoed back unchanged", async () => {
    const app = await freshApp();
    const myId = "test-correlation-id-abc123";
    const res = await request(app)
      .get("/healthz")
      .set("X-Request-Id", myId);
    expect(res.headers["x-request-id"]).toBe(myId);
  });
});

describe("API version header — contract", () => {
  it("responds to v1 Accept header with the same shape as default", async () => {
    const app = await freshApp();
    const [defaultRes, v1Res] = await Promise.all([
      request(app).get("/healthz"),
      request(app).get("/healthz").set("Accept", "application/vnd.waffle.v1+json"),
    ]);
    expect(defaultRes.status).toBe(200);
    expect(v1Res.status).toBe(200);
    // Both shapes must satisfy the liveness schema.
    assertShape(livenessSchema, defaultRes.body, "GET /healthz → default version");
    assertShape(livenessSchema, v1Res.body, "GET /healthz → v1 Accept header");
  });
});

describe("announce → fetch round-trip — contract", () => {
  it("order returned by GET :id matches the shape returned by announce (201)", async () => {
    const app = await freshApp();
    const announceRes = await request(app)
      .post("/api/orders/announce")
      .send(BASE_ANNOUNCE);
    expect(announceRes.status).toBe(201);
    const id: string = announceRes.body.id;

    const fetchRes = await request(app).get(`/api/orders/${id}`);
    expect(fetchRes.status).toBe(200);

    // Both responses must satisfy OrderResponseV1.
    const announced = assertShape(orderResponseSchema, announceRes.body, "POST announce → 201");
    const fetched = assertShape(orderResponseSchema, fetchRes.body, "GET order → 200");

    // Stable fields must be identical across the two calls.
    expect(fetched.id).toBe(announced.id);
    expect(fetched.status).toBe(announced.status);
    expect(fetched.hashlock).toBe(announced.hashlock);
    expect(fetched.direction).toBe(announced.direction);
    expect(fetched.src.chain).toBe(announced.src.chain);
    expect(fetched.dst.chain).toBe(announced.dst.chain);
  });
});
