/**
 * @file errors.ts
 *
 * Structured error taxonomy for the WaffleFinance coordinator.
 *
 * ## Motivation (#1113)
 *
 * Free-form error messages are difficult to aggregate in metrics and logs,
 * and may accidentally include sensitive data (order IDs, preimages, secrets).
 * Stable error codes enable:
 *
 *  - **Aggregation** — group errors by category in dashboards and alerts
 *  - **Safety** — sanitize sensitive fields before logging or emitting metrics
 *  - **Diagnosis** — preserve the original cause for internal diagnostics
 *    while presenting a stable external error code to operators
 *
 * ## Usage
 *
 * ```ts
 * import { CoordinatorError, ErrorCode } from './errors.js';
 *
 * // Throw a typed error
 * throw new CoordinatorError(
 *   ErrorCode.RPC_TIMEOUT,
 *   'Ethereum RPC did not respond within 10s',
 *   { chain: 'ethereum', endpoint: rpcUrl }
 * );
 *
 * // Wrap an external error
 * try {
 *   await ethClient.getBlock(blockNum);
 * } catch (err) {
 *   throw CoordinatorError.wrap(
 *     ErrorCode.RPC_ERROR,
 *     'Failed to fetch Ethereum block',
 *     err,
 *     { chain: 'ethereum', blockNum }
 *   );
 * }
 *
 * // Check error code in a handler
 * if (err instanceof CoordinatorError && err.code === ErrorCode.ORDER_NOT_FOUND) {
 *   // expected case — order was already archived or never announced
 *   return;
 * }
 * ```
 *
 * ## Error Code Categories
 *
 * - **1xxx** — Persistence errors (database, transactions, cursors)
 * - **2xxx** — RPC errors (chain connectivity, timeouts, invalid responses)
 * - **3xxx** — Validation errors (invalid input, state machine violations)
 * - **4xxx** — Workflow errors (order processing, reconciliation, secrets)
 * - **5xxx** — External service errors (rate limits, auth failures)
 * - **9xxx** — Internal errors (unexpected states, assertion failures)
 */

/**
 * Stable error codes for coordinator operations.
 *
 * Each code is a unique identifier for an error category that can be safely
 * logged, emitted in metrics, and used in alert rules without exposing
 * sensitive data.
 */
export enum ErrorCode {
  // ── 1xxx: Persistence ───────────────────────────────────────────────────────

  /** Database connection failed or was lost */
  DB_CONNECTION_FAILED = 'DB_CONNECTION_FAILED',

  /** Database query timed out */
  DB_QUERY_TIMEOUT = 'DB_QUERY_TIMEOUT',

  /** Transaction deadlock detected */
  DB_DEADLOCK = 'DB_DEADLOCK',

  /** Transaction retry limit exceeded */
  DB_RETRY_LIMIT = 'DB_RETRY_LIMIT',

  /** Constraint violation (unique, foreign key, check) */
  DB_CONSTRAINT_VIOLATION = 'DB_CONSTRAINT_VIOLATION',

  /** Database error not covered by specific codes */
  DB_ERROR = 'DB_ERROR',

  /** Order cursor update failed */
  CURSOR_UPDATE_FAILED = 'CURSOR_UPDATE_FAILED',

  // ── 2xxx: RPC ───────────────────────────────────────────────────────────────

  /** RPC endpoint did not respond within timeout */
  RPC_TIMEOUT = 'RPC_TIMEOUT',

  /** RPC endpoint returned a network error (ECONNREFUSED, ENOTFOUND, etc.) */
  RPC_NETWORK_ERROR = 'RPC_NETWORK_ERROR',

  /** RPC endpoint returned an invalid or malformed response */
  RPC_INVALID_RESPONSE = 'RPC_INVALID_RESPONSE',

  /** RPC endpoint returned an error response (e.g. invalid params) */
  RPC_ERROR = 'RPC_ERROR',

  /** RPC rate limit exceeded */
  RPC_RATE_LIMIT = 'RPC_RATE_LIMIT',

  /** RPC authentication failed */
  RPC_AUTH_FAILED = 'RPC_AUTH_FAILED',

  /** Ethereum-specific RPC error */
  ETH_RPC_ERROR = 'ETH_RPC_ERROR',

  /** Soroban-specific RPC error */
  SOROBAN_RPC_ERROR = 'SOROBAN_RPC_ERROR',

  /** Solana-specific RPC error */
  SOLANA_RPC_ERROR = 'SOLANA_RPC_ERROR',

  // ── 3xxx: Validation ────────────────────────────────────────────────────────

  /** Required field is missing */
  VALIDATION_MISSING_FIELD = 'VALIDATION_MISSING_FIELD',

  /** Field value is invalid or malformed */
  VALIDATION_INVALID_VALUE = 'VALIDATION_INVALID_VALUE',

  /** State transition is not allowed by the order state machine */
  VALIDATION_INVALID_TRANSITION = 'VALIDATION_INVALID_TRANSITION',

  /** Order is already in a terminal state and cannot be mutated */
  VALIDATION_ORDER_TERMINAL = 'VALIDATION_ORDER_TERMINAL',

  /** Preimage does not hash to the order's hashlock */
  VALIDATION_PREIMAGE_MISMATCH = 'VALIDATION_PREIMAGE_MISMATCH',

  /** Timelock has expired */
  VALIDATION_TIMELOCK_EXPIRED = 'VALIDATION_TIMELOCK_EXPIRED',

  /** Request body or parameters are malformed */
  VALIDATION_MALFORMED_INPUT = 'VALIDATION_MALFORMED_INPUT',

  // ── 4xxx: Workflow ──────────────────────────────────────────────────────────

  /** Order not found in database */
  ORDER_NOT_FOUND = 'ORDER_NOT_FOUND',

  /** Order already exists (duplicate announcement) */
  ORDER_ALREADY_EXISTS = 'ORDER_ALREADY_EXISTS',

  /** Cannot record src lock — order is in an invalid state */
  SRC_LOCK_INVALID_STATE = 'SRC_LOCK_INVALID_STATE',

  /** Cannot record secret — order does not have a src lock */
  SECRET_MISSING_SRC_LOCK = 'SECRET_MISSING_SRC_LOCK',

  /** Secret was already recorded for this order */
  SECRET_ALREADY_RECORDED = 'SECRET_ALREADY_RECORDED',

  /** Reconciliation run failed */
  RECONCILIATION_FAILED = 'RECONCILIATION_FAILED',

  /** Reconciliation detected a chain/DB state conflict */
  RECONCILIATION_CONFLICT = 'RECONCILIATION_CONFLICT',

  /** Event replay was skipped (already applied, stale sequence, etc.) */
  EVENT_REPLAY_SKIPPED = 'EVENT_REPLAY_SKIPPED',

  /** Event could not be decoded (malformed XDR, unknown topic, etc.) */
  EVENT_DECODE_FAILED = 'EVENT_DECODE_FAILED',

  /** Listener cursor is stale (RPC no longer recognizes it) */
  LISTENER_CURSOR_STALE = 'LISTENER_CURSOR_STALE',

  /** Listener detected a ledger gap larger than the replay window */
  LISTENER_GAP_TOO_LARGE = 'LISTENER_GAP_TOO_LARGE',

  // ── 5xxx: External Services ─────────────────────────────────────────────────

  /** Rate limit exceeded on an external API */
  EXTERNAL_RATE_LIMIT = 'EXTERNAL_RATE_LIMIT',

  /** External service returned an authentication error */
  EXTERNAL_AUTH_FAILED = 'EXTERNAL_AUTH_FAILED',

  /** External service is unavailable or unreachable */
  EXTERNAL_SERVICE_UNAVAILABLE = 'EXTERNAL_SERVICE_UNAVAILABLE',

  /** External service returned an unexpected error */
  EXTERNAL_SERVICE_ERROR = 'EXTERNAL_SERVICE_ERROR',

  // ── 9xxx: Internal ──────────────────────────────────────────────────────────

  /** Unexpected state or assertion failure — indicates a code bug */
  INTERNAL_ERROR = 'INTERNAL_ERROR',

  /** Feature is not yet implemented */
  NOT_IMPLEMENTED = 'NOT_IMPLEMENTED',

  /** Unknown error (fallback for unclassified errors) */
  UNKNOWN = 'UNKNOWN',
}

/**
 * Coordinator error with a stable error code and optional safe context.
 *
 * The `context` field should contain only non-sensitive data suitable for
 * logging and metrics (e.g. chain name, operation name, counts). Never
 * include order IDs, preimages, secrets, or user data in `context`.
 */
export class CoordinatorError extends Error {
  public readonly code: ErrorCode;
  public readonly context: Record<string, unknown>;
  public readonly cause?: Error;

  constructor(
    code: ErrorCode,
    message: string,
    context: Record<string, unknown> = {},
    cause?: Error
  ) {
    super(message);
    this.name = 'CoordinatorError';
    this.code = code;
    this.context = sanitizeContext(context);
    this.cause = cause;

    // Preserve stack trace
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, CoordinatorError);
    }
  }

  /**
   * Wrap an external error with a stable error code.
   *
   * Preserves the original error as `cause` for internal diagnostics while
   * exposing a stable `code` for metrics and alerts.
   */
  static wrap(
    code: ErrorCode,
    message: string,
    cause: unknown,
    context: Record<string, unknown> = {}
  ): CoordinatorError {
    const err = cause instanceof Error ? cause : new Error(String(cause));
    return new CoordinatorError(code, message, context, err);
  }

  /**
   * Convert this error to a JSON-serializable object for logging.
   *
   * The returned object is safe to log — sensitive fields are excluded.
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      context: this.context,
      stack: this.stack,
      cause: this.cause
        ? {
            name: this.cause.name,
            message: this.cause.message,
            stack: this.cause.stack,
          }
        : undefined,
    };
  }
}

/**
 * Sanitize a context object to remove sensitive fields.
 *
 * Sensitive keys are replaced with `[REDACTED]`. This prevents accidental
 * logging of secrets, preimages, or private keys.
 */
function sanitizeContext(context: Record<string, unknown>): Record<string, unknown> {
  const sensitiveKeys = new Set([
    'secret',
    'preimage',
    'password',
    'token',
    'apiKey',
    'privateKey',
    'mnemonic',
    'seed',
  ]);

  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    if (sensitiveKeys.has(key) || key.toLowerCase().includes('secret')) {
      sanitized[key] = '[REDACTED]';
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

/**
 * Classify an unknown error into a stable error code.
 *
 * Used when catching external errors (RPC failures, database exceptions, etc.)
 * to map them to our taxonomy without wrapping in `CoordinatorError`.
 */
export function classifyError(err: unknown): ErrorCode {
  if (err instanceof CoordinatorError) {
    return err.code;
  }

  if (!(err instanceof Error)) {
    return ErrorCode.UNKNOWN;
  }

  const message = err.message.toLowerCase();
  const name = err.name.toLowerCase();

  // Database errors
  if (
    name.includes('database') ||
    name.includes('sqlite') ||
    name.includes('postgres') ||
    message.includes('econnrefused') ||
    message.includes('connection') && message.includes('database')
  ) {
    if (message.includes('timeout')) return ErrorCode.DB_QUERY_TIMEOUT;
    if (message.includes('deadlock')) return ErrorCode.DB_DEADLOCK;
    if (message.includes('constraint') || message.includes('unique')) {
      return ErrorCode.DB_CONSTRAINT_VIOLATION;
    }
    return ErrorCode.DB_ERROR;
  }

  // RPC errors
  if (
    message.includes('rpc') ||
    message.includes('fetch') ||
    message.includes('http')
  ) {
    if (message.includes('timeout')) return ErrorCode.RPC_TIMEOUT;
    if (
      message.includes('econnrefused') ||
      message.includes('enotfound') ||
      message.includes('network')
    ) {
      return ErrorCode.RPC_NETWORK_ERROR;
    }
    if (message.includes('rate limit') || message.includes('429')) {
      return ErrorCode.RPC_RATE_LIMIT;
    }
    if (message.includes('auth') || message.includes('401') || message.includes('403')) {
      return ErrorCode.RPC_AUTH_FAILED;
    }
    return ErrorCode.RPC_ERROR;
  }

  // Validation errors
  if (
    message.includes('invalid') ||
    message.includes('malformed') ||
    message.includes('required')
  ) {
    return ErrorCode.VALIDATION_INVALID_VALUE;
  }

  // Fallback
  return ErrorCode.UNKNOWN;
}

/**
 * Error metrics for observability.
 *
 * Errors are counted by code (stable taxonomy) and component (which part of
 * the coordinator emitted the error).
 */
import { Counter } from 'prom-client';
import { registry } from './metrics.js';

export const coordinatorErrors = new Counter({
  name: 'coordinator_errors_total',
  help: 'Total coordinator errors by stable error code and component',
  labelNames: ['code', 'component'] as const,
  registers: [registry],
});

/**
 * Record an error in metrics.
 *
 * Call this in catch blocks after classifying the error:
 *
 * ```ts
 * catch (err) {
 *   const code = classifyError(err);
 *   recordError(code, 'reconciler');
 *   throw err;
 * }
 * ```
 */
export function recordError(code: ErrorCode, component: string): void {
  coordinatorErrors.inc({ code, component });
}
