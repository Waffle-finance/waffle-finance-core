import type { Logger } from "pino";

// ── Types ─────────────────────────────────────────────────────────────────────

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
}

export interface ListenerSet {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Lifecycle state exposed via `Supervisor.state`.
 *
 * - `idle`         — not yet started.
 * - `running`      — listeners are active.
 * - `restarting`   — a recoverable error occurred; supervisor is waiting before retrying.
 * - `stopping`     — stop() was called; teardown is in progress.
 * - `stopped`      — cleanly stopped (via stop() or clean exit).
 * - `failed`       — exhausted restarts or hit a fatal error; will not recover.
 */
export type SupervisorState = "idle" | "running" | "restarting" | "stopping" | "stopped" | "failed";

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

  /** Resolves the current sleep between restart attempts, if active. */
  private sleepReject?: (err: Error) => void;

  constructor(opts: SupervisorOptions) {
    this.log = opts.log.child({ component: "Supervisor" });
    this.maxRestarts = opts.maxRestarts ?? 5;
    this.restartDelayMs = opts.restartDelayMs ?? 5_000;
    this.maxRestartDelayMs = opts.maxRestartDelayMs ?? 60_000;
  }

  // ── Public accessors ───────────────────────────────────────────────────────

  /**
   * Current lifecycle state.  Exposed so health endpoints can surface it
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
    this._state = "running";

    while (!this._stopped) {
      try {
        await listeners.start();
        // Clean exit — listeners finished without error.
        this._state = "stopped";
        return;
      } catch (err) {
        if (this._stopped) {
          // stop() was called while listeners were running — absorb the error.
          this._state = "stopped";
          return;
        }

        if (!this.isRecoverable(err)) {
          this._state = "failed";
          this.log.error({ err }, "fatal listener error — aborting supervisor");
          throw err;
        }

        this.restartCount++;

        if (this.restartCount > this.maxRestarts) {
          this._state = "failed";
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
        }
      }
    }

    // Fell through the while loop because _stopped became true.
    this._state = "stopped";
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
    // Abort the current restart sleep so shutdown is not delayed.
    this.sleepReject?.(new Error("Supervisor: stop() called during restart sleep"));
    this.sleepReject = undefined;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

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
