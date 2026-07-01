import { describe, it, expect } from "vitest";
import request from "supertest";
import pino from "pino";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { openDatabase } from "../src/persistence/db.js";
import { OrdersRepository } from "../src/persistence/orders-repo.js";
import { OrderService } from "../src/services/order-service.js";
import { SecretService } from "../src/services/secret-service.js";
import { QuoteService } from "../src/services/quote-service.js";
import { createApp } from "../src/server/app.js";

const log = pino({ level: "silent" });

async function freshApp() {
  const dir = mkdtempSync(resolve(tmpdir(), "waffle-telemetry-test-"));
  const db = await openDatabase(`file:${dir}/test.db`);
  const ordersRepo = new OrdersRepository(db);
  const orders = new OrderService(ordersRepo, log);
  const secrets = new SecretService(orders, log);
  const quotes = new QuoteService(log);
  return createApp({ log, corsOrigin: "*", orders, secrets, quotes });
}

describe("POST /api/telemetry", () => {
  it("returns 202 Accepted for a valid telemetry payload", async () => {
    const app = await freshApp();
    const payload = {
      orderId: "wf_0x123",
      direction: "eth_to_xlm",
      step: "eth_approval_submit",
      walletType: "metamask",
      failureType: "wallet_rejection",
      errorCode: 4001,
      errorMessage: "User rejected transaction",
      state: { amount: "1.0" }
    };

    const res = await request(app)
      .post("/api/telemetry")
      .send(payload);

    expect(res.status).toBe(202);
    expect(res.body.ok).toBe(true);
  });

  it("returns 400 Bad Request for an invalid payload", async () => {
    const app = await freshApp();
    const payload = {
      direction: "eth_to_xlm",
      step: "eth_approval_submit",
      walletType: "not-a-wallet", // Invalid enum
      failureType: "wallet_rejection",
      errorMessage: "User rejected transaction"
    };

    const res = await request(app)
      .post("/api/telemetry")
      .send(payload);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation_error");
  });

  it("returns 429 when the rate limit is exceeded", async () => {
    const app = await freshApp();
    const payload = {
      direction: "eth_to_xlm",
      step: "eth_approval_submit",
      walletType: "metamask",
      failureType: "wallet_rejection",
      errorMessage: "User rejected transaction"
    };

    // Send 30 requests - all should succeed.
    for (let i = 0; i < 30; i++) {
      const res = await request(app)
        .post("/api/telemetry")
        .send(payload);
      expect(res.status).toBe(202);
    }

    // The 31st request should be rate-limited.
    const res = await request(app)
      .post("/api/telemetry")
      .send(payload);
    expect(res.status).toBe(429);
  });
});
