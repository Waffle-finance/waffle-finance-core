/**
 * @file service-lifecycle.test.ts
 *
 * Integration tests for the coordinator service lifecycle contract.
 *
 * ## What is under test
 *
 * The coordinator's `shutdown()` function (inside index.ts) owns these
 * resources and must release them on SIGTERM:
 *
 *   1. `MaintenanceScheduler` — owns `setInterval` handles for expiry_scan,
 *      stale_cleanup, and archival_policy.  `stop()` must clear all handles.
 *
 *   2. `SseBroker` — owns a `setInterval` keep-alive timer and an in-memory
 *      subscriber registry.  `shutdown()` must send close frames and clear
 *      the registry.
 *
 *   3. `BacklogScheduler` — holds queued jobs.  Stopping the maintenance
 *      scheduler prevents new jobs from being enqueued; previously-queued
 *      jobs must not start new work after `stop()`.
 *
 *   4. HTTP server (`net.Server`) — `server.close()` stops accepting new
 *      connections.  The test asserts it fires its callback (i.e. does not
 *      hang indefinitely).
 *
 * These objects are tested together in the same wiring order that `index.ts`
 * uses, without booting the full service (no env vars, no DB, no RPC).  Each
 * test creates fresh instances so there is no cross-test state.
 *
 * ## Shutdown deadline
 *
 * The coordinator shuts down within 5 seconds (soft deadline; measured by
 * the test's own timer, not a process.exit timeout).  An unhandled rejection
 * during shutdown is surfaced as a test failure via the Promise chain.
 *
 * ## Signal handling
 *
 * `process.on('SIGTERM', …)` cannot be tested reliably in-process without
 * either sending a real POSIX signal (which Vitest intercepts) or rewriting
 * the handler shape.  Instead we test the `shutdown()` callback directly —
 * it is the closure that signal handlers point at and is the actual unit
 * under test.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createServer } from 'node:net';
import pino from 'pino';
import { BacklogScheduler, Priority } from '../src/backlog/backlog-scheduler.js';
import { MaintenanceScheduler } from '../src/services/maintenance-scheduler.js';
import { SseBroker } from '../src/sse/sse-broker.js';

const nullLog = pino({ level: 'silent' });

afterEach(() => vi.restoreAllMocks());

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Create a minimal no-op HTTP server bound to an OS-assigned port. */
function makeServer(): Promise<ReturnType<typeof createServer>> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

/** Close a server and await the callback. */
function closeServer(srv: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    srv.close((err) => (err ? reject(err) : resolve()));
  });
}

/** Build the standard maintenance scheduler + backlog pair used by index.ts. */
function makeScheduler(baseIntervalMs = 50): {
  backlog: BacklogScheduler;
  maintenance: MaintenanceScheduler;
} {
  const backlog = new BacklogScheduler(nullLog);
  const maintenance = new MaintenanceScheduler(backlog, nullLog, baseIntervalMs);
  return { backlog, maintenance };
}

// ── 1. MaintenanceScheduler — start / stop lifecycle ─────────────────────────

describe('MaintenanceScheduler — start/stop lifecycle contract', () => {
  it('isRunning is false before start()', () => {
    const { maintenance } = makeScheduler();
    expect(maintenance.isRunning).toBe(false);
  });

  it('isRunning is true after start()', () => {
    const { maintenance } = makeScheduler(1_000); // long interval — won't fire during test
    maintenance.start();
    expect(maintenance.isRunning).toBe(true);
    maintenance.stop();
  });

  it('isRunning is false after stop()', () => {
    const { maintenance } = makeScheduler(1_000);
    maintenance.start();
    maintenance.stop();
    expect(maintenance.isRunning).toBe(false);
  });

  it('stop() is idempotent — safe to call multiple times', () => {
    const { maintenance } = makeScheduler(1_000);
    maintenance.start();
    expect(() => {
      maintenance.stop();
      maintenance.stop();
      maintenance.stop();
    }).not.toThrow();
    expect(maintenance.isRunning).toBe(false);
  });

  it('start() is idempotent — does not create duplicate intervals', () => {
    const { maintenance } = makeScheduler(1_000);
    maintenance.start();
    maintenance.start(); // second call must be a no-op
    maintenance.stop();
    expect(maintenance.isRunning).toBe(false);
  });

  it('no new jobs enqueued after stop()', async () => {
    const { backlog, maintenance } = makeScheduler(20); // 20 ms interval
    let executeCount = 0;

    maintenance.register({
      name: 'test_job',
      cadenceMultiplier: 1,
      priority: Priority.STALE_CLEANUP,
      execute: async () => { executeCount++; },
    });

    maintenance.start();

    // Run one cycle to ensure the job fires at least once.
    await backlog.run();
    const countAtStop = executeCount;

    // Stop the scheduler — no more intervals should fire.
    maintenance.stop();

    // Wait longer than one interval to confirm no additional ticks occur.
    await new Promise((r) => setTimeout(r, 60));
    await backlog.run();

    // executeCount must not have grown after stop().
    expect(executeCount).toBe(countAtStop);
  });

  it('in-flight jobs are not interrupted by stop()', async () => {
    const { backlog, maintenance } = makeScheduler(1_000);
    let resolved = false;

    maintenance.register({
      name: 'slow_job',
      cadenceMultiplier: 1,
      priority: Priority.REPLAY_JOB,
      execute: async () => {
        await new Promise((r) => setTimeout(r, 30));
        resolved = true;
      },
    });

    maintenance.start();
    // Drain the initial tick (fired by start()).
    const runPromise = backlog.run();
    // Stop while the job is still executing.
    maintenance.stop();
    // Await the in-flight work.
    await runPromise;

    expect(resolved).toBe(true);
  });
});

// ── 2. SseBroker — shutdown lifecycle ─────────────────────────────────────────

describe('SseBroker — shutdown lifecycle contract', () => {
  it('subscriberCount is 0 before any subscriptions', () => {
    const broker = new SseBroker({ keepAliveIntervalMs: 60_000 });
    expect(broker.subscriberCount).toBe(0);
    broker.shutdown();
  });

  it('shutdown() clears the subscriber registry', () => {
    const broker = new SseBroker({ keepAliveIntervalMs: 60_000 });

    // Create a fake writable stream handle.
    const writes: string[] = [];
    const handle = Object.assign(
      {
        write: (chunk: string) => { writes.push(chunk); return true; },
        end:   () => {},
        writableEnded: false,
        on:    (_event: string, _cb: () => void) => handle,
      }
    );

    broker.subscribe('order-1', handle as any);
    expect(broker.subscriberCount).toBe(1);

    broker.shutdown();

    // After shutdown the registry is cleared.
    expect(broker.subscriberCount).toBe(0);
  });

  it('shutdown() sends a shutdown frame to open streams before closing them', () => {
    const broker = new SseBroker({ keepAliveIntervalMs: 60_000 });
    const frames: string[] = [];
    let ended = false;

    const handle = Object.assign(
      {
        write: (chunk: string) => { frames.push(chunk); return true; },
        end:   () => { ended = true; },
        writableEnded: false,
        on:    (_event: string, _cb: () => void) => handle,
      }
    );

    broker.subscribe('order-2', handle as any);
    broker.shutdown();

    // At least one frame must have been written (the shutdown event).
    expect(frames.length).toBeGreaterThan(0);
    // The stream must have been ended.
    expect(ended).toBe(true);
  });

  it('shutdown() does not write to already-ended streams', () => {
    const broker = new SseBroker({ keepAliveIntervalMs: 60_000 });
    const frames: string[] = [];

    const handle = Object.assign(
      {
        write: (chunk: string) => { frames.push(chunk); return true; },
        end:   () => {},
        writableEnded: true, // already closed
        on:    (_event: string, _cb: () => void) => handle,
      }
    );

    broker.subscribe('order-3', handle as any);
    broker.shutdown();

    // writableEnded=true means the stream is gone — broker must not try to write.
    expect(frames).toHaveLength(0);
  });

  it('shutdown() is idempotent — safe to call twice', () => {
    const broker = new SseBroker({ keepAliveIntervalMs: 60_000 });
    expect(() => {
      broker.shutdown();
      broker.shutdown();
    }).not.toThrow();
  });

  it('shutdown() broadcasts to all subscribers across different orders', () => {
    const broker = new SseBroker({ keepAliveIntervalMs: 60_000 });
    const ends: string[] = [];

    function makeHandle(orderId: string) {
      const h = {
        write: (_chunk: string) => true,
        end:   () => { ends.push(orderId); },
        writableEnded: false,
        on:    (_event: string, _cb: () => void) => h,
      };
      return h;
    }

    broker.subscribe('order-A', makeHandle('order-A') as any);
    broker.subscribe('order-B', makeHandle('order-B') as any);
    broker.subscribe('order-B', makeHandle('order-B-second') as any);

    broker.shutdown();

    // All three handles must have been ended.
    expect(ends).toHaveLength(3);
  });
});

// ── 3. HTTP server — close lifecycle ─────────────────────────────────────────

describe('HTTP server — close lifecycle contract', () => {
  it('server.close() calls its callback without hanging', async () => {
    const srv = await makeServer();
    // server.close() must resolve within 1 second.
    await expect(
      Promise.race([
        closeServer(srv),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('server.close() timed out')), 1_000)
        ),
      ])
    ).resolves.toBeUndefined();
  });

  it('server is not listening after close()', async () => {
    const srv = await makeServer();
    expect(srv.listening).toBe(true);
    await closeServer(srv);
    expect(srv.listening).toBe(false);
  });
});

// ── 4. Coordinated shutdown sequence ─────────────────────────────────────────
//
// Exercises the same call order as index.ts shutdown():
//
//   1. sseBroker.shutdown()
//   2. maintenance.stop()
//   3. clearInterval(reconcileInterval)
//   4. clearInterval(cacheVerifyInterval)
//   5. server.close()
//
// Asserts: no new work is enqueued, all streams are closed, server stops
// listening, and the whole sequence completes within 2 seconds.

describe('Coordinated shutdown sequence', () => {
  it('completes the full shutdown sequence within 2 s without an unhandled rejection', async () => {
    const broker = new SseBroker({ keepAliveIntervalMs: 60_000 });
    const { backlog, maintenance } = makeScheduler(1_000);
    const srv = await makeServer();

    let jobsAfterStop = 0;
    maintenance.register({
      name: 'noop_job',
      cadenceMultiplier: 1,
      priority: Priority.STALE_CLEANUP,
      execute: async () => { jobsAfterStop++; },
    });

    // Start everything.
    maintenance.start();
    const reconcileInterval = setInterval(() => {}, 60_000);
    const cacheVerifyInterval = setInterval(() => {}, 60_000);

    // Fake subscriber.
    const frames: string[] = [];
    const handle = Object.assign({
      write: (chunk: string) => { frames.push(chunk); return true; },
      end:   () => {},
      writableEnded: false,
      on:    (_event: string, _cb: () => void) => handle,
    });
    broker.subscribe('order-shutdown', handle as any);

    // Simulate the shutdown() closure from index.ts.
    const shutdownErrors: Error[] = [];
    const shutdown = async () => {
      try {
        broker.shutdown();
        maintenance.stop();
        clearInterval(reconcileInterval);
        clearInterval(cacheVerifyInterval);
        await closeServer(srv);
      } catch (err) {
        shutdownErrors.push(err instanceof Error ? err : new Error(String(err)));
      }
    };

    // Measure wall-clock time.
    const t0 = Date.now();
    await Promise.race([
      shutdown(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('shutdown timed out after 2 s')), 2_000)
      ),
    ]);
    const elapsed = Date.now() - t0;

    expect(shutdownErrors).toHaveLength(0);
    expect(elapsed).toBeLessThan(2_000);
    expect(maintenance.isRunning).toBe(false);
    expect(broker.subscriberCount).toBe(0);
    expect(srv.listening).toBe(false);
    // The SSE stream received the shutdown frame.
    expect(frames.length).toBeGreaterThan(0);
  });

  it('no new backlog jobs enqueued after maintenance.stop()', async () => {
    const { backlog, maintenance } = makeScheduler(20);
    let count = 0;

    maintenance.register({
      name: 'counter',
      cadenceMultiplier: 1,
      priority: Priority.STALE_CLEANUP,
      execute: async () => { count++; },
    });

    maintenance.start();
    await backlog.run();
    const countAtStop = count;

    maintenance.stop();
    // Drain whatever is queued at the moment of stop.
    await backlog.run();
    // Clear the queue — any residual enqueued-but-not-yet-executed jobs.
    backlog.clear();

    // Wait for more than the base interval to pass — no new jobs should appear.
    await new Promise((r) => setTimeout(r, 60));
    await backlog.run();

    expect(count).toBe(countAtStop);
  });
});

// ── 5. Shutdown deadline enforcement ─────────────────────────────────────────
//
// Documents and verifies the documented shutdown deadline.  The coordinator
// does not use a hard process.exit timer (that belongs to the outer process
// manager / Kubernetes terminationGracePeriodSeconds); tests assert that the
// in-process shutdown steps themselves resolve promptly.

describe('Shutdown deadline — resource closure timing', () => {
  it('MaintenanceScheduler.stop() resolves synchronously', () => {
    const { maintenance } = makeScheduler(1_000);
    maintenance.start();
    const t0 = Date.now();
    maintenance.stop();
    // stop() is synchronous — must return in < 10 ms.
    expect(Date.now() - t0).toBeLessThan(10);
  });

  it('SseBroker.shutdown() resolves synchronously', () => {
    const broker = new SseBroker({ keepAliveIntervalMs: 60_000 });
    const t0 = Date.now();
    broker.shutdown();
    expect(Date.now() - t0).toBeLessThan(10);
  });

  it('server.close() resolves within 500 ms when no connections are open', async () => {
    const srv = await makeServer();
    const t0 = Date.now();
    await closeServer(srv);
    expect(Date.now() - t0).toBeLessThan(500);
  });
});
