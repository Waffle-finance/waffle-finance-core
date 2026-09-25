/**
 * EventIdentity — deterministic event deduplication for the reconciler.
 *
 * ## Problem
 *
 * The reconciler scans overlapping block windows on every run.  Without
 * deduplication, a single on-chain event (e.g. OrderCreated at block 100) will
 * be processed on every reconciliation cycle until the HWM advances past it.
 * For idempotent write operations (recordSrcLock, recordSecret, markStatus) the
 * duplicate processing is safe but wasteful; for non-idempotent metrics
 * counters it produces inflated numbers.
 *
 * ## Solution
 *
 * Each chain event is reduced to a **dedup key** — a short, deterministic
 * string that uniquely identifies an on-chain event occurrence. The dedup key
 * combines:
 *   - chain identifier
 *   - event type
 *   - the canonical event identifier (tx hash + log index for ETH, ledger +
 *     txHash for Soroban, slot + sig for Solana)
 *
 * The `EventSeenSet` tracks which keys have been processed in the current
 * reconciler run.  It is cleared between runs so that:
 *   - Within a run, each event is processed exactly once.
 *   - Between runs, events from overlapping windows are re-evaluated — this is
 *     required because the HWM may not have advanced (e.g. no new locks were
 *     written) but new events may have been emitted in the overlap range.
 *
 * ## Conflict classification
 *
 * When the reconciler encounters an event whose dedup key has already been
 * seen in the current run, it classifies the conflict as one of:
 *   - `duplicate`   — exact same key seen twice (same tx hash + event type)
 *   - `reordered`   — same logical event (same hashlock/orderId + event type)
 *                     but different tx hash (possible in Solana fork scenarios)
 *
 * Conflicts are counted by the caller for metrics but never cause a state
 * mutation to be re-applied.
 */

export type EventType = "OrderCreated" | "OrderClaimed" | "OrderRefunded";
export type Chain = "ethereum" | "soroban" | "solana";

export type ConflictKind = "duplicate" | "reordered";

export interface ConflictRecord {
  key: string;
  kind: ConflictKind;
  chain: Chain;
  eventType: EventType;
}

// ─── Key builders ─────────────────────────────────────────────────────────────

/**
 * Build a dedup key for an Ethereum log event.
 *
 * Ethereum events are uniquely identified by (txHash, logIndex).  The logIndex
 * distinguishes multiple events from the same transaction (e.g. a batch that
 * emits several OrderCreated logs).
 */
export function ethEventKey(
  eventType: EventType,
  txHash: string,
  logIndex: number,
): string {
  return `eth:${eventType}:${txHash.toLowerCase()}:${logIndex}`;
}

/**
 * Build a dedup key for a Soroban contract event.
 *
 * Soroban events are uniquely identified by (ledger, txHash, eventIndex within
 * the transaction). Since the cursor paginates via an opaque `cursor` string,
 * we use the ledger + txHash + an integer index within the batch.
 */
export function sorobanEventKey(
  eventType: EventType,
  txHash: string,
  ledger: number,
  eventIndex: number,
): string {
  return `soroban:${eventType}:${ledger}:${txHash}:${eventIndex}`;
}

/**
 * Build a dedup key for a Solana program log event.
 *
 * Solana transactions are uniquely identified by their signature.  Unlike
 * Ethereum, a single transaction produces at most one HTLC event (the program
 * only emits one type per instruction), so the signature alone is sufficient.
 */
export function solanaEventKey(
  eventType: EventType,
  signature: string,
): string {
  return `solana:${eventType}:${signature}`;
}

// ─── Semantic identity key (for reorder detection) ───────────────────────────

/**
 * Build a **semantic** identity key based on the order's logical identity
 * rather than the transaction identity.  Two events with the same semantic key
 * but different dedup keys represent a reordered delivery of the same logical
 * event (e.g. the same hashlock appearing in two different transactions due to
 * a chain fork or RPC inconsistency).
 */
export function semanticKey(
  chain: Chain,
  eventType: EventType,
  /** hashlock for Created events; orderId for Claimed/Refunded. */
  identifier: string,
): string {
  return `semantic:${chain}:${eventType}:${identifier.toLowerCase()}`;
}

// ─── EventSeenSet ─────────────────────────────────────────────────────────────

/**
 * Per-run seen-set for event deduplication.
 *
 * Lifecycle:
 *   1. Instantiate once per reconciler run (or call `clear()` between runs).
 *   2. For each event, call `checkAndMark(key, semanticKey)`.
 *   3. If `checkAndMark` returns a `ConflictRecord`, skip the event.
 *   4. After the run completes, `getStats()` returns counters for metrics.
 */
export class EventSeenSet {
  /** dedup key → semantic key (so we can detect reordered events). */
  private readonly dedupKeys = new Map<string, string>();
  /** semantic key → dedup key (so we can detect reordering). */
  private readonly semanticKeys = new Map<string, string>();

  private stats = {
    seen: 0,
    duplicates: 0,
    reordered: 0,
  };

  /**
   * Check whether `key` (or its `semKey` equivalent) has been seen before.
   *
   * Returns `null` when the event is new (caller should process it).
   * Returns a `ConflictRecord` when the event is a duplicate or reorder
   * (caller should skip processing and record the conflict).
   *
   * Marks the event as seen regardless of whether a conflict was detected,
   * so subsequent duplicates of the same key are also caught.
   */
  checkAndMark(
    chain: Chain,
    eventType: EventType,
    key: string,
    semKey: string,
  ): ConflictRecord | null {
    // Check 1: exact dedup key already seen.
    if (this.dedupKeys.has(key)) {
      this.stats.duplicates++;
      return { key, kind: "duplicate", chain, eventType };
    }

    // Check 2: same semantic identity but different dedup key → reordered.
    const existingDedupKey = this.semanticKeys.get(semKey);
    if (existingDedupKey !== undefined) {
      this.stats.reordered++;
      this.dedupKeys.set(key, semKey); // mark this key too
      return { key, kind: "reordered", chain, eventType };
    }

    // New event — record both maps.
    this.dedupKeys.set(key, semKey);
    this.semanticKeys.set(semKey, key);
    this.stats.seen++;
    return null;
  }

  /** True if the exact dedup key has been seen in this run. */
  has(key: string): boolean {
    return this.dedupKeys.has(key);
  }

  /** Returns a snapshot of the current run's stats. */
  getStats(): Readonly<{ seen: number; duplicates: number; reordered: number }> {
    return { ...this.stats };
  }

  /** Clear all seen keys and reset stats.  Call between reconciler runs. */
  clear(): void {
    this.dedupKeys.clear();
    this.semanticKeys.clear();
    this.stats = { seen: 0, duplicates: 0, reordered: 0 };
  }

  /** Total entries in the dedup set (useful for memory-pressure monitoring). */
  size(): number {
    return this.dedupKeys.size;
  }
}
