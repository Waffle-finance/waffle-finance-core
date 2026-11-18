import { describe, it, expect, vi, afterEach } from "vitest";
import request from "supertest";
import pino from "pino";
import { createApp, type AppDeps } from "../src/server/app.js";
import { OrderExportService } from "../src/services/order-export.js";
import type { OrdersRepository, OrderRow } from "../src/persistence/orders-repo.js";
import type { AuditRepository } from "../src/audit/audit-repo.js";

const secret = "0x" + "de".repeat(32);
const log = pino({ level: "silent" });
const originalKeys = process.env.COORDINATOR_OPERATOR_KEYS;
afterEach(() => {
  if (originalKeys === undefined) delete process.env.COORDINATOR_OPERATOR_KEYS;
  else process.env.COORDINATOR_OPERATOR_KEYS = originalKeys;
});

function fixture() {
  process.env.COORDINATOR_OPERATOR_KEYS = "export-test-key";
  const order = {
    publicId: "export-fixture", direction: "eth_to_xlm", status: "completed",
    hashlock: "0x" + "ab".repeat(32), preimage: secret,
    srcChain: "ethereum", srcAddress: "sender", srcAsset: "native", srcAmount: "10", srcSafetyDeposit: "1",
    dstChain: "stellar", dstAddress: "receiver", dstAsset: "native", dstAmount: "20",
    createdAt: 1700000000, updatedAt: 1700000001, archivedAt: null,
  } as OrderRow;
  const lookup = vi.fn().mockResolvedValue(order);
  const repo = { findByPublicId: lookup } as unknown as OrdersRepository;
  const audit = { forOrder: vi.fn().mockResolvedValue([{
    eventType: "secret.revealed", createdAt: 1700000001,
    payloadJson: JSON.stringify({ preimage: secret, nested: [{ secretPreimage: secret }], status: "completed" }),
  }, {
    eventType: "secret.revealed", createdAt: 1700000002,
    payloadJson: `malformed audit payload containing ${secret}`,
  }]) } as unknown as AuditRepository;
  const exporter = new OrderExportService(repo, audit, log);
  const app = createApp({ log, corsOrigin: "*", orders: {}, secrets: {}, quotes: {}, orderExport: exporter } as AppDeps);
  return { app, lookup };
}

describe("Export operator authorization and secret omission", () => {
  for (const endpoint of ["single", "bulk", "json", "csv"] as const) {
    it.each([
      ["absent", undefined, 401],
      ["valid", "Bearer export-test-key", 200],
      ["invalid", "Bearer invalid-export-key", 403],
      ["malformed", "Basic export-test-key", 401],
    ])(`${endpoint}: %s credentials`, async (_name, authorization, status) => {
      const { app, lookup } = fixture();
      const pending = endpoint === "single"
        ? request(app).get("/api/export/orders/export-fixture")
        : endpoint === "bulk"
          ? request(app).post("/api/export/orders").send({ orderIds: ["export-fixture"] })
          : request(app).get("/api/orders/export").query({ orderIds: "export-fixture", format: endpoint });
      if (authorization) pending.set("Authorization", authorization);
      const response = await pending.expect(status);
      expect(response.text).not.toContain(secret);
      expect(response.text).not.toContain("export-test-key");
      if (status === 200) {
        expect(lookup).toHaveBeenCalledWith("export-fixture");
        expect(response.text).toContain("export-fixture");
        if (endpoint === "single") expect(response.body.secret).toMatchObject({ revealed: true, preimage: null });
      } else {
        expect(lookup).not.toHaveBeenCalled();
        expect(response.body.error).toBe(status === 401 ? "unauthorized" : "forbidden");
      }
    });
  }

  it("does not expose a preimage in service error bodies", async () => {
    const { app, lookup } = fixture();
    lookup.mockRejectedValue(new Error(`database failure containing ${secret}`));
    const response = await request(app).get("/api/export/orders/export-fixture")
      .set("Authorization", "Bearer export-test-key").expect(500);
    expect(response.body).toEqual({ error: "internal_error", message: "Order export failed" });
    expect(response.text).not.toContain(secret);
  });
});
