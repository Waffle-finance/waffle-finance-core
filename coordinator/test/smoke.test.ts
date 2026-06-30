/**
 * Smoke tests — critical user flows
 *
 * Each describe block is one named user journey exercised end-to-end
 * against a real Express app wired to an in-memory SQLite database.
 * No network connections or external services are required.
 *
 * Flows covered:
 *   1. Health check              – service is reachable and reporting healthy
 *   2. Fetch a quote             – both pair endpoints and the aggregate prices feed
 *   3. Announce an order         – order created and immediately retrievable by ID
 *   4. Reveal a secret           – announce → src-lock → reveal → retrieve cycle
 *   5. Check transaction history – announced order visible in address history
 */

import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import pino from "pino";
import { openDatabase } from "../src/persistence/db.js";
import { OrdersRepository } from "../src/persistence/orders-repo.js";
import { OrderService } from "../src/services/order-service.js";
import { SecretService } from "../src/services/secret-service.js";
import { QuoteService } from "../src/services/quote-service.js";
import { createApp } from "../src/server/app.js";

// ── Helpers ────────────────────────────────────────────────────────────────

const log = pino({ level: "silent" });

/** Ethereum address used as src/dst in eth_to_xlm tests. */
const ETH_ADDR    = "0x1111111111111111111111111111111111111111";
/** Stellar address used as dst in eth_to_xlm and src in xlm_to_eth tests. */
const STELLAR_ADDR = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422";
/** Solana address used as src in sol_to_eth tests. */
const SOLANA_ADDR  = "11111111111111111111111111111111";

/**
 * Spin up a fresh, fully isolated Express application backed by an
 * in-memory SQLite database.  Each call returns an independent instance
 * so tests cannot share or corrupt each other's state.
 */
async function freshApp() {
  const dir  = mkdtempSync(resolve(tmpdir(), "waffle-smoke-"));
  const db   = await openDatabase(`file:${dir}/test.db`);
  const repo = new OrdersRepository(db);
  const orders  = new OrderService(repo, log);
  const secrets = new SecretService(orders, log);
  const quotes  = new QuoteService(log);
  return createApp({ log, corsOrigin: "*", orders, secrets, quotes });
}

/**
 * Build a { hashlock, preimage } pair from a 2-hex-char seed byte.
 *
 * hashlock = SHA-256(preimage) — the same digest the coordinator verifies
 * when a secret is revealed.  Using a deterministic seed keeps test
 * failures reproducible without requiring the SDK crypto module.
 */
function makeSecret(seedByte: string): { preimage: string; hashlock: string } {
  const rawHex  = seedByte.repeat(32);               // 64 hex chars = 32 bytes
  const preimage = `0x${rawHex}`;
  const hashlock = `0x${createHash("sha256").update(Buffer.from(rawHex, "hex")).digest("hex")}`;
  return { preimage, hashlock };
}

// ── Flow 1: Health check ──────────────────────────────────────────────────

describe("smoke: health check", () => {
  it("GET /healthz returns 200 with status ok and service name", async () => {
    const app = await freshApp();

    const res = await request(app).get("/healthz");

    expect(res.status, "expected HTTP 200 from /healthz").toBe(200);
    expect(res.body.status, "expected status field to be 'ok'").toBe("ok");
    expect(res.body.service, "expected service name in response").toBe(
      "wafflefinance-coordinator"
    );
  });
});

// ── Flow 2: Fetch a quote ─────────────────────────────────────────────────

describe("smoke: fetch a quote", () => {
  // The QuoteService calls CoinGecko with an 8-second AbortSignal timeout.
  // In CI there is no guarantee that CoinGecko is reachable, so we stub
  // fetch to fail immediately.  The service has a hardcoded fallback that
  // activates on upstream failure — this is the path most important to test
  // in CI (the "prices may be stale" scenario is a production reality).
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network unavailable"));
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("GET /api/quotes/eth-xlm returns a well-formed snapshot", async () => {
    const app = await freshApp();

    const res = await request(app).get("/api/quotes/eth-xlm");

    expect(res.status).toBe(200);
    // Prices may arrive as strings or fall back to hardcoded constants —
    // either way they must be present and non-null.
    expect(typeof res.body.ethUsd, "ethUsd must be a string").toBe("string");
    expect(typeof res.body.xlmUsd, "xlmUsd must be a string").toBe("string");
    expect(["fresh", "stale", "fallback"], "staleness must be a known value").toContain(
      res.body.staleness
    );
    expect(typeof res.body.fetchedAt, "fetchedAt must be a unix ms timestamp").toBe("number");
    expect(typeof res.body.ageMs, "ageMs must be a non-negative number").toBe("number");
  });

  it("GET /api/quotes/eth-sol returns a well-formed snapshot", async () => {
    const app = await freshApp();

    const res = await request(app).get("/api/quotes/eth-sol");

    expect(res.status).toBe(200);
    expect(typeof res.body.ethUsd).toBe("string");
    expect(typeof res.body.solUsd).toBe("string");
    expect(["fresh", "stale", "fallback"]).toContain(res.body.staleness);
  });

  it("GET /api/prices returns the aggregated price feed with all three assets", async () => {
    const app = await freshApp();

    const res = await request(app).get("/api/prices");

    expect(res.status).toBe(200);
    // All three asset prices are numbers — the route coerces nulls to
    // hardcoded fallback constants so the UI never crashes on a cold start.
    expect(typeof res.body.ethUsd, "ethUsd must be a number").toBe("number");
    expect(typeof res.body.xlmUsd, "xlmUsd must be a number").toBe("number");
    expect(typeof res.body.solUsd, "solUsd must be a number").toBe("number");
    // Exchange-rate helpers the BridgeForm uses must also be present.
    expect(typeof res.body.xlmPerEth, "xlmPerEth must be a number").toBe("number");
    expect(typeof res.body.ethPerXlm, "ethPerXlm must be a number").toBe("number");
    expect(["fresh", "stale", "fallback"]).toContain(res.body.staleness);
  });
});

// ── Flow 3: Announce an order ─────────────────────────────────────────────

describe("smoke: announce an order", () => {
  it("announced order is immediately retrievable by its public ID", async () => {
    const app = await freshApp();
    const { hashlock } = makeSecret("a1");

    // Step 1 — announce
    const announce = await request(app)
      .post("/api/orders/announce")
      .send({
        direction: "eth_to_xlm",
        hashlock,
        srcChain: "ethereum",
        srcAddress: ETH_ADDR,
        srcAsset: "native",
        srcAmount: "1000000000000000000",
        srcSafetyDeposit: "1000000000000000",
        dstChain: "stellar",
        dstAddress: STELLAR_ADDR,
        dstAsset: "native",
        dstAmount: "100000000",
      });

    expect(announce.status, "announce must return 201 Created").toBe(201);
    expect(typeof announce.body.id, "response must carry a public order ID").toBe("string");
    expect(announce.body.status, "newly announced order must have status 'announced'").toBe(
      "announced"
    );
    expect(announce.body.hashlock).toBe(hashlock);

    const orderId = announce.body.id as string;

    // Step 2 — retrieve by ID
    const get = await request(app).get(`/api/orders/${orderId}`);

    expect(get.status, "GET /api/orders/:id must return 200").toBe(200);
    expect(get.body.id).toBe(orderId);
    expect(get.body.status).toBe("announced");
    expect(get.body.hashlock).toBe(hashlock);
    expect(get.body.src.chain).toBe("ethereum");
    expect(get.body.dst.chain).toBe("stellar");
  });
});

// ── Flow 4: Reveal a secret ──────────────────────────────────────────────
//
// Minimum state-machine path that allows a reveal:
//   announced → src_locked → secret_revealed
//
// The src-locked step advances the order into a state that permits the
// secret-reveal transition (see coordinator/src/state-machine/order-machine.ts).

describe("smoke: reveal a secret", () => {
  it("preimage is retrievable after announce → src-lock → reveal", async () => {
    const app = await freshApp();
    const { preimage, hashlock } = makeSecret("b2");

    // Step 1 — announce (sol_to_eth direction)
    const announce = await request(app)
      .post("/api/orders/announce")
      .send({
        direction: "sol_to_eth",
        hashlock,
        srcChain: "solana",
        srcAddress: SOLANA_ADDR,
        srcAsset: "native",
        srcAmount: "1000000000",
        srcSafetyDeposit: "1000000",
        dstChain: "ethereum",
        dstAddress: ETH_ADDR,
        dstAsset: "native",
        dstAmount: "280000000000000000",
      });

    expect(announce.status, "announce must return 201 Created").toBe(201);
    const orderId = announce.body.id as string;

    // Step 2 — record source lock (transitions status to src_locked)
    const srcLocked = await request(app)
      .post(`/api/orders/${orderId}/src-locked`)
      .send({
        orderId: "solana-order-0001",
        txHash: "0xaabbccdd00000000000000000000000000000000000000000000000000000001",
        blockNumber: 100,
        timelock: Math.floor(Date.now() / 1000) + 86_400,
      });

    expect(srcLocked.status, "src-locked must return 200").toBe(200);
    expect(srcLocked.body.ok).toBe(true);

    // Step 3 — reveal the preimage
    const reveal = await request(app)
      .post("/api/secrets/reveal")
      .send({
        publicId: orderId,
        preimage,
        txHash: "0xdeadbeef00000000000000000000000000000000000000000000000000000002",
      });

    expect(reveal.status, "reveal must return 200 ok").toBe(200);
    expect(reveal.body.ok).toBe(true);

    // Step 4 — retrieve the revealed preimage
    const get = await request(app).get(`/api/secrets/${orderId}`);

    expect(get.status, "GET /api/secrets/:id must return 200 once revealed").toBe(200);
    expect(get.body.publicId).toBe(orderId);
    expect(get.body.preimage, "retrieved preimage must match what was revealed").toBe(preimage);
  });
});

// ── Flow 5: Check transaction history ────────────────────────────────────

describe("smoke: check transaction history", () => {
  it("announced order appears in the source-address history", async () => {
    const app = await freshApp();
    const { hashlock } = makeSecret("c3");

    // Step 1 — announce an order for a known Ethereum address
    const announce = await request(app)
      .post("/api/orders/announce")
      .send({
        direction: "eth_to_xlm",
        hashlock,
        srcChain: "ethereum",
        srcAddress: ETH_ADDR,
        srcAsset: "native",
        srcAmount: "1000000000000000000",
        srcSafetyDeposit: "1000000000000000",
        dstChain: "stellar",
        dstAddress: STELLAR_ADDR,
        dstAsset: "native",
        dstAmount: "100000000",
      });

    expect(announce.status).toBe(201);
    const orderId = announce.body.id as string;

    // Step 2 — query history for the source address
    const history = await request(app)
      .get("/api/orders/history")
      .query({ address: ETH_ADDR });

    expect(history.status, "history must return 200").toBe(200);
    expect(history.body.transactions, "history must contain exactly the one announced order").toHaveLength(1);
    expect(history.body.transactions[0].id).toBe(orderId);
    expect(history.body.transactions[0].status).toBe("announced");
    expect(history.body.pagination.count).toBe(1);
  });

  it("history for an address with no orders returns an empty list", async () => {
    const app = await freshApp();
    const unusedAddr = "0x9999999999999999999999999999999999999999";

    const res = await request(app)
      .get("/api/orders/history")
      .query({ address: unusedAddr });

    expect(res.status).toBe(200);
    expect(res.body.transactions).toEqual([]);
    expect(res.body.pagination.count).toBe(0);
  });
});
