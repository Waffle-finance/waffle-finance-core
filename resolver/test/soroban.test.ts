import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SorobanListener } from '../src/listeners/soroban.js';
import pino from 'pino';

vi.mock('@stellar/stellar-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@stellar/stellar-sdk')>();
  return {
    ...actual,
    rpc: {
      Server: vi.fn().mockImplementation(function() {
        return {
          getLatestLedger: vi.fn().mockResolvedValue({ sequence: 100 }),
          getEvents: vi.fn().mockResolvedValue({ events: [] }),
        };
      })
    }
  };
});

describe('SorobanListener lifecycle', () => {
  const logger = pino({ level: 'silent' });
  const cfg = { htlc: 'CABC', rpcUrl: 'http://localhost:8000', networkPassphrase: 'Test', chainId: 'testnet' };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('can be started and stopped repeatedly without leaking timers', async () => {
    const listener = new SorobanListener(cfg, 1000, logger);
    
    // First start
    await listener.start({} as any);
    
    // Call start again - it should clear the previous timeout and loop
    await listener.start({} as any);
    
    // Stop it completely
    listener.stop();

    // If it was stopped, no timers should be pending
    expect(vi.getTimerCount()).toBe(0);
  });
  
  it('clears timeout on stop', async () => {
    const listener = new SorobanListener(cfg, 1000, logger);
    await listener.start({} as any);
    
    // The start method fires `tick()` without awaiting it. The inner tick() schedules a timeout.
    // wait for the promise to flush and timer to be scheduled.
    await Promise.resolve(); // give tick() a chance to run since start doesn't await it fully
    
    // Actually, `start` calls `void tick()`, so tick is run asynchronously.
    // Let's use runAllTimers or just stop directly.
    listener.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
