/**
 * Rate-limit middleware — API-key bypass boundary tests.
 *
 * Security property being tested
 * --------------------------------
 * The `makeRateLimiter` middleware has an API-key bypass that lets callers
 * with a valid bearer token skip rate limiting (for high-volume resolver
 * integrations).  Only a correctly-formatted `Authorization: Bearer <token>`
 * header carrying a token that exists in the configured `apiKeys` set should
 * trigger the bypass.
 *
 * This file tests:
 *   1. Malformed bearer credentials do NOT receive the bypass and remain
 *      subject to ordinary rate limiting (or 401/403 from auth middleware).
 *   2. Missing Authorization header is never misinterpreted as a valid bypass.
 *   3. A "Bearer " prefix with an empty token is not treated as a bypass.
 *   4. A valid, known token DOES receive the bypass (regression guard).
 *   5. Ordinary rate limiting blocks after the configured max is exceeded,
 *      even when the Authorization header is present but invalid.
 *
 * Test strategy
 * -------------
 * We mount the middleware directly on a minimal Express app so these tests
 * stay fast, isolated, and free from the full coordinator boot sequence.
 * The `apiKeys` set is configured inline per test.  Prometheus counters are
 * not mocked — they are singletons in the metrics module and accept extra
 * `inc()` / `observe()` calls without side-effects visible here.
 */

import { describe, it, expect } from "vitest";
import express, { type Request, type Response } from "express";
import supertest from "supertest";
import pino from "pino";
import {
  makeRateLimiter,
  extractBearerToken,
  resolveClientIp,
} from "../src/server/middleware/ratelimit.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const VALID_API_KEY = "valid-api-key-abc123";
const log = pino({ level: "silent" });

/**
 * Build a minimal Express app with the rate-limiter protecting a single GET
 * endpoint.  The endpoint always responds 200 so the test can distinguish
 * "allowed by rate limiter" from "blocked by rate limiter (429)".
 */
function makeApp(opts: {
  max?: number;
  windowMs?: number;
  apiKeys?: string[];
}) {
  const app = express();

  const limiter = makeRateLimiter({
    windowMs: opts.windowMs ?? 60_000,
    max: opts.max ?? 5,
    name: "test/endpoint",
    log,
    apiKeys: opts.apiKeys ? new Set(opts.apiKeys) : new Set(),
  });

  app.get("/test", limiter, (_req: Request, res: Response) => {
    res.status(200).json({ ok: true });
  });

  return app;
}

// ── extractBearerToken unit tests ─────────────────────────────────────────────

describe("extractBearerToken — header parsing", () => {
  function fakeReq(authorization?: string): Request {
    return {
      headers: authorization ? { authorization } : {},
    } as unknown as Request;
  }

  it("returns the token when the header is well-formed", () => {
    const token = extractBearerToken(fakeReq("Bearer my-secret-token"));
    expect(token).toBe("my-secret-token");
  });

  it("returns null when the Authorization header is absent", () => {
    expect(extractBearerToken(fakeReq())).toBeNull();
  });

  it("returns null for 'Basic' auth scheme", () => {
    expect(extractBearerToken(fakeReq("Basic dXNlcjpwYXNz"))).toBeNull();
  });

  it("returns null when 'Bearer ' prefix is missing (raw token only)", () => {
    expect(extractBearerToken(fakeReq("my-secret-token"))).toBeNull();
  });

  it("returns null for 'Bearer' without the trailing space", () => {
    // 'Bearer' alone (no space) does not start with 'Bearer ' — returns null
    expect(extractBearerToken(fakeReq("Bearer"))).toBeNull();
  });

  it("returns null for 'Bearer ' with an empty token (whitespace only)", () => {
    expect(extractBearerToken(fakeReq("Bearer    "))).toBeNull();
  });

  it("returns null for an empty Authorization header value", () => {
    expect(extractBearerToken(fakeReq(""))).toBeNull();
  });

  it("returns null for a partial 'Bear' prefix", () => {
    // Partial prefix should not be treated as Bearer
    expect(extractBearerToken(fakeReq("Bear er token"))).toBeNull();
  });

  it("is case-sensitive: 'bearer ' (lower-case) is not accepted", () => {
    // The current implementation checks for the exact string "Bearer "
    expect(extractBearerToken(fakeReq("bearer my-token"))).toBeNull();
  });
});

// ── Integration: bypass requires a valid, known token ─────────────────────────

describe("makeRateLimiter — API-key bypass requires correct credentials", () => {
  it("a valid token in the apiKeys set bypasses rate limiting", async () => {
    // Set max=1 so any non-bypassed second request would get 429.
    const app = makeApp({ max: 1, apiKeys: [VALID_API_KEY] });

    // Send 3 requests with the valid token — all should be allowed.
    for (let i = 0; i < 3; i++) {
      const res = await supertest(app)
        .get("/test")
        .set("Authorization", `Bearer ${VALID_API_KEY}`);
      expect(res.status).toBe(200);
    }
  });

  it("no Authorization header is never treated as a bypass", async () => {
    const app = makeApp({ max: 1, apiKeys: [VALID_API_KEY] });

    // First request is allowed (within limit).
    await supertest(app).get("/test").expect(200);

    // Second request without auth is rate-limited.
    const res = await supertest(app).get("/test");
    expect(res.status).toBe(429);
  });

  it("a wrong token is not treated as a bypass — rate limiting applies", async () => {
    const app = makeApp({ max: 1, apiKeys: [VALID_API_KEY] });

    // Exhaust the limit with valid bypass requests first, then try wrong token.
    // Actually: set max=1, send 1 anonymous request to hit the limit,
    // then confirm the wrong-token request is also rate-limited.
    await supertest(app).get("/test").expect(200); // uses up the 1 allowed slot
    const res = await supertest(app)
      .get("/test")
      .set("Authorization", "Bearer wrong-token");
    expect(res.status).toBe(429);
  });

  it("'Bearer ' with an empty token after trim is not treated as a bypass", async () => {
    const app = makeApp({ max: 1, apiKeys: [VALID_API_KEY] });

    await supertest(app).get("/test").expect(200);
    const res = await supertest(app)
      .get("/test")
      .set("Authorization", "Bearer    ");
    expect(res.status).toBe(429);
  });

  it("a Basic auth header is not treated as a bearer bypass", async () => {
    const app = makeApp({ max: 1, apiKeys: [VALID_API_KEY] });

    await supertest(app).get("/test").expect(200);
    const res = await supertest(app)
      .get("/test")
      .set("Authorization", "Basic dXNlcjpwYXNz");
    expect(res.status).toBe(429);
  });

  it("a raw token without 'Bearer ' prefix is not treated as a bypass", async () => {
    const app = makeApp({ max: 1, apiKeys: [VALID_API_KEY] });

    await supertest(app).get("/test").expect(200);
    const res = await supertest(app)
      .get("/test")
      .set("Authorization", VALID_API_KEY); // token without the "Bearer " prefix
    expect(res.status).toBe(429);
  });

  it("'Bearer' without trailing space does not match and is not a bypass", async () => {
    const app = makeApp({ max: 1, apiKeys: [VALID_API_KEY] });

    await supertest(app).get("/test").expect(200);
    const res = await supertest(app)
      .get("/test")
      .set("Authorization", `Bearer${VALID_API_KEY}`); // no space after 'Bearer'
    expect(res.status).toBe(429);
  });

  it("empty apiKeys set means no bypass is ever granted", async () => {
    // Even with a "valid" bearer token, no bypass if the set is empty.
    const app = makeApp({ max: 1, apiKeys: [] });

    await supertest(app).get("/test").expect(200);
    const res = await supertest(app)
      .get("/test")
      .set("Authorization", `Bearer ${VALID_API_KEY}`);
    expect(res.status).toBe(429);
  });

  it("rate limiting still blocks unauthenticated requests after limit is exceeded", async () => {
    // Confirm the core rate-limiting behaviour is intact.
    const app = makeApp({ max: 2, apiKeys: [VALID_API_KEY] });

    await supertest(app).get("/test").expect(200);
    await supertest(app).get("/test").expect(200);

    // Third request without auth exceeds the limit.
    const blocked = await supertest(app).get("/test");
    expect(blocked.status).toBe(429);
    expect(blocked.body).toMatchObject({
      error: "too_many_requests",
    });
  });

  it("rate-limit response body does not echo the Authorization header value", async () => {
    const app = makeApp({ max: 1, apiKeys: [VALID_API_KEY] });

    await supertest(app).get("/test").expect(200);

    // Trigger a block with a malformed auth header that looks like an attempt
    // to smuggle content into the response.
    const res = await supertest(app)
      .get("/test")
      .set("Authorization", 'Bearer malformed"value"with<special>chars');

    expect(res.status).toBe(429);
    // The response body must not echo back the Authorization header content.
    const body = JSON.stringify(res.body);
    expect(body).not.toContain("malformed");
    expect(body).not.toContain("special");
  });
});
