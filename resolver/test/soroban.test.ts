/**
 * Tests for SorobanListener:
 *  - lifecycle (timer leak prevention)
 *  - cursor persistence (resume from disk, no advance on RPC failure)
 *  - typed event dispatch (onOrderCreated / onOrderClaimed / onOrderRefunded)
 *
 * @stellar/stellar-sdk rpc.Server is mocked here so no real RPC is needed.
 * XDR decoding is tested separately in soroban-events.test.ts, which runs
 * without any SDK mock so it can use real xdr / nativeToScVal / Address.
 *
 * The SorobanListener's internal `fetchAndProcess` calls
 * `decodeSorobanHtlcEvent` from soroban-events.ts.  In the dispatch tests we
 * inject pre-built base64 XDR payloads via the fake rpc event objects — these
 * are built with the REAL sdk (imported before the mock hoists), which works
 * because nativeToScVal / xdr / Address are only called in helper functions
 * that execute at test runtime, after the mock is already in place, using the
 * real module via the `actual` spread in the factory.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, rmSync } from "fs";
import { join } from "path";
import pino from "pino";
import { SorobanCursorStore } from "../src/utils/cursor-store.js";
import { SorobanListener } from "../src/listeners/soroban.js";

// ── Stellar SDK mock ─────────────────────────────────────────────────────────
// We mock rpc.Server but keep every other export (xdr, nativeToScVal, Address)
// real via `...actual` so the decoder can work correctly.
vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();
  return {
    ...actual,
    rpc: {
      Server: vi.fn().mockImplementation(function () {
        return {
          getLatestLedger: vi.fn().mockResolvedValue({ sequence: 100 }),
          getEvents: vi.fn().mockResolvedValue({ events: [], cursor: undefined }),
        };
      }),
    },
  };
});

// ── Fixtures — built AFTER mock is hoisted, so actual sdk exports are live ───
import { xdr, nativeToScVal, StrKey } from "@stellar/stellar-sdk";

// Fixed raw 32-byte buffers — no Keypair.fromSecret, no StrKey round-trip.
const SENDER_BYTES = Buffer.from("aabbccdd".repeat(8), "hex");
const BENE_BYTES   = Buffer.from("11223344".repeat(8), "hex");
const ASSET_BYTES  = Buffer.from("deadbeef".repeat(8), "hex");

const SENDER = StrKey.encodeEd25519PublicKey(SENDER_BYTES);
const BENE   = StrKey.encodeEd25519PublicKey(BENE_BYTES);
const ASSET  = StrKey.encodeContract(ASSET_BYTES);

const HASHLOCK_BUF = Buffer.alloc(32, 0xab);
const PREIMAGE_BUF = Buffer.from("deadbeef", "hex");
const HASHLOCK_HEX = HASHLOCK_BUF.toString("hex");
const PREIMAGE_HEX = PREIMAGE_BUF.toString("hex");

function b64(v: xdr.ScVal) { return v.toXDR("base64"); }
function sym(s: string)  { return nativeToScVal(s, { type: "symbol" }); }
function addrAccount(raw: Buffer) {
  return xdr.ScVal.scvAddress(
    xdr.ScAddress.scAddressTypeAccount(xdr.AccountId.publicKeyTypeEd25519(raw)),
  );
}
function addrContract(raw: Buffer) {
  return xdr.ScVal.scvAddress(xdr.ScAddress.scAddressTypeContract(raw));
}
function addrSender() { return addrAccount(SENDER_BYTES); }
function addrBene()   { return addrAccount(BENE_BYTES); }
function addrAsset()  { return addrContract(ASSET_BYTES); }
function u64(n: bigint)  { return nativeToScVal(n, { type: "u64" }); }
function i128(n: bigint) { return nativeToScVal(n, { type: "i128" }); }
function byts(b: Buffer) { return nativeToScVal(b, { type: "bytes" }); }
function vec(...els: xdr.ScVal[]) { return xdr.ScVal.scvVec(els); }

function createdTopics() {
  return [sym("created"), addrSender(), addrBene(), byts(HASHLOCK_BUF)].map(b64);
}
function createdValue() {
  return b64(vec(u64(1n), addrAsset(), i128(1000n), i128(50n), u64(9999999n)));
}
function claimedTopics() {
  return [sym("claimed"), addrBene(), byts(HASHLOCK_BUF)].map(b64);
}
function claimedValue() {
  return b64(vec(u64(1n), addrSender(), byts(PREIMAGE_BUF), i128(1000n), i128(50n)));
}
function refundedTopics() {
  return [sym("refunded"), addrSender(), byts(HASHLOCK_BUF)].map(b64);
}
function refundedValue() {
  return b64(vec(u64(1n), addrBene(), i128(1000n), i128(50n)));
}
function adminTopics() {
  return [sym("adm_xfer"), sym("proposed"), addrSender(), addrBene()].map(b64);
}
function adminValue() {
  return b64(vec(addrSender(), addrBene()));
}

// ── Test config ──────────────────────────────────────────────────────────────
const BASE_CFG = {
  network: "testnet" as const,
  pollIntervalMs: 1000,
  coordinatorUrl: "",
  logLevel: "silent" as const,
  ethereum: {
    chainId: 11155111,
    rpcUrl: "",
    htlcEscrow: null,
    resolverRegistry: null,
    resolverPrivateKey: null,
  },
  soroban: {
    rpcUrl: "http://localhost:8000",
    networkPassphrase: "Test SDF Network ; September 2015",
    horizonUrl: "",
    htlc: "CABC",
    resolverRegistry: null,
    resolverSecret: null,
  },
  rpc: { maxRetries: 3, baseDelayMs: 100, maxDelayMs: 2000 },
};
const SILENT_LOG = pino({ level: "silent" });
const TEST_DIR = join(process.cwd(), ".soroban-test-listener");

const noopHandlers = {
  onOrderCreated:  vi.fn(),
  onOrderClaimed:  vi.fn(),
  onOrderRefunded: vi.fn(),
};

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a fake RPC-style event object (topic ScVals as objects with toXDR). */
function fakeRpcEvent(
  topicB64s: string[],
  valueB64: string,
  ledger = 200,
  txHash = "txabc",
  contractId = "CCONTRACT",
) {
  return {
    topic: topicB64s.map((b) => ({ toXDR: (_enc: string) => b })),
    value: { toXDR: (_enc: string) => valueB64 },
    ledger,
    txHash,
    contractId: { toString: () => contractId },
  };
}

/** Build a mock rpc.Server-like object. */
function makeMockServer(opts: {
  sequence?: number;
  events?: unknown[];
  cursor?: string;
} = {}) {
  return {
    getLatestLedger: vi.fn().mockResolvedValue({ sequence: opts.sequence ?? 100 }),
    getEvents: vi.fn().mockResolvedValue({
      events: opts.events ?? [],
      cursor: opts.cursor ?? "0000000000000099",
    }),
  };
}

/** Inject a mock server into the listener's private field. */
function injectServer(
  listener: SorobanListener,
  mock: ReturnType<typeof makeMockServer>,
) {
  (listener as any).server = mock;
}

// ═══════════════════════════════════════════════════════════════════════════
// 1.  Lifecycle
// ═══════════════════════════════════════════════════════════════════════════
describe("SorobanListener lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });
  afterEach(() => {
    vi.useRealTimers();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("can be started and stopped repeatedly without leaking timers", async () => {
    const store    = new SorobanCursorStore({ storageDir: TEST_DIR });
    const listener = new SorobanListener(BASE_CFG, 1000, SILENT_LOG, { cursorStore: store });
    await listener.start(noopHandlers);
    await listener.start(noopHandlers);
    listener.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears timeout on stop", async () => {
    const store    = new SorobanCursorStore({ storageDir: TEST_DIR });
    const listener = new SorobanListener(BASE_CFG, 1000, SILENT_LOG, { cursorStore: store });
    await listener.start(noopHandlers);
    await Promise.resolve();
    listener.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not start when htlc contract id is not configured", async () => {
    const cfg = { ...BASE_CFG, soroban: { ...BASE_CFG.soroban, htlc: null } };
    const store    = new SorobanCursorStore({ storageDir: TEST_DIR });
    const listener = new SorobanListener(cfg, 1000, SILENT_LOG, { cursorStore: store });
    await listener.start(noopHandlers);
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2.  Cursor persistence
// ═══════════════════════════════════════════════════════════════════════════
describe("SorobanListener cursor persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });
  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("persists the cursor returned by RPC after the first poll", async () => {
    const store  = new SorobanCursorStore({ storageDir: TEST_DIR });
    const server = makeMockServer({ cursor: "0000000000000050" });
    const listener = new SorobanListener(BASE_CFG, 60_000, SILENT_LOG, {
      cursorStore: store,
      cursorLabel: "test-persist",
    });
    injectServer(listener, server);

    await listener.start(noopHandlers);
    await new Promise((r) => setTimeout(r, 20));

    expect(store.load("test-persist")).toBe("0000000000000050");
    expect(listener.getCursor()).toBe("0000000000000050");
    listener.stop();
  });

  it("resumes from a pre-seeded cursor and passes it to getEvents", async () => {
    const store = new SorobanCursorStore({ storageDir: TEST_DIR });
    store.save("test-resume", "0000000000000025");

    const server = makeMockServer({ cursor: "0000000000000030" });
    const listener = new SorobanListener(BASE_CFG, 60_000, SILENT_LOG, {
      cursorStore: store,
      cursorLabel: "test-resume",
    });
    injectServer(listener, server);

    await listener.start(noopHandlers);
    await new Promise((r) => setTimeout(r, 20));

    const callArg = (server.getEvents as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(callArg?.cursor).toBe("0000000000000025");
    expect(callArg?.startLedger).toBeUndefined();
    expect(store.load("test-resume")).toBe("0000000000000030");
    listener.stop();
  });

  it("does not advance cursor when RPC getEvents throws", async () => {
    const store = new SorobanCursorStore({ storageDir: TEST_DIR });
    store.save("test-rpc-fail", "0000000000000010");

    const failingServer = {
      getLatestLedger: vi.fn().mockResolvedValue({ sequence: 100 }),
      getEvents: vi.fn().mockRejectedValue(new Error("RPC connection refused")),
    };
    const listener = new SorobanListener(BASE_CFG, 60_000, SILENT_LOG, {
      cursorStore: store,
      cursorLabel: "test-rpc-fail",
    });
    injectServer(listener, failingServer);

    await listener.start(noopHandlers);
    await new Promise((r) => setTimeout(r, 50));

    expect(store.load("test-rpc-fail")).toBe("0000000000000010");
    expect(listener.getCursor()).toBe("0000000000000010");
    listener.stop();
  });

  it("uses startLedger on the very first poll when no cursor is persisted", async () => {
    const store  = new SorobanCursorStore({ storageDir: TEST_DIR });
    const server = makeMockServer({ sequence: 500, cursor: "0000000000000499" });
    const listener = new SorobanListener(BASE_CFG, 60_000, SILENT_LOG, {
      cursorStore: store,
      cursorLabel: "test-fresh-start",
    });
    injectServer(listener, server);

    await listener.start(noopHandlers);
    await new Promise((r) => setTimeout(r, 20));

    const callArg = (server.getEvents as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(callArg?.startLedger).toBe(499); // sequence - 1
    expect(callArg?.cursor).toBeUndefined();
    listener.stop();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3.  Typed event dispatch
// ═══════════════════════════════════════════════════════════════════════════
describe("SorobanListener typed event dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });
  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("calls onOrderCreated with a fully typed payload", async () => {
    const store  = new SorobanCursorStore({ storageDir: TEST_DIR });
    const server = makeMockServer({
      events: [fakeRpcEvent(createdTopics(), createdValue())],
      cursor: "0000000000000001",
    });
    const listener = new SorobanListener(BASE_CFG, 60_000, SILENT_LOG, { cursorStore: store });
    injectServer(listener, server);

    const handlers = { onOrderCreated: vi.fn(), onOrderClaimed: vi.fn(), onOrderRefunded: vi.fn() };
    await listener.start(handlers);
    await new Promise((r) => setTimeout(r, 20));

    expect(handlers.onOrderCreated).toHaveBeenCalledOnce();
    const e = handlers.onOrderCreated.mock.calls[0]![0];
    expect(e.type).toBe("created");
    expect(e.orderId).toBe(1n);
    expect(e.sender).toBe(SENDER);
    expect(e.beneficiary).toBe(BENE);
    expect(e.asset).toBe(ASSET);
    expect(e.amount).toBe(1000n);
    expect(e.safetyDeposit).toBe(50n);
    expect(e.hashlock).toBe(HASHLOCK_HEX);
    expect(handlers.onOrderClaimed).not.toHaveBeenCalled();
    expect(handlers.onOrderRefunded).not.toHaveBeenCalled();
    listener.stop();
  });

  it("calls onOrderClaimed with a fully typed payload", async () => {
    const store  = new SorobanCursorStore({ storageDir: TEST_DIR });
    const server = makeMockServer({
      events: [fakeRpcEvent(claimedTopics(), claimedValue())],
      cursor: "0000000000000002",
    });
    const listener = new SorobanListener(BASE_CFG, 60_000, SILENT_LOG, { cursorStore: store });
    injectServer(listener, server);

    const handlers = { onOrderCreated: vi.fn(), onOrderClaimed: vi.fn(), onOrderRefunded: vi.fn() };
    await listener.start(handlers);
    await new Promise((r) => setTimeout(r, 20));

    expect(handlers.onOrderClaimed).toHaveBeenCalledOnce();
    const e = handlers.onOrderClaimed.mock.calls[0]![0];
    expect(e.type).toBe("claimed");
    expect(e.orderId).toBe(1n);
    expect(e.beneficiary).toBe(BENE);
    expect(e.caller).toBe(SENDER);
    expect(e.preimage).toBe(PREIMAGE_HEX);
    listener.stop();
  });

  it("calls onOrderRefunded with a fully typed payload", async () => {
    const store  = new SorobanCursorStore({ storageDir: TEST_DIR });
    const server = makeMockServer({
      events: [fakeRpcEvent(refundedTopics(), refundedValue())],
      cursor: "0000000000000003",
    });
    const listener = new SorobanListener(BASE_CFG, 60_000, SILENT_LOG, { cursorStore: store });
    injectServer(listener, server);

    const handlers = { onOrderCreated: vi.fn(), onOrderClaimed: vi.fn(), onOrderRefunded: vi.fn() };
    await listener.start(handlers);
    await new Promise((r) => setTimeout(r, 20));

    expect(handlers.onOrderRefunded).toHaveBeenCalledOnce();
    const e = handlers.onOrderRefunded.mock.calls[0]![0];
    expect(e.type).toBe("refunded");
    expect(e.orderId).toBe(1n);
    expect(e.refundAddress).toBe(SENDER);
    expect(e.caller).toBe(BENE);
    listener.stop();
  });

  it("skips admin/config events without calling any handler", async () => {
    const store  = new SorobanCursorStore({ storageDir: TEST_DIR });
    const server = makeMockServer({
      events: [fakeRpcEvent(adminTopics(), adminValue())],
      cursor: "0000000000000004",
    });
    const listener = new SorobanListener(BASE_CFG, 60_000, SILENT_LOG, { cursorStore: store });
    injectServer(listener, server);

    const handlers = { onOrderCreated: vi.fn(), onOrderClaimed: vi.fn(), onOrderRefunded: vi.fn() };
    await listener.start(handlers);
    await new Promise((r) => setTimeout(r, 20));

    expect(handlers.onOrderCreated).not.toHaveBeenCalled();
    expect(handlers.onOrderClaimed).not.toHaveBeenCalled();
    expect(handlers.onOrderRefunded).not.toHaveBeenCalled();
    // Cursor still advances even when all events were skipped
    expect(listener.getCursor()).toBe("0000000000000004");
    listener.stop();
  });

  it("skips a malformed known event and still dispatches later events in the same batch", async () => {
    const store = new SorobanCursorStore({ storageDir: TEST_DIR });
    // bad: scalar value where a vector is expected
    const badEvent  = fakeRpcEvent(createdTopics(), b64(u64(42n)));
    const goodEvent = fakeRpcEvent(claimedTopics(), claimedValue(), 201, "txyyyy");
    const server = makeMockServer({
      events: [badEvent, goodEvent],
      cursor: "0000000000000005",
    });
    const listener = new SorobanListener(BASE_CFG, 60_000, SILENT_LOG, { cursorStore: store });
    injectServer(listener, server);

    const handlers = { onOrderCreated: vi.fn(), onOrderClaimed: vi.fn(), onOrderRefunded: vi.fn() };
    await listener.start(handlers);
    await new Promise((r) => setTimeout(r, 20));

    expect(handlers.onOrderCreated).not.toHaveBeenCalled();
    expect(handlers.onOrderClaimed).toHaveBeenCalledOnce();
    expect(listener.getCursor()).toBe("0000000000000005");
    listener.stop();
  });
});
