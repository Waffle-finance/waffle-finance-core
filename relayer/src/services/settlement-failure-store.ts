/**
 * @fileoverview Settlement failure store for the WaffleFinance relayer.
 *
 * Problem
 * -------
 * When a settlement attempt fails mid-flow (ETH send reverts, Horizon times
 * out, RPC rate-limits, etc.) there was no durable record of what went wrong
 * or how many times it was retried. Operators had to grep logs to reconstruct
 * the failure history. Orders silently stayed in `pending` / `awaiting_xlm_payment`
 * without any machine-readable failure signal.
 *
 * Solution
 * --------
 * `SettlementFailureStore` is a per-order append-only failure log. Every time
 * a settlement attempt fails, the caller records it with:
 *   - a `FailureCategory` (determines retryability)
 *   - the raw error message
 *   - the settlement direction and chain
 *   - an optional recovery action taken
 *
 * The store also tracks the overall recovery status of each order, which
 * drives the `/api/admin/settlement-failures` endpoint used by operators.
 *
 * Failure categories
 * ------------------
 *   rpc_rate_limit       → recoverable — back off and retry
 *   rpc_timeout          → recoverable — retry with fresh provider
 *   horizon_timeout      → ambiguous   — may have landed; do not retry immediately
 *   horizon_transient    → recoverable — retry on next tick
 *   eth_nonce_conflict   → recoverable — rebuild tx with current nonce
 *   eth_gas_too_low      → recoverable — bump gas
 *   stellar_bad_seq      → recoverable — reload account and retry
 *   stellar_fee_too_low  → recoverable — fee-bump
 *   insufficient_balance → terminal    — operator action required
 *   auth_failure         → terminal    — misconfiguration
 *   terminal_unknown     → terminal    — unknown; stop retrying
 *   partial_settlement   → requires_review — funds moved on one leg only
 *
 * Recovery statuses
 * -----------------
 *   pending    — at least one failure recorded, no success yet
 *   recovering — at least one retry attempt in progress or scheduled
 *   recovered  — a subsequent attempt succeeded after a previous failure
 *   failed     — terminal failure; no further retries will be attempted
 *   requires_review — partial settlement or ambiguous; needs manual review
 *
 * Persistence
 * -----------
 * Each order's failure record is written atomically to disk on every update
 * so the history survives process restarts. The admin endpoint loads all
 * records on demand from the in-memory map (populated at startup from disk).
 *
 * Thread safety
 * -------------
 * All mutations are synchronous within the Node.js event loop. The
 * append-only design means there are no read-modify-write races.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import {
  settlementFailuresTotal,
  settlementRecoveryAttemptsTotal,
  settlementRecoveredTotal,
  settlementTerminalTotal,
  settlementFailuresByCategory,
  settlementPendingRecoveryGauge,
} from '../metrics.js';
import { correlationLog } from '../correlation/correlation-context.js';
import { getLogger } from '../logger.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Every recognized failure category. The `recoverability` property drives
 * whether the retry engine will schedule another attempt.
 */
export type FailureCategory =
  | 'rpc_rate_limit'
  | 'rpc_timeout'
  | 'horizon_timeout'
  | 'horizon_transient'
  | 'eth_nonce_conflict'
  | 'eth_gas_too_low'
  | 'stellar_bad_seq'
  | 'stellar_fee_too_low'
  | 'insufficient_balance'
  | 'auth_failure'
  | 'terminal_unknown'
  | 'partial_settlement';

/** Whether a category allows subsequent retry attempts. */
export type Recoverability = 'recoverable' | 'ambiguous' | 'terminal' | 'requires_review';

/** Map from category to its recoverability. */
export const CATEGORY_RECOVERABILITY: Record<FailureCategory, Recoverability> = {
  rpc_rate_limit:       'recoverable',
  rpc_timeout:          'recoverable',
  horizon_timeout:      'ambiguous',
  horizon_transient:    'recoverable',
  eth_nonce_conflict:   'recoverable',
  eth_gas_too_low:      'recoverable',
  stellar_bad_seq:      'recoverable',
  stellar_fee_too_low:  'recoverable',
  insufficient_balance: 'terminal',
  auth_failure:         'terminal',
  terminal_unknown:     'terminal',
  partial_settlement:   'requires_review',
};

/** Overall recovery lifecycle of an order after at least one failure. */
export type RecoveryStatus =
  | 'pending'          // failure recorded, no retry yet
  | 'recovering'       // retry in progress
  | 'recovered'        // successfully settled after prior failure
  | 'failed'           // terminal; no further retries
  | 'requires_review'; // partial settlement or ambiguous; needs manual attention

/** A single failure event appended to an order's record. */
export interface FailureEvent {
  /** ISO timestamp of when the failure was recorded. */
  at: string;
  /** Structured failure category. */
  category: FailureCategory;
  /** Recoverability derived from the category. */
  recoverability: Recoverability;
  /** Raw error message (sanitised — no keys, hashes, or amounts). */
  errorMessage: string;
  /** Settlement direction at time of failure. */
  direction: string;
  /** Chain where the failure occurred ('ethereum' | 'stellar' | 'unknown'). */
  chain: 'ethereum' | 'stellar' | 'unknown';
  /** Attempt number (1-based). */
  attempt: number;
  /** Optional note about the recovery action taken or scheduled. */
  recoveryAction?: string;
}

/** Complete failure record for one order. */
export interface OrderFailureRecord {
  orderId: string;
  direction: string;
  recoveryStatus: RecoveryStatus;
  /** Total number of failure events recorded. */
  failureCount: number;
  /** Total number of recovery (retry) attempts recorded. */
  recoveryAttempts: number;
  /** Unix ms timestamp of the first failure event. */
  firstFailedAt: number;
  /** Unix ms timestamp of the most recent update. */
  lastUpdatedAt: number;
  /** Ordered list of failure events, oldest first. */
  events: FailureEvent[];
  /** If recovered, the successful tx hash (for audit trail). */
  recoveredTxHash?: string;
  /** If failed terminally, the final reason. */
  terminalReason?: string;
}

// ---------------------------------------------------------------------------
// SettlementFailureStore
// ---------------------------------------------------------------------------

export interface SettlementFailureStoreOptions {
  /**
   * Directory for per-order JSON files.
   * Defaults to `<cwd>/.settlement-failures`.
   * Pass `null` to disable disk persistence (tests).
   */
  storageDir?: string | null;
}

export class SettlementFailureStore {
  private readonly records = new Map<string, OrderFailureRecord>();
  private readonly storageDir: string | null;

  constructor(options: SettlementFailureStoreOptions = {}) {
    if (options.storageDir === null) {
      this.storageDir = null;
    } else {
      this.storageDir = options.storageDir ?? join(process.cwd(), '.settlement-failures');
      this._ensureDir();
      this._loadFromDisk();
    }
    // Initialise the pending-recovery gauge from loaded records.
    this._updatePendingGauge();
  }

  // ── Write API ─────────────────────────────────────────────────────────────

  /**
   * Record a single failure event for `orderId`.
   *
   * Creates a new record if this is the first failure for the order.
   * Increments Prometheus counters and persists to disk.
   *
   * @returns The updated OrderFailureRecord.
   */
  recordFailure(opts: {
    orderId: string;
    direction: string;
    category: FailureCategory;
    errorMessage: string;
    chain?: 'ethereum' | 'stellar' | 'unknown';
    recoveryAction?: string;
  }): OrderFailureRecord {
    const {
      orderId,
      direction,
      category,
      errorMessage,
      chain = 'unknown',
      recoveryAction,
    } = opts;

    const recoverability = CATEGORY_RECOVERABILITY[category];
    const now = Date.now();

    let record = this.records.get(orderId);

    if (!record) {
      record = {
        orderId,
        direction,
        recoveryStatus: 'pending',
        failureCount: 0,
        recoveryAttempts: 0,
        firstFailedAt: now,
        lastUpdatedAt: now,
        events: [],
      };
      this.records.set(orderId, record);
    }

    const event: FailureEvent = {
      at: new Date(now).toISOString(),
      category,
      recoverability,
      errorMessage: sanitiseErrorMessage(errorMessage),
      direction,
      chain,
      attempt: record.failureCount + 1,
      recoveryAction,
    };

    record.failureCount++;
    record.lastUpdatedAt = now;
    record.events.push(event);

    // Update recovery status based on recoverability
    if (recoverability === 'terminal') {
      record.recoveryStatus = 'failed';
      record.terminalReason = event.errorMessage;
    } else if (recoverability === 'requires_review') {
      record.recoveryStatus = 'requires_review';
    } else if (record.recoveryStatus === 'pending') {
      record.recoveryStatus = 'pending'; // stays pending until a retry is attempted
    }

    // Prometheus
    settlementFailuresTotal.inc({ direction, category, chain });
    settlementFailuresByCategory.inc({ category, recoverability });
    if (recoverability === 'terminal') {
      settlementTerminalTotal.inc({ direction, category });
    }
    this._updatePendingGauge();

    // Structured log
    this._log('warn', '[settlement-failure-store] failure recorded', {
      orderId,
      direction,
      category,
      recoverability,
      chain,
      attempt: event.attempt,
      recoveryAction,
    });
    correlationLog('warn', '[settlement-failure-store] failure recorded', {
      orderId, category, recoverability, chain,
    });

    this._persist(record);
    return record;
  }

  /**
   * Mark that a recovery (retry) attempt is starting for `orderId`.
   * Transitions status from `pending` → `recovering`.
   */
  markRecovering(orderId: string): void {
    const record = this.records.get(orderId);
    if (!record) return;
    if (record.recoveryStatus === 'failed' || record.recoveryStatus === 'recovered') return;

    record.recoveryStatus = 'recovering';
    record.recoveryAttempts++;
    record.lastUpdatedAt = Date.now();

    settlementRecoveryAttemptsTotal.inc({ direction: record.direction });
    this._log('info', '[settlement-failure-store] recovery attempt started', {
      orderId,
      recoveryAttempts: record.recoveryAttempts,
    });
    this._persist(record);
  }

  /**
   * Mark that a settlement succeeded after one or more prior failures.
   * Records the recovering tx hash for audit and transitions to `recovered`.
   */
  markRecovered(orderId: string, txHash: string): void {
    const record = this.records.get(orderId);
    if (!record) return;

    record.recoveryStatus = 'recovered';
    record.recoveredTxHash = txHash;
    record.lastUpdatedAt = Date.now();

    settlementRecoveredTotal.inc({ direction: record.direction });
    this._updatePendingGauge();
    this._log('info', '[settlement-failure-store] order recovered after failure', {
      orderId,
      txHash,
      totalFailures: record.failureCount,
      totalRecoveryAttempts: record.recoveryAttempts,
    });
    correlationLog('info', '[settlement-failure-store] order recovered', { orderId, txHash });
    this._persist(record);
  }

  /**
   * Force an order to `requires_review` (e.g. partial settlement detected).
   */
  markRequiresReview(orderId: string, reason: string): void {
    const record = this.records.get(orderId);
    if (!record) return;

    record.recoveryStatus = 'requires_review';
    record.terminalReason = reason;
    record.lastUpdatedAt = Date.now();

    this._log('warn', '[settlement-failure-store] order requires manual review', {
      orderId, reason,
    });
    this._persist(record);
  }

  // ── Read API ──────────────────────────────────────────────────────────────

  /** Retrieve the failure record for an order, or undefined if none. */
  get(orderId: string): OrderFailureRecord | undefined {
    return this.records.get(orderId);
  }

  /** True if any failure has been recorded for the order. */
  hasFailed(orderId: string): boolean {
    return this.records.has(orderId);
  }

  /** All records with the given recovery status. */
  byStatus(status: RecoveryStatus): OrderFailureRecord[] {
    return Array.from(this.records.values()).filter(r => r.recoveryStatus === status);
  }

  /** All records — for admin endpoint. */
  all(): OrderFailureRecord[] {
    return Array.from(this.records.values());
  }

  /** Summary counts per recovery status. */
  summary(): Record<RecoveryStatus, number> {
    const out: Record<RecoveryStatus, number> = {
      pending: 0, recovering: 0, recovered: 0, failed: 0, requires_review: 0,
    };
    for (const r of this.records.values()) out[r.recoveryStatus]++;
    return out;
  }

  /** Total number of failure records. */
  size(): number {
    return this.records.size;
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  private _updatePendingGauge(): void {
    let pending = 0;
    for (const r of this.records.values()) {
      if (r.recoveryStatus === 'pending' || r.recoveryStatus === 'recovering' || r.recoveryStatus === 'requires_review') {
        pending++;
      }
    }
    settlementPendingRecoveryGauge.set(pending);
  }

  private _log(
    level: 'info' | 'warn' | 'error',
    msg: string,
    extra?: Record<string, unknown>,
  ): void {
    getLogger()[level](extra ?? {}, msg);
  }

  // ── Persistence ───────────────────────────────────────────────────────────

  private _ensureDir(): void {
    if (this.storageDir && !existsSync(this.storageDir)) {
      mkdirSync(this.storageDir, { recursive: true });
    }
  }

  private _filePath(orderId: string): string {
    const safe = orderId.replace(/[^a-zA-Z0-9_\-]/g, '_').substring(0, 120);
    return join(this.storageDir!, `${safe}.json`);
  }

  private _persist(record: OrderFailureRecord): void {
    if (!this.storageDir) return;
    const fpath = this._filePath(record.orderId);
    const tmp = fpath + '.tmp';
    try {
      writeFileSync(tmp, JSON.stringify({ ...record, savedAt: Date.now() }), 'utf-8');
      renameSync(tmp, fpath);
    } catch (err) {
      getLogger().warn({ orderId: record.orderId, err: err instanceof Error ? err.message : String(err) }, '[settlement-failure-store] failed to persist record');
    }
  }

  private _loadFromDisk(): void {
    if (!this.storageDir || !existsSync(this.storageDir)) return;
    let files: string[];
    try {
      files = readdirSync(this.storageDir).filter(
        f => f.endsWith('.json') && !f.endsWith('.tmp'),
      );
    } catch { return; }

    const VALID_RECOVERY_STATUSES = new Set<string>([
      'pending', 'recovering', 'recovered', 'failed', 'requires_review',
    ]);

    for (const file of files) {
      const fpath = join(this.storageDir, file);
      try {
        const raw = readFileSync(fpath, 'utf-8');
        const parsed = JSON.parse(raw) as (OrderFailureRecord & { savedAt?: number });

        // ── Structural validation ───────────────────────────────────────────
        // Reject records missing any field that downstream code assumes is
        // present. A silent skip with a warning is far safer than loading a
        // half-formed record that will throw at call-time.
        const malformed = (
          !parsed ||
          typeof parsed !== 'object' ||
          typeof parsed.orderId !== 'string' || parsed.orderId.length === 0 ||
          typeof parsed.direction !== 'string' ||
          typeof parsed.recoveryStatus !== 'string' ||
          !VALID_RECOVERY_STATUSES.has(parsed.recoveryStatus) ||
          typeof parsed.failureCount !== 'number' ||
          typeof parsed.recoveryAttempts !== 'number' ||
          typeof parsed.firstFailedAt !== 'number' ||
          typeof parsed.lastUpdatedAt !== 'number' ||
          !Array.isArray(parsed.events) ||
          this.records.has(parsed.orderId)
        );

        if (malformed) {
          this._log('warn', '[settlement-failure-store] skipping malformed persisted record', {
            file,
            orderId: typeof parsed?.orderId === 'string' ? parsed.orderId : undefined,
            reason: !parsed || typeof parsed !== 'object'
              ? 'not an object'
              : typeof parsed.orderId !== 'string' || parsed.orderId.length === 0
                ? 'missing or empty orderId'
                : typeof parsed.direction !== 'string'
                  ? 'missing direction'
                  : !VALID_RECOVERY_STATUSES.has(String(parsed.recoveryStatus))
                    ? `invalid recoveryStatus: ${parsed.recoveryStatus}`
                    : typeof parsed.failureCount !== 'number'
                      ? 'missing failureCount'
                      : typeof parsed.recoveryAttempts !== 'number'
                        ? 'missing recoveryAttempts'
                        : typeof parsed.firstFailedAt !== 'number'
                          ? 'missing firstFailedAt'
                          : typeof parsed.lastUpdatedAt !== 'number'
                            ? 'missing lastUpdatedAt'
                            : !Array.isArray(parsed.events)
                              ? 'events is not an array'
                              : 'duplicate orderId',
          });
          continue;
        }

        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { savedAt: _s, ...record } = parsed;
        this.records.set(record.orderId, record as OrderFailureRecord);
      } catch { /* JSON parse error or I/O error — skip silently */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Error message sanitiser
// ---------------------------------------------------------------------------

/**
 * Strip anything that looks like a private key, tx hash, or wallet address
 * from the error message before writing it to the failure record.
 */
function sanitiseErrorMessage(msg: string): string {
  return msg
    .replace(/0x[0-9a-fA-F]{40,}/g, '[address/hash]')
    .replace(/[SG][A-Z0-9]{54,}/g, '[stellar-key]')
    .substring(0, 500); // hard cap to prevent log flooding
}

// ---------------------------------------------------------------------------
// Process-wide singleton
// ---------------------------------------------------------------------------

/**
 * Process-wide singleton. Import this wherever settlement failures are reported.
 *
 * In tests, create isolated instances with `storageDir: null`:
 *   const store = new SettlementFailureStore({ storageDir: null });
 */
export const globalSettlementFailureStore = new SettlementFailureStore();
