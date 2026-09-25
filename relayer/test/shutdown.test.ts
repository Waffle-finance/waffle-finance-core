/**
 * Tests for graceful shutdown idempotency — issue 587.
 *
 * Strategy: import shutdown.ts directly (not index.ts) so the test never
 * boots the HTTP server or requires live env vars.  The Ethereum listener
 * module is mocked at the Vitest module level so stopListening() is a spy
 * we can count.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { gracefulShutdown, _resetShutdownStateForTest } from '../src/shutdown.js';

// ---------------------------------------------------------------------------
// Mock the Ethereum listener so stopListening() is a controllable spy and
// never touches a real provider.
// ---------------------------------------------------------------------------

vi.mock('../src/listeners/ethereum-listener.js', () => ({
  ethereumListener: {
    stopListening: vi.fn().mockResolvedValue(undefined),
  },
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('gracefulShutdown — idempotency (issue 587)', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    // Prevent process.exit from terminating the test runner.
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    // Reset the module-level flag so every test starts from a clean state.
    _resetShutdownStateForTest();

    // Clear call counts on the listener spy.
    const { ethereumListener } = await import('../src/listeners/ethereum-listener.js');
    vi.mocked(ethereumListener.stopListening).mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('first shutdown calls stopListening exactly once', async () => {
    const { ethereumListener } = await import('../src/listeners/ethereum-listener.js');

    await gracefulShutdown();

    expect(ethereumListener.stopListening).toHaveBeenCalledTimes(1);
  });

  it('first shutdown calls process.exit(0)', async () => {
    await gracefulShutdown();

    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('second shutdown call does NOT invoke stopListening again', async () => {
    const { ethereumListener } = await import('../src/listeners/ethereum-listener.js');

    await gracefulShutdown(); // first — does full cleanup
    await gracefulShutdown(); // second — must be a no-op

    expect(ethereumListener.stopListening).toHaveBeenCalledTimes(1);
  });

  it('second shutdown call does NOT call process.exit again', async () => {
    await gracefulShutdown(); // first
    exitSpy.mockClear();      // reset counter so we only measure the second call

    await gracefulShutdown(); // second — must be a no-op

    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('second shutdown call resolves without throwing', async () => {
    await gracefulShutdown();

    await expect(gracefulShutdown()).resolves.toBeUndefined();
  });

  it('third and further calls are also no-ops', async () => {
    const { ethereumListener } = await import('../src/listeners/ethereum-listener.js');

    await gracefulShutdown();
    await gracefulShutdown();
    await gracefulShutdown();

    expect(ethereumListener.stopListening).toHaveBeenCalledTimes(1);
    // process.exit only from the first call
    expect(exitSpy).toHaveBeenCalledTimes(1);
  });
});
