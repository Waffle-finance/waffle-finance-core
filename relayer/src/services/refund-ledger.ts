/**
 * RefundLedger — idempotency store for XLM refunds.
 *
 * Problem it solves
 * -----------------
 * Three code paths can trigger a refund for the same order:
 *  1. Inline handler in /api/orders/xlm-to-eth (ETH send failed → immediate refund)
 *  2. /api/orders/manual-refund (user-initiated retry)
 *  3. Background refund watchdog (rescues orders the user never retried)
 *
 * Without a shared gate, a race between any two paths could submit two Stellar
 * payments for the same original XLM payment — i.e. the relayer pays out twice.
 *
 * How it works
 * ------------
 * Each refund attempt is keyed by `orderId`. Before any caller submits to
 * Horizon it MUST call `claim(orderId)`. Only the first caller receives `true`;
 * every subsequent caller receives `false` (already claimed). When the Stellar
 * submit returns:
 *
 *   SUCCESS  → call `commit(orderId, result)` — persists the txHash.
 *   FAILURE  → call `release(orderId)` — removes the in-flight marker so the
 *              next retry can try again. Horizon 504/timeout MUST NOT be
 *              released — call `markAmbiguous` instead and let the watchdog
 *              resolve on the next tick.
 *
 * All mutations are synchronous within the event loop, so the claim →
 * submit → commit/release sequence is safe without an async mutex.
 *
 * Persistence
 * -----------
 * Entries are written to disk atomically (tmp-file + rename) so that
 * `pending` and `ambiguous` state survives a process restart. On startup
 * the watchdog loads the persisted ledger and resumes where it left off.
 *
 * Only `committed` and `ambiguous` states are persisted; `in_flight` entries
 * are ephemeral — a crash during an in-flight submission is indistinguishable
 * from "never attempted", so we allow the next process to re-claim.
 *
 * Storage format: one JSON file per orderId under `storageDir`.
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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RefundState =
  | { phase: 'in_flight' }
  | { phase: 'committed'; txHash: string; amount: string; ledger?: number; committedAt: number }
  | { phase: 'ambiguous'; reason: string; ambiguousAt: number };

export interface RefundEntry {
  orderId: string;
  state: RefundState;
}

/** Subset of states that are persisted to disk. */
type PersistedState =
  | { phase: 'committed'; txHash: string; amount: string; ledger?: number; committedAt: number }
  | { phase: 'ambiguous'; reason: string; ambiguousAt: number };

interface PersistedRecord {
  orderId: string;
  state: PersistedState;
  savedAt: number;
}

export interface RefundLedgerOptions {
  /**
   * Directory where per-order JSON files are written.
   * Defaults to `<cwd>/.refund-ledger`.
   * Pass `null` to disable persistence (useful in tests).
   */
  storageDir?: string | null;
}

// ---------------------------------------------------------------------------
// RefundLedger
// ---------------------------------------------------------------------------

export class RefundLedger {
  private readonly entries = new Map<string, RefundEntry>();
  private readonly storageDir: string | null;

  constructor(options: RefundLedgerOptions = {}) {
    if (options.storageDir === null) {
      this.storageDir = null;
    } else {
      this.storageDir = options.storageDir ?? join(process.cwd(), '.refund-ledger');
      this._ensureDir();
      this._loadFromDisk();
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Atomically claim the right to refund `orderId`.
   *
   * Returns `true` if the claim was granted (this caller may proceed).
   * Returns `false` if the order is already in-flight, committed, or ambiguous.
   *
   * When `false` is returned, inspect `getEntry(orderId)` for details.
   */
  claim(orderId: string): boolean {
    if (this.entries.has(orderId)) return false;
    this.entries.set(orderId, { orderId, state: { phase: 'in_flight' } });
    // in_flight is not persisted — ephemeral within this process lifetime.
    return true;
  }

  /**
   * Finalise a successful refund. Idempotent — subsequent calls with the same
   * orderId are no-ops that preserve the first committed result.
   */
  commit(orderId: string, result: { txHash: string; amount: string; ledger?: number }): void {
    const existing = this.entries.get(orderId);
    // Already committed — keep the first result, do not overwrite.
    if (existing?.state.phase === 'committed') return;

    const state: RefundState = {
      phase: 'committed',
      txHash: result.txHash,
      amount: result.amount,
      ledger: result.ledger,
      committedAt: Date.now(),
    };
    this.entries.set(orderId, { orderId, state });
    this._persist(orderId, state as PersistedState);
  }

  /**
   * Release a failed claim so the next retry can try again.
   * Only releases `in_flight` entries; committed and ambiguous are left intact.
   */
  release(orderId: string): void {
    const entry = this.entries.get(orderId);
    if (entry?.state.phase === 'in_flight') {
      this.entries.delete(orderId);
      // in_flight was never persisted — nothing to delete on disk.
    }
  }

  /**
   * Mark an entry as ambiguous — the submit timed out or received a 504, so
   * the transaction may or may not have landed. The watchdog will re-check
   * on-chain state before attempting a new submission.
   */
  markAmbiguous(orderId: string, reason: string): void {
    const state: RefundState = {
      phase: 'ambiguous',
      reason,
      ambiguousAt: Date.now(),
    };
    this.entries.set(orderId, { orderId, state });
    this._persist(orderId, state as PersistedState);
  }

  /**
   * Promote an ambiguous entry to committed once the watchdog confirms a
   * refund landed on-chain.
   */
  resolveAmbiguous(
    orderId: string,
    result: { txHash: string; amount: string; ledger?: number }
  ): void {
    const entry = this.entries.get(orderId);
    if (entry?.state.phase !== 'ambiguous') return;
    this.commit(orderId, result);
  }

  /**
   * Clear an ambiguous entry so the watchdog can retry submitting.
   * Call only after confirming the original tx is NOT on-chain.
   */
  releaseAmbiguous(orderId: string): void {
    const entry = this.entries.get(orderId);
    if (entry?.state.phase === 'ambiguous') {
      this.entries.delete(orderId);
      this._deletePersisted(orderId);
    }
  }

  /** Retrieve the current state for an order, or undefined if unknown. */
  getEntry(orderId: string): RefundEntry | undefined {
    return this.entries.get(orderId);
  }

  /** True if the order is already committed (successful refund recorded). */
  isCommitted(orderId: string): boolean {
    return this.entries.get(orderId)?.state.phase === 'committed';
  }

  /** True if a refund attempt is currently in-flight or ambiguous. */
  isLocked(orderId: string): boolean {
    const phase = this.entries.get(orderId)?.state.phase;
    return phase === 'in_flight' || phase === 'ambiguous';
  }

  /** Snapshot of all entries — useful for health endpoints and tests. */
  snapshot(): RefundEntry[] {
    return Array.from(this.entries.values());
  }

  /** Count of entries in each phase — for metrics / debugging. */
  stats(): Record<RefundState['phase'], number> {
    const counts: Record<RefundState['phase'], number> = {
      in_flight: 0,
      committed: 0,
      ambiguous: 0,
    };
    for (const { state } of this.entries.values()) {
      counts[state.phase]++;
    }
    return counts;
  }

  // ── Persistence helpers ───────────────────────────────────────────────────

  private _ensureDir(): void {
    if (this.storageDir && !existsSync(this.storageDir)) {
      mkdirSync(this.storageDir, { recursive: true });
    }
  }

  private _filePath(orderId: string): string {
    // Sanitise orderId so it is safe to use as a filename.
    const safe = orderId.replace(/[^a-zA-Z0-9_\-]/g, '_');
    return join(this.storageDir!, `${safe}.json`);
  }

  /** Atomically write a persisted state (tmp + rename). */
  private _persist(orderId: string, state: PersistedState): void {
    if (!this.storageDir) return;
    const record: PersistedRecord = { orderId, state, savedAt: Date.now() };
    const fpath = this._filePath(orderId);
    const tmp = fpath + '.tmp';
    try {
      writeFileSync(tmp, JSON.stringify(record), 'utf-8');
      renameSync(tmp, fpath);
    } catch (err) {
      // Non-fatal — in-memory state is authoritative; disk is best-effort.
      process.stderr.write(
        JSON.stringify({
          level: 'warn',
          msg: '[refund-ledger] failed to persist entry',
          orderId,
          error: err instanceof Error ? err.message : String(err),
        }) + '\n'
      );
    }
  }

  /** Remove a persisted file for an orderId. */
  private _deletePersisted(orderId: string): void {
    if (!this.storageDir) return;
    const fpath = this._filePath(orderId);
    try {
      if (existsSync(fpath)) unlinkSync(fpath);
    } catch {
      /* best-effort */
    }
  }

  /**
   * Load all persisted entries from disk on startup.
   * `in_flight` entries are never persisted, so only `committed` and
   * `ambiguous` records will be found here.
   */
  private _loadFromDisk(): void {
    if (!this.storageDir || !existsSync(this.storageDir)) return;

    let files: string[];
    try {
      files = readdirSync(this.storageDir).filter(
        (f) => f.endsWith('.json') && !f.endsWith('.tmp')
      );
    } catch {
      return;
    }

    for (const file of files) {
      const fpath = join(this.storageDir, file);
      try {
        const raw = readFileSync(fpath, 'utf-8');
        const record: PersistedRecord = JSON.parse(raw);
        if (
          record &&
          typeof record.orderId === 'string' &&
          record.state &&
          (record.state.phase === 'committed' || record.state.phase === 'ambiguous')
        ) {
          // Do not overwrite an entry that was already set in-memory
          // (shouldn't happen at startup, but be defensive).
          if (!this.entries.has(record.orderId)) {
            this.entries.set(record.orderId, {
              orderId: record.orderId,
              state: record.state,
            });
          }
        }
      } catch {
        // Corrupted file — skip; the watchdog will retry that order.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Process-wide singleton
// ---------------------------------------------------------------------------

/**
 * Process-wide singleton. Import this wherever a refund is initiated.
 *
 * In tests, create a fresh instance with `storageDir: null` per suite:
 *   const ledger = new RefundLedger({ storageDir: null });
 */
export const globalRefundLedger = new RefundLedger();
