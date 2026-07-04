import { Connection, PublicKey } from "@solana/web3.js";
import type { Logger } from "pino";
import type { CoordinatorConfig } from "../config.js";
import type { OrderService } from "../services/order-service.js";
import { observeListenerEventProcessing, recordListenerProgress } from "../metrics.js";

/**
 * Confirmation level constants for Solana commitment model.
 * - processed: seen by the node, not yet voted on (highest risk of fork)
 * - confirmed:  voted on by supermajority, very likely final (~0.5s)
 * - finalized:  max lockout reached, irreversible (~12s)
 */
export const CONFIRMATION_LEVELS = ["processed", "confirmed", "finalized"] as const;
export type ConfirmationLevel = (typeof CONFIRMATION_LEVELS)[number];

/**
 * Number of slots behind the current finalized slot before a transaction
 * in `pendingSlots` is considered sufficiently finalized and safe to process.
 * Solana's supermajority vote lockout reaches max after ~32 slots.
 */
export const FINALIZATION_SLOTS = 32;

/**
 * Slot regression threshold: if the newly observed confirmed slot has
 * fallen more than this many slots below the previous observed slot,
 * we treat it as evidence of a fork/reorg and roll back affected orders.
 */
const REGRESSION_THRESHOLD = 5;

/**
 * Maximum age (in slots relative to the finalized slot) for entries to
 * stay in `pendingSlots`. Older entries are pruned to bound memory growth.
 */
const PENDING_SLOTS_MAX_AGE = 200;

/**
 * Polls the Solana RPC for HTLC program logs and feeds order events into
 * the OrderService with full reorg/fork awareness.
 *
 * Reorg safety model
 * ------------------
 * Solana validators produce forks: a confirmed slot can be reverted if the
 * supermajority never votes it to max lockout.  We guard against this with
 * a two-stage pipeline:
 *
 *   1. Fetch new signatures at the `confirmed` commitment level and queue
 *      them in `pendingSlots` (slot → [{sig, logs}]).
 *   2. Only drain (process) entries whose slot has reached
 *      `finalizedSlot - FINALIZATION_SLOTS`.  Transactions in those slots
 *      are irreversible.
 *   3. On each poll compare the new confirmed slot to the previous one.
 *      If it regressed by more than REGRESSION_THRESHOLD we know a fork
 *      occurred: we drop pending entries in the regressed range and roll
 *      back any already-processed orders whose `srcLockBlock` falls in
 *      that range.
 *
 * Mirrors the pattern of EthereumListener / SorobanListener.
 */
export class SolanaListener {
  private readonly connection: Connection;
  private readonly log: Logger;
  private stopped = false;

  /** Last confirmed slot we observed — used to detect regressions. */
  private lastSlot = 0;

  /**
   * Confirmation queue: slot number → array of {sig, logs} objects seen at
   * `confirmed` commitment but not yet finalized.
   */
  private readonly pendingSlots: Map<number, Array<{ sig: string; logs: string[] }>> =
    new Map();

  /**
   * Index of already-processed orders keyed by the Solana slot in which
   * they were recorded.  Used to roll back src locks when a slot regresses.
   * slot → [publicId, ...]
   */
  private readonly processedBySlot: Map<number, string[]> = new Map();

  constructor(
    private readonly cfg: CoordinatorConfig,
    private readonly orders: OrderService,
    log: Logger
  ) {
    this.log = log.child({ component: "SolanaListener" });
    this.connection = new Connection(cfg.solana.rpcUrl, cfg.solana.commitment);
  }

  start(): void {
    if (!this.cfg.solana.programId || this.cfg.solana.programId === "PLACEHOLDER") {
      this.log.warn("SOLANA_HTLC_PROGRAM not configured - Solana listener disabled");
      return;
    }
    this.log.info({ program: this.cfg.solana.programId }, "Solana listener starting");
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
  }

  /** Returns the number of slot buckets currently waiting for finalization. */
  getPendingSlotCount(): number {
    return this.pendingSlots.size;
  }

  // ---------------------------------------------------------------------------
  // Main poll loop
  // ---------------------------------------------------------------------------

  private async loop(): Promise<void> {
    const programPk = new PublicKey(this.cfg.solana.programId);

    while (!this.stopped) {
      try {
        await this.poll(programPk);
      } catch (err) {
        this.log.warn({ err }, "Solana poll failed");
      }

      await new Promise<void>((r) => setTimeout(r, this.cfg.pollIntervalMs));
    }
  }

  private async poll(programPk: PublicKey): Promise<void> {
    const startedAt = Date.now();

    // --- Step a: fetch both commitment levels to measure the gap -----------
    const [finalizedSlot, confirmedSlot] = await Promise.all([
      this.connection.getSlot("finalized"),
      this.connection.getSlot("confirmed"),
    ]);

    // --- Step b: detect slot regression ------------------------------------
    if (this.lastSlot > 0 && confirmedSlot < this.lastSlot - REGRESSION_THRESHOLD) {
      this.log.warn(
        { confirmedSlot, lastSlot: this.lastSlot, finalizedSlot },
        "Solana slot regression detected"
      );
      await this.handleRegression(confirmedSlot);
    }

    // --- Step c: fetch new signatures at `confirmed` and queue them --------
    const sigs = await this.connection.getSignaturesForAddress(programPk, {
      limit: 50,
    });

    for (const sigInfo of sigs) {
      // Skip anything we have already seen or that reports an on-chain error.
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

      // Queue under the transaction's actual slot.
      const slot = sigInfo.slot;
      if (!this.pendingSlots.has(slot)) {
        this.pendingSlots.set(slot, []);
      }
      this.pendingSlots.get(slot)!.push({ sig: sigInfo.signature, logs });
    }

    // Update lastSlot to the highest slot seen across all returned sigs.
    if (sigs.length > 0) {
      this.lastSlot = Math.max(this.lastSlot, ...sigs.map((s) => s.slot));
    } else if (this.lastSlot === 0) {
      // First poll with no events yet — anchor to current confirmed slot.
      this.lastSlot = confirmedSlot;
    }

    // --- Step d: drain finalized slots from the pending queue --------------
    const drainBefore = finalizedSlot - FINALIZATION_SLOTS;
    for (const [slot, txList] of this.pendingSlots) {
      if (slot > drainBefore) continue; // not finalized yet

      for (const { sig, logs } of txList) {
        this.handleLogs(sig, logs, slot);
      }
      this.pendingSlots.delete(slot);
    }

    // --- Step e: prune entries too old to ever be useful -------------------
    const pruneOlderThan = finalizedSlot - PENDING_SLOTS_MAX_AGE;
    for (const slot of this.pendingSlots.keys()) {
      if (slot < pruneOlderThan) {
        this.log.debug({ slot, pruneOlderThan }, "pruning stale pending slot");
        this.pendingSlots.delete(slot);
      }
    }

    // Also prune processedBySlot entries that are far behind finalized.
    for (const slot of this.processedBySlot.keys()) {
      if (slot < pruneOlderThan) {
        this.processedBySlot.delete(slot);
      }
    }

    recordListenerProgress("solana", this.lastSlot, confirmedSlot);
    observeListenerEventProcessing("solana", "poll", startedAt);
  }

  // ---------------------------------------------------------------------------
  // Reorg / fork handling
  // ---------------------------------------------------------------------------

  /**
   * Called when the confirmed slot regresses below `lastSlot - REGRESSION_THRESHOLD`.
   *
   * Actions:
   *  1. Remove pending (unprocessed) transactions in the regressed slot range
   *     from `pendingSlots` — they may have been on a fork that was abandoned.
   *  2. Roll back any orders that were already processed (srcLock recorded)
   *     whose `srcLockBlock` falls in the regressed range.
   *
   * @param newConfirmedSlot  The newly observed (lower) confirmed slot.
   */
  private async handleRegression(newConfirmedSlot: number): Promise<void> {
    const regressionStart = newConfirmedSlot + 1; // slots above newConfirmedSlot may be forked
    const regressionEnd = this.lastSlot;

    // 1. Drop pending transactions in the regressed range — they may not exist
    //    on the canonical fork.
    let droppedPending = 0;
    for (let slot = regressionStart; slot <= regressionEnd; slot++) {
      if (this.pendingSlots.has(slot)) {
        droppedPending += this.pendingSlots.get(slot)!.length;
        this.pendingSlots.delete(slot);
      }
    }
    if (droppedPending > 0) {
      this.log.warn(
        { regressionStart, regressionEnd, droppedPending },
        "dropped pending transactions in regressed slot range"
      );
    }

    // 2. Roll back already-processed orders whose srcLockBlock is in the range.
    for (let slot = regressionStart; slot <= regressionEnd; slot++) {
      const publicIds = this.processedBySlot.get(slot);
      if (!publicIds || publicIds.length === 0) continue;

      for (const publicId of publicIds) {
        try {
          await this.orders.rollbackSrcLock(publicId);
          this.log.warn(
            { publicId, slot, regressionStart, regressionEnd },
            "rolled back src lock due to Solana slot regression"
          );
        } catch (err) {
          this.log.warn({ err, publicId, slot }, "could not rollback src lock for regressed slot");
        }
      }
      this.processedBySlot.delete(slot);
    }

    // Reset lastSlot to the new confirmed slot so future regression checks
    // use the correct baseline.
    this.lastSlot = newConfirmedSlot;
  }

  // ---------------------------------------------------------------------------
  // Log parsing (unchanged from original implementation)
  // ---------------------------------------------------------------------------

  /**
   * Parse Anchor program log lines and forward recognised events to OrderService.
   * Anchor emits: `Program log: Instruction: <name>` and data lines.
   *
   * Expected log format (base64-encoded Anchor event data):
   *   Program log: {"hashlock":"0x...","orderId":"...","timelock":...}
   *
   * Until the Anchor IDL is finalised, we extract JSON payloads carried
   * in "Program data:" lines - the Anchor event discriminator prefix is
   * stripped so any shape of payload is accepted as long as it contains
   * the fields we need.
   */
  private handleLogs(sig: string, logs: string[], slot?: number): void {
    let eventType: string | null = null;
    const payload: Record<string, unknown> = {};

    for (const line of logs) {
      if (line.includes("OrderCreated"))  { eventType = "OrderCreated"; }
      if (line.includes("OrderClaimed"))  { eventType = "OrderClaimed"; }
      if (line.includes("OrderRefunded")) { eventType = "OrderRefunded"; }

      // Try to pick up a JSON payload from any log line (Anchor emits them as
      // "Program log: {.}" or "Program data: {.}").
      const jsonMatch = line.match(/\{.*\}/);
      if (jsonMatch) {
        try {
          Object.assign(payload, JSON.parse(jsonMatch[0]));
        } catch { /* not JSON - skip */ }
      }
    }

    if (!eventType) return;

    this.log.info({ sig, event: eventType, payload }, "Solana HTLC event");

    if (eventType === "OrderCreated") {
      const hashlock = payload.hashlock as string | undefined;
      const orderId  = payload.orderId  as string | undefined;
      const timelock = payload.timelock as number | undefined;

      if (!hashlock || !orderId || timelock === null || timelock === undefined) {
        this.log.warn({ sig, payload }, "OrderCreated missing required fields - cannot record src lock");
        return;
      }

      const effectiveSlot = slot ?? this.lastSlot;

      void (async () => {
        try {
          const order = await this.orders.findByHashlock(hashlock);
          if (!order) {
            this.log.info({ hashlock, orderId }, "Solana order observed without local announce");
            return;
          }
          await this.orders.recordSrcLock({
            publicId: order.publicId,
            orderId,
            txHash: sig,
            blockNumber: effectiveSlot,
            timelock,
          });

          // Track the processed order under its slot for regression rollback.
          if (!this.processedBySlot.has(effectiveSlot)) {
            this.processedBySlot.set(effectiveSlot, []);
          }
          this.processedBySlot.get(effectiveSlot)!.push(order.publicId);
        } catch (err) {
          this.log.warn({ err, hashlock }, "could not record Solana src lock");
        }
      })();
    }

    if (eventType === "OrderClaimed") {
      const preimage = payload.preimage as string | undefined;
      const orderId  = payload.orderId  as string | undefined;
      if (preimage && orderId) {
        void (async () => {
          try {
            const order = await this.orders.findBySrcOrderId("solana", orderId);
            if (order) {
              await this.orders.recordSecret(order.publicId, preimage, sig);
            }
          } catch (err) {
            this.log.warn({ err, orderId }, "could not record Solana secret");
          }
        })();
      }
    }

    if (eventType === "OrderRefunded") {
      const orderId = payload.orderId as string | undefined;
      if (orderId) {
        void (async () => {
          try {
            const order = await this.orders.findBySrcOrderId("solana", orderId);
            if (order) {
              await this.orders.markStatus(order.publicId, "refunded");
            }
          } catch (err) {
            this.log.warn({ err, orderId }, "could not mark Solana order refunded");
          }
        })();
      }
    }
  }
}
