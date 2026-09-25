/**
 * Per-order ledger cursor validation, recovery, and edge-case tests (#476).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import pino from "pino";
import { openDatabase } from "../src/persistence/db.js";
import { OrdersRepository } from "../src/persistence/orders-repo.js";
import { OrderService } from "../src/services/order-service.js";
import {
  advanceCursor,
  computeIncrementalScanStart,
  isEventBehindOrderCursor,
  ETH_LOOKBACK_BLOCKS,
} from "../src/reconciliation/ledger-cursor.js";

const log = pino({ level: "silent" });

const VALID_ETH = "0x1111111111111111111111111111111111111111";
const VALID_STELLAR = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422";
const HASHLOCK = "0x" + "aa".repeat(32);

async function freshService() {
  const dir = mkdtempSync(resolve(tmpdir(), "wafflefinance-cursor-test-"));
  const db = await openDatabase(`file:${dir}/test.db`);
  const repo = new OrdersRepository(db);
  const orders = new OrderService(repo, log);
  return { orders, repo, db };
}

describe("ledger-cursor helpers", () => {
  it("isEventBehindOrderCursor returns true when position is at or below cursor", () => {
    expect(isEventBehindOrderCursor(100, 100)).toBe(true);
    expect(isEventBehindOrderCursor(100, 50)).toBe(true);
    expect(isEventBehindOrderCursor(100, 101)).toBe(false);
    expect(isEventBehindOrderCursor(null, 50)).toBe(false);
  });

  it("computeIncrementalScanStart uses chain cursor when gap is within lookback", () => {
    const result = computeIncrementalScanStart(19_900, 20_000, ETH_LOOKBACK_BLOCKS);
    expect(result.from).toBe(19_900);
    expect(result.gap).toBe(100);
    expect(result.usedLookbackFallback).toBe(false);
  });

  it("computeIncrementalScanStart falls back to lookback on first run", () => {
    const tip = 20_000;
    const result = computeIncrementalScanStart(0, tip, ETH_LOOKBACK_BLOCKS);
    expect(result.from).toBe(tip - ETH_LOOKBACK_BLOCKS);
    expect(result.usedLookbackFallback).toBe(true);
  });

  it("advanceCursor never regresses", () => {
    expect(advanceCursor(500, 400)).toBe(500);
    expect(advanceCursor(500, 600)).toBe(600);
    expect(advanceCursor(null, 100)).toBe(100);
  });
});

describe("OrdersRepository.advanceOrderLedgerCursor", () => {
  let orders: OrderService;
  let publicId: string;

  beforeEach(async () => {
    const ctx = await freshService();
    orders = ctx.orders;
    const order = await orders.announce({
      direction: "eth_to_xlm",
      hashlock: HASHLOCK,
      srcChain: "ethereum",
      srcAddress: VALID_ETH,
      srcAsset: "native",
      srcAmount: "1000000",
      srcSafetyDeposit: "1000",
      dstChain: "stellar",
      dstAddress: VALID_STELLAR,
      dstAsset: "native",
      dstAmount: "1000000",
    });
    publicId = order.publicId;
  });

  it("advances last_eth_block forward only", async () => {
    await orders.advanceOrderLedgerCursor(publicId, { lastEthBlock: 1000 });
    let row = await orders.get(publicId);
    expect(row?.lastEthBlock).toBe(1000);

    await orders.advanceOrderLedgerCursor(publicId, { lastEthBlock: 900 });
    row = await orders.get(publicId);
    expect(row?.lastEthBlock).toBe(1000);

    await orders.advanceOrderLedgerCursor(publicId, { lastEthBlock: 1200 });
    row = await orders.get(publicId);
    expect(row?.lastEthBlock).toBe(1200);
  });

  it("survives pause/resume — cursor persists across service instances", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "wafflefinance-cursor-resume-"));
    const dbUrl = `file:${dir}/test.db`;
    const db1 = await openDatabase(dbUrl);
    const svc1 = new OrderService(new OrdersRepository(db1), log);
    const order = await svc1.announce({
      direction: "eth_to_xlm",
      hashlock: "0x" + "bb".repeat(32),
      srcChain: "ethereum",
      srcAddress: VALID_ETH,
      srcAsset: "native",
      srcAmount: "1",
      srcSafetyDeposit: "1",
      dstChain: "stellar",
      dstAddress: VALID_STELLAR,
      dstAsset: "native",
      dstAmount: "1",
    });
    await svc1.advanceOrderLedgerCursor(order.publicId, { lastEthBlock: 42_000 });

    const db2 = await openDatabase(dbUrl);
    const svc2 = new OrderService(new OrdersRepository(db2), log);
    const resumed = await svc2.get(order.publicId);
    expect(resumed?.lastEthBlock).toBe(42_000);
  });

  it("handles concurrent advance attempts without regression", async () => {
    await Promise.all([
      orders.advanceOrderLedgerCursor(publicId, { lastEthBlock: 500 }),
      orders.advanceOrderLedgerCursor(publicId, { lastEthBlock: 600 }),
      orders.advanceOrderLedgerCursor(publicId, { lastEthBlock: 550 }),
    ]);
    const row = await orders.get(publicId);
    expect(row?.lastEthBlock).toBe(600);
  });

  it("simulates reorg safety — lower block after higher block does not rewind cursor", async () => {
    await orders.advanceOrderLedgerCursor(publicId, { lastEthBlock: 10_000 });
    await orders.advanceOrderLedgerCursor(publicId, { lastEthBlock: 9_999 });
    const row = await orders.get(publicId);
    expect(row?.lastEthBlock).toBe(10_000);
  });

  it("getReconciliationCursorState returns chain and order cursors", async () => {
    await orders.setChainCursor("ethereum", 99_000);
    await orders.advanceOrderLedgerCursor(publicId, {
      lastEthBlock: 5000,
      lastSorobanLedger: 8000,
    });

    const state = await orders.getReconciliationCursorState();
    expect(state.chainCursors.find((c) => c.chain === "ethereum")?.position).toBe(99_000);
    expect(state.orderCursors.some((o) => o.publicId === publicId)).toBe(true);
    const oc = state.orderCursors.find((o) => o.publicId === publicId)!;
    expect(oc.lastEthBlock).toBe(5000);
    expect(oc.lastSorobanLedger).toBe(8000);
  });
});

describe("migration 011 — order ledger cursor columns", () => {
  it("orders table includes per-order cursor columns", async () => {
    const { db } = await freshService();
    const cols = (db as any)
      .prepare("PRAGMA table_info(orders)")
      .all()
      .map((c: any) => c.name);
    expect(cols).toContain("last_eth_block");
    expect(cols).toContain("last_soroban_ledger");
    expect(cols).toContain("last_solana_slot");
  });
});
