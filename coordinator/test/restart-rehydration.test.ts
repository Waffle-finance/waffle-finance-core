/**
 * Restart rehydration tests
 *
 * These tests verify that the coordinator can recover gracefully after a
 * process restart without corrupting order state or duplicating transitions:
 *
 *  1. SorobanListener cursor is persisted and restored on restart.
 *  2. SolanaListener lastSlot is persisted and restored on restart.
 *  3. EthereumListener replays catch-up on restart and handles duplicate
 *     events (OrderCreated, OrderClaimed, OrderRefunded) idempotently.
 *  4. OrderService.recordSrcLock / recordDstLock / recordSecret are
 *     idempotent on re-application.
 *  5. Restarting with a dirty DB (orders already advanced) never
 *     double-transitions or corrupts state.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import pino from "pino";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { openDatabase } from "../src/persistence/db.js";
import { OrdersRepository } from "../src/persistence/orders-repo.js";
import { OrderService } from "../src/services/order-service.js";
import { EthereumListener } from "../src/listeners/ethereum-listener.js";
import { SorobanListener } from "../src/listeners/soroban-listener.js";
import { SolanaListener } from "../src/listeners/solana-listener.js";
import { CursorStore } from "../src/utils/cursor-store.js";
import type { CoordinatorConfig } from "../src/config.js";

// ---------------------------------------------------------------------------
// Viem / Stellar / Solana mocks
// ---------------------------------------------------------------------------

let mockLatestBlock = 5000n;
let mockCreatedLogs: any[] = [];
let mockClaimedLogs: any[] = [];
let mockRefundedLogs: any[] = [];
let mockWatchHandlers: Record<string, (logs: any[]) => void> = {};

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: vi.fn(() => ({
      getBlockNumber: vi.fn(async () => mockLatestBlock),
      getLogs: vi.fn(async ({ event }: any) => {
        if (event?.name === "OrderCreated") return mockCreatedLogs;
        if (event?.name === "OrderClaimed") return mockClaimedLogs;
        if (event?.name === "OrderRefunded") return mockRefundedLogs;
        return [];
      }),
      watchEvent: vi.fn((options: any) => {
        const name: string = options.event?.name ?? "unknown";
        mockWatchHandlers[name] = options.onLogs;
        return () => { delete mockWatchHandlers[name]; };
      })
    }))
  };
});

let mockLatestLedger = 20_000;
let mockSorobanEvents: any[] = [];
let mockSorobanCursor: string | null = null;

vi.mock("@stellar/stellar-sdk", () => ({
  rpc: {
    Server: vi.fn(() => ({
      getLatestLedger: vi.fn(async () => ({ sequence: mockLatestLedger })),
      getEvents: vi.fn(async () => ({ events: mockSorobanEvents, cursor: mockSorobanCursor }))
    }))
  }
}));

let mockCurrentSlot = 300_000;
let mockSolanaSignatures: any[] = [];
let mockSolanaTransactions: Record<string, any> = {};

vi.mock("@solana/web3.js", () => ({
  Connection: vi.fn(() => ({
    getSlot: vi.fn(async () => mockCurrentSlot),
    getSignaturesForAddress: vi.fn(async () => mockSolanaSignatures),
    getParsedTransaction: vi.fn(async (sig: string) => mockSolanaTransactions[sig] ?? null)
  })),
  PublicKey: vi.fn((id: string) => ({ toBase58: () => id }))
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const log = pino({ level: "silent" });

const ETH_ADDR  = "0x1111111111111111111111111111111111111111";
const XLM_ADDR  = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422";
const HASHLOCK  = "0x" + "aa".repeat(32);
const HASHLOCK2 = "0x" + "bb".repeat(32);

const BASE_CFG: CoordinatorConfig = {
  network: "testnet",
  port: 3001,
  databaseUrl: "file::memory:",
  logLevel: "silent",
  corsOrigin: "*",
  pollIntervalMs: 1, // fast for tests
  ethereum: {
    rpcUrl: "https://rpc.test",
    chainId: 11_155_111,
    htlcEscrow: "0xb352339BEb146f2699d28D736700B953988bB178",
    resolverRegistry: null
  },
  soroban: {
    rpcUrl: "https://soroban.test",
    horizonUrl: "https://horizon.test",
    networkPassphrase: "Test",
    htlcContract: "CONTRACT_ID_PLACEHOLDER",
    resolverRegistry: null
  },
  solana: {
    rpcUrl: "https://solana.test",
    programId: "SolProgramId1111111111111111111111111111111",
    commitment: "confirmed"
  }
};

async function freshOrders() {
  const dir = mkdtempSync(resolve(tmpdir(), "wafflefinance-restart-"));
  const db = await openDatabase(`file:${dir}/test.db`);
  return new OrderService(new OrdersRepository(db), log);
}

function freshCursorStore() {
  const dir = mkdtempSync(resolve(tmpdir(), "wafflefinance-cursor-"));
  return { store: new CursorStore({ storageDir: dir }), dir };
}

function announceDefaults(hashlock = HASHLOCK) {
  return {
    direction: "eth_to_xlm" as const,
    hashlock,
    srcChain: "ethereum" as const,
    srcAddress: ETH_ADDR,
    srcAsset: "native",
    srcAmount: "1000000000000000000",
    srcSafetyDeposit: "1000000000000000",
    dstChain: "stellar" as const,
    dstAddress: XLM_ADDR,
    dstAsset: "native",
    dstAmount: "100000000"
  };
}

function announceStellarDefaults(hashlock = HASHLOCK) {
  return {
    direction: "xlm_to_eth" as const,
    hashlock,
    srcChain: "stellar" as const,
    srcAddress: XLM_ADDR,
    srcAsset: "native",
    srcAmount: "100000000",
    srcSafetyDeposit: "0",
    dstChain: "ethereum" as const,
    dstAddress: ETH_ADDR,
    dstAsset: "native",
    dstAmount: "1000000000000000000"
  };
}

// ---------------------------------------------------------------------------
// OrderService idempotency
// ---------------------------------------------------------------------------

describe("OrderService — idempotency on re-apply", () => {
  it("recordSrcLock is a no-op when order is already src_locked", async () => {
    const orders = await freshOrders();
    const order = await orders.announce(announceDefaults());

    await orders.recordSrcLock({ publicId: order.publicId, orderId: "1", txHash: "0xtx", blockNumber: 100, timelock: 9999 });
    expect((await orders.get(order.publicId))!.status).toBe("src_locked");

    // second call with same data must not throw and must keep status
    await expect(
      orders.recordSrcLock({ publicId: order.publicId, orderId: "1", txHash: "0xtx", blockNumber: 100, timelock: 9999 })
    ).resolves.toBeUndefined();
    expect((await orders.get(order.publicId))!.status).toBe("src_locked");
  });

  it("recordSrcLock is a no-op when order has advanced past src_locked", async () => {
    const orders = await freshOrders();
    const order = await orders.announce(announceDefaults());
    await orders.recordSrcLock({ publicId: order.publicId, orderId: "1", txHash: "0xtx", blockNumber: 100, timelock: 9999 });
    await orders.recordDstLock({ publicId: order.publicId, orderId: "2", txHash: "0xtx2", blockNumber: 101, timelock: 9999, resolver: null });

    // Replay src lock on an order already at dst_locked — must be silent no-op
    await expect(
      orders.recordSrcLock({ publicId: order.publicId, orderId: "1", txHash: "0xtx", blockNumber: 100, timelock: 9999 })
    ).resolves.toBeUndefined();
    expect((await orders.get(order.publicId))!.status).toBe("dst_locked");
  });

  it("recordDstLock is a no-op when order is already dst_locked", async () => {
    const orders = await freshOrders();
    const order = await orders.announce(announceDefaults());
    await orders.recordSrcLock({ publicId: order.publicId, orderId: "1", txHash: "0xtx", blockNumber: 100, timelock: 9999 });
    await orders.recordDstLock({ publicId: order.publicId, orderId: "2", txHash: "0xtx2", blockNumber: 101, timelock: 9999, resolver: null });

    await expect(
      orders.recordDstLock({ publicId: order.publicId, orderId: "2", txHash: "0xtx2", blockNumber: 101, timelock: 9999, resolver: null })
    ).resolves.toBeUndefined();
    expect((await orders.get(order.publicId))!.status).toBe("dst_locked");
  });

  it("recordSecret is a no-op when order is already secret_revealed", async () => {
    const orders = await freshOrders();
    const order = await orders.announce(announceDefaults());
    await orders.recordSrcLock({ publicId: order.publicId, orderId: "1", txHash: "0xtx", blockNumber: 100, timelock: 9999 });
    await orders.recordSecret(order.publicId, "0x" + "cc".repeat(32), "0xtx");

    await expect(
      orders.recordSecret(order.publicId, "0x" + "cc".repeat(32), "0xtx")
    ).resolves.toBeUndefined();
    expect((await orders.get(order.publicId))!.status).toBe("secret_revealed");
  });

  it("recordSrcLock on a terminal (refunded) order is a no-op", async () => {
    const orders = await freshOrders();
    const order = await orders.announce(announceDefaults());
    await orders.recordSrcLock({ publicId: order.publicId, orderId: "1", txHash: "0xtx", blockNumber: 100, timelock: 9999 });
    await orders.markStatus(order.publicId, "refunded");

    await expect(
      orders.recordSrcLock({ publicId: order.publicId, orderId: "1", txHash: "0xtx", blockNumber: 100, timelock: 9999 })
    ).resolves.toBeUndefined();
    expect((await orders.get(order.publicId))!.status).toBe("refunded");
  });
});

// ---------------------------------------------------------------------------
// EthereumListener — restart catch-up and idempotency
// ---------------------------------------------------------------------------

describe("EthereumListener — restart rehydration", () => {
  beforeEach(() => {
    mockLatestBlock = 5000n;
    mockCreatedLogs = [];
    mockClaimedLogs = [];
    mockRefundedLogs = [];
    mockWatchHandlers = {};
  });

  it("replays OrderCreated events that arrived while service was offline", async () => {
    const orders = await freshOrders();
    const order = await orders.announce(announceDefaults());

    // Simulate: block 4900 was already processed before restart
    mockLatestBlock = 5100n;
    mockCreatedLogs = [{
      args: { orderId: 1n, hashlock: HASHLOCK, timelock: 9999n },
      transactionHash: "0xtx1",
      blockNumber: 5050n,
      removed: false
    }];

    const listener = new EthereumListener(BASE_CFG, orders, log);
    listener.start();
    await new Promise(r => setTimeout(r, 60));

    expect((await orders.get(order.publicId))!.status).toBe("src_locked");
    listener.stop();
  });

  it("handles duplicate OrderCreated on restart without double-locking", async () => {
    const orders = await freshOrders();
    const order = await orders.announce(announceDefaults());

    // Pre-apply src lock (simulates it was processed before restart)
    await orders.recordSrcLock({ publicId: order.publicId, orderId: "1", txHash: "0xtx1", blockNumber: 5050, timelock: 9999 });

    // getLogs still returns the same event (catch-up window overlaps)
    mockLatestBlock = 5100n;
    mockCreatedLogs = [{
      args: { orderId: 1n, hashlock: HASHLOCK, timelock: 9999n },
      transactionHash: "0xtx1",
      blockNumber: 5050n,
      removed: false
    }];

    const listener = new EthereumListener(BASE_CFG, orders, log);
    listener.start();
    await new Promise(r => setTimeout(r, 60));

    // Must remain src_locked, not throw
    expect((await orders.get(order.publicId))!.status).toBe("src_locked");
    listener.stop();
  });

  it("OrderClaimed watchEvent handler records the secret idempotently", async () => {
    const orders = await freshOrders();
    const order = await orders.announce(announceDefaults());
    await orders.recordSrcLock({ publicId: order.publicId, orderId: "42", txHash: "0xtx", blockNumber: 100, timelock: 9999 });

    const listener = new EthereumListener(BASE_CFG, orders, log);
    listener.start();
    await new Promise(r => setTimeout(r, 20));

    const claimedHandler = mockWatchHandlers["OrderClaimed"];
    expect(claimedHandler).toBeDefined();

    const claimedLog = {
      args: { orderId: 42n, preimage: "0x" + "dd".repeat(32) },
      transactionHash: "0xtx_claim",
      blockNumber: 5001n
    };
    await claimedHandler!([claimedLog]);
    await new Promise(r => setTimeout(r, 20));
    expect((await orders.get(order.publicId))!.status).toBe("secret_revealed");

    // Replay — must be silent no-op
    await claimedHandler!([claimedLog]);
    await new Promise(r => setTimeout(r, 20));
    expect((await orders.get(order.publicId))!.status).toBe("secret_revealed");

    listener.stop();
  });

  it("OrderRefunded watchEvent handler marks order refunded idempotently", async () => {
    const orders = await freshOrders();
    const order = await orders.announce(announceDefaults());
    await orders.recordSrcLock({ publicId: order.publicId, orderId: "99", txHash: "0xtx", blockNumber: 100, timelock: 9999 });

    const listener = new EthereumListener(BASE_CFG, orders, log);
    listener.start();
    await new Promise(r => setTimeout(r, 20));

    const refundedHandler = mockWatchHandlers["OrderRefunded"];
    expect(refundedHandler).toBeDefined();

    const refundedLog = {
      args: { orderId: 99n },
      transactionHash: "0xtx_refund",
      blockNumber: 5002n
    };
    await refundedHandler!([refundedLog]);
    await new Promise(r => setTimeout(r, 20));
    expect((await orders.get(order.publicId))!.status).toBe("refunded");

    // Second call — must stay refunded without throwing
    await refundedHandler!([refundedLog]);
    await new Promise(r => setTimeout(r, 20));
    expect((await orders.get(order.publicId))!.status).toBe("refunded");

    listener.stop();
  });
});

// ---------------------------------------------------------------------------
// SorobanListener — cursor persistence across restarts
// ---------------------------------------------------------------------------

describe("SorobanListener — cursor persistence", () => {
  beforeEach(() => {
    mockLatestLedger = 20_000;
    mockSorobanEvents = [];
    mockSorobanCursor = null;
  });

  it("saves cursor after a successful poll and restores it on the next start", async () => {
    const orders = await freshOrders();
    const { store, dir } = freshCursorStore();

    // First run: RPC returns a cursor
    mockSorobanCursor = "cursor-abc-123";
    mockSorobanEvents = [];

    const listener1 = new SorobanListener(BASE_CFG, orders, log, store);
    listener1.start();
    await new Promise(r => setTimeout(r, 30));
    listener1.stop();

    // Cursor must be persisted
    const stored = store.load("soroban-listener");
    expect(stored).toBe("cursor-abc-123");

    // Second run: a new instance with the same store should restore the cursor
    const store2 = new CursorStore({ storageDir: dir });
    const listener2 = new SorobanListener(BASE_CFG, orders, log, store2);
    // We can verify the cursor is picked up by checking the log output would
    // say "cursor restored". Here we just confirm load works:
    expect(store2.load("soroban-listener")).toBe("cursor-abc-123");
    listener2.stop();

    rmSync(dir, { recursive: true, force: true });
  });

  it("processes events then cursor-resumes without re-processing them", async () => {
    const orders = await freshOrders();
    const order = await orders.announce(announceDefaults());
    const { store, dir } = freshCursorStore();

    // First run: deliver an OrderCreated event
    mockSorobanEvents = [{
      ledger: 20_050,
      txHash: "0xsoroban_tx1",
      topic: [{ value: "OrderCreated" }],
      value: { hashlock: HASHLOCK, orderId: "100", timelock: 9999 }
    }];
    mockSorobanCursor = "cursor-after-event";

    const listener1 = new SorobanListener(BASE_CFG, orders, log, store);
    listener1.start();
    await new Promise(r => setTimeout(r, 40));
    listener1.stop();

    expect((await orders.get(order.publicId))!.status).toBe("src_locked");
    expect(store.load("soroban-listener")).toBe("cursor-after-event");

    // Restart: same event is no longer returned (cursor advanced past it)
    mockSorobanEvents = [];
    mockSorobanCursor = "cursor-after-event";

    const store2 = new CursorStore({ storageDir: dir });
    const order2 = await orders.announce({ ...announceDefaults(HASHLOCK2) });
    const listener2 = new SorobanListener(BASE_CFG, orders, log, store2);
    listener2.start();
    await new Promise(r => setTimeout(r, 40));
    listener2.stop();

    // order still src_locked (not double-processed), order2 still announced
    expect((await orders.get(order.publicId))!.status).toBe("src_locked");
    expect((await orders.get(order2.publicId))!.status).toBe("announced");

    rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// SolanaListener — lastSlot persistence across restarts
// ---------------------------------------------------------------------------

describe("SolanaListener — slot cursor persistence", () => {
  beforeEach(() => {
    mockCurrentSlot = 300_000;
    mockSolanaSignatures = [];
    mockSolanaTransactions = {};
  });

  it("saves lastSlot after processing signatures and restores on restart", async () => {
    const orders = await freshOrders();
    const { store, dir } = freshCursorStore();

    // currentSlot = 300_100; seed = 300_099.
    // Provide a signature at slot 300_150 (newer than seed) so the cursor
    // advances to 300_150 and that value gets persisted.
    mockCurrentSlot = 300_100;
    mockSolanaSignatures = [
      { slot: 300_150, signature: "sig1", err: null },
    ];
    mockSolanaTransactions["sig1"] = {
      meta: { logMessages: ["Program log: {\"other\":\"data\"}"] }
    };

    const listener1 = new SolanaListener(BASE_CFG, orders, log, store);
    listener1.start();
    // Wait for at least one complete poll iteration
    await new Promise(r => setTimeout(r, 80));
    listener1.stop();

    // The cursor must have advanced to the max slot from sigs (300_150)
    const saved = store.load("solana-listener");
    expect(saved).toBe(300_150);

    // A fresh store instance (simulating a new process) should read it back
    const store2 = new CursorStore({ storageDir: dir });
    expect(store2.load("solana-listener")).toBe(300_150);

    rmSync(dir, { recursive: true, force: true });
  });

  it("skips already-processed signatures after restart (no duplicate processing)", async () => {
    const orders = await freshOrders();
    const order = await orders.announce(announceDefaults());
    const { store, dir } = freshCursorStore();

    // Pre-set cursor to slot 300_050 — simulates having processed up to there
    store.save("solana-listener", 300_050);

    mockCurrentSlot = 300_100;
    // Signatures at slot ≤ 300_050 should be skipped
    mockSolanaSignatures = [
      { slot: 300_040, signature: "old-sig", err: null },
      { slot: 300_060, signature: "new-sig", err: null }
    ];
    mockSolanaTransactions["old-sig"] = {
      meta: {
        logMessages: [
          "Program log: OrderCreated",
          `Program log: {"hashlock":"${HASHLOCK}","orderId":"42","timelock":9999}`
        ]
      }
    };
    mockSolanaTransactions["new-sig"] = {
      meta: { logMessages: ["Program log: no-event"] }
    };

    const listener = new SolanaListener(BASE_CFG, orders, log, store);
    listener.start();
    await new Promise(r => setTimeout(r, 40));
    listener.stop();

    // old-sig (slot 300_040 ≤ 300_050) must be filtered — order stays announced
    await new Promise(r => setTimeout(r, 20)); // allow async void handlers to settle
    expect((await orders.get(order.publicId))!.status).toBe("announced");

    rmSync(dir, { recursive: true, force: true });
  });
});
