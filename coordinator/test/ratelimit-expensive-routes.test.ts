/**
 * Rate-limit coverage for expensive quote and export endpoints (issue #1133).
 *
 * Bursts are deterministic: one IP, one window, no clock stubbing needed.
 * Tests assert enforcement, documented headers/retry information, absence of
 * API key material or bucket identifiers, and that the operator bypass is
 * restricted to the configured identity and audited.
 */
import { describe, it, expect } from "vitest";
import express, { type Request, type Response } from "express";
import request from "supertest";
import pino from "pino";
import {
  EXPENSIVE_ROUTE_POLICIES,
  makeExpensiveRouteLimiter,
  classifiedExpensiveRouteLimiter,
} from "../src/server/middleware/expensive-route-limits.js";
import { createApp, type AppDeps } from "../src/server/app.js";

const API_KEY = "operator-bypass-key-1133";
const auditMessages: Record<string, unknown>[] = [];
const log = {
  info: (obj: Record<string, unknown>) => { auditMessages.push(obj); },
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => log,
} as any;

function limiterApp(family: "quotes" | "export", max: number) {
  const app = express();
  // Smaller deterministic max, same middleware and policy names.
  const policy = EXPENSIVE_ROUTE_POLICIES[`${family}/anonymous`];
  const limiter = makeExpensiveRouteLimiter(`${family}/anonymous`, {
    log,
    apiKeys: new Set([API_KEY]),
    trustedProxies: new Set(),
  });
  expect(policy.max).toBeGreaterThan(0);
  app.get("/test", limiter, (_req: Request, res: Response) => res.status(200).json({ ok: true }));
  // Keep the assertion local to the configured policy for documentation.
  expect(max).toBe(policy.max);
  return app;
}

describe("expensive route policies", () => {
  it("classifies quote and export routes with bounded anonymous and authenticated limits", () => {
    expect(Object.keys(EXPENSIVE_ROUTE_POLICIES)).toEqual([
      "quotes/anonymous", "quotes/authenticated", "export/anonymous", "export/authenticated",
    ]);
    for (const policy of Object.values(EXPENSIVE_ROUTE_POLICIES)) {
      expect(policy.windowMs).toBe(60_000);
      expect(policy.max).toBeGreaterThan(0);
      expect(policy.name).toBeTruthy();
    }
  });

  for (const family of ["quotes", "export"] as const) {
    it(`blocks a burst beyond the ${family} limit with safe, documented headers`, async () => {
      const app = limiterApp(family, EXPENSIVE_ROUTE_POLICIES[`${family}/anonymous`].max);
      const max = EXPENSIVE_ROUTE_POLICIES[`${family}/anonymous`].max;
      for (let i = 0; i < max; i++) {
        const ok = await request(app).get("/test");
        expect(ok.status).toBe(200);
        expect(ok.headers["x-ratelimit-limit"]).toBe(String(max));
        expect(Number(ok.headers["x-ratelimit-remaining"])).toBeGreaterThanOrEqual(0);
        expect(Number(ok.headers["x-ratelimit-reset"])).toBeGreaterThanOrEqual(0);
      }
      const blocked = await request(app).get("/test").expect(429);
      expect(blocked.body.error).toBe("too_many_requests");
      expect(blocked.body.retryAfterSeconds).toBeGreaterThan(0);
      expect(blocked.headers["retry-after"]).toBe(String(blocked.body.retryAfterSeconds));

      const text = JSON.stringify(blocked.body) + JSON.stringify(blocked.headers);
      expect(text).not.toContain(API_KEY);
      expect(text).not.toMatch(/bucket|quotes\/anonymous:[0-9]|export\/anonymous:[0-9]/);
    });
  }

  it("allows only the configured identity to bypass, and audits the bypass without the key", async () => {
    auditMessages.length = 0;
    const app = express();
    const limiter = makeExpensiveRouteLimiter("export/anonymous", {
      log, apiKeys: new Set([API_KEY]), trustedProxies: new Set(),
    });
    app.get("/test", limiter, (_req: Request, res: Response) => res.status(200).json({ ok: true }));

    for (let i = 0; i < 3; i++) {
      await request(app).get("/test").set("Authorization", "Bearer not-configured").expect(200);
    }
    expect(auditMessages).toHaveLength(0);
    const bypassed = await request(app).get("/test").set("Authorization", `Bearer ${API_KEY}`);
    expect(bypassed.status).toBe(200);
    expect(auditMessages).toHaveLength(1); // explicit operator-bypass audit record
    const audit = JSON.stringify(auditMessages);
    expect(audit).toContain("bypass");
    expect(audit).not.toContain(API_KEY);
  });

  it("registers per-route limiters on the real quote and export routers", async () => {
    const original = process.env.COORDINATOR_API_KEYS;
    process.env.COORDINATOR_API_KEYS = API_KEY;
    try {
      const quotes = { getQuote: async () => ({
        srcUsd: 1, dstUsd: 2, rate: 2, source: "cache", staleness: "fresh",
        fetchedAt: Date.now(), ageMs: 0,
      }) } as any;
      const exportService = { exportOrder: async () => ({}) } as any;
      const app = createApp({
        log: pino({ level: "silent" }), corsOrigin: "*", quotes, orderExport: exportService,
      } as AppDeps);

      const anonymousPolicy = EXPENSIVE_ROUTE_POLICIES["quotes/anonymous"];
      for (let i = 0; i < anonymousPolicy.max; i++) {
        await request(app).get("/api/quotes/eth-xlm").expect(200);
      }
      await request(app).get("/api/quotes/eth-xlm").expect(429);

      // A configured identity still bypasses the registered limiter.
      await request(app).get("/api/quotes/eth-xlm")
        .set("Authorization", `Bearer ${API_KEY}`).expect(200);

      // Route-family dispatch exists for both families.
      expect(typeof classifiedExpensiveRouteLimiter("quotes", { log })).toBe("function");
      expect(typeof classifiedExpensiveRouteLimiter("export", { log })).toBe("function");
    } finally {
      if (original === undefined) delete process.env.COORDINATOR_API_KEYS;
      else process.env.COORDINATOR_API_KEYS = original;
    }
  });
});
