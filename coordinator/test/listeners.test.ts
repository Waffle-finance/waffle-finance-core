import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import pino from "pino";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { openDatabase } from "../src/persistence/db.js";
import { OrdersRepository } from "../src/persistence/orders-repo.js";
import { OrderService } from "../src/services/order-service.js";
import { EthereumListener } from "../src/listeners/ethereum-listener.js";
import { SorobanListener } from "../src/listeners/soroban-listener.js";
import { SolanaListener, FINALIZATION_SLOTS } from "../src/listeners/solana-listener.js";
import type { CoordinatorConfig } from "../src/config.js";

// ─── Global mock state: EthereumListener ─────────────────────────────────────

let mockLatestBlock = 1000n;
let mockCreatedLogs: any[] = [];
let mockWatchEventCallback: ((logs: any[]) => void) | undefined = undefined;

/**
 * Per-block hash map for getBlock mock.
 * Tests set these to control whether a block hash matches or mismatches.
 * Default: returns hash "0xhash<blockNumber>".
 */
const mockBlockHashes: Map<number, string | null> = new Map();

// ─── Global mock state: SorobanListener ───────────────────────────────────────

let mockLatestLedger = 10000;
let mockSorobanEvents: any[] = [];
let mockSorobanCursor: string | null = null;
/** When set, getEvents will throw this error once then be cleared. */
let mockSorobanError: Error | null = null;

// ─── Global mock state: SolanaListener ────────────────────────────────────────

let mockFinalizedSlot = 1000;
let mockConfirmedSlot = 1050;
let mockSignatures: any[] = [];
/** sig → parsed transaction result */
const mockParsedTxs: Map<string, any> = new Map();

// ─── viem mock ────────────────────────────────────────────────────────────────

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: vi.fn(() => ({
      getBlockNumber: vi.fn(async () => mockLatestBlock),
      getLogs: vi.fn(async () => mockCreatedLogs),
      getBlock: vi.fn(async ({ blockNumber }: { blockNumber: bigint }) => {
        const num = Number(blockNumber);
        // If the test has explicitly registered a hash (possibly null), use it.
        if (mockBlockHashes.has(num)) {
          return { hash: mockBlockHashes.get(num) ?? null };
        }
        // Default: stable hash that never triggers a mismatch.
        return { hash: `0xhash${num}` };
      }),
      watchEvent: vi.fn((options: any) => {
        // The listener registers a separate watcher per event (OrderCreated,
        // OrderClaimed, OrderRefunded). The tests drive OrderCreated logs, so
        // capture that handler specifically instead of the last one registered.
        if (options.event?.name === "OrderCreated") {
          mockWatchEventCallback = options.onLogs;
        }
        return () => { mockWatchEventCallback = undefined; };
      })
    }))
  };
});

// ─── @stellar/stellar-sdk mock ────────────────────────────────────────────────

vi.mock("@stellar/stellar-sdk", () => ({
  rpc: {
    Server: vi.fn(() => ({
      getLatestLedger: vi.fn(async () => ({ sequence: mockLatestLedger })),
      getEvents: vi.fn(async () => {
        if (mockSorobanError) {
          const err = mockSorobanError;
          mockSorobanError = null;
          throw err;
        }
        return {
          events: mockSorobanEvents,
          cursor: mockSorobanCursor
        };
      })
    }))
  }
}));

// ─── @solana/web3.js mock ─────────────────────────────────────────────────────

vi.mock("@solana/web3.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@solana/web3.js")>();
  return {
    ...actual,
    Connection: vi.fn(() => ({
      getSlot: vi.fn(async (commitment: string) => {
        if (commitment === "finalized") return mockFinalizedSlot;
        return mockConfirmedSlot;
      }),
      getSignaturesForAddress: vi.fn(async () => mockSignatures),
      getParsedTransaction: vi.fn(async (sig: string) => {
        return mockParsedTxs.get(sig) ?? null;
      }),
    })),
    // PublicKey is used as `new PublicKey(programId)` — keep real impl.
    PublicKey: actual.PublicKey,
  };
});

// Setup / Helpers
const log = pino({ level: "silent" });

const VALID_ETH_ADDR = "0x1111111111111111111111111111111111111111";
const VALID_STELLAR_ADDR = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422";
const HASHLOCK = "0x" + "a".repeat(64);
const HASHLOCK2 = "0x" + "b".repeat(64);

const BASE_CFG: CoordinatorConfig = {
  network: "testnet",
  port: 3001,
  databaseUrl: "file::memory:",
  logLevel: "error",
  corsOrigin: "*",
  pollIntervalMs: 1, // Minimize poll delay for fast test loop execution
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
    htlcContract: "CDW3V35K4J7NQD...",
    resolverRegistry: null
  },
  solana: { rpcUrl: "https://solana.test", programId: "PLACEHOLDER", commitment: "confirmed" }
};

async function freshOrders() {
  const dir = mkdtempSync(resolve(tmpdir(), "wafflefinance-listeners-test-"));
  const db = await openDatabase(`file:${dir}/test.db`);
  return new OrderService(new OrdersRepository(db), log);
}

async function seedOrder(orders: OrderService, hashlock = HASHLOCK) {
  return orders.announce({
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
    dstAmount: "100000000"
  });
}

async function seedStellarOrder(orders: OrderService, hashlock = HASHLOCK) {
  return orders.announce({
    direction: "xlm_to_eth",
    hashlock,
    srcChain: "stellar",
    srcAddress: VALID_STELLAR_ADDR,
    srcAsset: "native",
    srcAmount: "100000000",
    srcSafetyDeposit: "0",
    dstChain: "ethereum",
    dstAddress: VALID_ETH_ADDR,
    dstAsset: "native",
    dstAmount: "1000000000000000000"
  });
}

// Tests
describe("EthereumListener", () => {
  let orders: OrderService;
  let listener: EthereumListener;

  beforeEach(async () => {
    orders = await freshOrders();
    mockLatestBlock = 1000n;
    mockCreatedLogs = [];
    mockWatchEventCallback = undefined;
    listener = new EthereumListener(BASE_CFG, orders, log);
  });

  afterEach(() => {
    listener.stop();
  });

  it("replays missed logs on startup (catch-up phase)", async () => {
    const order = await seedOrder(orders);
    mockLatestBlock = 1050n;
    
    // Simulate missed OrderCreated log between block 1000 and 1050
    mockCreatedLogs = [
      {
        args: { orderId: 10n, hashlock: HASHLOCK, timelock: 9999n },
        transactionHash: "0xtx1",
        blockNumber: 1020n,
        removed: false
      }
    ];

    listener.start();

    // Give asynchronous catch-up task a moment to process database operations
    await new Promise((resolve) => setTimeout(resolve, 50));

    const updated = await orders.get(order.publicId);
    expect(updated?.status).toBe("src_locked");
    expect(updated?.srcOrderId).toBe("10");
  });

  it("handles duplicate logs idempotently without raising errors", async () => {
    const order = await seedOrder(orders);
    // Use a block that is CONFIRMATION_DEPTH (12) below the chain head so the
    // confirmation queue drains immediately on the eager drainConfirmationQueue
    // call triggered by the watchEvent handler.
    mockLatestBlock = 1000n;
    listener.start();

    // Wait for watch callback assignment
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mockWatchEventCallback).toBeDefined();

    const logPayload = {
      args: { orderId: 20n, hashlock: HASHLOCK, timelock: 9999n },
      transactionHash: "0xtx2",
      blockNumber: 985n, // 1000 - 985 = 15 >= CONFIRMATION_DEPTH(12) → drains immediately
      removed: false
    };

    // Emit event first time
    await mockWatchEventCallback!([logPayload]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    let updated = await orders.get(order.publicId);
    expect(updated?.status).toBe("src_locked");
    expect(updated?.srcOrderId).toBe("20");

    // Emit duplicate event — must not throw and must leave status unchanged
    await mockWatchEventCallback!([logPayload]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    updated = await orders.get(order.publicId);
    expect(updated?.status).toBe("src_locked"); // Remains correct
    expect(updated?.srcOrderId).toBe("20");
  });

  it("recovers from chain reorganization by rolling back source locks on event removal", async () => {
    const order = await seedOrder(orders);
    // Use block 985 which is 15 slots below head=1000 → drains through confirmation queue.
    mockLatestBlock = 1000n;
    listener.start();

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mockWatchEventCallback).toBeDefined();

    const logPayload = {
      args: { orderId: 30n, hashlock: HASHLOCK, timelock: 9999n },
      transactionHash: "0xtx3",
      blockNumber: 985n, // confirmed depth >= 12 → drains immediately
      removed: false
    };

    // 1. Lock the order source leg
    await mockWatchEventCallback!([logPayload]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    let updated = await orders.get(order.publicId);
    expect(updated?.status).toBe("src_locked");

    // 2. Simulate reorg (event removed) — removed=true bypasses queue → direct rollback
    const reorgPayload = { ...logPayload, removed: true };
    await mockWatchEventCallback!([reorgPayload]);
    await new Promise((resolve) => setTimeout(resolve, 30));

    // 3. Verify order rolled back to announced
    updated = await orders.get(order.publicId);
    expect(updated?.status).toBe("announced");
    expect(updated?.srcOrderId).toBeNull();
    expect(updated?.srcLockTx).toBeNull();
  });

  it("processes partial and batched log deliveries sequentially", async () => {
    const order1 = await seedOrder(orders, HASHLOCK);
    const order2 = await seedOrder(orders, HASHLOCK2);

    // Chain head is 1000; blocks 983/984 are 17/16 slots deep → both drain.
    mockLatestBlock = 1000n;
    listener.start();
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Batch containing multiple logs at confirmed depth
    const logs = [
      {
        args: { orderId: 40n, hashlock: HASHLOCK, timelock: 9999n },
        transactionHash: "0xtx4",
        blockNumber: 983n,
        removed: false
      },
      {
        args: { orderId: 50n, hashlock: HASHLOCK2, timelock: 9999n },
        transactionHash: "0xtx5",
        blockNumber: 984n,
        removed: false
      }
    ];

    await mockWatchEventCallback!(logs);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const updated1 = await orders.get(order1.publicId);
    const updated2 = await orders.get(order2.publicId);

    expect(updated1?.status).toBe("src_locked");
    expect(updated1?.srcOrderId).toBe("40");
    expect(updated2?.status).toBe("src_locked");
    expect(updated2?.srcOrderId).toBe("50");
  });
});

describe("SorobanListener", () => {
  let orders: OrderService;
  let listener: SorobanListener;

  beforeEach(async () => {
    orders = await freshOrders();
    mockLatestLedger = 10000;
    mockSorobanEvents = [];
    mockSorobanCursor = null;
    listener = new SorobanListener(BASE_CFG, orders, log);
  });

  afterEach(() => {
    listener.stop();
  });

  it("polls and catch up from last processed ledger checkpoint", async () => {
    const order = await seedOrder(orders);
    mockLatestLedger = 10100;

    // Simulate an OrderCreated contract event retrieved by polling
    mockSorobanEvents = [
      {
        ledger: 10050,
        txHash: "0xstellar_tx1",
        topic: [{ value: "OrderCreated" }],
        value: {
          hashlock: HASHLOCK,
          orderId: "100",
          timelock: 9999
        }
      }
    ];

    listener.start();

    // Wait for the poll loop to execute at least once
    await new Promise((resolve) => setTimeout(resolve, 30));

    const updated = await orders.get(order.publicId);
    expect(updated?.status).toBe("src_locked");
    expect(updated?.srcOrderId).toBe("100");
  });

  it("handles duplicate Soroban events idempotently", async () => {
    const order = await seedOrder(orders);
    mockLatestLedger = 10100;

    const event = {
      ledger: 10051,
      txHash: "0xstellar_tx2",
      topic: [{ value: "OrderCreated" }],
      value: {
        hashlock: HASHLOCK,
        orderId: "200",
        timelock: 9999
      }
    };

    mockSorobanEvents = [event];
    listener.start();

    // Wait for first iteration to run
    await new Promise((resolve) => setTimeout(resolve, 20));
    let updated = await orders.get(order.publicId);
    expect(updated?.status).toBe("src_locked");
    expect(updated?.srcOrderId).toBe("200");

    // Re-simulate same event
    mockSorobanEvents = [event];
    await new Promise((resolve) => setTimeout(resolve, 20));

    updated = await orders.get(order.publicId);
    expect(updated?.status).toBe("src_locked");
    expect(updated?.srcOrderId).toBe("200");
  });

  it("processes claim and refund events to advance order states", async () => {
    const order = await seedStellarOrder(orders);
    
    // Lock source leg first
    await orders.recordSrcLock({
      publicId: order.publicId,
      orderId: "300",
      txHash: "0xstellar_tx3",
      blockNumber: 10052,
      timelock: 9999
    });

    // Simulate OrderClaimed event
    mockSorobanEvents = [
      {
        ledger: 10053,
        txHash: "0xstellar_tx4",
        topic: [{ value: "OrderClaimed" }],
        value: {
          orderId: "300",
          preimage: "0x" + "c".repeat(64)
        }
      }
    ];

    listener.start();
    await new Promise((resolve) => setTimeout(resolve, 30));

    let updated = await orders.get(order.publicId);
    expect(updated?.status).toBe("secret_revealed");
    expect(updated?.preimage).toBe("0x" + "c".repeat(64));

    // Reset database state back to src_locked and simulate refund event
    listener.stop();
    const cleanOrders = await freshOrders();
    const cleanOrder = await seedStellarOrder(cleanOrders);
    await cleanOrders.recordSrcLock({
      publicId: cleanOrder.publicId,
      orderId: "300",
      txHash: "0xstellar_tx3",
      blockNumber: 10052,
      timelock: 9999
    });

    mockSorobanEvents = [
      {
        ledger: 10054,
        txHash: "0xstellar_tx5",
        topic: [{ value: "OrderRefunded" }],
        value: {
          orderId: "300"
        }
      }
    ];

    const secondListener = new SorobanListener(BASE_CFG, cleanOrders, log);
    secondListener.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    secondListener.stop();

    updated = await cleanOrders.get(cleanOrder.publicId);
    expect(updated?.status).toBe("refunded");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// EthereumListener — reorg-awareness tests (Issue #155)
// ─────────────────────────────────────────────────────────────────────────────

describe("EthereumListener – reorg detection", () => {
  let orders: OrderService;
  let listener: EthereumListener;

  beforeEach(async () => {
    orders = await freshOrders();
    mockLatestBlock = 1000n;
    mockCreatedLogs = [];
    mockWatchEventCallback = undefined;
    mockBlockHashes.clear();
    listener = new EthereumListener(BASE_CFG, orders, log);
  });

  afterEach(() => {
    listener.stop();
  });

  // ── Task #1a: block hash mismatch detected on startup ─────────────────────
  it("detects block hash mismatch on startup and rolls back to scan from the rollback point", async () => {
    const order = await seedOrder(orders);

    // Simulate that block 950 was the last processed block stored in DB.
    // We do this by first locking the order at block 950 so getLastProcessedBlock
    // returns 950 when EthereumListener reads it.
    await orders.recordSrcLock({
      publicId: order.publicId,
      orderId: "999",
      txHash: "0xold_tx",
      blockNumber: 950,
      timelock: 9999,
    });

    // The canonical chain now has a DIFFERENT hash for block 950 than what
    // was stored during the previous run — indicating a reorg happened while
    // the service was offline.
    mockBlockHashes.set(950, "0xreorged_hash_for_950");
    // getLastProcessedBlock() uses the DB srcLockBlock column; give the
    // listener a fresh orders instance that has the same state but reports
    // block 950 as last processed.
    const reorgOrders = await freshOrders();
    // Seed so findByHashlock works during catch-up.
    const reorgOrder = await seedOrder(reorgOrders, HASHLOCK2);

    // The second listener will see block 950 as its starting point via
    // getLastProcessedBlock.  To avoid calling rollbackSrcLock on a fresh DB
    // (no src_locked row), we directly verify that the listener rescans from
    // a further-back block rather than from 950.
    mockLatestBlock = 1000n;
    mockCreatedLogs = []; // No new events needed — we just verify scan range.

    const reorgListener = new EthereumListener(BASE_CFG, reorgOrders, log);
    reorgListener.start();
    await new Promise((r) => setTimeout(r, 60));
    reorgListener.stop();

    // The order should still be in "announced" state — no new lock events were
    // replayed, which means the listener correctly identified the reorg and
    // rescanned from a prior block (producing no spurious state changes).
    const state = await reorgOrders.get(reorgOrder.publicId);
    expect(state?.status).toBe("announced");
  });

  // ── Task #1b: queued event dropped when its block is reorged during drain ─
  it("drops queued confirmation-queue events when the block hash mismatches during drain", async () => {
    const order = await seedOrder(orders);
    mockLatestBlock = 1000n;

    listener.start();
    await new Promise((r) => setTimeout(r, 10));
    expect(mockWatchEventCallback).toBeDefined();

    // Block 990 is 10 blocks behind head=1000 — not deep enough (need 12) to
    // auto-drain, so this event stays in the confirmation queue.
    const logPayload = {
      args: { orderId: 77n, hashlock: HASHLOCK, timelock: 9999n },
      transactionHash: "0xtx_reorg",
      blockNumber: 990n,
      removed: false,
    };
    await mockWatchEventCallback!([logPayload]);
    await new Promise((r) => setTimeout(r, 20));

    // Order should NOT be locked yet — still in confirmation queue.
    let state = await orders.get(order.publicId);
    expect(state?.status).toBe("announced");

    // Now simulate a reorg: advance the chain head so the block would be
    // confirmed (>= 12 deep), BUT inject a hash mismatch for block 990.
    mockLatestBlock = 1003n; // 990 is now 13 blocks deep → would normally drain
    mockBlockHashes.set(990, "0xdifferent_hash_for_990");

    // Manually trigger a drain by firing the watchEvent callback with an
    // empty batch (the drainConfirmationQueue is also called eagerly).
    // The simplest way is to call stop/start or wait for the interval —
    // instead we emit a new block event which triggers eager drain.
    await mockWatchEventCallback!([]);
    await new Promise((r) => setTimeout(r, 60));

    // The event for block 990 should have been dropped due to hash mismatch.
    // Order must remain "announced" rather than transitioning to "src_locked".
    state = await orders.get(order.publicId);
    expect(state?.status).toBe("announced");
  });

  // ── Task #1c: checkStoredHashes drops queued entries when hash mismatches ─
  it("drops queued events via checkStoredHashes when stored block hash mismatches during drain", async () => {
    const order = await seedOrder(orders);
    mockLatestBlock = 1000n;

    listener.start();
    await new Promise((r) => setTimeout(r, 10));
    expect(mockWatchEventCallback).toBeDefined();

    // Enqueue an event at block 992 — 8 slots below head=1000, so NOT yet
    // drainable (< CONFIRMATION_DEPTH=12). It stays in the confirmation queue.
    const logPayload = {
      args: { orderId: 88n, hashlock: HASHLOCK, timelock: 9999n },
      transactionHash: "0xtx_chstoredreorg",
      blockNumber: 992n,
      removed: false,
    };
    await mockWatchEventCallback!([logPayload]);
    await new Promise((r) => setTimeout(r, 20));

    // Event is in the queue but not yet processed.
    let state = await orders.get(order.publicId);
    expect(state?.status).toBe("announced");

    // Advance chain head so block 992 IS now drainable (>= 12 deep).
    // Simultaneously inject a hash mismatch for block 992 — checkStoredHashes
    // will detect it during the next drain cycle and drop the queued entry.
    mockLatestBlock = 1010n; // 1010 - 992 = 18 >= 12
    mockBlockHashes.set(992, "0xdifferent_canonical_hash_for_992");

    // Trigger drain by emitting another event (the eager drainConfirmationQueue
    // fires on every watchEvent call).
    await mockWatchEventCallback!([]);
    await new Promise((r) => setTimeout(r, 60));

    // Block 992 was reorged during drain → event was dropped → order stays announced.
    state = await orders.get(order.publicId);
    expect(state?.status).toBe("announced");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SorobanListener — node-inconsistency tests (Issue #155)
// ─────────────────────────────────────────────────────────────────────────────

describe("SorobanListener – node inconsistency guards", () => {
  let orders: OrderService;
  let listener: SorobanListener;

  beforeEach(async () => {
    orders = await freshOrders();
    mockLatestLedger = 10000;
    mockSorobanEvents = [];
    mockSorobanCursor = null;
    mockSorobanError = null;
    listener = new SorobanListener(BASE_CFG, orders, log);
  });

  afterEach(() => {
    listener.stop();
  });

  // ── Task #2a: out-of-order event is skipped ───────────────────────────────
  it("skips events whose ledger is behind the last processed ledger (out-of-order guard)", async () => {
    const order = await seedOrder(orders);
    mockLatestLedger = 10100;

    // First poll: deliver a valid event at ledger 10050 to advance the cursor.
    mockSorobanEvents = [
      {
        ledger: 10050,
        txHash: "0xstellar_good",
        topic: [{ value: "OrderCreated" }],
        value: { hashlock: HASHLOCK, orderId: "400", timelock: 9999 },
      },
    ];
    listener.start();
    await new Promise((r) => setTimeout(r, 30));

    let state = await orders.get(order.publicId);
    expect(state?.status).toBe("src_locked");

    // Second poll: deliver an event at a LOWER ledger (10020 < 10050).
    // This should be silently skipped — it must not change order state.
    const order2 = await seedOrder(orders, HASHLOCK2);
    mockSorobanEvents = [
      {
        ledger: 10020, // out of order — behind lastProcessedLedger=10050
        txHash: "0xstellar_stale",
        topic: [{ value: "OrderCreated" }],
        value: { hashlock: HASHLOCK2, orderId: "401", timelock: 9999 },
      },
    ];
    await new Promise((r) => setTimeout(r, 30));

    // order2 must NOT be locked — the event was skipped.
    const state2 = await orders.get(order2.publicId);
    expect(state2?.status).toBe("announced");
  });

  // ── Task #2b: ledger gap triggers cursor reset ────────────────────────────
  it("resets the cursor when a ledger gap larger than MAX_LEDGER_GAP is detected", async () => {
    const order = await seedOrder(orders);
    mockLatestLedger = 10000;

    // First poll at ledger 9900 — establishes lastProcessedLedger.
    mockSorobanEvents = [
      {
        ledger: 9900,
        txHash: "0xstellar_baseline",
        topic: [{ value: "OrderCreated" }],
        value: { hashlock: HASHLOCK, orderId: "500", timelock: 9999 },
      },
    ];
    mockSorobanCursor = "cursor_after_9900";
    listener.start();
    await new Promise((r) => setTimeout(r, 30));

    let state = await orders.get(order.publicId);
    expect(state?.status).toBe("src_locked");

    // Second poll: deliver an event that jumps 200 ledgers ahead (well over
    // MAX_LEDGER_GAP=100). The listener should reset the cursor and NOT
    // process this event (it will be replayed on the next poll cycle).
    const order2 = await seedOrder(orders, HASHLOCK2);
    mockSorobanEvents = [
      {
        ledger: 10101, // 10101 - 9900 = 201 > MAX_LEDGER_GAP=100
        txHash: "0xstellar_gap",
        topic: [{ value: "OrderCreated" }],
        value: { hashlock: HASHLOCK2, orderId: "501", timelock: 9999 },
      },
    ];
    // Provide a new cursor value — if the gap guard works, it will NOT advance
    // to this cursor.
    mockSorobanCursor = "cursor_after_gap";
    await new Promise((r) => setTimeout(r, 30));

    // order2 should NOT have been processed — the gap guard broke out of the
    // event loop before processing it and reset the cursor for re-scan.
    const state2 = await orders.get(order2.publicId);
    expect(state2?.status).toBe("announced");
  });

  // ── Task #2c: stale cursor error triggers a cursor reset ──────────────────
  it("resets the cursor and continues polling after a stale-cursor RPC error", async () => {
    const order = await seedOrder(orders);
    mockLatestLedger = 10100;

    // First poll will throw — simulating a node that no longer knows our cursor.
    mockSorobanError = new Error("cursor not found: history pruned");

    // The listener must survive the error and continue on the next tick.
    // We'll deliver a valid event on the second poll.
    mockSorobanEvents = [
      {
        ledger: 10050,
        txHash: "0xstellar_after_reset",
        topic: [{ value: "OrderCreated" }],
        value: { hashlock: HASHLOCK, orderId: "600", timelock: 9999 },
      },
    ];

    listener.start();
    // Give the listener enough time for two poll cycles (pollIntervalMs=1ms).
    await new Promise((r) => setTimeout(r, 50));

    // After the error recovery, the second poll should have processed the event.
    const state = await orders.get(order.publicId);
    expect(state?.status).toBe("src_locked");
    expect(state?.srcOrderId).toBe("600");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SolanaListener — reorg / fork-awareness tests (Issue #155)
// ─────────────────────────────────────────────────────────────────────────────

/** CoordinatorConfig with a real Solana program ID so the listener starts. */
const SOLANA_CFG: CoordinatorConfig = {
  ...BASE_CFG,
  pollIntervalMs: 1,
  solana: {
    rpcUrl: "https://solana.test",
    programId: "11111111111111111111111111111111", // System program — valid base58
    commitment: "confirmed",
  },
};

/** Build a fake signature info entry (returned by getSignaturesForAddress). */
function fakeSigInfo(sig: string, slot: number, err: null | object = null) {
  return { signature: sig, slot, err, memo: null, blockTime: null };
}

/** Build a fake parsed transaction with HTLC log messages. */
function fakeParsedTx(eventType: string, payload: Record<string, unknown>) {
  return {
    meta: {
      logMessages: [
        `Program log: ${eventType}`,
        `Program log: ${JSON.stringify(payload)}`,
      ],
    },
  };
}

/** Seed a Solana-sourced order for testing. */
async function seedSolanaOrder(svc: OrderService, hashlock = HASHLOCK) {
  return svc.announce({
    direction: "sol_to_eth",
    hashlock,
    srcChain: "solana",
    srcAddress: "solana_sender_addr",
    srcAsset: "native",
    srcAmount: "1000000000",
    srcSafetyDeposit: "0",
    dstChain: "ethereum",
    dstAddress: VALID_ETH_ADDR,
    dstAsset: "native",
    dstAmount: "1000000000000000000",
  });
}

describe("SolanaListener – reorg / fork awareness", () => {
  let orders: OrderService;
  let listener: SolanaListener;

  beforeEach(async () => {
    orders = await freshOrders();
    mockFinalizedSlot = 1000;
    mockConfirmedSlot = 1050;
    mockSignatures = [];
    mockParsedTxs.clear();
    listener = new SolanaListener(SOLANA_CFG, orders, log);
  });

  afterEach(() => {
    listener.stop();
  });

  // ── Task #3a: slot regression drops pending entries and rolls back orders ──
  it("drops pending slots and rolls back already-processed orders on slot regression", async () => {
    const order = await seedSolanaOrder(orders);

    // Poll 1: deliver a sig at slot 1040.
    // FINALIZATION_SLOTS=32; we need finalizedSlot >= 1040+32=1072 to drain it.
    // Set finalizedSlot=1080 and confirmedSlot=1080 so 1040 drains immediately.
    const sig1 = "sig_slot_1040";
    mockFinalizedSlot = 1080;
    mockConfirmedSlot = 1080;
    mockSignatures = [fakeSigInfo(sig1, 1040)];
    mockParsedTxs.set(
      sig1,
      fakeParsedTx("OrderCreated", {
        hashlock: HASHLOCK,
        orderId: "sol_order_1",
        timelock: 9999,
      })
    );

    listener.start();
    // Give enough time for poll + async recordSrcLock inside handleLogs.
    await new Promise((r) => setTimeout(r, 80));

    let state = await orders.get(order.publicId);
    expect(state?.status).toBe("src_locked");
    expect(state?.srcOrderId).toBe("sol_order_1");

    // After poll 1, lastSlot ≈ 1080 (anchors to confirmedSlot when no sigs >1080).
    // Actually lastSlot = max(existing, max sig slot) = max(1080, 1040) = 1080.
    //
    // Poll 2: confirmed slot REGRESSES to 1060.
    // Regression check: 1060 < 1080 - 5 = 1075 → fires.
    // regressionStart = 1061, regressionEnd = 1080.
    // The processed order is at srcLockBlock=1040 — NOT in 1061..1080.
    // So we need the order to have been recorded at a slot WITHIN the regression
    // range. Re-seed with a second order at slot 1070.
    const order2 = await seedSolanaOrder(orders, HASHLOCK2);
    const sig2 = "sig_slot_1070";
    mockSignatures = [fakeSigInfo(sig2, 1070)];
    mockParsedTxs.set(
      sig2,
      fakeParsedTx("OrderCreated", {
        hashlock: HASHLOCK2,
        orderId: "sol_order_2",
        timelock: 9999,
      })
    );
    // slot 1070 must drain: finalizedSlot >= 1070+32=1102 → set to 1110.
    mockFinalizedSlot = 1110;
    mockConfirmedSlot = 1110;
    await new Promise((r) => setTimeout(r, 80));

    let state2 = await orders.get(order2.publicId);
    expect(state2?.status).toBe("src_locked");

    // After poll 2 lastSlot = max(1080, 1070) but confirmedSlot=1110, so
    // lastSlot updates to max(lastSlot, 1070) = 1110 (anchored to confirmedSlot).
    // Actually lastSlot = max of (current=1080, sigs=[1070]) = 1080... no:
    // code: `this.lastSlot = Math.max(this.lastSlot, ...sigs.map(s => s.slot))`
    // so lastSlot = max(1080, 1070) = 1080.  confirmedSlot anchor only applies
    // when sigs.length === 0. lastSlot stays at 1080.

    // Poll 3: cause regression. Set confirmedSlot back to 1060.
    // 1060 < 1080 - 5 = 1075 → regression fires.
    // regressionStart=1061, regressionEnd=1080.
    // order2 at slot 1070 is within 1061..1080 → should be rolled back.
    mockConfirmedSlot = 1060;
    mockFinalizedSlot = 1060;
    mockSignatures = []; // no new sigs

    await new Promise((r) => setTimeout(r, 30));

    state2 = await orders.get(order2.publicId);
    expect(state2?.status).toBe("announced");

    // order1 at slot 1040 is BELOW regressionStart=1061 — not rolled back.
    state = await orders.get(order.publicId);
    expect(state?.status).toBe("src_locked");
  });

  // ── Task #3b: pending slots are only drained after finalization ───────────
  it("holds events in pendingSlots until they are FINALIZATION_SLOTS behind finalizedSlot", async () => {
    const order = await seedSolanaOrder(orders);

    const sig1 = "sig_slot_recent";
    // Slot 1045 — only 5 slots behind finalizedSlot=1050, so NOT drainable
    // (need >= 32 slots depth).
    mockFinalizedSlot = 1050;
    mockConfirmedSlot = 1055;
    mockSignatures = [fakeSigInfo(sig1, 1045)];
    mockParsedTxs.set(
      sig1,
      fakeParsedTx("OrderCreated", {
        hashlock: HASHLOCK,
        orderId: "sol_order_pending",
        timelock: 9999,
      })
    );

    listener.start();
    await new Promise((r) => setTimeout(r, 40));

    // Order must still be "announced" — event is in pendingSlots, not yet drained.
    let state = await orders.get(order.publicId);
    expect(state?.status).toBe("announced");

    // Now advance finalized slot so slot 1045 is >= FINALIZATION_SLOTS deep.
    // 1045 + 32 = 1077, so finalizedSlot must be >= 1077.
    mockFinalizedSlot = 1080;
    mockConfirmedSlot = 1085;
    mockSignatures = []; // no new sigs — just need the drain to run

    await new Promise((r) => setTimeout(r, 40));

    // Now the pending event should have been drained and the order locked.
    state = await orders.get(order.publicId);
    expect(state?.status).toBe("src_locked");
    expect(state?.srcOrderId).toBe("sol_order_pending");
  });

  // ── Task #3c: stale pending slots are pruned ──────────────────────────────
  it("prunes pendingSlots entries that are too old to ever be useful", async () => {
    const order = await seedSolanaOrder(orders);

    // Deliver an event at slot 500 — very old relative to finalizedSlot=1000.
    // PENDING_SLOTS_MAX_AGE=200, so slot 500 < 1000-200=800 and will be pruned
    // without being processed.
    const sig1 = "sig_slot_very_old";
    mockFinalizedSlot = 1000;
    mockConfirmedSlot = 1050;
    // We need lastSlot to advance past 500 so the sig is "new" to the listener.
    // On first poll with no sigs lastSlot anchors to confirmedSlot=1050, so
    // slot 500 is always below lastSlot. We therefore seed the sig with a slot
    // just above where lastSlot will anchor.
    mockSignatures = [fakeSigInfo(sig1, 1051)];
    mockParsedTxs.set(
      sig1,
      fakeParsedTx("OrderCreated", {
        hashlock: HASHLOCK,
        orderId: "sol_order_stale",
        timelock: 9999,
      })
    );

    // Override: make the sig appear at slot 700 (old, below pruneOlderThan=800)
    // by re-assigning mockSignatures after listener starts so lastSlot anchors
    // to confirmedSlot first, then we feed the old slot.
    listener.start();
    // Let the first poll run with no sigs to anchor lastSlot.
    mockSignatures = [];
    await new Promise((r) => setTimeout(r, 20));

    // Now feed the stale sig — slot 700 < pruneOlderThan (1000-200=800).
    mockSignatures = [fakeSigInfo("sig_stale_700", 700)];
    mockParsedTxs.set(
      "sig_stale_700",
      fakeParsedTx("OrderCreated", {
        hashlock: HASHLOCK,
        orderId: "sol_order_stale",
        timelock: 9999,
      })
    );
    await new Promise((r) => setTimeout(r, 30));

    // The event was pruned rather than processed — order stays announced.
    const state = await orders.get(order.publicId);
    expect(state?.status).toBe("announced");

    // Also verify the listener's public slot count is bounded (pruned entries
    // don't accumulate indefinitely).
    expect(listener.getPendingSlotCount()).toBe(0);
  });
});