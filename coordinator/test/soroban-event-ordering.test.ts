/**
 * Tests for Soroban event ordering, same-ledger sequencing, and edge-case
 * delivery patterns in the SorobanListener.
 *
 * Covers:
 *   - Out-of-order ledger delivery (ev.ledger < lastProcessedLedger) — Guard 1
 *   - Same-ledger events for different orders processed independently
 *   - Invalid ledger metadata (NaN, Infinity, unsafe integers)
 *   - Idempotency under partial RPC responses: same event batch re-delivered
 *   - Deduplication boundary: events at exactly lastProcessedLedger pass through
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import pino from "pino";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { openDatabase } from "../src/persistence/db.js";
import { OrdersRepository } from "../src/persistence/orders-repo.js";
import { OrderService } from "../src/services/order-service.js";
import { SorobanListener } from "../src/listeners/soroban-listener.js";
import type { CoordinatorConfig } from "../src/config.js";
import {
  makeCreatedEvent,
  makeClaimedEvent,
  makeRefundedEvent,
  HASHLOCK,
  PREIMAGE,
  ORDER_ID,
  TIMELOCK,
} from "./fixtures/soroban-xdr-fixtures.js";

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();
  return {
    ...actual,
    rpc: {
      ...actual.rpc,
      Server: vi.fn(() => ({
        getLatestLedger: vi.fn(async () => ({ sequence: 20000 })),
        getEvents: vi.fn(async () => ({ events: [], cursor: null })),
      })),
    },
  };
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

const log = pino({ level: "silent" });

const VALID_ETH_ADDR = "0x1111111111111111111111111111111111111111";
const VALID_STELLAR_ADDR = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422";
const HASHLOCK_B = "0x" + "b".repeat(64);

const BASE_CFG: CoordinatorConfig = {
  network: "testnet",
  port: 3001,
  databaseUrl: "file::memory:",
  logLevel: "error",
  corsOrigin: "*",
  pollIntervalMs: 5000,
  ethereum: {
    rpcUrl: "http://localhost:8545",
    chainId: 11155111,
    htlcEscrow: "0xb352339BEb146f2699d28D736700B953988bB178",
  },
  soroban: {
    rpcUrl: "http://localhost:8000/soroban/rpc",
    htlcContract: "CDIKSJKVMXKGBRD3BBEBMF7Q4GQJ52ECU6R6G5HEKXKXVGGWK2CTA6JK",
    networkPassphrase: "Test SDF Network ; September 2015",
  },
  solana: {
    rpcUrl: "http://localhost:8899",
    programId: "HTLCprogramIDpubkey111111111111111111111111",
    commitment: "confirmed",
  },
} as unknown as CoordinatorConfig;

async function makeServices() {
  const db = await openDatabase("file::memory:");
  const repo = new OrdersRepository(db);
  const svc = new OrderService(repo, log.child({ component: "order-service" }));
  return { db, repo, svc };
}

async function announceOrder(svc: OrderService, hashlock = HASHLOCK) {
  return svc.announce({
    direction: "eth_to_xlm",
    hashlock,
    srcChain: "ethereum",
    srcAddress: VALID_ETH_ADDR,
    srcAsset: "native",
    srcAmount: "1000000000000000000",
    srcSafetyDeposit: "1000000000000000",
    dstChain: "stellar",
    dstAddress: VALID_STELLAR_ADDR,
    dstAsset: "native",
    dstAmount: "100000000",
  });
}

// ─── Out-of-order ledger delivery (Guard 1) ───────────────────────────────────

describe("SorobanListener — out-of-order ledger delivery", () => {
  it("skips an event whose ledger is strictly less than lastProcessedLedger", async () => {
    const { svc } = await makeServices();
    await announceOrder(svc);
    const recordSrcLock = vi.spyOn(svc, "recordSrcLock");
    const listener = new SorobanListener(BASE_CFG, svc, log);

    // Advance the internal ledger pointer by processing a valid event.
    const evFirst = { ...makeCreatedEvent(), ledger: 5000, txHash: "tx_first" };
    await (listener as any).processSorobanEvent(evFirst);
    expect(recordSrcLock).toHaveBeenCalledTimes(1);

    // Now submit an event from an earlier ledger — must be skipped entirely.
    const evLate = { ...makeCreatedEvent(), ledger: 4999, txHash: "tx_late" };
    await (listener as any).processSorobanEvent(evLate);
    // The first call already wrote to DB; the late event must not trigger another.
    expect(recordSrcLock).toHaveBeenCalledTimes(1);
  });

  it("allows an event at exactly lastProcessedLedger (boundary condition)", async () => {
    const { svc } = await makeServices();
    await announceOrder(svc, HASHLOCK);
    await announceOrder(svc, HASHLOCK_B);
    const recordSrcLock = vi.spyOn(svc, "recordSrcLock");
    const listener = new SorobanListener(BASE_CFG, svc, log);

    // Process event at ledger 5000 to advance the HWM.
    const evA = { ...makeCreatedEvent(), ledger: 5000, txHash: "tx_a" };
    await (listener as any).processSorobanEvent(evA);
    expect(recordSrcLock).toHaveBeenCalledTimes(1);

    // Process a *different* event (different txHash) also at ledger 5000 —
    // it is NOT behind the HWM, so it must be processed.
    const { nativeToScVal } = await import("@stellar/stellar-sdk");
    const base2 = makeCreatedEvent(5000, "tx_b");
    const topic2 = [...base2.topic];
    topic2[3] = nativeToScVal(Buffer.from("b".repeat(64), "hex")) as any;
    const evB = { ...base2, topic: topic2, ledger: 5000, txHash: "tx_b" };
    await (listener as any).processSorobanEvent(evB);
    expect(recordSrcLock).toHaveBeenCalledTimes(2);
  });

  it("processes events in strictly increasing ledger order without skips", async () => {
    const { svc } = await makeServices();
    await announceOrder(svc);
    const recordSrcLock = vi.spyOn(svc, "recordSrcLock");
    const listener = new SorobanListener(BASE_CFG, svc, log);

    const ev = makeCreatedEvent(6000, "tx_incr");
    await (listener as any).processSorobanEvent({ ledger: 6000, txHash: "tx_incr", ...ev });
    expect(recordSrcLock).toHaveBeenCalledTimes(1);
  });
});

// ─── Invalid ledger metadata ──────────────────────────────────────────────────

describe("SorobanListener — invalid ledger metadata guard", () => {
  it("rejects an event with NaN ledger without dispatching", async () => {
    const { svc } = await makeServices();
    await announceOrder(svc);
    const recordSrcLock = vi.spyOn(svc, "recordSrcLock");
    const listener = new SorobanListener(BASE_CFG, svc, log);

    const ev = { ...makeCreatedEvent(), ledger: NaN, txHash: "tx_nan" };
    const applied = await (listener as any).processSorobanEvent(ev);
    expect(applied).toBe(false);
    expect(recordSrcLock).not.toHaveBeenCalled();
  });

  it("rejects an event with Infinity ledger without dispatching", async () => {
    const { svc } = await makeServices();
    await announceOrder(svc);
    const recordSrcLock = vi.spyOn(svc, "recordSrcLock");
    const listener = new SorobanListener(BASE_CFG, svc, log);

    const ev = { ...makeCreatedEvent(), ledger: Infinity, txHash: "tx_inf" };
    const applied = await (listener as any).processSorobanEvent(ev);
    expect(applied).toBe(false);
    expect(recordSrcLock).not.toHaveBeenCalled();
  });

  it("rejects an event with a negative ledger", async () => {
    const { svc } = await makeServices();
    await announceOrder(svc);
    const recordSrcLock = vi.spyOn(svc, "recordSrcLock");
    const listener = new SorobanListener(BASE_CFG, svc, log);

    const ev = { ...makeCreatedEvent(), ledger: -1, txHash: "tx_neg" };
    const applied = await (listener as any).processSorobanEvent(ev);
    expect(applied).toBe(false);
    expect(recordSrcLock).not.toHaveBeenCalled();
  });

  it("rejects an event with an unsafe-integer ledger", async () => {
    const { svc } = await makeServices();
    await announceOrder(svc);
    const recordSrcLock = vi.spyOn(svc, "recordSrcLock");
    const listener = new SorobanListener(BASE_CFG, svc, log);

    const ev = {
      ...makeCreatedEvent(),
      ledger: Number.MAX_SAFE_INTEGER + 1,
      txHash: "tx_unsafe",
    };
    const applied = await (listener as any).processSorobanEvent(ev);
    expect(applied).toBe(false);
    expect(recordSrcLock).not.toHaveBeenCalled();
  });
});

// ─── Same-ledger multi-event ordering ────────────────────────────────────────

describe("SorobanListener — same-ledger event sequencing", () => {
  it("processes multiple events from the same ledger in submission order", async () => {
    const { svc } = await makeServices();
    await announceOrder(svc, HASHLOCK);
    await announceOrder(svc, HASHLOCK_B);
    const recordSrcLock = vi.spyOn(svc, "recordSrcLock");
    const listener = new SorobanListener(BASE_CFG, svc, log);

    const { nativeToScVal } = await import("@stellar/stellar-sdk");
    const evA = { ...makeCreatedEvent(), ledger: 7000, txHash: "same_ledger_tx_0", id: "7000-1" };
    const base2 = makeCreatedEvent(7000, "same_ledger_tx_1");
    const topic2 = [...base2.topic];
    topic2[3] = nativeToScVal(Buffer.from("b".repeat(64), "hex")) as any;
    const evB = { ...base2, topic: topic2, ledger: 7000, txHash: "same_ledger_tx_1", id: "7000-2" };

    // Both events are at the same ledger; both should be processed.
    await (listener as any).processSorobanEvent(evA);
    await (listener as any).processSorobanEvent(evB);
    expect(recordSrcLock).toHaveBeenCalledTimes(2);
  });

  it("deduplicates a re-delivered event within the same ledger", async () => {
    const { svc } = await makeServices();
    await announceOrder(svc);
    const recordSrcLock = vi.spyOn(svc, "recordSrcLock");
    const listener = new SorobanListener(BASE_CFG, svc, log);

    const ev = { ...makeCreatedEvent(), ledger: 8000, txHash: "dup_tx", id: "8000-1" };

    await (listener as any).processSorobanEvent(ev);
    await (listener as any).processSorobanEvent(ev); // exact duplicate
    expect(recordSrcLock).toHaveBeenCalledTimes(1);
  });

  it("is idempotent when a partial RPC response redelivers already-processed events", async () => {
    const { svc } = await makeServices();
    await announceOrder(svc);
    const recordSrcLock = vi.spyOn(svc, "recordSrcLock");
    const listener = new SorobanListener(BASE_CFG, svc, log);

    // Simulate a batch of events where the first page is redelivered on retry.
    const evs = [
      { ...makeCreatedEvent(), ledger: 9000, txHash: "batch_tx", id: "9000-1" },
    ];

    for (const ev of evs) await (listener as any).processSorobanEvent(ev);
    expect(recordSrcLock).toHaveBeenCalledTimes(1);

    // Redelivery of the same batch (partial RPC overlap).
    for (const ev of evs) await (listener as any).processSorobanEvent(ev);
    expect(recordSrcLock).toHaveBeenCalledTimes(1); // still 1 — idempotent
  });
});

// ─── isDuplicate — public dedup API ──────────────────────────────────────────

describe("SorobanListener.isDuplicate — public dedup API", () => {
  it("returns false before any event is marked processed", () => {
    const listener = new SorobanListener(BASE_CFG, undefined as any, log);
    expect(listener.isDuplicate("created", "tx1")).toBe(false);
    expect(listener.isDuplicate("claimed", "tx1")).toBe(false);
  });

  it("returns true after the same (kind, txHash) pair is processed", async () => {
    const { svc } = await makeServices();
    await announceOrder(svc);
    const listener = new SorobanListener(BASE_CFG, svc, log);

    const ev = { ...makeCreatedEvent(), ledger: 1000, txHash: "dedup_tx", id: "1000-1" };
    await (listener as any).processSorobanEvent(ev);

    expect(listener.isDuplicate("created", "dedup_tx", "1000-1")).toBe(true);
  });

  it("returns false for a different discriminator on the same txHash", async () => {
    const { svc } = await makeServices();
    await announceOrder(svc, HASHLOCK);
    await announceOrder(svc, HASHLOCK_B);
    const listener = new SorobanListener(BASE_CFG, svc, log);

    const { nativeToScVal } = await import("@stellar/stellar-sdk");
    const evA = { ...makeCreatedEvent(), ledger: 2000, txHash: "multi_ev_tx", id: "2000-1" };
    await (listener as any).processSorobanEvent(evA);

    // Different discriminator (different event index in the same tx).
    expect(listener.isDuplicate("created", "multi_ev_tx", "2000-1")).toBe(true);
    expect(listener.isDuplicate("created", "multi_ev_tx", "2000-2")).toBe(false);
  });
});

// ─── getStalenessInfo — health signal ────────────────────────────────────────

describe("SorobanListener.getStalenessInfo — staleness state", () => {
  it("returns inactive when the listener has not polled yet", () => {
    const listener = new SorobanListener(BASE_CFG, undefined as any, log);
    const info = listener.getStalenessInfo();
    expect(info.state).toBe("inactive");
    expect(info.lastPollAgeSeconds).toBe(-1);
    expect(info.lastProcessedLedger).toBe(0);
  });

  it("returns connected immediately after a poll timestamp is set", () => {
    const listener = new SorobanListener(BASE_CFG, undefined as any, log);
    // Manually set lastPollTimestampMs via private field access for the unit test.
    (listener as any).lastPollTimestampMs = Date.now();
    const info = listener.getStalenessInfo();
    expect(info.state).toBe("connected");
    expect(info.lastPollAgeSeconds).toBeGreaterThanOrEqual(0);
    expect(info.lastPollAgeSeconds).toBeLessThan(1);
  });

  it("returns degraded when last poll was more than 2 minutes ago", () => {
    const listener = new SorobanListener(BASE_CFG, undefined as any, log);
    (listener as any).lastPollTimestampMs = Date.now() - 150_000; // 2.5 min
    const info = listener.getStalenessInfo();
    expect(info.state).toBe("degraded");
  });

  it("returns stale when last poll was more than 5 minutes ago", () => {
    const listener = new SorobanListener(BASE_CFG, undefined as any, log);
    (listener as any).lastPollTimestampMs = Date.now() - 360_000; // 6 min
    const info = listener.getStalenessInfo();
    expect(info.state).toBe("stale");
  });

  it("exposes lastEventAgeSeconds as -1 when no HTLC event was ever observed", () => {
    const listener = new SorobanListener(BASE_CFG, undefined as any, log);
    (listener as any).lastPollTimestampMs = Date.now();
    const info = listener.getStalenessInfo();
    expect(info.lastEventAgeSeconds).toBe(-1);
  });

  it("exposes a positive lastEventAgeSeconds after a HTLC event is applied", async () => {
    const { svc } = await makeServices();
    await announceOrder(svc);
    const listener = new SorobanListener(BASE_CFG, svc, log);
    (listener as any).lastPollTimestampMs = Date.now();

    const ev = { ...makeCreatedEvent(), ledger: 3000, txHash: "age_tx", id: "3000-1" };
    await (listener as any).processSorobanEvent(ev);

    const info = listener.getStalenessInfo();
    expect(info.lastEventAgeSeconds).toBeGreaterThanOrEqual(0);
    expect(info.lastEventAgeSeconds).toBeLessThan(5);
  });
});
