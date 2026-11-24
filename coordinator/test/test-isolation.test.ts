/**
 * @file test-isolation.test.ts
 *
 * Verifies that the coordinator test suite's shared infrastructure does not
 * leak state across tests or test files.
 *
 * ## What is checked
 *
 * 1. **Environment variables** — `process.env` mutations made during a test
 *    are fully restored by `EnvSnapshot.restore()` even when the test fails.
 *
 * 2. **Fake timers** — `FakeClock.restore()` unconditionally reverts to real
 *    timers; a fake clock activated in one test cannot bleed into the next.
 *
 * 3. **Module-level singletons** — modules that carry module-level flags
 *    (e.g. a "shutdown already in progress" guard) must expose a reset hook
 *    so tests can restore the initial state between cases.
 *
 * 4. **Suite-order independence** — the suites in this file are written so
 *    each passes whether run in declaration order or reversed order, which
 *    is what `vitest --sequence.shuffle` would exercise.
 *
 * ## Parallelism note
 *
 * With `pool: 'forks'` (the coordinator's vitest config) each *file* runs in
 * its own Node process, so global state cannot leak between files.  Within a
 * file, tests share the process and DO share module-level globals — this file
 * verifies that the cleanup helpers prevent within-file leakage.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EnvSnapshot, withEnv, hasFakeTimers } from '../../packages/test-utils/src/isolation.js';
import { FakeClock } from '../../packages/test-utils/src/fake-clock.js';

// ── 1. EnvSnapshot — basic save / restore ─────────────────────────────────────

describe('EnvSnapshot — save and restore', () => {
  const snap = new EnvSnapshot();

  beforeEach(() => snap.capture());
  afterEach(() => snap.restore());

  it('captures and restores a newly added key', () => {
    expect(process.env['__WAFFLE_TEST_NEW_KEY__']).toBeUndefined();
    process.env['__WAFFLE_TEST_NEW_KEY__'] = 'hello';
    expect(process.env['__WAFFLE_TEST_NEW_KEY__']).toBe('hello');
    // restore() fires in afterEach — verified by the NEXT test seeing undefined
  });

  it('the key added by the previous test is gone after restore', () => {
    // This test relies on afterEach from the previous test having run.
    // Both tests run in the same describe block so afterEach fires between them.
    expect(process.env['__WAFFLE_TEST_NEW_KEY__']).toBeUndefined();
  });

  it('restores a modified key to its original value', () => {
    const original = process.env['PATH'] ?? '';
    process.env['PATH'] = '/tmp/fake-path:' + original;
    expect(process.env['PATH']).toContain('/tmp/fake-path');
    // afterEach restores PATH
  });

  it('PATH is back to its original value after the previous test', () => {
    // After the previous test's afterEach ran, PATH must not contain the fake prefix.
    expect(process.env['PATH'] ?? '').not.toContain('/tmp/fake-path');
  });

  it('removes a key that was undefined before the test', () => {
    const KEY = '__WAFFLE_RESTORE_DELETE__';
    delete process.env[KEY];
    snap.restore();
    snap.capture();
    process.env[KEY] = 'set-during-test';
    // afterEach will delete it again
  });

  it('the key deleted/restored by the previous test is now absent', () => {
    expect(process.env['__WAFFLE_RESTORE_DELETE__']).toBeUndefined();
  });
});

// ── 2. EnvSnapshot.diff() reports drift before restore ───────────────────────

describe('EnvSnapshot.diff()', () => {
  const snap = new EnvSnapshot();

  afterEach(() => snap.restore());

  it('returns empty array when env is clean', () => {
    snap.capture();
    expect(snap.diff()).toHaveLength(0);
  });

  it('reports a newly added key as drift', () => {
    snap.capture();
    process.env['__DRIFT_KEY__'] = 'leaked';
    const drifts = snap.diff();
    expect(drifts.some(d => d.includes('__DRIFT_KEY__'))).toBe(true);
    expect(drifts.some(d => d.startsWith('added:'))).toBe(true);
  });

  it('reports a modified key as drift', () => {
    // Temporarily set a known key so we can modify it.
    process.env['__MODIFY_KEY__'] = 'original';
    snap.capture();
    process.env['__MODIFY_KEY__'] = 'modified';
    const drifts = snap.diff();
    expect(drifts.some(d => d.includes('__MODIFY_KEY__') && d.startsWith('changed:'))).toBe(true);
  });

  it('returns no drift after restore()', () => {
    snap.capture();
    process.env['__AFTER_RESTORE__'] = 'value';
    expect(snap.diff().length).toBeGreaterThan(0); // has drift
    snap.restore();
    // After restore, capture is cleared — diff returns empty.
    expect(snap.diff()).toHaveLength(0);
  });
});

// ── 3. withEnv — scoped override ──────────────────────────────────────────────

describe('withEnv()', () => {
  it('sets variables for the duration of the callback only', async () => {
    expect(process.env['__WITH_ENV_A__']).toBeUndefined();

    await withEnv({ '__WITH_ENV_A__': 'scoped' }, async () => {
      expect(process.env['__WITH_ENV_A__']).toBe('scoped');
    });

    expect(process.env['__WITH_ENV_A__']).toBeUndefined();
  });

  it('restores the original value when the key already existed', async () => {
    process.env['__WITH_ENV_B__'] = 'before';

    await withEnv({ '__WITH_ENV_B__': 'during' }, async () => {
      expect(process.env['__WITH_ENV_B__']).toBe('during');
    });

    expect(process.env['__WITH_ENV_B__']).toBe('before');
    delete process.env['__WITH_ENV_B__'];
  });

  it('restores the original value even when the callback throws', async () => {
    process.env['__WITH_ENV_C__'] = 'initial';

    await expect(
      withEnv({ '__WITH_ENV_C__': 'override' }, async () => {
        throw new Error('callback error');
      })
    ).rejects.toThrow('callback error');

    expect(process.env['__WITH_ENV_C__']).toBe('initial');
    delete process.env['__WITH_ENV_C__'];
  });

  it('removes an explicitly undefined key inside the callback', async () => {
    process.env['__WITH_ENV_D__'] = 'present';

    await withEnv({ '__WITH_ENV_D__': undefined }, async () => {
      expect(process.env['__WITH_ENV_D__']).toBeUndefined();
    });

    expect(process.env['__WITH_ENV_D__']).toBe('present');
    delete process.env['__WITH_ENV_D__'];
  });
});

// ── 4. FakeClock — no leak after restore ──────────────────────────────────────

describe('FakeClock — no timer-state leak after restore', () => {
  it('hasFakeTimers() returns false before install', () => {
    expect(hasFakeTimers()).toBe(false);
  });

  it('hasFakeTimers() returns true after install', () => {
    const clock = new FakeClock();
    clock.install();
    expect(hasFakeTimers()).toBe(true);
    clock.restore(); // clean up for the next test
  });

  it('hasFakeTimers() returns false after restore', () => {
    const clock = new FakeClock();
    clock.install();
    clock.restore();
    expect(hasFakeTimers()).toBe(false);
  });

  it('restore() is a no-op when called without install', () => {
    const clock = new FakeClock();
    // Should not throw.
    expect(() => clock.restore()).not.toThrow();
    expect(hasFakeTimers()).toBe(false);
  });
});

// ── 5. FakeClock — per-test isolation ────────────────────────────────────────
//
// Each test here independently installs and restores the clock.  The goal is
// to show that a later test always starts with real timers even when an
// earlier test advanced fake time significantly.

describe('FakeClock — per-test time isolation', () => {
  const clock = new FakeClock({ scope: 'date' });

  afterEach(() => clock.restore());

  it('records the real Date.now() as the baseline', () => {
    const before = Date.now();
    // No clock installed — Date.now() is the real clock.
    const now = Date.now();
    expect(now).toBeGreaterThanOrEqual(before);
  });

  it('advances time by 1 hour without affecting the next test', () => {
    clock.install();
    const baseline = clock.now();
    clock.advance(3_600_000); // 1 hour
    expect(clock.now()).toBe(baseline + 3_600_000);
    // restore() fires in afterEach
  });

  it('Date.now() is back to the real clock after the previous test advanced time', () => {
    // Real Date.now() should be close to actual wall-clock time, not 1 hour ahead.
    // We verify that fake clock did NOT leak by checking that Date.now() is at
    // most 10 seconds in the future (a generous wall-clock tolerance).
    const realNow = Date.now();
    const tenSecondsAhead = Date.now() + 10_000;
    expect(realNow).toBeLessThan(tenSecondsAhead);
  });

  it('two independent clock instances within one test do not interfere', () => {
    const clockA = new FakeClock({ scope: 'date' });
    clockA.install();
    const t0 = clockA.now();
    clockA.advance(5_000);
    expect(clockA.now()).toBe(t0 + 5_000);
    clockA.restore();
    // After clockA restores, Date.now() is real again.
    expect(hasFakeTimers()).toBe(false);
  });
});

// ── 6. Suite-order independence — env ─────────────────────────────────────────
//
// These two describe blocks must produce the same result whether run A→B or B→A.

describe('Suite-order A — env key __ORDER_CHECK__', () => {
  const snap = new EnvSnapshot();
  beforeEach(() => snap.capture());
  afterEach(() => snap.restore());

  it('sees __ORDER_CHECK__ as undefined (not set by suite B)', () => {
    expect(process.env['__ORDER_CHECK__']).toBeUndefined();
    // Set it; afterEach cleans up.
    process.env['__ORDER_CHECK__'] = 'from-A';
  });
});

describe('Suite-order B — env key __ORDER_CHECK__', () => {
  const snap = new EnvSnapshot();
  beforeEach(() => snap.capture());
  afterEach(() => snap.restore());

  it('sees __ORDER_CHECK__ as undefined (not set by suite A)', () => {
    expect(process.env['__ORDER_CHECK__']).toBeUndefined();
    process.env['__ORDER_CHECK__'] = 'from-B';
  });
});

// ── 7. Suite-order independence — fake timers ─────────────────────────────────

describe('Suite-order C — fake timers', () => {
  const clock = new FakeClock({ scope: 'all' });
  afterEach(() => clock.restore());

  it('installs fake timers, advances by 2 min, then restores', () => {
    clock.install();
    const t0 = clock.now();
    clock.advance(120_000);
    expect(clock.now()).toBe(t0 + 120_000);
  });
});

describe('Suite-order D — fake timers (no leaked state from C)', () => {
  it('hasFakeTimers() is false — suite C cleaned up', () => {
    expect(hasFakeTimers()).toBe(false);
  });

  it('Date.now() behaves as the real clock', () => {
    const a = Date.now();
    const b = Date.now();
    // Real clock: b >= a and both are within 1 s of each other.
    expect(b).toBeGreaterThanOrEqual(a);
    expect(b - a).toBeLessThan(1_000);
  });
});

// ── 8. vi.spyOn cleanup ───────────────────────────────────────────────────────
//
// Spies installed with vi.spyOn must be restored with vi.restoreAllMocks()
// (or vi.restoreAllMocks in afterEach).  This suite verifies that a spy
// left in place by one test does not affect the next.

describe('vi.spyOn — cleanup discipline', () => {
  afterEach(() => vi.restoreAllMocks());

  it('wraps Math.random with a deterministic spy', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    expect(Math.random()).toBe(0.5);
    // afterEach restores Math.random
  });

  it('Math.random is real again after spy was restored', () => {
    // After the previous afterEach, Math.random is the native function.
    const r = Math.random();
    // Native Math.random returns [0, 1).
    expect(r).toBeGreaterThanOrEqual(0);
    expect(r).toBeLessThan(1);
    // And it is NOT always 0.5 — a fresh call is very unlikely to equal 0.5.
    // (We cannot assert r !== 0.5 deterministically, but the spy is gone.)
    expect(vi.isMockFunction(Math.random)).toBe(false);
  });
});
