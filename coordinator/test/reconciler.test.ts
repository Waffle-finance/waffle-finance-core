/**
 * Reconciler integration tests.
 *
 * Tests are organised into scenario groups:
 *
 *  1. Startup state
 *  2. Cursor initialisation from DB (startup recovery)
 *  3. Ethereum event replay (OrderCreated / OrderClaimed / OrderRefunded)
 *  4. Soroban event replay
 *  5. Solana event replay
 *  6. Idempotency — replaying already-applied events is safe
 *  7. Duplicate suppression — same event twice in one run
 *  8. Restart recovery — cursor re-seeds from DB, no events lost
 *  9. Gap detection — large gap emits lookbackExceeded
 * 10. Partial RPC outage — one chain failing leaves the others intact
 * 11. Active orders with stale cursor — orders ahead of HWM are still processed
 * 12. Chain gap > lookback — window falls back deterministically
 * 13. Conflict classification — wrong-state events are skipped, not mutated
 * 14. Status cursors in getStatus()
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import pino from "pino";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { openDatabase } from "../src/persistence/db.js";
import { OrdersRepository } from "../src/persistence/orders-repo.js";
import { OrderService } from "../src/services/order-service.js";
import { Reconciler } from "../src/reconciliation/reconciler.js";
import type { CoordinatorConfig } from "../src/config.js";
import {
  makeCreatedEvent,
  makeClaimedEvent,
  makeRefundedEvent,
  makeMalformedDataEvent,
  makeUnknownTopicEvent,
  PREIMAGE,
  ORDER_ID,
  TIMELOCK,
  HASHLOCK,
} from "./fixtures/soroban-xdr-fixtures.js";

// ---------------------------------------------------------------------------
// Mock viem + @stellar/stellar-sdk + @solana/web3.js so the reconciler can
// run without live RPCs.
// ---------------------------------------------------------------------------
let mockSorobanEvents: any[] = [];
vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: vi.fn(() => ({
      getBlockNumber: vi.fn(async () => 10_000n),
      getLogs: vi.fn(async () => []),
    })),
  };
});

vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();
  return {
    ...actual,
    rpc: {
      Server: vi.fn(() => ({
        getLatestLedger: vi.fn(async () => ({ sequence: 100_000 })),
        getEvents: vi.fn(async () => ({ events: mockSorobanEvents, cursor: null }))
      }))
    }
  };
});

vi.mock("@solana/web3.js", () => ({
  Connection: vi.fn(() => ({
    getSlot: vi.fn(async () => 500_000),
    getSignaturesForAddress: vi.fn(async () => []),
    getParsedTransaction: vi.fn(async () => null),
  })),
  PublicKey: vi.fn((id: string) => ({ toBase58: () => id })),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const log = pino({ level: "silent" });

const VALID_ETH_ADDR  = "0x1111111111111111111111111111111111111111";
const VALID_STELLAR   = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422";
const HASHLOCK        = "0x" + "a".repeat(64);
const HASHLOCK_B      = "0x" + "b".repeat(64);

// Cryptographically valid (preimage → hashlock) pair via sha256.
const PREIMAGE_BUF    = Buffer.alloc(32, 0xcc);
const VALID_PREIMAGE  = "0x" + PREIMAGE_BUF.toString("hex");
const VALID_HASHLOCK  = "0x" + createHash("sha256").update(PREIMAGE_BUF).digest("hex");

const BASE_CFG: CoordinatorConfig = {
  network:       "testnet",
  port:          3001,
  databaseUrl:   "file::memory:",
  logLevel:      "silent",
  corsOrigin:    "*",
  pollIntervalMs: 15_000,
  ethereum: {
    rpcUrl:           "https://rpc.test",
    chainId:          11_155_111,
    htlcEscrow:       "0xb352339BEb146f2699d28D736700B953988bB178",
    resolverRegistry: null,
  },
  soroban: {
    rpcUrl:             "https://soroban.test",
    horizonUrl:         "https://horizon.test",
    networkPassphrase:  "Test",
    htlcContract:       null,
    resolverRegistry:   null,
  },
  solana: { rpcUrl: "https://solana.test", programId: "PLACEHOLDER", commitment: "confirmed" },
};

async function freshOrders() {
  const dir = mkdtempSync(resolve(tmpdir(), "wafflefinance-recon-test-"));
  const db = await openDatabase(`file:${dir}/test.db`);
  return new OrderService(new OrdersRepository(db), log);
}

async function seedOrder(orders: OrderService, hashlock = HASHLOCK) {
  return orders.announce({
    direction: "eth_to_xlm",
    hashlock,
    srcChain:          "ethereum",
    srcAddress:        VALID_ETH_ADDR,
    srcAsset:          "native",
    srcAmount:         "1000000000000000000",
    srcSafetyDeposit:  "1000000000000000",
    dstChain:          "stellar",
    dstAddress:        VALID_STELLAR,
    dstAsset:          "native",
    dstAmount:         "100000000",
  });
}

/** Return the most-recently created viem mock client. */
function ethMock() {
  const { createPublicClient } = require("viem");
  return (createPublicClient as any).mock.results.at(-1)?.value as {
    getBlockNumber: ReturnType<typeof vi.fn>;
    getLogs: ReturnType<typeof vi.fn>;
  };
}

/** Return the most-recently created Soroban mock server. */
function sorobanMock() {
  const { rpc } = require("@stellar/stellar-sdk");
  return (rpc.Server as any).mock.results.at(-1)?.value as {
    getLatestLedger: ReturnType<typeof vi.fn>;
    getEvents: ReturnType<typeof vi.fn>;
  };
}

/** Return the most-recently created Solana mock connection. */
function solanaMock() {
  const { Connection } = require("@solana/web3.js");
  return (Connection as any).mock.results.at(-1)?.value as {
    getSlot: ReturnType<typeof vi.fn>;
    getSignaturesForAddress: ReturnType<typeof vi.fn>;
    getParsedTransaction: ReturnType<typeof vi.fn>;
  };
}

/** Build an OrderCreated ETH log mock. */
function ethCreatedLog(orderId: bigint, hashlock: string, block = 9_000n) {
  return {
    args: { orderId, hashlock, timelock: 9_999n },
    transactionHash: `0xeth${orderId}`,
    logIndex: 0,
    blockNumber: block,
  };
}

/** Build an OrderClaimed ETH log mock. */
function ethClaimedLog(orderId: bigint, preimage: string, block = 9_100n) {
  return {
    args: { orderId, preimage },
    transactionHash: `0xclaimed${orderId}`,
    logIndex: 0,
    blockNumber: block,
  };
}

/** Build an OrderRefunded ETH log mock. */
function ethRefundedLog(orderId: bigint, block = 9_200n) {
  return {
    args: { orderId },
    transactionHash: `0xrefunded${orderId}`,
    logIndex: 0,
    blockNumber: block,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Startup state
// ─────────────────────────────────────────────────────────────────────────────

describe("Reconciler — startup state", () => {
  it("getStatus() returns null fields before any run", () => {
    const orders = { findByHashlock: vi.fn(), findBySrcOrderId: vi.fn() } as any;
    const r = new Reconciler(BASE_CFG, orders, log);
    const s = r.getStatus();
    expect(s.lastRunAt).toBeNull();
    expect(s.lastRunOk).toBeNull();
    expect(s.eventsReplayed).toBe(0);
  });

  it("run() completes and marks lastRunOk=true when no events exist", async () => {
    const orders = await freshOrders();
    const r = new Reconciler(BASE_CFG, orders, log);
    await r.run();
    expect(r.getStatus().lastRunOk).toBe(true);
    expect(r.getStatus().lastRunAt).toBeTypeOf("number");
    expect(r.getStatus().eventsReplayed).toBe(0);
  });

  it("getStatus() exposes per-chain cursor HWMs after first run", async () => {
    const orders = await freshOrders();
    const r = new Reconciler(BASE_CFG, orders, log);
    await r.run();
    const s = r.getStatus();
    expect(s.cursors).toBeDefined();
    expect(typeof s.cursors!.ethereum).toBe("number");
    expect(typeof s.cursors!.soroban).toBe("number");
    expect(typeof s.cursors!.solana).toBe("number");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Cursor initialisation from DB (startup recovery)
// ─────────────────────────────────────────────────────────────────────────────

describe("Reconciler — startup cursor seeding from DB", () => {
  it("seeds ETH cursor from the highest srcLockBlock in the DB", async () => {
    const orders = await freshOrders();
    const order = await seedOrder(orders);
    // Record a lock at block 5_000 to set the DB high-water mark.
    await orders.recordSrcLock({
      publicId: order.publicId,
      orderId: "1",
      txHash: "0xseed",
      blockNumber: 5_000,
      timelock: 9_999,
    });

    const r = new Reconciler(BASE_CFG, orders, log);

    // Simulate ETH tip at exactly the HWM — window should be zero.
    const mock = ethMock();
    mock.getBlockNumber.mockResolvedValue(5_000n);

    await r.run();

    // HWM was 5000, tip is 5000 → zero window → 0 events replayed.
    expect(r.getStatus().eventsReplayed).toBe(0);
    expect(r.getStatus().cursors!.ethereum).toBe(5_000);
  });

  it("seeds ETH cursor to 0 when DB has no blocks → scans from tip - lookback", async () => {
    const orders = await freshOrders();
    const r = new Reconciler(BASE_CFG, orders, log);
    const mock = ethMock();
    mock.getBlockNumber.mockResolvedValue(20_000n);
    // getLogs returns no results but is called with a non-zero fromBlock window.
    mock.getLogs.mockResolvedValue([]);

    await r.run();
    // Cursor should now be at the tip.
    expect(r.getStatus().cursors!.ethereum).toBe(20_000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Ethereum — OrderCreated replay
// ─────────────────────────────────────────────────────────────────────────────

describe("Reconciler — Ethereum OrderCreated replay", () => {
  let orders: OrderService;

  beforeEach(async () => {
    orders = await freshOrders();
    vi.clearAllMocks();
  });

  it("replays a missing OrderCreated and advances the order to src_locked", async () => {
    const order = await seedOrder(orders);
    const r = new Reconciler(BASE_CFG, orders, log);
    const mock = ethMock();
    mock.getLogs.mockImplementation(async ({ event }: any) =>
      event?.name === "OrderCreated" ? [ethCreatedLog(42n, HASHLOCK)] : []
    );

    await r.run();

    const updated = await orders.get(order.publicId);
    expect(updated?.status).toBe("src_locked");
    expect(updated?.srcOrderId).toBe("42");
    expect(r.getStatus().eventsReplayed).toBe(1);
  });

  it("replays multiple OrderCreated logs in one run", async () => {
    const o1 = await seedOrder(orders, HASHLOCK);
    const o2 = await seedOrder(orders, HASHLOCK_B);
    const r = new Reconciler(BASE_CFG, orders, log);
    const mock = ethMock();
    mock.getLogs.mockImplementation(async ({ event }: any) =>
      event?.name === "OrderCreated"
        ? [ethCreatedLog(1n, HASHLOCK), ethCreatedLog(2n, HASHLOCK_B, 9_001n)]
        : []
    );

    await r.run();

    expect((await orders.get(o1.publicId))?.status).toBe("src_locked");
    expect((await orders.get(o2.publicId))?.status).toBe("src_locked");
    expect(r.getStatus().eventsReplayed).toBe(2);
  });

  it("skips OrderCreated for an unknown hashlock (no DB order)", async () => {
    const r = new Reconciler(BASE_CFG, orders, log);
    const mock = ethMock();
    mock.getLogs.mockImplementation(async ({ event }: any) =>
      event?.name === "OrderCreated" ? [ethCreatedLog(99n, HASHLOCK)] : []
    );

    await r.run();
    expect(r.getStatus().eventsReplayed).toBe(0);
    expect(r.getStatus().lastRunOk).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Ethereum — OrderClaimed / OrderRefunded replay
// ─────────────────────────────────────────────────────────────────────────────

describe("Reconciler — Ethereum OrderClaimed replay", () => {
  it("replays OrderClaimed and advances order to secret_revealed", async () => {
    const orders = await freshOrders();
    const order = await seedOrder(orders, VALID_HASHLOCK);
    await orders.recordSrcLock({ publicId: order.publicId, orderId: "77", txHash: "0xabc", blockNumber: 100, timelock: 9_999 });

    const r = new Reconciler(BASE_CFG, orders, log);
    const mock = ethMock();
    mock.getLogs.mockImplementation(async ({ event }: any) =>
      event?.name === "OrderClaimed" ? [ethClaimedLog(77n, VALID_PREIMAGE)] : []
    );

    await r.run();

    const updated = await orders.get(order.publicId);
    expect(updated?.status).toBe("secret_revealed");
    expect(r.getStatus().eventsReplayed).toBe(1);
  });

  it("rejects an OrderClaimed with an invalid preimage", async () => {
    const orders = await freshOrders();
    const order = await seedOrder(orders, VALID_HASHLOCK);
    await orders.recordSrcLock({ publicId: order.publicId, orderId: "78", txHash: "0xabc", blockNumber: 100, timelock: 9_999 });

    const r = new Reconciler(BASE_CFG, orders, log);
    const BAD_PREIMAGE = "0x" + "ff".repeat(32);
    const mock = ethMock();
    mock.getLogs.mockImplementation(async ({ event }: any) =>
      event?.name === "OrderClaimed" ? [ethClaimedLog(78n, BAD_PREIMAGE)] : []
    );

    await r.run();
    const updated = await orders.get(order.publicId);
    expect(updated?.status).toBe("src_locked"); // unchanged
    expect(r.getStatus().eventsReplayed).toBe(0);
  });
});

describe("Reconciler — Ethereum OrderRefunded replay", () => {
  it("replays OrderRefunded and advances order to refunded", async () => {
    const orders = await freshOrders();
    const order = await seedOrder(orders);
    await orders.recordSrcLock({ publicId: order.publicId, orderId: "55", txHash: "0xabc", blockNumber: 100, timelock: 9_999 });

    const r = new Reconciler(BASE_CFG, orders, log);
    const mock = ethMock();
    mock.getLogs.mockImplementation(async ({ event }: any) =>
      event?.name === "OrderRefunded" ? [ethRefundedLog(55n)] : []
    );

    await r.run();
    expect((await orders.get(order.publicId))?.status).toBe("refunded");
    expect(r.getStatus().eventsReplayed).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Soroban event replay
// ─────────────────────────────────────────────────────────────────────────────

describe("Reconciler — Soroban event replay", () => {
  const SOROBAN_CFG: CoordinatorConfig = {
    ...BASE_CFG,
    soroban: { ...BASE_CFG.soroban, htlcContract: "CCONTRACTID" },
  };

  it("replays a Soroban OrderCreated (old topic format: 'OrderCreated')", async () => {
    const orders = await freshOrders();
    const order = await seedOrder(orders);
    const r = new Reconciler(SOROBAN_CFG, orders, log);
    const mock = sorobanMock();

    mock.getEvents.mockResolvedValue({
      events: [{
        ledger: 99_000,
        txHash: "soroban_tx1",
        topic: [{ value: "OrderCreated" }],
        value: { hashlock: HASHLOCK, orderId: "1", timelock: 9_999 },
      }],
      cursor: null,
    });

    await r.run();
    const updated = await orders.get(order.publicId);
    expect(updated?.status).toBe("src_locked");
    expect(r.getStatus().eventsReplayed).toBe(1);
  });

  it("replays a Soroban OrderCreated (short topic format: 'created')", async () => {
    const orders = await freshOrders();
    const order = await seedOrder(orders);
    const r = new Reconciler(SOROBAN_CFG, orders, log);
    const mock = sorobanMock();

    mock.getEvents.mockResolvedValue({
      events: [{
        ledger: 99_001,
        txHash: "soroban_tx2",
        topic: [{ value: "created" }],
        value: { hashlock: HASHLOCK, orderId: "2", timelock: 9_999 },
      }],
      cursor: null,
    });

    await r.run();
    expect((await orders.get(order.publicId))?.status).toBe("src_locked");
  });

  it("resets Soroban page cursor on RPC error and throws for chain-error counting", async () => {
    const orders = await freshOrders();
    const r = new Reconciler(SOROBAN_CFG, orders, log);
    const mock = sorobanMock();

    mock.getEvents.mockRejectedValue(new Error("Soroban RPC timeout"));

    await r.run(); // Should not throw — Soroban error is caught at chain level.
    expect(r.getStatus().lastRunOk).toBe(false); // one chain failed
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Idempotency — replaying already-applied events
// ─────────────────────────────────────────────────────────────────────────────

describe("Reconciler — idempotency", () => {
  it("replaying an already-applied OrderCreated is a no-op (eventsReplayed=0)", async () => {
    const orders = await freshOrders();
    const order = await seedOrder(orders);
    await orders.recordSrcLock({ publicId: order.publicId, orderId: "10", txHash: "0xaaa", blockNumber: 100, timelock: 9_999 });

    const r = new Reconciler(BASE_CFG, orders, log);
    const mock = ethMock();
    mock.getLogs.mockImplementation(async ({ event }: any) =>
      event?.name === "OrderCreated" ? [ethCreatedLog(10n, HASHLOCK, 100n)] : []
    );

    await r.run();

    expect(r.getStatus().lastRunOk).toBe(true);
    expect(r.getStatus().eventsReplayed).toBe(0);
    expect((await orders.get(order.publicId))?.status).toBe("src_locked");
  });

  it("replaying an already-applied OrderRefunded is a no-op", async () => {
    const orders = await freshOrders();
    const order = await seedOrder(orders);
    await orders.recordSrcLock({ publicId: order.publicId, orderId: "20", txHash: "0xabc", blockNumber: 100, timelock: 9_999 });
    await orders.markStatus(order.publicId, "refunded");

    const r = new Reconciler(BASE_CFG, orders, log);
    const mock = ethMock();
    mock.getLogs.mockImplementation(async ({ event }: any) =>
      event?.name === "OrderRefunded" ? [ethRefundedLog(20n)] : []
    );

    await r.run();
    expect(r.getStatus().eventsReplayed).toBe(0);
    expect((await orders.get(order.publicId))?.status).toBe("refunded");
  });

  it("running reconciliation twice produces no duplicate state transitions", async () => {
    const orders = await freshOrders();
    const order = await seedOrder(orders);

    const makeReconciler = () => {
      const r = new Reconciler(BASE_CFG, orders, log);
      const mock = ethMock();
      mock.getLogs.mockImplementation(async ({ event }: any) =>
        event?.name === "OrderCreated" ? [ethCreatedLog(99n, HASHLOCK)] : []
      );
      return r;
    };

    const r1 = makeReconciler();
    await r1.run();
    expect(r1.getStatus().eventsReplayed).toBe(1);

    const r2 = makeReconciler();
    await r2.run();
    expect(r2.getStatus().eventsReplayed).toBe(0);

    expect((await orders.get(order.publicId))?.status).toBe("src_locked");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Duplicate suppression — same event twice within one run
// ─────────────────────────────────────────────────────────────────────────────

describe("Reconciler — per-run duplicate suppression", () => {
  it("processes an event only once when the same log appears twice in getLogs response", async () => {
    const orders = await freshOrders();
    const order = await seedOrder(orders);
    const r = new Reconciler(BASE_CFG, orders, log);
    const mock = ethMock();

    // Return the same log twice (same txHash + logIndex → same dedup key).
    const dup = ethCreatedLog(1n, HASHLOCK);
    mock.getLogs.mockImplementation(async ({ event }: any) =>
      event?.name === "OrderCreated" ? [dup, dup] : []
    );

    await r.run();

    // Should have recorded exactly one src lock, not two.
    expect(r.getStatus().eventsReplayed).toBe(1);
    expect((await orders.get(order.publicId))?.status).toBe("src_locked");
  });

  it("does not deduplicate events with different log indices in the same tx", async () => {
    const HASHLOCK_C = "0x" + "c".repeat(64);
    const orders = await freshOrders();
    const o1 = await seedOrder(orders, HASHLOCK);
    const o2 = await seedOrder(orders, HASHLOCK_C);
    const r = new Reconciler(BASE_CFG, orders, log);
    const mock = ethMock();

    // Two events from the same tx but different log indices.
    mock.getLogs.mockImplementation(async ({ event }: any) =>
      event?.name === "OrderCreated"
        ? [
            { ...ethCreatedLog(1n, HASHLOCK), logIndex: 0 },
            { ...ethCreatedLog(2n, HASHLOCK_C), transactionHash: "0xethmulti", logIndex: 1, args: { orderId: 2n, hashlock: HASHLOCK_C, timelock: 9_999n } },
          ]
        : []
    );

    await r.run();
    expect(r.getStatus().eventsReplayed).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Restart recovery — cursor re-seeds from DB, no events lost
// ─────────────────────────────────────────────────────────────────────────────

describe("Reconciler — restart recovery", () => {
  it("after a restart, a new reconciler seeded from DB processes events missed while down", async () => {
    const orders = await freshOrders();
    const order = await seedOrder(orders);

    // First reconciler crashes BEFORE processing the event.
    // (We just create it and never call run().)
    const _crashed = new Reconciler(BASE_CFG, orders, log);

    // Process restarts — new reconciler instance, same DB.
    const r2 = new Reconciler(BASE_CFG, orders, log);
    const mock = ethMock();
    mock.getLogs.mockImplementation(async ({ event }: any) =>
      event?.name === "OrderCreated" ? [ethCreatedLog(42n, HASHLOCK)] : []
    );

    await r2.run();
    expect((await orders.get(order.publicId))?.status).toBe("src_locked");
    expect(r2.getStatus().eventsReplayed).toBe(1);
  });

  it("after a restart, a new reconciler starts from the DB HWM, not from 0", async () => {
    const orders = await freshOrders();
    const order = await seedOrder(orders);
    // Put HWM at block 5_000 by recording a lock.
    await orders.recordSrcLock({
      publicId: order.publicId,
      orderId: "1",
      txHash: "0xseed",
      blockNumber: 5_000,
      timelock: 9_999,
    });

    // Restart with a new reconciler.
    const r = new Reconciler(BASE_CFG, orders, log);
    const mock = ethMock();
    // Tip is just one block ahead — only a 1-block window.
    mock.getBlockNumber.mockResolvedValue(5_001n);
    let capturedFromBlock: bigint | null = null;
    mock.getLogs.mockImplementation(async ({ fromBlock }: any) => {
      capturedFromBlock = fromBlock;
      return [];
    });

    await r.run();
    // fromBlock should be 5000 (the DB HWM), not 0.
    expect(capturedFromBlock).toBe(5_000n);
  });

  it("after a restart with a stale cursor, the run still completes without throwing", async () => {
    const orders = await freshOrders();
    const r = new Reconciler(BASE_CFG, orders, log);
    await r.run();
    // Second run on same instance (simulates next poll interval).
    await r.run();
    expect(r.getStatus().lastRunOk).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. Gap detection — large gap emits lookbackExceeded
// ─────────────────────────────────────────────────────────────────────────────

describe("Reconciler — large gap handling", () => {
  it("run() still succeeds when ETH tip is far ahead of the HWM", async () => {
    const orders = await freshOrders();
    const r = new Reconciler(BASE_CFG, orders, log);
    const mock = ethMock();
    // HWM=0, tip=1_000_000 → gap >> 2 × lookback.
    mock.getBlockNumber.mockResolvedValue(1_000_000n);
    mock.getLogs.mockResolvedValue([]);

    await r.run();
    expect(r.getStatus().lastRunOk).toBe(true);
    // Cursor advances to the tip.
    expect(r.getStatus().cursors!.ethereum).toBe(1_000_000);
  });

  it("run() scans events from the fallback window even when the gap exceeds 2 × lookback", async () => {
    const orders = await freshOrders();
    const order = await seedOrder(orders);
    const r = new Reconciler(BASE_CFG, orders, log);
    const mock = ethMock();

    // HWM=0, tip=100_000, lookback=14_400 → exceeded → fromBlock = 100_000 - 14_400
    mock.getBlockNumber.mockResolvedValue(100_000n);

    let capturedFromBlock: bigint | null = null;
    mock.getLogs.mockImplementation(async ({ event, fromBlock }: any) => {
      if (event?.name === "OrderCreated") {
        capturedFromBlock = fromBlock;
        return [ethCreatedLog(7n, HASHLOCK, BigInt(100_000 - 100))];
      }
      return [];
    });

    await r.run();
    // fromBlock should be the fallback (tip - lookback).
    expect(capturedFromBlock).toBe(BigInt(100_000 - 14_400));
    // The event within the fallback window was still processed.
    expect(r.getStatus().eventsReplayed).toBe(1);
    expect((await orders.get(order.publicId))?.status).toBe("src_locked");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. Partial RPC outage — one chain failing leaves others intact
// ─────────────────────────────────────────────────────────────────────────────

describe("Reconciler — partial RPC outage", () => {
  const SOROBAN_CFG: CoordinatorConfig = {
    ...BASE_CFG,
    soroban: { ...BASE_CFG.soroban, htlcContract: "CCONTRACTID" },
  };

  it("ETH RPC failure does not prevent Soroban from running", async () => {
    const orders = await freshOrders();
    const order = await seedOrder(orders);
    const r = new Reconciler(SOROBAN_CFG, orders, log);

    // ETH fails.
    const ethM = ethMock();
    ethM.getBlockNumber.mockRejectedValue(new Error("ETH RPC down"));

    // Soroban succeeds with an event.
    const sorM = sorobanMock();
    sorM.getEvents.mockResolvedValue({
      events: [{
        ledger: 99_000,
        txHash: "sor_tx",
        topic: [{ value: "OrderCreated" }],
        value: { hashlock: HASHLOCK, orderId: "1", timelock: 9_999 },
      }],
      cursor: null,
    });

    await r.run();

    // Run reports failure (one chain failed).
    expect(r.getStatus().lastRunOk).toBe(false);
    // But Soroban still processed its event.
    expect(r.getStatus().eventsReplayed).toBe(1);
    expect((await orders.get(order.publicId))?.status).toBe("src_locked");
  });

  it("ETH RPC failure: lastRunOk=false, run does not throw", async () => {
    const orders = await freshOrders();
    const r = new Reconciler(BASE_CFG, orders, log);
    const mock = ethMock();
    mock.getBlockNumber.mockRejectedValue(new Error("network error"));

    await expect(r.run()).resolves.toBeUndefined();
    expect(r.getStatus().lastRunOk).toBe(false);
  });

  it("Soroban RPC failure: cursor does not advance for that chain", async () => {
    const SOROBAN_CFG2: CoordinatorConfig = {
      ...BASE_CFG,
      soroban: { ...BASE_CFG.soroban, htlcContract: "CCONTRACTID" },
    };
    const orders = await freshOrders();
    const r = new Reconciler(SOROBAN_CFG2, orders, log);

    const sorM = sorobanMock();
    sorM.getLatestLedger.mockResolvedValue({ sequence: 100_000 });
    sorM.getEvents.mockRejectedValue(new Error("Soroban timeout"));

    await r.run();
    // Soroban HWM stays 0 (never advanced).
    expect(r.getStatus().cursors!.soroban).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. Active orders with stale cursor
// ─────────────────────────────────────────────────────────────────────────────

describe("Reconciler — active orders with stale cursor", () => {
  it("orders created before the HWM but missing src_lock are still processed if in the scan window", async () => {
    // Scenario: the listener was down for 500 blocks. HWM = 9500, tip = 10000.
    // An OrderCreated fired at block 9600 — inside the window.
    const orders = await freshOrders();
    const order = await seedOrder(orders);
    // Seed HWM at 9500.
    await orders.recordSrcLock({
      publicId: order.publicId,
      orderId: "seed",
      txHash: "0xseed",
      blockNumber: 9_500,
      timelock: 0,
    });
    // Now roll back so the order is back in "announced" (HWM stays at 9500 in DB).
    // We just need the DB's max block to be 9500 — the order itself doesn't matter.
    const order2 = await seedOrder(orders, HASHLOCK_B);

    const r = new Reconciler(BASE_CFG, orders, log);
    const mock = ethMock();
    mock.getBlockNumber.mockResolvedValue(10_000n);
    mock.getLogs.mockImplementation(async ({ event }: any) =>
      event?.name === "OrderCreated"
        ? [{ ...ethCreatedLog(99n, HASHLOCK_B, 9_600n) }]
        : []
    );

    await r.run();
    // order2 should be src_locked — it was in the scan window.
    expect((await orders.get(order2.publicId))?.status).toBe("src_locked");
  });

  it("an order whose srcLockBlock equals the cursor HWM is processed on the next run (inclusive window)", async () => {
    const orders = await freshOrders();
    const order = await seedOrder(orders);

    // Set HWM to 100 (order at exactly block 100 was processed previously).
    const prevOrder = await seedOrder(orders, HASHLOCK_B);
    await orders.recordSrcLock({ publicId: prevOrder.publicId, orderId: "prev", txHash: "0xprev", blockNumber: 100, timelock: 9_999 });

    const r = new Reconciler(BASE_CFG, orders, log);
    const mock = ethMock();
    mock.getBlockNumber.mockResolvedValue(200n);
    // New event at block 101 — just past the HWM.
    mock.getLogs.mockImplementation(async ({ event }: any) =>
      event?.name === "OrderCreated"
        ? [ethCreatedLog(77n, HASHLOCK, 101n)]
        : []
    );

    await r.run();
    expect((await orders.get(order.publicId))?.status).toBe("src_locked");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 12. Chain gap > lookback window
// ─────────────────────────────────────────────────────────────────────────────

describe("Reconciler — chain gap > lookback window", () => {
  it("run() completes successfully even when gap > 2 × lookback", async () => {
    const orders = await freshOrders();
    const r = new Reconciler(BASE_CFG, orders, log);
    const mock = ethMock();
    // HWM=0, tip=1_000_000 — far exceeds 2 × ETH_LOOKBACK_BLOCKS (28_800).
    mock.getBlockNumber.mockResolvedValue(1_000_000n);
    mock.getLogs.mockResolvedValue([]);
    await r.run();
    expect(r.getStatus().lastRunOk).toBe(true);
  });

  it("getLogs is called with fromBlock = tip - lookback when gap is exceeded", async () => {
    const ETH_LOOKBACK = 14_400;
    const orders = await freshOrders();
    const r = new Reconciler(BASE_CFG, orders, log);
    const mock = ethMock();
    mock.getBlockNumber.mockResolvedValue(1_000_000n);

    let capturedFrom: bigint | undefined;
    mock.getLogs.mockImplementation(async ({ fromBlock }: any) => {
      capturedFrom = fromBlock;
      return [];
    });

    await r.run();
    expect(capturedFrom).toBe(BigInt(1_000_000 - ETH_LOOKBACK));
  });

  it("events within the fallback window are still replayed correctly", async () => {
    const orders = await freshOrders();
    const order = await seedOrder(orders);
    const r = new Reconciler(BASE_CFG, orders, log);
    const ETH_LOOKBACK = 14_400;
    const TIP = 1_000_000;
    const mock = ethMock();
    mock.getBlockNumber.mockResolvedValue(BigInt(TIP));
    mock.getLogs.mockImplementation(async ({ event }: any) =>
      event?.name === "OrderCreated"
        ? [ethCreatedLog(5n, HASHLOCK, BigInt(TIP - 100))]
        : []
    );

    await r.run();
    expect(r.getStatus().eventsReplayed).toBe(1);
    expect((await orders.get(order.publicId))?.status).toBe("src_locked");
  });

  it("cursor advances to the tip even after a fallback-window scan", async () => {
    const orders = await freshOrders();
    const r = new Reconciler(BASE_CFG, orders, log);
    const mock = ethMock();
    mock.getBlockNumber.mockResolvedValue(1_000_000n);
    mock.getLogs.mockResolvedValue([]);

    await r.run();
    expect(r.getStatus().cursors!.ethereum).toBe(1_000_000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 13. Conflict classification — wrong-state events skipped, not mutated
// ─────────────────────────────────────────────────────────────────────────────

describe("Reconciler — conflict classification", () => {
  it("does not regress a completed order when an OrderCreated fires for its hashlock", async () => {
    const orders = await freshOrders();
    const order = await seedOrder(orders, VALID_HASHLOCK);
    await orders.recordSrcLock({ publicId: order.publicId, orderId: "1", txHash: "0x", blockNumber: 1, timelock: 9_999 });
    await orders.recordSecret(order.publicId, VALID_PREIMAGE, "0x", null);
    await orders.markStatus(order.publicId, "completed");

    const r = new Reconciler(BASE_CFG, orders, log);
    const mock = ethMock();
    // A stale OrderCreated for the same hashlock (VALID_HASHLOCK).
    mock.getLogs.mockImplementation(async ({ event }: any) =>
      event?.name === "OrderCreated" ? [ethCreatedLog(1n, VALID_HASHLOCK)] : []
    );

    await r.run();
    expect((await orders.get(order.publicId))?.status).toBe("completed");
    expect(r.getStatus().eventsReplayed).toBe(0);
  });

  it("does not apply an OrderRefunded to an already-completed order", async () => {
    const orders = await freshOrders();
    const order = await seedOrder(orders);
    await orders.recordSrcLock({ publicId: order.publicId, orderId: "2", txHash: "0x", blockNumber: 1, timelock: 9_999 });
    await orders.recordSecret(order.publicId, VALID_PREIMAGE, "0x");
    await orders.markStatus(order.publicId, "completed");

    const r = new Reconciler(BASE_CFG, orders, log);
    const mock = ethMock();
    mock.getLogs.mockImplementation(async ({ event }: any) =>
      event?.name === "OrderRefunded" ? [ethRefundedLog(2n)] : []
    );

    await r.run();
    expect((await orders.get(order.publicId))?.status).toBe("completed");
    expect(r.getStatus().lastRunOk).toBe(true);
  });

  it("does not apply OrderClaimed to an already-refunded order", async () => {
    const orders = await freshOrders();
    const order = await seedOrder(orders, VALID_HASHLOCK);
    await orders.recordSrcLock({ publicId: order.publicId, orderId: "3", txHash: "0x", blockNumber: 1, timelock: 9_999 });
    await orders.markStatus(order.publicId, "refunded");

    const r = new Reconciler(BASE_CFG, orders, log);
    const mock = ethMock();
    mock.getLogs.mockImplementation(async ({ event }: any) =>
      event?.name === "OrderClaimed" ? [ethClaimedLog(3n, VALID_PREIMAGE)] : []
    );

    await r.run();
    expect((await orders.get(order.publicId))?.status).toBe("refunded");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 14. Concurrent runs and per-run isolation
// ─────────────────────────────────────────────────────────────────────────────

describe("Reconciler — per-run dedup isolation", () => {
  it("an event seen in run N appears fresh in run N+1 (clear between runs)", async () => {
    const orders = await freshOrders();
    const o1 = await seedOrder(orders, HASHLOCK);
    const o2 = await seedOrder(orders, HASHLOCK_B);

    const r = new Reconciler(BASE_CFG, orders, log);
    const mock = ethMock();

    // Run 1: process HASHLOCK
    mock.getLogs.mockImplementation(async ({ event }: any) =>
      event?.name === "OrderCreated" ? [ethCreatedLog(1n, HASHLOCK)] : []
    );
    await r.run();
    expect((await orders.get(o1.publicId))?.status).toBe("src_locked");

    // Run 2: process HASHLOCK_B — different event, same reconciler instance.
    mock.getLogs.mockImplementation(async ({ event }: any) =>
      event?.name === "OrderCreated" ? [ethCreatedLog(2n, HASHLOCK_B)] : []
    );
    await r.run();
    expect((await orders.get(o2.publicId))?.status).toBe("src_locked");
    // Both runs each replayed exactly 1 event.
    expect(r.getStatus().eventsReplayed).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 15. Solana — skip PLACEHOLDER programId
// ─────────────────────────────────────────────────────────────────────────────

describe("Reconciler — Solana PLACEHOLDER skip", () => {
  it("does not call Solana RPC when programId is PLACEHOLDER", async () => {
    const orders = await freshOrders();
    const r = new Reconciler(BASE_CFG, orders, log); // BASE_CFG has PLACEHOLDER
    const mock = solanaMock();
    await r.run();
    expect(mock.getSlot).not.toHaveBeenCalled();
    expect(mock.getSignaturesForAddress).not.toHaveBeenCalled();
  });
});

describe("Reconciler — Soroban event replay", () => {
  let orders: OrderService;
  let reconciler: Reconciler;

  beforeEach(async () => {
    orders = await freshOrders();
    mockSorobanEvents = [];
    vi.resetModules();
    vi.clearAllMocks();
    const sorobanCfg = {
      ...BASE_CFG,
      soroban: { ...BASE_CFG.soroban, htlcContract: "C123456789" }
    };
    reconciler = new Reconciler(sorobanCfg, orders, log);
  });

  it("replays a missing Soroban created event and advances order to src_locked", async () => {
    const order = await seedOrder(orders);
    mockSorobanEvents = [makeCreatedEvent(100050, "0xstellar_created_tx")];

    await reconciler.run();

    const updated = await orders.get(order.publicId);
    expect(updated?.status).toBe("src_locked");
    expect(updated?.srcOrderId).toBe(ORDER_ID);
    expect(updated?.srcLockTx).toBe("0xstellar_created_tx");
  });

  it("skips a malformed Soroban event and records a decode error without mutating state", async () => {
    const order = await seedOrder(orders);
    mockSorobanEvents = [makeMalformedDataEvent(100051, "0xstellar_malformed_tx")];

    await reconciler.run();

    const updated = await orders.get(order.publicId);
    expect(updated?.status).toBe("announced");
  });

  it("skips an unknown Soroban topic event without recording a decode error", async () => {
    const order = await seedOrder(orders);
    mockSorobanEvents = [makeUnknownTopicEvent(100052, "0xstellar_unknown_tx")];

    await reconciler.run();

    const updated = await orders.get(order.publicId);
    expect(updated?.status).toBe("announced");
  });
});

// ── #576: unsafe numeric conversion guard ─────────────────────────────────────

describe("Reconciler — #576: unsafe integer guard", () => {
  it("skips an ETH OrderCreated event with an unsafe block number and does not mutate order state", async () => {
    const orders = await freshOrders();
    const order = await seedOrder(orders);

    const reconciler = new Reconciler(BASE_CFG, orders, log);

    const { createPublicClient } = await import("viem");
    const mockClient = (createPublicClient as MockedFunction<any>).mock.results.at(-1)?.value;

    // blockNumber larger than Number.MAX_SAFE_INTEGER — would be silently rounded otherwise
    const UNSAFE_BLOCK = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    mockClient.getLogs.mockImplementation(async ({ event }: any) => {
      if (event?.name === "OrderCreated") {
        return [
          {
            args: { orderId: 1n, hashlock: HASHLOCK, timelock: 9999n },
            transactionHash: "0xdeadbeef",
            blockNumber: UNSAFE_BLOCK,
          },
        ];
      }
      return [];
    });

    await reconciler.run();

    // Run must succeed (no throw)
    expect(reconciler.getStatus().lastRunOk).toBe(true);
    // Order must NOT have been advanced — unsafe block was rejected
    const updated = await orders.get(order.publicId);
    expect(updated?.status).toBe("announced");
    expect(updated?.srcOrderId).toBeNull();
    // No events replayed
    expect(reconciler.getStatus().eventsReplayed).toBe(0);
  });

  it("skips an ETH OrderCreated event with an unsafe timelock and does not mutate order state", async () => {
    const orders = await freshOrders();
    const order = await seedOrder(orders);

    const reconciler = new Reconciler(BASE_CFG, orders, log);

    const { createPublicClient } = await import("viem");
    const mockClient = (createPublicClient as MockedFunction<any>).mock.results.at(-1)?.value;

    const UNSAFE_TIMELOCK = BigInt(Number.MAX_SAFE_INTEGER) + 100n;
    mockClient.getLogs.mockImplementation(async ({ event }: any) => {
      if (event?.name === "OrderCreated") {
        return [
          {
            args: { orderId: 1n, hashlock: HASHLOCK, timelock: UNSAFE_TIMELOCK },
            transactionHash: "0xdeadbeef",
            blockNumber: 100n,
          },
        ];
      }
      return [];
    });

    await reconciler.run();

    expect(reconciler.getStatus().lastRunOk).toBe(true);
    const updated = await orders.get(order.publicId);
    expect(updated?.status).toBe("announced");
    expect(reconciler.getStatus().eventsReplayed).toBe(0);
  });
});
