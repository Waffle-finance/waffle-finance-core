import { describe, it, expect, vi, afterEach } from "vitest";
import request from "supertest";
import express from "express";
import { exportRoutes } from "../src/server/routes/export.js";
import type { OrderExportService } from "../src/services/order-export.js";

const originalKeys = process.env.COORDINATOR_OPERATOR_KEYS;
afterEach(() => {
  if (originalKeys === undefined) delete process.env.COORDINATOR_OPERATOR_KEYS;
  else process.env.COORDINATOR_OPERATOR_KEYS = originalKeys;
});

function makeApp() {
  process.env.COORDINATOR_OPERATOR_KEYS = "schema-test-key";
  const exportOrders = vi.fn().mockResolvedValue({ orders: [], totalCount: 0, metadata: {} });
  const app = express();
  app.use(express.json());
  app.use("/api", exportRoutes({ exportOrders } as unknown as OrderExportService));
  return { app, exportOrders };
}

describe("POST /api/export/orders schema validation", () => {
  it.each([{ orderIds: [""] }, { orderIds: ["   "] }, { orderIds: ["valid-id", ""] }, { orderIds: [] }])("rejects invalid order IDs $orderIds before service access", async ({ orderIds }) => {
    const { app, exportOrders } = makeApp();
    const response = await request(app).post("/api/export/orders")
      .set("Authorization", "Bearer schema-test-key").send({ orderIds }).expect(400);
    expect(response.body.error).toBe("validation_error");
    expect(exportOrders).not.toHaveBeenCalled();
  });

  it("accepts valid IDs and passes them to the export service", async () => {
    const { app, exportOrders } = makeApp();
    await request(app).post("/api/export/orders")
      .set("Authorization", "Bearer schema-test-key").send({ orderIds: ["first", "second"] }).expect(200);
    expect(exportOrders).toHaveBeenCalledTimes(1);
    expect(exportOrders).toHaveBeenCalledWith({ orderIds: ["first", "second"] });
  });

  it("allows omitted IDs for a filtered bulk export", async () => {
    const { app, exportOrders } = makeApp();
    await request(app).post("/api/export/orders")
      .set("Authorization", "Bearer schema-test-key").send({ status: "completed" }).expect(200);
    expect(exportOrders).toHaveBeenCalledWith({ status: "completed" });
  });
});
