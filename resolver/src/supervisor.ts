import type { Logger } from "pino";

export interface SupervisorOptions {
  log: Logger;
  /** Maximum number of listener restarts before the supervisor gives up. */
  maxRestarts?: number;
  /** Base delay in ms before the first restart attempt. Doubles on each retry. */
  restartDelayMs?: number;
}

export interface ListenerSet {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Supervises a set of listeners, restarting them on recoverable errors and
 * giving up after exceeding the configured restart ceiling.
 *
 * The supervisor is shut-down-safe: calling stop() causes any in-progress
 * restart loop to exit cleanly without restarting listeners again.
 *
 * Shutdown is idempotent — repeated calls to stop() are safe.
 */
export class Supervisor {
  private stopped = false;
  private restartCount = 0;

  private readonly log: Logger;
  private readonly maxRestarts: number;
  private readonly restartDelayMs: number;

  constructor(opts: SupervisorOptions) {
    this.log = opts.log.child({ component: "Supervisor" });
    this.maxRestarts = opts.maxRestarts ?? 5;
    this.restartDelayMs = opts.restartDelayMs ?? 5_000;
  }

  /**
   * Determine whether an error is recoverable (i.e., worth restarting over).
   * Fatal errors — those explicitly flagged or caused by bad configuration —
   * should propagate immediately without retrying.
   */
  isRecoverable(err: unknown): boolean {
    if (err instanceof FatalError) return false;
    return true;
  }

  /**
   * Run the given listener set, restarting it on recoverable errors until
   * maxRestarts is exceeded.  Resolves when the listener exits cleanly or
   * rejects on a fatal or unrecoverable error.
   */
  async run(listeners: ListenerSet): Promise<void> {
    while (!this.stopped) {
      try {
        await listeners.start();
        return; // clean exit — no restart needed
      } catch (err) {
        if (this.stopped) return;

        if (!this.isRecoverable(err)) {
          this.log.error({ err }, "fatal listener error — aborting supervisor");
          throw err;
        }

        this.restartCount++;
        if (this.restartCount > this.maxRestarts) {
          this.log.error(
            { restartCount: this.restartCount, maxRestarts: this.maxRestarts },
            "max restarts exceeded — aborting supervisor"
          );
          throw new Error(
            `Supervisor: max restarts (${this.maxRestarts}) exceeded`
          );
        }

        const delay = this.restartDelayMs * Math.pow(2, this.restartCount - 1);
        this.log.warn(
          { err, restartCount: this.restartCount, delayMs: delay },
          "recoverable listener error — restarting"
        );

        await this.sleep(delay);
      }
    }
  }

  /** Signal the supervisor to stop restarting listeners. */
  stop(): void {
    this.stopped = true;
  }

  /** Whether stop() has been called. */
  get isStopped(): boolean {
    return this.stopped;
  }

  get restarts(): number {
    return this.restartCount;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

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
