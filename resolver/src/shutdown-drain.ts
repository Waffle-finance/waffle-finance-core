/**
 * Graceful shutdown draining for in-flight resolver work (issue #1094).
 *
 * A process signal can arrive between a transaction being submitted and its
 * confirmation.  Killing the process at that point leaves the order in an
 * unknown state: the transaction may land, or it may be dropped.  This module
 * gives shutdown a draining phase:
 *
 *   1. **Stop intake.**  The coordinator stops admitting new operations the
 *      moment draining begins — `run()` rejects with `DrainingError` — and the
 *      orchestrator stops listeners before anything else, so no new events
 *      produce new work.
 *   2. **Bounded completion.**  Operations already in flight get up to
 *      `drainTimeoutMs` to finish (confirm, fail, or bail out).
 *   3. **Report the leftovers.**  Any operation that submitted a transaction
 *      but never observed its outcome is reported as *ambiguous* — logged and
 *      handed to an `AmbiguousTxSink` so it can be reconciled after restart.
 *      Operations that had not submitted anything are reported as *abandoned*
 *      (safe to retry from scratch).
 *   4. **Close clients.**  Only after the drain settles are HTTP servers and
 *      RPC clients closed, so in-flight work never loses its transport.
 *
 * Repeated signals are idempotent: every call to `shutdown()` / `drain()`
 * returns the same promise and never restarts the sequence.
 */
import { appendFile } from "node:fs/promises";
import type { Logger } from "pino";
import { activeOperations } from "./metrics.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface OperationMeta {
  /** Chain label, e.g. "ethereum" or "stellar". */
  chain: string;
  /** Operation kind, e.g. "claim", "refund", "order_created". */
  action: string;
  /** Order identifier, if the operation is tied to an order. */
  orderId?: string;
}

/**
 * Handle passed to every tracked operation.  Call `recordTx()` as soon as a
 * transaction has been broadcast so that, if shutdown interrupts the wait for
 * confirmation, the identifier is reported for reconciliation.
 */
export interface OperationHandle {
  readonly id: number;
  /** Aborted when the drain deadline expires; long waits should honour it. */
  readonly signal: AbortSignal;
  recordTx(txHash: string): void;
}

export interface InFlightOperation extends OperationMeta {
  id: number;
  startedAt: number;
  /** Transaction hashes broadcast by this operation (in submission order). */
  txHashes: string[];
}

/** A broadcast transaction whose outcome was never observed. */
export interface AmbiguousTransaction extends OperationMeta {
  operationId: number;
  txHash: string;
  startedAt: number;
  reportedAt: number;
  reason: "drain_deadline_exceeded" | "failed_after_submission";
  error?: string;
}

export interface DrainReport {
  /** Operations that were in flight when draining began. */
  inFlightAtStart: number;
  /** Operations that settled successfully during the drain window. */
  completed: number;
  /** Operations that rejected during the drain window. */
  failed: number;
  /** Submitted-but-unconfirmed transactions needing reconciliation. */
  ambiguous: AmbiguousTransaction[];
  /** Operations still running at the deadline that never submitted a tx. */
  abandoned: InFlightOperation[];
  /** True when the deadline expired before every operation settled. */
  timedOut: boolean;
  durationMs: number;
}

/** Destination for ambiguous transactions (log, file, DB, …). */
export interface AmbiguousTxSink {
  record(entries: AmbiguousTransaction[]): Promise<void>;
}

export interface DrainCoordinatorOptions {
  log: Logger;
  /** Maximum time to wait for in-flight work once draining starts. */
  drainTimeoutMs: number;
  /** Where ambiguous transactions are persisted. Logging always happens. */
  sink?: AmbiguousTxSink;
  /** Injectable clock for tests. */
  now?: () => number;
}

export class DrainingError extends Error {
  constructor(meta: OperationMeta) {
    super(
      `resolver is draining for shutdown — refusing new ${meta.chain}/${meta.action} operation`
    );
    this.name = "DrainingError";
  }
}

export const DEFAULT_DRAIN_TIMEOUT_MS = 10_000;

// ── DrainCoordinator ──────────────────────────────────────────────────────────

interface TrackedOperation extends InFlightOperation {
  controller: AbortController;
  done: Promise<void>;
}

export class DrainCoordinator {
  private readonly log: Logger;
  private readonly drainTimeoutMs: number;
  private readonly sink?: AmbiguousTxSink;
  private readonly now: () => number;

  private nextId = 1;
  private draining = false;
  private drainPromise?: Promise<DrainReport>;
  private readonly inFlight = new Map<number, TrackedOperation>();

  /** Counters for the current drain window. */
  private completedDuringDrain = 0;
  private failedDuringDrain = 0;
  /** Ambiguous entries collected from operations that failed after submit. */
  private readonly failedAfterSubmit: AmbiguousTransaction[] = [];

  constructor(opts: DrainCoordinatorOptions) {
    this.log = opts.log.child({ component: "DrainCoordinator" });
    this.drainTimeoutMs = Math.max(0, opts.drainTimeoutMs);
    this.sink = opts.sink;
    this.now = opts.now ?? Date.now;
  }

  /** False once draining has begun; new operations are rejected. */
  get accepting(): boolean {
    return !this.draining;
  }

  get inFlightCount(): number {
    return this.inFlight.size;
  }

  /** Snapshot of the operations currently in flight. */
  snapshot(): InFlightOperation[] {
    return [...this.inFlight.values()].map(toPublic);
  }

  /**
   * Run `fn` as a tracked operation.  Rejects with `DrainingError` without
   * calling `fn` once draining has started.
   */
  async run<T>(meta: OperationMeta, fn: (op: OperationHandle) => Promise<T> | T): Promise<T> {
    if (this.draining) {
      this.log.warn({ ...meta }, "operation rejected — resolver is draining");
      throw new DrainingError(meta);
    }

    const id = this.nextId++;
    const controller = new AbortController();
    let settle!: () => void;
    const op: TrackedOperation = {
      ...meta,
      id,
      startedAt: this.now(),
      txHashes: [],
      controller,
      done: new Promise<void>((r) => (settle = r)),
    };
    this.inFlight.set(id, op);
    activeOperations.inc({ operation: meta.action });

    const handle: OperationHandle = {
      id,
      signal: controller.signal,
      recordTx: (txHash: string) => {
        if (!op.txHashes.includes(txHash)) op.txHashes.push(txHash);
        this.log.debug({ ...meta, operationId: id, txHash }, "in-flight transaction recorded");
      },
    };

    try {
      const result = await fn(handle);
      if (this.draining) this.completedDuringDrain++;
      return result;
    } catch (err) {
      if (this.draining) this.failedDuringDrain++;
      // During a drain, a failure after broadcast (e.g. the confirmation wait
      // was cut short) does not tell us whether the tx landed.  Outside a
      // drain the caller's own error handling owns the retry decision, so we
      // do not accumulate entries (which would grow without bound).
      if (this.draining && op.txHashes.length > 0) {
        const reportedAt = this.now();
        for (const txHash of op.txHashes) {
          this.failedAfterSubmit.push({
            ...meta,
            operationId: id,
            txHash,
            startedAt: op.startedAt,
            reportedAt,
            reason: "failed_after_submission",
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      throw err;
    } finally {
      this.inFlight.delete(id);
      activeOperations.dec({ operation: meta.action });
      settle();
    }
  }

  /**
   * Stop accepting new work and wait (up to the deadline) for in-flight
   * operations to settle.  Idempotent — repeated calls share one drain.
   */
  drain(): Promise<DrainReport> {
    if (!this.drainPromise) {
      this.draining = true;
      this.drainPromise = this.performDrain();
    }
    return this.drainPromise;
  }

  private async performDrain(): Promise<DrainReport> {
    const startedAt = this.now();
    const pending = [...this.inFlight.values()];
    this.log.info(
      { inFlight: pending.length, drainTimeoutMs: this.drainTimeoutMs },
      "draining in-flight operations"
    );

    let timedOut = false;
    if (pending.length > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), this.drainTimeoutMs);
      });
      const allDone = Promise.all(pending.map((op) => op.done)).then(() => "done" as const);
      timedOut = (await Promise.race([allDone, deadline])) === "timeout";
      clearTimeout(timer);
    }

    const reportedAt = this.now();
    const ambiguous: AmbiguousTransaction[] = [...this.failedAfterSubmit];
    const abandoned: InFlightOperation[] = [];

    if (timedOut) {
      for (const op of this.inFlight.values()) {
        // Signal the stragglers so they can stop waiting on RPC responses.
        op.controller.abort(new Error("drain deadline exceeded"));
        if (op.txHashes.length === 0) {
          abandoned.push(toPublic(op));
          continue;
        }
        for (const txHash of op.txHashes) {
          ambiguous.push({
            chain: op.chain,
            action: op.action,
            orderId: op.orderId,
            operationId: op.id,
            txHash,
            startedAt: op.startedAt,
            reportedAt,
            reason: "drain_deadline_exceeded",
          });
        }
      }
    }

    const report: DrainReport = {
      inFlightAtStart: pending.length,
      completed: this.completedDuringDrain,
      failed: this.failedDuringDrain,
      ambiguous,
      abandoned,
      timedOut,
      durationMs: reportedAt - startedAt,
    };

    for (const entry of ambiguous) {
      this.log.warn(
        {
          chain: entry.chain,
          action: entry.action,
          orderId: entry.orderId,
          txHash: entry.txHash,
          reason: entry.reason,
        },
        "ambiguous transaction left unresolved at shutdown — reconcile on restart"
      );
    }
    for (const op of abandoned) {
      this.log.warn(
        { chain: op.chain, action: op.action, orderId: op.orderId },
        "operation abandoned at shutdown before submitting a transaction — safe to retry"
      );
    }

    if (ambiguous.length > 0 && this.sink) {
      try {
        await this.sink.record(ambiguous);
      } catch (err) {
        // The log lines above already carry every identifier.
        this.log.error({ err, count: ambiguous.length }, "failed to persist ambiguous transactions");
      }
    }

    this.log[timedOut ? "warn" : "info"](
      {
        inFlightAtStart: report.inFlightAtStart,
        completed: report.completed,
        failed: report.failed,
        ambiguous: ambiguous.length,
        abandoned: abandoned.length,
        timedOut,
        durationMs: report.durationMs,
      },
      timedOut ? "drain deadline exceeded" : "drain complete"
    );

    return report;
  }
}

function toPublic(op: TrackedOperation): InFlightOperation {
  return {
    id: op.id,
    chain: op.chain,
    action: op.action,
    orderId: op.orderId,
    startedAt: op.startedAt,
    txHashes: [...op.txHashes],
  };
}

// ── Sinks ─────────────────────────────────────────────────────────────────────

/**
 * Append ambiguous transactions as JSON lines to `path`.  The file is a
 * reconciliation journal: an operator (or a future startup pass) re-checks
 * each `txHash` on-chain before retrying the order.
 */
export function createFileAmbiguousTxSink(path: string): AmbiguousTxSink {
  return {
    async record(entries) {
      if (entries.length === 0) return;
      const body = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
      await appendFile(path, body, "utf8");
    },
  };
}

// ── Shutdown orchestration ────────────────────────────────────────────────────

export interface ShutdownSteps {
  /** Stop new event intake (supervisor + listeners). Runs first. */
  stopIntake(): Promise<void> | void;
  /** Close servers and RPC clients. Runs only after the drain settles. */
  closeClients(): Promise<void> | void;
}

export interface ShutdownResult {
  signal: string;
  report: DrainReport;
}

/**
 * Coordinates the shutdown order: stop intake → drain → close clients.
 * `shutdown()` is idempotent; repeated signals return the first promise.
 */
export class ShutdownOrchestrator {
  private readonly log: Logger;
  private promise?: Promise<ShutdownResult>;

  constructor(
    private readonly coordinator: DrainCoordinator,
    private readonly steps: ShutdownSteps,
    log: Logger
  ) {
    this.log = log.child({ component: "ShutdownOrchestrator" });
  }

  get inProgress(): boolean {
    return this.promise !== undefined;
  }

  shutdown(signal: string): Promise<ShutdownResult> {
    if (this.promise) {
      this.log.warn({ signal }, "shutdown already in progress — ignoring duplicate signal");
      return this.promise;
    }
    this.promise = this.perform(signal);
    return this.promise;
  }

  private async perform(signal: string): Promise<ShutdownResult> {
    this.log.info({ signal }, "shutdown requested — stopping intake");

    // Refuse new operations immediately, before awaiting anything, so work
    // triggered while listeners are being torn down is rejected too.
    const drained = this.coordinator.drain();

    try {
      await this.steps.stopIntake();
    } catch (err) {
      this.log.warn({ err }, "error stopping intake — continuing drain");
    }

    const report = await drained;

    try {
      await this.steps.closeClients();
    } catch (err) {
      this.log.warn({ err }, "error closing clients during shutdown");
    }

    return { signal, report };
  }
}

/**
 * Resolve the drain timeout from the environment, keeping it strictly below
 * the hard shutdown timeout so the report is always emitted before force-exit.
 */
export function resolveDrainTimeoutMs(
  raw: string | undefined,
  hardTimeoutMs: number
): number {
  const ceiling = Math.max(0, hardTimeoutMs - 2_000);
  const parsed = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  const value = Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_DRAIN_TIMEOUT_MS;
  return Math.min(value, ceiling);
}
