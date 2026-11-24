/**
 * @file service-lifecycle.test.ts
 *
 * Integration tests for the relayer service lifecycle contract.
 *
 * ## What is under test
 *
 * The relayer's shutdown path (`relayer/src/shutdown.ts`) owns:
 *
 *   1. **Idempotency flag** (`_shuttingDown`) — a second SIGTERM while the
 *      first shutdown is in progress must be a no-op.  Tested via the exported
 *      `_resetShutdownStateForTest` hook.
 *
 *   2. **Resource closure** — `ethereumListener.stopListening()` must be
 *      called exactly once; subsequent calls must be skipped.
 *
 *   3. **process.exit(0)** — called exactly once on the first shutdown.
 *
 *   4. **Shutdown deadline** — the entire shutdown sequence must complete
 *      within a documented wall-clock budget.  `resolver/src/commands/run.ts`
 *      uses `SHUTDOWN_TIMEOUT_MS = 15 000`; here we document and assert a
 *      conservative 5 s budget for the relayer's simpler teardown.
 *
 *   5. **No unhandled rejection** — a listener that rejects during `stopListening()`
 *      must be caught and logged, not propagated as an unhandled rejection.
 *
 * ## Strategy
 *
 * We import `shutdown.ts` directly (never `index.ts`) so the HTTP server and
 * env-var loading are never touched.  The Ethereum listener is mocked at the
 * Vitest module level so `stopListening()` is a fully controllable spy.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FakeClock } from '../../packages/test-utils/src/fake-clock.js';
import { gracefulShutdown, _resetShutdownStateForTest } from '../src/shutdown.js';

// ---------------------------------------------------------------------------
// Mock the Ethereum listener so stopListening() never touches a real provider
// ---------------------------------------------------------------------------

vi.mock('../src/listeners/ethereum-listener.js', () => ({
  ethereumListener: {
    stopListening: vi.fn().mockResolvedValue(undefined),
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getListener() {
  const { ethereumListener } = await import('../src/listeners/ethereum-listener.js');
  return ethereumListener;
}

// ---------------------------------------------------------------------------
// Suite setup
// ---------------------------------------------------------------------------

let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  // Prevent process.exit from terminating the test runner.
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  // Reset the module-level idempotency flag before every test.
  _resetShutdownStateForTest();
  // Clear any previous call counts on the listener spy.
  (await getListener()).stopListening.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── 1. First-call semantics ───────────────────────────────────────────────────

describe('gracefulShutdown — first-call semantics', () => {
  it('calls stopListening() exactly once', async () => {
    const listener = await getListener();
    await gracefulShutdown();
    expect(listener.stopListening).toHaveBeenCalledTimes(1);
  });

  it('calls process.exit(0) exactly once', async () => {
    await gracefulShutdown();
    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('resolves without throwing', async () => {
    await expect(gracefulShutdown()).resolves.toBeUndefined();
  });
});

// ── 2. Idempotency ────────────────────────────────────────────────────────────

describe('gracefulShutdown — idempotency (SIGTERM repeated delivery)', () => {
  it('second call does not invoke stopListening again', async () => {
    const listener = await getListener();
    await gracefulShutdown();
    await gracefulShutdown();
    expect(listener.stopListening).toHaveBeenCalledTimes(1);
  });

  it('second call does not invoke process.exit again', async () => {
    await gracefulShutdown();
    exitSpy.mockClear();
    await gracefulShutdown();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('third and subsequent calls are also no-ops', async () => {
    const listener = await getListener();
    await gracefulShutdown();
    await gracefulShutdown();
    await gracefulShutdown();
    expect(listener.stopListening).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledTimes(1);
  });

  it('concurrent calls: only the first executes cleanup', async () => {
    const listener = await getListener();
    // Fire three concurrent shutdowns — only the first should run cleanup.
    await Promise.all([gracefulShutdown(), gracefulShutdown(), gracefulShutdown()]);
    expect(listener.stopListening).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledTimes(1);
  });
});

// ── 3. Error resilience ───────────────────────────────────────────────────────

describe('gracefulShutdown — error resilience', () => {
  it('process.exit(0) is still called when stopListening() rejects', async () => {
    const listener = await getListener();
    vi.mocked(listener.stopListening).mockRejectedValueOnce(
      new Error('listener teardown failed')
    );

    // gracefulShutdown catches listener errors internally — must not reject.
    await expect(gracefulShutdown()).resolves.toBeUndefined();
    // process.exit must still be reached despite the listener failure.
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('a listener that throws synchronously is caught and exit still fires', async () => {
    const listener = await getListener();
    vi.mocked(listener.stopListening).mockImplementationOnce(() => {
      throw new Error('sync throw from listener');
    });

    await expect(gracefulShutdown()).resolves.toBeUndefined();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});

// ── 4. Shutdown deadline ──────────────────────────────────────────────────────
//
// The entire gracefulShutdown() must complete within the documented deadline.
// We verify two scenarios:
//   a) Fast path — stopListening resolves immediately.
//   b) Slow path — stopListening takes non-trivially long; still within budget.

describe('gracefulShutdown — shutdown deadline', () => {
  const SHUTDOWN_BUDGET_MS = 5_000;

  it('completes well within the budget on the fast path', async () => {
    const t0 = Date.now();
    await gracefulShutdown();
    expect(Date.now() - t0).toBeLessThan(SHUTDOWN_BUDGET_MS);
  });

  it('completes within the budget even when stopListening takes 100 ms', async () => {
    const listener = await getListener();
    vi.mocked(listener.stopListening).mockImplementationOnce(
      () => new Promise((r) => setTimeout(r, 100))
    );

    const t0 = Date.now();
    await gracefulShutdown();
    expect(Date.now() - t0).toBeLessThan(SHUTDOWN_BUDGET_MS);
  });
});

// ── 5. Reset hook integrity ───────────────────────────────────────────────────
//
// _resetShutdownStateForTest() must restore the initial module state so the
// following call to gracefulShutdown() behaves as if no prior shutdown ran.

describe('_resetShutdownStateForTest — integrity', () => {
  it('allows gracefulShutdown() to run again after a reset', async () => {
    const listener = await getListener();

    await gracefulShutdown();             // first shutdown
    expect(listener.stopListening).toHaveBeenCalledTimes(1);

    _resetShutdownStateForTest();         // reset the flag
    listener.stopListening.mockClear();
    exitSpy.mockClear();

    await gracefulShutdown();             // second shutdown (after reset)
    expect(listener.stopListening).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('multiple resets in sequence are safe', () => {
    expect(() => {
      _resetShutdownStateForTest();
      _resetShutdownStateForTest();
      _resetShutdownStateForTest();
    }).not.toThrow();
  });
});

// ── 6. Signal sequence: SIGTERM → SIGTERM ────────────────────────────────────
//
// Container runtimes (Docker, Kubernetes) often send SIGTERM, wait for
// terminationGracePeriodSeconds, then send SIGKILL.  In rare cases they also
// re-deliver SIGTERM.  Simulated here by calling the shutdown handler twice
// in quick succession with a realistic async gap between them.

describe('gracefulShutdown — SIGTERM → SIGTERM delivery sequence', () => {
  it('handles SIGTERM delivered 50 ms after the first graceful shutdown started', async () => {
    const listener = await getListener();

    // First SIGTERM — slow listener (200 ms) simulates in-progress teardown.
    vi.mocked(listener.stopListening).mockImplementationOnce(
      () => new Promise((r) => setTimeout(r, 200))
    );

    const first = gracefulShutdown(); // starts but has not finished

    // Second SIGTERM arrives 50 ms later while teardown is in progress.
    await new Promise((r) => setTimeout(r, 50));
    await gracefulShutdown();         // must be a no-op

    await first;                      // wait for the original to complete

    expect(listener.stopListening).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledTimes(1);
  });
});

// ── 7. FakeClock — no interaction with shutdown timing ───────────────────────
//
// Verifies that the FakeClock utility installed by another suite does not
// interfere with the real setTimeout used inside gracefulShutdown.  This is
// a sanity check that the per-file clock isolation contract holds.

describe('gracefulShutdown — real timer independence', () => {
  const clock = new FakeClock({ scope: 'all' });

  afterEach(() => clock.restore());

  it('gracefulShutdown() resolves even when fake timers are active', async () => {
    // Install fake timers — the shutdown module uses a dynamic import chain
    // but no internal setTimeouts, so fake timers should not interfere.
    clock.install();

    const listener = await getListener();
    await gracefulShutdown();

    expect(listener.stopListening).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
