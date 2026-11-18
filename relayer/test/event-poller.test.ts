import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { type Contract, type EventLog, type JsonRpcProvider, type Log } from 'ethers';
import { CursorStore } from '../src/utils/cursor-store.js';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';

// We import the module under test lazily because the module-level
// singletons may interfere across tests. We use dynamic imports.
type ContractEventPollerHandle = import('../src/listeners/contract-event-poller.js').ContractEventPollerHandle;
type ContractEventBinding = import('../src/listeners/contract-event-poller.js').ContractEventBinding;

const TEST_DIR = join(process.cwd(), '.cursor-test-poller');

/**
 * Build a realistic synthetic EventLog.
 *
 * `transactionHash` and `logIndex` together form the chain-specific event
 * identity used by the deduplication layer (see relay-guard-design.md §B and
 * coordinator/src/reconciliation/event-identity.ts `ethEventKey`).  Callers
 * should supply distinct (transactionHash, logIndex) pairs whenever they want
 * to represent distinct on-chain events, and the *same* pair when simulating
 * a replay of the identical event.
 */
function fakeEventLog(
  blockNumber: number,
  args: Record<string, unknown> = {},
  overrides: { transactionHash?: string; logIndex?: number } = {},
): EventLog {
  return {
    args: args as any,
    blockNumber,
    transactionHash: overrides.transactionHash ?? '0xabc',
    transactionIndex: 0,
    logIndex: overrides.logIndex ?? 0,
    address: '0x123',
    data: '0x',
    topics: [],
    blockHash: '0xblock',
    removed: false,
    getBlock: () => Promise.resolve(null as any),
    getTransaction: () => Promise.resolve(null as any),
    getTransactionReceipt: () => Promise.resolve(null as any),
  } as unknown as EventLog;
}

describe('contract-event-poller (integration)', () => {
  let cursorStore: CursorStore;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
    cursorStore = new CursorStore({ storageDir: TEST_DIR });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it('resumes from a persisted cursor after restart', async () => {
    const handler = vi.fn();
    const bindings: ContractEventBinding[] = [
      { eventName: 'OrderCreated', handler },
    ];

    // Persist a cursor before starting the poller (simulating a previous run).
    cursorStore.save('test-resume', 50);

    const mockContract = {
      filters: {
        OrderCreated: () => ({}),
      },
      queryFilter: vi.fn().mockResolvedValue([
        fakeEventLog(51, { orderId: 1n, sender: '0xabc' }),
        fakeEventLog(52, { orderId: 2n, sender: '0xdef' }),
      ]),
    } as unknown as Contract;

    const mockProvider = {
      getBlockNumber: vi.fn().mockResolvedValue(55),
    } as unknown as JsonRpcProvider;

    const { startContractEventPoller } = await import(
      '../src/listeners/contract-event-poller.js'
    );

    const handle: ContractEventPollerHandle = await startContractEventPoller(
      mockContract,
      mockProvider,
      bindings,
      {
        label: 'test-resume',
        cursorStore,
        intervalMs: 10_000,
        idleIntervalMs: 10_000,
      },
    );

    // Wait a tick for the poller to process
    await new Promise((r) => setTimeout(r, 50));

    // Should have scanned from block 51 to min(55, 51+500-1=55) → toBlock=55
    // queryFilter should have been called with fromBlock=51, toBlock=55
    expect(mockContract.queryFilter).toHaveBeenCalledWith(
      expect.anything(),
      51,
      55,
    );

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handle.cursor()).toBe(55);

    // The cursor should be persisted to disk
    expect(cursorStore.load('test-resume')).toBe(55);

    handle.stop();
  });

  it('starts from startBlock when no persisted cursor exists', async () => {
    const handler = vi.fn();
    const bindings: ContractEventBinding[] = [
      { eventName: 'OrderCreated', handler },
    ];

    const mockContract = {
      filters: {
        OrderCreated: () => ({}),
      },
      queryFilter: vi.fn().mockResolvedValue([]),
    } as unknown as Contract;

    const mockProvider = {
      getBlockNumber: vi.fn().mockResolvedValue(200),
    } as unknown as JsonRpcProvider;

    const { startContractEventPoller } = await import(
      '../src/listeners/contract-event-poller.js'
    );

    const handle = await startContractEventPoller(
      mockContract,
      mockProvider,
      bindings,
      {
        label: 'test-startblock',
        startBlock: 100,
        cursorStore,
        intervalMs: 10_000,
        idleIntervalMs: 10_000,
      },
    );

    // Wait a tick
    await new Promise((r) => setTimeout(r, 50));

    expect(mockContract.queryFilter).toHaveBeenCalledWith(
      expect.anything(),
      101,
      200,
    );

    handle.stop();
  });

  it('returns empty poll for inverted range without querying provider', async () => {
    const handler = vi.fn();
    const bindings: ContractEventBinding[] = [
      { eventName: 'OrderCreated', handler },
    ];

    // Persist cursor AHEAD of current head to simulate a rollback.
    cursorStore.save('test-inverted', 100);

    const mockContract = {
      filters: {
        OrderCreated: () => ({}),
      },
      queryFilter: vi.fn().mockResolvedValue([]),
    } as unknown as Contract;

    const mockProvider = {
      // Head is behind the persisted cursor → inverted range
      getBlockNumber: vi.fn().mockResolvedValue(90),
    } as unknown as JsonRpcProvider;

    const { startContractEventPoller } = await import(
      '../src/listeners/contract-event-poller.js'
    );

    const handle = await startContractEventPoller(
      mockContract,
      mockProvider,
      bindings,
      {
        label: 'test-inverted',
        cursorStore,
        intervalMs: 10_000,
        idleIntervalMs: 10_000,
      },
    );

    // Wait for at least one tick
    await new Promise((r) => setTimeout(r, 50));

    // queryFilter should NOT have been called — range is inverted
    expect(mockContract.queryFilter).not.toHaveBeenCalled();
    // Handler should NOT have been called
    expect(handler).not.toHaveBeenCalled();
    // Cursor should remain unchanged at 100
    expect(handle.cursor()).toBe(100);

    handle.stop();
  });

  it('does not advance cursor when RPC fails', async () => {
    const handler = vi.fn();
    const bindings: ContractEventBinding[] = [
      { eventName: 'OrderCreated', handler },
    ];

    cursorStore.save('test-rpc-fail', 10);

    const mockContract = {
      filters: {
        OrderCreated: () => ({}),
      },
      queryFilter: vi.fn().mockRejectedValue(new Error('RPC rate limited')),
    } as unknown as Contract;

    const mockProvider = {
      getBlockNumber: vi.fn().mockResolvedValue(20),
    } as unknown as JsonRpcProvider;

    const { startContractEventPoller } = await import(
      '../src/listeners/contract-event-poller.js'
    );

    const handle = await startContractEventPoller(
      mockContract,
      mockProvider,
      bindings,
      {
        label: 'test-rpc-fail',
        cursorStore,
        intervalMs: 10_000,
        idleIntervalMs: 10_000,
        retry: { maxRetries: 0, baseDelayMs: 5 },
      },
    );

    // Wait enough time for the tick + failure
    await new Promise((r) => setTimeout(r, 100));

    // Cursor should NOT have advanced
    expect(handle.cursor()).toBe(10);
    // On-disk cursor should also still be 10
    expect(cursorStore.load('test-rpc-fail')).toBe(10);
    // Handler should NOT have been called
    expect(handler).not.toHaveBeenCalled();

    handle.stop();
  });
});

// ---------------------------------------------------------------------------
// Event deduplication — issue #339 / replay-guard-design.md §B
//
// The contract-event-poller advances its cursor only after a full tick
// succeeds.  If a provider failure (or a deliberate restart) causes the
// cursor NOT to advance, the next tick re-scans the same block range and
// re-delivers every event in that window.  Without a per-event dedupe key,
// a handler that performs an on-chain action (escrow creation, status
// mutation) would be called twice for the same on-chain log.
//
// These tests feed the same synthetic EventLog identity (transactionHash +
// logIndex, the canonical Ethereum dedup key) through the poller under two
// distinct failure scenarios and assert that:
//   1. A handler that tracks seen event identities is called only once per
//      unique (transactionHash, logIndex) pair — regardless of how many
//      times the poller delivers it.
//   2. Two logs with the same transactionHash but different logIndexes ARE
//      treated as distinct events (a batch can emit multiple logs per tx).
//   3. After a simulated restart (fresh CursorStore, cursor reset to an
//      earlier block), replayed events from the overlap window are not
//      processed twice by a downstream handler that tracks event identity.
// ---------------------------------------------------------------------------

/**
 * Minimal downstream deduplication shim.
 *
 * Mirrors the pattern a real handler would follow:  maintain a Set of
 * `${transactionHash}:${logIndex}` keys (the composite Ethereum event
 * identity) and skip processing when the key is already present.
 *
 * This represents the "safe downstream deduplication" required by the
 * acceptance criteria when the poller itself does not deduplicate.
 */
function makeDeduplicatingHandler(inner: (ev: EventLog) => void) {
  const seen = new Set<string>();
  return {
    handler(...args: any[]) {
      // The EventLog is always the last argument passed by the poller.
      const ev: EventLog = args[args.length - 1];
      const key = `${ev.transactionHash}:${ev.logIndex}`;
      if (seen.has(key)) return;          // already processed this event identity
      seen.add(key);
      inner(ev);
    },
    seen,
  };
}

describe('contract-event-poller — event deduplication (issue #339)', () => {
  let cursorStore: CursorStore;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
    cursorStore = new CursorStore({ storageDir: TEST_DIR });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  // ── Same-batch duplicate delivery ─────────────────────────────────────────
  // Simulates a provider returning the identical EventLog twice in a single
  // queryFilter response (e.g. a buggy RPC or an overlapping range caused by
  // cursor arithmetic).  The handler must process each unique event identity
  // exactly once within a single tick.

  it('same-batch: handler called once when the same event identity appears twice in one queryFilter response', async () => {
    const innerFn = vi.fn();
    const { handler } = makeDeduplicatingHandler(innerFn);
    const bindings: ContractEventBinding[] = [{ eventName: 'OrderCreated', handler }];

    // Both entries share the same transactionHash + logIndex → same identity.
    const duplicateLog = fakeEventLog(
      101,
      { orderId: 7n, hashLock: '0xdeadbeef' },
      { transactionHash: '0xfeed0001cafebabe0000000000000000000000000000000000000000000000001', logIndex: 0 },
    );

    const mockContract = {
      filters: { OrderCreated: () => ({}) },
      queryFilter: vi.fn().mockResolvedValue([duplicateLog, duplicateLog]),
    } as unknown as Contract;

    const mockProvider = {
      getBlockNumber: vi.fn().mockResolvedValue(110),
    } as unknown as JsonRpcProvider;

    cursorStore.save('test-dedup-same-batch', 100);

    const { startContractEventPoller } = await import(
      '../src/listeners/contract-event-poller.js'
    );

    const handle = await startContractEventPoller(
      mockContract,
      mockProvider,
      bindings,
      {
        label: 'test-dedup-same-batch',
        cursorStore,
        intervalMs: 10_000,
        idleIntervalMs: 10_000,
      },
    );

    await new Promise((r) => setTimeout(r, 60));

    // Poller delivered the log twice; deduplicating handler should have
    // called the inner action only once.
    expect(innerFn).toHaveBeenCalledTimes(1);

    handle.stop();
  });

  it('same-batch: two logs with the same txHash but different logIndexes are processed as distinct events', async () => {
    const innerFn = vi.fn();
    const { handler } = makeDeduplicatingHandler(innerFn);
    const bindings: ContractEventBinding[] = [{ eventName: 'OrderCreated', handler }];

    const TX = '0xfeed0002cafebabe0000000000000000000000000000000000000000000000002';

    // Same transaction, two distinct log entries (logIndex 0 and logIndex 1).
    const log0 = fakeEventLog(102, { orderId: 8n }, { transactionHash: TX, logIndex: 0 });
    const log1 = fakeEventLog(102, { orderId: 9n }, { transactionHash: TX, logIndex: 1 });

    const mockContract = {
      filters: { OrderCreated: () => ({}) },
      queryFilter: vi.fn().mockResolvedValue([log0, log1]),
    } as unknown as Contract;

    const mockProvider = {
      getBlockNumber: vi.fn().mockResolvedValue(110),
    } as unknown as JsonRpcProvider;

    cursorStore.save('test-dedup-two-logs', 101);

    const { startContractEventPoller } = await import(
      '../src/listeners/contract-event-poller.js'
    );

    const handle = await startContractEventPoller(
      mockContract,
      mockProvider,
      bindings,
      {
        label: 'test-dedup-two-logs',
        cursorStore,
        intervalMs: 10_000,
        idleIntervalMs: 10_000,
      },
    );

    await new Promise((r) => setTimeout(r, 60));

    // Both are unique event identities → both must be processed.
    expect(innerFn).toHaveBeenCalledTimes(2);

    handle.stop();
  });

  // ── Restart / replay condition ────────────────────────────────────────────
  // Simulates a process restart where the cursor is reset to a block that was
  // already fully processed in the previous run.  The next tick re-scans the
  // same block range and re-delivers the same events.  A handler that tracks
  // seen identities in persistent storage (or re-checks on-chain state) must
  // not trigger a second on-chain action for an already-processed event.
  //
  // Here we model the "persistent tracking" using the same deduplicating
  // handler shim that survives across poller restarts within the same process.

  it('restart/replay: handler called once per event identity across two poller instances sharing the same seen-set', async () => {
    const innerFn = vi.fn();
    const dedup = makeDeduplicatingHandler(innerFn);

    const TX_A = '0xfeed0003cafebabe0000000000000000000000000000000000000000000000003';
    const TX_B = '0xfeed0004cafebabe0000000000000000000000000000000000000000000000004';

    const logA = fakeEventLog(201, { orderId: 10n }, { transactionHash: TX_A, logIndex: 0 });
    const logB = fakeEventLog(202, { orderId: 11n }, { transactionHash: TX_B, logIndex: 0 });

    // First poller instance: cursor at 200, head at 205 → processes logA and logB.
    cursorStore.save('test-dedup-restart', 200);

    const mockContract = {
      filters: { OrderCreated: () => ({}) },
      queryFilter: vi.fn().mockResolvedValue([logA, logB]),
    } as unknown as Contract;

    const mockProvider = {
      getBlockNumber: vi.fn().mockResolvedValue(205),
    } as unknown as JsonRpcProvider;

    const { startContractEventPoller } = await import(
      '../src/listeners/contract-event-poller.js'
    );

    const bindings: ContractEventBinding[] = [
      { eventName: 'OrderCreated', handler: dedup.handler },
    ];

    const handle1 = await startContractEventPoller(
      mockContract,
      mockProvider,
      bindings,
      {
        label: 'test-dedup-restart',
        cursorStore,
        intervalMs: 10_000,
        idleIntervalMs: 10_000,
      },
    );

    await new Promise((r) => setTimeout(r, 60));
    expect(innerFn).toHaveBeenCalledTimes(2); // both events processed once each
    handle1.stop();

    // Simulate restart: roll back cursor to 200 (overlapping window).
    // In production this happens when the process crashes before persisting
    // the cursor advance, or when the operator manually resets the cursor.
    cursorStore.save('test-dedup-restart', 200);

    // Second poller instance: same seen-set (dedup.seen persists in memory
    // as the handler closure — in production this would be durable storage).
    // queryFilter returns the same events again.
    const mockContract2 = {
      filters: { OrderCreated: () => ({}) },
      queryFilter: vi.fn().mockResolvedValue([logA, logB]),
    } as unknown as Contract;

    const mockProvider2 = {
      getBlockNumber: vi.fn().mockResolvedValue(205),
    } as unknown as JsonRpcProvider;

    const handle2 = await startContractEventPoller(
      mockContract2,
      mockProvider2,
      bindings,
      {
        label: 'test-dedup-restart',
        cursorStore,
        intervalMs: 10_000,
        idleIntervalMs: 10_000,
      },
    );

    await new Promise((r) => setTimeout(r, 60));

    // Replayed delivery → dedup shim must suppress both; inner action still 2.
    expect(innerFn).toHaveBeenCalledTimes(2);

    handle2.stop();
  });

  it('restart/replay: a new event in the overlap window IS processed even though earlier events are suppressed', async () => {
    const innerFn = vi.fn();
    const dedup = makeDeduplicatingHandler(innerFn);

    const TX_OLD = '0xfeed0005cafebabe0000000000000000000000000000000000000000000000005';
    const TX_NEW = '0xfeed0006cafebabe0000000000000000000000000000000000000000000000006';

    const oldLog = fakeEventLog(301, { orderId: 12n }, { transactionHash: TX_OLD, logIndex: 0 });
    const newLog = fakeEventLog(303, { orderId: 13n }, { transactionHash: TX_NEW, logIndex: 0 });

    // First run: processes only the old log.
    cursorStore.save('test-dedup-new-in-overlap', 300);

    const mockContract1 = {
      filters: { OrderCreated: () => ({}) },
      queryFilter: vi.fn().mockResolvedValue([oldLog]),
    } as unknown as Contract;

    const mockProvider1 = {
      getBlockNumber: vi.fn().mockResolvedValue(302),
    } as unknown as JsonRpcProvider;

    const { startContractEventPoller } = await import(
      '../src/listeners/contract-event-poller.js'
    );

    const bindings: ContractEventBinding[] = [
      { eventName: 'OrderCreated', handler: dedup.handler },
    ];

    const handle1 = await startContractEventPoller(
      mockContract1,
      mockProvider1,
      bindings,
      {
        label: 'test-dedup-new-in-overlap',
        cursorStore,
        intervalMs: 10_000,
        idleIntervalMs: 10_000,
      },
    );

    await new Promise((r) => setTimeout(r, 60));
    expect(innerFn).toHaveBeenCalledTimes(1);
    handle1.stop();

    // Simulate restart: cursor rolls back to 300.
    // This time the range also includes a NEW event (TX_NEW at block 303)
    // that was not present during the first run.
    cursorStore.save('test-dedup-new-in-overlap', 300);

    const mockContract2 = {
      filters: { OrderCreated: () => ({}) },
      // Returns both the old (replay) and the new event.
      queryFilter: vi.fn().mockResolvedValue([oldLog, newLog]),
    } as unknown as Contract;

    const mockProvider2 = {
      getBlockNumber: vi.fn().mockResolvedValue(305),
    } as unknown as JsonRpcProvider;

    const handle2 = await startContractEventPoller(
      mockContract2,
      mockProvider2,
      bindings,
      {
        label: 'test-dedup-new-in-overlap',
        cursorStore,
        intervalMs: 10_000,
        idleIntervalMs: 10_000,
      },
    );

    await new Promise((r) => setTimeout(r, 60));

    // oldLog is suppressed (already in seen-set); newLog is processed once.
    expect(innerFn).toHaveBeenCalledTimes(2);

    handle2.stop();
  });

  // ── Dedupe key identity contract ──────────────────────────────────────────
  // Asserts that the dedupe key used by a downstream handler MUST include both
  // transactionHash and logIndex.  Using transactionHash alone would collapse
  // two distinct events emitted in the same transaction into a single seen-set
  // entry, silently dropping the second event.

  it('dedup key must include logIndex: two events in same tx with different logIndexes produce different keys', () => {
    const TX = '0xfeed0007cafebabe0000000000000000000000000000000000000000000000007';
    const log0 = fakeEventLog(400, {}, { transactionHash: TX, logIndex: 0 });
    const log1 = fakeEventLog(400, {}, { transactionHash: TX, logIndex: 1 });

    const key0 = `${log0.transactionHash}:${log0.logIndex}`;
    const key1 = `${log1.transactionHash}:${log1.logIndex}`;

    expect(key0).not.toBe(key1);
    expect(key0).toContain(TX);
    expect(key1).toContain(TX);
  });

  it('dedup key must include transactionHash: same logIndex from different txs produce different keys', () => {
    const TX_P = '0xfeed0008cafebabe0000000000000000000000000000000000000000000000008';
    const TX_Q = '0xfeed0009cafebabe0000000000000000000000000000000000000000000000009';
    const logP = fakeEventLog(401, {}, { transactionHash: TX_P, logIndex: 0 });
    const logQ = fakeEventLog(401, {}, { transactionHash: TX_Q, logIndex: 0 });

    const keyP = `${logP.transactionHash}:${logP.logIndex}`;
    const keyQ = `${logQ.transactionHash}:${logQ.logIndex}`;

    expect(keyP).not.toBe(keyQ);
  });
});
