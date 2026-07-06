/**
 * Integration tests for rate-limited coordinator routes.
 *
 * Uses supertest to drive a real Express app wired to an in-memory SQLite
 * database - no network or external services required.
 *
 * Covered scenarios:
 *  - POST /api/orders/announce: 201 on valid payload, 429 after limit exceeded
 *  - POST /api/secrets/reveal: 400 on bad payload, 429 after stricter limit
 *  - GET  /api/secrets/:id:    404 for unknown id, 429 after read limit
 *  - API-key bearer token bypasses rate limits entirely
 *  - X-Forwarded-For is ignored when no trusted proxies are configured
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import express from "express";
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
import { makeRateLimiter, resolveClientIp } from "../src/server/middleware/ratelimit.js";

// ?? Helpers ???????????????????????????????????????????????????????????????????

const log = pino({ level: "silent" });

const VALID_HASHLOCK = "0x" + "ab".repeat(32); // 64 hex chars
const VALID_ETH_ADDR = "0x1111111111111111111111111111111111111111";
const VALID_STELLAR_ADDR = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422";
type FreshAppOptions = Partial<
  Pick<AppDeps, "getReadinessChecks" | "getReconciliationStatus">
>;

async function freshApp(overrides: FreshAppOptions = {}) {
  const dir = mkdtempSync(resolve(tmpdir(), "waffle-routes-test-"));
  const db = await openDatabase(`file:${dir}/test.db`);
  const ordersRepo = new OrdersRepository(db);
  const orders = new OrderService(ordersRepo, log);
  const secrets = new SecretService(orders, log);
  const quotes = new QuoteService(log);
  return createApp({ log, corsOrigin: "*", orders, secrets, quotes, ...overrides });
}

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

// ?? Tests ?????????????????????????????????????????????????????????????????????

describe("health and readiness routes", () => {
  it("returns liveness without dependency probes", async () => {
    const app = await freshApp();
    const res = await request(app).get("/healthz");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.service).toBe("wafflefinance-coordinator");
  });

  it("returns readiness ok when all dependency checks pass", async () => {
    const app = await freshApp({
      getReadinessChecks: () => [
        { name: "database", ok: true, latencyMs: 1 },
        { name: "ethereum_rpc", ok: true, latencyMs: 2 }
      ]
    });

    const res = await request(app).get("/readyz");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.checks).toEqual([
      { name: "database", ok: true, latencyMs: 1 },
      { name: "ethereum_rpc", ok: true, latencyMs: 2 }
    ]);
  });

  it("returns degraded readiness when a dependency check fails", async () => {
    const app = await freshApp({
      getReadinessChecks: () => [
        { name: "database", ok: true },
        { name: "soroban_rpc", ok: false, detail: "unavailable" }
      ]
    });

    const res = await request(app).get("/readyz");

    expect(res.status).toBe(503);
    expect(res.body.status).toBe("degraded");
    expect(res.body.checks).toContainEqual({
      name: "soroban_rpc",
      ok: false,
      detail: "unavailable"
    });
  });

  it("sanitizes readiness provider errors", async () => {
    const app = await freshApp({
      getReadinessChecks: () => {
        throw new Error("postgres://user:pass@example.internal/db");
      }
    });

    const res = await request(app).get("/readyz");

    expect(res.status).toBe(503);
    expect(res.body.status).toBe("degraded");
    expect(res.body.checks).toEqual([
      {
        name: "readiness",
        ok: false,
        detail: "readiness_check_failed"
      }
    ]);
    expect(JSON.stringify(res.body)).not.toContain("postgres://");
  });
});

describe("POST /api/orders/announce", () => {
  it("returns 201 for a valid order", async () => {
    const app = await freshApp();
    const res = await request(app)
      .post("/api/orders/announce")
      .send(BASE_ANNOUNCE);
    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.status).toBe("announced");
  });

  it("returns 400 for a missing field", async () => {
    const app = await freshApp();
    const { hashlock: _omit, ...withoutHashlock } = BASE_ANNOUNCE;
    const res = await request(app)
      .post("/api/orders/announce")
      .send(withoutHashlock);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation_error");
    expect(typeof res.body.message).toBe("string");
    expect(res.body.message.length).toBeGreaterThan(0);
  });

  it("returns a structured 400 for a mismatched direction/chain combo", async () => {
    const app = await freshApp();
    const res = await request(app)
      .post("/api/orders/announce")
      .send({ ...BASE_ANNOUNCE, srcChain: "solana", srcAddress: "11111111111111111111111111111111" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation_error");
    expect(typeof res.body.message).toBe("string");
    expect(Array.isArray(res.body.details)).toBe(true);
    expect(res.body.details.some((d: { path: unknown[] }) => d.path.includes("srcChain"))).toBe(true);
  });

  it("returns 429 once the announce rate limit is exceeded", async () => {
    const app = await freshApp();

    // Each announce uses a unique hashlock to avoid dedup errors.
    const makeHashlock = (i: number) =>
      "0x" + i.toString(16).padStart(2, "0").repeat(32);

    // Send 20 requests - all should succeed (limit is 20/min).
    for (let i = 0; i < 20; i++) {
      const res = await request(app)
        .post("/api/orders/announce")
        .send({ ...BASE_ANNOUNCE, hashlock: makeHashlock(i) });
      expect(res.status).toBe(201);
    }

    // The 21st request must hit the limiter.
    const res = await request(app)
      .post("/api/orders/announce")
      .send({ ...BASE_ANNOUNCE, hashlock: makeHashlock(20) });
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("too_many_requests");
    expect(res.headers["retry-after"]).toBeDefined();
  });

  it("X-Forwarded-For is ignored when no trusted proxy is configured", async () => {
    const app = await freshApp();
    // Even with a forged XFF header the IP used for bucketing is the actual
    // socket peer, so the limit still applies.
    const makeHashlock = (i: number) =>
      "0x" + (i + 100).toString(16).padStart(2, "0").repeat(32);

    for (let i = 0; i < 20; i++) {
      await request(app)
        .post("/api/orders/announce")
        .set("x-forwarded-for", "1.2.3.4") // attempt IP spoofing
        .send({ ...BASE_ANNOUNCE, hashlock: makeHashlock(i) });
    }

    const res = await request(app)
      .post("/api/orders/announce")
      .set("x-forwarded-for", "1.2.3.4")
      .send({ ...BASE_ANNOUNCE, hashlock: makeHashlock(20) });
    expect(res.status).toBe(429);
  });
});

describe("POST /api/secrets/reveal", () => {
  it("returns 400 for a missing preimage", async () => {
    const app = await freshApp();
    const res = await request(app)
      .post("/api/secrets/reveal")
      .send({ publicId: "test", txHash: "0xabc" }); // no preimage
    expect(res.status).toBe(400);
  });

  it("returns a classified 404 for an unknown order (secret not accepted)", async () => {
    const app = await freshApp();
    const res = await request(app)
      .post("/api/secrets/reveal")
      .send({
        publicId: "doesnotexist",
        preimage: "0x" + "ab".repeat(32),
        txHash: "0xabc"
      });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("unknown_order");
    expect(typeof res.body.message).toBe("string");
    expect(res.body.retryable).toBe(false);
    // The reveal error must never echo the submitted preimage.
    expect(JSON.stringify(res.body)).not.toContain("ab".repeat(32));
  });

  it("returns 429 after the reveal rate limit (5/min) is exceeded", async () => {
    const app = await freshApp();
    const payload = {
      publicId: "anyid",
      preimage: "0x" + "cd".repeat(32),
      txHash: "0xabc"
    };

    // First 5 attempts return 404 (unknown order), not 429.
    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .post("/api/secrets/reveal")
        .send(payload);
      expect(res.status).toBe(404);
    }

    // The 6th attempt must be rate-limited.
    const res = await request(app)
      .post("/api/secrets/reveal")
      .send(payload);
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("too_many_requests");
  });
});

describe("GET /api/orders/:id", () => {
  it("returns 404 with a message for an unknown order id", async () => {
    const app = await freshApp();
    const res = await request(app).get("/api/orders/wf_0x" + "0".repeat(64));
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
    expect(typeof res.body.message).toBe("string");
    expect(res.body.message.length).toBeGreaterThan(0);
  });
});

describe("GET /api/secrets/:publicId", () => {
  it("returns 404 for an unknown publicId", async () => {
    const app = await freshApp();
    const res = await request(app).get("/api/secrets/doesnotexist");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_revealed");
    expect(typeof res.body.message).toBe("string");
    expect(res.body.message.length).toBeGreaterThan(0);
  });

  it("returns 429 after the read rate limit (30/min) is exceeded", async () => {
    const app = await freshApp();

    for (let i = 0; i < 30; i++) {
      const res = await request(app).get("/api/secrets/testid");
      expect(res.status).toBe(404);
    }

    const res = await request(app).get("/api/secrets/testid");
    expect(res.status).toBe(429);
  });
});

describe("API key bypass", () => {
  it("a valid API key bypasses the secrets/reveal rate limit", async () => {
    // Inject the API key via environment before building the app.
    const originalKeys = process.env.COORDINATOR_API_KEYS;
    process.env.COORDINATOR_API_KEYS = "test-key-abc123";

    try {
      const app = await freshApp();
      const payload = {
        publicId: "anyid",
        preimage: "0x" + "cd".repeat(32),
        txHash: "0xabc"
      };

      // Send 10 requests (well above the 5/min limit) - all should get 400, not 429.
      for (let i = 0; i < 10; i++) {
        const res = await request(app)
          .post("/api/secrets/reveal")
          .set("Authorization", "Bearer test-key-abc123")
          .send(payload);
        // 404 = unknown order, not rate-limited
        expect(res.status).toBe(404);
        expect(res.body.error).toBe("unknown_order");
      }
    } finally {
      if (originalKeys === undefined) {
        delete process.env.COORDINATOR_API_KEYS;
      } else {
        process.env.COORDINATOR_API_KEYS = originalKeys;
      }
    }
  });

  it("a valid API key bypasses the announce rate limit", async () => {
    const originalKeys = process.env.COORDINATOR_API_KEYS;
    process.env.COORDINATOR_API_KEYS = "announce-key-xyz";

    try {
      const app = await freshApp();
      const makeHashlock = (i: number) =>
        "0x" + (i + 200).toString(16).padStart(2, "0").repeat(32);

      // 25 requests - above the 20/min limit - all should succeed.
      for (let i = 0; i < 25; i++) {
        const res = await request(app)
          .post("/api/orders/announce")
          .set("Authorization", "Bearer announce-key-xyz")
          .send({ ...BASE_ANNOUNCE, hashlock: makeHashlock(i) });
        expect(res.status).toBe(201);
      }
    } finally {
      if (originalKeys === undefined) {
        delete process.env.COORDINATOR_API_KEYS;
      } else {
        process.env.COORDINATOR_API_KEYS = originalKeys;
      }
    }
  });

  it("an invalid API key does not bypass the secrets/reveal rate limit", async () => {
    const originalKeys = process.env.COORDINATOR_API_KEYS;
    process.env.COORDINATOR_API_KEYS = "valid-key-only";

    try {
      const app = await freshApp();
      const payload = {
        publicId: "anyid",
        preimage: "0x" + "cd".repeat(32),
        txHash: "0xabc"
      };

      for (let i = 0; i < 5; i++) {
        const res = await request(app)
          .post("/api/secrets/reveal")
          .set("Authorization", "Bearer wrong-key")
          .send(payload);
        expect(res.status).toBe(404);
        expect(res.body.error).toBe("unknown_order");
      }

      const res = await request(app)
        .post("/api/secrets/reveal")
        .set("Authorization", "Bearer wrong-key")
        .send(payload);
      expect(res.status).toBe(429);
      expect(res.body.error).toBe("too_many_requests");
    } finally {
      if (originalKeys === undefined) {
        delete process.env.COORDINATOR_API_KEYS;
      } else {
        process.env.COORDINATOR_API_KEYS = originalKeys;
      }
    }
  });
});

describe("Rate-limit client IP resolution", () => {
  it("uses the first X-Forwarded-For value only when the direct peer is trusted", () => {
    const req = {
      socket: { remoteAddress: "10.0.0.10" },
      headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.10" }
    };

    expect(resolveClientIp(req as any, new Set(["10.0.0.10"]))).toBe("203.0.113.7");
  });

  it("ignores X-Forwarded-For when the direct peer is not trusted", () => {
    const req = {
      socket: { remoteAddress: "10.0.0.11" },
      headers: { "x-forwarded-for": "203.0.113.7" }
    };

    expect(resolveClientIp(req as any, new Set(["10.0.0.10"]))).toBe("10.0.0.11");
  });
});

describe("GET /api/orders/history", () => {
  const VALID_SOLANA_ADDR = "11111111111111111111111111111111"; // 32-char base58

  it("returns 400 with validation details when the address is missing", async () => {
    const app = await freshApp();
    const res = await request(app).get("/api/orders/history");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation_error");
    expect(typeof res.body.message).toBe("string");
    expect(Array.isArray(res.body.details)).toBe(true);
  });

  it("rejects a malformed address with 400", async () => {
    const app = await freshApp();
    const res = await request(app).get("/api/orders/history").query({ address: "not-an-address" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation_error");
  });

  it("rejects the Ethereum zero address with 400", async () => {
    const app = await freshApp();
    const res = await request(app)
      .get("/api/orders/history")
      .query({ address: "0x" + "0".repeat(40) });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation_error");
  });

  it("accepts a valid Ethereum address and returns matching orders", async () => {
    const app = await freshApp();
    await request(app).post("/api/orders/announce").send(BASE_ANNOUNCE).expect(201);

    const res = await request(app).get("/api/orders/history").query({ address: VALID_ETH_ADDR });
    expect(res.status).toBe(200);
    expect(res.body.transactions).toHaveLength(1);
    expect(res.body.pagination).toMatchObject({ limit: 50, offset: 0, count: 1 });
  });

  it("accepts a valid Stellar address and returns matching orders", async () => {
    const app = await freshApp();
    await request(app).post("/api/orders/announce").send(BASE_ANNOUNCE).expect(201);

    const res = await request(app)
      .get("/api/orders/history")
      .query({ address: VALID_STELLAR_ADDR });
    expect(res.status).toBe(200);
    expect(res.body.transactions).toHaveLength(1);
  });

  it("accepts a valid Solana address (empty history is still 200)", async () => {
    const app = await freshApp();
    const res = await request(app)
      .get("/api/orders/history")
      .query({ address: VALID_SOLANA_ADDR });
    expect(res.status).toBe(200);
    expect(res.body.transactions).toEqual([]);
  });
});

describe("Rate-limit response headers", () => {
  it("sets X-RateLimit-* headers on every response", async () => {
    const app = await freshApp();
    const res = await request(app)
      .post("/api/orders/announce")
      .send(BASE_ANNOUNCE);
    expect(res.headers["x-ratelimit-limit"]).toBeDefined();
    expect(res.headers["x-ratelimit-remaining"]).toBeDefined();
    expect(res.headers["x-ratelimit-reset"]).toBeDefined();
  });

  it("opens a fresh rate-limit window after reset time elapses", async () => {
    const app = express();
    app.get(
      "/limited",
      makeRateLimiter({ windowMs: 50, max: 1, name: "test-reset-window", log }),
      (_req, res) => res.json({ ok: true })
    );

    await request(app).get("/limited").expect(200);
    await request(app).get("/limited").expect(429);

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 75));

    const res = await request(app).get("/limited").expect(200);
    expect(res.body).toEqual({ ok: true });
    expect(res.headers["x-ratelimit-reset"]).toBeDefined();
  });
});

import { SecretStorageError } from "../src/services/secret-errors.js";

describe("Global Error Handler", () => {
  it("sanitizes hex strings from generic Error in response and logs", async () => {
    const app = await freshApp();
    const logSpy = vi.spyOn(log, 'error');
    
    const mockService = vi.spyOn(OrderService.prototype, "history").mockImplementation(() => {
      const err: any = new Error("leak message: 0xabcdef1234567890abcdef");
      err.customSecret = "0x1234567890abcdef123456";
      throw err;
    });

    const res = await request(app).get("/api/orders/history").query({ address: VALID_ETH_ADDR });
    
    expect(res.status).toBe(500);
    expect(res.body.message).toBe("leak message: [REDACTED_SECRET]");
    
    expect(logSpy).toHaveBeenCalled();
    const loggedError = logSpy.mock.calls[0][0].err;
    expect(loggedError.message).toBe("leak message: [REDACTED_SECRET]");
    expect(loggedError.customSecret).toBe("[REDACTED_SECRET]");
    
    mockService.mockRestore();
    logSpy.mockRestore();
  });

  it("leaves SecretRevealError subclasses intact", async () => {
    const app = await freshApp();
    const logSpy = vi.spyOn(log, 'error');
    
    const mockService = vi.spyOn(OrderService.prototype, "history").mockImplementation(() => {
      throw new SecretStorageError("safe message: 0xabcdef1234567890abcdef");
    });

    const res = await request(app).get("/api/orders/history").query({ address: VALID_ETH_ADDR });
    
    expect(res.status).toBe(500);
    expect(res.body.message).toBe("safe message: 0xabcdef1234567890abcdef");
    
    expect(logSpy).toHaveBeenCalled();
    const loggedError = logSpy.mock.calls[0][0].err;
    expect(loggedError.message).toBe("safe message: 0xabcdef1234567890abcdef");
    
    mockService.mockRestore();
    logSpy.mockRestore();
  });
});
