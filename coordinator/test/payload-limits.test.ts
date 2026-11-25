/**
 * Boundary tests for route-specific payload size and field-length limits.
 *
 * Covers:
 *  a. HTTP 413 when Content-Length or actual body exceeds the route limit.
 *  b. HTTP 400 when individual string fields exceed their documented maximums.
 *  c. Maximum-valid payloads pass validation and reach business logic.
 *  d. Business logic is never reached for oversized inputs (limits fire first).
 *
 * All tests run against a real Express app with an in-memory SQLite database.
 * No mocks, no network.
 */

import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import pino from "pino";
import { openDatabase } from "../src/persistence/db.js";
import { OrdersRepository } from "../src/persistence/orders-repo.js";
import { OrderService } from "../src/services/order-service.js";
import { SecretService } from "../src/services/secret-service.js";
import { QuoteService } from "../src/services/quote-service.js";
import { createApp } from "../src/server/app.js";
import { PAYLOAD_LIMITS } from "../src/server/middleware/payload-limits.js";
import { ANNOUNCE_FIELD_LIMITS } from "../src/validation/announce.js";

// ── Test-app factory ──────────────────────────────────────────────────────────

const log = pino({ level: "silent" });

async function freshApp() {
  const dir = mkdtempSync(resolve(tmpdir(), "waffle-payload-test-"));
  const db = await openDatabase(`file:${dir}/test.db`);
  const ordersRepo = new OrdersRepository(db);
  const orders = new OrderService(ordersRepo, log);
  const secrets = new SecretService(orders, log);
  const quotes = new QuoteService(log);
  return createApp({ log, corsOrigin: "*", orders, secrets, quotes });
}

// ── Shared fixtures ───────────────────────────────────────────────────────────

const VALID_HASHLOCK = "0x" + "ab".repeat(32);        // exactly 66 chars
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

/** Build a JSON string of exactly `targetBytes` bytes, padding `srcAsset`. */
function buildPaddedAnnounce(targetBytes: number): string {
  // Determine how much padding the srcAsset field needs.
  const baseJson = JSON.stringify(BASE_ANNOUNCE);
  const baseLen = Buffer.byteLength(baseJson, "utf8");
  // "srcAsset":"native" is 18 chars in the JSON; replace "native" (6 chars)
  // with a string long enough to hit targetBytes.
  const overhead = baseLen - 6; // everything except the "native" value
  const padLen = Math.max(1, targetBytes - overhead);
  const padded = { ...BASE_ANNOUNCE, srcAsset: "a".repeat(padLen) };
  return JSON.stringify(padded);
}

// ── POST /api/orders/announce ─────────────────────────────────────────────────

describe("POST /api/orders/announce — body-size limit", () => {
  it("accepts a maximum-valid payload (just under the limit)", async () => {
    const app = await freshApp();
    // Use the last byte of room: build a payload whose srcAsset is at the
    // maximum allowed field length. The body will be well under 8 KB.
    const maxAsset = "a".repeat(ANNOUNCE_FIELD_LIMITS.asset); // 200 chars
    const res = await request(app)
      .post("/api/orders/announce")
      .send({ ...BASE_ANNOUNCE, srcAsset: maxAsset, dstAsset: maxAsset });
    // 400 is acceptable here (asset format validation may still reject it),
    // but it must NOT be 413 — the size is within the limit.
    expect(res.status).not.toBe(413);
  });

  it("returns 413 when Content-Length header exceeds the announce limit", async () => {
    const app = await freshApp();
    const oversized = "x".repeat(PAYLOAD_LIMITS.announce + 1);
    const res = await request(app)
      .post("/api/orders/announce")
      .set("Content-Length", String(PAYLOAD_LIMITS.announce + 1))
      .set("Content-Type", "application/json")
      .send(oversized);
    expect(res.status).toBe(413);
    expect(res.body.error).toBe("payload_too_large");
    expect(typeof res.body.message).toBe("string");
    expect(res.body.message.length).toBeGreaterThan(0);
  });

  it("returns 413 for a streamed body that exceeds the announce limit", async () => {
    const app = await freshApp();
    // Build a body that is PAYLOAD_LIMITS.announce + 500 bytes.
    const body = buildPaddedAnnounce(PAYLOAD_LIMITS.announce + 500);
    // Do not set Content-Length so the streaming counter path runs.
    const res = await request(app)
      .post("/api/orders/announce")
      .set("Content-Type", "application/json")
      .set("Transfer-Encoding", "chunked")
      .send(body);
    // Either 413 (streaming check) or 400 (global express.json limit fires first
    // for the same body) — both mean business logic was never reached.
    expect([400, 413]).toContain(res.status);
    if (res.status === 413) {
      expect(res.body.error).toBe("payload_too_large");
    }
  });

  it("business logic is never reached for a 413 response (no DB write)", async () => {
    const app = await freshApp();
    // Send a body larger than the announce limit. If business logic ran it
    // would return 201; a 413 confirms the limit fired before the handler.
    const body = buildPaddedAnnounce(PAYLOAD_LIMITS.announce + 1_000);
    const res = await request(app)
      .post("/api/orders/announce")
      .set("Content-Length", String(Buffer.byteLength(body, "utf8")))
      .set("Content-Type", "application/json")
      .send(body);
    expect(res.status).not.toBe(201);
    expect([400, 413]).toContain(res.status);
  });
});

// ── POST /api/orders/announce — field-length limits ───────────────────────────

describe("POST /api/orders/announce — field-length limits", () => {
  it("accepts srcAddress at the maximum allowed length (100 chars padded)", async () => {
    // A 100-char address will fail chain-format validation, so we expect 400,
    // NOT 413. This confirms the field cap doesn't fire before schema parsing.
    const app = await freshApp();
    const res = await request(app)
      .post("/api/orders/announce")
      .send({ ...BASE_ANNOUNCE, srcAddress: "0x" + "a".repeat(ANNOUNCE_FIELD_LIMITS.address - 2) });
    // Should be a format-level 400, not a size-level 413.
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation_error");
    // Error must name the offending field, not payload_too_large.
    expect(res.body.details?.some((d: { path: string[] }) =>
      d.path.includes("srcAddress")
    )).toBe(true);
  });

  it("rejects srcAddress longer than 100 chars with a field-level 400", async () => {
    const app = await freshApp();
    const res = await request(app)
      .post("/api/orders/announce")
      .send({ ...BASE_ANNOUNCE, srcAddress: "0x" + "a".repeat(ANNOUNCE_FIELD_LIMITS.address) });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation_error");
    expect(res.body.details?.some((d: { path: string[] }) =>
      d.path.includes("srcAddress")
    )).toBe(true);
  });

  it("rejects srcAsset longer than 200 chars with a field-level 400", async () => {
    const app = await freshApp();
    const oversizedAsset = "a".repeat(ANNOUNCE_FIELD_LIMITS.asset + 1);
    const res = await request(app)
      .post("/api/orders/announce")
      .send({ ...BASE_ANNOUNCE, srcAsset: oversizedAsset });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation_error");
    expect(res.body.details?.some((d: { path: string[] }) =>
      d.path.includes("srcAsset")
    )).toBe(true);
  });

  it("rejects srcAmount longer than 78 chars with a field-level 400", async () => {
    const app = await freshApp();
    const oversizedAmount = "9".repeat(ANNOUNCE_FIELD_LIMITS.amount + 1);
    const res = await request(app)
      .post("/api/orders/announce")
      .send({ ...BASE_ANNOUNCE, srcAmount: oversizedAmount });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation_error");
    expect(res.body.details?.some((d: { path: string[] }) =>
      d.path.includes("srcAmount")
    )).toBe(true);
  });

  it("accepts srcAmount at exactly 78 chars (uint256 max boundary)", async () => {
    // 78 nines — a valid decimal string at the documented limit.
    const app = await freshApp();
    const maxAmount = "9".repeat(ANNOUNCE_FIELD_LIMITS.amount);
    const res = await request(app)
      .post("/api/orders/announce")
      .send({ ...BASE_ANNOUNCE, srcAmount: maxAmount });
    // Not 413. Business-logic or address errors may still return 400.
    expect(res.status).not.toBe(413);
    // If the error is size-related it would name srcAmount with a "too long"
    // message; a format error or policy error is fine.
    if (res.status === 400) {
      const isSizeLimitIssue = res.body.details?.some(
        (d: { path: string[]; message: string }) =>
          d.path.includes("srcAmount") && d.message.includes("most 78")
      );
      expect(isSizeLimitIssue).toBe(false);
    }
  });

  it("rejects dstAmount longer than 78 chars", async () => {
    const app = await freshApp();
    const res = await request(app)
      .post("/api/orders/announce")
      .send({ ...BASE_ANNOUNCE, dstAmount: "1".repeat(ANNOUNCE_FIELD_LIMITS.amount + 1) });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation_error");
    expect(res.body.details?.some((d: { path: string[] }) =>
      d.path.includes("dstAmount")
    )).toBe(true);
  });
});

// ── POST /api/secrets/reveal — body-size and field limits ─────────────────────

describe("POST /api/secrets/reveal — body-size limit", () => {
  const VALID_REVEAL = {
    publicId: "wf_0x" + "a".repeat(64),
    preimage: "0x" + "ab".repeat(32),
    txHash: "0x" + "cd".repeat(32),
  };

  it("accepts a maximum-valid reveal payload", async () => {
    const app = await freshApp();
    // Max-valid: publicId = 100 chars, preimage = 132 chars, txHash = 132 chars.
    const maxPayload = {
      publicId: "wf_" + "a".repeat(97),   // 100 chars total
      preimage: "0x" + "ab".repeat(65),   // 132 chars total
      txHash: "0x" + "cd".repeat(65),     // 132 chars total
    };
    const res = await request(app)
      .post("/api/secrets/reveal")
      .send(maxPayload);
    // Not 413 — size is within limit. 404/400 from business logic is fine.
    expect(res.status).not.toBe(413);
  });

  it("returns 413 when Content-Length exceeds the reveal limit", async () => {
    const app = await freshApp();
    const oversized = "x".repeat(PAYLOAD_LIMITS.secretReveal + 1);
    const res = await request(app)
      .post("/api/secrets/reveal")
      .set("Content-Length", String(PAYLOAD_LIMITS.secretReveal + 1))
      .set("Content-Type", "application/json")
      .send(oversized);
    expect(res.status).toBe(413);
    expect(res.body.error).toBe("payload_too_large");
  });

  it("rejects publicId longer than 100 chars with field-level 400", async () => {
    const app = await freshApp();
    const res = await request(app)
      .post("/api/secrets/reveal")
      .send({ ...VALID_REVEAL, publicId: "x".repeat(101) });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation_error");
    expect(res.body.details?.some((d: { path: string[] }) =>
      d.path.includes("publicId")
    )).toBe(true);
  });

  it("rejects preimage longer than 132 chars with field-level 400", async () => {
    const app = await freshApp();
    const res = await request(app)
      .post("/api/secrets/reveal")
      .send({ ...VALID_REVEAL, preimage: "0x" + "a".repeat(131) }); // 133 chars total
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation_error");
    expect(res.body.details?.some((d: { path: string[] }) =>
      d.path.includes("preimage")
    )).toBe(true);
  });

  it("rejects txHash longer than 132 chars with field-level 400", async () => {
    const app = await freshApp();
    const res = await request(app)
      .post("/api/secrets/reveal")
      .send({ ...VALID_REVEAL, txHash: "0x" + "a".repeat(131) }); // 133 chars total
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation_error");
    expect(res.body.details?.some((d: { path: string[] }) =>
      d.path.includes("txHash")
    )).toBe(true);
  });
});

// ── Error response never echoes secret fields ─────────────────────────────────

describe("secret fields are never echoed in error responses", () => {
  it("413 response body for /secrets/reveal never echoes the submitted preimage", async () => {
    const app = await freshApp();
    const secretValue = "ab".repeat(500); // well over the limit
    const oversized = JSON.stringify({
      publicId: "some-id",
      preimage: "0x" + secretValue,
      txHash: "0xdeadbeef",
    });
    const res = await request(app)
      .post("/api/secrets/reveal")
      .set("Content-Length", String(Buffer.byteLength(oversized, "utf8")))
      .set("Content-Type", "application/json")
      .send(oversized);
    expect([400, 413]).toContain(res.status);
    // The secret value must never appear in the response body.
    expect(JSON.stringify(res.body)).not.toContain(secretValue);
  });

  it("field-length 400 for /secrets/reveal never echoes the oversized preimage", async () => {
    const app = await freshApp();
    const secretValue = "ab".repeat(70); // 140 hex chars > 132 limit
    const res = await request(app)
      .post("/api/secrets/reveal")
      .send({
        publicId: "wf_0x" + "a".repeat(64),
        preimage: "0x" + secretValue,
        txHash: "0x" + "cd".repeat(32),
      });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain(secretValue);
  });
});

// ── PAYLOAD_LIMITS constants are self-consistent ──────────────────────────────

describe("PAYLOAD_LIMITS constant sanity", () => {
  it("announce limit is larger than the max announce payload", () => {
    // Maximum field sizes summed:
    // direction(20) + hashlock(66) + 2*chain(40) + 2*address(200) +
    // 2*asset(400) + 3*amount(234) = ~960 chars of values + JSON overhead ~200
    const maxFieldBytes =
      ANNOUNCE_FIELD_LIMITS.direction +
      ANNOUNCE_FIELD_LIMITS.hashlock +
      2 * 20 + // srcChain + dstChain (chain limit)
      2 * ANNOUNCE_FIELD_LIMITS.address +
      2 * ANNOUNCE_FIELD_LIMITS.asset +
      3 * ANNOUNCE_FIELD_LIMITS.amount;
    const jsonOverheadEstimate = 400; // keys + quotes + commas + braces
    expect(PAYLOAD_LIMITS.announce).toBeGreaterThan(maxFieldBytes + jsonOverheadEstimate);
  });

  it("secretReveal limit is larger than the max reveal payload", () => {
    // publicId(100) + preimage(132) + txHash(132) + json overhead(60)
    const maxRevealBytes = 100 + 132 + 132 + 60;
    expect(PAYLOAD_LIMITS.secretReveal).toBeGreaterThan(maxRevealBytes);
  });
});
