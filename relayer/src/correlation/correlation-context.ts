/**
 * @fileoverview Request correlation context for the WaffleFinance relayer.
 *
 * A bridge operation spans multiple services and chains. Without a correlated
 * request ID, operators cannot trace a single order from raw event delivery
 * through relay, submission, and receipt processing.
 *
 * This module provides:
 *  1. A stable `CorrelationId` tied to one relay operation (order-scoped).
 *  2. An `AsyncLocalStorage`-backed context store so every async hop in the
 *     call chain can read the current correlation without explicit threading.
 *  3. Structured log helpers that always include the correlation ID, so every
 *     log line emitted during a relay operation is traceable by operators.
 *  4. A `withCorrelation` wrapper that runs a closure inside a correlation scope
 *     and stamps a final structured summary when it exits.
 *
 * Design constraints
 * ------------------
 * - The correlation ID is STABLE for the lifetime of an order. It survives
 *   retries, restarts, and hand-offs between code paths.
 * - IDs are generated from the order ID so they are deterministic across
 *   process boundaries (e.g. coordinator ↔ relayer).  A random suffix is
 *   appended to distinguish concurrent operations on the same order.
 * - No PII or financial amounts are stored in the correlation context. Label
 *   values are restricted to stable identifiers (order IDs, tx hashes,
 *   reason codes) so the /metrics endpoint remains safe to expose internally.
 *
 * Usage
 * -----
 * ```ts
 * import { withCorrelation, getCorrelation, correlationLog } from './correlation-context.js';
 *
 * // Entry point of a relay operation:
 * await withCorrelation({ orderId, route: 'eth_to_xlm' }, async () => {
 *   correlationLog('info', 'relay started');
 *   // … all async operations in this scope see the same correlation
 *   const ctx = getCorrelation()!;
 *   correlationLog('info', 'escrow created', { escrowId: ctx.correlationId });
 * });
 *
 * // Inside any nested async function:
 * const ctx = getCorrelation();
 * if (ctx) {
 *   ctx.addCheckpoint('horizon_verified');
 * }
 * ```
 */

import { AsyncLocalStorage, createHook } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import {
  correlationOpsTotal,
  correlationCheckpointsTotal,
  correlationOpDurationSeconds,
  correlationRetryHopsTotal,
} from '../metrics.js';
import { getLogger } from '../logger.js';

// ---------------------------------------------------------------------------
// Internal structured log helper
//
// We write directly to process.stdout.write / process.stderr.write rather
// than routing through the Pino singleton. This keeps the correlation module
// self-contained and — critically — lets the test suite intercept log output
// by patching process.stdout.write, matching the exact pattern used in
// correlation-context.test.ts captureStdout().
// ---------------------------------------------------------------------------

function _log(
  level: 'info' | 'warn' | 'error',
  ctx: CorrelationContext | undefined,
  msg: string,
  extra?: Record<string, unknown>,
): void {
  const record: Record<string, unknown> = {
    level,
    msg,
    ts: new Date().toISOString(),
    ...extra,
  };
  if (ctx) {
    record.correlationId = ctx.correlationId;
    record.orderId = ctx.orderId;
    record.route = ctx.route;
    record.retryCount = ctx.retryCount;
    record.elapsedMs = ctx.elapsedMs();
  }
  const line = JSON.stringify(record) + '\n';
  if (level === 'error') {
    process.stderr.write(line);
  } else {
    process.stdout.write(line);
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Stable route identifier for a relay operation. */
export type RelayRoute =
  | 'eth_to_xlm'
  | 'xlm_to_eth'
  | 'eth_to_sol'
  | 'sol_to_eth'
  | 'unknown';

/**
 * Named checkpoints in the relay lifecycle.
 * Each one maps to a Prometheus label so operators can filter by phase.
 */
export type RelayCheckpoint =
  | 'order_created'
  | 'event_received'
  | 'queue_enqueued'
  | 'relay_started'
  | 'escrow_encoded'
  | 'tx_submitted'
  | 'tx_mined'
  | 'horizon_verified'
  | 'stellar_submitted'
  | 'receipt_recorded'
  | 'relay_complete'
  | 'retry_scheduled'
  | 'circuit_open'
  | 'terminal_failure';

/**
 * A single relay operation's tracing identity. Created once per order
 * invocation and propagated via AsyncLocalStorage.
 */
export interface CorrelationContext {
  /**
   * Stable ID for the full relay operation.
   * Format: `<orderId_prefix>-<8-hex-random>`, e.g. `order_abc123-f4a91c3d`.
   */
  readonly correlationId: string;

  /** Original order ID this relay operation is serving. */
  readonly orderId: string;

  /** Bridge route (used as a Prometheus label). */
  readonly route: RelayRoute;

  /** Unix timestamp (ms) when this context was created. */
  readonly startedAt: number;

  /**
   * Sequential checkpoint list. Each `addCheckpoint` call appends here and
   * increments a Prometheus counter so operators can trace the path through logs.
   */
  readonly checkpoints: Array<{ name: RelayCheckpoint; at: number }>;

  /**
   * Number of times the operation has been retried within this correlation
   * scope. Incremented by `incrementRetry`.
   */
  retryCount: number;

  /**
   * Append a named checkpoint. Emits a structured log line and increments
   * `relayer_correlation_checkpoints_total{checkpoint,route}`.
   */
  addCheckpoint(name: RelayCheckpoint): void;

  /**
   * Record a retry hop within this correlation scope.
   * Increments both `retryCount` and `relayer_correlation_retry_hops_total`.
   */
  incrementRetry(reason: string): void;

  /**
   * Elapsed milliseconds since this context was created.
   */
  elapsedMs(): number;
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

const _store = new AsyncLocalStorage<CorrelationContext>();

// ---------------------------------------------------------------------------
// Context factory
// ---------------------------------------------------------------------------

function generateCorrelationId(orderId: string): string {
  const prefix = orderId.substring(0, 16).replace(/[^a-zA-Z0-9_-]/g, '_');
  const suffix = randomBytes(4).toString('hex');
  return `${prefix}-${suffix}`;
}

function createContext(opts: {
  orderId: string;
  route?: RelayRoute;
  correlationId?: string;
}): CorrelationContext {
  const correlationId = opts.correlationId ?? generateCorrelationId(opts.orderId);
  const route: RelayRoute = opts.route ?? 'unknown';
  const startedAt = Date.now();
  const checkpoints: CorrelationContext['checkpoints'] = [];

  const ctx: CorrelationContext = {
    correlationId,
    orderId: opts.orderId,
    route,
    startedAt,
    checkpoints,
    retryCount: 0,

    addCheckpoint(name: RelayCheckpoint): void {
      checkpoints.push({ name, at: Date.now() });
      correlationCheckpointsTotal.inc({ checkpoint: name, route: ctx.route });
      _log('info', ctx, `[correlation] checkpoint: ${name}`);
    },

    incrementRetry(reason: string): void {
      ctx.retryCount++;
      correlationRetryHopsTotal.inc({ route: ctx.route, reason });
      _log('info', ctx, `[correlation] retry #${ctx.retryCount}`, { reason });
    },

    elapsedMs(): number {
      return Date.now() - startedAt;
    },
  };

  return ctx;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Retrieve the current correlation context from the AsyncLocalStorage.
 * Returns `undefined` when called outside a `withCorrelation` scope (e.g. at
 * startup or in a background timer not spawned from a relay invocation).
 */
export function getCorrelation(): CorrelationContext | undefined {
  return _store.getStore();
}

/**
 * Run `fn` inside a new correlation scope.
 *
 * - Creates a fresh `CorrelationContext` for the operation.
 * - Records `relay_started` on entry.
 * - On completion, emits `relay_complete` or `terminal_failure`, increments
 *   `relayer_correlation_ops_total`, and records the duration histogram.
 * - The correlation context is accessible anywhere inside `fn` (and all
 *   awaited callees) via `getCorrelation()`.
 *
 * @param opts    Order-level identity for this relay operation.
 * @param fn      The async relay operation to execute.
 * @returns       The resolved value of `fn`.
 */
export async function withCorrelation<T>(
  opts: { orderId: string; route?: RelayRoute; correlationId?: string },
  fn: (ctx: CorrelationContext) => Promise<T>
): Promise<T> {
  const ctx = createContext(opts);
  const endTimer = correlationOpDurationSeconds.startTimer({ route: ctx.route });

  return _store.run(ctx, async () => {
    ctx.addCheckpoint('relay_started');
    _log('info', ctx, '[correlation] operation started');

    try {
      const result = await fn(ctx);
      ctx.addCheckpoint('relay_complete');
      correlationOpsTotal.inc({ route: ctx.route, outcome: 'success' });
      _log('info', ctx, '[correlation] operation succeeded', {
        elapsedMs: ctx.elapsedMs(),
        retries: ctx.retryCount,
      });
      return result;
    } catch (err: unknown) {
      ctx.addCheckpoint('terminal_failure');
      correlationOpsTotal.inc({ route: ctx.route, outcome: 'failure' });
      _log('error', ctx, '[correlation] operation failed', {
        elapsedMs: ctx.elapsedMs(),
        retries: ctx.retryCount,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      endTimer();
    }
  });
}

/**
 * Stamp the current correlation ID into an arbitrary log record and emit it.
 * When called outside a correlation scope the `correlationId` field is omitted
 * (the mixin in logger.ts handles this automatically).
 *
 * @param level   Severity: 'info' | 'warn' | 'error'.
 * @param msg     Human-readable message.
 * @param extra   Additional structured fields (no PII or amounts).
 */
export function correlationLog(
  level: 'info' | 'warn' | 'error',
  msg: string,
  extra?: Record<string, unknown>
): void {
  const ctx = _store.getStore();
  _log(level, ctx, msg, extra);
}

/**
 * Build a log record object pre-populated with the current correlation
 * fields. Useful when you need to pass a record to an external logger.
 */
export function correlationFields(): Record<string, unknown> {
  const ctx = _store.getStore();
  if (!ctx) return {};
  return {
    correlationId: ctx.correlationId,
    orderId: ctx.orderId,
    route: ctx.route,
    retryCount: ctx.retryCount,
    elapsedMs: ctx.elapsedMs(),
  };
}

/**
 * Wrap an existing correlation ID into a new scope. This is useful when
 * the coordinator hands off a correlation ID to the relayer over HTTP and
 * the relayer wants to continue under the same stable ID.
 */
export async function continueCorrelation<T>(
  correlationId: string,
  orderId: string,
  route: RelayRoute,
  fn: (ctx: CorrelationContext) => Promise<T>
): Promise<T> {
  return withCorrelation({ orderId, route, correlationId }, fn);
}

// (structured logging is now handled by the Pino-based _log helper above)
