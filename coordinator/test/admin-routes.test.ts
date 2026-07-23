/**
 * Tests for the admin maintenance endpoints:
 *   POST /admin/reconcile
 *   POST /admin/stale-cleanup
 *
 * All endpoints require an operator Bearer token.  The test suite validates
 * both the happy path (authenticated + successful service call) and the
 * various failure modes (missing auth, wrong token, service throws).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import pino from "pino";
import { createApp } from "../src/server/app.js";
import type { AppDeps } from "../src/server/app.js";
import type { OrderService } from "../src/services/order-service.js";
import type { SecretService } from "../src/services/secret-service.js";
import type { QuoteService } from "../src/services/quote-service.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const OPERATOR_KEY = "test-operator-key-abc123";
const WRONG_KEY = "wrong-key-xyz";
const AUTH_HEADER = `Bearer ${OPERATOR_KEY}`;

// ── Fixtures ──────────────────────────────────────────────────────────────────

const nullLog = pino({ level: "silent" });

/**
 * Stub implementations of service dependencies that aren't under test here.
 * We only care that the admin endpoints reach the `runReconcile` and
 * `runStaleCleanup` callbacks — not that the actual reconciler or cleanup
 * service works (those have their own test files).
 */
function makeStubDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    log: nullLog,
    corsOrigin: "*",
    orders: {} as OrderService,
    secrets: {} as SecretService,
    quotes: {} as QuoteService,
    getReconciliationStatus: () => ({
      lastRunAt: null,
      lastRunOk: null,
      eventsReplayed: 0
    }),
    runReconcile: vi.fn(async () => ({
      lastRunAt: 1_700_000_000_000,
      lastRunOk: true,
      eventsReplayed: 3
    })),
    runStaleCleanup: vi.fn(async () => ({ archivedCount: 7 })),
    ...overrides
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Create an Express app with a fixed operator key injected via environment
 * variable so `loadOperatorKeys()` inside `requireRole` picks it up.
 */
function makeApp(overrides: Partial<AppDeps> = {}) {
  process.env.COORDINATOR_OPERATOR_KEYS = OPERATOR_KEY;
  return createApp(makeStubDeps(overrides));
}

// ── Test suites ───────────────────────────────────────────────────────────────

describe("POST /admin/reconcile", () => {
  beforeEach(() => {
    delete process.env.COORDINATOR_OPERATOR_KEYS;
  });

  it("returns 401 when Authorization header is missing", async () => {
    const app = makeApp();
    const res = await request(app).post("/admin/reconcile");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
  });

  it("returns 401 when Authorization header is malformed (no Bearer prefix)", async () => {
    const app = makeApp();
    const res = await request(app)
      .post("/admin/reconcile")
      .set("Authorization", OPERATOR_KEY); // not "Bearer <key>"
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
  });

  it("returns 403 when Authorization header has the wrong token", async () => {
    const app = makeApp();
    const res = await request(app)
      .post("/admin/reconcile")
      .set("Authorization", `Bearer ${WRONG_KEY}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden");
  });

  it("returns 404 when admin routes are not mounted (no callbacks provided)", async () => {
    // When runReconcile / runStaleCleanup are absent, the admin router is
    // never mounted, so the endpoint simply 404s instead of 401/403.
    process.env.COORDINATOR_OPERATOR_KEYS = OPERATOR_KEY;
    const app = createApp({
      ...makeStubDeps(),
      runReconcile: undefined,
      runStaleCleanup: undefined
    });
    const res = await request(app)
      .post("/admin/reconcile")
      .set("Authorization", AUTH_HEADER);
    expect(res.status).toBe(404);
  });

  it("calls runReconcile and returns the status on success", async () => {
    const runReconcile = vi.fn(async () => ({
      lastRunAt: 1_700_000_000_000,
      lastRunOk: true,
      eventsReplayed: 5
    }));
    const app = makeApp({ runReconcile });

    const res = await request(app)
      .post("/admin/reconcile")
      .set("Authorization", AUTH_HEADER);

    expect(res.status).toBe(200);
    expect(runReconcile).toHaveBeenCalledOnce();
    expect(res.body).toEqual({
      ok: true,
      lastRunOk: true,
      lastRunAt: 1_700_000_000_000,
      eventsReplayed: 5
    });
  });

  it("returns 500 when runReconcile throws", async () => {
    const runReconcile = vi.fn(async () => {
      throw new Error("RPC unreachable");
    });
    const app = makeApp({ runReconcile });

    const res = await request(app)
      .post("/admin/reconcile")
      .set("Authorization", AUTH_HEADER);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("internal_error");
  });

  it("returns 200 with eventsReplayed=0 when no events were replayed", async () => {
    const runReconcile = vi.fn(async () => ({
      lastRunAt: Date.now(),
      lastRunOk: true,
      eventsReplayed: 0
    }));
    const app = makeApp({ runReconcile });

    const res = await request(app)
      .post("/admin/reconcile")
      .set("Authorization", AUTH_HEADER);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.eventsReplayed).toBe(0);
  });
});

describe("POST /admin/stale-cleanup", () => {
  beforeEach(() => {
    delete process.env.COORDINATOR_OPERATOR_KEYS;
  });

  it("returns 401 when Authorization header is missing", async () => {
    const app = makeApp();
    const res = await request(app).post("/admin/stale-cleanup");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
  });

  it("returns 403 when Authorization header has the wrong token", async () => {
    const app = makeApp();
    const res = await request(app)
      .post("/admin/stale-cleanup")
      .set("Authorization", `Bearer ${WRONG_KEY}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden");
  });

  it("returns 404 when admin routes are not mounted (no callbacks provided)", async () => {
    process.env.COORDINATOR_OPERATOR_KEYS = OPERATOR_KEY;
    const app = createApp({
      ...makeStubDeps(),
      runReconcile: undefined,
      runStaleCleanup: undefined
    });
    const res = await request(app)
      .post("/admin/stale-cleanup")
      .set("Authorization", AUTH_HEADER);
    expect(res.status).toBe(404);
  });

  it("calls runStaleCleanup and returns the archived count on success", async () => {
    const runStaleCleanup = vi.fn(async () => ({ archivedCount: 12 }));
    const app = makeApp({ runStaleCleanup });

    const res = await request(app)
      .post("/admin/stale-cleanup")
      .set("Authorization", AUTH_HEADER);

    expect(res.status).toBe(200);
    expect(runStaleCleanup).toHaveBeenCalledOnce();
    expect(res.body).toEqual({ ok: true, archivedCount: 12 });
  });

  it("returns 200 with archivedCount=0 when there are no stale orders", async () => {
    const runStaleCleanup = vi.fn(async () => ({ archivedCount: 0 }));
    const app = makeApp({ runStaleCleanup });

    const res = await request(app)
      .post("/admin/stale-cleanup")
      .set("Authorization", AUTH_HEADER);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, archivedCount: 0 });
  });

  it("returns 500 when runStaleCleanup throws", async () => {
    const runStaleCleanup = vi.fn(async () => {
      throw new Error("database locked");
    });
    const app = makeApp({ runStaleCleanup });

    const res = await request(app)
      .post("/admin/stale-cleanup")
      .set("Authorization", AUTH_HEADER);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("internal_error");
  });
});

describe("Admin routes — GET is not allowed", () => {
  it("POST /admin/reconcile is not reachable via GET", async () => {
    const app = makeApp();
    const res = await request(app)
      .get("/admin/reconcile")
      .set("Authorization", AUTH_HEADER);
    // Express returns 404 for unregistered GET routes; the important thing is
    // the endpoint is not accessible via a safe HTTP method.
    expect(res.status).toBe(404);
  });

  it("POST /admin/stale-cleanup is not reachable via GET", async () => {
    const app = makeApp();
    const res = await request(app)
      .get("/admin/stale-cleanup")
      .set("Authorization", AUTH_HEADER);
    expect(res.status).toBe(404);
  });
});
