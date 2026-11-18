import type { Logger } from "pino";
import { ResolverLifecycle, LifecycleState } from "./lifecycle.js";

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * SupervisorOptions with optional lifecycle integration.
 *
 * If lifecycle is provided, the supervisor will update it on state changes.
 * Otherwise, the supervisor manages its own internal state.
 */
export interface SupervisorOptions {
  log: Logger;
  /** Maximum number of listener restarts before the supervisor gives up. */
  maxRestarts?: number;
  /** Base delay in ms before the first restart attempt. Doubles on each retry. */
  restartDelayMs?: number;
  /**
   * Maximum cap on the restart delay (ms).  Prevents the backoff from growing
   * unbounded on a repeatedly failing listener.  Default: 60 000 (1 minute).
   */
  maxRestartDelayMs?: number;
  /**
   * Optional lifecycle manager.  If provided, the supervisor will update
   * this lifecycle on state changes, allowing for more detailed lifecycle
   * tracking beyond the basic supervisor states.
   */
  lifecycle?: ResolverLifecycle;
}

export interface ListenerSet {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Supervisor state transitions:
 *
 * - `idle`         — not yet started.
 * - `starting`     — listeners are being initialized.
 * - `running`      — listeners are active.
 * - `pausing`      — graceful pause requested; draining in-flight work.
 * - `paused`       — all listeners paused.
 * - `restarting`   — recoverable error; waiting before retry.
 * - `stopping`     — stop() was called; teardown in progress.
 * - `stopped`      — cleanly stopped (via stop() or clean exit).
 * - `failed`       — exhausted restarts or fatal error.
 *
 * Note: The supervisor's internal _state only tracks basic states for
 * restart logic.  For full lifecycle management (including pausing),
 * use the optional `lifecycle` parameter which updates the lifecycle manager.
 */
export type SupervisorState = 
  | "idle" 
  | "starting" 
  | "running" 
  | "pausing" 
  | "paused" 
  | "restarting" 
  | "stopping" 
  | "stopped" 
  | "failed";

// ── Supervisor ────────────────────────────────────────────────────────────────

/**
 * Supervises a set of listeners, restarting them on recoverable errors and
 * giving up after exceeding the configured restart ceiling.
 *
 * Key guarantees:
 *  - stop() is idempotent and safe to call from any lifecycle state.
 *  - run() resolves cleanly when stop() is called mid-restart (no throw).
 *  - FatalError propagates immediately without restart delay.
 *  - Restart delay is capped at maxRestartDelayMs to bound wait time.
 *  - state transitions are monotonic: idle → running → {restarting,stopping} → {stopped,failed}.
 */
export class Supervisor {
  private _stopped = false;
  private _state: SupervisorState = "idle";
  private restartCount = 0;

  private readonly log: Logger;
  private readonly maxRestarts: number;
  private readonly restartDelayMs: number;
  private readonly maxRestartDelayMs: number;
  private readonly lifecycle?: ResolverLifecycle;

  /** Resolves the current sleep between restart attempts, if active. */
  private sleepReject?: (err: Error) => void;

  constructor(opts: SupervisorOptions) {
    this.log = opts.log.child({ component: "Supervisor" });
    this.maxRestarts = opts.maxRestarts ?? 5;
    this.restartDelayMs = opts.restartDelayMs ?? 5_000;
    this.maxRestartDelayMs = opts.maxRestartDelayMs ?? 60_000;
    this.lifecycle = opts.lifecycle;
  }

  // ── Public accessors ───────────────────────────────────────────────────────

  /**
   * Current supervisor state.  Exposed so health endpoints can surface it
   * without distinguishing between "never started" and "cleanly stopped".
   */
  get state(): SupervisorState {
    return this._state;
  }

  /** @deprecated Use `state` instead. Kept for backward-compatibility. */
  get isStopped(): boolean {
    return this._stopped;
  }

  get restarts(): number {
    return this.restartCount;
  }

  /**
   * Get the lifecycle state.
   *
   * If a lifecycle manager was provided to the constructor, returns its state.
   * Otherwise, maps the supervisor state to the lifecycle state.
   */
  get lifecycleState(): LifecycleState {
    if (this.lifecycle) {
      return this.lifecycle.state;
    }

    // Map supervisor state to lifecycle state
    switch (this._state) {
      case "idle":
        return "idle";
      case "starting":
        return "starting";
      case "running":
        return "running";
      case "restarting":
        return "restarting";
      case "stopping":
        return "stopping";
      case "stopped":
        return "stopped";
      case "failed":
        return "failed";
      default:
        return "failed";
    }
  }

  // ── Core logic ─────────────────────────────────────────────────────────────

  /**
   * Determine whether an error is recoverable (i.e., worth restarting over).
   * FatalError is never recoverable.  All other error types are treated as
   * transient by default.
   */
  isRecoverable(err: unknown): boolean {
    if (err instanceof FatalError) return false;
    return true;
  }

  /**
   * Run the given listener set, restarting it on recoverable errors until
   * `maxRestarts` is exceeded.
   *
   * - Resolves when the listener exits cleanly or when `stop()` is called.
   * - Rejects with a `FatalError` on a non-recoverable listener error.
   * - Rejects with a plain `Error` when max restarts are exceeded.
   *
   * Calling `stop()` while a restart sleep is in progress cancels the sleep
   * immediately so teardown is not delayed.
   */
  async run(listeners: ListenerSet): Promise<void> {
    this._state = "starting";
    this.lifecycle?.transition('starting');

    // Startup: attempt to start listeners
    try {
      await listeners.start();
    } catch (err) {
      // Failed startup
      this._state = "failed";
      this.lifecycle?.transition('failed');
      this.log.error({ err }, "fatal listener error — aborting supervisor");
      throw err;
    }

    // Shutdown may have been requested while startup was still in flight.
    // Never mark the service running after shutdown began — tear down the
    // late listener instead so no subscription leaks.
    if (this._stopped) {
      await this.absorbLateStartup(listeners);
      return;
    }

    this._state = "running";
    this.lifecycle?.transition('running');

    while (!this._stopped) {
      try {
        await listeners.start();
        // Shutdown may also have arrived during this (re)start. Tear down
        // the late listener rather than leaking it on the clean-exit path.
        if (this._stopped) {
          await this.absorbLateStartup(listeners);
          return;
        }
        // Clean exit — listeners finished without error.
        this._state = "stopped";
        this.lifecycle?.transition('stopped');
        return;
      } catch (err) {
        if (this._stopped) {
          // stop() was called while listeners were running — absorb the error.
          this._state = "stopped";
          this.lifecycle?.transition('stopped');
          return;
        }

        if (!this.isRecoverable(err)) {
          this._state = "failed";
          this.lifecycle?.transition('failed');
          this.log.error({ err }, "fatal listener error — aborting supervisor");
          throw err;
        }

        this.restartCount++;

        if (this.restartCount > this.maxRestarts) {
          this._state = "failed";
          this.lifecycle?.transition('failed');
          this.log.error(
            { restartCount: this.restartCount, maxRestarts: this.maxRestarts },
            "max restarts exceeded — aborting supervisor"
          );
          throw new Error(`Supervisor: max restarts (${this.maxRestarts}) exceeded`);
        }

        const delay = Math.min(
          this.restartDelayMs * Math.pow(2, this.restartCount - 1),
          this.maxRestartDelayMs
        );

        this._state = "restarting";
        this.lifecycle?.transition('restarting');
        this.log.warn(
          {
            err,
            restartCount: this.restartCount,
            maxRestarts: this.maxRestarts,
            delayMs: delay,
          },
          "recoverable listener error — restarting after delay"
        );

        await this.sleep(delay);

        if (!this._stopped) {
          this._state = "running";
          this.lifecycle?.transition('running');
        }
      }
    }

    // Fell through the while loop because _stopped became true.
    this._state = "stopped";
    this.lifecycle?.transition('stopped');
  }

  /**
   * Signal the supervisor to stop.
   *
   * - Sets `_stopped = true` so the restart loop exits after the current
   *   iteration completes.
   * - Cancels any in-progress restart-delay sleep immediately.
   * - Safe to call multiple times (idempotent).
   */
  stop(): void {
    if (this._stopped) return;
    this._stopped = true;
    this._state = "stopping";
    this.lifecycle?.transition('stopping');
    // Abort the current restart sleep so shutdown is not delayed.
    this.sleepReject?.(new Error("Supervisor: stop() called during restart sleep"));
    this.sleepReject = undefined;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Tear down a listener whose `start()` resolved after `stop()` was called.
   * The late subscription is stopped (best-effort) and the supervisor parks
   * in the terminal `stopped` state — it is never marked `running` once
   * shutdown has begun.
   */
  private async absorbLateStartup(listeners: ListenerSet): Promise<void> {
    this._state = "stopping";
    this.lifecycle?.transition('stopping');
    try {
      await listeners.stop();
    } catch (err) {
      this.log.warn({ err }, "error stopping late listener after shutdown — ignoring");
    }
    this._state = "stopped";
    this.lifecycle?.transition('stopped');
  }

  /**
   * Sleep for `ms` milliseconds.  The sleep is interruptible: calling
   * `stop()` resolves the sleep immediately (without throwing) so the
   * restart loop can exit cleanly.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.sleepReject = (_err: Error) => {
        clearTimeout(timer);
        // Resolve rather than reject: stop() aborting a sleep is not an
        // error — it just means the supervisor is shutting down.
        resolve();
      };
    });
  }

  /**
   * Stop every listener, attempting all cleanups even when one throws.
   *
   * Each listener's stop() is awaited in order; failures are logged and
   * collected. When a lifecycle manager is present it transitions to
   * `failed` on any cleanup error, otherwise to `stopped`. The first
   * error is rethrown (awaited by the caller, so no unhandled rejection)
   * after all listeners have been given a chance to stop.
   */
  async stopAll(listeners: ListenerSet[]): Promise<void> {
    const errors: unknown[] = [];
    for (const listener of listeners) {
      try {
        await listener.stop();
      } catch (err) {
        errors.push(err);
        this.log.error({ err }, "listener stop failed — continuing cleanup");
      }
    }
    if (errors.length > 0) {
      try {
        this.lifecycle?.transition("failed");
      } catch {
        // Lifecycle may already be terminal; state is still reported via error.
      }
      this._state = "failed";
      throw errors[0];
    }
    this._state = "stopped";
    try {
      this.lifecycle?.transition("stopped");
    } catch {
      // Already stopped — safe to ignore.
    }
  }
}

// ── FatalError ────────────────────────────────────────────────────────────────

/**
 * Throw a FatalError to signal that the supervisor should not attempt
 * a restart.  Use this for configuration errors, unrecoverable state, etc.
 */
export class FatalError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "FatalError";
  }
}
