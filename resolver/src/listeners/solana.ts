import { Connection, PublicKey } from "@solana/web3.js";
import type { Logger } from "pino";
import type { ResolverConfig } from "../config.js";
import {
  eventsTotal,
  listenerErrorsTotal,
  listenerPollDurationSeconds,
  listenerPollRunsTotal,
  listenerLastEventTimestampSeconds,
  activeListeners,
} from "../metrics.js";
import { globalStalenessMonitor } from "../telemetry.js";

const CHAIN = "solana";

/**
 * Number of slots behind the current finalized slot before a transaction
 * queued at `confirmed` is considered safe to process.
 * Solana's supermajority vote lockout reaches maximum after ~32 slots.
 */
export const FINALIZATION_SLOTS = 32;

/**
 * Slot regression threshold: if the newly observed confirmed slot drops
 * more than this many slots below the previously observed slot, we treat
 * it as evidence of a fork and clear the pending queue.
 */
export const REGRESSION_THRESHOLD = 5;

/**
 * Maximum age (in slots relative to the finalized slot) for entries to
 * stay in `pendingSlots`.  Older entries are pruned to bound memory growth.
 */
const PENDING_SLOTS_MAX_AGE = 200;

/**
 * Maximum number of processed signature keys held in the in-process dedup
 * cache.  Bounded to prevent unbounded memory growth in long-running processes.
 */
const DEDUP_CACHE_MAX = 10_000;

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

/** Emitted when a new HTLC order is locked on Solana. */
export interface SolanaOrderCreatedEvent {
  type: "created";
  /** Solana transaction signature (base58). */
  txSig: string;
  /** On-chain order ID (Anchor PDA address). */
  orderId: string;
  /** SHA-256 hashlock (hex string). */
  hashlock: string;
  /** Timelock (unix seconds). */
  timelock: number;
  /** Slot the transaction landed in. */
  slot: number;
}

/** Emitted when the beneficiary reveals the preimage and claims funds. */
export interface SolanaOrderClaimedEvent {
  type: "claimed";
  txSig: string;
  orderId: string;
  /** Revealed preimage (hex string). */
  preimage: string;
  slot: number;
}

/** Emitted when the timelock expires and the maker reclaims funds. */
export interface SolanaOrderRefundedEvent {
  type: "refunded";
  txSig: string;
  orderId: string;
  slot: number;
}

/** Union of all typed Solana HTLC events. */
export type SolanaHtlcEvent =
  | SolanaOrderCreatedEvent
  | SolanaOrderClaimedEvent
  | SolanaOrderRefundedEvent;

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

export interface SolanaEventHandlers {
  onOrderCreated(e: SolanaOrderCreatedEvent): void;
  onOrderClaimed(e: SolanaOrderClaimedEvent): void;
  onOrderRefunded(e: SolanaOrderRefundedEvent): void;
  /**
   * Called for any Anchor log line that does not correspond to one of the
   * known HTLC instruction names.  Optional; defaults to a no-op.
   */
  onUnknownEvent?(opts: { sig: string; logs: string[]; slot: number }): void;
}

// ---------------------------------------------------------------------------
// Log-parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parse Anchor program log lines emitted by the Solana HTLC program.
 *
 * Anchor logs follow the pattern:
 *   Program log: Instruction: <name>
 * and carry a JSON payload on a subsequent "Program log: {...}" line.
 *
 * Returns the decoded event or `null` when the log batch does not
 * contain a recognised HTLC instruction.
 */
export function parseSolanaHtlcLogs(
  sig: string,
  logs: string[],
  slot: number,
): SolanaHtlcEvent | null {
  let eventType: "created" | "claimed" | "refunded" | null = null;
  const payload: Record<string, unknown> = {};

  for (const line of logs) {
    if (line.includes("OrderCreated"))  eventType = "created";
    if (line.includes("OrderClaimed"))  eventType = "claimed";
    if (line.includes("OrderRefunded")) eventType = "refunded";

    // Anchor may emit JSON data on any "Program log:" or "Program data:" line.
    const jsonMatch = line.match(/\{.*\}/);
    if (jsonMatch) {
      try {
        Object.assign(payload, JSON.parse(jsonMatch[0]));
      } catch {
        // Malformed JSON in a program log line — not a whole-batch failure.
        // The metric is incremented here so operators can alert on repeated
        // parse errors without them being invisible in production.
        listenerErrorsTotal.inc({ chain: CHAIN, error_type: "parse_error" });
      }
    }
  }

  if (!eventType) return null;

  switch (eventType) {
    case "created": {
      const hashlock = payload.hashlock as string | undefined;
      const orderId  = payload.orderId  as string | undefined;
      const timelock = payload.timelock as number | undefined;
      if (!hashlock || !orderId || timelock == null) return null;
      return { type: "created", txSig: sig, orderId, hashlock, timelock, slot };
    }
    case "claimed": {
      const preimage = payload.preimage as string | undefined;
      const orderId  = payload.orderId  as string | undefined;
      if (!preimage || !orderId) return null;
      return { type: "claimed", txSig: sig, orderId, preimage, slot };
    }
    case "refunded": {
      const orderId = payload.orderId as string | undefined;
      if (!orderId) return null;
      return { type: "refunded", txSig: sig, orderId, slot };
    }
  }
}

// ---------------------------------------------------------------------------
// Listener
// ---------------------------------------------------------------------------

/**
 * Polls the Solana RPC for HTLC program transactions and dispatches typed
 * events to the supplied handlers.
 *
 * Reorg-safety model
 * ------------------
 * Solana validators fork: a confirmed slot can be reverted if the
 * supermajority never reaches max lockout on it.  The listener uses a
 * two-stage pipeline to guard against this:
 *
 *  1. Fetch new signatures at `confirmed` and queue them in `pendingSlots`
 *     (slot → [{sig, logs}]).
 *  2. Drain (dispatch) entries only once the slot has reached
 *     `finalizedSlot - FINALIZATION_SLOTS`, making them effectively
 *     irreversible.
 *  3. On each poll, compare the new confirmed slot to the last observed one.
 *     If it regressed by more than REGRESSION_THRESHOLD we assume a fork:
 *     pending entries in the affected range are dropped.
 *
 * Deduplication
 * -------------
 * Each transaction signature is tracked in an LRU-bounded in-process cache
 * (`processedSigs`).  Duplicate deliveries (e.g. RPC returning the same
 * signature across two polls due to pagination overlap) are silently ignored.
 *
 * This class mirrors the structure of SorobanListener so it can be tested
 * and operated in the same way.
 */
export class SolanaListener {
  private readonly log: Logger;
  private connection: Connection;
  private stopped = false;
  private timeoutId?: ReturnType<typeof setTimeout>;
  private readonly pollMs: number;

  /** Last confirmed slot observed — used to detect regressions. */
  private lastSlot = 0;

  /**
   * Confirmation queue: slot → [{sig, logs}] seen at `confirmed`
   * but not yet at `finalized - FINALIZATION_SLOTS`.
   */
  private readonly pendingSlots: Map<number, Array<{ sig: string; logs: string[] }>> =
    new Map();

  /**
   * In-process event deduplication cache.
   * Key: transaction signature (unique per on-chain tx).
   * Bounded at DEDUP_CACHE_MAX; oldest entry evicted on overflow.
   */
  private readonly processedSigs = new Map<string, true>();

  constructor(
    private readonly cfg: ResolverConfig & {
      solana?: {
        rpcUrl: string;
        programId?: string;
        commitment?: "processed" | "confirmed" | "finalized";
      };
    },
    pollMs: number,
    log: Logger,
  ) {
    this.pollMs = pollMs;
    this.log = log.child({ component: "SolanaListener" });
    const rpcUrl = cfg.solana?.rpcUrl ?? "https://api.devnet.solana.com";
    const commitment = cfg.solana?.commitment ?? "confirmed";
    this.connection = new Connection(rpcUrl, commitment);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async start(handlers: SolanaEventHandlers): Promise<void> {
    const programId = this.cfg.solana?.programId;

    if (!programId || isProgramIdPlaceholder(programId)) {
      this.log.warn(
        { programId },
        "SOLANA_HTLC_PROGRAM is a placeholder — Solana listener disabled",
      );
      return;
    }

    // Cancel any previous polling loop before starting a new one.
    this.stop();
    this.stopped = false;

    this.log.info(
      { program: programId, rpc: this.cfg.solana?.rpcUrl },
      "Solana listener starting",
    );

    activeListeners.set({ chain: CHAIN }, 1);
    globalStalenessMonitor.recordStarted(CHAIN);

    const tick = async () => {
      if (this.stopped) return;
      const endTimer = listenerPollDurationSeconds.startTimer({ chain: CHAIN });
      try {
        await this.poll(new PublicKey(programId), handlers);
        endTimer();
        listenerPollRunsTotal.inc({ chain: CHAIN, result: "success" });
        // Healthy tick — resets consecutive-failure counter and flips the
        // health-state gauge back to "healthy" via the staleness monitor.
        globalStalenessMonitor.recordHealthyTick(CHAIN);
      } catch (err) {
        endTimer();
        listenerPollRunsTotal.inc({ chain: CHAIN, result: "failure" });
        listenerErrorsTotal.inc({ chain: CHAIN, error_type: "poll_error" });
        // Failure tick — accumulates consecutive failures; after threshold=3
        // the health-state gauge transitions to "degraded".
        globalStalenessMonitor.recordFailure(CHAIN);
        this.log.warn({ err }, "Solana poll failed");
      } finally {
        if (!this.stopped) {
          this.timeoutId = setTimeout(tick, this.pollMs);
        }
      }
    };

    void tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = undefined;
    }
    activeListeners.set({ chain: CHAIN }, 0);
    globalStalenessMonitor.recordStopped(CHAIN);
  }

  // ---------------------------------------------------------------------------
  // Deduplication helpers (exposed for tests)
  // ---------------------------------------------------------------------------

  isDuplicate(sig: string): boolean {
    return this.processedSigs.has(sig);
  }

  getDedupSize(): number {
    return this.processedSigs.size;
  }

  getPendingSlotCount(): number {
    return this.pendingSlots.size;
  }

  getLastSlot(): number {
    return this.lastSlot;
  }

  // ---------------------------------------------------------------------------
  // Poll loop
  // ---------------------------------------------------------------------------

  private async poll(
    programPk: PublicKey,
    handlers: SolanaEventHandlers,
  ): Promise<void> {
    const startedAt = Date.now();

    // Step a: fetch both commitment levels to determine finalization watermark.
    const [finalizedSlot, confirmedSlot] = await Promise.all([
      this.connection.getSlot("finalized"),
      this.connection.getSlot("confirmed"),
    ]);

    // Step b: detect slot regression (possible fork).
    if (this.lastSlot > 0 && confirmedSlot < this.lastSlot - REGRESSION_THRESHOLD) {
      this.log.warn(
        { confirmedSlot, lastSlot: this.lastSlot, finalizedSlot },
        "Solana slot regression detected",
      );
      this.handleRegression(confirmedSlot);
    }

    // Step c: fetch recent signatures and queue them.
    const sigs = await this.connection.getSignaturesForAddress(programPk, {
      limit: 50,
    });

    for (const sigInfo of sigs) {
      if (sigInfo.slot <= this.lastSlot) continue;
      if (sigInfo.err) continue;

      let logs: string[] = [];
      try {
        const tx = await this.connection.getParsedTransaction(sigInfo.signature, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        });
        if (!tx?.meta?.logMessages) continue;
        logs = tx.meta.logMessages;
      } catch (txErr) {
        this.log.warn({ sig: sigInfo.signature, err: txErr }, "failed to fetch tx");
        continue;
      }

      const slot = sigInfo.slot;
      if (!this.pendingSlots.has(slot)) {
        this.pendingSlots.set(slot, []);
      }
      this.pendingSlots.get(slot)!.push({ sig: sigInfo.signature, logs });
    }

    // Update lastSlot.
    if (sigs.length > 0) {
      this.lastSlot = Math.max(this.lastSlot, ...sigs.map((s) => s.slot));
    } else if (this.lastSlot === 0) {
      this.lastSlot = confirmedSlot;
    }

    // Step d: drain slots that have reached the finalization watermark.
    const drainBefore = finalizedSlot - FINALIZATION_SLOTS;
    for (const [slot, txList] of this.pendingSlots) {
      if (slot > drainBefore) continue;

      for (const { sig, logs } of txList) {
        this.dispatch(sig, logs, slot, handlers);
      }
      this.pendingSlots.delete(slot);
    }

    // Step e: prune entries too old to be useful.
    const pruneOlderThan = finalizedSlot - PENDING_SLOTS_MAX_AGE;
    for (const slot of this.pendingSlots.keys()) {
      if (slot < pruneOlderThan) {
        this.log.debug({ slot }, "pruning stale pending slot");
        this.pendingSlots.delete(slot);
      }
    }

    void startedAt; // suppress unused-variable lint
  }

  // ---------------------------------------------------------------------------
  // Regression / fork handling
  // ---------------------------------------------------------------------------

  private handleRegression(newConfirmedSlot: number): void {
    const regressionStart = newConfirmedSlot + 1;
    const regressionEnd   = this.lastSlot;

    let dropped = 0;
    for (let slot = regressionStart; slot <= regressionEnd; slot++) {
      if (this.pendingSlots.has(slot)) {
        dropped += this.pendingSlots.get(slot)!.length;
        this.pendingSlots.delete(slot);
      }
    }

    if (dropped > 0) {
      this.log.warn(
        { regressionStart, regressionEnd, dropped },
        "dropped pending transactions in regressed slot range",
      );
      // Record dropped batches as missed events so the staleness monitor can
      // reflect that events may have been lost during the fork.
      globalStalenessMonitor.recordMissedBatch(CHAIN, "slot_regression");
    }

    this.lastSlot = newConfirmedSlot;
  }

  // ---------------------------------------------------------------------------
  // Event dispatch
  // ---------------------------------------------------------------------------

  private dispatch(
    sig: string,
    logs: string[],
    slot: number,
    handlers: SolanaEventHandlers,
  ): void {
    if (this.isDuplicate(sig)) {
      this.log.debug({ sig }, "Solana event duplicate skipped (in-process cache)");
      return;
    }

    const event = parseSolanaHtlcLogs(sig, logs, slot);

    if (!event) {
      // No recognised HTLC instruction — route to optional unknown handler.
      if (handlers.onUnknownEvent) {
        handlers.onUnknownEvent({ sig, logs, slot });
      }
      // Unknown events do not advance the dedup cache.
      return;
    }

    listenerLastEventTimestampSeconds.set({ chain: CHAIN }, Math.floor(Date.now() / 1000));

    try {
      switch (event.type) {
        case "created":
          eventsTotal.inc({ chain: CHAIN, event_type: "created" });
          handlers.onOrderCreated(event);
          break;
        case "claimed":
          eventsTotal.inc({ chain: CHAIN, event_type: "claimed" });
          handlers.onOrderClaimed(event);
          break;
        case "refunded":
          eventsTotal.inc({ chain: CHAIN, event_type: "refunded" });
          handlers.onOrderRefunded(event);
          break;
      }

      this.markSigProcessed(sig);
    } catch (err) {
      listenerErrorsTotal.inc({ chain: CHAIN, error_type: "handler_error" });
      this.log.warn({ err, sig }, "Solana event handler threw");
      // Do NOT mark as processed on handler error — allow retry on next poll.
    }
  }

  private markSigProcessed(sig: string): void {
    if (this.processedSigs.has(sig)) return;
    if (this.processedSigs.size >= DEDUP_CACHE_MAX) {
      const oldest = this.processedSigs.keys().next().value;
      if (oldest !== undefined) this.processedSigs.delete(oldest);
    }
    this.processedSigs.set(sig, true);
  }
}

// ---------------------------------------------------------------------------
// Internal helper
// ---------------------------------------------------------------------------

/** Mirrors the coordinator's isSolanaPlaceholder logic inline to avoid
 *  importing @wafflefinance/config from the resolver (which has no Solana
 *  section in its config schema yet). */
function isProgramIdPlaceholder(programId: string | undefined): boolean {
  if (!programId || programId.trim() === "") return true;
  const upper = programId.trim().toUpperCase();
  const known = new Set([
    "PLACEHOLDER",
    "YOUR_SOLANA_HTLC_PROGRAM",
    "YOUR_SOLANA_PROGRAM",
    "YOUR_PROGRAM_ID",
    "11111111111111111111111111111111",
  ]);
  for (const k of known) {
    if (upper === k) return true;
  }
  return upper.includes("PLACEHOLDER") || upper.startsWith("YOUR_");
}
