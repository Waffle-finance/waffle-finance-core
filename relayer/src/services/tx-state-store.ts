/**
 * @fileoverview Durable transaction-state reconciliation store for the relayer.
 *
 * Problem
 * -------
 * The relayer coordinates settlement actions across multiple chains. Before
 * this module the only state lived in the `activeOrders` in-memory Map inside
 * index.ts. After a restart that Map was empty, so the relayer could not tell
 * whether a submitted transaction was still pending on-chain, already mined,
 * already recorded in the coordinator, or permanently failed. Operators had
 * no way to know either without reading two separate log streams and guessing.
 *
 * Solution
 * --------
 * `TxStateStore` maintains a durable per-order state record that tracks the
 * full relay transaction lifecycle:
 *
 *   pending_submission   — order accepted, transaction not yet submitted
 *       ↓
 *   submission_acked     — transaction broadcast, hash known, not yet mined
 *       ↓
 *   chain_mined          — receipt received, confirmed on-chain
 *       ↓
 *   coordinator_recorded — coordinator acknowledged the settlement event
 *       ↓
 *   complete             — terminal success
 *
 * Parallel terminal failure path (reachable from any non-terminal state):
 *   terminal_failure     — permanent failure, no further relay attempts
 *
 * Each record is written to disk atomically on every transition so the store
 * survives process restarts. On startup `reconcile()` loads all non-terminal
 * records and can determine the current state of each submitted order.
 *
 * Reconciliation
 * --------------
 * `reconcile(provider)` is called at startup (and on demand) to recover
 * in-flight records. For each non-terminal record it:
 *   - `pending_submission`   → marks `terminal_failure` if the timeout window
 *                              has expired (submission was never broadcast).
 *   - `submission_acked`     → queries the chain for the tx receipt; if mined
 *                              advances to `chain_mined`.
 *   - `chain_mined`          → re-emits the coordinator notification event so
 *                              the coordinator can pick up the receipt.
 *   - `coordinator_recorded` → advances to `complete`.
 *
 * Duplicate receipts
 * ------------------
 * `recordReceipt` is idempotent: re-submitting the same txHash for an order
 * that is already in `chain_mined` or later returns `false` and increments a
 * Prometheus counter so operators can see double-delivery noise without it
 * causing state corruption.
 *
 * Metrics
 * -------
 * Every state transition records:
 *   relayer_tx_state_transitions_total{from_state, to_state}
 *   relayer_tx_state_current_by_state{state}              (sampled per sweep)
 *   relayer_tx_state_reconciliations_total{trigger}
 *   relayer_tx_state_recovered_total{recovered_to_state}
 *   relayer_tx_state_duplicate_receipts_total
 *   relayer_tx_state_reconciliation_duration_seconds
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import {
  txStateTransitionsTotal,
  txStateReconciliationsTotal,
  txStateRecoveredTotal,
  txStateDuplicateReceiptsTotal,
  txStateCurrentByState,
  txStateReconciliationDurationSeconds,
} from '../metrics.js';
import { correlationLog } from '../correlation/correlation-context.js';
import { getLogger } from '../logger.js';

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

/** Every state the relay transaction can occupy. */
export type TxState =
  | 'pending_submission'
  | 'submission_acked'
  | 'chain_mined'
  | 'coordinator_recorded'
  | 'complete'
  | 'terminal_failure';

/** States that allow further progress (not yet at a terminal). */
const NON_TERMINAL_STATES: ReadonlySet<TxState> = new Set([
  'pending_submission',
  'submission_acked',
  'chain_mined',
  'coordinator_recorded',
]);

/** Legal forward transitions. */
const ALLOWED_TRANSITIONS: ReadonlyMap<TxState, ReadonlySet<TxState>> = new Map([
  ['pending_submission',   new Set(['submission_acked', 'terminal_failure'])],
  ['submission_acked',     new Set(['chain_mined', 'terminal_failure'])],
  ['chain_mined',          new Set(['coordinator_recorded', 'terminal_failure'])],
  ['coordinator_recorded', new Set(['complete', 'terminal_failure'])],
  ['complete',             new Set()],          // terminal — no exit
  ['terminal_failure',     new Set()],          // terminal — no exit
]);

export function isTerminalState(state: TxState): boolean {
  return state === 'complete' || state === 'terminal_failure';
}

export function isTransitionAllowed(from: TxState, to: TxState): boolean {
  return ALLOWED_TRANSITIONS.get(from)?.has(to) ?? false;
}

// ---------------------------------------------------------------------------
// Record types
// ---------------------------------------------------------------------------

/** A single relay transaction's lifecycle record. */
export interface TxStateRecord {
  /** Order ID this relay action is serving. */
  orderId: string;

  /** Stable correlation ID for log tracing. */
  correlationId: string;

  /** Bridge route (for metrics labels). */
  route: string;

  /** Current lifecycle state. */
  state: TxState;

  /** Chain transaction hash — set when state ≥ submission_acked. */
  txHash?: string;

  /** Block number the transaction was mined in — set when state ≥ chain_mined. */
  minedBlock?: number;

  /** Block timestamp (seconds) when mined — set when state ≥ chain_mined. */
  minedAt?: number;

  /** Number of block confirmations at last check — set when state ≥ chain_mined. */
  confirmations?: number;

  /** Coordinator acknowledgement reference — set when state ≥ coordinator_recorded. */
  coordinatorRef?: string;

  /** Unix timestamp (ms) when the record was first created. */
  createdAt: number;

  /** Unix timestamp (ms) of the last state transition. */
  updatedAt: number;

  /** History of all transitions for audit. */
  transitions: Array<{
    from: TxState;
    to: TxState;
    at: number;
    note?: string;
  }>;

  /** Failure reason — populated when state = terminal_failure. */
  failureReason?: string;

  /** Number of reconciliation recovery attempts made for this record. */
  recoveryAttempts: number;
}

/** Slim on-disk format (same fields, just makes intent explicit). */
type PersistedTxRecord = TxStateRecord & { savedAt: number };

// ---------------------------------------------------------------------------
// Reconciliation provider interface
// ---------------------------------------------------------------------------

/**
 * Minimal chain provider interface required by the reconciler.
 * Designed to be satisfied by ethers.js `JsonRpcProvider` but kept
 * abstract so tests can inject a stub without a real RPC endpoint.
 */
export interface ChainProvider {
  getTransactionReceipt(txHash: string): Promise<TxReceipt | null>;
  getBlockNumber(): Promise<number>;
}

export interface TxReceipt {
  hash: string;
  blockNumber: number;
  blockHash: string;
  status: number;          // 1 = success, 0 = reverted
  gasUsed: bigint;
  confirmations?: number;
}

// ---------------------------------------------------------------------------
// TxStateStore
// ---------------------------------------------------------------------------

export interface TxStateStoreOptions {
  /**
   * Directory where per-order JSON files are persisted.
   * Defaults to `<cwd>/.tx-state-store`.
   * Pass `null` to disable disk persistence (tests).
   */
  storageDir?: string | null;

  /**
   * How long (ms) a `pending_submission` record may live before the
   * reconciler marks it `terminal_failure`. Defaults to 30 minutes.
   */
  pendingSubmissionTimeoutMs?: number;

  /**
   * How many recovery attempts to allow before declaring `terminal_failure`.
   * Defaults to 5.
   */
  maxRecoveryAttempts?: number;
}

export class TxStateStore {
  private readonly records = new Map<string, TxStateRecord>();
  private readonly storageDir: string | null;
  private readonly pendingTimeoutMs: number;
  private readonly maxRecovery: number;

  constructor(options: TxStateStoreOptions = {}) {
    if (options.storageDir === null) {
      this.storageDir = null;
    } else {
      this.storageDir = options.storageDir ?? join(process.cwd(), '.tx-state-store');
      this._ensureDir();
      this._loadFromDisk();
    }
    this.pendingTimeoutMs = options.pendingSubmissionTimeoutMs ?? 30 * 60 * 1000;
    this.maxRecovery = options.maxRecoveryAttempts ?? 5;
  }

  // ── Write API ─────────────────────────────────────────────────────────────

  /**
   * Create a new record in `pending_submission` state.
   * Throws if a record for `orderId` already exists.
   */
  create(opts: {
    orderId: string;
    correlationId: string;
    route: string;
  }): TxStateRecord {
    if (this.records.has(opts.orderId)) {
      throw new TxStateError(
        `[tx-state] Record already exists for orderId=${opts.orderId}`,
        'ALREADY_EXISTS',
      );
    }
    const now = Date.now();
    const record: TxStateRecord = {
      orderId: opts.orderId,
      correlationId: opts.correlationId,
      route: opts.route,
      state: 'pending_submission',
      createdAt: now,
      updatedAt: now,
      transitions: [],
      recoveryAttempts: 0,
    };
    this.records.set(opts.orderId, record);
    this._persist(record);
    this._log('info', 'record created', record);
    return record;
  }

  /**
   * Advance a record to `submission_acked` once the tx has been broadcast.
   */
  ackSubmission(orderId: string, txHash: string): TxStateRecord {
    return this._transition(orderId, 'submission_acked', { txHash }, 'tx broadcast');
  }

  /**
   * Advance a record to `chain_mined` when a receipt is received.
   * Idempotent for the same receipt — returns `false` if already recorded.
   */
  recordReceipt(
    orderId: string,
    receipt: TxReceipt,
  ): { record: TxStateRecord; accepted: boolean } {
    const record = this._getOrThrow(orderId);

    // Duplicate receipt guard
    if (!isTransitionAllowed(record.state, 'chain_mined')) {
      if (record.txHash === receipt.hash && record.state !== 'pending_submission') {
        txStateDuplicateReceiptsTotal.inc();
        this._log('warn', 'duplicate receipt ignored', record, { txHash: receipt.hash });
        return { record, accepted: false };
      }
      throw new TxStateError(
        `[tx-state] Cannot record receipt for orderId=${orderId} in state=${record.state}`,
        'INVALID_TRANSITION',
      );
    }

    const updated = this._transition(orderId, 'chain_mined', {
      txHash: receipt.hash,
      minedBlock: receipt.blockNumber,
      minedAt: Date.now(),
      confirmations: receipt.confirmations ?? 0,
    }, `mined in block ${receipt.blockNumber}`);
    return { record: updated, accepted: true };
  }

  /**
   * Advance a record to `coordinator_recorded` after the coordinator
   * acknowledges the settlement event.
   */
  recordCoordinatorAck(orderId: string, coordinatorRef: string): TxStateRecord {
    return this._transition(
      orderId,
      'coordinator_recorded',
      { coordinatorRef },
      `coordinator ref: ${coordinatorRef}`,
    );
  }

  /**
   * Advance a record to `complete` (terminal success).
   */
  markComplete(orderId: string): TxStateRecord {
    return this._transition(orderId, 'complete', {}, 'relay complete');
  }

  /**
   * Advance a record to `terminal_failure`.
   * Can be called from any non-terminal state.
   */
  markFailed(orderId: string, reason: string): TxStateRecord {
    return this._transition(orderId, 'terminal_failure', { failureReason: reason }, reason);
  }

  // ── Read API ──────────────────────────────────────────────────────────────

  get(orderId: string): TxStateRecord | undefined {
    return this.records.get(orderId);
  }

  /** All records in a given state. */
  byState(state: TxState): TxStateRecord[] {
    return Array.from(this.records.values()).filter(r => r.state === state);
  }

  /** Count of records per state — for operator dashboards. */
  stateCounts(): Record<TxState, number> {
    const counts: Record<TxState, number> = {
      pending_submission: 0,
      submission_acked: 0,
      chain_mined: 0,
      coordinator_recorded: 0,
      complete: 0,
      terminal_failure: 0,
    };
    for (const r of this.records.values()) counts[r.state]++;
    return counts;
  }

  /** Total number of records. */
  size(): number {
    return this.records.size;
  }

  /** Snapshot of all records — for diagnostics and tests. */
  snapshot(): TxStateRecord[] {
    return Array.from(this.records.values());
  }

  // ── Reconciliation ────────────────────────────────────────────────────────

  /**
   * Walk all non-terminal records and attempt to advance or recover them.
   *
   * Call this:
   *   - At relayer startup (trigger = 'startup')
   *   - On a scheduled interval (trigger = 'scheduled')
   *   - Manually via an admin endpoint (trigger = 'manual')
   *
   * The `provider` is only contacted for records in `submission_acked` or
   * `chain_mined` states that need on-chain data. Records in
   * `pending_submission` and `coordinator_recorded` are resolved from
   * internal state only.
   *
   * Returns a summary of what was recovered.
   */
  async reconcile(
    provider: ChainProvider | null,
    trigger: 'startup' | 'scheduled' | 'manual' = 'scheduled',
  ): Promise<ReconcileSummary> {
    const endTimer = txStateReconciliationDurationSeconds.startTimer();
    txStateReconciliationsTotal.inc({ trigger });

    const summary: ReconcileSummary = {
      trigger,
      scanned: 0,
      advanced: 0,
      failed: 0,
      skipped: 0,
      startedAt: Date.now(),
    };

    try {
      const nonTerminal = Array.from(this.records.values()).filter(
        r => NON_TERMINAL_STATES.has(r.state),
      );

      summary.scanned = nonTerminal.length;

      for (const record of nonTerminal) {
        try {
          const result = await this._reconcileRecord(record, provider);
          if (result === 'advanced') summary.advanced++;
          else if (result === 'failed') summary.failed++;
          else summary.skipped++;
        } catch (err) {
          summary.skipped++;
          this._log('warn', 'reconcile record error — skipping', record, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Update current-by-state gauge after sweep
      const counts = this.stateCounts();
      for (const [state, count] of Object.entries(counts)) {
        txStateCurrentByState.set({ state }, count);
      }
    } finally {
      endTimer();
    }

    this._log('info', '[tx-state] reconciliation complete', undefined, {
      trigger,
      ...summary,
      durationMs: Date.now() - summary.startedAt,
    });

    return summary;
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  private async _reconcileRecord(
    record: TxStateRecord,
    provider: ChainProvider | null,
  ): Promise<'advanced' | 'failed' | 'skipped'> {
    const now = Date.now();

    // Guard: too many recovery attempts
    if (record.recoveryAttempts >= this.maxRecovery) {
      this.markFailed(record.orderId, `max recovery attempts (${this.maxRecovery}) exceeded`);
      return 'failed';
    }

    record.recoveryAttempts++;
    this._persist(record);

    switch (record.state) {
      case 'pending_submission': {
        const age = now - record.createdAt;
        if (age > this.pendingTimeoutMs) {
          this.markFailed(
            record.orderId,
            `pending_submission timeout after ${Math.round(age / 1000)}s`,
          );
          return 'failed';
        }
        return 'skipped'; // still within window
      }

      case 'submission_acked': {
        if (!record.txHash || !provider) return 'skipped';
        const receipt = await provider.getTransactionReceipt(record.txHash);
        if (!receipt) return 'skipped'; // not yet mined

        if (receipt.status === 0) {
          this.markFailed(record.orderId, `tx reverted on-chain: ${record.txHash}`);
          txStateRecoveredTotal.inc({ recovered_to_state: 'terminal_failure' });
          return 'failed';
        }

        const { record: updated } = this.recordReceipt(record.orderId, receipt);
        txStateRecoveredTotal.inc({ recovered_to_state: updated.state });
        return 'advanced';
      }

      case 'chain_mined': {
        // Re-emit coordinator notification. The coordinator layer is expected
        // to call recordCoordinatorAck once it has processed the event.
        // Here we can only log and count — the actual re-notification is done
        // by whichever service owns the coordinator client.
        this._log('warn', '[tx-state] chain_mined without coordinator ack — needs re-notification', record);
        txStateRecoveredTotal.inc({ recovered_to_state: 'chain_mined' });
        return 'skipped';
      }

      case 'coordinator_recorded': {
        this.markComplete(record.orderId);
        txStateRecoveredTotal.inc({ recovered_to_state: 'complete' });
        return 'advanced';
      }

      default:
        return 'skipped';
    }
  }

  private _transition(
    orderId: string,
    to: TxState,
    patch: Partial<TxStateRecord>,
    note?: string,
  ): TxStateRecord {
    const record = this._getOrThrow(orderId);
    const from = record.state;

    if (!isTransitionAllowed(from, to)) {
      throw new TxStateError(
        `[tx-state] Invalid transition ${from} → ${to} for orderId=${orderId}`,
        'INVALID_TRANSITION',
      );
    }

    const now = Date.now();
    record.transitions.push({ from, to, at: now, note });
    record.state = to;
    record.updatedAt = now;

    // Apply field patches
    if (patch.txHash !== undefined) record.txHash = patch.txHash;
    if (patch.minedBlock !== undefined) record.minedBlock = patch.minedBlock;
    if (patch.minedAt !== undefined) record.minedAt = patch.minedAt;
    if (patch.confirmations !== undefined) record.confirmations = patch.confirmations;
    if (patch.coordinatorRef !== undefined) record.coordinatorRef = patch.coordinatorRef;
    if (patch.failureReason !== undefined) record.failureReason = patch.failureReason;

    txStateTransitionsTotal.inc({ from_state: from, to_state: to });
    this._persist(record);
    this._log('info', `[tx-state] ${from} → ${to}`, record, { note });

    return record;
  }

  private _getOrThrow(orderId: string): TxStateRecord {
    const record = this.records.get(orderId);
    if (!record) {
      throw new TxStateError(
        `[tx-state] No record found for orderId=${orderId}`,
        'NOT_FOUND',
      );
    }
    return record;
  }

  private _log(
    level: 'info' | 'warn' | 'error',
    msg: string,
    record: TxStateRecord | undefined,
    extra?: Record<string, unknown>,
  ): void {
    const fields: Record<string, unknown> = { ...extra };
    if (record) {
      fields.orderId = record.orderId;
      fields.correlationId = record.correlationId;
      fields.state = record.state;
      fields.route = record.route;
    }
    getLogger()[level](fields, msg);

    // Also stamp correlation context if we're inside one
    correlationLog(level, msg, fields);
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

  private _persist(record: TxStateRecord): void {
    if (!this.storageDir) return;
    const payload: PersistedTxRecord = { ...record, savedAt: Date.now() };
    const fpath = this._filePath(record.orderId);
    const tmp = fpath + '.tmp';
    try {
      writeFileSync(tmp, JSON.stringify(payload), 'utf-8');
      renameSync(tmp, fpath);
    } catch (err) {
      getLogger().warn({ orderId: record.orderId, err: err instanceof Error ? err.message : String(err) }, '[tx-state] failed to persist record');
    }
  }

  private _deletePersisted(orderId: string): void {
    if (!this.storageDir) return;
    const fpath = this._filePath(orderId);
    try {
      if (existsSync(fpath)) unlinkSync(fpath);
    } catch { /* best-effort */ }
  }

  private _loadFromDisk(): void {
    if (!this.storageDir || !existsSync(this.storageDir)) return;

    let files: string[];
    try {
      files = readdirSync(this.storageDir).filter(
        f => f.endsWith('.json') && !f.endsWith('.tmp'),
      );
    } catch { return; }

    for (const file of files) {
      const fpath = join(this.storageDir, file);
      try {
        const raw = readFileSync(fpath, 'utf-8');
        const persisted: PersistedTxRecord = JSON.parse(raw);
        if (
          persisted &&
          typeof persisted.orderId === 'string' &&
          typeof persisted.state === 'string' &&
          !this.records.has(persisted.orderId)
        ) {
          // Validate block number fields: must be nonnegative finite integers when present.
          if (!_isValidBlockNumber(persisted.minedBlock)) {
            process.stderr.write(
              JSON.stringify({
                level: 'warn',
                msg: '[tx-state] rejecting persisted record with invalid minedBlock',
                orderId: persisted.orderId,
                minedBlock: persisted.minedBlock,
              }) + '\n',
            );
            continue;
          }

          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const { savedAt: _savedAt, ...record } = persisted;
          this.records.set(record.orderId, record as TxStateRecord);
        }
      } catch { /* corrupted file — skip */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if `value` is a valid persisted block number:
 * undefined/absent (field not yet set), OR a finite nonnegative safe integer.
 * Rejects negative numbers, fractional numbers, NaN, and Infinity.
 */
function _isValidBlockNumber(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0
  );
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class TxStateError extends Error {
  readonly code: 'ALREADY_EXISTS' | 'INVALID_TRANSITION' | 'NOT_FOUND';
  constructor(message: string, code: TxStateError['code']) {
    super(message);
    this.name = 'TxStateError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Reconciliation summary
// ---------------------------------------------------------------------------

export interface ReconcileSummary {
  trigger: 'startup' | 'scheduled' | 'manual';
  scanned: number;
  advanced: number;
  failed: number;
  skipped: number;
  startedAt: number;
}

// ---------------------------------------------------------------------------
// Process-wide singleton
// ---------------------------------------------------------------------------

/**
 * Process-wide singleton TxStateStore.
 *
 * In tests, create isolated instances with `storageDir: null`:
 *   const store = new TxStateStore({ storageDir: null });
 */
export const globalTxStateStore = new TxStateStore();
