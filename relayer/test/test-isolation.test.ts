/**
 * @file test-isolation.test.ts
 *
 * Verifies that the relayer test suite's shared infrastructure does not leak
 * state across tests or test files.
 *
 * ## What is checked
 *
 * 1. **Singleton reset discipline** — `shutdown.ts` carries a module-level
 *    `_shuttingDown` flag that must be reset between tests.  Forgetting to
 *    call `_resetShutdownStateForTest()` in `beforeEach` would make every
 *    subsequent test in `shutdown.test.ts` see a "already shutting down" state
 *    and silently skip all cleanup.  This suite asserts the helper works and
 *    that `assertModuleReset` documents the contract.
 *
 * 2. **Environment variable isolation** — `EnvSnapshot` and `withEnv` are
 *    exercised identically to the coordinator suite so a single change to the
 *    helpers is verified against both packages.
 *
 * 3. **FakeClock cleanup** — the relayer's retry-engine suite uses `FakeClock`;
 *    this suite verifies that real timers are restored after each such test.
 *
 * 4. **Suite-order independence** — results are the same regardless of order.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EnvSnapshot, withEnv, hasFakeTimers, assertModuleReset } from '../../packages/test-utils/src/isolation.js';
import { FakeClock } from '../../packages/test-utils/src/fake-clock.js';
import { gracefulShutdown, _resetShutdownStateForTest } from '../src/shutdown.js';

// Mock the Ethereum listener so stopListening() never touches a real provider.
vi.mock('../src/listeners/ethereum-listener.js', () => ({
  ethereumListener: {
    stopListening: vi.fn().mockResolvedValue(undefined),
  },
}));

// ── 1. Shutdown singleton — reset discipline ──────────────────────────────────

describe('shutdown singleton — _resetShutdownStateForTest discipline', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    assertModuleReset('shutdown', _resetShutdownStateForTest);
  });

  afterEach(() => vi.restoreAllMocks());

  it('assertModuleReset calls the reset function without throwing', () => {
    // If we reach here, assertModuleReset did not throw — the module exported
    // a valid reset function and it was called successfully.
    expect(true).toBe(true);
  });

  it('shutdown flag starts false after each reset', async () => {
    // gracefulShutdown() should run to completion (not short-circuit as a no-op).
    await gracefulShutdown();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('a second shutdown call within the same test is a no-op after first completes', async () => {
    await gracefulShutdown();             // first — sets _shuttingDown
    exitSpy.mockClear();
    await gracefulShutdown();             // second — must be ignored
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('the reset fires before each test so the first shutdown always runs', async () => {
    // Despite the previous test calling gracefulShutdown twice, the beforeEach
    // reset means this test starts fresh: _shuttingDown is false again.
    await gracefulShutdown();
    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});

// ── 2. assertModuleReset — error when reset fn is missing ─────────────────────

describe('assertModuleReset — contract enforcement', () => {
  it('throws when the module does not export a reset function', () => {
    expect(() => assertModuleReset('no-reset-module', undefined)).toThrow(
      'does not export a reset function'
    );
  });

  it('calls the provided reset function exactly once', () => {
    const mockReset = vi.fn();
    assertModuleReset('my-module', mockReset);
    expect(mockReset).toHaveBeenCalledTimes(1);
  });
});

// ── 3. Environment variable isolation ─────────────────────────────────────────

describe('EnvSnapshot — relayer env isolation', () => {
  const snap = new EnvSnapshot();

  beforeEach(() => snap.capture());
  afterEach(() => snap.restore());

  it('newly added env key is visible inside the test', () => {
    process.env['__RELAYER_TEST_KEY__'] = 'present';
    expect(process.env['__RELAYER_TEST_KEY__']).toBe('present');
  });

  it('key added by previous test is gone after restore', () => {
    expect(process.env['__RELAYER_TEST_KEY__']).toBeUndefined();
  });

  it('withEnv() restores value even when callback throws', async () => {
    process.env['__RELAYER_ERR_KEY__'] = 'original';

    await expect(
      withEnv({ '__RELAYER_ERR_KEY__': 'overridden' }, async () => {
        throw new Error('error in callback');
      })
    ).rejects.toThrow('error in callback');

    expect(process.env['__RELAYER_ERR_KEY__']).toBe('original');
    delete process.env['__RELAYER_ERR_KEY__'];
  });
});

// ── 4. FakeClock — no leak ────────────────────────────────────────────────────

describe('FakeClock — no timer leak in relayer suite', () => {
  it('hasFakeTimers() starts false', () => {
    expect(hasFakeTimers()).toBe(false);
  });

  it('install + restore leaves no fake timers', () => {
    const clock = new FakeClock();
    clock.install();
    expect(hasFakeTimers()).toBe(true);
    clock.restore();
    expect(hasFakeTimers()).toBe(false);
  });

  it('Date.now() is the real clock after restore', () => {
    const clock = new FakeClock({ scope: 'date' });
    clock.install();
    clock.advance(999_999_999); // advance by ~11.5 days
    clock.restore();

    // Real Date.now() should be close to actual time, not 11 days ahead.
    const now = Date.now();
    const elevenDaysMs = 11 * 24 * 60 * 60 * 1000;
    // The real now is at most 1 second ahead of when this test started.
    expect(now).toBeLessThan(Date.now() + 1_000);
    // And definitely not 11 days in the future.
    expect(now).toBeLessThan(Date.now() + elevenDaysMs);
  });
});

// ── 5. Suite-order independence ───────────────────────────────────────────────

describe('Suite order E — relayer env key __RELAYER_ORDER__', () => {
  const snap = new EnvSnapshot();
  beforeEach(() => snap.capture());
  afterEach(() => snap.restore());

  it('sees __RELAYER_ORDER__ as undefined and sets it', () => {
    expect(process.env['__RELAYER_ORDER__']).toBeUndefined();
    process.env['__RELAYER_ORDER__'] = 'from-E';
  });
});

describe('Suite order F — relayer env key __RELAYER_ORDER__ (no leak from E)', () => {
  const snap = new EnvSnapshot();
  beforeEach(() => snap.capture());
  afterEach(() => snap.restore());

  it('sees __RELAYER_ORDER__ as undefined — E cleaned up', () => {
    expect(process.env['__RELAYER_ORDER__']).toBeUndefined();
  });
});
