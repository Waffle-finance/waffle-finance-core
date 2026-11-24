/**
 * @file isolation.ts
 *
 * Shared test-isolation helpers for the WaffleFinance monorepo.
 *
 * Tests that mutate `process.env`, install global timers, or register module
 * mocks can silently corrupt later tests when the mutations are not fully
 * undone on failure.  This module provides lightweight wrappers that:
 *
 *   - Snapshot the original state before each test.
 *   - Restore it unconditionally in `afterEach`, even if the test throws.
 *   - Expose assertion helpers that verify isolation is working.
 *
 * ## Isolation contract for parallel test execution
 *
 * When Vitest runs with `pool: 'forks'` (the default for coordinator and
 * relayer), each *file* runs in its own Node.js worker process.  Global state
 * (env vars, timers, module-level singletons) is therefore isolated at the
 * file level automatically.
 *
 * Within a file, tests share the same process.  The helpers here enforce the
 * within-file contract:
 *
 *   - `withEnv` / `EnvSnapshot` guard `process.env`.
 *   - `FakeClock` (fake-clock.ts) guards timer APIs.
 *   - Module-level singletons that expose `_resetForTest` hooks (e.g.
 *     `relayer/src/shutdown.ts`) must be reset in `beforeEach` by callers;
 *     the `assertModuleReset` helper documents and verifies this expectation.
 */

// ── Environment snapshot ───────────────────────────────────────────────────

/**
 * Snapshot of `process.env` entries that were set by a test.
 *
 * Usage — wrap the body of a test (or `beforeEach`) with `EnvSnapshot`:
 *
 * ```ts
 * const env = new EnvSnapshot();
 * beforeEach(() => env.capture());
 * afterEach(() => env.restore());
 *
 * it('uses a custom RPC URL', () => {
 *   process.env.ETH_RPC_URL = 'https://test-rpc.example';
 *   // ... test body ...
 * });
 * // ETH_RPC_URL is restored to whatever it was before the test, even if the
 * // test throws.
 * ```
 */
export class EnvSnapshot {
  private _snapshot: Record<string, string | undefined> = {};
  private _captured = false;

  /**
   * Capture the current `process.env` so `restore()` knows what to roll back
   * to.  Call this in `beforeEach`.
   */
  capture(): void {
    this._snapshot = { ...process.env };
    this._captured = true;
  }

  /**
   * Restore `process.env` to the state captured by the last `capture()` call.
   *
   * - Keys that existed before but were deleted during the test are restored.
   * - Keys that were added during the test are removed.
   * - Keys that existed and were modified are reset to their original values.
   *
   * Safe to call even when `capture()` was never called (no-op).
   */
  restore(): void {
    if (!this._captured) return;

    // Remove keys that were added during the test.
    for (const key of Object.keys(process.env)) {
      if (!(key in this._snapshot)) {
        delete process.env[key];
      }
    }

    // Restore keys that were modified or removed.
    for (const [key, value] of Object.entries(this._snapshot)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }

    this._captured = false;
    this._snapshot = {};
  }

  /**
   * Assert that the current `process.env` matches the captured snapshot.
   *
   * Use this in a dedicated "isolation check" test to verify that a previous
   * test's `afterEach` cleaned up correctly.
   *
   * @returns An array of drift descriptions; empty when env is clean.
   */
  diff(): string[] {
    if (!this._captured) return [];
    const issues: string[] = [];

    for (const key of Object.keys(process.env)) {
      if (!(key in this._snapshot)) {
        issues.push(`added: ${key}=${process.env[key]}`);
      } else if (process.env[key] !== this._snapshot[key]) {
        issues.push(`changed: ${key} (was "${this._snapshot[key]}", now "${process.env[key]}")`);
      }
    }
    for (const key of Object.keys(this._snapshot)) {
      if (!(key in process.env)) {
        issues.push(`removed: ${key} (was "${this._snapshot[key]}")`);
      }
    }

    return issues;
  }
}

// ── withEnv ───────────────────────────────────────────────────────────────────

/**
 * Temporarily set `process.env` entries for a callback, then restore them.
 *
 * ```ts
 * await withEnv({ DATABASE_URL: 'sqlite::memory:' }, async () => {
 *   const cfg = loadConfig();
 *   expect(cfg.databaseUrl).toBe('sqlite::memory:');
 * });
 * ```
 *
 * This is the simplest option for one-off env changes in a single test.
 * For suites with many tests that all need the same env, `EnvSnapshot` with
 * `beforeEach`/`afterEach` is a better fit.
 */
export async function withEnv<T>(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<T> | T,
): Promise<T> {
  const snap = new EnvSnapshot();
  snap.capture();
  try {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    return await fn();
  } finally {
    snap.restore();
  }
}

// ── Timer-leak detector ───────────────────────────────────────────────────────

/**
 * Detect whether fake timers are currently active.
 *
 * Returns `true` when `vi.useFakeTimers()` has been called but
 * `vi.useRealTimers()` has not yet been called.
 *
 * Use this in an isolation-check test that runs *after* a suite that installs
 * fake timers, to assert the previous suite cleaned up properly:
 *
 * ```ts
 * it('no fake timers left active after the previous suite', () => {
 *   expect(hasFakeTimers()).toBe(false);
 * });
 * ```
 */
export function hasFakeTimers(): boolean {
  // `vi.isFakeTimers()` is the canonical Vitest API for this check.
  try {
    const { vi } = await_vi();
    return vi.isFakeTimers();
  } catch {
    return false;
  }
}

function await_vi(): { vi: typeof import('vitest').vi } {
  const g = globalThis as any;
  if (!g.vi || typeof g.vi.isFakeTimers !== 'function') {
    throw new Error('vi is not available in this environment');
  }
  return { vi: g.vi };
}

// ── assertModuleReset ─────────────────────────────────────────────────────────

/**
 * Assert that a module exposes a test-reset function and call it.
 *
 * Many modules carry module-level state (singleton flags, caches, counters)
 * that must be reset between tests.  Vitest does NOT re-evaluate modules
 * between tests in the same file; callers must explicitly reset.
 *
 * ```ts
 * import { _resetShutdownStateForTest } from '../src/shutdown.js';
 *
 * beforeEach(() => {
 *   assertModuleReset('shutdown', _resetShutdownStateForTest);
 * });
 * ```
 *
 * The first argument is a human-readable module name used in error messages.
 */
export function assertModuleReset(moduleName: string, resetFn: (() => void) | undefined): void {
  if (typeof resetFn !== 'function') {
    throw new Error(
      `assertModuleReset: module "${moduleName}" does not export a reset function. ` +
      `Add a \`_resetForTest()\` export (or equivalent) to allow isolation between tests.`
    );
  }
  resetFn();
}
