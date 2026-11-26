/**
 * @fileoverview Durable recovery-job persistence for the relayer (#1083).
 *
 * Problem
 * -------
 * The relayer recovery service kept its in-flight recovery/refund jobs only
 * in memory. A restart lost that work, so orders that were eligible for a
 * recovery action could be left unprocessed after an outage.
 *
 * Solution
 * --------
 * `RecoveryJobStore` persists recovery-job state to disk so a restart can
 * resume eligible unfinished work. It follows the same atomic-write pattern
 * used by the relayer's `IdempotencyManager` and `TxStateStore`: write to a
 * `.tmp` file then rename, so a crash mid-write never leaves a half record.
 *
 * Privacy
 * -------
 * The persisted record carries a *redacted* order snapshot so the job can be
 * retried after a restart, but it never stores a preimage or signing-key
 * material. {@link redactRecoveryOrder} recursively strips keys whose names
 * look like secrets (preimage, secret, private key, signing key, seed,
 * mnemonic) from the order's metadata before it is written to disk.
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
import { getLogger } from '../../logger.js';
import type {
  ChainType,
  RecoveryOrder,
  RecoveryRequest,
  RecoveryStatus,
  RecoveryType,
} from './IRecoveryService.js';

const log = getLogger().child({ component: 'recovery-job-store' });

/**
 * Keys whose presence anywhere in an order's metadata is treated as secret.
 * Matched case-insensitively against the full key name so `preimageHash` is
 * safe to keep (it is a hash, not the preimage) while `preimage` is stripped.
 */
const SECRET_KEY_PATTERN =
  /^(preimage|secret|privatekey|private_key|privatekey$|signingkey|signing_key|signerkey|seed|mnemonic|secretkey|secret_key)$/i;

/**
 * States after which a recovery job will not be resumed automatically.
 * `failed` is NOT in this set: a failed job that still has a scheduled retry
 * (`nextAttemptAt != null`) remains eligible to resume.
 */
const TERMINAL_JOB_STATES: ReadonlySet<RecoveryStatus> = new Set<RecoveryStatus>([
  'completed',
  'cancelled',
  'requires_review',
]);

// ── Redaction ─────────────────────────────────────────────────────────────────

/**
 * Deep-clone a value and drop any key whose name looks like a secret.
 * Arrays are recursed element-wise; primitives pass through unchanged.
 */
export function redactSecrets<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redactSecrets) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_PATTERN.test(k)) continue;
    out[k] = redactSecrets(v);
  }
  return out as unknown as T;
}

/**
 * Return a copy of `order` with secret-looking keys removed from its
 * `metadata` (recursively). Non-metadata fields are preserved as-is — they
 * are identifiers and on-chain coordinates (orderId, hash, chains, amounts,
 * timelocks) needed to retry a refund.
 */
export function redactRecoveryOrder(order: RecoveryOrder): RecoveryOrder {
  const clone: RecoveryOrder = { ...order };
  if (clone.metadata) {
    clone.metadata = redactSecrets(clone.metadata) as Record<string, unknown>;
  }
  return clone;
}

/**
 * True when a persisted recovery job is still eligible to be resumed after a
 * restart. A job is eligible unless it reached a terminal state OR it is
 * `failed` with no scheduled retry (the retry budget is exhausted).
 */
export function isJobEligibleToResume(
  status: RecoveryStatus,
  nextAttemptAt: number | null,
): boolean {
  if (TERMINAL_JOB_STATES.has(status)) return false;
  if (status === 'failed') return nextAttemptAt !== null;
  // pending / in_progress are eligible.
  return true;
}

// ── Persisted record ─────────────────────────────────────────────────────────

/**
 * The on-disk shape of a recovery job. Mirrors {@link RecoveryRequest} plus a
 * redacted order snapshot; never contains preimage or signing-key material.
 */
export interface PersistedRecoveryJob {
  id: string;
  orderId: string;
  orderHash: string;
  type: RecoveryType;
  status: RecoveryStatus;
  chain: ChainType | 'unknown';
  initiator: string;
  reason: string;
  metadata: RecoveryRequest['metadata'];
  createdAt: number;
  updatedAt: number;
  attempts: number;
  lastAttemptAt: number | null;
  nextAttemptAt: number | null;
  /** Redacted order snapshot needed to retry the recovery action. */
  order: RecoveryOrder;
  savedAt: number;
}

// ── RecoveryJobStore ──────────────────────────────────────────────────────────

export interface RecoveryJobStoreOptions {
  /**
   * Directory used for durable backing. Pass `null` for an in-memory-only
   * store (the default) so tests stay hermetic.
   */
  storageDir?: string | null;
}

/**
 * Durable, privacy-safe persistence for relayer recovery jobs.
 *
 * Default construction is in-memory only. Pass a `storageDir` to enable
 * cross-restart persistence.
 */
export class RecoveryJobStore {
  private readonly storageDir: string | null;
  /** In-memory mirror used when storageDir is null, and as a cache otherwise. */
  private readonly records = new Map<string, PersistedRecoveryJob>();

  constructor(opts: RecoveryJobStoreOptions = {}) {
    this.storageDir = opts.storageDir === undefined ? null : opts.storageDir;
    if (this.storageDir) {
      if (!existsSync(this.storageDir)) mkdirSync(this.storageDir, { recursive: true });
      this._loadFromDisk();
    }
  }

  /**
   * Persist a recovery-job record. The order snapshot is redacted before it
   * touches disk so no preimage or signing-key material is ever stored.
   */
  save(record: PersistedRecoveryJob): void {
    const redacted: PersistedRecoveryJob = {
      ...record,
      order: redactRecoveryOrder(record.order),
      savedAt: Date.now(),
    };
    this.records.set(redacted.id, redacted);
    this._persist(redacted);
  }

  /** Remove a job from the store (in-memory + durable). */
  remove(id: string): void {
    this.records.delete(id);
    if (this.storageDir) {
      const fpath = this._filePath(id);
      try {
        if (existsSync(fpath)) unlinkSync(fpath);
      } catch { /* best-effort */ }
    }
  }

  /** Return every persisted job (for inspection / reconstruction). */
  loadAll(): PersistedRecoveryJob[] {
    return Array.from(this.records.values());
  }

  /** Return only the jobs eligible to resume after a restart. */
  loadEligible(): PersistedRecoveryJob[] {
    return this.loadAll().filter((j) =>
      isJobEligibleToResume(j.status, j.nextAttemptAt ?? null),
    );
  }

  /** Number of persisted jobs. */
  size(): number {
    return this.records.size;
  }

  /** Remove every persisted job (in-memory + durable). */
  clear(): void {
    this.records.clear();
    if (this.storageDir && existsSync(this.storageDir)) {
      for (const file of readdirSync(this.storageDir)) {
        if (file.endsWith('.json')) unlinkSync(join(this.storageDir, file));
      }
    }
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  private _filePath(id: string): string {
    const safe = id.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 120);
    return join(this.storageDir!, `${safe}.json`);
  }

  private _persist(record: PersistedRecoveryJob): void {
    if (!this.storageDir) return;
    const fpath = this._filePath(record.id);
    const tmp = fpath + '.tmp';
    try {
      writeFileSync(tmp, JSON.stringify(record), 'utf-8');
      renameSync(tmp, fpath);
    } catch (err) {
      log.warn(
        { jobId: record.id, err: err instanceof Error ? err.message : String(err) },
        '[recovery-job-store] persist failed',
      );
    }
  }

  private _loadFromDisk(): void {
    if (!this.storageDir || !existsSync(this.storageDir)) return;
    let files: string[];
    try {
      files = readdirSync(this.storageDir).filter(
        (f) => f.endsWith('.json') && !f.endsWith('.tmp'),
      );
    } catch {
      return;
    }
    for (const file of files) {
      try {
        const raw = readFileSync(join(this.storageDir, file), 'utf-8');
        const persisted = JSON.parse(raw) as PersistedRecoveryJob;
        if (persisted && typeof persisted.id === 'string' && !this.records.has(persisted.id)) {
          this.records.set(persisted.id, persisted);
        }
      } catch {
        // corrupted record — skip
      }
    }
  }
}
