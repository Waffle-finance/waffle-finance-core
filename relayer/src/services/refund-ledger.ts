/**
 * RefundLedger — in-process idempotency store for XLM refunds.
 *
 * Problem it solves
 * -----------------
 * Three code paths can trigger a refund for the same order:
 *  1. Inline handler in /api/orders/xlm-to-eth (ETH send failed → immediate refund)
 *  2. /api/orders/manual-refund (user-initiated retry)
 *  3. Background refund watchdog (rescues orders the user never retried)
 *
 * Without a shared gate, a race between any two of these paths could
 * submit two Stellar payments to the same destination for the same
 * original XLM payment — i.e. the relayer pays out twice.
 *
 * How it works
 * ------------
 * Each refund attempt is keyed by `orderId`. Before any caller submits
 * to Horizon it MUST call `claim(orderId)`. Only the first caller
 * receives a token; every subsequent caller receives `null` (already
 * claimed). When the Stellar submit returns:
 *
 *   - SUCCESS:  call `commit(orderId, result)` — persists the winning
 *               txHash so future callers can inspect it.
 *   - FAILURE:  call `release(orderId)` — removes the in-flight marker
 *               so the next retry can attempt again. This handles the
 *               case where Horizon returned a definitive error (tx was
 *               never broadcast). Horizon 504 / timeout is NOT released
 *               because the tx may still land — the caller should treat
 *               it as ambiguous and let the watchdog handle the retry
 *               after the back-off window expires.
 *
 * All mutations are synchronous so the claim → submit → commit/release
 * sequence is safe within a single-threaded Node.js event loop iteration
 * (no two callers can interleave between `claim` and `commit`).
 *
 * Persistence
 * -----------
 * This is deliberately in-memory. In production a durable store (Redis,
 * Postgres) should replace this, but the interface is identical — swap
 * the backing store without touching callers.
 */

export type RefundState =
  | { phase: 'in_flight' }
  | { phase: 'committed'; txHash: string; amount: string; ledger?: number; committedAt: number }
  | { phase: 'ambiguous'; reason: string; ambiguousAt: number };

export interface RefundEntry {
  orderId: string;
  state: RefundState;
}

export class RefundLedger {
  private readonly entries = new Map<string, RefundEntry>();

  /**
   * Atomically claim the right to refund `orderId`.
   *
   * Returns `true` if the claim was granted (this caller may proceed).
   * Returns `false` if the order is already in-flight, committed, or
   * ambiguous — caller MUST NOT submit a Stellar transaction.
   *
   * When `false` is returned, call `getEntry(orderId)` to inspect the
   * existing state (e.g. to return the committed txHash to the user).
   */
  claim(orderId: string): boolean {
    if (this.entries.has(orderId)) return false;
    this.entries.set(orderId, { orderId, state: { phase: 'in_flight' } });
    return true;
  }

  /**
   * Finalise a successful refund. Idempotent — safe to call more than
   * once with the same arguments (subsequent calls are no-ops).
   */
  commit(orderId: string, result: { txHash: string; amount: string; ledger?: number }): void {
    const existing = this.entries.get(orderId);
    // Already committed (e.g. concurrent path beat us here) — keep first result.
    if (existing?.state.phase === 'committed') return;
    this.entries.set(orderId, {
      orderId,
      state: {
        phase: 'committed',
        txHash: result.txHash,
        amount: result.amount,
        ledger: result.ledger,
        committedAt: Date.now(),
      },
    });
  }

  /**
   * Release a failed claim so the next retry attempt can try again.
   * Only releases entries that are currently `in_flight`; committed and
   * ambiguous entries are left untouched (no double-spend risk).
   */
  release(orderId: string): void {
    const entry = this.entries.get(orderId);
    if (entry?.state.phase === 'in_flight') {
      this.entries.delete(orderId);
    }
  }

  /**
   * Mark an entry as ambiguous — the submit call timed out or received a
   * 504, so the transaction may or may not have landed on Stellar.
   * The watchdog will retry after the back-off window; the RefundLedger
   * will block concurrent callers in the meantime.
   */
  markAmbiguous(orderId: string, reason: string): void {
    this.entries.set(orderId, {
      orderId,
      state: { phase: 'ambiguous', reason, ambiguousAt: Date.now() },
    });
  }

  /**
   * Promote an ambiguous entry to committed once the watchdog confirms
   * a refund landed (e.g. by querying Horizon by the memo).
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
   * Clear an ambiguous entry so the watchdog can retry submitting it.
   * Should be called only after confirming the original tx is NOT on-chain.
   */
  releaseAmbiguous(orderId: string): void {
    const entry = this.entries.get(orderId);
    if (entry?.state.phase === 'ambiguous') {
      this.entries.delete(orderId);
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

  /** True if a refund attempt is currently in flight or ambiguous. */
  isLocked(orderId: string): boolean {
    const phase = this.entries.get(orderId)?.state.phase;
    return phase === 'in_flight' || phase === 'ambiguous';
  }

  /** Snapshot of all entries — useful for health endpoints and tests. */
  snapshot(): RefundEntry[] {
    return Array.from(this.entries.values());
  }

  /** Number of entries in each phase — for metrics / debugging. */
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
}

/**
 * Process-wide singleton. Import this wherever a refund is initiated.
 *
 * In tests, create a fresh instance per suite:
 *   const ledger = new RefundLedger();
 */
export const globalRefundLedger = new RefundLedger();
