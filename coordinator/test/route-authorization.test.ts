/**
 * Least-privilege authorization matrix for mounted coordinator routes (#1131).
 */
import { describe, it, expect, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import pino from "pino";
import { createApp, type AppDeps } from "../src/server/app.js";
import {
  ROUTE_AUTHORIZATION_MATRIX,
  assertRouteAuthorizationCoverage,
  mountedRoutes,
  policyForRoute
} from "../src/server/authorization-policy.js";

const OPERATOR_KEY = "route-matrix-operator-key";
const originalKeys = process.env.COORDINATOR_OPERATOR_KEYS;
afterEach(() => {
  if (originalKeys === undefined) delete process.env.COORDINATOR_OPERATOR_KEYS;
  else process.env.COORDINATOR_OPERATOR_KEYS = originalKeys;
});

function fixture() {
  process.env.COORDINATOR_OPERATOR_KEYS = OPERATOR_KEY;
  const deps = {
    log: pino({ level: "silent" }),
    corsOrigin: "*",
    orders: { get: async () => null },
    secrets: { get: async () => null, reveal: async () => ({ ok: true }) },
    quotes: {},
    auditRepo: {},
    orderExport: {},
    runReconcile: async () => ({ ok: true }),
    runStaleCleanup: async () => ({ ok: true }),
    runExpiry: async () => 0,
    getReconciliationCursors: () => ({}),
    sseBroker: {}
  } as unknown as AppDeps;
  return createApp(deps);
}

/** Operator-only endpoints: anonymous 401, user 403, operator allowed. */
const OPERATOR_ROUTES = [
  "GET /metrics",
  "GET /api/audit/export",
  "GET /api/export/orders/id-1",
  "POST /api/export/orders",
  "GET /api/orders/export?orderIds=id-1",
  "POST /api/orders/id-1/src-locked",
  "POST /api/orders/id-1/dst-locked",
  "POST /admin/reconcile",
  "POST /admin/stale-cleanup",
  "POST /admin/expire-now",
  "GET /admin/reconciliation-cursors"
] as const;

describe("coordinator route authorization matrix", () => {
  for (const route of OPERATOR_ROUTES) {
    const [method, path] = route.split(" ") as [string, string];
    const send = (app: express.Express) => {
      const req = method === "GET" ? request(app).get(path) : request(app).post(path);
      return method === "POST" ? req.send({}) : req;
    };

    it(`${route} denies anonymous and user credentials`, async () => {
      const app = fixture();
      expect((await send(app)).status).toBe(401);
      const asUser = method === "GET"
        ? request(app).get(path)
        : request(app).post(path).send({});
      expect((await asUser.set("Authorization", "Bearer regular-user-key")).status).toBe(403);
    });

    it(`${route} accepts an operator key`, async () => {
      let status = 0;
      try {
        const response = await send(fixture())
          .set("Authorization", `Bearer ${OPERATOR_KEY}`);
        status = response.status;
      } catch (err) {
        // Streaming NDJSON endpoints can trip supertest's response parser;
        // reaching the handler (rather than a 401/403) is what we assert here.
        if (!/Parse Error/.test((err as Error).message)) throw err;
      }
      expect([401, 403]).not.toContain(status);
    });
  }

  it("classifies each mounted route in the matrix", () => {
    const app = fixture();
    const mounted = mountedRoutes(app);
    expect(mounted.length).toBeGreaterThan(0);
    for (const route of mounted) {
      const [method, path] = route.split(" ") as [string, string];
      expect(policyForRoute(method, path), `missing policy for ${route}`).toBeDefined();
    }
    expect(ROUTE_AUTHORIZATION_MATRIX.some((e) => e.principal === "operator")).toBe(true);
  });

  it("fails registration when a new route has no policy entry", () => {
    const app = express();
    app.get("/api/new-sensitive-route", (_req, res) => res.json({ ok: true }));
    expect(() => assertRouteAuthorizationCoverage(app)).toThrow(/missing entries/);
  });
});
