/**
 * Reconciliation checkpoint atomicity.
 *
 * An Ethereum event is claimed in `processed_events` only after its order
 * mutation has been written. The chain cursor never moves to or past an event
 * whose apply failed. These tests simulate a failure or crash at each
 * persistence boundary and check that the event is either fully applied or
 * replayable, and that a replay never applies it twice.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import pino from "pino";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import type { Database } from "../src/persistence/db.js";
import { OrdersRepository } from "../src/persistence/orders-repo.js";
import { OrderService } from "../src/services/order-service.js";
import { Reconciler } from "../src/reconciliation/reconciler.js";
import { ethEventKey } from "../src/reconciliation/event-identity.js";
import type { CoordinatorConfig } from "../src/config.js";

// The reconciler's import graph reaches packages/sdk, which imports
// `@wormhole/config`. That package is not declared anywhere in the workspace,
// so the names sdk needs at load time are stubbed here. The checkpoint logic
// under test never calls into them.
// `kysely` is imported by the persistence layer (db.ts re-exports kysely-db.ts)
// but is not declared in any package.json, so the names loaded at import time
// are stubbed. The SQLite repository used here does not touch Kysely.
vi.mock("kysely", () => ({
  Kysely: class Kysely {},
  PostgresDialect: class PostgresDialect {},
  SqliteDialect: class SqliteDialect {},
  sql: Object.assign(() => ({}), { raw: () => ({}) }),
}));

vi.mock("@wormhole/config", () => ({
  ConfigValidationError: class ConfigValidationError extends Error {},
  isSecretFieldName: () => false,
  redactSecretValue: (value: unknown) => String(value),
  validateAddressFormat: () => [],
  validateNetworkModeChainId: () => [],
}));

// Chain clients: the ETH log feed is controlled per test through `ethState`.
const ethState = vi.hoisted(() => ({
  latest: 10_000n,
  logs: { OrderCreated: [] as any[], OrderClaimed: [] as any[], OrderRefunded: [] as any[] },
}));

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: vi.fn(() => ({
      getBlockNumber: vi.fn(async () => ethState.latest),
      getLogs: vi.fn(async ({ event }: any) => ethState.logs[event.name as keyof typeof ethState.logs] ?? []),
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
        getEvents: vi.fn(async () => ({ events: [], cursor: null })),
      })),
    },
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

const log = pino({ level: "silent" });

const VALID_ETH_ADDR = "0x1111111111111111111111111111111111111111";
const VALID_STELLAR = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422";
const HASHLOCK = "0x" + "a".repeat(64);
const HASHLOCK_B = "0x" + "b".repeat(64);
const PREIMAGE_BUF = Buffer.alloc(32, 0xcc);
const VALID_PREIMAGE = "0x" + PREIMAGE_BUF.toString("hex");
const VALID_HASHLOCK = "0x" + createHash("sha256").update(PREIMAGE_BUF).digest("hex");

const CFG: CoordinatorConfig = {
  network: "testnet",
  port: 3001,
  databaseUrl: "file::memory:",
  logLevel: "silent",
  corsOrigin: "*",
  pollIntervalMs: 15_000,
  ethereum: {
    rpcUrl: "https://rpc.test",
    chainId: 11_155_111,
    htlcEscrow: "0xb352339BEb146f2699d28D736700B953988bB178",
    resolverRegistry: null,
  },
  soroban: {
    rpcUrl: "https://soroban.test",
    horizonUrl: "https://horizon.test",
    networkPassphrase: "Test",
    htlcContract: null,
    resolverRegistry: null,
  },
  solana: { rpcUrl: "https://solana.test", programId: "PLACEHOLDER", commitment: "confirmed" },
};

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite");

const SCHEMA_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../src/persistence/schema.sql");

/**
 * Open a fresh SQLite database with the canonical schema.
 *
 * This is the schema step of `openDatabase`, without its migration-registry
 * check. That check currently fails on upstream because `013_backlog_indexes*.sql`
 * exists on disk but is not registered, so every `openDatabase` call throws.
 */
function openTestDatabase(): Database {
  const dir = mkdtempSync(resolve(tmpdir(), "wafflefinance-checkpoint-test-"));
  const raw = new DatabaseSync(`${dir}/test.db`);
  raw.exec(readFileSync(SCHEMA_PATH, "utf8"));
  return raw as unknown as Database;
}

async function freshOrders(): Promise<OrderService> {
  return new OrderService(new OrdersRepository(openTestDatabase()), log);
}

async function announce(orders: OrderService, hashlock: string) {
  return orders.announce({
    direction: "eth_to_xlm",
    hashlock,
    srcChain: "ethereum",
    srcAddress: VALID_ETH_ADDR,
    srcAsset: "native",
    srcAmount: "1000000000000000000",
    srcSafetyDeposit: "1000000000000000",
    dstChain: "stellar",
    dstAddress: VALID_STELLAR,
    dstAsset: "native",
    dstAmount: "100000000",
  });
}

function createdLog(orderId: bigint, hashlock: string, blockNumber: bigint, txHash = "0x" + "1".repeat(64)) {
  return {
    args: { orderId, hashlock, timelock: 9_999n },
    blockNumber,
    transactionHash: txHash,
    logIndex: 0,
  };
}

function claimedLog(orderId: bigint, preimage: string, blockNumber: bigint, txHash = "0x" + "2".repeat(64)) {
  return {
    args: { orderId, preimage },
    blockNumber,
    transactionHash: txHash,
    logIndex: 0,
  };
}

beforeEach(() => {
  ethState.latest = 10_000n;
  ethState.logs = { OrderCreated: [], OrderClaimed: [], OrderRefunded: [] };
});

describe("Reconciler checkpoints — OrderCreated claim ordering", () => {
  it("leaves the event unclaimed when the order write fails", async () => {
    const orders = await freshOrders();
    const order = await announce(orders, HASHLOCK);
    const log1 = createdLog(42n, HASHLOCK, 9_000n);
    ethState.logs.OrderCreated = [log1];

    const reconciler = new Reconciler(CFG, orders, log);
    vi.spyOn(orders, "recordSrcLock").mockRejectedValueOnce(new Error("disk I/O error"));
    await reconciler.run();

    const key = ethEventKey("OrderCreated", log1.transactionHash, 0);
    expect(await orders.hasProcessedEvent(key)).toBe(false);
    expect((await orders.get(order.publicId))?.srcOrderId).toBeNull();
  });

  it("replays the event on the next run after a failed write", async () => {
    const orders = await freshOrders();
    const order = await announce(orders, HASHLOCK);
    const log1 = createdLog(42n, HASHLOCK, 9_000n);
    ethState.logs.OrderCreated = [log1];

    const reconciler = new Reconciler(CFG, orders, log);
    vi.spyOn(orders, "recordSrcLock").mockRejectedValueOnce(new Error("disk I/O error"));
    await reconciler.run();
    await reconciler.run();

    const key = ethEventKey("OrderCreated", log1.transactionHash, 0);
    expect(await orders.hasProcessedEvent(key)).toBe(true);
    const applied = await orders.get(order.publicId);
    expect(applied?.srcOrderId).toBe("42");
    expect(applied?.srcLockBlock).toBe(9_000);
  });

  it("treats a crash after the order write but before the claim as a no-op on replay", async () => {
    const orders = await freshOrders();
    const order = await announce(orders, HASHLOCK);
    const log1 = createdLog(42n, HASHLOCK, 9_000n);
    ethState.logs.OrderCreated = [log1];

    const reconciler = new Reconciler(CFG, orders, log);
    // The lock is written, then the process "dies" before the claim lands.
    const claimSpy = vi.spyOn(orders, "claimEvent").mockRejectedValueOnce(new Error("process killed"));
    const lockSpy = vi.spyOn(orders, "recordSrcLock");
    await reconciler.run();

    const key = ethEventKey("OrderCreated", log1.transactionHash, 0);
    expect(claimSpy).toHaveBeenCalledTimes(1);
    expect(await orders.hasProcessedEvent(key)).toBe(false);
    expect(lockSpy).toHaveBeenCalledTimes(1);

    // Restart: the event is still unclaimed, so it is replayed. The order already
    // carries the lock, so the decision logic skips the write and records the claim.
    await reconciler.run();
    expect(lockSpy).toHaveBeenCalledTimes(1);
    expect(await orders.hasProcessedEvent(key)).toBe(true);
    expect((await orders.get(order.publicId))?.srcOrderId).toBe("42");
  });

  it("does not apply an event for an order that is not announced yet, and applies it once it is", async () => {
    const orders = await freshOrders();
    const log1 = createdLog(77n, HASHLOCK_B, 9_100n);
    ethState.logs.OrderCreated = [log1];

    const reconciler = new Reconciler(CFG, orders, log);
    await reconciler.run();
    const key = ethEventKey("OrderCreated", log1.transactionHash, 0);
    expect(await orders.hasProcessedEvent(key)).toBe(false);

    const order = await announce(orders, HASHLOCK_B);
    await reconciler.run();
    expect(await orders.hasProcessedEvent(key)).toBe(true);
    expect((await orders.get(order.publicId))?.srcOrderId).toBe("77");
  });

  it("claims an event that conflicts with a terminal order so it is not retried", async () => {
    const orders = await freshOrders();
    await announce(orders, HASHLOCK);
    const log1 = createdLog(42n, HASHLOCK, 9_000n);
    ethState.logs.OrderCreated = [log1];

    const reconciler = new Reconciler(CFG, orders, log);
    const lockSpy = vi
      .spyOn(orders, "recordSrcLock")
      .mockRejectedValueOnce(new Error("cannot record src lock: order is terminal"));
    await reconciler.run();
    await reconciler.run();

    const key = ethEventKey("OrderCreated", log1.transactionHash, 0);
    expect(await orders.hasProcessedEvent(key)).toBe(true);
    expect(lockSpy).toHaveBeenCalledTimes(1);
  });
});

describe("Reconciler checkpoints — chain cursor never passes an unapplied event", () => {
  it("holds the ETH cursor one block below a failed event and still applies later events", async () => {
    const orders = await freshOrders();
    const failing = await announce(orders, HASHLOCK);
    const healthy = await announce(orders, HASHLOCK_B);
    ethState.logs.OrderCreated = [
      createdLog(1n, HASHLOCK, 9_000n, "0x" + "a".repeat(64)),
      createdLog(2n, HASHLOCK_B, 9_500n, "0x" + "b".repeat(64)),
    ];

    const reconciler = new Reconciler(CFG, orders, log);
    const realRecordSrcLock = orders.recordSrcLock.bind(orders);
    vi.spyOn(orders, "recordSrcLock").mockImplementation(async (input) => {
      if (input.publicId === failing.publicId) throw new Error("transient write failure");
      return realRecordSrcLock(input);
    });
    await reconciler.run();

    expect(await orders.getChainCursor("ethereum")).toBe(8_999);
    expect((await orders.get(healthy.publicId))?.srcOrderId).toBe("2");
    expect((await orders.get(failing.publicId))?.srcOrderId).toBeNull();
  });

  it("advances the ETH cursor to the tip when every event applies", async () => {
    const orders = await freshOrders();
    await announce(orders, HASHLOCK);
    ethState.logs.OrderCreated = [createdLog(1n, HASHLOCK, 9_000n)];

    const reconciler = new Reconciler(CFG, orders, log);
    await reconciler.run();

    expect(await orders.getChainCursor("ethereum")).toBe(10_000);
  });

  it("holds the cursor for a failed OrderClaimed and re-applies it on the next run", async () => {
    const orders = await freshOrders();
    const order = await announce(orders, VALID_HASHLOCK);
    await orders.recordSrcLock({
      actor: "system",
      publicId: order.publicId,
      orderId: "9",
      txHash: "0x" + "c".repeat(64),
      blockNumber: 8_000,
      timelock: 9_999,
    });
    ethState.logs.OrderClaimed = [claimedLog(9n, VALID_PREIMAGE, 9_300n)];

    const reconciler = new Reconciler(CFG, orders, log);
    const secretSpy = vi.spyOn(orders, "recordSecret").mockRejectedValueOnce(new Error("disk full"));
    await reconciler.run();
    expect(await orders.getChainCursor("ethereum")).toBe(9_299);
    expect((await orders.get(order.publicId))?.preimage).toBeNull();

    await reconciler.run();
    expect(secretSpy).toHaveBeenCalledTimes(2);
    expect((await orders.get(order.publicId))?.preimage).toBe(VALID_PREIMAGE);
    expect(await orders.getChainCursor("ethereum")).toBe(10_000);
  });

  it("keeps the replay window at the lowest failed block when several events fail", async () => {
    const orders = await freshOrders();
    await announce(orders, HASHLOCK);
    await announce(orders, HASHLOCK_B);
    ethState.logs.OrderCreated = [
      createdLog(1n, HASHLOCK, 9_700n, "0x" + "d".repeat(64)),
      createdLog(2n, HASHLOCK_B, 9_200n, "0x" + "e".repeat(64)),
    ];

    const reconciler = new Reconciler(CFG, orders, log);
    vi.spyOn(orders, "recordSrcLock").mockRejectedValue(new Error("write failure"));
    await reconciler.run();

    expect(await orders.getChainCursor("ethereum")).toBe(9_199);
  });
});
