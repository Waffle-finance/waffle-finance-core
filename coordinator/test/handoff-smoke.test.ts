/**
 * Coordinator–Relayer–Resolver handoff smoke test.
 *
 * Validates the full cross-service order lifecycle as a single, deterministic
 * workflow that runs in CI with no external services required.
 *
 * Architecture under test
 * ───────────────────────
 * The coordinator is the shared state store all three services write through:
 *   1. Relayer / frontend announces an order and records the src lock.
 *   2. Resolver detects the announced order, creates the dst lock on the
 *      opposite chain, and calls POST /api/orders/:id/dst-locked.
 *   3. User / relayer reveals the preimage via POST /api/secrets/reveal.
 *   4. Resolver polls GET /api/secrets/:id, retrieves the preimage, and
 *      completes the swap on the source chain.
 *
 * The relayer and resolver roles are played by test code that calls the same
 * HTTP endpoints those services use in production. No real process is started.
 *
 * How to run
 * ──────────
 *   pnpm --filter @wafflefinance/coordinator exec vitest run test/handoff-smoke.test.ts
 *   # or the full suite:
 *   pnpm --filter @wafflefinance/coordinator test
 *
 * Failure signal
 * ──────────────
 * A failure here means a service-boundary contract has drifted. Each describe
 * block names the exact flow and role that broke.
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

// ── Constants ─────────────────────────────────────────────────────────────────

const log = pino({ level: "silent" });

const ETH_ADDR     = "0x1111111111111111111111111111111111111111";
const XLM_ADDR     = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422";
const SOL_ADDR     = "11111111111111111111111111111111";
const RESOLVER_ETH = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const OPERATOR_KEY = "handoff-smoke-operator-key";

// ── Helpers ───────────────────────────────────────────────────────────────────

async function freshApp() {
  const dir = mkdtempSync(resolve(tmpdir(), "waffle-handoff-"));
  const db  = await openDatabase(`file:${dir}/test.db`);
  const repo    = new OrdersRepository(db);
  const orders  = new OrderService(repo, log);
  const secrets = new SecretService(orders, log);
  const quotes  = new QuoteService(log);
  return createApp({ log, corsOrigin: "*", orders, secrets, quotes });
}

function makeSecret(seed: string): { preimage: string; hashlock: string } {
  const raw     = seed.repeat(32);
  const preimage = `0x${raw}`;
  const hashlock = `0x${createHash("sha256").update(Buffer.from(raw, "hex")).digest("hex")}`;
  return { preimage, hashlock };
}

/** Attach the operator bearer token to a supertest request chain. */
function asOperator(req: ReturnType<typeof request.agent>) {
  return req.set("Authorization", `Bearer ${OPERATOR_KEY}`);
}

// ── Environment setup ─────────────────────────────────────────────────────────

let _originalOperatorKeys: string | undefined;

beforeEach(() => {
  _originalOperatorKeys = process.env.COORDINATOR_OPERATOR_KEYS;
  process.env.COORDINATOR_OPERATOR_KEYS = OPERATOR_KEY;
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network in test"));
});

afterEach(() => {
  if (_originalOperatorKeys === undefined) {
    delete process.env.COORDINATOR_OPERATOR_KEYS;
  } else {
    process.env.COORDINATOR_OPERATOR_KEYS = _originalOperatorKeys;
  }
  vi.restoreAllMocks();
});

// ── Flow 1: eth_to_xlm full lifecycle ────────────────────────────────────────

describe("handoff smoke: eth_to_xlm full lifecycle", () => {
  it("announce returns 201 and src-lock transitions to src_locked", async () => {
    const app = await freshApp();
    const { hashlock } = makeSecret("a1");

    const announce = await request(app).post("/api/orders/announce").send({
      direction: "eth_to_xlm", hashlock,
      srcChain: "ethereum", srcAddress: ETH_ADDR,
      srcAsset: "native", srcAmount: "1000000000000000000",
      srcSafetyDeposit: "1000000000000000",
      dstChain: "stellar", dstAddress: XLM_ADDR,
      dstAsset: "native", dstAmount: "100000000",
    });
    expect(announce.status).toBe(201);
    expect(announce.body.status).toBe("announced");
    expect(announce.body.hashlock).toBe(hashlock);
    const orderId = announce.body.id as string;
    expect(orderId).toMatch(/^wf_0x/);

    const srcTimelock = Math.floor(Date.now() / 1000) + 86_400;
    const srcLocked = await asOperator(
      request(app).post(`/api/orders/${orderId}/src-locked`),
    ).send({ orderId: "1", txHash: "0x" + "aa".repeat(32), blockNumber: 100, timelock: srcTimelock });
    expect(srcLocked.status).toBe(200);
    expect(srcLocked.body.ok).toBe(true);

    const afterSrc = await request(app).get(`/api/orders/${orderId}`);
    expect(afterSrc.body.status).toBe("src_locked");
    expect(afterSrc.body.src.orderId).toBe("1");
    expect(afterSrc.body.src.timelock).toBe(srcTimelock);
  });

  it("resolver dst-lock transitions to dst_locked with resolver field recorded", async () => {
    const app = await freshApp();
    const { hashlock } = makeSecret("a2");

    const announce = await request(app).post("/api/orders/announce").send({
      direction: "eth_to_xlm", hashlock,
      srcChain: "ethereum", srcAddress: ETH_ADDR,
      srcAsset: "native", srcAmount: "1000000000000000000",
      srcSafetyDeposit: "1000000000000000",
      dstChain: "stellar", dstAddress: XLM_ADDR,
      dstAsset: "native", dstAmount: "100000000",
    });
    const orderId = announce.body.id as string;

    await asOperator(request(app).post(`/api/orders/${orderId}/src-locked`))
      .send({ orderId: "2", txHash: "0x" + "bb".repeat(32), blockNumber: 110,
              timelock: Math.floor(Date.now() / 1000) + 86_400 });

    const dstTimelock = Math.floor(Date.now() / 1000) + 43_200;
    const dstLocked = await asOperator(
      request(app).post(`/api/orders/${orderId}/dst-locked`),
    ).send({ orderId: "xlm-0001", txHash: "0x" + "cc".repeat(32),
             blockNumber: 200, timelock: dstTimelock, resolver: RESOLVER_ETH });
    expect(dstLocked.status).toBe(200);
    expect(dstLocked.body.ok).toBe(true);

    const afterDst = await request(app).get(`/api/orders/${orderId}`);
    expect(afterDst.body.status).toBe("dst_locked");
    expect(afterDst.body.dst.orderId).toBe("xlm-0001");
    expect(afterDst.body.dst.timelock).toBe(dstTimelock);
    expect(afterDst.body.resolver).toBe(RESOLVER_ETH);
  });

  it("preimage reveal transitions to secret_revealed", async () => {
    const app = await freshApp();
    const { preimage, hashlock } = makeSecret("a3");

    const announce = await request(app).post("/api/orders/announce").send({
      direction: "eth_to_xlm", hashlock,
      srcChain: "ethereum", srcAddress: ETH_ADDR,
      srcAsset: "native", srcAmount: "1000000000000000000",
      srcSafetyDeposit: "1000000000000000",
      dstChain: "stellar", dstAddress: XLM_ADDR,
      dstAsset: "native", dstAmount: "100000000",
    });
    const orderId = announce.body.id as string;

    await asOperator(request(app).post(`/api/orders/${orderId}/src-locked`))
      .send({ orderId: "3", txHash: "0x" + "dd".repeat(32), blockNumber: 120,
              timelock: Math.floor(Date.now() / 1000) + 86_400 });

    const reveal = await request(app).post("/api/secrets/reveal")
      .send({ publicId: orderId, preimage, txHash: "0x" + "ee".repeat(32) });
    expect(reveal.status).toBe(200);
    expect(reveal.body.ok).toBe(true);

    const afterReveal = await request(app).get(`/api/orders/${orderId}`);
    expect(afterReveal.body.status).toBe("secret_revealed");
    expect(afterReveal.body.secret.revealed).toBe(true);
  });

  it("resolver retrieves the preimage from secrets endpoint after reveal", async () => {
    const app = await freshApp();
    const { preimage, hashlock } = makeSecret("a4");

    const announce = await request(app).post("/api/orders/announce").send({
      direction: "eth_to_xlm", hashlock,
      srcChain: "ethereum", srcAddress: ETH_ADDR,
      srcAsset: "native", srcAmount: "1000000000000000000",
      srcSafetyDeposit: "1000000000000000",
      dstChain: "stellar", dstAddress: XLM_ADDR,
      dstAsset: "native", dstAmount: "100000000",
    });
    const orderId = announce.body.id as string;

    await asOperator(request(app).post(`/api/orders/${orderId}/src-locked`))
      .send({ orderId: "4", txHash: "0x" + "ff".repeat(32), blockNumber: 130,
              timelock: Math.floor(Date.now() / 1000) + 86_400 });

    await request(app).post("/api/secrets/reveal")
      .send({ publicId: orderId, preimage, txHash: "0x" + "11".repeat(32) });

    // Resolver polls the secrets endpoint
    const secretGet = await request(app).get(`/api/secrets/${orderId}`);
    expect(secretGet.status).toBe(200);
    expect(secretGet.body.publicId).toBe(orderId);
    expect(secretGet.body.preimage).toBe(preimage);
  });

  it("history endpoint reflects each status step as the order advances", async () => {
    const app = await freshApp();
    const { preimage, hashlock } = makeSecret("a5");

    const announce = await request(app).post("/api/orders/announce").send({
      direction: "eth_to_xlm", hashlock,
      srcChain: "ethereum", srcAddress: ETH_ADDR,
      srcAsset: "native", srcAmount: "1000000000000000000",
      srcSafetyDeposit: "1000000000000000",
      dstChain: "stellar", dstAddress: XLM_ADDR,
      dstAsset: "native", dstAmount: "100000000",
    });
    const orderId = announce.body.id as string;

    let hist = await request(app).get("/api/orders/history").query({ address: ETH_ADDR });
    expect(hist.body.transactions[0].status).toBe("announced");

    await asOperator(request(app).post(`/api/orders/${orderId}/src-locked`))
      .send({ orderId: "5", txHash: "0x" + "12".repeat(32), blockNumber: 140,
              timelock: Math.floor(Date.now() / 1000) + 86_400 });

    hist = await request(app).get("/api/orders/history").query({ address: ETH_ADDR });
    expect(hist.body.transactions[0].status).toBe("src_locked");

    await asOperator(request(app).post(`/api/orders/${orderId}/dst-locked`))
      .send({ orderId: "xlm-hist", txHash: "0x" + "13".repeat(32), blockNumber: 141,
              timelock: Math.floor(Date.now() / 1000) + 43_200, resolver: RESOLVER_ETH });

    hist = await request(app).get("/api/orders/history").query({ address: ETH_ADDR });
    expect(hist.body.transactions[0].status).toBe("dst_locked");

    await request(app).post("/api/secrets/reveal")
      .send({ publicId: orderId, preimage, txHash: "0x" + "14".repeat(32) });

    hist = await request(app).get("/api/orders/history").query({ address: ETH_ADDR });
    expect(hist.body.transactions[0].status).toBe("secret_revealed");
  });
});

// ── Flow 2: sol_to_eth full lifecycle ─────────────────────────────────────────

describe("handoff smoke: sol_to_eth full lifecycle", () => {
  it("sol_to_eth order reaches secret_revealed through all handoff points", async () => {
    const app = await freshApp();
    const { preimage, hashlock } = makeSecret("b1");

    const announce = await request(app).post("/api/orders/announce").send({
      direction: "sol_to_eth", hashlock,
      srcChain: "solana", srcAddress: SOL_ADDR,
      srcAsset: "native", srcAmount: "1000000000", srcSafetyDeposit: "1000000",
      dstChain: "ethereum", dstAddress: ETH_ADDR,
      dstAsset: "native", dstAmount: "280000000000000000",
    });
    expect(announce.status).toBe(201);
    expect(announce.body.status).toBe("announced");
    expect(announce.body.src.chain).toBe("solana");
    expect(announce.body.dst.chain).toBe("ethereum");
    const orderId = announce.body.id as string;

    // Relayer records the Solana source lock (24-hour timelock)
    const srcTimelock = Math.floor(Date.now() / 1000) + 86_400;
    const srcLocked = await asOperator(
      request(app).post(`/api/orders/${orderId}/src-locked`),
    ).send({ orderId: "solana-order-0001", txHash: "0x" + "a0".repeat(32),
             blockNumber: 1000, timelock: srcTimelock });
    expect(srcLocked.status).toBe(200);

    const afterSrc = await request(app).get(`/api/orders/${orderId}`);
    expect(afterSrc.body.status).toBe("src_locked");
    expect(afterSrc.body.src.orderId).toBe("solana-order-0001");

    // Resolver records the Ethereum destination lock (12-hour timelock)
    const dstTimelock = Math.floor(Date.now() / 1000) + 43_200;
    const dstLocked = await asOperator(
      request(app).post(`/api/orders/${orderId}/dst-locked`),
    ).send({ orderId: "eth-order-9999", txHash: "0x" + "b0".repeat(32),
             blockNumber: 200, timelock: dstTimelock, resolver: RESOLVER_ETH });
    expect(dstLocked.status).toBe(200);

    const afterDst = await request(app).get(`/api/orders/${orderId}`);
    expect(afterDst.body.status).toBe("dst_locked");
    expect(afterDst.body.dst.orderId).toBe("eth-order-9999");
    expect(afterDst.body.resolver).toBe(RESOLVER_ETH);

    // User claims ETH on Ethereum, revealing the preimage
    const reveal = await request(app).post("/api/secrets/reveal")
      .send({ publicId: orderId, preimage, txHash: "0x" + "c0".repeat(32) });
    expect(reveal.status).toBe(200);

    const afterReveal = await request(app).get(`/api/orders/${orderId}`);
    expect(afterReveal.body.status).toBe("secret_revealed");

    // Resolver retrieves the preimage — now can claim on Solana
    const secretGet = await request(app).get(`/api/secrets/${orderId}`);
    expect(secretGet.status).toBe(200);
    expect(secretGet.body.preimage).toBe(preimage);
    expect(secretGet.body.publicId).toBe(orderId);
  });
});

// ── Flow 3: eth_to_sol full lifecycle ─────────────────────────────────────────

describe("handoff smoke: eth_to_sol full lifecycle", () => {
  it("eth_to_sol order transitions through all handoff states", async () => {
    const app = await freshApp();
    const { preimage, hashlock } = makeSecret("f1");

    const announce = await request(app).post("/api/orders/announce").send({
      direction: "eth_to_sol", hashlock,
      srcChain: "ethereum", srcAddress: ETH_ADDR,
      srcAsset: "native", srcAmount: "100000000000000000", srcSafetyDeposit: "1000000000000000",
      dstChain: "solana", dstAddress: SOL_ADDR,
      dstAsset: "native", dstAmount: "666000000",
    });
    expect(announce.status).toBe(201);
    expect(announce.body.src.chain).toBe("ethereum");
    expect(announce.body.dst.chain).toBe("solana");
    const orderId = announce.body.id as string;

    await asOperator(request(app).post(`/api/orders/${orderId}/src-locked`))
      .send({ orderId: "11", txHash: "0x" + "fa".repeat(32), blockNumber: 300,
              timelock: Math.floor(Date.now() / 1000) + 86_400 });

    const afterSrc = await request(app).get(`/api/orders/${orderId}`);
    expect(afterSrc.body.status).toBe("src_locked");

    await asOperator(request(app).post(`/api/orders/${orderId}/dst-locked`))
      .send({ orderId: "solana-dst-001", txHash: "0x" + "fb".repeat(32), blockNumber: 400,
              timelock: Math.floor(Date.now() / 1000) + 43_200, resolver: RESOLVER_ETH });

    const afterDst = await request(app).get(`/api/orders/${orderId}`);
    expect(afterDst.body.status).toBe("dst_locked");
    expect(afterDst.body.dst.orderId).toBe("solana-dst-001");

    await request(app).post("/api/secrets/reveal")
      .send({ publicId: orderId, preimage, txHash: "0x" + "fc".repeat(32) });

    const afterReveal = await request(app).get(`/api/orders/${orderId}`);
    expect(afterReveal.body.status).toBe("secret_revealed");

    const secretGet = await request(app).get(`/api/secrets/${orderId}`);
    expect(secretGet.status).toBe(200);
    expect(secretGet.body.preimage).toBe(preimage);
  });
});

// ── Flow 4: Resolver idempotency ─────────────────────────────────────────────

describe("handoff smoke: resolver event idempotency", () => {
  it("duplicate src-locked POST with identical params is a safe no-op", async () => {
    const app = await freshApp();
    const { hashlock } = makeSecret("c1");

    const announce = await request(app).post("/api/orders/announce").send({
      direction: "eth_to_xlm", hashlock,
      srcChain: "ethereum", srcAddress: ETH_ADDR,
      srcAsset: "native", srcAmount: "1000000000000000000",
      srcSafetyDeposit: "1000000000000000",
      dstChain: "stellar", dstAddress: XLM_ADDR,
      dstAsset: "native", dstAmount: "100000000",
    });
    const orderId = announce.body.id as string;

    const srcPayload = { orderId: "6", txHash: "0x" + "d1".repeat(32),
                         blockNumber: 150, timelock: Math.floor(Date.now() / 1000) + 86_400 };

    await asOperator(request(app).post(`/api/orders/${orderId}/src-locked`)).send(srcPayload);
    const dup = await asOperator(request(app).post(`/api/orders/${orderId}/src-locked`)).send(srcPayload);
    expect(dup.status).toBe(200);

    const state = await request(app).get(`/api/orders/${orderId}`);
    expect(state.body.status).toBe("src_locked");
  });

  it("duplicate dst-locked POST with identical params is a safe no-op", async () => {
    const app = await freshApp();
    const { hashlock } = makeSecret("c2");

    const announce = await request(app).post("/api/orders/announce").send({
      direction: "eth_to_xlm", hashlock,
      srcChain: "ethereum", srcAddress: ETH_ADDR,
      srcAsset: "native", srcAmount: "1000000000000000000",
      srcSafetyDeposit: "1000000000000000",
      dstChain: "stellar", dstAddress: XLM_ADDR,
      dstAsset: "native", dstAmount: "100000000",
    });
    const orderId = announce.body.id as string;

    await asOperator(request(app).post(`/api/orders/${orderId}/src-locked`))
      .send({ orderId: "7", txHash: "0x" + "e1".repeat(32), blockNumber: 160,
              timelock: Math.floor(Date.now() / 1000) + 86_400 });

    const dstPayload = { orderId: "xlm-idem-001", txHash: "0x" + "d2".repeat(32),
                         blockNumber: 161, timelock: Math.floor(Date.now() / 1000) + 43_200,
                         resolver: RESOLVER_ETH };

    const first  = await asOperator(request(app).post(`/api/orders/${orderId}/dst-locked`)).send(dstPayload);
    const second = await asOperator(request(app).post(`/api/orders/${orderId}/dst-locked`)).send(dstPayload);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const state = await request(app).get(`/api/orders/${orderId}`);
    expect(state.body.status).toBe("dst_locked");
    expect(state.body.resolver).toBe(RESOLVER_ETH);
  });
});

// ── Flow 5: State machine integrity ──────────────────────────────────────────

describe("handoff smoke: state machine integrity at service boundaries", () => {
  it("dst-locked before src-locked returns 400 (out-of-order handoff rejected)", async () => {
    const app = await freshApp();
    const { hashlock } = makeSecret("d1");

    const announce = await request(app).post("/api/orders/announce").send({
      direction: "eth_to_xlm", hashlock,
      srcChain: "ethereum", srcAddress: ETH_ADDR,
      srcAsset: "native", srcAmount: "1000000000000000000",
      srcSafetyDeposit: "1000000000000000",
      dstChain: "stellar", dstAddress: XLM_ADDR,
      dstAsset: "native", dstAmount: "100000000",
    });
    const orderId = announce.body.id as string;

    // Resolver skips src-lock and tries to jump straight to dst-lock
    const res = await asOperator(
      request(app).post(`/api/orders/${orderId}/dst-locked`),
    ).send({ orderId: "xlm-early", txHash: "0x" + "f1".repeat(32),
             blockNumber: 1, timelock: Math.floor(Date.now() / 1000) + 43_200,
             resolver: RESOLVER_ETH });

    expect(res.status).toBe(400);

    // Order must stay at announced — no state corruption
    const state = await request(app).get(`/api/orders/${orderId}`);
    expect(state.body.status).toBe("announced");
  });

  it("secret reveal before src-locked is rejected", async () => {
    const app = await freshApp();
    const { preimage, hashlock } = makeSecret("d2");

    const announce = await request(app).post("/api/orders/announce").send({
      direction: "eth_to_xlm", hashlock,
      srcChain: "ethereum", srcAddress: ETH_ADDR,
      srcAsset: "native", srcAmount: "1000000000000000000",
      srcSafetyDeposit: "1000000000000000",
      dstChain: "stellar", dstAddress: XLM_ADDR,
      dstAsset: "native", dstAmount: "100000000",
    });
    const orderId = announce.body.id as string;

    const res = await request(app).post("/api/secrets/reveal")
      .send({ publicId: orderId, preimage, txHash: "0x" + "f2".repeat(32) });

    // SecretService rejects reveals on non-src_locked orders; the status
    // may be 400, 409, or 422 depending on which error branch fires.
    expect([400, 409, 422]).toContain(res.status);

    const state = await request(app).get(`/api/orders/${orderId}`);
    expect(state.body.status).toBe("announced");
  });

  it("duplicate announce with the same hashlock returns 400", async () => {
    const app = await freshApp();
    const { hashlock } = makeSecret("d3");

    const body = {
      direction: "eth_to_xlm", hashlock,
      srcChain: "ethereum", srcAddress: ETH_ADDR,
      srcAsset: "native", srcAmount: "1000000000000000000",
      srcSafetyDeposit: "1000000000000000",
      dstChain: "stellar", dstAddress: XLM_ADDR,
      dstAsset: "native", dstAmount: "100000000",
    };

    const first  = await request(app).post("/api/orders/announce").send(body);
    const second = await request(app).post("/api/orders/announce").send(body);
    expect(first.status).toBe(201);
    expect(second.status).toBe(400);
  });
});

// ── Flow 6: Operator auth enforcement ────────────────────────────────────────

describe("handoff smoke: operator auth on protected handoff endpoints", () => {
  it("src-locked without auth returns 401 or 403", async () => {
    const app = await freshApp();
    const { hashlock } = makeSecret("e1");

    const announce = await request(app).post("/api/orders/announce").send({
      direction: "eth_to_xlm", hashlock,
      srcChain: "ethereum", srcAddress: ETH_ADDR,
      srcAsset: "native", srcAmount: "1000000000000000000",
      srcSafetyDeposit: "1000000000000000",
      dstChain: "stellar", dstAddress: XLM_ADDR,
      dstAsset: "native", dstAmount: "100000000",
    });
    const orderId = announce.body.id as string;

    const res = await request(app).post(`/api/orders/${orderId}/src-locked`)
      .send({ orderId: "8", txHash: "0x" + "aa".repeat(32),
              blockNumber: 1, timelock: Math.floor(Date.now() / 1000) + 86_400 });

    expect([401, 403]).toContain(res.status);
    const state = await request(app).get(`/api/orders/${orderId}`);
    expect(state.body.status).toBe("announced");
  });

  it("dst-locked without auth returns 401 or 403", async () => {
    const app = await freshApp();
    const { hashlock } = makeSecret("e2");

    const announce = await request(app).post("/api/orders/announce").send({
      direction: "eth_to_xlm", hashlock,
      srcChain: "ethereum", srcAddress: ETH_ADDR,
      srcAsset: "native", srcAmount: "1000000000000000000",
      srcSafetyDeposit: "1000000000000000",
      dstChain: "stellar", dstAddress: XLM_ADDR,
      dstAsset: "native", dstAmount: "100000000",
    });
    const orderId = announce.body.id as string;

    await asOperator(request(app).post(`/api/orders/${orderId}/src-locked`))
      .send({ orderId: "9", txHash: "0x" + "ab".repeat(32),
              blockNumber: 1, timelock: Math.floor(Date.now() / 1000) + 86_400 });

    const res = await request(app).post(`/api/orders/${orderId}/dst-locked`)
      .send({ orderId: "xlm-unauth", txHash: "0x" + "ac".repeat(32),
              blockNumber: 2, timelock: Math.floor(Date.now() / 1000) + 43_200,
              resolver: RESOLVER_ETH });

    expect([401, 403]).toContain(res.status);
    const state = await request(app).get(`/api/orders/${orderId}`);
    expect(state.body.status).toBe("src_locked");
  });

  it("src-locked with a wrong bearer token returns 401 or 403", async () => {
    const app = await freshApp();
    const { hashlock } = makeSecret("e3");

    const announce = await request(app).post("/api/orders/announce").send({
      direction: "eth_to_xlm", hashlock,
      srcChain: "ethereum", srcAddress: ETH_ADDR,
      srcAsset: "native", srcAmount: "1000000000000000000",
      srcSafetyDeposit: "1000000000000000",
      dstChain: "stellar", dstAddress: XLM_ADDR,
      dstAsset: "native", dstAmount: "100000000",
    });
    const orderId = announce.body.id as string;

    const res = await request(app).post(`/api/orders/${orderId}/src-locked`)
      .set("Authorization", "Bearer totally-wrong-key")
      .send({ orderId: "10", txHash: "0x" + "ba".repeat(32),
              blockNumber: 1, timelock: Math.floor(Date.now() / 1000) + 86_400 });

    expect([401, 403]).toContain(res.status);
  });
});

// ── Flow 7: Multi-order isolation ────────────────────────────────────────────

describe("handoff smoke: concurrent orders do not bleed state", () => {
  it("two orders on different directions advance independently", async () => {
    const app = await freshApp();
    const secretA = makeSecret("a0");
    const secretB = makeSecret("b0");

    const [annA, annB] = await Promise.all([
      request(app).post("/api/orders/announce").send({
        direction: "eth_to_xlm", hashlock: secretA.hashlock,
        srcChain: "ethereum", srcAddress: ETH_ADDR,
        srcAsset: "native", srcAmount: "1000000000000000000",
        srcSafetyDeposit: "1000000000000000",
        dstChain: "stellar", dstAddress: XLM_ADDR,
        dstAsset: "native", dstAmount: "100000000",
      }),
      request(app).post("/api/orders/announce").send({
        direction: "sol_to_eth", hashlock: secretB.hashlock,
        srcChain: "solana", srcAddress: SOL_ADDR,
        srcAsset: "native", srcAmount: "1000000000", srcSafetyDeposit: "1000000",
        dstChain: "ethereum", dstAddress: ETH_ADDR,
        dstAsset: "native", dstAmount: "280000000000000000",
      }),
    ]);
    expect(annA.status).toBe(201);
    expect(annB.status).toBe(201);

    const orderIdA = annA.body.id as string;
    const orderIdB = annB.body.id as string;
    expect(orderIdA).not.toBe(orderIdB);

    // Advance A to src_locked
    await asOperator(request(app).post(`/api/orders/${orderIdA}/src-locked`))
      .send({ orderId: "12", txHash: "0x" + "ab".repeat(32),
              blockNumber: 10, timelock: Math.floor(Date.now() / 1000) + 86_400 });

    // B must still be announced — not contaminated by A's src-lock
    const stateB = await request(app).get(`/api/orders/${orderIdB}`);
    expect(stateB.body.status).toBe("announced");

    // Advance B to src_locked
    await asOperator(request(app).post(`/api/orders/${orderIdB}/src-locked`))
      .send({ orderId: "sol-002", txHash: "0x" + "ba".repeat(32),
              blockNumber: 20, timelock: Math.floor(Date.now() / 1000) + 86_400 });

    // A must still be src_locked — not further advanced by B's event
    const stateA = await request(app).get(`/api/orders/${orderIdA}`);
    expect(stateA.body.status).toBe("src_locked");

    // Both orders must appear in ETH_ADDR history
    const hist = await request(app).get("/api/orders/history").query({ address: ETH_ADDR });
    const ids = hist.body.transactions.map((t: { id: string }) => t.id);
    expect(ids).toContain(orderIdA);
    expect(ids).toContain(orderIdB);
  });
});
