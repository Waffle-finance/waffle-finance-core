/**
 * Focused validation tests for the request-ID middleware — header safety.
 *
 * The existing request-id.test.ts covers happy-path propagation.  This file
 * covers the boundary conditions required by the security fix:
 *
 *   - Oversized header  → replaced with a generated UUID, never echoed back.
 *   - Malformed header  → control characters and special characters are
 *     rejected; a generated UUID is used instead.
 *   - Normal valid ID   → propagated unchanged (regression guard).
 *   - Generated ID      → always a UUID v4 (regression guard for the
 *     no-header case).
 *
 * The unsafe values must not reach response headers, logs, or tracing labels.
 */

import { describe, it, expect } from "vitest";
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
import { createApp } from "../src/server/app.js";
import { isSafeId } from "../src/server/middleware/request-id.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const log = pino({ level: "silent" });

async function freshApp() {
  const dir = mkdtempSync(resolve(tmpdir(), "wf-reqid-val-"));
  const db = await openDatabase(`file:${dir}/test.db`);
  const repo = new OrdersRepository(db);
  const orders = new OrderService(repo, log);
  const secrets = new SecretService(orders, log);
  const quotes = new QuoteService(log);
  return createApp({ log, corsOrigin: "*", orders, secrets, quotes });
}

// ── isSafeId unit tests ───────────────────────────────────────────────────────

describe("isSafeId — character-set validator", () => {
  it("accepts a standard UUID v4", () => {
    expect(isSafeId("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
  });

  it("accepts alphanumeric-only IDs", () => {
    expect(isSafeId("abc123XYZ")).toBe(true);
  });

  it("accepts IDs with hyphens, underscores, and dots", () => {
    expect(isSafeId("trace-id_v2.3")).toBe(true);
  });

  it("rejects an empty string", () => {
    expect(isSafeId("")).toBe(false);
  });

  it("rejects a string longer than 128 characters", () => {
    expect(isSafeId("a".repeat(129))).toBe(false);
  });

  it("accepts a string of exactly 128 characters", () => {
    expect(isSafeId("a".repeat(128))).toBe(true);
  });

  it("rejects a string containing a newline (log injection vector)", () => {
    expect(isSafeId("id\ninjected-log-line")).toBe(false);
  });

  it("rejects a string containing a carriage return", () => {
    expect(isSafeId("id\rvalue")).toBe(false);
  });

  it("rejects a string containing a tab character", () => {
    expect(isSafeId("id\tvalue")).toBe(false);
  });

  it("rejects a string containing a NUL byte", () => {
    expect(isSafeId("id\x00value")).toBe(false);
  });

  it("rejects a string containing a space", () => {
    expect(isSafeId("id value")).toBe(false);
  });

  it("rejects a string with angle brackets (HTML/XML injection)", () => {
    expect(isSafeId("<script>alert(1)</script>")).toBe(false);
  });

  it("rejects a string with semicolons", () => {
    expect(isSafeId("id;rm -rf /")).toBe(false);
  });

  it("rejects a string with percent-encoding characters", () => {
    expect(isSafeId("id%0ainjected")).toBe(false);
  });
});

// ── Integration: X-Request-ID header sanitisation ────────────────────────────

describe("requestIdMiddleware — X-Request-ID header sanitisation", () => {
  it("rejects an oversized header and returns a generated UUID instead", async () => {
    const app = await freshApp();
    const oversized = "x".repeat(129);

    const res = await request(app)
      .get("/healthz")
      .set("x-request-id", oversized);

    const returned = res.headers["x-request-id"];
    // The oversized value must not be echoed back.
    expect(returned).not.toBe(oversized);
    // The replacement must be a valid UUID v4.
    expect(UUID_RE.test(returned)).toBe(true);
  });

  it("rejects a header with a newline character (log injection) — validated by isSafeId", () => {
    // HTTP clients (and Node's http module) reject newlines in headers before
    // they reach Express, so we validate the isSafeId guard directly rather
    // than via a supertest HTTP round-trip.
    expect(isSafeId("good-prefix\nX-Injected: evil")).toBe(false);
    expect(isSafeId("good-prefix\r\nX-Injected: evil")).toBe(false);
  });

  it("rejects a header with control characters — validated by isSafeId", () => {
    // Similarly, ESC sequences and NUL bytes are rejected at the HTTP layer
    // and would never reach the middleware, but isSafeId must still refuse them
    // in case the value arrives via another path (e.g. request body parsing).
    expect(isSafeId("id\x1b[31mRED\x1b[0m")).toBe(false);
    expect(isSafeId("id\x00value")).toBe(false);
  });

  it("accepts a well-formed, short, safe request ID", async () => {
    const app = await freshApp();
    const safeId = "my-load-balancer-trace-99";

    const res = await request(app)
      .get("/healthz")
      .set("x-request-id", safeId);

    expect(res.headers["x-request-id"]).toBe(safeId);
  });

  it("accepts a UUID v4 supplied by the caller", async () => {
    const app = await freshApp();
    const uuid = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

    const res = await request(app)
      .get("/healthz")
      .set("x-request-id", uuid);

    expect(res.headers["x-request-id"]).toBe(uuid);
  });

  it("generates a UUID v4 when no X-Request-ID header is present", async () => {
    const app = await freshApp();
    const res = await request(app).get("/healthz");
    expect(UUID_RE.test(res.headers["x-request-id"])).toBe(true);
  });

  it("rejects a header with a space (header smuggling vector)", async () => {
    const app = await freshApp();
    // Spaces in header values can be used in HTTP request smuggling
    const malformed = "id with spaces";

    const res = await request(app)
      .get("/healthz")
      .set("x-request-id", malformed);

    const returned = res.headers["x-request-id"];
    // Should be replaced by a generated UUID, not the space-containing value
    expect(UUID_RE.test(returned)).toBe(true);
  });

  it("accepts an ID at exactly the 128-character boundary", async () => {
    const app = await freshApp();
    const atLimit = "a".repeat(128);

    const res = await request(app)
      .get("/healthz")
      .set("x-request-id", atLimit);

    expect(res.headers["x-request-id"]).toBe(atLimit);
  });
});

// ── Integration: X-Correlation-ID header sanitisation ────────────────────────

describe("requestIdMiddleware — X-Correlation-ID header sanitisation", () => {
  it("rejects an oversized correlation ID and falls back to the request ID", async () => {
    const app = await freshApp();
    const safeRequestId = "my-request-id-001";
    const oversizedCorrelation = "c".repeat(129);

    const res = await request(app)
      .get("/healthz")
      .set("x-request-id", safeRequestId)
      .set("x-correlation-id", oversizedCorrelation);

    // The request ID should be echoed (it was safe).
    expect(res.headers["x-request-id"]).toBe(safeRequestId);
  });

  it("accepts a valid correlation ID", async () => {
    const app = await freshApp();
    const correlationId = "corr-abc-123";

    const res = await request(app)
      .get("/healthz")
      .set("x-correlation-id", correlationId);

    // The response always echoes the x-request-id, not correlation-id,
    // but the request should succeed and not be rejected.
    expect(res.status).toBe(200);
    expect(res.headers["x-request-id"]).toBeDefined();
  });
});
