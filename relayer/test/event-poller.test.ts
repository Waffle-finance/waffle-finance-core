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

function fakeEventLog(blockNumber: number, args: Record<string, unknown> = {}): EventLog {
  return {
    args: args as any,
    blockNumber,
    transactionHash: '0xabc',
    transactionIndex: 0,
    logIndex: 0,
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
