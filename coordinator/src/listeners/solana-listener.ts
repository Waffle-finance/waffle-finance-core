import { PublicKey } from "@solana/web3.js";
import type { Logger } from "pino";
import type { CoordinatorConfig } from "../config.js";
import type { OrderService } from "../services/order-service.js";
import {
  observeListenerEventProcessing,
  recordListenerProgress,
  workflowDispatchDecisions,
} from '../metrics.js';
import { isSolanaPlaceholder } from '../config.js';
import { decideDispatch } from '../services/workflow-priority-policy.js';
import { SolanaRpcProvider, createSolanaRpcProvider } from '@wafflefinance/sdk';

/**
 * Confirmation level constants for Solana commitment model.
 * - processed: seen by the node, not yet voted on (highest risk of fork)
 * - confirmed:  voted on by supermajority, very likely final (~0.5s)
 * - finalized:  max lockout reached, irreversible (~12s)
 */
export const CONFIRMATION_LEVELS = ['processed', 'confirmed', 'finalized'] as const;
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
 * Maximum age (in slots relative to the finalized slot) for processed-order
 * rollback metadata. Older entries can no longer be affected by a fork.
 */
const PROCESSED_SLOT_INDEX_MAX_AGE = 200;

/**
 * Maximum number of processed signature keys in the in-process dedup cache.
 * Bounded to avoid unbounded memory growth in long-running processes.
 */
const DEDUP_CACHE_MAX = 10_000;

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
 *      them in `pendingSlots` (slot → [{sig}]).
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
  private readonly rpcProvider: SolanaRpcProvider;
  private readonly log: Logger;
  private stopped = false;
  private timeoutId: ReturnType<typeof setTimeout> | undefined;

  /** Last confirmed slot we observed — used to detect regressions. */
  private lastSlot = 0;

  /**
   * Confirmation queue: slot number → signatures seen at `confirmed`
   * commitment but not yet applied to coordinator state.
   */
  private readonly pendingSlots: Map<number, Array<{ sig: string }>> =
    new Map();

  /**
   * Index of already-processed orders keyed by the Solana slot in which
   * they were recorded.  Used to roll back src locks when a slot regresses.
   * slot → [publicId, ...]
   */
  private readonly processedBySlot: Map<number, string[]> = new Map();

  /**
   * In-process event deduplication cache.
   * Key: transaction signature (unique per on-chain transaction).
   * Bounded at DEDUP_CACHE_MAX entries; oldest evicted on overflow.
   */
  private readonly processedSigs = new Map<string, true>();

  constructor(
    private readonly cfg: CoordinatorConfig,
    private readonly orders: OrderService,
    log: Logger
  ) {
    this.log = log.child({ component: "SolanaListener" });
    this.rpcProvider = createSolanaRpcProvider(
      cfg.solana.rpcUrl,
      cfg.solana.commitment,
      { maxConsecutiveErrors: 3, recoveryWindowMs: 30_000 }
    );
  }

  start(): void {
    if (isSolanaPlaceholder(this.cfg.solana.programId)) {
      this.log.warn(
        { programId: this.cfg.solana.programId },
        'SOLANA_HTLC_PROGRAM is a placeholder — Solana listener disabled'
      );
      return;
    }
    this.log.info({ program: this.cfg.solana.programId }, 'Solana listener starting');
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    if (this.timeoutId !== undefined) {
      clearTimeout(this.timeoutId);
      this.timeoutId = undefined;
    }
  }

  /** Returns the number of slot buckets currently waiting for finalization. */
  getPendingSlotCount(): number {
    return this.pendingSlots.size;
  }

  /**
   * Returns the current health of the underlying RPC provider.
   * Exposes degraded state for /health endpoint and metrics (#713).
   */
  getRpcHealth() {
    return this.rpcProvider.getHealth();
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
        this.log.warn({ err }, 'Solana poll failed');
      }

      await new Promise<void>(r => {
        this.timeoutId = setTimeout(r, this.cfg.pollIntervalMs);
      });
    }
  }

  private async poll(programPk: PublicKey): Promise<void> {
    const startedAt = Date.now();

    // --- Step a: fetch both commitment levels to measure the gap -----------
    // All RPC calls are routed through the provider so a degraded primary
    // endpoint transparently falls back to a configured secondary (#713).
    const [finalizedSlot, confirmedSlot] = await Promise.all([
      this.rpcProvider.withFallback(conn => conn.getSlot('finalized'), 'getSlot(finalized)'),
      this.rpcProvider.withFallback(conn => conn.getSlot('confirmed'), 'getSlot(confirmed)'),
    ]);

    // Report RPC provider health for degraded-mode detection.
    const providerHealth = this.rpcProvider.getHealth();
    if (providerHealth.degraded) {
      this.log.warn(
        { activeEndpoint: providerHealth.activeEndpoint, endpoints: providerHealth.endpoints },
        'Solana RPC provider is degraded — running on fallback endpoint'
      );
    }

    // --- Step b: detect slot regression ------------------------------------
    if (this.lastSlot > 0 && confirmedSlot < this.lastSlot - REGRESSION_THRESHOLD) {
      this.log.warn(
        { confirmedSlot, lastSlot: this.lastSlot, finalizedSlot },
        'Solana slot regression detected'
      );
      await this.handleRegression(confirmedSlot);
    }

    // --- Step c: fetch new signatures at `confirmed` and queue them --------
    const sigs = await this.rpcProvider.withFallback(
      conn => conn.getSignaturesForAddress(programPk, { limit: 50 }),
      'getSignaturesForAddress'
    );

    for (const sigInfo of sigs) {
      // Skip anything we have already seen or that reports an on-chain error.
      if (sigInfo.slot <= this.lastSlot) continue;
      if (sigInfo.err) continue;

      // ── Dedup at queue time (#714) ────────────────────────────────────
      // Reject signatures already in the pending queue or already fully
      // processed.  This prevents double-queueing on overlapping poll windows
      // and on restart when the same signatures are returned again.
      if (this.isDuplicate(sigInfo.signature)) {
        this.log.debug(
          { sig: sigInfo.signature },
          'Solana event duplicate skipped (in-process cache) during queue'
        );
        continue;
      }
      if (this.isInPendingSlots(sigInfo.signature)) {
        this.log.debug(
          { sig: sigInfo.signature, slot: sigInfo.slot },
          'Solana event already queued in pendingSlots — skipping'
        );
        continue;
      }

      // Queue the signature before fetching its transaction. RPC indexing can
      // lag signature discovery; losing the entry here would mean lastSlot
      // advances past a transaction we never process.
      const slot = sigInfo.slot;
      if (!this.pendingSlots.has(slot)) {
        this.pendingSlots.set(slot, []);
      }
      this.pendingSlots.get(slot)!.push({ sig: sigInfo.signature });
    }

    // Update lastSlot to the highest slot seen across all returned sigs.
    if (sigs.length > 0) {
      this.lastSlot = Math.max(this.lastSlot, ...sigs.map(s => s.slot));
    } else if (this.lastSlot === 0) {
      // First poll with no events yet — anchor to current confirmed slot.
      this.lastSlot = confirmedSlot;
    }

    // --- Step d: drain finalized slots from the pending queue --------------
    const drainBefore = finalizedSlot - FINALIZATION_SLOTS;
    for (const [slot, txList] of this.pendingSlots) {
      if (slot > drainBefore) continue; // not finalized yet

      const retry: Array<{ sig: string }> = [];
      for (const { sig } of txList) {
        if (this.isDuplicate(sig)) continue;

        let tx;
        try {
          tx = await this.rpcProvider.withFallback(
            (conn) =>
              conn.getParsedTransaction(sig, {
                commitment: "confirmed",
                maxSupportedTransactionVersion: 0,
              }),
            `getParsedTransaction(${sig.slice(0, 8)}…)`
          );
        } catch (txErr) {
          this.log.warn({ sig, err: txErr }, "failed to fetch finalized Solana transaction; keeping it queued");
          retry.push({ sig });
          continue;
        }

        // Keep signatures whose transaction is not indexed yet. Once it is
        // available, inspect the transaction's actual execution result before
        // applying any service-side order mutation.
        if (!tx) {
          retry.push({ sig });
          continue;
        }
        if (tx.meta?.err) {
          this.log.warn({ sig, err: tx.meta.err }, "Solana transaction failed on-chain; skipping order mutation");
          this.markSigProcessed(sig);
          continue;
        }

        const logs = tx.meta?.logMessages ?? [];
        try {
          const handled = await this.handleLogs(sig, logs, slot);
          if (handled) this.markSigProcessed(sig);
          else retry.push({ sig });
        } catch (err) {
          // handleLogs should convert persistence errors to `false`; retain
          // this guard so an unexpected failure also remains retryable.
          this.log.warn({ sig, err }, "failed to process finalized Solana transaction; keeping it queued");
          retry.push({ sig });
        }
      }
      if (retry.length > 0) this.pendingSlots.set(slot, retry);
      else this.pendingSlots.delete(slot);
    }

    // --- Step e: prune stale rollback metadata ------------------------------
    const pruneOlderThan = finalizedSlot - PROCESSED_SLOT_INDEX_MAX_AGE;
    // Unresolved finalized events are intentionally retained: pruning them
    // after a coordinator write failure would strand on-chain success from
    // off-chain state forever. Rollback metadata is still safely bounded.
    for (const slot of this.processedBySlot.keys()) {
      if (slot < pruneOlderThan) {
        this.processedBySlot.delete(slot);
      }
    }

    recordListenerProgress('solana', this.lastSlot, confirmedSlot);
    observeListenerEventProcessing('solana', 'poll', startedAt);
  }

  // ---------------------------------------------------------------------------
  // Event deduplication helpers
  // ---------------------------------------------------------------------------

  /** Returns true if this signature was already processed in-process. */
  isDuplicate(sig: string): boolean {
    return this.processedSigs.has(sig);
  }

  /**
   * Returns true if this signature is already queued in `pendingSlots`.
   * Prevents double-queueing the same transaction on overlapping poll windows.
   */
  isInPendingSlots(sig: string): boolean {
    for (const txList of this.pendingSlots.values()) {
      for (const entry of txList) {
        if (entry.sig === sig) return true;
      }
    }
    return false;
  }

  /** Mark a signature as processed; evicts oldest on overflow. */
  private markSigProcessed(sig: string): void {
    if (this.processedSigs.has(sig)) return;
    if (this.processedSigs.size >= DEDUP_CACHE_MAX) {
      const oldest = this.processedSigs.keys().next().value;
      if (oldest !== undefined) this.processedSigs.delete(oldest);
    }
    this.processedSigs.set(sig, true);
  }

  private completeSignature(sig: string): true {
    this.markSigProcessed(sig);
    return true;
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
        'dropped pending transactions in regressed slot range'
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
            'rolled back src lock due to Solana slot regression'
          );
        } catch (err) {
          this.log.warn({ err, publicId, slot }, 'could not rollback src lock for regressed slot');
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
  private async handleLogs(sig: string, logs: string[], slot?: number): Promise<boolean> {
    // ── In-process deduplication ────────────────────────────────────────────
    // If we have already processed this signature in the current process
    // lifetime, skip without touching the DB.
    if (this.isDuplicate(sig)) {
      this.log.debug({ sig }, "Solana event duplicate skipped (in-process cache)");
      return this.completeSignature(sig);
    }

    let eventType: string | null = null;
    const payload: Record<string, unknown> = {};

    for (const line of logs) {
      if (line.includes('OrderCreated')) {
        eventType = 'OrderCreated';
      }
      if (line.includes('OrderClaimed')) {
        eventType = 'OrderClaimed';
      }
      if (line.includes('OrderRefunded')) {
        eventType = 'OrderRefunded';
      }

      // Try to pick up a JSON payload from any log line (Anchor emits them as
      // "Program log: {.}" or "Program data: {.}").
      const jsonMatch = line.match(/\{.*\}/);
      if (jsonMatch) {
        try {
          Object.assign(payload, JSON.parse(jsonMatch[0]));
        } catch {
          /* not JSON - skip */
        }
      }
    }

    if (!eventType) return this.completeSignature(sig);

    this.log.info({ sig, event: eventType, payload }, 'Solana HTLC event');

    if (eventType === 'OrderCreated') {
      const hashlock = (payload.hashlock ?? payload.hash_lock) as string | undefined;
      const orderId = (payload.orderId ?? payload.order_id) as string | undefined;
      const timelock = (payload.timelock ?? payload.time_lock) as number | undefined;

      if (!hashlock || !orderId || timelock === null || timelock === undefined) {
        this.log.warn({ sig, payload }, "OrderCreated missing required fields - cannot record src lock");
        return this.completeSignature(sig);
      }

      const effectiveSlot = slot ?? this.lastSlot;
      try {
        const order = await this.orders.findByHashlock(hashlock);
        if (!order) {
          this.log.info({ hashlock, orderId }, "Solana order observed without local announce");
          return this.completeSignature(sig);
        }
        const decision = decideDispatch({
          path: "live",
          mutation: "src_lock",
          incomingSequence: effectiveSlot,
          existingSequence: order.srcLockBlock,
          alreadyApplied: order.srcOrderId !== null,
        });
        workflowDispatchDecisions.inc({
          path: "live",
          mutation: "src_lock",
          outcome: decision.reason,
        });
        if (!decision.shouldApply) return this.completeSignature(sig);
        await this.orders.recordSrcLock({
          actor: "solana_listener",
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
        return this.completeSignature(sig);
      } catch (err) {
        this.log.warn({ err, hashlock }, "could not record Solana src lock; keeping event queued");
        return false;
      }
    }

    if (eventType === "OrderClaimed") {
      const preimage = payload.preimage as string | undefined;
      const orderId  = payload.orderId  as string | undefined;
      if (preimage && orderId) {
        try {
          const order = await this.orders.findBySrcOrderId("solana", orderId);
          if (!order) {
            this.log.info({ orderId, sig }, "Solana claim observed without local order");
            return this.completeSignature(sig);
          }
          const decision = decideDispatch({
            path: "live",
            mutation: "secret_reveal",
            incomingSequence: slot ?? null,
            existingSequence: null,
            alreadyApplied: order.preimage !== null,
          });
          workflowDispatchDecisions.inc({
            path: "live",
            mutation: "secret_reveal",
            outcome: decision.reason,
          });
          if (!decision.shouldApply) return this.completeSignature(sig);
          await this.orders.recordSecret(order.publicId, preimage, sig, null, "solana_listener");
          return this.completeSignature(sig);
        } catch (err) {
          this.log.warn({ err, orderId }, "could not record Solana secret; keeping event queued");
          return false;
        }
      }
      this.log.warn({ sig, payload }, "OrderClaimed missing required fields");
      return this.completeSignature(sig);
    }

    if (eventType === 'OrderRefunded') {
      const orderId = (payload.orderId ?? payload.order_id) as string | undefined;
      if (orderId) {
        try {
          const order = await this.orders.findBySrcOrderId("solana", orderId);
          if (!order) {
            this.log.info({ orderId, sig }, "Solana refund observed without local order");
            return this.completeSignature(sig);
          }
          const decision = decideDispatch({
            path: "live",
            mutation: "refund",
            incomingSequence: slot ?? null,
            existingSequence: order.srcLockBlock,
            alreadyApplied: order.status === "refunded" || order.status === "completed",
          });
          workflowDispatchDecisions.inc({
            path: "live",
            mutation: "refund",
            outcome: decision.reason,
          });
          if (!decision.shouldApply) return this.completeSignature(sig);
          await this.orders.markStatus(order.publicId, "refunded", "solana_listener");
          return this.completeSignature(sig);
        } catch (err) {
          this.log.warn({ err, orderId }, "could not mark Solana order refunded; keeping event queued");
          return false;
        }
      }
      this.log.warn({ sig, payload }, "OrderRefunded missing required fields");
      return this.completeSignature(sig);
    }

    return this.completeSignature(sig);
  }
}
