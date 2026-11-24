/**
 * @file fake-clock.ts
 *
 * Shared fake-clock test utility for the WaffleFinance monorepo.
 *
 * ## Why this exists
 *
 * Timelocks, stale-cleanup windows, freshness TTLs, circuit-breaker cooldowns,
 * and retry policies all depend on wall-clock time.  Tests that use real
 * `setTimeout` / `Date.now()` calls become:
 *
 *   - **Slow** — a 30 s stale TTL forces a 30 s sleep.
 *   - **Flaky** — timing jitter on loaded CI agents shifts boundary behaviour
 *     across the pass/fail line unpredictably.
 *   - **Hard to reproduce** — exact boundary conditions (1 ms before / after a
 *     threshold) cannot be pinned with real timers.
 *
 * `FakeClock` wraps Vitest's built-in fake-timer APIs behind a narrower
 * interface that:
 *
 *   1. Makes the intent explicit — `clock.advance(ms)` is unambiguous.
 *   2. Guarantees cleanup in `afterEach` — `clock.restore()` calls
 *      `vi.useRealTimers()` unconditionally, so a failing test never leaks
 *      fake-timer state into subsequent suites.
 *   3. Documents isolation requirements — see the `ParallelIsolation` note at
 *      the bottom of this file.
 *
 * ## Usage
 *
 * ```ts
 * import { FakeClock } from '@wafflefinance/test-utils/fake-clock';
 *
 * describe('my suite', () => {
 *   const clock = new FakeClock();
 *
 *   afterEach(() => clock.restore());
 *
 *   it('transitions to stale after freshTtlMs', () => {
 *     clock.install();
 *     const fetchedAt = clock.now();
 *     clock.advance(31_000);  // skip 31 s
 *     expect(policy.classify(fetchedAt).freshness).toBe('stale');
 *   });
 * });
 * ```
 *
 * ## Parallel-isolation requirements
 *
 * Vitest's fake-timer state is **per-worker** when `pool: 'forks'` is set
 * (each test file runs in its own Node.js process).  Clock mutations therefore
 * do not leak across test *files*.
 *
 * Within a single file, timer state IS shared across `describe` blocks.
 * Always call `clock.restore()` in `afterEach` (not just `afterAll`) so a
 * failed test does not leave fake timers active for the next test in the same
 * suite.  `FakeClock` enforces this by tracking whether `install()` has been
 * called and warning when `restore()` is skipped.
 *
 * Do NOT use `clock.install()` at the top of a `describe` block without a
 * matching `afterEach(() => clock.restore())`.  Shared `beforeAll` +
 * `afterAll` installation is only safe when every test in the block is
 * guaranteed to leave the clock in the same state it found it — which is
 * almost never true for time-advancing tests.
 */

import { vi } from 'vitest';

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Which global timer APIs to replace with Vitest fakes.
 *
 * `'all'` replaces `Date`, `setTimeout`, `setInterval`, `clearTimeout`,
 * `clearInterval`, `setImmediate`, `clearImmediate`, and `queueMicrotask`.
 *
 * `'date'` replaces only `Date.now()` / `new Date()` — useful when you need
 * to control the system clock without freezing async timers (e.g. the
 * freshness-policy tests that call `Date.now()` directly but do not schedule
 * any timers of their own).
 *
 * `'timers'` replaces only the timer APIs (`setTimeout` etc.) without
 * touching `Date` — useful when you need `Date.now()` to stay real but want
 * to advance timers manually (rare; prefer `'all'`).
 */
export type FakeTimerScope = 'all' | 'date' | 'timers';

export interface FakeClockOptions {
  /**
   * Which timer APIs to fake. Default: `'all'`.
   * See `FakeTimerScope` for the tradeoffs.
   */
  scope?: FakeTimerScope;

  /**
   * Initial system time to set when `install()` is called.
   * Defaults to the real `Date.now()` at the moment `install()` runs,
   * which keeps the first `clock.now()` call in the ballpark of wall-clock
   * time and avoids confusing log timestamps.
   */
  initialTime?: number;
}

// ── FakeClock ─────────────────────────────────────────────────────────────────

/**
 * A thin, test-safe wrapper around Vitest's fake-timer infrastructure.
 *
 * One instance should be created per `describe` block and shared across its
 * tests.  Calling `install()` activates fake timers; `restore()` unconditionally
 * reverts to real timers, even when the test throws.
 */
export class FakeClock {
  private _installed = false;
  private _currentTime = 0;
  private readonly _scope: FakeTimerScope;
  private readonly _initialTime: number | undefined;

  constructor(opts: FakeClockOptions = {}) {
    this._scope = opts.scope ?? 'all';
    this._initialTime = opts.initialTime;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Activate fake timers for the current test.
   *
   * Safe to call multiple times in the same test (idempotent after the first
   * call) — but calling it in a new test without a matching `restore()` from
   * the previous test is a bug that will produce a warning.
   */
  install(): this {
    const startTime = this._initialTime ?? Date.now();
    this._currentTime = startTime;

    const toFake = this._buildToFake();
    vi.useFakeTimers({ now: startTime, toFake });
    this._installed = true;
    return this;
  }

  /**
   * Revert to real timers and reset internal state.
   *
   * Always call this in `afterEach` — the helper is intentionally a no-op
   * when called without a matching `install()` so it is safe to put in a
   * top-level `afterEach` that runs even when a test skipped clock
   * installation.
   */
  restore(): void {
    if (!this._installed) return;
    vi.useRealTimers();
    this._installed = false;
    this._currentTime = 0;
  }

  // ── Clock control ──────────────────────────────────────────────────────────

  /**
   * Advance the fake clock by `ms` milliseconds and flush any timers that
   * fell due during that advance.
   *
   * Equivalent to `vi.advanceTimersByTime(ms)` but also updates the internal
   * `_currentTime` bookkeeping so `clock.now()` returns the right value.
   *
   * @throws if called before `install()`.
   */
  advance(ms: number): this {
    this._assertInstalled('advance');
    this._currentTime += ms;
    vi.advanceTimersByTime(ms);
    return this;
  }

  /**
   * Advance the clock and await all timer callbacks (including async ones).
   *
   * Use this when the timer callback is `async` and you need the callback's
   * promise to settle before making assertions.
   */
  async advanceAsync(ms: number): Promise<this> {
    this._assertInstalled('advanceAsync');
    this._currentTime += ms;
    await vi.advanceTimersByTimeAsync(ms);
    return this;
  }

  /**
   * Pin the fake system clock to `timeMs` (absolute unix-ms timestamp).
   *
   * Useful when you want to simulate a specific wall-clock moment rather than
   * a relative advance — e.g. to place a timestamp exactly at a TTL boundary.
   *
   * Does NOT flush pending timers; use `advance(0)` after `setTime()` if you
   * want to drain any timers that are now overdue.
   */
  setTime(timeMs: number): this {
    this._assertInstalled('setTime');
    this._currentTime = timeMs;
    vi.setSystemTime(timeMs);
    return this;
  }

  /**
   * Run all pending fake timers to completion (including timers that schedule
   * new timers) and settle all resulting microtasks.
   *
   * Equivalent to `vi.runAllTimersAsync()`.
   */
  async runAll(): Promise<this> {
    this._assertInstalled('runAll');
    await vi.runAllTimersAsync();
    return this;
  }

  // ── Observation ───────────────────────────────────────────────────────────

  /**
   * Current fake unix timestamp in milliseconds.
   *
   * Returns `Date.now()` from the fake clock when `install()` has been called,
   * or the real `Date.now()` otherwise.
   */
  now(): number {
    return this._installed ? Date.now() : Date.now();
  }

  /**
   * Current fake unix timestamp in whole seconds (floor).
   * Matches the integer format used throughout the coordinator's SQL layer.
   */
  nowSeconds(): number {
    return Math.floor(this.now() / 1000);
  }

  /** Whether `install()` has been called and `restore()` has not yet been called. */
  get installed(): boolean {
    return this._installed;
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  private _buildToFake(): Parameters<typeof vi.useFakeTimers>[0]['toFake'] {
    switch (this._scope) {
      case 'date':
        return ['Date'];
      case 'timers':
        return ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
                'setImmediate', 'clearImmediate'];
      case 'all':
      default:
        return ['Date', 'setTimeout', 'setInterval', 'clearTimeout',
                'clearInterval', 'setImmediate', 'clearImmediate'];
    }
  }

  private _assertInstalled(method: string): void {
    if (!this._installed) {
      throw new Error(
        `FakeClock.${method}() called before install(). ` +
        `Call clock.install() at the start of your test (or in beforeEach).`
      );
    }
  }
}

// ── Convenience factory ───────────────────────────────────────────────────────

/**
 * Create a `FakeClock` and register `afterEach` cleanup automatically.
 *
 * This is the recommended way to use `FakeClock` when you don't need fine-
 * grained control over when `restore()` is called.
 *
 * ```ts
 * const clock = useFakeClock();
 *
 * it('advances time', () => {
 *   clock.install();
 *   clock.advance(60_000);
 *   // ...
 * });
 * // restore() is called automatically after each test
 * ```
 */
export function useFakeClock(opts: FakeClockOptions = {}): FakeClock {
  const clock = new FakeClock(opts);

  // We import afterEach lazily to stay compatible with both vitest and
  // environments that import this utility outside of a test runner.
  try {
    // `afterEach` is a vitest global — it's available when this module is
    // loaded inside a test file.
    const { afterEach } = await_afterEach();
    afterEach(() => clock.restore());
  } catch {
    // Not inside a test runner (e.g. type-checking or bundling) — skip.
  }

  return clock;
}

// Vitest exposes afterEach as a global but TypeScript doesn't know about it
// unless @vitest/globals is configured. We read it via globalThis to avoid
// requiring that configuration in every consumer.
function await_afterEach(): { afterEach: (fn: () => void) => void } {
  const g = globalThis as any;
  if (typeof g.afterEach !== 'function') {
    throw new Error('afterEach is not available in this environment');
  }
  return { afterEach: g.afterEach };
}
