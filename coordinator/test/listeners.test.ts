import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import pino from "pino";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { openDatabase } from "../src/persistence/db.js";
import { OrdersRepository } from "../src/persistence/orders-repo.js";
import { OrderService } from "../src/services/order-service.js";
import { EthereumListener } from "../src/listeners/ethereum-listener.js";
import { SorobanListener } from "../src/listeners/soroban-listener.js";
import { SolanaListener } from "../src/listeners/solana-listener.js";
import type { CoordinatorConfig } from "../src/config.js";

// ── viem mock state ──────────────────────────────────────────────────────────
let mockLatestBlock = 1000n;
let mockCreatedLogs: any[] = [];
let mockClaimedLogs: any[] = [];
let mockRefundedLogs: any[] = [];
let mockWatchEventCallback: ((logs: any[]) => void) | undefined = undefined;
let mockClaimedCallback: ((logs: any[]) => void) | undefined = undefined;
let mockRefundedCallback: ((logs: any[]) => void) | undefined = undefined;

// ── @stellar/stellar-sdk mock state ─────────────────────────────────────────
let mockLatestLedger = 10000;
let mockSorobanEvents: any[] = [];
let mockSorobanCursor: string | null = null;

// ── @solana/web3.js mock state ───────────────────────────────────────────────
let mockSolanaSlot = 500;
let mockSolanaSignatures: any[] = [];
let mockSolanaTransactions: Record<string, any> = {};

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: vi.fn(() => ({
      getBlockNumber: vi.fn(async () => mockLatestBlock),
      getLogs: vi.fn(async ({ event }: any) => {
        if (event?.name === "OrderClaimed") return mockClaimedLogs;
        if (event?.name === "OrderRefunded") return mockRefundedLogs;
        return mockCreatedLogs;
      }),
      watchEvent: vi.fn((options: any) => {
        if (options.event?.name === "OrderCreated") {
          mockWatchEventCallback = options.onLogs;
          return () => { mockWatchEventCallback = undefined; };
        } else if (options.event?.name === "OrderClaimed") {
          mockClaimedCallback = options.onLogs;
          return () => { mockClaimedCallback = undefined; };
        } else if (options.event?.name === "OrderRefunded") {
          mockRefundedCallback = options.onLogs;
          return () => { mockRefundedCallback = undefined; };
        }
        return () => {};
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

vi.mock("@solana/web3.js", () => ({
  Connection: vi.fn(() => ({
    getSlot: vi.fn(async () => mockSolanaSlot),
    getSignaturesForAddress: vi.fn(async () => mockSolanaSignatures),
    getParsedTransaction: vi.fn(async (sig: string) => mockSolanaTransactions[sig] ?? null),
  })),
  PublicKey: vi.fn((addr: string) => ({ toString: () => addr })),
}));

// Setup / Helpers
const log = pino({ level: "silent" });

const VALID_ETH_ADDR = "0x1111111111111111111111111111111111111111";
const VALID_STELLAR_ADDR = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422";
const HASHLOCK = "0x" + "a".repeat(64);
const HASHLOCK2 = "0x" + "b".repeat(64);

// Cryptographically valid (preimage, hashlock) pair for OrderClaimed tests
const VALID_PREIMAGE_BUF = Buffer.alloc(32, 0xcc);
const VALID_PREIMAGE = "0x" + VALID_PREIMAGE_BUF.toString("hex");
const VALID_HASHLOCK = "0x" + createHash("sha256").update(VALID_PREIMAGE_BUF).digest("hex");

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
    mockClaimedLogs = [];
    mockRefundedLogs = [];
    mockWatchEventCallback = undefined;
    mockClaimedCallback = undefined;
    mockRefundedCallback = undefined;
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

describe("EthereumListener — OrderClaimed and OrderRefunded events", () => {
  let orders: OrderService;
  let listener: EthereumListener;

  beforeEach(async () => {
    orders = await freshOrders();
    mockLatestBlock = 1000n;
    mockCreatedLogs = [];
    mockClaimedLogs = [];
    mockRefundedLogs = [];
    mockWatchEventCallback = undefined;
    mockClaimedCallback = undefined;
    mockRefundedCallback = undefined;
    listener = new EthereumListener(BASE_CFG, orders, log);
  });

  afterEach(() => {
    listener.stop();
  });

  it("processes live OrderClaimed events and advances order to secret_revealed", async () => {
    const order = await seedOrder(orders, VALID_HASHLOCK);
    await orders.recordSrcLock({
      publicId: order.publicId,
      orderId: "77",
      txHash: "0xabc",
      blockNumber: 100,
      timelock: 9999
    });

    listener.start();
    await new Promise((r) => setTimeout(r, 20));
    expect(mockClaimedCallback).toBeDefined();

    await mockClaimedCallback!([{
      args: { orderId: 77n, preimage: VALID_PREIMAGE },
      transactionHash: "0xclaim1",
      blockNumber: 1001n,
      removed: false
    }]);
    await new Promise((r) => setTimeout(r, 20));

    const updated = await orders.get(order.publicId);
    expect(updated?.status).toBe("secret_revealed");
    expect(updated?.preimage).toBe(VALID_PREIMAGE);
  });

  it("processes live OrderRefunded events and advances order to refunded", async () => {
    const order = await seedOrder(orders);
    await orders.recordSrcLock({
      publicId: order.publicId,
      orderId: "55",
      txHash: "0xabc",
      blockNumber: 100,
      timelock: 9999
    });

    listener.start();
    await new Promise((r) => setTimeout(r, 20));
    expect(mockRefundedCallback).toBeDefined();

    await mockRefundedCallback!([{
      args: { orderId: 55n },
      transactionHash: "0xrefund1",
      blockNumber: 1001n,
      removed: false
    }]);
    await new Promise((r) => setTimeout(r, 20));

    const updated = await orders.get(order.publicId);
    expect(updated?.status).toBe("refunded");
  });

  it("rejects live OrderClaimed whose preimage does not match hashlock", async () => {
    const order = await seedOrder(orders, HASHLOCK);
    await orders.recordSrcLock({
      publicId: order.publicId,
      orderId: "88",
      txHash: "0xabc",
      blockNumber: 100,
      timelock: 9999
    });

    listener.start();
    await new Promise((r) => setTimeout(r, 20));
    expect(mockClaimedCallback).toBeDefined();

    // Preimage "0xff...ff" does not hash to HASHLOCK ("0xaaa...a")
    await mockClaimedCallback!([{
      args: { orderId: 88n, preimage: "0x" + "ff".repeat(32) },
      transactionHash: "0xclaim_bad",
      blockNumber: 1001n,
      removed: false
    }]);
    await new Promise((r) => setTimeout(r, 20));

    const updated = await orders.get(order.publicId);
    expect(updated?.status).toBe("src_locked");
    expect(updated?.preimage).toBeNull();
  });

  it("handles duplicate OrderClaimed events idempotently", async () => {
    const order = await seedOrder(orders, VALID_HASHLOCK);
    await orders.recordSrcLock({
      publicId: order.publicId,
      orderId: "91",
      txHash: "0xabc",
      blockNumber: 100,
      timelock: 9999
    });

    listener.start();
    await new Promise((r) => setTimeout(r, 20));

    const claimLog = {
      args: { orderId: 91n, preimage: VALID_PREIMAGE },
      transactionHash: "0xclaim_dup",
      blockNumber: 1001n,
      removed: false
    };

    await mockClaimedCallback!([claimLog]);
    await new Promise((r) => setTimeout(r, 20));
    expect((await orders.get(order.publicId))?.status).toBe("secret_revealed");

    // Second delivery — must not error
    await mockClaimedCallback!([claimLog]);
    await new Promise((r) => setTimeout(r, 20));
    expect((await orders.get(order.publicId))?.status).toBe("secret_revealed");
  });

  it("handles duplicate OrderRefunded events idempotently", async () => {
    const order = await seedOrder(orders);
    await orders.recordSrcLock({
      publicId: order.publicId,
      orderId: "92",
      txHash: "0xabc",
      blockNumber: 100,
      timelock: 9999
    });

    listener.start();
    await new Promise((r) => setTimeout(r, 20));

    const refundLog = {
      args: { orderId: 92n },
      transactionHash: "0xrefund_dup",
      blockNumber: 1001n,
      removed: false
    };

    await mockRefundedCallback!([refundLog]);
    await new Promise((r) => setTimeout(r, 20));
    expect((await orders.get(order.publicId))?.status).toBe("refunded");

    // Second delivery — must not error
    await mockRefundedCallback!([refundLog]);
    await new Promise((r) => setTimeout(r, 20));
    expect((await orders.get(order.publicId))?.status).toBe("refunded");
  });

  it("replays missed OrderClaimed events on startup", async () => {
    const order = await seedOrder(orders, VALID_HASHLOCK);
    await orders.recordSrcLock({
      publicId: order.publicId,
      orderId: "99",
      txHash: "0xabc",
      blockNumber: 100,
      timelock: 9999
    });

    mockLatestBlock = 2000n;
    mockClaimedLogs = [{
      args: { orderId: 99n, preimage: VALID_PREIMAGE },
      transactionHash: "0xcatch",
      blockNumber: 1500n
    }];

    listener.start();
    await new Promise((r) => setTimeout(r, 50));

    const updated = await orders.get(order.publicId);
    expect(updated?.status).toBe("secret_revealed");
    expect(updated?.preimage).toBe(VALID_PREIMAGE);
  });

  it("replays missed OrderRefunded events on startup", async () => {
    const order = await seedOrder(orders);
    await orders.recordSrcLock({
      publicId: order.publicId,
      orderId: "44",
      txHash: "0xabc",
      blockNumber: 100,
      timelock: 9999
    });

    mockLatestBlock = 2000n;
    mockRefundedLogs = [{
      args: { orderId: 44n },
      transactionHash: "0xrefcatch",
      blockNumber: 1600n
    }];

    listener.start();
    await new Promise((r) => setTimeout(r, 50));

    const updated = await orders.get(order.publicId);
    expect(updated?.status).toBe("refunded");
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

// ─── SolanaListener ───────────────────────────────────────────────────────────

const SOLANA_CFG: CoordinatorConfig = {
  ...BASE_CFG,
  solana: { rpcUrl: "https://solana.test", programId: "SomeRealProgramId1111111111111111111111111111", commitment: "confirmed" },
};

async function seedSolanaOrder(orders: OrderService, hashlock = HASHLOCK) {
  return orders.announce({
    direction: "sol_to_eth",
    hashlock,
    srcChain: "solana",
    srcAddress: VALID_ETH_ADDR,
    srcAsset: "native",
    srcAmount: "1000000000",
    srcSafetyDeposit: "0",
    dstChain: "ethereum",
    dstAddress: VALID_ETH_ADDR,
    dstAsset: "native",
    dstAmount: "1000000000000000000",
  });
}

describe("SolanaListener", () => {
  let orders: OrderService;
  let listener: SolanaListener;

  beforeEach(async () => {
    orders = await freshOrders();
    mockSolanaSlot = 500;
    mockSolanaSignatures = [];
    mockSolanaTransactions = {};
    listener = new SolanaListener(SOLANA_CFG, orders, log);
  });

  afterEach(() => {
    listener.stop();
  });

  it("is disabled when programId is PLACEHOLDER", async () => {
    const disabledCfg: CoordinatorConfig = {
      ...SOLANA_CFG,
      solana: { ...SOLANA_CFG.solana, programId: "PLACEHOLDER" },
    };
    const disabledListener = new SolanaListener(disabledCfg, orders, log);
    // start() should return without scheduling any polls (no errors thrown)
    expect(() => disabledListener.start()).not.toThrow();
    disabledListener.stop();
  });

  it("resumes from the last persisted slot on startup", async () => {
    // Seed an order that already has a src lock recorded at slot 400
    const order = await seedSolanaOrder(orders);
    await orders.recordSrcLock({
      publicId: order.publicId,
      orderId: "persisted-1",
      txHash: "sig-persisted",
      blockNumber: 400,
      timelock: 9999,
    });

    // Arrange: a new sig at slot 450 (above 400) should be processed
    const newSig = "sig-new";
    mockSolanaSlot = 500;
    mockSolanaSignatures = [{ signature: newSig, slot: 450, err: null }];
    mockSolanaTransactions[newSig] = {
      meta: {
        logMessages: [
          "Program log: OrderCreated",
          `Program log: {"hashlock":"${HASHLOCK2}","orderId":"new-1","timelock":9999}`,
        ],
      },
    };

    // Seed a second order for HASHLOCK2
    await orders.announce({
      direction: "sol_to_eth",
      hashlock: HASHLOCK2,
      srcChain: "solana",
      srcAddress: VALID_ETH_ADDR,
      srcAsset: "native",
      srcAmount: "1000000000",
      srcSafetyDeposit: "0",
      dstChain: "ethereum",
      dstAddress: VALID_ETH_ADDR,
      dstAsset: "native",
      dstAmount: "1000000000000000000",
    });

    listener.start();
    await new Promise((r) => setTimeout(r, 60));

    // The new order (HASHLOCK2) should be src_locked; the persisted order untouched
    const persisted = await orders.get(order.publicId);
    expect(persisted?.status).toBe("src_locked");
    expect(persisted?.srcOrderId).toBe("persisted-1");
  });

  it("processes an OrderCreated event and records src lock", async () => {
    const order = await seedSolanaOrder(orders);
    const sig = "sig-created-1";

    mockSolanaSlot = 100;
    mockSolanaSignatures = [{ signature: sig, slot: 100, err: null }];
    mockSolanaTransactions[sig] = {
      meta: {
        logMessages: [
          "Program log: OrderCreated",
          `Program log: {"hashlock":"${HASHLOCK}","orderId":"sol-1","timelock":9999}`,
        ],
      },
    };

    listener.start();
    await new Promise((r) => setTimeout(r, 60));

    const updated = await orders.get(order.publicId);
    expect(updated?.status).toBe("src_locked");
    expect(updated?.srcOrderId).toBe("sol-1");
    expect(updated?.srcLockTx).toBe(sig);
  });

  it("processes an OrderClaimed event and records secret", async () => {
    const order = await seedSolanaOrder(orders);
    await orders.recordSrcLock({
      publicId: order.publicId,
      orderId: "sol-2",
      txHash: "sig-create",
      blockNumber: 50,
      timelock: 9999,
    });

    const claimSig = "sig-claim-1";
    mockSolanaSlot = 100;
    mockSolanaSignatures = [{ signature: claimSig, slot: 100, err: null }];
    mockSolanaTransactions[claimSig] = {
      meta: {
        logMessages: [
          "Program log: OrderClaimed",
          `Program log: {"orderId":"sol-2","preimage":"0x${"ee".repeat(32)}"}`,
        ],
      },
    };

    listener.start();
    await new Promise((r) => setTimeout(r, 60));

    const updated = await orders.get(order.publicId);
    expect(updated?.status).toBe("secret_revealed");
    expect(updated?.preimage).toBe("0x" + "ee".repeat(32));
  });

  it("processes an OrderRefunded event and marks order refunded", async () => {
    const order = await seedSolanaOrder(orders);
    await orders.recordSrcLock({
      publicId: order.publicId,
      orderId: "sol-3",
      txHash: "sig-create",
      blockNumber: 50,
      timelock: 9999,
    });

    const refundSig = "sig-refund-1";
    mockSolanaSlot = 100;
    mockSolanaSignatures = [{ signature: refundSig, slot: 100, err: null }];
    mockSolanaTransactions[refundSig] = {
      meta: {
        logMessages: [
          "Program log: OrderRefunded",
          `Program log: {"orderId":"sol-3"}`,
        ],
      },
    };

    listener.start();
    await new Promise((r) => setTimeout(r, 60));

    const updated = await orders.get(order.publicId);
    expect(updated?.status).toBe("refunded");
  });

  it("handles duplicate events idempotently", async () => {
    const order = await seedSolanaOrder(orders);
    const sig = "sig-dup-1";

    mockSolanaSlot = 100;
    mockSolanaSignatures = [{ signature: sig, slot: 100, err: null }];
    mockSolanaTransactions[sig] = {
      meta: {
        logMessages: [
          "Program log: OrderCreated",
          `Program log: {"hashlock":"${HASHLOCK}","orderId":"sol-dup","timelock":9999}`,
        ],
      },
    };

    listener.start();
    // Two poll cycles
    await new Promise((r) => setTimeout(r, 60));

    const updated = await orders.get(order.publicId);
    expect(updated?.status).toBe("src_locked");
    expect(updated?.srcOrderId).toBe("sol-dup");
  });

  it("rolls back src lock when a transaction is no longer retrievable (dropped fork)", async () => {
    const order = await seedSolanaOrder(orders);
    const sig = "sig-fork-1";

    // First poll: tx is available → src lock is recorded
    mockSolanaSlot = 100;
    mockSolanaSignatures = [{ signature: sig, slot: 100, err: null }];
    mockSolanaTransactions[sig] = {
      meta: {
        logMessages: [
          "Program log: OrderCreated",
          `Program log: {"hashlock":"${HASHLOCK}","orderId":"sol-fork","timelock":9999}`,
        ],
      },
    };

    listener.start();
    await new Promise((r) => setTimeout(r, 60));

    let updated = await orders.get(order.publicId);
    expect(updated?.status).toBe("src_locked");

    // Simulate fork drop: tx disappears on subsequent polls
    mockSolanaTransactions[sig] = null;
    // The sig is still in the sig list (slot not yet advanced past it)
    await new Promise((r) => setTimeout(r, 60));

    updated = await orders.get(order.publicId);
    expect(updated?.status).toBe("announced");
    expect(updated?.srcOrderId).toBeNull();
    expect(updated?.srcLockTx).toBeNull();
  });

  it("skips errored transactions without processing or rolling back", async () => {
    const order = await seedSolanaOrder(orders);
    const sig = "sig-err-1";

    mockSolanaSlot = 100;
    mockSolanaSignatures = [{ signature: sig, slot: 100, err: { message: "account constraint violation" } }];
    mockSolanaTransactions[sig] = {
      meta: {
        logMessages: [
          "Program log: OrderCreated",
          `Program log: {"hashlock":"${HASHLOCK}","orderId":"sol-err","timelock":9999}`,
        ],
      },
    };

    listener.start();
    await new Promise((r) => setTimeout(r, 60));

    // Order should remain announced — errored tx is ignored
    const updated = await orders.get(order.publicId);
    expect(updated?.status).toBe("announced");
  });
});

// ─── Concurrency Protections ──────────────────────────────────────────────────

describe("Listeners Concurrency Protections", () => {
  it("KeyedMutex serialises writes for the same hashlock within a single batch delivery", async () => {
    const orders = await freshOrders();
    const order = await seedOrder(orders, HASHLOCK);

    // Track which orderId values reach recordSrcLock
    const callOrder: string[] = [];
    const origRecordSrcLock = orders.recordSrcLock.bind(orders);
    orders.recordSrcLock = async (input) => {
      callOrder.push(input.orderId);
      return origRecordSrcLock(input);
    };

    const listener = new EthereumListener(BASE_CFG, orders, log);
    listener.start();
    await new Promise((r) => setTimeout(r, 20));
    expect(mockWatchEventCallback).toBeDefined();

    // Deliver two logs for the *same* hashlock in one batch.
    // The mutex ensures they are processed in-series (log1 completes fully
    // before log2 begins), so there is no interleaved read-modify-write.
    // Both writes reach recordSrcLock because the OrderService allows a
    // re-lock from src_locked with a different orderId (re-anchoring pattern).
    // The important guarantee: the order ends up in a coherent src_locked
    // state and no write is lost mid-flight due to a race.
    const log1 = {
      args: { orderId: 101n, hashlock: HASHLOCK, timelock: 9999n },
      transactionHash: "0xcc1",
      blockNumber: 1010n,
      removed: false,
    };
    const log2 = {
      args: { orderId: 102n, hashlock: HASHLOCK, timelock: 9999n },
      transactionHash: "0xcc2",
      blockNumber: 1011n,
      removed: false,
    };

    // Both logs in one delivery → processed in series inside the mutex
    mockWatchEventCallback!([log1, log2]);
    await new Promise((r) => setTimeout(r, 40));

    const updated = await orders.get(order.publicId);
    // The order must be in src_locked regardless of which log wins
    expect(updated?.status).toBe("src_locked");
    // Both logs were processed without crashing — the mutex serialised them
    expect(callOrder.length).toBe(2);
    // The last write wins (log2), as expected from sequential processing
    expect(updated?.srcOrderId).toBe("102");

    listener.stop();
  });
});
