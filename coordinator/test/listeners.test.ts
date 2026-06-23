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
import type { CoordinatorConfig } from "../src/config.js";

// Global mock states to control dynamically in tests
let mockLatestBlock = 1000n;
let mockCreatedLogs: any[] = [];
let mockWatchEventCallback: ((logs: any[]) => void) | undefined = undefined;

let mockLatestLedger = 10000;
let mockSorobanEvents: any[] = [];
let mockSorobanCursor: string | null = null;

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: vi.fn(() => ({
      getBlockNumber: vi.fn(async () => mockLatestBlock),
      getLogs: vi.fn(async () => mockCreatedLogs),
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

vi.mock("@stellar/stellar-sdk", () => ({
  rpc: {
    Server: vi.fn(() => ({
      getLatestLedger: vi.fn(async () => ({ sequence: mockLatestLedger })),
      getEvents: vi.fn(async () => ({
        events: mockSorobanEvents,
        cursor: mockSorobanCursor
      }))
    }))
  }
}));

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
    listener.start();

    // Wait for watch callback assignment
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mockWatchEventCallback).toBeDefined();

    const logPayload = {
      args: { orderId: 20n, hashlock: HASHLOCK, timelock: 9999n },
      transactionHash: "0xtx2",
      blockNumber: 1001n,
      removed: false
    };

    // Emit event first time
    await mockWatchEventCallback!([logPayload]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    let updated = await orders.get(order.publicId);
    expect(updated?.status).toBe("src_locked");
    expect(updated?.srcOrderId).toBe("20");

    // Emit duplicate event
    await mockWatchEventCallback!([logPayload]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    updated = await orders.get(order.publicId);
    expect(updated?.status).toBe("src_locked"); // Remains correct
    expect(updated?.srcOrderId).toBe("20");
  });

  it("recovers from chain reorganization by rolling back source locks on event removal", async () => {
    const order = await seedOrder(orders);
    listener.start();

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mockWatchEventCallback).toBeDefined();

    const logPayload = {
      args: { orderId: 30n, hashlock: HASHLOCK, timelock: 9999n },
      transactionHash: "0xtx3",
      blockNumber: 1002n,
      removed: false
    };

    // 1. Lock the order source leg
    await mockWatchEventCallback!([logPayload]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    let updated = await orders.get(order.publicId);
    expect(updated?.status).toBe("src_locked");

    // 2. Simulate reorg (event removed)
    const reorgPayload = { ...logPayload, removed: true };
    await mockWatchEventCallback!([reorgPayload]);
    await new Promise((resolve) => setTimeout(resolve, 20));

    // 3. Verify order rolled back to announced
    updated = await orders.get(order.publicId);
    expect(updated?.status).toBe("announced");
    expect(updated?.srcOrderId).toBeNull();
    expect(updated?.srcLockTx).toBeNull();
  });

  it("processes partial and batched log deliveries sequentially", async () => {
    const order1 = await seedOrder(orders, HASHLOCK);
    const order2 = await seedOrder(orders, HASHLOCK2);

    listener.start();
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Batch containing multiple logs
    const logs = [
      {
        args: { orderId: 40n, hashlock: HASHLOCK, timelock: 9999n },
        transactionHash: "0xtx4",
        blockNumber: 1003n,
        removed: false
      },
      {
        args: { orderId: 50n, hashlock: HASHLOCK2, timelock: 9999n },
        transactionHash: "0xtx5",
        blockNumber: 1004n,
        removed: false
      }
    ];

    await mockWatchEventCallback!(logs);
    await new Promise((resolve) => setTimeout(resolve, 20));

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
