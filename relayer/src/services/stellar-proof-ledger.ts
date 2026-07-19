/**
 * StellarProofLedger — replay-protection store for consumed Stellar tx proofs.
 *
 * Problem it solves
 * -----------------
 * The xlm-to-eth settlement path releases ETH in exchange for proof that the
 * user sent XLM (the stellarTxHash). Without a consumed-hash registry an
 * attacker can replay the same Stellar tx hash in multiple requests and
 * receive ETH on every call that finds an eligible order.
 *
 * How it works
 * ------------
 * Before any ETH release the handler MUST call `consume(stellarTxHash)`.
 * - First call → returns `true` (caller may proceed to release ETH).
 * - Subsequent calls with the same hash → returns `false` (rejected).
 *
 * The entry is keyed by the Stellar transaction hash (64-char hex string).
 * Once consumed the entry is permanent — there is no release path, unlike
 * the RefundLedger, because a Stellar payment can only happen once on-chain.
 *
 * Concurrency
 * -----------
 * All operations are synchronous. Within Node.js's single-threaded event
 * loop, `consume` acts as an atomic compare-and-set: two concurrent requests
 * for the same hash cannot both receive `true`.
 *
 * Persistence
 * -----------
 * This is in-memory only. In production, swap the backing store to Redis or
 * a database table with a unique index on stellarTxHash. The interface is
 * intentionally narrow so callers need no changes.
 *
 * Related
 * -------
 * See `refund-ledger.ts` for the analogous store that gates XLM refunds.
 */

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

export class StellarProofLedger {
  private readonly entries = new Map<string, ConsumedProofEntry>();

  /**
   * Atomically mark a Stellar tx hash as consumed.
   *
   * Returns `true` on first call for this hash (caller may release ETH).
   * Returns `false` if the hash was already consumed — reject the request.
   */
  consume(
    stellarTxHash: string,
    meta: Omit<ConsumedProofEntry, 'stellarTxHash' | 'consumedAt'>
  ): boolean {
    if (this.entries.has(stellarTxHash)) return false;
    this.entries.set(stellarTxHash, {
      stellarTxHash,
      consumedAt: Date.now(),
      ...meta,
    });
    return true;
  }

  /**
   * Check whether a hash has been consumed without marking it.
   * Use this for read-only checks (e.g. health endpoints, diagnostics).
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
}

/**
 * Process-wide singleton. Import this in the xlm-to-eth handler.
 *
 * In tests, create a fresh instance per suite:
 *   const ledger = new StellarProofLedger();
 */
export const globalStellarProofLedger = new StellarProofLedger();
