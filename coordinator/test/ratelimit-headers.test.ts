import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import supertest from "supertest";
import pino from "pino";
import { makeRateLimiter } from "../src/server/middleware/ratelimit.js";
import { requestIdMiddleware } from "../src/server/middleware/request-id.js";

const trustedKey = "header-contract-trusted-key";

function makeApp() {
  const app = express();
  app.use(requestIdMiddleware);
  app.get("/test", makeRateLimiter({
    max: 2,
    windowMs: 2_500,
    name: "test/header-contract",
    apiKeys: new Set([trustedKey]),
    trustedProxies: new Set(),
    log: pino({ level: "silent" }),
  }), (_req, res) => res.json({ ok: true }));
  return app;
}

describe("rate-limit response header contract", () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it.each([undefined, "Bearer wrong-key", trustedKey, "Basic ignored"])(
    "keeps untrusted credentials %s and forwarded IPs within the budget",
    async (authorization) => {
      // Fake only the clock and limiter's housekeeping timer; HTTP stays live.
      vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const app = makeApp();
      async function request(id: string, ip: string) {
        const req = supertest(app).get("/test")
          .set("X-Request-ID", id).set("X-Forwarded-For", ip);
        if (authorization !== undefined) req.set("Authorization", authorization);
        return req;
      }
      const first = await request("allowed-request", "198.51.100.1");
      expect(first.status).toBe(200);
      expect(first.headers).toMatchObject({
        "x-ratelimit-limit": "2", "x-ratelimit-remaining": "1",
        "x-ratelimit-reset": "3", "x-request-id": "allowed-request",
      });
      expect(first.headers["retry-after"]).toBeUndefined();
      const second = await request("last-allowed", "198.51.100.2");
      expect(second.status).toBe(200);
      expect(second.headers["x-ratelimit-remaining"]).toBe("0");
      vi.setSystemTime(Date.now() + 1_001);
      const blocked = await request("blocked-request", "198.51.100.3");
      expect(blocked.status).toBe(429);
      expect(blocked.headers).toMatchObject({
        "x-ratelimit-limit": "2", "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": "2", "retry-after": "2",
        "x-request-id": "blocked-request",
      });
      expect(blocked.body.retryAfterSeconds).toBe(2);
      vi.setSystemTime(Date.now() + Number(blocked.headers["retry-after"]) * 1000);
      const recovered = await request("recovered-request", "198.51.100.4");
      expect(recovered.status).toBe(200);
      expect(recovered.headers["x-ratelimit-remaining"]).toBe("1");
    }
  );

  it("bypasses only for a configured bearer token without consuming the public budget", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const app = makeApp();
    for (let i = 0; i < 3; i++) {
      const res = await supertest(app).get("/test").set("Authorization", `Bearer ${trustedKey}`);
      expect(res.status).toBe(200);
      expect(res.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
      for (const header of ["x-ratelimit-limit", "x-ratelimit-remaining", "retry-after"]) {
        expect(res.headers[header]).toBeUndefined();
      }
    }
    const publicResponse = await supertest(app).get("/test");
    expect(publicResponse.headers["x-ratelimit-remaining"]).toBe("1");
  });
});
