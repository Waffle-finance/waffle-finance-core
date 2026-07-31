import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
  HASHLOCK,
  PREIMAGE,
  ORDER_ID,
  TIMELOCK,
} from "./fixtures/soroban-xdr-fixtures.js";

// ─── @stellar/stellar-sdk mock (rpc.Server only) ──────────────────────────────
// Mirrors listeners.test.ts: real scValToNative/xdr are passed through so the
// XDR fixtures decode exactly as they do against a live node.

let mockLatestLedger = 10_000;
let mockSorobanEvents: any[] = [];
let mockSorobanCursor: string | null = null;
/** When set, getEvents throws this error once, then clears it. */
let mockSorobanError: Error | null = null;

vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();
  return {
    ...actual,
    rpc: {
      ...actual.rpc,
      Server: vi.fn(() => ({
        getLatestLedger: vi.fn(async () => ({ sequence: mockLatestLedger })),
        getEvents: vi.fn(async () => {
          if (mockSorobanError) {
            const err = mockSorobanError;
            mockSorobanError = null;
            throw err;
          }
          return { events: mockSorobanEvents, cursor: mockSorobanCursor };
        }),
      })),
    },
  };
});

const log = pino({ level: "silent" });

const VALID_ETH_ADDR = "0x1111111111111111111111111111111111111111";
const VALID_STELLAR_ADDR = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422";
const CONTRACT = "CDW3V35K4J7NQD...";

const BASE_CFG: CoordinatorConfig = {
  network: "testnet",
  port: 3001,
  databaseUrl: "file::memory:",
  logLevel: "error",
  corsOrigin: "*",
  pollIntervalMs: 1,
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
    htlcContract: CONTRACT,
    resolverRegistry: null,
  },
  solana: { rpcUrl: "https://solana.test", programId: "PLACEHOLDER", commitment: "confirmed" },
} as CoordinatorConfig;

async function freshDb() {
  const dir = mkdtempSync(resolve(tmpdir(), "wafflefinance-checkpoint-test-"));
  return openDatabase(`file:${dir}/test.db`);
}

async function freshRepoAndOrders() {
  const db = await freshDb();
  const repo = new OrdersRepository(db);
  return { repo, orders: new OrderService(repo, log) };
}

async function seedEthToXlmOrder(orders: OrderService, hashlock = HASHLOCK) {
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
    dstAmount: "100000000",
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
    dstAmount: "1000000000000000000",
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Persistence adapter — OrdersRepository checkpoint methods
// ─────────────────────────────────────────────────────────────────────────────

describe("Soroban checkpoint persistence adapter", () => {
  let repo: OrdersRepository;

  beforeEach(async () => {
    ({ repo } = await freshRepoAndOrders());
  });

  it("returns null when no checkpoint exists for the contract", async () => {
    expect(await repo.getSorobanCheckpoint(CONTRACT)).toBeNull();
  });

  it("round-trips every field of a saved checkpoint", async () => {
    await repo.saveSorobanCheckpoint({
      contractId: CONTRACT,
      lastSafeLedger: 12_345,
      effectiveCursor: "cursor-abc",
      recoveryMarker: "clean",
    });

    const cp = await repo.getSorobanCheckpoint(CONTRACT);
    expect(cp).toEqual({
      contractId: CONTRACT,
      lastSafeLedger: 12_345,
      effectiveCursor: "cursor-abc",
      recoveryMarker: "clean",
      updatedAt: expect.any(Number),
    });
  });

  it("persists and reads back a null cursor", async () => {
    await repo.saveSorobanCheckpoint({
      contractId: CONTRACT,
      lastSafeLedger: 10,
      effectiveCursor: null,
      recoveryMarker: "clean",
    });
    const cp = await repo.getSorobanCheckpoint(CONTRACT);
    expect(cp?.effectiveCursor).toBeNull();
  });

  it("advances last_safe_ledger forward on a higher save", async () => {
    await repo.saveSorobanCheckpoint({
      contractId: CONTRACT,
      lastSafeLedger: 100,
      effectiveCursor: "c1",
      recoveryMarker: "clean",
    });
    await repo.saveSorobanCheckpoint({
      contractId: CONTRACT,
      lastSafeLedger: 200,
      effectiveCursor: "c2",
      recoveryMarker: "clean",
    });
    const cp = await repo.getSorobanCheckpoint(CONTRACT);
    expect(cp?.lastSafeLedger).toBe(200);
    expect(cp?.effectiveCursor).toBe("c2");
  });

  it("never rewinds last_safe_ledger when a lower ledger is saved (forward-only)", async () => {
    await repo.saveSorobanCheckpoint({
      contractId: CONTRACT,
      lastSafeLedger: 500,
      effectiveCursor: "c-high",
      recoveryMarker: "clean",
    });
    // A stale-cursor reset writes a lower ledger — must not regress the resume point.
    await repo.saveSorobanCheckpoint({
      contractId: CONTRACT,
      lastSafeLedger: 400,
      effectiveCursor: "c-low",
      recoveryMarker: "pending_replay",
    });
    const cp = await repo.getSorobanCheckpoint(CONTRACT);
    expect(cp?.lastSafeLedger).toBe(500); // clamped forward-only
    // cursor and marker still take the latest value.
    expect(cp?.effectiveCursor).toBe("c-low");
    expect(cp?.recoveryMarker).toBe("pending_replay");
  });

  it("markSorobanRecovery returns 0 and is a no-op when no checkpoint exists", async () => {
    expect(await repo.markSorobanRecovery(CONTRACT, "pending_replay")).toBe(0);
    expect(await repo.getSorobanCheckpoint(CONTRACT)).toBeNull();
  });

  it("markSorobanRecovery flips only the marker, leaving ledger and cursor intact", async () => {
    await repo.saveSorobanCheckpoint({
      contractId: CONTRACT,
      lastSafeLedger: 777,
      effectiveCursor: "keep-me",
      recoveryMarker: "clean",
    });
    const changed = await repo.markSorobanRecovery(CONTRACT, "recovering");
    expect(changed).toBe(1);

    const cp = await repo.getSorobanCheckpoint(CONTRACT);
    expect(cp?.recoveryMarker).toBe("recovering");
    expect(cp?.lastSafeLedger).toBe(777);
    expect(cp?.effectiveCursor).toBe("keep-me");
  });

  it("keeps checkpoints isolated per contract id", async () => {
    await repo.saveSorobanCheckpoint({
      contractId: "CONTRACT_A",
      lastSafeLedger: 10,
      effectiveCursor: "a",
      recoveryMarker: "clean",
    });
    await repo.saveSorobanCheckpoint({
      contractId: "CONTRACT_B",
      lastSafeLedger: 20,
      effectiveCursor: "b",
      recoveryMarker: "recovering",
    });
    expect((await repo.getSorobanCheckpoint("CONTRACT_A"))?.lastSafeLedger).toBe(10);
    expect((await repo.getSorobanCheckpoint("CONTRACT_B"))?.recoveryMarker).toBe("recovering");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Listener — durable checkpointing & replay-recovery
// ─────────────────────────────────────────────────────────────────────────────

describe("SorobanListener — durable checkpoint & replay-recovery", () => {
  let orders: OrderService;
  let repo: OrdersRepository;
  let listener: SorobanListener | undefined;

  beforeEach(async () => {
    ({ repo, orders } = await freshRepoAndOrders());
    mockLatestLedger = 10_100;
    mockSorobanEvents = [];
    mockSorobanCursor = null;
    mockSorobanError = null;
    listener = undefined;
  });

  afterEach(() => {
    listener?.stop();
  });

  it("persists a durable checkpoint after processing a live event", async () => {
    const order = await seedEthToXlmOrder(orders);
    mockSorobanEvents = [makeCreatedEvent(10_050, "0xlive_tx")];
    mockSorobanCursor = "cursor-live";

    listener = new SorobanListener(BASE_CFG, orders, log);
    listener.start();
    await new Promise((r) => setTimeout(r, 40));

    expect((await orders.get(order.publicId))?.status).toBe("src_locked");

    const cp = await repo.getSorobanCheckpoint(CONTRACT);
    expect(cp).not.toBeNull();
    expect(cp?.recoveryMarker).toBe("clean");
    expect(cp?.lastSafeLedger).toBeGreaterThanOrEqual(10_050);
    expect(cp?.effectiveCursor).toBe("cursor-live");
  });

  it("resumes from the persisted checkpoint on restart without double-processing", async () => {
    const order = await seedEthToXlmOrder(orders);

    // ── First process: listener A locks the order and checkpoints. ──────────
    mockSorobanEvents = [makeCreatedEvent(10_050, "0xoriginal_tx")];
    mockSorobanCursor = "cursor-A";
    const listenerA = new SorobanListener(BASE_CFG, orders, log);
    listenerA.start();
    await new Promise((r) => setTimeout(r, 40));
    listenerA.stop();

    const afterA = await orders.get(order.publicId);
    expect(afterA?.status).toBe("src_locked");
    expect(afterA?.srcLockTx).toBe("0xoriginal_tx");

    const cpA = await repo.getSorobanCheckpoint(CONTRACT);
    expect(cpA?.recoveryMarker).toBe("clean");

    // ── Restart: listener B shares the same persistence layer. The SAME event
    //    is re-delivered but with a DIFFERENT tx hash. If B double-processed,
    //    srcLockTx would change; idempotency keeps it at the original. ───────
    mockSorobanEvents = [makeCreatedEvent(10_050, "0xREDELIVERED_tx")];
    mockSorobanCursor = "cursor-A";
    listener = new SorobanListener(BASE_CFG, orders, log);
    listener.start();
    await new Promise((r) => setTimeout(r, 40));

    const afterB = await orders.get(order.publicId);
    expect(afterB?.status).toBe("src_locked");
    expect(afterB?.srcLockTx).toBe("0xoriginal_tx"); // unchanged → no duplicate transition
    expect(afterB?.srcOrderId).toBe(ORDER_ID);
  });

  it("recovers a missed ledger range by replaying from the checkpoint after a stale-cursor error", async () => {
    const order = await seedEthToXlmOrder(orders);

    // First getEvents throws (node no longer knows our cursor); the recovered
    // event is delivered on the replay scan that follows the reset.
    mockSorobanError = new Error("cursor not found: history pruned");
    mockSorobanEvents = [makeCreatedEvent(10_050, "0xafter_reset")];

    listener = new SorobanListener(BASE_CFG, orders, log);
    listener.start();
    await new Promise((r) => setTimeout(r, 60));

    const updated = await orders.get(order.publicId);
    expect(updated?.status).toBe("src_locked");
    expect(updated?.srcOrderId).toBe(ORDER_ID);

    const cp = await repo.getSorobanCheckpoint(CONTRACT);
    expect(cp?.recoveryMarker).toBe("clean");
    expect(cp?.lastSafeLedger).toBeGreaterThanOrEqual(10_050);
  });

  it("replays a large ledger gap and reconciles the missed transition", async () => {
    // Order is already source-locked; the claimed event that reveals the secret
    // arrives beyond MAX_LEDGER_GAP ahead of the checkpoint, tripping the gap
    // guard. The bounded replay must still apply it.
    const order = await seedStellarOrder(orders);
    await orders.recordSrcLock({
      publicId: order.publicId,
      orderId: ORDER_ID,
      txHash: "0xlock_tx",
      blockNumber: 9_900,
      timelock: TIMELOCK,
    });

    // Seed a clean checkpoint far enough behind that the incoming ledger is a gap.
    await repo.saveSorobanCheckpoint({
      contractId: CONTRACT,
      lastSafeLedger: 9_900,
      effectiveCursor: "cursor-pre-gap",
      recoveryMarker: "clean",
    });

    mockLatestLedger = 10_010;
    // 10_005 - 9_900 = 105 > MAX_LEDGER_GAP (100) → gap guard → bounded replay.
    mockSorobanEvents = [makeClaimedEvent(10_005, "0xclaimed_after_gap")];

    listener = new SorobanListener(BASE_CFG, orders, log);
    listener.start();
    await new Promise((r) => setTimeout(r, 60));

    const updated = await orders.get(order.publicId);
    expect(updated?.status).toBe("secret_revealed");
    expect(updated?.preimage).toBe(PREIMAGE);

    const cp = await repo.getSorobanCheckpoint(CONTRACT);
    expect(cp?.recoveryMarker).toBe("clean");
    expect(cp?.lastSafeLedger).toBeGreaterThanOrEqual(10_005);
  });

  it("runs the pending replay recorded in the checkpoint on startup", async () => {
    const order = await seedEthToXlmOrder(orders);

    // A prior run flagged replay-pending and did not finish (e.g. crashed).
    await repo.saveSorobanCheckpoint({
      contractId: CONTRACT,
      lastSafeLedger: 10_000,
      effectiveCursor: null,
      recoveryMarker: "pending_replay",
    });

    mockSorobanEvents = [makeCreatedEvent(10_050, "0xreplay_tx")];

    listener = new SorobanListener(BASE_CFG, orders, log);
    listener.start();
    await new Promise((r) => setTimeout(r, 50));

    expect((await orders.get(order.publicId))?.status).toBe("src_locked");
    const cp = await repo.getSorobanCheckpoint(CONTRACT);
    expect(cp?.recoveryMarker).toBe("clean");
  });

  it("is idempotent when the same event is replayed again after recovery", async () => {
    const order = await seedEthToXlmOrder(orders);

    // First recovery: checkpoint marked pending → replay applies the created event.
    await repo.saveSorobanCheckpoint({
      contractId: CONTRACT,
      lastSafeLedger: 10_000,
      effectiveCursor: null,
      recoveryMarker: "pending_replay",
    });
    mockSorobanEvents = [makeCreatedEvent(10_050, "0xfirst_recovery")];

    const listenerA = new SorobanListener(BASE_CFG, orders, log);
    listenerA.start();
    await new Promise((r) => setTimeout(r, 50));
    listenerA.stop();

    const afterFirst = await orders.get(order.publicId);
    expect(afterFirst?.status).toBe("src_locked");
    expect(afterFirst?.srcLockTx).toBe("0xfirst_recovery");

    // Force a second recovery over the SAME event (different tx hash). The
    // decideDispatch policy must treat it as already-applied → no re-transition.
    await repo.markSorobanRecovery(CONTRACT, "pending_replay");
    mockSorobanEvents = [makeCreatedEvent(10_050, "0xsecond_recovery")];

    listener = new SorobanListener(BASE_CFG, orders, log);
    listener.start();
    await new Promise((r) => setTimeout(r, 50));

    const afterSecond = await orders.get(order.publicId);
    expect(afterSecond?.status).toBe("src_locked");
    expect(afterSecond?.srcLockTx).toBe("0xfirst_recovery"); // unchanged → idempotent
  });
});
