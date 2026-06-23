import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EthereumListener } from '../src/listeners/ethereum.js';
import pino from 'pino';

const mockWatchEvent = vi.fn();
vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    createPublicClient: vi.fn(() => ({
      watchEvent: mockWatchEvent,
    })),
  };
});

describe('EthereumListener lifecycle', () => {
  const logger = pino({ level: 'silent' });
  const cfg = { chainId: 1, rpcUrl: 'http://localhost:8545', htlcEscrow: '0x123' as const };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('can be started and stopped repeatedly without leaking watchers', async () => {
    const listener = new EthereumListener(cfg, logger);
    const unwatch1 = vi.fn();
    const unwatch2 = vi.fn();
    const unwatch3 = vi.fn();
    
    mockWatchEvent.mockReturnValueOnce(unwatch1)
                  .mockReturnValueOnce(unwatch2)
                  .mockReturnValueOnce(unwatch3);

    await listener.start({} as any);

    const unwatch4 = vi.fn();
    const unwatch5 = vi.fn();
    const unwatch6 = vi.fn();
    mockWatchEvent.mockReturnValueOnce(unwatch4)
                  .mockReturnValueOnce(unwatch5)
                  .mockReturnValueOnce(unwatch6);

    // If start is called again, it should stop the previous ones
    await listener.start({} as any);

    expect(unwatch1).toHaveBeenCalled();
    expect(unwatch2).toHaveBeenCalled();
    expect(unwatch3).toHaveBeenCalled();

    await listener.stop();

    expect(unwatch4).toHaveBeenCalled();
    expect(unwatch5).toHaveBeenCalled();
    expect(unwatch6).toHaveBeenCalled();
  });
});
