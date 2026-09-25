/**
 * Tests for SorobanListener (updated interface):
 *  1. Lifecycle (timer leak prevention, stop/start)
 *  2. Cursor persistence (resume, no advance on failure)
 *  3. Typed event dispatch (onOrderCreated / onOrderClaimed / onOrderRefunded)
 *  4. Per-event-type metrics (created / claimed / refunded / unknown)
 *  5. onUnknownEvent callback
 *  6. Deduplication (restart-overlap, same batch)
 *  7. Stale-cursor / history-window overflow handling
 *  8. Malformed event: skip + increment error metric, continue processing
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, rmSync } from "fs";
import { join } from "path";
import pino from "pino";
import { SorobanCursorStore } from "../src/utils/cursor-store.js";
import { SorobanListener } from "../src/listeners/soroban.js";

// ── Stellar SDK mock ─────────────────────────────────────────────────────────
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

// ── Import real SDK exports after mock is hoisted ───────────────────────────
import { xdr, nativeToScVal, StrKey } from "@stellar/stellar-sdk";

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

function makeMockServer(opts: {
  sequence?: number;
  events?: unknown[];
  cursor?: string;
  getEventsImpl?: () => Promise<unknown>;
} = {}) {
  const defaultGetEvents = vi.fn().mockResolvedValue({
    events: opts.events ?? [],
    cursor: opts.cursor ?? "0000000000000099",
  });
  return {
    getLatestLedger: vi.fn().mockResolvedValue({ sequence: opts.sequence ?? 100 }),
    getEvents: opts.getEventsImpl
      ? vi.fn().mockImplementation(opts.getEventsImpl)
      : defaultGetEvents,
  };
}

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

  it("restart clears the previous timer so only one schedule is active", async () => {
    // Verifies the stop/start path: starting a second time must cancel the
    // timer created by the first start so there is never more than one
    // outstanding poll schedule after a restart.
    const store    = new SorobanCursorStore({ storageDir: TEST_DIR });
    const listener = new SorobanListener(BASE_CFG, 1_000, SILENT_LOG, { cursorStore: store });

    const server = makeMockServer({ events: [], cursor: "0000000000000099" });
    injectServer(listener, server);

    // First start — spawns one tick which, after resolving, sets one timer.
    await listener.start(noopHandlers);
    await Promise.resolve(); // let the first tick complete
    const afterFirstStart = vi.getTimerCount();

    // Second start — must cancel the first timer before scheduling a new one.
    await listener.start(noopHandlers);
    await Promise.resolve();
    const afterRestart = vi.getTimerCount();

    // At most one timer active at any point.
    expect(afterFirstStart).toBeLessThanOrEqual(1);
    expect(afterRestart).toBeLessThanOrEqual(1);

    // Stopping eliminates all timers.
    listener.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stopping after restart prevents future poll callbacks", async () => {
    const store    = new SorobanCursorStore({ storageDir: TEST_DIR });
    const listener = new SorobanListener(BASE_CFG, 50, SILENT_LOG, { cursorStore: store });

    const handlers = { onOrderCreated: vi.fn(), onOrderClaimed: vi.fn(), onOrderRefunded: vi.fn() };
    const event    = fakeRpcEvent(createdTopics(), createdValue(), 200, "txrestartstop");
    const server   = makeMockServer({ events: [event], cursor: "0000000000000099" });
    injectServer(listener, server);

    // start → let first tick complete → stop
    await listener.start(handlers);
    await Promise.resolve(); // flush microtasks so the async tick completes
    listener.stop();
    // No pending timers immediately after stop.
    expect(vi.getTimerCount()).toBe(0);

    const countAfterFirstStop = handlers.onOrderCreated.mock.calls.length;

    // Confirm no phantom timer fires after advancing fake time.
    vi.advanceTimersByTime(200);
    expect(handlers.onOrderCreated.mock.calls.length).toBe(countAfterFirstStop);

    // Restart → let first tick complete → stop again.
    await listener.start(handlers);
    await Promise.resolve();
    listener.stop();
    // No pending timers after second stop either.
    expect(vi.getTimerCount()).toBe(0);

    vi.advanceTimersByTime(200);
    const countAfterSecondStop = handlers.onOrderCreated.mock.calls.length;

    // At most 2 dispatches total (one per start's first tick).
    expect(countAfterSecondStop).toBeLessThanOrEqual(2);
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
      cursorStore: store, cursorLabel: "test-persist",
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
      cursorStore: store, cursorLabel: "test-resume",
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
      cursorStore: store, cursorLabel: "test-rpc-fail",
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
      cursorStore: store, cursorLabel: "test-fresh-start",
    });
    injectServer(listener, server);
    await listener.start(noopHandlers);
    await new Promise((r) => setTimeout(r, 20));
    const callArg = (server.getEvents as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(callArg?.startLedger).toBe(499);
    expect(callArg?.cursor).toBeUndefined();
    listener.stop();
  });

  it("does not advance cursor when a handler throws an error, allowing retry", async () => {
    const store = new SorobanCursorStore({ storageDir: TEST_DIR });
    store.save("test-handler-fail", "0000000000000010");
    const server = makeMockServer({
      events: [fakeRpcEvent(createdTopics(), createdValue())],
      cursor: "0000000000000011",
    });
    // Set a very short poll interval so it retries quickly
    const listener = new SorobanListener(BASE_CFG, 10, SILENT_LOG, {
      cursorStore: store, cursorLabel: "test-handler-fail",
    });
    injectServer(listener, server);
    
    // Make the handler throw on the first call, succeed on the second
    let calls = 0;
    let firstCallTime = 0;
    const handlers = {
      onOrderCreated: vi.fn().mockImplementation(() => {
        calls++;
        if (calls === 1) {
            firstCallTime = Date.now();
            throw new Error("handler failed");
        }
      }),
      onOrderClaimed: vi.fn(),
      onOrderRefunded: vi.fn(),
    };
    
    await listener.start(handlers);
    
    // Wait for the first call to fail
    await vi.waitFor(() => {
      expect(calls).toBeGreaterThanOrEqual(1);
    });
    
    // Cursor should NOT be advanced because the handler threw
    expect(store.load("test-handler-fail")).toBe("0000000000000010");
    expect(listener.getCursor()).toBe("0000000000000010");
    
    // Wait for the second call to succeed
    await vi.waitFor(() => {
      expect(calls).toBeGreaterThanOrEqual(2);
    });
    
    // Cursor should now be advanced
    expect(store.load("test-handler-fail")).toBe("0000000000000011");
    expect(listener.getCursor()).toBe("0000000000000011");
    
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
    expect(e.refundAddress).toBe(SENDER);
    expect(e.caller).toBe(BENE);
    listener.stop();
  });

  it("skips a malformed known event and dispatches the next event in the same batch", async () => {
    const store = new SorobanCursorStore({ storageDir: TEST_DIR });
    const badEvent  = fakeRpcEvent(createdTopics(), b64(u64(42n)));
    const goodEvent = fakeRpcEvent(claimedTopics(), claimedValue(), 201, "txyyyy");
    const server = makeMockServer({ events: [badEvent, goodEvent], cursor: "0000000000000005" });
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

// ═══════════════════════════════════════════════════════════════════════════
// 4.  Per-event-type metrics
// ═══════════════════════════════════════════════════════════════════════════
describe("SorobanListener per-event-type metrics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });
  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("increments eventsTotal with event_type=created for a created event", async () => {
    const { eventsTotal } = await import("../src/metrics.js");
    const incSpy = vi.spyOn(eventsTotal, "inc");
    const store  = new SorobanCursorStore({ storageDir: TEST_DIR });
    const server = makeMockServer({
      events: [fakeRpcEvent(createdTopics(), createdValue())],
      cursor: "0000000000000010",
    });
    const listener = new SorobanListener(BASE_CFG, 60_000, SILENT_LOG, { cursorStore: store });
    injectServer(listener, server);
    await listener.start(noopHandlers);
    await new Promise((r) => setTimeout(r, 20));
    const createdCall = incSpy.mock.calls.find(
      (c) => (c[0] as any)?.event_type === "created",
    );
    expect(createdCall).toBeDefined();
    expect((createdCall![0] as any).chain).toBe("soroban");
    listener.stop();
    incSpy.mockRestore();
  });

  it("increments eventsTotal with event_type=claimed for a claimed event", async () => {
    const { eventsTotal } = await import("../src/metrics.js");
    const incSpy = vi.spyOn(eventsTotal, "inc");
    const store  = new SorobanCursorStore({ storageDir: TEST_DIR });
    const server = makeMockServer({
      events: [fakeRpcEvent(claimedTopics(), claimedValue())],
      cursor: "0000000000000011",
    });
    const listener = new SorobanListener(BASE_CFG, 60_000, SILENT_LOG, { cursorStore: store });
    injectServer(listener, server);
    await listener.start(noopHandlers);
    await new Promise((r) => setTimeout(r, 20));
    const claimedCall = incSpy.mock.calls.find(
      (c) => (c[0] as any)?.event_type === "claimed",
    );
    expect(claimedCall).toBeDefined();
    listener.stop();
    incSpy.mockRestore();
  });

  it("increments eventsTotal with event_type=refunded for a refunded event", async () => {
    const { eventsTotal } = await import("../src/metrics.js");
    const incSpy = vi.spyOn(eventsTotal, "inc");
    const store  = new SorobanCursorStore({ storageDir: TEST_DIR });
    const server = makeMockServer({
      events: [fakeRpcEvent(refundedTopics(), refundedValue())],
      cursor: "0000000000000012",
    });
    const listener = new SorobanListener(BASE_CFG, 60_000, SILENT_LOG, { cursorStore: store });
    injectServer(listener, server);
    await listener.start(noopHandlers);
    await new Promise((r) => setTimeout(r, 20));
    const refundedCall = incSpy.mock.calls.find(
      (c) => (c[0] as any)?.event_type === "refunded",
    );
    expect(refundedCall).toBeDefined();
    listener.stop();
    incSpy.mockRestore();
  });

  it("increments eventsTotal with event_type=unknown for a non-HTLC event", async () => {
    const { eventsTotal } = await import("../src/metrics.js");
    const incSpy = vi.spyOn(eventsTotal, "inc");
    const store  = new SorobanCursorStore({ storageDir: TEST_DIR });
    const server = makeMockServer({
      events: [fakeRpcEvent(adminTopics(), adminValue())],
      cursor: "0000000000000013",
    });
    const listener = new SorobanListener(BASE_CFG, 60_000, SILENT_LOG, { cursorStore: store });
    injectServer(listener, server);
    await listener.start(noopHandlers);
    await new Promise((r) => setTimeout(r, 20));
    const unknownCall = incSpy.mock.calls.find(
      (c) => (c[0] as any)?.event_type === "unknown",
    );
    expect(unknownCall).toBeDefined();
    listener.stop();
    incSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5.  onUnknownEvent callback
// ═══════════════════════════════════════════════════════════════════════════
describe("SorobanListener onUnknownEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });
  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("calls onUnknownEvent for admin/config events and skips HTLC handlers", async () => {
    const store  = new SorobanCursorStore({ storageDir: TEST_DIR });
    const server = makeMockServer({
      events: [fakeRpcEvent(adminTopics(), adminValue())],
      cursor: "0000000000000004",
    });
    const listener = new SorobanListener(BASE_CFG, 60_000, SILENT_LOG, { cursorStore: store });
    injectServer(listener, server);
    const onUnknownEvent = vi.fn();
    const handlers = {
      onOrderCreated:  vi.fn(),
      onOrderClaimed:  vi.fn(),
      onOrderRefunded: vi.fn(),
      onUnknownEvent,
    };
    await listener.start(handlers);
    await new Promise((r) => setTimeout(r, 20));
    expect(handlers.onOrderCreated).not.toHaveBeenCalled();
    expect(handlers.onOrderClaimed).not.toHaveBeenCalled();
    expect(handlers.onOrderRefunded).not.toHaveBeenCalled();
    expect(onUnknownEvent).toHaveBeenCalledOnce();
    const arg = onUnknownEvent.mock.calls[0]![0];
    expect(arg.topics).toBeInstanceOf(Array);
    expect(arg.topics.length).toBeGreaterThan(0);
    expect(typeof arg.ledger).toBe("number");
    expect(typeof arg.txHash).toBe("string");
    expect(typeof arg.contractId).toBe("string");
    // Cursor still advances even when all events were unknown
    expect(listener.getCursor()).toBe("0000000000000004");
    listener.stop();
  });

  it("does not require onUnknownEvent to be provided (optional callback)", async () => {
    const store  = new SorobanCursorStore({ storageDir: TEST_DIR });
    const server = makeMockServer({
      events: [fakeRpcEvent(adminTopics(), adminValue())],
      cursor: "0000000000000007",
    });
    const listener = new SorobanListener(BASE_CFG, 60_000, SILENT_LOG, { cursorStore: store });
    injectServer(listener, server);
    // No onUnknownEvent — must not throw
    await expect(
      listener.start({ onOrderCreated: vi.fn(), onOrderClaimed: vi.fn(), onOrderRefunded: vi.fn() })
        .then(() => new Promise((r) => setTimeout(r, 20)))
    ).resolves.toBeUndefined();
    listener.stop();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6.  Deduplication
// ═══════════════════════════════════════════════════════════════════════════
describe("SorobanListener deduplication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });
  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("does not double-fire the same event when returned in two consecutive polls", async () => {
    const store  = new SorobanCursorStore({ storageDir: TEST_DIR });
    // Both polls return the same event (simulates cursor overlap on resume).
    const event = fakeRpcEvent(createdTopics(), createdValue(), 200, "txdedup");
    let callCount = 0;
    const getEventsImpl = async () => {
      callCount++;
      return { events: [event], cursor: "0000000000000020" };
    };
    const server = {
      getLatestLedger: vi.fn().mockResolvedValue({ sequence: 200 }),
      getEvents: vi.fn().mockImplementation(getEventsImpl),
    };
    const listener = new SorobanListener(BASE_CFG, 5, SILENT_LOG, { cursorStore: store });
    injectServer(listener, server);
    const handlers = { onOrderCreated: vi.fn(), onOrderClaimed: vi.fn(), onOrderRefunded: vi.fn() };
    await listener.start(handlers);
    // Wait long enough for at least 2 poll ticks.
    await new Promise((r) => setTimeout(r, 80));
    listener.stop();
    // Handler must be called exactly once despite multiple polls returning the same event.
    expect(handlers.onOrderCreated).toHaveBeenCalledOnce();
  });

  it("dedup window tracks processed events — getDedupSize increases", async () => {
    const store  = new SorobanCursorStore({ storageDir: TEST_DIR });
    const server = makeMockServer({
      events: [
        fakeRpcEvent(createdTopics(), createdValue(), 200, "txA"),
        fakeRpcEvent(claimedTopics(), claimedValue(), 201, "txB"),
      ],
      cursor: "0000000000000030",
    });
    const listener = new SorobanListener(BASE_CFG, 60_000, SILENT_LOG, { cursorStore: store });
    injectServer(listener, server);
    await listener.start(noopHandlers);
    await new Promise((r) => setTimeout(r, 20));
    expect(listener.getDedupSize()).toBe(2);
    listener.stop();
  });

  it("restart simulation: second listener instance dispatches previously-seen events exactly once", async () => {
    // First run: process an event and persist cursor.
    const store = new SorobanCursorStore({ storageDir: TEST_DIR });
    const event = fakeRpcEvent(createdTopics(), createdValue(), 200, "txrestart");
    const server1 = makeMockServer({ events: [event], cursor: "0000000000000040" });
    const listener1 = new SorobanListener(BASE_CFG, 60_000, SILENT_LOG, {
      cursorStore: store, cursorLabel: "restart-dedup",
    });
    injectServer(listener1, server1);
    const handlers1 = { onOrderCreated: vi.fn(), onOrderClaimed: vi.fn(), onOrderRefunded: vi.fn() };
    await listener1.start(handlers1);
    await new Promise((r) => setTimeout(r, 20));
    expect(handlers1.onOrderCreated).toHaveBeenCalledOnce();
    listener1.stop();

    // Second run (simulated restart): same cursor in store, RPC returns same event in overlap.
    const store2 = new SorobanCursorStore({ storageDir: TEST_DIR });
    // Second instance has its own empty dedup set — but the cursor already
    // advanced past this event so the RPC should NOT return it again.
    // We simulate proper RPC behaviour: cursor advanced, no duplicate events.
    const server2 = makeMockServer({ events: [], cursor: "0000000000000041" });
    const listener2 = new SorobanListener(BASE_CFG, 60_000, SILENT_LOG, {
      cursorStore: store2, cursorLabel: "restart-dedup",
    });
    injectServer(listener2, server2);
    const handlers2 = { onOrderCreated: vi.fn(), onOrderClaimed: vi.fn(), onOrderRefunded: vi.fn() };
    await listener2.start(handlers2);
    await new Promise((r) => setTimeout(r, 20));
    // No duplicate dispatch — cursor was advanced, RPC returns no overlap.
    expect(handlers2.onOrderCreated).not.toHaveBeenCalled();
    listener2.stop();
  });

  it("in-process dedup blocks the same event returned twice in one poll batch", async () => {
    const store  = new SorobanCursorStore({ storageDir: TEST_DIR });
    const dupEvent = fakeRpcEvent(createdTopics(), createdValue(), 200, "txdup");
    const server = makeMockServer({
      events: [dupEvent, dupEvent], // same object twice in one batch
      cursor: "0000000000000050",
    });
    const listener = new SorobanListener(BASE_CFG, 60_000, SILENT_LOG, { cursorStore: store });
    injectServer(listener, server);
    const handlers = { onOrderCreated: vi.fn(), onOrderClaimed: vi.fn(), onOrderRefunded: vi.fn() };
    await listener.start(handlers);
    await new Promise((r) => setTimeout(r, 20));
    // Only one dispatch despite two identical entries in the batch.
    expect(handlers.onOrderCreated).toHaveBeenCalledOnce();
    listener.stop();
  });

  it("same-batch dedup: duplicate suppressed, distinct event in same batch still dispatches", async () => {
    // This fixture explicitly models provider replay / pagination overlap where
    // the RPC returns the same event twice alongside a different event.
    // Expected: the duplicate fires exactly once, the distinct event fires once,
    // cursor advances to the value returned by the batch.
    const store = new SorobanCursorStore({ storageDir: TEST_DIR });

    const dupEvent      = fakeRpcEvent(createdTopics(),  createdValue(),  200, "txsame");
    const distinctEvent = fakeRpcEvent(claimedTopics(),  claimedValue(),  201, "txother");

    const server = makeMockServer({
      // Two identical entries simulate a duplicated event in the same batch;
      // the third entry is a distinct event that must still be dispatched.
      events: [dupEvent, dupEvent, distinctEvent],
      cursor: "0000000000000060",
    });
    const listener = new SorobanListener(BASE_CFG, 60_000, SILENT_LOG, { cursorStore: store });
    injectServer(listener, server);

    const handlers = {
      onOrderCreated:  vi.fn(),
      onOrderClaimed:  vi.fn(),
      onOrderRefunded: vi.fn(),
    };
    await listener.start(handlers);
    await new Promise((r) => setTimeout(r, 20));

    // Duplicate is suppressed — exactly one created callback.
    expect(handlers.onOrderCreated).toHaveBeenCalledOnce();
    // Distinct event is dispatched independently.
    expect(handlers.onOrderClaimed).toHaveBeenCalledOnce();
    // Cursor advanced to the value the RPC returned for this batch.
    expect(listener.getCursor()).toBe("0000000000000060");
    listener.stop();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7.  Stale-cursor / history-window overflow
// ═══════════════════════════════════════════════════════════════════════════
describe("SorobanListener stale-cursor / history-window overflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });
  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("recovers from history-window error: clamps to latest ledger and retries", async () => {
    const store = new SorobanCursorStore({ storageDir: TEST_DIR });
    // Seed a stale cursor.
    store.save("test-stale", "0000000000000001");

    let callCount = 0;
    const getEventsImpl = async () => {
      callCount++;
      if (callCount === 1) {
        // First call: simulate history-window error.
        throw new Error("start ledger must be within the ledger retention window");
      }
      // Second call (after clamp): succeed with no events.
      return { events: [], cursor: "0000000000000999" };
    };
    const server = {
      getLatestLedger: vi.fn().mockResolvedValue({ sequence: 1000 }),
      getEvents: vi.fn().mockImplementation(getEventsImpl),
    };

    const listener = new SorobanListener(BASE_CFG, 60_000, SILENT_LOG, {
      cursorStore: store, cursorLabel: "test-stale",
    });
    injectServer(listener, server);
    await listener.start(noopHandlers);
    await new Promise((r) => setTimeout(r, 50));

    // Two getEvents calls: first throws, second succeeds.
    expect((server.getEvents as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2);
    // After recovery, the cursor should be updated to the new position.
    expect(listener.getCursor()).toBe("0000000000000999");
    // The stale cursor was cleared internally.
    listener.stop();
  });

  it("increments history_window_overflow error metric on stale-cursor error", async () => {
    const { listenerErrorsTotal } = await import("../src/metrics.js");
    const incSpy = vi.spyOn(listenerErrorsTotal, "inc");

    const store = new SorobanCursorStore({ storageDir: TEST_DIR });
    store.save("test-overflow-metric", "0000000000000001");

    let called = false;
    const getEventsImpl = async () => {
      if (!called) {
        called = true;
        throw new Error("startLedger must be within the ledger retention window");
      }
      return { events: [], cursor: "0000000000001000" };
    };
    const server = {
      getLatestLedger: vi.fn().mockResolvedValue({ sequence: 1001 }),
      getEvents: vi.fn().mockImplementation(getEventsImpl),
    };
    const listener = new SorobanListener(BASE_CFG, 60_000, SILENT_LOG, {
      cursorStore: store, cursorLabel: "test-overflow-metric",
    });
    injectServer(listener, server);
    await listener.start(noopHandlers);
    await new Promise((r) => setTimeout(r, 50));

    const overflowCall = incSpy.mock.calls.find(
      (c) => (c[0] as any)?.error_type === "history_window_overflow",
    );
    expect(overflowCall).toBeDefined();
    listener.stop();
    incSpy.mockRestore();
  });

  it("does not treat a generic RPC error as a history-window overflow", async () => {
    const store = new SorobanCursorStore({ storageDir: TEST_DIR });
    store.save("test-generic-err", "0000000000000010");

    const server = {
      getLatestLedger: vi.fn().mockResolvedValue({ sequence: 100 }),
      getEvents: vi.fn().mockRejectedValue(new Error("RPC connection refused")),
    };
    const listener = new SorobanListener(BASE_CFG, 60_000, SILENT_LOG, {
      cursorStore: store, cursorLabel: "test-generic-err",
    });
    injectServer(listener, server);
    await listener.start(noopHandlers);
    await new Promise((r) => setTimeout(r, 50));
    // Cursor must NOT have been cleared — it's not a history-window error.
    expect(listener.getCursor()).toBe("0000000000000010");
    listener.stop();
  });

  it("classifies a circular-reference thrown value without throwing", async () => {
    // Build a circular object — JSON.stringify would throw on this.
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;

    const store = new SorobanCursorStore({ storageDir: TEST_DIR });
    store.save("test-circular", "0000000000000001");

    let callCount = 0;
    const getEventsImpl = async () => {
      callCount++;
      if (callCount === 1) {
        // Throw the circular object directly (not wrapped in Error).
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw circular;
      }
      return { events: [], cursor: "0000000000000999" };
    };
    const server = {
      getLatestLedger: vi.fn().mockResolvedValue({ sequence: 1000 }),
      getEvents: vi.fn().mockImplementation(getEventsImpl),
    };
    const listener = new SorobanListener(BASE_CFG, 60_000, SILENT_LOG, {
      cursorStore: store, cursorLabel: "test-circular",
    });
    injectServer(listener, server);

    // Must resolve without throwing — the circular object should be handled
    // gracefully and treated as a non-history-window error (rethrown), but
    // safeErrorString itself must not throw during classification.
    await expect(
      listener.start(noopHandlers).then(() => new Promise((r) => setTimeout(r, 50)))
    ).resolves.toBeUndefined();

    // Cursor must NOT have been cleared — circular object is not a
    // history-window error, so it propagates as a normal poll failure.
    expect(listener.getCursor()).toBe("0000000000000001");
    listener.stop();
  });

  it("classifies a plain Error as a non-history-window error and does not clear cursor", async () => {
    const store = new SorobanCursorStore({ storageDir: TEST_DIR });
    store.save("test-plain-error", "0000000000000005");

    const server = {
      getLatestLedger: vi.fn().mockResolvedValue({ sequence: 100 }),
      getEvents: vi.fn().mockRejectedValue(new Error("network timeout")),
    };
    const listener = new SorobanListener(BASE_CFG, 60_000, SILENT_LOG, {
      cursorStore: store, cursorLabel: "test-plain-error",
    });
    injectServer(listener, server);
    await listener.start(noopHandlers);
    await new Promise((r) => setTimeout(r, 50));
    // Cursor must NOT be cleared — generic errors are not history-window errors.
    expect(listener.getCursor()).toBe("0000000000000005");
    listener.stop();
  });

  it("clamps to latest-1 ledger after history-window overflow", async () => {
    const store = new SorobanCursorStore({ storageDir: TEST_DIR });
    store.save("test-clamp-ledger", "0000000000000001");

    let callCount = 0;
    let secondCallArg: any;
    const getEventsImpl = async (req: any) => {
      callCount++;
      if (callCount === 1) {
        throw new Error("requested ledger is older than retention window");
      }
      secondCallArg = req;
      return { events: [], cursor: "0000000000000799" };
    };
    const server = {
      getLatestLedger: vi.fn().mockResolvedValue({ sequence: 800 }),
      getEvents: vi.fn().mockImplementation(getEventsImpl),
    };
    const listener = new SorobanListener(BASE_CFG, 60_000, SILENT_LOG, {
      cursorStore: store, cursorLabel: "test-clamp-ledger",
    });
    injectServer(listener, server);
    await listener.start(noopHandlers);
    await new Promise((r) => setTimeout(r, 50));
    // The retry should use startLedger = latest.sequence - 1 = 799.
    expect(secondCallArg?.startLedger).toBe(799);
    listener.stop();
  });
});
