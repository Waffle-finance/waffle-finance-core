/**
 * Event deduplication tests — issue #281
 *
 * Verifies that the in-process deduplication caches in EthereumListener,
 * SorobanListener, and SolanaListener prevent duplicate DB calls when the
 * same event is replayed within a single process lifetime.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
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
import { nativeToScVal } from "@stellar/stellar-sdk";
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

// ─── viem mock ────────────────────────────────────────────────────────────────

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: vi.fn(() => ({
      getBlockNumber: vi.fn(async () => 1000n),
      getLogs: vi.fn(async () => []),
      getBlock: vi.fn(async ({ blockNumber }: { blockNumber: bigint }) => ({
        hash: `0xhash${Number(blockNumber)}`,
      })),
      watchEvent: vi.fn(() => () => {}),
    })),
  };
});

// ─── @stellar/stellar-sdk mock ────────────────────────────────────────────────

vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();
  return {
    ...actual,
    rpc: {
      ...actual.rpc,
      Server: vi.fn(() => ({
        getLatestLedger: vi.fn(async () => ({ sequence: 10000 })),
        getEvents: vi.fn(async () => ({ events: [], cursor: null })),
      })),
    },
  };
});

// ─── @solana/web3.js mock ─────────────────────────────────────────────────────

vi.mock("@solana/web3.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@solana/web3.js")>();
  return {
    ...actual,
    Connection: vi.fn(() => ({
      getSlot: vi.fn(async () => 1000),
      getSignaturesForAddress: vi.fn(async () => []),
      getParsedTransaction: vi.fn(async () => null),
    })),
    PublicKey: actual.PublicKey,
  };
});

// ─── Test helpers ─────────────────────────────────────────────────────────────

const log = pino({ level: "silent" });

const VALID_ETH_ADDR = "0x1111111111111111111111111111111111111111";
const VALID_STELLAR_ADDR = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422";

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

function makeTmpDir(): string {
  return mkdtempSync(resolve(tmpdir(), "dedup-test-"));
}

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

// ─── EthereumListener — deduplication ────────────────────────────────────────

describe("EthereumListener — in-process deduplication (issue #281)", () => {
  it("isDuplicate returns false before any event is processed", () => {
    const { svc } = { svc: undefined as any };
    const listener = new EthereumListener(BASE_CFG, svc, log);
    expect(listener.isDuplicate("OrderCreated", "0xdeadbeef")).toBe(false);
  });

  it("does not call recordSrcLock a second time for the same txHash", async () => {
    const { svc } = await makeServices();
    const order = await announceOrder(svc);

    const recordSrcLock = vi.spyOn(svc, "recordSrcLock");

    // Simulate two confirmed events with the same txHash
    const fakeTxHash = "0xaaaa1111";
    const fakeLog = {
      blockNumber: 100n,
      transactionHash: fakeTxHash,
      args: {
        orderId: 1n,
        hashlock: HASHLOCK,
        timelock: BigInt(TIMELOCK),
      },
    };

    const listener = new EthereumListener(BASE_CFG, svc, log);

    // First dispatch — should write to DB
    await (listener as any).processConfirmedCreatedLog(fakeLog, order.publicId, 200);
    expect(recordSrcLock).toHaveBeenCalledTimes(1);

    // Second dispatch with same txHash — should be skipped by dedup cache
    await (listener as any).processConfirmedCreatedLog(fakeLog, order.publicId, 200);
    expect(recordSrcLock).toHaveBeenCalledTimes(1); // still 1
  });

  it("processes a different txHash after the first is cached", async () => {
    const { svc } = await makeServices();
    const order1 = await announceOrder(svc, HASHLOCK);
    const HASHLOCK2 = "0x" + "b".repeat(64);
    const order2 = await announceOrder(svc, HASHLOCK2);

    const recordSrcLock = vi.spyOn(svc, "recordSrcLock");
    const listener = new EthereumListener(BASE_CFG, svc, log);

    const makeLog = (txHash: string, hashlock: string) => ({
      blockNumber: 100n,
      transactionHash: txHash,
      args: { orderId: 1n, hashlock, timelock: BigInt(TIMELOCK) },
    });

    await (listener as any).processConfirmedCreatedLog(makeLog("0xtx1", HASHLOCK), order1.publicId, 200);
    await (listener as any).processConfirmedCreatedLog(makeLog("0xtx2", HASHLOCK2), order2.publicId, 200);
    await (listener as any).processConfirmedCreatedLog(makeLog("0xtx1", HASHLOCK), order1.publicId, 200); // dup

    // tx1 written once, tx2 written once → total 2 calls
    expect(recordSrcLock).toHaveBeenCalledTimes(2);
  });
});

// ─── SorobanListener — deduplication ─────────────────────────────────────────

describe("SorobanListener — in-process deduplication (issue #281)", () => {
  it("isDuplicate returns false initially", () => {
    const listener = new SorobanListener(BASE_CFG, undefined as any, log);
    expect(listener.isDuplicate("created", "txHash1")).toBe(false);
  });

  it("does not call recordSrcLock twice for the same txHash", async () => {
    const { svc } = await makeServices();
    const order = await announceOrder(svc);

    const recordSrcLock = vi.spyOn(svc, "recordSrcLock");
    const listener = new SorobanListener(BASE_CFG, svc, log);

    const ev = {
      ledger: 5000,
      txHash: "sorobanTxHash1",
      topic: makeCreatedEvent().topic,
      value: makeCreatedEvent().value,
    };

    // processSorobanEvent is private — call via (listener as any)
    await (listener as any).processSorobanEvent(ev);
    await (listener as any).processSorobanEvent(ev); // replay

    // Only one DB write regardless of replay
    expect(recordSrcLock).toHaveBeenCalledTimes(1);
  });

  it("processes events with different txHashes independently", async () => {
    const { svc } = await makeServices();
    const HASHLOCK2 = "0x" + "b".repeat(64);
    await announceOrder(svc, HASHLOCK);
    await announceOrder(svc, HASHLOCK2);

    const recordSrcLock = vi.spyOn(svc, "recordSrcLock");
    const listener = new SorobanListener(BASE_CFG, svc, log);

    const ev1 = { ledger: 5000, txHash: "tx1", ...makeCreatedEvent() };
    const base2 = makeCreatedEvent(5001, "tx2");
    const topic2 = [...base2.topic];
    topic2[3] = nativeToScVal(Buffer.from("b".repeat(64), "hex"));
    const ev2 = { ...base2, topic: topic2 };

    await (listener as any).processSorobanEvent(ev1);
    await (listener as any).processSorobanEvent(ev2);
    await (listener as any).processSorobanEvent(ev1); // dup

    expect(recordSrcLock).toHaveBeenCalledTimes(2);
  });

  it("processes two events with the same topic in the same transaction when they have distinct eventIndexes", async () => {
    const { svc } = await makeServices();
    const HASHLOCK2 = "0x" + "b".repeat(64);
    await announceOrder(svc, HASHLOCK);
    await announceOrder(svc, HASHLOCK2);

    const recordSrcLock = vi.spyOn(svc, "recordSrcLock");
    const listener = new SorobanListener(BASE_CFG, svc, log);

    const ev1 = { ledger: 5000, txHash: "sameTxHash", eventIndex: 0, ...makeCreatedEvent() };
    const base2 = makeCreatedEvent(5000, "sameTxHash");
    const topic2 = [...base2.topic];
    topic2[3] = nativeToScVal(Buffer.from("b".repeat(64), "hex"));
    const ev2 = { ledger: 5000, txHash: "sameTxHash", eventIndex: 1, ...base2, topic: topic2 };

    await (listener as any).processSorobanEvent(ev1);
    await (listener as any).processSorobanEvent(ev2);

    expect(recordSrcLock).toHaveBeenCalledTimes(2);

    // Replaying ev1 should be suppressed
    await (listener as any).processSorobanEvent(ev1);
    expect(recordSrcLock).toHaveBeenCalledTimes(2);
  });

  it("processes two events with the same topic in the same transaction when they have distinct IDs", async () => {
    const { svc } = await makeServices();
    const HASHLOCK2 = "0x" + "b".repeat(64);
    await announceOrder(svc, HASHLOCK);
    await announceOrder(svc, HASHLOCK2);

    const recordSrcLock = vi.spyOn(svc, "recordSrcLock");
    const listener = new SorobanListener(BASE_CFG, svc, log);

    const ev1 = { ledger: 5000, txHash: "sameTxHash2", id: "1000-1", ...makeCreatedEvent() };
    const base2 = makeCreatedEvent(5000, "sameTxHash2");
    const topic2 = [...base2.topic];
    topic2[3] = nativeToScVal(Buffer.from("b".repeat(64), "hex"));
    const ev2 = { ledger: 5000, txHash: "sameTxHash2", id: "1000-2", ...base2, topic: topic2 };

    await (listener as any).processSorobanEvent(ev1);
    await (listener as any).processSorobanEvent(ev2);

    expect(recordSrcLock).toHaveBeenCalledTimes(2);

    // Replaying ev1 should be suppressed
    await (listener as any).processSorobanEvent(ev1);
    expect(recordSrcLock).toHaveBeenCalledTimes(2);
  });
});

// ─── SolanaListener — deduplication ──────────────────────────────────────────

describe("SolanaListener — in-process deduplication (issue #281)", () => {
  it("isDuplicate returns false initially", () => {
    const listener = new SolanaListener(BASE_CFG, undefined as any, log);
    expect(listener.isDuplicate("some-sig-abc")).toBe(false);
  });

  it("does not call recordSrcLock twice for the same signature", async () => {
    const { svc } = await makeServices();
    const order = await announceOrder(svc);

    const recordSrcLock = vi.spyOn(svc, "recordSrcLock");
    const listener = new SolanaListener(BASE_CFG, svc, log);

    const sig = "5SigAbcDef";
    const logs = [
      `Program log: Instruction: OrderCreated`,
      `Program log: {"hashlock":"${HASHLOCK}","orderId":"ord1","timelock":${TIMELOCK}}`,
    ];

    // First call — should write
    (listener as any).handleLogs(sig, logs, 100);
    // Need to wait a tick for the void async block inside handleLogs
    await new Promise((r) => setTimeout(r, 10));
    expect(recordSrcLock).toHaveBeenCalledTimes(1);

    // Second call — same sig, should be deduped
    (listener as any).handleLogs(sig, logs, 100);
    await new Promise((r) => setTimeout(r, 10));
    expect(recordSrcLock).toHaveBeenCalledTimes(1); // still 1
  });

  it("processes different signatures independently", async () => {
    const { svc } = await makeServices();
    await announceOrder(svc, HASHLOCK);
    const HASHLOCK2 = "0x" + "b".repeat(64);
    await announceOrder(svc, HASHLOCK2);

    const recordSrcLock = vi.spyOn(svc, "recordSrcLock");
    const listener = new SolanaListener(BASE_CFG, svc, log);

    const makeLogs = (hashlock: string) => [
      `Program log: Instruction: OrderCreated`,
      `Program log: {"hashlock":"${hashlock}","orderId":"ord1","timelock":${TIMELOCK}}`,
    ];

    (listener as any).handleLogs("sig1", makeLogs(HASHLOCK), 100);
    await new Promise((r) => setTimeout(r, 10));
    (listener as any).handleLogs("sig2", makeLogs(HASHLOCK2), 101);
    await new Promise((r) => setTimeout(r, 10));
    (listener as any).handleLogs("sig1", makeLogs(HASHLOCK), 100); // dup
    await new Promise((r) => setTimeout(r, 10));

    expect(recordSrcLock).toHaveBeenCalledTimes(2);
  });
});
