import { describe, it, expect, vi, beforeEach, type MockedFunction } from "vitest";
import { createHash } from "node:crypto";
import pino from "pino";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { openDatabase } from "../src/persistence/db.js";
import { OrdersRepository } from "../src/persistence/orders-repo.js";
import { OrderService } from "../src/services/order-service.js";
import { CacheVerifier } from "../src/reconciliation/cache-verifier.js";
import type { CoordinatorConfig } from "../src/config.js";

// ── Mock chain clients ────────────────────────────────────────────────────────

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: vi.fn(() => ({
      getBlockNumber: vi.fn(async () => 20_000n),
      getLogs: vi.fn(async () => []),
    })),
  };
});

vi.mock("@stellar/stellar-sdk", () => ({
  rpc: {
    Server: vi.fn(() => ({
      getLatestLedger: vi.fn(async () => ({ sequence: 200_000 })),
      getEvents: vi.fn(async () => ({ events: [], cursor: null })),
    })),
  },
  scValToNative: vi.fn((v: any) => v),
}));

// ── Test helpers ──────────────────────────────────────────────────────────────

const log = pino({ level: "silent" });

const VALID_ETH_ADDR = "0x1111111111111111111111111111111111111111";
const VALID_STELLAR_ADDR = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422";

// Generate a unique hashlock so tests never collide
let hashlockCounter = 0;
function nextHashlock(): string {
  return "0x" + String(++hashlockCounter).padStart(64, "a");
}

const PREIMAGE_BUF = Buffer.alloc(32, 0xcc);
const VALID_PREIMAGE = "0x" + PREIMAGE_BUF.toString("hex");
const VALID_HASHLOCK = "0x" + createHash("sha256").update(PREIMAGE_BUF).digest("hex");

const BASE_CFG: CoordinatorConfig = {
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
    htlcContract: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA7A6A",
    resolverRegistry: null,
  },
  solana: { rpcUrl: "https://solana.test", programId: "PLACEHOLDER", commitment: "confirmed" },
};

async function freshDb() {
  const dir = mkdtempSync(resolve(tmpdir(), "wafflefinance-verifier-test-"));
  const db = await openDatabase(`file:${dir}/test.db`);
  return { db, repo: new OrdersRepository(db) };
}

async function seedEthOrder(
  orders: OrderService,
  hashlock = nextHashlock(),
  status: "announced" | "src_locked" = "announced"
) {
  const order = await orders.announce({
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
  if (status === "src_locked") {
    await orders.recordSrcLock({
      publicId: order.publicId,
      orderId: "42",
      txHash: "0xabc",
      blockNumber: 100,
      // timelock far in the future so it is NOT an expiry candidate
      timelock: Math.floor(Date.now() / 1000) + 86400,
    });
  }
  return order;
}

// ── Initial state ─────────────────────────────────────────────────────────────

describe("CacheVerifier — initial state", () => {
  it("getStatus() returns null/aligned=true before any run", async () => {
    const { repo } = await freshDb();
    const verifier = new CacheVerifier(BASE_CFG, repo, log);
    const status = verifier.getStatus();
    expect(status.lastRunAt).toBeNull();
    expect(status.lastRunOk).toBeNull();
    expect(status.sampleSize).toBe(0);
    expect(status.mismatches).toHaveLength(0);
    expect(status.aligned).toBe(true);
  });

  it("run() succeeds with no orders and reports aligned=true", async () => {
    const { repo } = await freshDb();
    const verifier = new CacheVerifier(BASE_CFG, repo, log);
    const status = await verifier.run();
    expect(status.lastRunOk).toBe(true);
    expect(status.aligned).toBe(true);
    expect(status.mismatches).toHaveLength(0);
  });

  it("run() returns skipped result (sampleSize=0) when DB is empty", async () => {
    const { repo } = await freshDb();
    const verifier = new CacheVerifier(BASE_CFG, repo, log);
    const status = await verifier.run({ sampleSize: 50 });
    expect(status.sampleSize).toBe(0);
    expect(status.lastRunOk).toBe(true);
  });
});

// ── Aligned cache — no mismatches ─────────────────────────────────────────────

describe("CacheVerifier — aligned cache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports aligned=true when src_locked order matches on-chain OrderCreated", async () => {
    const { db, repo } = await freshDb();
    const orders = new OrderService(repo, log);
    const order = await seedEthOrder(orders, nextHashlock(), "src_locked");

    const { createPublicClient } = await import("viem");
    const mockClient = (createPublicClient as MockedFunction<any>).mock.results.at(-1)?.value;

    // On-chain has the matching OrderCreated event
    mockClient.getLogs.mockImplementation(async ({ event }: any) => {
      if (event?.name === "OrderCreated") {
        return [{ args: { orderId: 42n, hashlock: order.hashlock, timelock: 9999n } }];
      }
      return [];
    });

    const verifier = new CacheVerifier(BASE_CFG, repo, log);
    const status = await verifier.run();
    expect(status.aligned).toBe(true);
    expect(status.mismatches).toHaveLength(0);
  });

  it("reports aligned=true when no on-chain events and DB has only announced orders", async () => {
    const { repo } = await freshDb();
    const orders = new OrderService(repo, log);
    await seedEthOrder(orders, nextHashlock(), "announced");

    const { createPublicClient } = await import("viem");
    const mockClient = (createPublicClient as MockedFunction<any>).mock.results.at(-1)?.value;
    mockClient.getLogs.mockResolvedValue([]);

    const verifier = new CacheVerifier(BASE_CFG, repo, log);
    const status = await verifier.run();
    // Announced + no on-chain events = aligned (no unexpected lock yet)
    expect(status.aligned).toBe(true);
  });
});

// ── Mismatch: src_lock_unexpected ─────────────────────────────────────────────

describe("CacheVerifier — mismatch: src_lock_unexpected", () => {
  beforeEach(() => vi.clearAllMocks());

  it("flags an order as src_lock_unexpected when DB=announced but chain has OrderCreated", async () => {
    const { repo } = await freshDb();
    const orders = new OrderService(repo, log);
    const hashlock = nextHashlock();
    const order = await seedEthOrder(orders, hashlock, "announced");

    const { createPublicClient } = await import("viem");
    const mockClient = (createPublicClient as MockedFunction<any>).mock.results.at(-1)?.value;

    // Chain has a Created event for this hashlock — DB missed it
    mockClient.getLogs.mockImplementation(async ({ event }: any) => {
      if (event?.name === "OrderCreated") {
        return [{ args: { orderId: 99n, hashlock, timelock: 9999n } }];
      }
      return [];
    });

    const verifier = new CacheVerifier(BASE_CFG, repo, log);
    const status = await verifier.run();

    expect(status.aligned).toBe(false);
    expect(status.mismatches).toHaveLength(1);
    const mm = status.mismatches[0];
    expect(mm.mismatchType).toBe("src_lock_unexpected");
    expect(mm.cachedStatus).toBe("announced");
    expect(mm.publicId).toBe(order.publicId);
    expect(mm.chain).toBe("ethereum");
  });

  it("mismatch detail message mentions reconciliation as the fix", async () => {
    const { repo } = await freshDb();
    const orders = new OrderService(repo, log);
    const hashlock = nextHashlock();
    await seedEthOrder(orders, hashlock, "announced");

    const { createPublicClient } = await import("viem");
    const mockClient = (createPublicClient as MockedFunction<any>).mock.results.at(-1)?.value;
    mockClient.getLogs.mockImplementation(async ({ event }: any) => {
      if (event?.name === "OrderCreated") return [{ args: { orderId: 1n, hashlock, timelock: 9999n } }];
      return [];
    });

    const verifier = new CacheVerifier(BASE_CFG, repo, log);
    const status = await verifier.run();
    expect(status.mismatches[0].detail.toLowerCase()).toContain("reconcil");
  });
});

// ── Mismatch: claimed_missing ─────────────────────────────────────────────────

describe("CacheVerifier — mismatch: claimed_missing", () => {
  beforeEach(() => vi.clearAllMocks());

  it("flags claimed_missing when chain has OrderClaimed but DB has no preimage", async () => {
    const { repo } = await freshDb();
    const orders = new OrderService(repo, log);
    // Seed with a valid preimage/hashlock pair so the order has a real srcOrderId
    const order = await orders.announce({
      direction: "eth_to_xlm",
      hashlock: VALID_HASHLOCK,
      srcChain: "ethereum",
      srcAddress: VALID_ETH_ADDR,
      srcAsset: "native",
      srcAmount: "1000000000000000000",
      srcSafetyDeposit: "0",
      dstChain: "stellar",
      dstAddress: VALID_STELLAR_ADDR,
      dstAsset: "native",
      dstAmount: "100000000",
    });
    await orders.recordSrcLock({
      publicId: order.publicId,
      orderId: "77",
      txHash: "0xabc",
      blockNumber: 100,
      timelock: Math.floor(Date.now() / 1000) + 86400,
    });

    const { createPublicClient } = await import("viem");
    const mockClient = (createPublicClient as MockedFunction<any>).mock.results.at(-1)?.value;

    // Chain has an OrderClaimed for orderId=77 — DB has no preimage yet
    mockClient.getLogs.mockImplementation(async ({ event }: any) => {
      if (event?.name === "OrderClaimed") {
        return [{ args: { orderId: 77n, preimage: VALID_PREIMAGE } }];
      }
      return [];
    });

    const verifier = new CacheVerifier(BASE_CFG, repo, log);
    const status = await verifier.run();

    expect(status.aligned).toBe(false);
    const mm = status.mismatches.find((m) => m.mismatchType === "claimed_missing");
    expect(mm).toBeDefined();
    expect(mm!.publicId).toBe(order.publicId);
    expect(mm!.chain).toBe("ethereum");
  });

  it("does NOT flag claimed_missing when DB already has the preimage", async () => {
    const { repo } = await freshDb();
    const orders = new OrderService(repo, log);
    const order = await orders.announce({
      direction: "eth_to_xlm",
      hashlock: VALID_HASHLOCK,
      srcChain: "ethereum",
      srcAddress: VALID_ETH_ADDR,
      srcAsset: "native",
      srcAmount: "1000000000000000000",
      srcSafetyDeposit: "0",
      dstChain: "stellar",
      dstAddress: VALID_STELLAR_ADDR,
      dstAsset: "native",
      dstAmount: "100000000",
    });
    await orders.recordSrcLock({
      publicId: order.publicId,
      orderId: "88",
      txHash: "0xabc",
      blockNumber: 100,
      timelock: Math.floor(Date.now() / 1000) + 86400,
    });
    // Preimage is already in the DB
    await orders.recordSecret(order.publicId, VALID_PREIMAGE, "0xcafe");

    const { createPublicClient } = await import("viem");
    const mockClient = (createPublicClient as MockedFunction<any>).mock.results.at(-1)?.value;
    mockClient.getLogs.mockImplementation(async ({ event }: any) => {
      if (event?.name === "OrderClaimed") {
        return [{ args: { orderId: 88n, preimage: VALID_PREIMAGE } }];
      }
      return [];
    });

    const verifier = new CacheVerifier(BASE_CFG, repo, log);
    const status = await verifier.run();
    expect(status.mismatches.filter((m) => m.mismatchType === "claimed_missing")).toHaveLength(0);
  });
});

// ── Mismatch: refunded_missing ────────────────────────────────────────────────

describe("CacheVerifier — mismatch: refunded_missing", () => {
  beforeEach(() => vi.clearAllMocks());

  it("flags refunded_missing when chain has OrderRefunded but DB is not refunded", async () => {
    const { repo } = await freshDb();
    const orders = new OrderService(repo, log);
    const hashlock = nextHashlock();
    const order = await seedEthOrder(orders, hashlock, "src_locked");
    // DB stays at src_locked — simulating missed refund event

    const { createPublicClient } = await import("viem");
    const mockClient = (createPublicClient as MockedFunction<any>).mock.results.at(-1)?.value;

    mockClient.getLogs.mockImplementation(async ({ event }: any) => {
      if (event?.name === "OrderRefunded") {
        return [{ args: { orderId: 42n } }]; // matches the orderId set by seedEthOrder
      }
      return [];
    });

    const verifier = new CacheVerifier(BASE_CFG, repo, log);
    const status = await verifier.run();

    expect(status.aligned).toBe(false);
    const mm = status.mismatches.find((m) => m.mismatchType === "refunded_missing");
    expect(mm).toBeDefined();
    expect(mm!.publicId).toBe(order.publicId);
  });

  it("does NOT flag refunded_missing when DB is already refunded", async () => {
    const { repo } = await freshDb();
    const orders = new OrderService(repo, log);
    const hashlock = nextHashlock();
    const order = await seedEthOrder(orders, hashlock, "src_locked");
    await orders.markStatus(order.publicId, "refunded");

    // order is terminal (refunded) — findNonTerminalSample will not include it
    const verifier = new CacheVerifier(BASE_CFG, repo, log);
    const status = await verifier.run();
    // sample is empty (terminal order excluded) → skipped
    expect(status.mismatches.filter((m) => m.mismatchType === "refunded_missing")).toHaveLength(0);
  });
});

// ── Targeted verification (targetOrderIds) ────────────────────────────────────

describe("CacheVerifier — targetOrderIds option", () => {
  beforeEach(() => vi.clearAllMocks());

  it("only verifies the specified order IDs, ignoring others", async () => {
    const { repo } = await freshDb();
    const orders = new OrderService(repo, log);
    const hashlock1 = nextHashlock();
    const hashlock2 = nextHashlock();
    const order1 = await seedEthOrder(orders, hashlock1, "announced");
    await seedEthOrder(orders, hashlock2, "announced");

    const { createPublicClient } = await import("viem");
    const mockClient = (createPublicClient as MockedFunction<any>).mock.results.at(-1)?.value;

    // Both hashlocks have on-chain events, but we only ask for order1
    mockClient.getLogs.mockImplementation(async ({ event }: any) => {
      if (event?.name === "OrderCreated") {
        return [
          { args: { orderId: 1n, hashlock: hashlock1, timelock: 9999n } },
          { args: { orderId: 2n, hashlock: hashlock2, timelock: 9999n } },
        ];
      }
      return [];
    });

    const verifier = new CacheVerifier(BASE_CFG, repo, log);
    const status = await verifier.run({ targetOrderIds: [order1.publicId] });

    // Only order1 was in the sample — only one mismatch possible
    expect(status.sampleSize).toBe(1);
    expect(status.mismatches).toHaveLength(1);
    expect(status.mismatches[0].publicId).toBe(order1.publicId);
  });

  it("returns empty mismatches when targetOrderIds refers to unknown IDs", async () => {
    const { repo } = await freshDb();
    const verifier = new CacheVerifier(BASE_CFG, repo, log);
    const status = await verifier.run({ targetOrderIds: ["wf_nonexistent"] });
    expect(status.mismatches).toHaveLength(0);
    expect(status.aligned).toBe(true);
  });
});

// ── RPC failure resilience ────────────────────────────────────────────────────

describe("CacheVerifier — RPC failure resilience", () => {
  beforeEach(() => vi.clearAllMocks());

  it("marks lastRunOk=false but never throws when getBlockNumber fails", async () => {
    const { repo } = await freshDb();
    const orders = new OrderService(repo, log);
    await seedEthOrder(orders, nextHashlock(), "src_locked");

    const { createPublicClient } = await import("viem");
    const mockClient = (createPublicClient as MockedFunction<any>).mock.results.at(-1)?.value;
    mockClient.getBlockNumber.mockRejectedValue(new Error("RPC timeout"));

    const verifier = new CacheVerifier(BASE_CFG, repo, log);

    // Must not throw
    let status: Awaited<ReturnType<typeof verifier.run>>;
    await expect(async () => {
      status = await verifier.run();
    }).not.toThrow();

    // getBlockNumber failure causes verifyEthereum to skip — run still ok
    expect(status!.lastRunOk).toBe(true);
    expect(status!.mismatches).toHaveLength(0);
  });

  it("marks lastRunOk=false when getBlockNumber throws at the top-level run", async () => {
    // Simulate a failure that propagates all the way through run()
    const { repo } = await freshDb();
    const orders = new OrderService(repo, log);
    await seedEthOrder(orders, nextHashlock(), "src_locked");

    // Make findNonTerminalSample throw to trigger the top-level catch
    const brokenRepo = Object.create(repo);
    brokenRepo.findNonTerminalSample = async () => { throw new Error("DB gone"); };

    const verifier = new CacheVerifier(BASE_CFG, brokenRepo, log);
    const status = await verifier.run();

    expect(status.lastRunOk).toBe(false);
    expect(status.aligned).toBe(false);
  });
});

// ── readiness integration: cacheAlignmentCheck ───────────────────────────────

describe("createReadinessChecks — cache_alignment check", () => {
  it("emits cache_alignment check with detail=not_run_yet before first verifier run", async () => {
    const { db } = await freshDb();
    const { createReadinessChecks } = await import("../src/readiness.js");

    const checks = await createReadinessChecks({
      cfg: {
        network: "testnet",
        port: 3001,
        databaseUrl: "file:./wafflefinance.db",
        logLevel: "error",
        corsOrigin: "*",
        pollIntervalMs: 15_000,
        secretStorageKey: undefined,
        ethereum: { rpcUrl: "https://eth.example", chainId: 11_155_111, htlcEscrow: null, resolverRegistry: null },
        soroban: { rpcUrl: "https://soroban.example", horizonUrl: "https://horizon.example", networkPassphrase: "Test SDF Network ; September 2015", htlcContract: null, resolverRegistry: null },
        solana: { rpcUrl: "https://solana.example", programId: "PLACEHOLDER", commitment: "confirmed" },
      },
      db,
      getReconciliationStatus: () => ({ lastRunAt: Date.now(), lastRunOk: true, eventsReplayed: 0 }),
      fetcher: async () => ({ ok: true, status: 200, json: async () => ({ result: "ok" }) }),
      timeoutMs: 10,
      getCacheVerificationStatus: () => ({
        lastRunOk: null,
        lastRunAt: null,
        sampleSize: 0,
        mismatches: [],
        aligned: true,
        incompleteEvents: 0,
      }),
    })();

    const cacheCheck = checks.find((c) => c.name === "cache_alignment");
    expect(cacheCheck).toBeDefined();
    expect(cacheCheck!.ok).toBe(true);
    expect(cacheCheck!.detail).toBe("not_run_yet");
  });

  it("emits cache_alignment ok=false when verifier found mismatches", async () => {
    const { db } = await freshDb();
    const { createReadinessChecks } = await import("../src/readiness.js");

    const checks = await createReadinessChecks({
      cfg: {
        network: "testnet",
        port: 3001,
        databaseUrl: "file:./wafflefinance.db",
        logLevel: "error",
        corsOrigin: "*",
        pollIntervalMs: 15_000,
        secretStorageKey: undefined,
        ethereum: { rpcUrl: "https://eth.example", chainId: 11_155_111, htlcEscrow: null, resolverRegistry: null },
        soroban: { rpcUrl: "https://soroban.example", horizonUrl: "https://horizon.example", networkPassphrase: "Test SDF Network ; September 2015", htlcContract: null, resolverRegistry: null },
        solana: { rpcUrl: "https://solana.example", programId: "PLACEHOLDER", commitment: "confirmed" },
      },
      db,
      getReconciliationStatus: () => ({ lastRunAt: Date.now(), lastRunOk: true, eventsReplayed: 0 }),
      fetcher: async () => ({ ok: true, status: 200, json: async () => ({ result: "ok" }) }),
      timeoutMs: 10,
      getCacheVerificationStatus: () => ({
        lastRunOk: true,
        lastRunAt: Date.now(),
        sampleSize: 10,
        aligned: false,
        incompleteEvents: 0,
        mismatches: [
          {
            publicId: "wf_0xaaaa",
            hashlock: "0xaaaa",
            chain: "ethereum",
            mismatchType: "src_lock_unexpected",
            cachedStatus: "announced",
            detail: "DB says announced but chain has a lock event",
          },
          {
            publicId: "wf_0xbbbb",
            hashlock: "0xbbbb",
            chain: "ethereum",
            mismatchType: "claimed_missing",
            cachedStatus: "src_locked",
            detail: "Chain claimed but DB has no preimage",
          },
        ],
      }),
    })();

    const cacheCheck = checks.find((c) => c.name === "cache_alignment");
    expect(cacheCheck!.ok).toBe(false);
    expect(cacheCheck!.detail).toBe("mismatches_detected:2");
  });

  it("emits cache_alignment ok=false when verifier run itself failed", async () => {
    const { db } = await freshDb();
    const { createReadinessChecks } = await import("../src/readiness.js");

    const checks = await createReadinessChecks({
      cfg: {
        network: "testnet",
        port: 3001,
        databaseUrl: "file:./wafflefinance.db",
        logLevel: "error",
        corsOrigin: "*",
        pollIntervalMs: 15_000,
        secretStorageKey: undefined,
        ethereum: { rpcUrl: "https://eth.example", chainId: 11_155_111, htlcEscrow: null, resolverRegistry: null },
        soroban: { rpcUrl: "https://soroban.example", horizonUrl: "https://horizon.example", networkPassphrase: "Test SDF Network ; September 2015", htlcContract: null, resolverRegistry: null },
        solana: { rpcUrl: "https://solana.example", programId: "PLACEHOLDER", commitment: "confirmed" },
      },
      db,
      getReconciliationStatus: () => ({ lastRunAt: Date.now(), lastRunOk: true, eventsReplayed: 0 }),
      fetcher: async () => ({ ok: true, status: 200, json: async () => ({ result: "ok" }) }),
      timeoutMs: 10,
      getCacheVerificationStatus: () => ({
        lastRunOk: false,
        lastRunAt: Date.now(),
        sampleSize: 0,
        mismatches: [],
        aligned: false,
        incompleteEvents: 0,
      }),
    })();

    const cacheCheck = checks.find((c) => c.name === "cache_alignment");
    expect(cacheCheck!.ok).toBe(false);
    expect(cacheCheck!.detail).toBe("verifier_error");
  });

  it("emits cache_alignment ok=true with detail=aligned after a clean run", async () => {
    const { db } = await freshDb();
    const { createReadinessChecks } = await import("../src/readiness.js");

    const checks = await createReadinessChecks({
      cfg: {
        network: "testnet",
        port: 3001,
        databaseUrl: "file:./wafflefinance.db",
        logLevel: "error",
        corsOrigin: "*",
        pollIntervalMs: 15_000,
        secretStorageKey: undefined,
        ethereum: { rpcUrl: "https://eth.example", chainId: 11_155_111, htlcEscrow: null, resolverRegistry: null },
        soroban: { rpcUrl: "https://soroban.example", horizonUrl: "https://horizon.example", networkPassphrase: "Test SDF Network ; September 2015", htlcContract: null, resolverRegistry: null },
        solana: { rpcUrl: "https://solana.example", programId: "PLACEHOLDER", commitment: "confirmed" },
      },
      db,
      getReconciliationStatus: () => ({ lastRunAt: Date.now(), lastRunOk: true, eventsReplayed: 0 }),
      fetcher: async () => ({ ok: true, status: 200, json: async () => ({ result: "ok" }) }),
      timeoutMs: 10,
      getCacheVerificationStatus: () => ({
        lastRunOk: true,
        lastRunAt: Date.now(),
        sampleSize: 12,
        mismatches: [],
        aligned: true,
        incompleteEvents: 0,
      }),
    })();

    const cacheCheck = checks.find((c) => c.name === "cache_alignment");
    expect(cacheCheck!.ok).toBe(true);
    expect(cacheCheck!.detail).toBe("aligned");
  });

  it("omits cache_alignment check entirely when getCacheVerificationStatus is not provided", async () => {
    const { db } = await freshDb();
    const { createReadinessChecks } = await import("../src/readiness.js");

    const checks = await createReadinessChecks({
      cfg: {
        network: "testnet",
        port: 3001,
        databaseUrl: "file:./wafflefinance.db",
        logLevel: "error",
        corsOrigin: "*",
        pollIntervalMs: 15_000,
        secretStorageKey: undefined,
        ethereum: { rpcUrl: "https://eth.example", chainId: 11_155_111, htlcEscrow: null, resolverRegistry: null },
        soroban: { rpcUrl: "https://soroban.example", horizonUrl: "https://horizon.example", networkPassphrase: "Test SDF Network ; September 2015", htlcContract: null, resolverRegistry: null },
        solana: { rpcUrl: "https://solana.example", programId: "PLACEHOLDER", commitment: "confirmed" },
      },
      db,
      getReconciliationStatus: () => ({ lastRunAt: Date.now(), lastRunOk: true, eventsReplayed: 0 }),
      fetcher: async () => ({ ok: true, status: 200, json: async () => ({ result: "ok" }) }),
      timeoutMs: 10,
      // no getCacheVerificationStatus
    })();

    expect(checks.find((c) => c.name === "cache_alignment")).toBeUndefined();
  });
});

// ── #577: incomplete cache-verifier events ────────────────────────────────────

describe("CacheVerifier — #577: malformed/incomplete events", () => {
  beforeEach(() => vi.clearAllMocks());

  it("skips an OrderCreated event with missing hashlock, records incompleteEvents=1, no repair attempted", async () => {
    const { repo } = await freshDb();
    const orders = new OrderService(repo, log);
    await seedEthOrder(orders, nextHashlock(), "announced");

    const { createPublicClient } = await import("viem");
    const mockClient = (createPublicClient as MockedFunction<any>).mock.results.at(-1)?.value;

    // Malformed: args exist but hashlock is undefined
    mockClient.getLogs.mockImplementation(async ({ event }: any) => {
      if (event?.name === "OrderCreated") {
        return [{ args: { orderId: 1n /* no hashlock */ } }];
      }
      return [];
    });

    const verifier = new CacheVerifier(BASE_CFG, repo, log);
    const status = await verifier.run();

    // No repair should have been attempted — mismatches is empty
    expect(status.mismatches).toHaveLength(0);
    // Incomplete event was recorded
    expect(status.incompleteEvents).toBe(1);
    expect(status.aligned).toBe(true);
    expect(status.lastRunOk).toBe(true);
  });

  it("skips an OrderClaimed event with missing orderId, records incompleteEvents=1", async () => {
    const { repo } = await freshDb();
    const orders = new OrderService(repo, log);
    await seedEthOrder(orders, nextHashlock(), "src_locked");

    const { createPublicClient } = await import("viem");
    const mockClient = (createPublicClient as MockedFunction<any>).mock.results.at(-1)?.value;

    mockClient.getLogs.mockImplementation(async ({ event }: any) => {
      if (event?.name === "OrderClaimed") {
        return [{ args: { preimage: "0xdeadbeef" /* no orderId */ } }];
      }
      return [];
    });

    const verifier = new CacheVerifier(BASE_CFG, repo, log);
    const status = await verifier.run();

    expect(status.mismatches).toHaveLength(0);
    expect(status.incompleteEvents).toBe(1);
  });

  it("complete events retain their normal verification behavior alongside malformed ones", async () => {
    const { repo } = await freshDb();
    const orders = new OrderService(repo, log);
    const hashlock = nextHashlock();
    await seedEthOrder(orders, hashlock, "announced");

    const { createPublicClient } = await import("viem");
    const mockClient = (createPublicClient as MockedFunction<any>).mock.results.at(-1)?.value;

    mockClient.getLogs.mockImplementation(async ({ event }: any) => {
      if (event?.name === "OrderCreated") {
        return [
          { args: { orderId: 1n /* no hashlock — malformed */ } },
          { args: { orderId: 2n, hashlock, timelock: 9999n } }, // valid
        ];
      }
      return [];
    });

    const verifier = new CacheVerifier(BASE_CFG, repo, log);
    const status = await verifier.run();

    // Malformed event counted
    expect(status.incompleteEvents).toBe(1);
    // Valid event produced a mismatch (DB=announced but chain has lock)
    expect(status.mismatches).toHaveLength(1);
    expect(status.mismatches[0].mismatchType).toBe("src_lock_unexpected");
  });
});
