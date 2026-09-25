/**
 * @file test/export-route.test.ts
 *
 * Tests for POST /api/orders/export.
 *
 * Coverage:
 *   1. Schema validation — empty string entries fail with 400
 *   2. Schema validation — valid IDs pass and reach the service layer
 *   3. Schema validation — whitespace-only entries are treated as empty and fail
 *   4. No exporter/repository call occurs when validation fails
 */

import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import express from "express";
import pino from "pino";
import { exportRoutes } from "../src/server/routes/export.js";
import type { OrderService } from "../src/services/order-service.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const log = pino({ level: "silent" });

const VALID_ID_A = "wf_0x" + "a".repeat(64);
const VALID_ID_B = "wf_0x" + "b".repeat(64);

/**
 * Build a minimal Express app that mounts the export routes backed by a mock
 * OrderService.  Returns both the app and the mock's `get` spy so tests can
 * assert whether the service was ever called.
 */
function makeApp() {
  const getSpy = vi.fn().mockResolvedValue(null);
  const mockOrders = { get: getSpy } as unknown as OrderService;

  const app = express();
  app.use(express.json());
  app.use("/api", exportRoutes(mockOrders, log));

  return { app, getSpy };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("POST /api/orders/export — schema validation", () => {
  it("returns 400 when orderIds contains an empty string", async () => {
    const { app, getSpy } = makeApp();

    const res = await request(app)
      .post("/api/orders/export")
      .send({ orderIds: [""] });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation_error");
    expect(typeof res.body.message).toBe("string");
    expect(Array.isArray(res.body.details)).toBe(true);

    // The service must never be called for invalid input.
    expect(getSpy).not.toHaveBeenCalled();
  });

  it("returns 400 when orderIds contains a whitespace-only string", async () => {
    const { app, getSpy } = makeApp();

    const res = await request(app)
      .post("/api/orders/export")
      .send({ orderIds: ["   "] });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation_error");
    expect(Array.isArray(res.body.details)).toBe(true);

    // No DB work for invalid input.
    expect(getSpy).not.toHaveBeenCalled();
  });

  it("returns 400 when orderIds contains a mix of valid and empty strings", async () => {
    const { app, getSpy } = makeApp();

    const res = await request(app)
      .post("/api/orders/export")
      .send({ orderIds: [VALID_ID_A, ""] });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation_error");

    // No DB work even if some entries are valid.
    expect(getSpy).not.toHaveBeenCalled();
  });

  it("returns 200 when all orderIds entries are valid non-empty strings", async () => {
    const { app, getSpy } = makeApp();

    const res = await request(app)
      .post("/api/orders/export")
      .send({ orderIds: [VALID_ID_A, VALID_ID_B] });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("orders");

    // Service must be called once per ID.
    expect(getSpy).toHaveBeenCalledTimes(2);
    expect(getSpy).toHaveBeenCalledWith(VALID_ID_A);
    expect(getSpy).toHaveBeenCalledWith(VALID_ID_B);
  });

  it("returns 400 when orderIds is an empty array", async () => {
    const { app, getSpy } = makeApp();

    const res = await request(app)
      .post("/api/orders/export")
      .send({ orderIds: [] });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation_error");
    expect(getSpy).not.toHaveBeenCalled();
  });

  it("returns 400 when orderIds is missing entirely", async () => {
    const { app, getSpy } = makeApp();

    const res = await request(app)
      .post("/api/orders/export")
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation_error");
    expect(getSpy).not.toHaveBeenCalled();
  });
});
