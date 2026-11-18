/**
 * @file idempotency.ts
 *
 * Idempotent action tracking for relayer recovery operations.
 *
 * Problem
 * -------
 * Recovery operations (claims, refunds) can be retried due to:
 *   - Network timeouts
 *   - Process restarts
 *   - Event re-delivery
 *
 * Without idempotency tracking, retries can:
 *   - Submit duplicate transactions to the chain
 *   - Process the same order twice
 *   - Create overfunding or incorrect state
 *
 * Solution
 * --------
 * IdempotencyManager tracks actions by a composite key (orderId + actionType)
 * and provides:
 *   - In-memory deduplication within a process lifetime
 *   - Persistent state across restarts (disk-backed)
 *   - Safe retry for known network failures
 *   - Recovery after crashes without duplicate submission
 *
 * Usage
 * -----
 * ```ts
 * const manager = new IdempotencyManager();
 *
 * // Check if action was already attempted
 * const existing = manager.get('order-123', 'claim');
 *
 * // If not, record attempt
 * const attemptId = manager.record('order-123', 'claim', 'attempt-1');
 *
 * // Later, if it succeeds
 * manager.complete('order-123', 'claim', attemptId, { txHash: '0x...' });
 *
 * // On recovery, check persisted state
 * await manager.reconcile();
 * ```
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  unlinkSync,
  renameSync,
} from 'fs';
import { join } from 'path';
import { getLogger } from './logger.js';
import { correlationLog } from './correlation/correlation-context.js';

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Valid action types for idempotency tracking.
 */
export type IdempotentActionType =
  | 'claim'
  | 'refund'
  | 'create_escrow'
  | 'reveal_preimage'
  | 'register_resolver'
  | 'increase_stake';

/**
 * Idempotency attempt state.
 */
export type AttemptState =
  | 'pending'           // Attempt recorded, not yet submitted
  | 'submitted'         // Transaction submitted, waiting for receipt
  | 'completed'         // Successfully completed
  | 'failed'            // Permanently failed
  | 'abandoned'         // Abandoned by operator

/**
 * Single action record.
 */
export interface IdempotentActionRecord {
  /** Composite key: orderId + actionType */
  key: string;

  /** Stable order identifier. */
  orderId: string;

  /** Action type (claim, refund, etc.). */
  actionType: IdempotentActionType;

  /** Current attempt state. */
  state: AttemptState;

  /** Unique attempt identifier. */
  attemptId: string;

  /** Transaction hash if submitted. */
  txHash?: string;

  /** Block number if mined. */
  minedBlock?: number;

  /** Failure reason if failed. */
  failureReason?: string;

  /** Number of retry attempts made. */
  retryCount: number;

  /** Timestamp when record was created. */
  createdAt: number;

  /** Timestamp of last update. */
  updatedAt: number;

  /** Correlation ID for tracing. */
  correlationId?: string;
}

/**
 * Recovery context for an action.
 */
export interface RecoveryContext {
  /** Original attempt that needs recovery. */
  originalAttemptId: string;

  /** Order ID being recovered. */
  orderId: string;

  /** Action type being recovered. */
  actionType: IdempotentActionType;

  /** Current state at time of recovery. */
  state: AttemptState;

  /** Whether this can be safely retried. */
  canRetry: boolean;

  /** Reason why this can or cannot be retried. */
  retryReason?: string;
}

// ── Error types ───────────────────────────────────────────────────────────────

export class IdempotencyError extends Error {
  constructor(
    public readonly orderId: string,
    public readonly actionType: IdempotentActionType,
    message: string,
    public readonly code?: string,
  ) {
    super(`[idempotency] orderId=${orderId}, action=${actionType}: ${message}`);
    this.name = 'IdempotencyError';
  }
}

// ── IdempotencyManager ────────────────────────────────────────────────────────

/**
 * Manages idempotent action tracking for relayer recovery operations.
 */
export class IdempotencyManager {
  private readonly records = new Map<string, IdempotentActionRecord>();
  private readonly storageDir: string | null;
  private readonly maxRetryCount: number;
  private readonly pendingTimeoutMs: number;

  constructor(opts: {
    storageDir?: string | null;
    maxRetryCount?: number;
    pendingTimeoutMs?: number;
  } = {}) {
    this.storageDir = opts.storageDir ?? join(process.cwd(), '.idempotency-store');
    this.maxRetryCount = opts.maxRetryCount ?? 10;
    this.pendingTimeoutMs = opts.pendingTimeoutMs ?? 15 * 60 * 1000; // 15 min

    if (this.storageDir && !existsSync(this.storageDir)) {
      mkdirSync(this.storageDir, { recursive: true });
    }
    this._loadFromDisk();
  }

  // ── Core API ────────────────────────────────────────────────────────────────

  /**
   * Get an existing record by orderId and actionType.
   */
  get(orderId: string, actionType: IdempotentActionType): IdempotentActionRecord | undefined {
    const key = this._makeKey(orderId, actionType);
    return this.records.get(key);
  }

  /**
   * Check if an action has already been attempted (any state).
   */
  hasAttempted(orderId: string, actionType: IdempotentActionType): boolean {
    return this.records.has(this._makeKey(orderId, actionType));
  }

  /**
   * Record a new attempt for an action.
   *
   * Returns the attempt record. If a previous attempt exists and has a txHash,
   * returns that instead (idempotency guard).
   *
   * @param orderId - Order being acted on
   * @param actionType - Type of action (claim, refund, etc.)
   * @param correlationId - For tracing
   * @param forceNew - Create new attempt even if one exists (for testing)
   */
  record(
    orderId: string,
    actionType: IdempotentActionType,
    correlationId?: string,
    forceNew: boolean = false,
  ): IdempotentActionRecord {
    const key = this._makeKey(orderId, actionType);
    const existing = this.records.get(key);

    if (existing && !forceNew) {
      // If already submitted, return existing (idempotency)
      if (existing.state === 'submitted' && existing.txHash) {
        return existing;
      }

      // If already completed or failed, throw
      if (existing.state === 'completed' || existing.state === 'failed') {
        throw new IdempotencyError(
          orderId,
          actionType,
          `Action already ${existing.state}`,
          'ALREADY_COMPLETED',
        );
      }

      // If pending, increment retry count
      if (existing.state === 'pending') {
        existing.retryCount++;
        existing.updatedAt = Date.now();
        this._persist(existing);
        return existing;
      }
    }

    // Create new attempt
    const attemptId = this._generateAttemptId();
    const now = Date.now();
    const record: IdempotentActionRecord = {
      key,
      orderId,
      actionType,
      state: 'pending',
      attemptId,
      retryCount: 0,
      createdAt: now,
      updatedAt: now,
      correlationId,
    };

    this.records.set(key, record);
    this._persist(record);
    return record;
  }

  /**
   * Mark an action as submitted (tx broadcast).
   */
  submitted(
    orderId: string,
    actionType: IdempotentActionType,
    txHash: string,
  ): IdempotentActionRecord {
    const record = this._getOrThrow(orderId, actionType);
    return this._update(record, 'submitted', { txHash });
  }

  /**
   * Mark an action as completed (tx mined and processed).
   */
  complete(
    orderId: string,
    actionType: IdempotentActionType,
    txHash: string,
    minedBlock?: number,
  ): IdempotentActionRecord {
    const record = this._getOrThrow(orderId, actionType);
    return this._update(record, 'completed', { txHash, minedBlock });
  }

  /**
   * Mark an action as failed.
   */
  fail(
    orderId: string,
    actionType: IdempotentActionType,
    reason: string,
    isTerminal: boolean = false,
  ): IdempotentActionRecord {
    const record = this._getOrThrow(orderId, actionType);
    const newState = isTerminal ? 'failed' : 'abandoned';
    return this._update(record, newState, { failureReason: reason });
  }

  /**
   * Check if an action can be retried safely.
   */
  canRetry(orderId: string, actionType: IdempotentActionType): boolean {
    const record = this.records.get(this._makeKey(orderId, actionType));
    if (!record) return true;

    // Can retry if pending or abandoned
    if (record.state === 'pending' || record.state === 'abandoned') {
      return record.retryCount < this.maxRetryCount;
    }

    // Can retry if submitted but not confirmed (network timeout scenario)
    if (record.state === 'submitted' && !record.minedBlock) {
      const age = Date.now() - record.updatedAt;
      return age < this.pendingTimeoutMs;
    }

    // Cannot retry if completed or failed
    return false;
  }

  /**
   * Get recovery context for an action.
   */
  getRecoveryContext(orderId: string, actionType: IdempotentActionType): RecoveryContext {
    const record = this.records.get(this._makeKey(orderId, actionType));
    if (!record) {
      return {
        originalAttemptId: '',
        orderId,
        actionType,
        state: 'pending',
        canRetry: true,
        retryReason: 'No previous attempt found, safe to start new attempt',
      };
    }

    const now = Date.now();

    switch (record.state) {
      case 'completed':
        return {
          originalAttemptId: record.attemptId,
          orderId: record.orderId,
          actionType: record.actionType,
          state: record.state,
          canRetry: false,
          retryReason: 'Action already completed successfully',
        };

      case 'failed':
        return {
          originalAttemptId: record.attemptId,
          orderId: record.orderId,
          actionType: record.actionType,
          state: record.state,
          canRetry: false,
          retryReason: `Action failed permanently: ${record.failureReason}`,
        };

      case 'pending':
        return {
          originalAttemptId: record.attemptId,
          orderId: record.orderId,
          actionType: record.actionType,
          state: record.state,
          canRetry: record.retryCount < this.maxRetryCount,
          retryReason: record.retryCount < this.maxRetryCount
            ? `Retry attempt ${record.retryCount + 1}/${this.maxRetryCount}`
            : `Max retries (${this.maxRetryCount}) exceeded`,
        };

      case 'submitted':
        if (record.minedBlock) {
          return {
            originalAttemptId: record.attemptId,
            orderId: record.orderId,
            actionType: record.actionType,
            state: record.state,
            canRetry: false,
            retryReason: 'Transaction already mined',
          };
        }

        // Check if pending submission has timed out
        const age = now - record.updatedAt;
        if (age > this.pendingTimeoutMs) {
          return {
            originalAttemptId: record.attemptId,
            orderId: record.orderId,
            actionType: record.actionType,
            state: record.state,
            canRetry: true,
            retryReason: 'Submission pending too long, safe to retry',
          };
        }

        return {
          originalAttemptId: record.attemptId,
          orderId: record.orderId,
          actionType: record.actionType,
          state: record.state,
          canRetry: true,
          retryReason: `Submission pending ${Math.round(age / 1000)}s, safe to retry`,
        };

      case 'abandoned':
        return {
          originalAttemptId: record.attemptId,
          orderId: record.orderId,
          actionType: record.actionType,
          state: record.state,
          canRetry: record.retryCount < this.maxRetryCount,
          retryReason: `Abandoned attempt, ${record.retryCount}/${this.maxRetryCount} retries`,
        };
    }
  }

  // ── Recovery API ────────────────────────────────────────────────────────────

  /**
   * Reconcile all records after restart.
   *
   * Call this at startup to recover state from disk.
   */
  async reconcile(): Promise<ReconcileResult> {
    const result: ReconcileResult = {
      scanned: 0,
      recovered: 0,
      failed: 0,
      skipped: 0,
      startedAt: Date.now(),
    };

    for (const record of this.records.values()) {
      result.scanned++;

      // Skip completed records
      if (record.state === 'completed') {
        result.skipped++;
        continue;
      }

      // Check for stale pending submissions
      if (record.state === 'pending') {
        const age = Date.now() - record.createdAt;
        if (age > this.pendingTimeoutMs) {
          record.state = 'abandoned';
          record.updatedAt = Date.now();
          this._persist(record);
          this._log('warn', 'stale pending submission marked abandoned', record);
          result.failed++;
          continue;
        }
      }

      // Check for stale submitted records
      if (record.state === 'submitted' && !record.minedBlock) {
        const age = Date.now() - record.updatedAt;
        if (age > this.pendingTimeoutMs) {
          record.state = 'abandoned';
          record.updatedAt = Date.now();
          this._persist(record);
          this._log('warn', 'stale submitted transaction marked abandoned', record);
          result.failed++;
          continue;
        }
      }

      result.recovered++;
    }

    return result;
  }

  /**
   * Get all records in a given state.
   */
  byState(state: AttemptState): IdempotentActionRecord[] {
    return Array.from(this.records.values()).filter(r => r.state === state);
  }

  /**
   * Get all records for an order.
   */
  byOrderId(orderId: string): IdempotentActionRecord[] {
    return Array.from(this.records.values()).filter(r => r.orderId === orderId);
  }

  /**
   * Get counts per state.
   */
  stateCounts(): Record<AttemptState, number> {
    const counts: Record<AttemptState, number> = {
      pending: 0,
      submitted: 0,
      completed: 0,
      failed: 0,
      abandoned: 0,
    };
    for (const record of this.records.values()) {
      counts[record.state]++;
    }
    return counts;
  }

  /**
   * Remove a record (for cleanup).
   */
  remove(orderId: string, actionType: IdempotentActionType): void {
    const key = this._makeKey(orderId, actionType);
    this.records.delete(key);
    this._deletePersisted(key);
  }

  /**
   * Clear all records (for testing).
   */
  clear(): void {
    this.records.clear();
    if (this.storageDir && existsSync(this.storageDir)) {
      for (const file of readdirSync(this.storageDir)) {
        unlinkSync(join(this.storageDir, file));
      }
    }
  }

  // ── Internal helpers ────────────────────────────────────────────────────────

  private _makeKey(orderId: string, actionType: IdempotentActionType): string {
    return `${orderId}:${actionType}`;
  }

  private _generateAttemptId(): string {
    return `attempt-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
  }

  private _getOrThrow(orderId: string, actionType: IdempotentActionType): IdempotentActionRecord {
    const key = this._makeKey(orderId, actionType);
    const record = this.records.get(key);
    if (!record) {
      throw new IdempotencyError(orderId, actionType, 'No record found', 'NOT_FOUND');
    }
    return record;
  }

  private _update(
    record: IdempotentActionRecord,
    newState: AttemptState,
    patch: Partial<IdempotentActionRecord>,
  ): IdempotentActionRecord {
    record.state = newState;
    record.updatedAt = Date.now();
    if (patch.txHash !== undefined) record.txHash = patch.txHash;
    if (patch.minedBlock !== undefined) record.minedBlock = patch.minedBlock;
    if (patch.failureReason !== undefined) record.failureReason = patch.failureReason;

    this._persist(record);
    this._log('info', `state: ${record.state} → ${newState}`, record);
    return record;
  }

  private _persist(record: IdempotentActionRecord): void {
    if (!this.storageDir) return;
    const payload = { ...record, savedAt: Date.now() };
    const fpath = this._filePath(record.key);
    const tmp = fpath + '.tmp';
    try {
      writeFileSync(tmp, JSON.stringify(payload), 'utf-8');
      renameSync(tmp, fpath);
    } catch (err) {
      this._log('warn', 'failed to persist record', record, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private _deletePersisted(key: string): void {
    if (!this.storageDir) return;
    const fpath = this._filePath(key);
    try {
      if (existsSync(fpath)) unlinkSync(fpath);
    } catch { /* best-effort */ }
  }

  private _filePath(key: string): string {
    // key is orderId:actionType - make it safe for filesystem
    const safe = key.replace(/[^a-zA-Z0-9_\-]/g, '_').substring(0, 100);
    return join(this.storageDir!, `${safe}.json`);
  }

  private _loadFromDisk(): void {
    if (!this.storageDir || !existsSync(this.storageDir)) return;

    try {
      for (const file of readdirSync(this.storageDir)) {
        if (!file.endsWith('.json')) continue;
        const fpath = join(this.storageDir, file);
        try {
          const raw = readFileSync(fpath, 'utf-8');
          const persisted = JSON.parse(raw) as IdempotentActionRecord;
          if (persisted && persisted.key && !this.records.has(persisted.key)) {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const { savedAt: _savedAt, ...record } = persisted;
            this.records.set(record.key, record);
          }
        } catch {
          // Corrupted file - skip
          this._log('warn', 'skipping corrupted idempotency record', undefined, { file });
        }
      }
    } catch {
      // Directory read error - skip
    }
  }

  private _log(
    level: 'info' | 'warn' | 'error',
    msg: string,
    record: IdempotentActionRecord | undefined,
    extra?: Record<string, unknown>,
  ): void {
    const fields: Record<string, unknown> = { ...extra };
    if (record) {
      fields.orderId = record.orderId;
      fields.actionType = record.actionType;
      fields.state = record.state;
      fields.attemptId = record.attemptId;
    }
    getLogger()[level](fields, msg);

    correlationLog(level, msg, fields);
  }
}

// ── Recovery result ───────────────────────────────────────────────────────────

export interface ReconcileResult {
  scanned: number;
  recovered: number;
  failed: number;
  skipped: number;
  startedAt: number;
}

// ── IdempotencyGuard ──────────────────────────────────────────────────────────

/**
 * Guard that ensures only safe operations are performed based on idempotency state.
 */
export class IdempotencyGuard {
  private readonly manager: IdempotencyManager;

  constructor(manager: IdempotencyManager) {
    this.manager = manager;
  }

  /**
   * Assert that an action can be attempted.
   * Throws if the action has already been completed or failed permanently.
   */
  assertCanAttempt(orderId: string, actionType: IdempotentActionType): void {
    const existing = this.manager.get(orderId, actionType);

    if (existing) {
      if (existing.state === 'completed') {
        throw new IdempotencyError(
          orderId,
          actionType,
          `Action already completed`,
          'ALREADY_COMPLETED',
        );
      }

      if (existing.state === 'failed') {
        throw new IdempotencyError(
          orderId,
          actionType,
          `Action permanently failed: ${existing.failureReason}`,
          'PERMANENTLY_FAILED',
        );
      }
    }
  }

  /**
   * Assert that an action can be retried.
   */
  assertCanRetry(orderId: string, actionType: IdempotentActionType): void {
    if (!this.manager.canRetry(orderId, actionType)) {
      const context = this.manager.getRecoveryContext(orderId, actionType);
      throw new IdempotencyError(
        orderId,
        actionType,
        `Cannot retry: ${context.retryReason}`,
        'CANNOT_RETRY',
      );
    }
  }

  /**
   * Assert that an action has been completed.
   */
  assertCompleted(orderId: string, actionType: IdempotentActionType): void {
    const record = this.manager.get(orderId, actionType);
    if (!record || record.state !== 'completed') {
      throw new IdempotencyError(
        orderId,
        actionType,
        `Action not completed`,
        'NOT_COMPLETED',
      );
    }
  }

  /**
   * Assert that an action has been submitted (tx broadcast).
   */
  assertSubmitted(orderId: string, actionType: IdempotentActionType): void {
    const record = this.manager.get(orderId, actionType);
    if (!record || record.state !== 'submitted' || !record.txHash) {
      throw new IdempotencyError(
        orderId,
        actionType,
        `Action not submitted`,
        'NOT_SUBMITTED',
      );
    }
  }
}
