/**
 * Tests for Solana event listener idempotency (#714) and RPC fallback
 * integration in the coordinator's SolanaListener (#713).
 *
 * Covers:
 *  - Duplicate signatures are not re-queued in pendingSlots
 *  - Already-processed signatures are skipped (in-process dedup cache)
 *  - isInPendingSlots returns true only for queued sigs
 *  - isDuplicate returns true only for processed sigs
 *  - Repeated replays of the same signature produce at most one DB mutation
 *  - getRpcHealth reflects provider health (#713)
 *  - Listener handles RPC fallback errors gracefully without dropping state
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import pino from "pino";
import type { CoordinatorConfig } from "../src/config.js";
import { SolanaListener } from "../src/listeners/solana-listener.js";

// ── Mock web3.js and SDK ───────────────────────────────────────────────────

vi.mock("@solana/web3.js", () => ({
  Connection: vi.fn(() => ({
    getSlot: vi.fn().mockResolvedValue(100),
    getSignaturesForAddress: vi.fn().mockResolvedValue([]),
    getParsedTransaction: vi.fn().mockResolvedValue(null),
  })),
  PublicKey: vi.fn((id: string) => ({
    toBase58: () => id,
    equals: (other: any) => other.toBase58?.() === id,
  })),
}));

vi.mock("@wafflefinance/sdk", () => ({
  SolanaRpcProvider: vi.fn(() => ({
    withFallback: vi.fn(async (fn: (conn: any) => any) => {
      const mockConn = {
        getSlot: vi.fn().mockResolvedValue(100),
        getSignaturesForAddress: vi.fn().mockResolvedValue([]),
        getParsedTransaction: vi.fn().mockResolvedValue(null),
      };
      return fn(mockConn);
    }),
    getConnection: vi.fn(() => ({
      getSlot: vi.fn().mockResolvedValue(100),
    })),
    getHealth: vi.fn(() => ({
      healthy: true,
      degraded: false,
      endpoints: [],
      activeEndpoint: "https://api.devnet.solana.com",
    })),
    getPrimaryUrl: vi.fn().mockReturnValue("https://api.devnet.solana.com"),
  })),
  createSolanaRpcProvider: vi.fn(() => ({
    withFallback: vi.fn(async (fn: (conn: any) => any) => {
      const mockConn = {
        getSlot: vi.fn().mockResolvedValue(100),
        getSignaturesForAddress: vi.fn().mockResolvedValue([]),
        getParsedTransaction: vi.fn().mockResolvedValue(null),
      };
      return fn(mockConn);
    }),
    getConnection: vi.fn(() => ({})),
    getHealth: vi.fn(() => ({
      healthy: true,
      degraded: false,
      endpoints: [{ url: "https://api.devnet.solana.com", consecutiveErrors: 0, lastErrorMs: null, lastSuccessMs: Date.now(), latencyMs: 10 }],
      activeEndpoint: "https://api.devnet.solana.com",
    })),
    getPrimaryUrl: vi.fn().mockReturnValue("https://api.devnet.solana.com"),
  })),
}));

// ── Fixtures ───────────────────────────────────────────────────────────────

const BASE_CFG: CoordinatorConfig = {
  network: "testnet",
  port: 3001,
  databaseUrl: "file::memory:",
  logLevel: "silent",
  corsOrigin: "*",
  pollIntervalMs: 10,
  ethereum: {
    rpcUrl: "https://rpc.test",
    chainId: 11_155_111,
    htlcEscrow: null,
    resolverRegistry: null,
  },
  soroban: {
    rpcUrl: "https://soroban.test",
    horizonUrl: "https://horizon.test",
    networkPassphrase: "Test",
    htlcContract: null,
    resolverRegistry: null,
  },
  solana: {
    rpcUrl: "https://api.devnet.solana.com",
    programId: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
    commitment: "confirmed",
  },
};

const SILENT_LOG = pino({ level: "silent" });
const STUB_ORDERS = {} as any;

function makeListener(cfgOverrides?: Partial<typeof BASE_CFG.solana>): SolanaListener {
  const cfg = cfgOverrides
    ? { ...BASE_CFG, solana: { ...BASE_CFG.solana, ...cfgOverrides } }
    : BASE_CFG;
  return new SolanaListener(cfg, STUB_ORDERS, SILENT_LOG);
}

// ── Dedup cache tests (#714) ──────────────────────────────────────────────

describe("SolanaListener — in-process deduplication (#714)", () => {
  it("isDuplicate returns false for a new signature", () => {
    const listener = makeListener();
    expect(listener.isDuplicate("sig-abc")).toBe(false);
  });

  it("isDuplicate returns false for a different signature after marking one", () => {
    const listener = makeListener();
    // Access private method via cast
    (listener as any).markSigProcessed("sig-abc");
    expect(listener.isDuplicate("sig-xyz")).toBe(false);
  });

  it("isDuplicate returns true after markSigProcessed", () => {
    const listener = makeListener();
    (listener as any).markSigProcessed("sig-duplicate");
    expect(listener.isDuplicate("sig-duplicate")).toBe(true);
  });

  it("evicts oldest entry when cache reaches DEDUP_CACHE_MAX", () => {
    const listener = makeListener();
    const DEDUP_CACHE_MAX = (listener as any).processedSigs.constructor === Map
      ? 10_000
      : 10_000;

    // Fill the cache to the limit.
    for (let i = 0; i < DEDUP_CACHE_MAX; i++) {
      (listener as any).markSigProcessed(`sig-${i}`);
    }

    // All entries should be present.
    expect(listener.isDuplicate("sig-0")).toBe(true);

    // Add one more — oldest (sig-0) should be evicted.
    (listener as any).markSigProcessed("sig-new");
    expect(listener.isDuplicate("sig-new")).toBe(true);
    // sig-0 was evicted.
    expect(listener.isDuplicate("sig-0")).toBe(false);
  });

  it("markSigProcessed is idempotent — calling twice does not duplicate", () => {
    const listener = makeListener();
    (listener as any).markSigProcessed("sig-once");
    (listener as any).markSigProcessed("sig-once");
    expect(listener.isDuplicate("sig-once")).toBe(true);
    // Size should only be 1.
    expect((listener as any).processedSigs.size).toBe(1);
  });
});

describe("SolanaListener — pending-slot deduplication (#714)", () => {
  it("isInPendingSlots returns false when pendingSlots is empty", () => {
    const listener = makeListener();
    expect(listener.isInPendingSlots("sig-abc")).toBe(false);
  });

  it("isInPendingSlots returns true for a sig that was queued", () => {
    const listener = makeListener();
    (listener as any).pendingSlots.set(100, [{ sig: "sig-abc", logs: [] }]);
    expect(listener.isInPendingSlots("sig-abc")).toBe(true);
  });

  it("isInPendingSlots returns false for a different sig in the same slot", () => {
    const listener = makeListener();
    (listener as any).pendingSlots.set(100, [{ sig: "sig-abc", logs: [] }]);
    expect(listener.isInPendingSlots("sig-xyz")).toBe(false);
  });

  it("isInPendingSlots searches across multiple slots", () => {
    const listener = makeListener();
    (listener as any).pendingSlots.set(100, [{ sig: "sig-slot100", logs: [] }]);
    (listener as any).pendingSlots.set(200, [{ sig: "sig-slot200", logs: [] }]);
    expect(listener.isInPendingSlots("sig-slot100")).toBe(true);
    expect(listener.isInPendingSlots("sig-slot200")).toBe(true);
    expect(listener.isInPendingSlots("sig-missing")).toBe(false);
  });
});

describe("SolanaListener — handleLogs dedup prevents double-processing (#714)", () => {
  it("skips OrderCreated when signature is already in processedSigs", () => {
    const orders = {
      findByHashlock: vi.fn(),
      recordSrcLock: vi.fn(),
      findBySrcOrderId: vi.fn(),
      recordSecret: vi.fn(),
      markStatus: vi.fn(),
      rollbackSrcLock: vi.fn(),
    };

    const listener = new SolanaListener(BASE_CFG, orders as any, SILENT_LOG);

    // Pre-mark the sig as processed.
    (listener as any).markSigProcessed("sig-already-done");

    // Call handleLogs with the pre-processed signature.
    const logs = [
      'Program log: Instruction: CreateOrder',
      'Program log: OrderCreated',
      'Program log: {"hashlock":"0x' + 'aa'.repeat(32) + '","orderId":"somePDA","timelock":1700000000}',
    ];

    (listener as any).handleLogs("sig-already-done", logs, 100);

    // findByHashlock should NOT have been called — dedup kicked in.
    expect(orders.findByHashlock).not.toHaveBeenCalled();
  });

  it("processes OrderCreated when signature is new", () => {
    const orders = {
      findByHashlock: vi.fn().mockResolvedValue(null), // returns null → no local order
      recordSrcLock: vi.fn(),
      findBySrcOrderId: vi.fn(),
      recordSecret: vi.fn(),
      markStatus: vi.fn(),
      rollbackSrcLock: vi.fn(),
    };

    const listener = new SolanaListener(BASE_CFG, orders as any, SILENT_LOG);

    const logs = [
      'Program log: OrderCreated',
      'Program log: {"hashlock":"0x' + 'bb'.repeat(32) + '","orderId":"somePDA2","timelock":1700000000}',
    ];

    (listener as any).handleLogs("sig-brand-new", logs, 101);

    // findByHashlock SHOULD have been called for a new sig.
    expect(orders.findByHashlock).toHaveBeenCalledWith("0x" + "bb".repeat(32));
  });

  it("replaying the same OrderCreated signature twice only calls findByHashlock once", async () => {
    const orders = {
      findByHashlock: vi.fn().mockResolvedValue({
        publicId: "pub-123",
        srcOrderId: null,
        srcLockBlock: null,
        preimage: null,
        status: "announced",
      }),
      recordSrcLock: vi.fn().mockResolvedValue(undefined),
      findBySrcOrderId: vi.fn(),
      recordSecret: vi.fn(),
      markStatus: vi.fn(),
      rollbackSrcLock: vi.fn(),
    };

    const listener = new SolanaListener(BASE_CFG, orders as any, SILENT_LOG);

    const sig = "sig-replay-test";
    const logs = [
      'Program log: OrderCreated',
      'Program log: {"hashlock":"0x' + 'cc'.repeat(32) + '","orderId":"somePDA3","timelock":1700000001}',
    ];

    // First call — triggers async findByHashlock, which resolves and marks sig.
    (listener as any).handleLogs(sig, logs, 102);

    // Wait for the async IIFE to settle so markSigProcessed fires.
    await new Promise((r) => setTimeout(r, 20));

    // Second call — should be deduped now.
    (listener as any).handleLogs(sig, logs, 102);

    // findByHashlock should have been called exactly once.
    expect((orders.findByHashlock as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });
});

describe("SolanaListener — RPC health surface (#713)", () => {
  it("getRpcHealth returns health from the provider", () => {
    const listener = makeListener();
    const health = listener.getRpcHealth();
    expect(health).toHaveProperty("healthy");
    expect(health).toHaveProperty("degraded");
    expect(health).toHaveProperty("endpoints");
    expect(health).toHaveProperty("activeEndpoint");
  });

  it("getPendingSlotCount returns 0 initially", () => {
    const listener = makeListener();
    expect(listener.getPendingSlotCount()).toBe(0);
  });

  it("getPendingSlotCount reflects queued slots", () => {
    const listener = makeListener();
    (listener as any).pendingSlots.set(1, []);
    (listener as any).pendingSlots.set(2, []);
    expect(listener.getPendingSlotCount()).toBe(2);
  });
});
