/**
 * StellarProofLedger — persistent replay-protection store for consumed
 * Stellar tx proofs on the XLM→ETH settlement path.
 *
 * Problem it solves
 * -----------------
 * The xlm-to-eth settlement path releases ETH in exchange for proof that
 * the user sent XLM (the stellarTxHash). Without a consumed-hash registry
 * an attacker can replay the same Stellar tx hash and receive ETH on every
 * call that finds an eligible order.
 *
 * How it works
 * ------------
 * Before any ETH release the handler MUST call `consume(stellarTxHash)`.
 * - First call  → returns `true`  (caller may proceed to release ETH).
 * - Later calls → returns `false` (rejected; caller MUST return 409).
 *
 * The entry is keyed by the Stellar transaction hash. Once consumed the
 * entry is permanent — there is no release path, because a Stellar payment
 * can only happen once on-chain.
 *
 * Concurrency
 * -----------
 * All mutations are synchronous. Within Node.js's single-threaded event
 * loop `consume` acts as an atomic compare-and-set: two concurrent requests
 * for the same hash cannot both receive `true`.
 *
 * Persistence
 * -----------
 * Each consumed entry is written atomically to disk (tmp file + rename) so
 * that the guard survives process restarts. On startup the constructor reads
 * all persisted records from `storageDir` and rebuilds the in-memory map.
 *
 * Pass `storageDir: null` to disable disk I/O (tests, unit benchmarks).
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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConsumedProofEntry {
  stellarTxHash: string;
  orderId: string;
  /** Amount verified from Horizon (7-decimal XLM string, e.g. "12.3456789"). */
  verifiedAmount: string;
  /** Horizon ledger sequence the tx was included in. */
  ledgerSequence?: number;
  /** Unix timestamp (ms) when this entry was created. */
  consumedAt: number;
}

interface PersistedRecord {
  stellarTxHash: string;
  orderId: string;
  verifiedAmount: string;
  ledgerSequence?: number;
  consumedAt: number;
  savedAt: number;
}

export interface StellarProofLedgerOptions {
  /**
   * Directory where one JSON file per consumed hash is stored.
   * Defaults to `<cwd>/.stellar-proof-ledger`.
   * Pass `null` to disable persistence (useful in tests).
   */
  storageDir?: string | null;
}

// ---------------------------------------------------------------------------
// StellarProofLedger
// ---------------------------------------------------------------------------

export class StellarProofLedger {
  private readonly entries = new Map<string, ConsumedProofEntry>();
  private readonly storageDir: string | null;

  constructor(options: StellarProofLedgerOptions = {}) {
    if (options.storageDir === null) {
      this.storageDir = null;
    } else {
      this.storageDir =
        options.storageDir ?? join(process.cwd(), '.stellar-proof-ledger');
      this._ensureDir();
      this._loadFromDisk();
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Atomically mark a Stellar tx hash as consumed.
   *
   * Returns `true` on first call for this hash (caller may release ETH).
   * Returns `false` if the hash was already consumed — caller MUST return 409.
   */
  consume(
    stellarTxHash: string,
    meta: Omit<ConsumedProofEntry, 'stellarTxHash' | 'consumedAt'>
  ): boolean {
    if (this.entries.has(stellarTxHash)) return false;
    const entry: ConsumedProofEntry = {
      stellarTxHash,
      consumedAt: Date.now(),
      ...meta,
    };
    this.entries.set(stellarTxHash, entry);
    this._persist(entry);
    return true;
  }

  /**
   * Check whether a hash has been consumed without marking it.
   */
  isConsumed(stellarTxHash: string): boolean {
    return this.entries.has(stellarTxHash);
  }

  /**
   * Retrieve the full entry for a consumed hash, or `undefined` if unknown.
   */
  getEntry(stellarTxHash: string): ConsumedProofEntry | undefined {
    return this.entries.get(stellarTxHash);
  }

  /** Total number of consumed proofs tracked in this instance. */
  size(): number {
    return this.entries.size;
  }

  /** Snapshot of all entries — useful for diagnostics and tests. */
  snapshot(): ConsumedProofEntry[] {
    return Array.from(this.entries.values());
  }

  // ── Persistence helpers ───────────────────────────────────────────────────

  private _ensureDir(): void {
    if (this.storageDir && !existsSync(this.storageDir)) {
      mkdirSync(this.storageDir, { recursive: true });
    }
  }

  private _filePath(stellarTxHash: string): string {
    // Hashes are hex strings — safe as filenames already, but clamp length.
    const safe = stellarTxHash.replace(/[^a-zA-Z0-9_\-]/g, '_').substring(0, 80);
    return join(this.storageDir!, `${safe}.json`);
  }

  /** Atomically write one entry to disk (tmp + rename). */
  private _persist(entry: ConsumedProofEntry): void {
    if (!this.storageDir) return;
    const record: PersistedRecord = { ...entry, savedAt: Date.now() };
    const fpath = this._filePath(entry.stellarTxHash);
    const tmp = fpath + '.tmp';
    try {
      writeFileSync(tmp, JSON.stringify(record), 'utf-8');
      renameSync(tmp, fpath);
    } catch (err) {
      // Non-fatal — in-memory state is authoritative within this process.
      process.stderr.write(
        JSON.stringify({
          level: 'warn',
          msg: '[stellar-proof-ledger] failed to persist entry',
          stellarTxHash: entry.stellarTxHash,
          error: err instanceof Error ? err.message : String(err),
        }) + '\n'
      );
    }
  }

  /**
   * Load all persisted entries from disk on startup.
   * Silently skips corrupted or malformed files.
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
          typeof record.stellarTxHash === 'string' &&
          typeof record.orderId === 'string' &&
          typeof record.verifiedAmount === 'string' &&
          typeof record.consumedAt === 'number' &&
          !this.entries.has(record.stellarTxHash)
        ) {
          this.entries.set(record.stellarTxHash, {
            stellarTxHash: record.stellarTxHash,
            orderId: record.orderId,
            verifiedAmount: record.verifiedAmount,
            ledgerSequence: record.ledgerSequence,
            consumedAt: record.consumedAt,
          });
        }
      } catch {
        // Corrupted file — skip; the handler will process a fresh request.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Process-wide singleton
// ---------------------------------------------------------------------------

/**
 * Process-wide singleton. Import this in the xlm-to-eth handler.
 *
 * In tests, create a fresh instance with `storageDir: null` per suite:
 *   const ledger = new StellarProofLedger({ storageDir: null });
 */
export const globalStellarProofLedger = new StellarProofLedger();
