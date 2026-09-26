/**
 * @fileoverview SettlementService — structured retry, state persistence, and
 * recovery for the relayer's settlement flows.
 *
 * Problem
 * -------
 * The original settlement handlers in index.ts retried inline with ad-hoc
 * loops and left orders in an ambiguous state on failure.  There was no
 * shared classification of which errors are retryable, no durable record of
 * which orders are mid-settlement, and no operator-visible recovery path.
 *
 * Solution
 * --------
 * SettlementService wraps every settlement action in:
 *
 *  1. FAULT CLASSIFICATION — delegates to RetryEngine's defaultClassifier:
 *       transient          → retry with exponential backoff
 *       confirmation_delay → retry with longer cool-down
 *       terminal           → fail immediately, no retry
 *
 *  2. STATE PERSISTENCE — every settlement action is tracked via TxStateStore
 *     so a restart can reconcile in-flight orders from the persisted record
 *     rather than guessing from the in-memory activeOrders map.
 *
 *  3. STRUCTURED RECOVERY — reconcile() (called at startup and on demand)
 *     queries each in-flight record, advances state where possible, and
 *     marks terminal_failure for orders that cannot be recovered.
 *
 *  4. METRICS — every attempt, failure, recovery, and state transition
 *     increments the Prometheus counters defined in metrics.ts.
 *
 * Usage
 * -----
 * ```ts
 * const svc = new SettlementService({ txStateStore, retryEngine });
 *
 * // Wrap a settlement action:
 * await svc.settle({
 *   orderId: 'order_123',
 *   direction: 'xlm_to_eth',
 *   correlationId: 'cid-abc',
 *   action: async () => {
 *     const tx = await relayerWallet.sendTransaction(tx);
 *     return tx.hash;
 *   },
 *   onTxHash: (hash) => txStateStore.ackSubmission(orderId, hash),
 * });
 *
 * // At startup:
 * await svc.reconcile(ethProvider, 'startup');
 *
 * // Status endpoint:
 * svc.getStatus('order_123');
 * ```
 */

import {
  TxStateStore,
  TxStateError,
  isTerminalState,
  type TxStateRecord,
  type ChainProvider,
  type ReconcileSummary,
} from './tx-state-store.js';
import {
  RetryEngine,
  RetryExhaustedError,
  CircuitOpenError,
  defaultClassifier,
  type FaultClassifier,
  type FaultClass,
} from '../utils/retry-engine.js';
import {
  settlementAttemptsTotal,
  settlementFailuresTotal,
  settlementRecoveryTotal,
  settlementStateGauge,
  settlementDurationSeconds,
} from '../metrics.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SettleOptions {
  /** Stable order identifier. */
  orderId: string;
  /** Route direction label for metrics. */
  direction: string;
  /** Correlation ID for log tracing. */
  correlationId: string;
  /** Route label (e.g. 'eth_to_xlm'). */
  route?: string;
  /**
   * The actual settlement action.  Must return the chain transaction hash
   * string on success, or throw on failure.
   */
  action: () => Promise<string>;
  /**
   * Called as soon as a txHash is available (before waiting for receipt).
   * Use this to call `txStateStore.ackSubmission()` so the hash is persisted
   * even if the process crashes before confirmation.
   */
  onTxHash?: (txHash: string) => void;
  /** Override the default fault classifier for this action. */
  classifier?: FaultClassifier;
  /** Override max attempts (default: engine default = 5). */
  maxAttempts?: number;
  /** Override base delay ms. */
  baseDelayMs?: number;
  /**
   * Optional Soroban-specific deduplication key, typically
   * `"<ledger>:<txHash>"` or `"<contractId>:<orderId>"`.
   *
   * When provided, `settle()` checks this key against an in-process index
   * before creating a new TxStateRecord.  If a matching record already has a
   * txHash (submitted or complete), that hash is returned immediately without
   * calling `action` again.
   *
   * This prevents a second Soroban contract submission when the same
   * coordinator event triggers `settle()` twice within the same process
   * lifetime — e.g. during a bounded replay pass or when a live event and a
   * recovery event for the same order arrive within the same poll window.
   *
   * Note: this guard is in-process only.  Cross-restart replay protection
   * relies on the TxStateStore's durable `ackSubmission` record and on the
   * coordinator's `decideDispatch` policy (which checks the DB for
   * already-applied transitions before notifying the relayer).
   */
  contractKey?: string;
}

export interface SettleResult {
  /** The committed transaction hash. */
  txHash: string;
  /** Number of attempts made (1 = succeeded on first try). */
  attempts: number;
  /** Fault class of the last error before success (undefined on first-try success). */
  lastFaultClass?: FaultClass;
}

export interface SettlementServiceOptions {
  /** Injected TxStateStore — use `storageDir: null` in tests. */
  txStateStore?: TxStateStore;
  /** Injected RetryEngine — create isolated instance in tests. */
  retryEngine?: RetryEngine;
  /**
   * Maximum retry attempts per settlement action.
   * Defaults to 5. Override per-call via SettleOptions.maxAttempts.
   */
  defaultMaxAttempts?: number;
  /** Base backoff delay in ms. Defaults to 1000. */
  defaultBaseDelayMs?: number;
  /** Maximum backoff delay in ms. Defaults to 30000. */
  defaultMaxDelayMs?: number;
}

// ---------------------------------------------------------------------------
// SettlementService
// ---------------------------------------------------------------------------

export class SettlementService {
  private readonly store: TxStateStore;
  private readonly engine: RetryEngine;
  private readonly defaultMaxAttempts: number;
  private readonly defaultBaseDelayMs: number;
  private readonly defaultMaxDelayMs: number;

  /**
   * In-process index from Soroban `contractKey` → `orderId`.
   *
   * Populated by `settle()` when a caller supplies a `contractKey`.  Used to
   * short-circuit duplicate contract submissions within the same process
   * lifetime without requiring a second TxStateStore lookup by contractKey.
   */
  private readonly contractKeyIndex = new Map<string, string>();

  constructor(options: SettlementServiceOptions = {}) {
    this.store = options.txStateStore ?? new TxStateStore();
    this.engine = options.retryEngine ?? new RetryEngine();
    this.defaultMaxAttempts = options.defaultMaxAttempts ?? 5;
    this.defaultBaseDelayMs = options.defaultBaseDelayMs ?? 1_000;
    this.defaultMaxDelayMs = options.defaultMaxDelayMs ?? 30_000;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Execute a settlement action with structured retry, classification, and
   * state persistence.
   *
   * Creates a TxStateRecord in `pending_submission` state before the first
   * attempt.  On each failure the error is classified; terminal errors abort
   * immediately and mark the record `terminal_failure`.  Transient / delay
   * errors are retried up to `maxAttempts`.
   *
   * If the record already exists (e.g. duplicate call or restart) this method
   * returns the existing record's tx hash if it is already in a completed or
   * mined state, avoiding double-submission.
   */
  async settle(opts: SettleOptions): Promise<SettleResult> {
    const {
      orderId,
      direction,
      correlationId,
      route = direction,
      action,
      onTxHash,
      classifier,
      maxAttempts = this.defaultMaxAttempts,
      baseDelayMs = this.defaultBaseDelayMs,
    } = opts;

    const startedAt = Date.now();

    // ── Soroban contractKey dedup (in-process, within session) ────────────
    // When a Soroban-specific key is provided, check if this exact contract
    // invocation was already initiated in this session.  Prevents a second
    // Soroban contract call when a bounded replay or a live+recovery event
    // pair triggers settle() for the same on-chain action twice.
    if (opts.contractKey) {
      const knownOrderId = this.contractKeyIndex.get(opts.contractKey);
      if (knownOrderId) {
        const keyRecord = this.store.get(knownOrderId);
        if (keyRecord?.txHash) {
          return { txHash: keyRecord.txHash, attempts: 0 };
        }
      }
    }

    // ── Idempotency: if a record already exists, check its state. ──────────
    const existing = this.store.get(orderId);
    if (existing) {
      if (existing.state === 'complete' || existing.state === 'chain_mined') {
        return {
          txHash: existing.txHash!,
          attempts: 0,
          lastFaultClass: undefined,
        };
      }
      if (existing.state === 'terminal_failure') {
        throw new SettlementError(
          orderId,
          `Order ${orderId} is already in terminal_failure: ${existing.failureReason}`,
          'terminal',
          0,
        );
      }
      // submission_acked or coordinator_recorded: already submitted, return hash.
      if (existing.txHash) {
        return { txHash: existing.txHash, attempts: 0 };
      }
    }

    // ── Create state record. ───────────────────────────────────────────────
    let record: TxStateRecord;
    try {
      record = this.store.create({ orderId, correlationId, route });
    } catch (err) {
      if (err instanceof TxStateError && err.code === 'ALREADY_EXISTS') {
        // Race: another concurrent call created the record just now.
        const r = this.store.get(orderId);
        if (r?.txHash) return { txHash: r.txHash, attempts: 0 };
      }
      throw err;
    }

    this._updateStateGauge();

    let lastFaultClass: FaultClass = 'transient';
    let attempts = 0;

    try {
      const txHash = await this.engine.run(
        `settlement:${direction}`,
        async () => {
          attempts++;
          settlementAttemptsTotal.inc({ direction, failure_category: 'none' });
          const hash = await action();
          // Persist the tx hash as soon as it is available.
          try {
            this.store.ackSubmission(orderId, hash);
          } catch {
            // Record may have been advanced by concurrent reconciliation.
          }
          if (onTxHash) onTxHash(hash);
          return hash;
        },
        {
          classifier: (err) => {
            const cls = classifier ? (classifier(err) ?? defaultClassifier(err)) : defaultClassifier(err);
            lastFaultClass = cls;
            if (cls !== 'terminal') {
              settlementAttemptsTotal.inc({ direction, failure_category: cls });
            }
            return cls;
          },
          maxAttempts,
          baseDelayMs,
          maxDelayMs: this.defaultMaxDelayMs,
          note: `orderId=${orderId}`,
        },
      );

      const finalRecord = this.store.get(orderId);
      if (finalRecord && finalRecord.state === 'pending_submission') {
        // Engine succeeded but ackSubmission wasn't called (shouldn't happen,
        // but be defensive).
        this.store.ackSubmission(orderId, txHash);
      }

      settlementDurationSeconds.observe(
        { direction, outcome: 'success' },
        (Date.now() - startedAt) / 1000,
      );
      this._updateStateGauge();

      if (opts.contractKey) {
        this.contractKeyIndex.set(opts.contractKey, orderId);
      }

      return { txHash, attempts, lastFaultClass: attempts > 1 ? lastFaultClass : undefined };
    } catch (err) {
      // Classify the final error to label the failure metric.
      let failureCategory: FaultClass = 'unknown' as FaultClass;
      if (err instanceof RetryExhaustedError) {
        failureCategory = err.faultClass;
      } else if (err instanceof CircuitOpenError) {
        failureCategory = 'transient';
      } else {
        failureCategory = defaultClassifier(err);
      }

      // Mark record terminal unless it already moved on (e.g. concurrent reconcile).
      const current = this.store.get(orderId);
      if (current && !isTerminalState(current.state)) {
        try {
          this.store.markFailed(
            orderId,
            err instanceof Error ? err.message : String(err),
          );
        } catch {
          // Ignore transition errors from concurrent state changes.
        }
      }

      settlementFailuresTotal.inc({ direction, failure_category: failureCategory });
      settlementDurationSeconds.observe(
        { direction, outcome: 'failure' },
        (Date.now() - startedAt) / 1000,
      );
      this._updateStateGauge();

      throw new SettlementError(
        orderId,
        err instanceof Error ? err.message : String(err),
        failureCategory,
        attempts,
        err,
      );
    }
  }

  /**
   * Record that the coordinator has acknowledged the settlement.
   * Advances the TxStateRecord from chain_mined → coordinator_recorded.
   */
  recordCoordinatorAck(orderId: string, coordinatorRef: string): void {
    try {
      this.store.recordCoordinatorAck(orderId, coordinatorRef);
      this._updateStateGauge();
    } catch {
      // Idempotent — ignore if already advanced.
    }
  }

  /**
   * Record the chain receipt for an order.
   * Advances the record from submission_acked → chain_mined.
   * Returns false if the receipt is a duplicate (already recorded).
   */
  recordReceipt(
    orderId: string,
    receipt: Parameters<TxStateStore['recordReceipt']>[1],
  ): boolean {
    try {
      const { accepted } = this.store.recordReceipt(orderId, receipt);
      if (accepted) this._updateStateGauge();
      return accepted;
    } catch {
      return false;
    }
  }

  /**
   * Mark a settlement as complete (terminal success).
   */
  markComplete(orderId: string): void {
    try {
      this.store.markComplete(orderId);
      this._updateStateGauge();
    } catch {
      // Already complete or terminal — no-op.
    }
  }

  /**
   * Retrieve the current settlement record for an order.
   */
  getStatus(orderId: string): TxStateRecord | undefined {
    return this.store.get(orderId);
  }

  /**
   * All records in a given state.
   */
  byState(state: Parameters<TxStateStore['byState']>[0]): TxStateRecord[] {
    return this.store.byState(state);
  }

  /**
   * Snapshot of all records — for the status endpoint.
   */
  snapshot(): TxStateRecord[] {
    return this.store.snapshot();
  }

  /**
   * State counts — for dashboards.
   */
  stateCounts(): ReturnType<TxStateStore['stateCounts']> {
    return this.store.stateCounts();
  }

  /**
   * Reconcile in-flight records.
   *
   * Walks all non-terminal records and attempts to advance them:
   *   - pending_submission: mark terminal_failure if timeout expired.
   *   - submission_acked: query provider for receipt.
   *   - chain_mined: log warning (coordinator notification needed externally).
   *   - coordinator_recorded: advance to complete.
   *
   * @param provider  Chain provider for receipt lookups (null = skip chain queries).
   * @param trigger   'startup' | 'scheduled' | 'manual'
   * @param direction Optional direction label for metrics (e.g. 'xlm_to_eth').
   */
  async reconcile(
    provider: ChainProvider | null,
    trigger: 'startup' | 'scheduled' | 'manual' = 'scheduled',
    direction = 'all',
  ): Promise<ReconcileSummary> {
    settlementRecoveryTotal.inc({ direction, trigger });
    const summary = await this.store.reconcile(provider, trigger);
    this._updateStateGauge();
    return summary;
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  private _updateStateGauge(): void {
    const counts = this.store.stateCounts();
    for (const [state, count] of Object.entries(counts)) {
      settlementStateGauge.set({ state }, count);
    }
  }
}

// ---------------------------------------------------------------------------
// SettlementError
// ---------------------------------------------------------------------------

/**
 * Thrown by `SettlementService.settle()` when a settlement permanently fails.
 *
 * Properties:
 *   orderId       — the order that failed
 *   faultCategory — classification of the failure (transient / terminal / etc.)
 *   attempts      — how many attempts were made before giving up
 *   cause         — the original underlying error
 */
export class SettlementError extends Error {
  readonly orderId: string;
  readonly faultCategory: FaultClass | 'unknown';
  readonly attempts: number;
  readonly cause: unknown;

  constructor(
    orderId: string,
    message: string,
    faultCategory: FaultClass | 'unknown',
    attempts: number,
    cause?: unknown,
  ) {
    super(`[settlement] orderId=${orderId}: ${message}`);
    this.name = 'SettlementError';
    this.orderId = orderId;
    this.faultCategory = faultCategory;
    this.attempts = attempts;
    this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// Process-wide singleton
// ---------------------------------------------------------------------------

/**
 * Process-wide SettlementService singleton.
 * In tests, create isolated instances with `storageDir: null`.
 */
export const globalSettlementService = new SettlementService();
