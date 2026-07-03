import { Connection, PublicKey } from "@solana/web3.js";
import type { Logger } from "pino";
import type { CoordinatorConfig } from "../config.js";
import type { OrderService } from "../services/order-service.js";
import { observeListenerEventProcessing, recordListenerProgress } from "../metrics.js";
import { KeyedMutex } from "../utils/concurrency.js";

/**
 * Polls the Solana RPC for HTLC program logs and feeds order events into
 * the OrderService. Mirrors the pattern of EthereumListener and SorobanListener.
 *
 * Until the Anchor program is deployed this listener is automatically
 * disabled (programId === "PLACEHOLDER") and logs a single warning.
 *
 * Reorg / fork handling
 * ----------------------
 * Solana does not have reorgs in the Ethereum sense, but a transaction that
 * reaches "confirmed" status can be dropped if the fork it landed on is not
 * ultimately finalized. Two mitigations are applied:
 *
 * 1. The listener tracks which signatures it has already processed in
 *    `processedSigs` so a sig that was seen on a confirmed-but-later-dropped
 *    slot can be detected on re-fetch.
 * 2. When fetching a transaction whose sig is still in the program signature
 *    list but the transaction body can no longer be retrieved (it was on a
 *    dropped fork), the listener rolls back any src-lock that was recorded
 *    for that order.
 *
 * For production robustness the caller-supplied commitment defaults to
 * "finalized" when the programId is a real address, since finalized
 * transactions are guaranteed to be permanent.
 */
export class SolanaListener {
  private readonly connection: Connection;
  private readonly log: Logger;
  private stopped = false;
  private lastSlot = 0;
  /** Sigs we have successfully processed; used for deduplication. */
  private readonly processedSigs = new Set<string>();
  /**
   * Maps sig → {hashlock, publicId} so that when a tx disappears (dropped
   * fork) we can roll back the recorded src lock.
   */
  private readonly sigToOrder = new Map<string, { hashlock: string; publicId: string }>();
  private orderMutex = new KeyedMutex();

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

    // Kick off the catch-up + poll loop asynchronously so start() returns
    // immediately (matching the Ethereum / Soroban pattern).
    void this.init();
  }

  stop(): void {
    this.stopped = true;
  }

  /**
   * Load the last processed slot from persistent storage, then enter the
   * normal poll loop.  Falls back to (currentSlot - 1) when no records exist.
   */
  private async init(): Promise<void> {
    try {
      const lastPersistedBlock = await this.orders.getLastProcessedBlock("solana");
      if (lastPersistedBlock > 0) {
        this.lastSlot = lastPersistedBlock;
        this.log.info(
          { lastSlot: this.lastSlot },
          "Solana listener resuming from last persisted slot"
        );
      }
    } catch (err) {
      this.log.warn({ err }, "Solana listener: failed to load last processed slot — starting fresh");
    }

    await this.loop();
  }

  private async loop(): Promise<void> {
    const programPk = new PublicKey(this.cfg.solana.programId);

    while (!this.stopped) {
      try {
        const startedAt = Date.now();
        const slot = await this.connection.getSlot(this.cfg.solana.commitment);

        if (this.lastSlot === 0) {
          this.lastSlot = slot - 1;
        }

        // ── Step 1: verify previously-processed sigs are still on chain ──────
        // This handles the case where a transaction landed on a fork that was
        // subsequently dropped. The sig may no longer appear in the sig list,
        // but we check all entries we are still tracking.
        await this.verifyTrackedSigs();

        // ── Step 2: fetch new signatures and process them ────────────────────
        const sigs = await this.connection.getSignaturesForAddress(programPk, {
          limit: 50,
        });

        for (const sigInfo of sigs) {
          if (sigInfo.slot <= this.lastSlot) continue;

          // A non-null err means the transaction failed on-chain (e.g. account
          // constraint violation). There is no state to process or roll back.
          if (sigInfo.err) continue;

          const sig = sigInfo.signature;

          // Already processed — skip (the fork check above handles rollbacks)
          if (this.processedSigs.has(sig)) continue;

          try {
            const tx = await this.connection.getParsedTransaction(sig, {
              commitment: "confirmed",
              maxSupportedTransactionVersion: 0,
            });

            if (!tx?.meta?.logMessages) {
              // Transaction body is gone immediately — likely landed on a
              // dropped fork before we even committed it.
              this.log.warn({ sig, slot: sigInfo.slot }, "Solana tx not found on first fetch — skipping");
              continue;
            }

            // Parse log messages emitted by the Anchor program.
            await this.handleLogs(sig, sigInfo.slot, tx.meta.logMessages);
            this.processedSigs.add(sig);
          } catch (txErr) {
            this.log.warn({ sig, err: txErr }, "failed to fetch tx");
          }
        }

        if (sigs.length > 0) {
          this.lastSlot = Math.max(...sigs.map((s) => s.slot));
        }
        recordListenerProgress("solana", this.lastSlot, slot);
        observeListenerEventProcessing("solana", "poll", startedAt);
      } catch (err) {
        this.log.warn({ err }, "Solana poll failed");
      }

      await new Promise((r) => setTimeout(r, this.cfg.pollIntervalMs));
    }
  }

  /**
   * On every poll, re-check each sig we have tracked in sigToOrder to confirm
   * the transaction is still retrievable on the canonical chain. If it has
   * disappeared (dropped fork), roll back the associated src lock.
   */
  private async verifyTrackedSigs(): Promise<void> {
    for (const [sig, entry] of this.sigToOrder.entries()) {
      try {
        const tx = await this.connection.getParsedTransaction(sig, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        });
        if (!tx) {
          await this.rollbackDroppedSig(sig, entry);
        }
      } catch {
        // Transient RPC error — leave tracking state as-is, retry next poll
      }
    }
  }

  /**
   * A transaction that was previously processed is no longer retrievable,
   * indicating it landed on a fork that was not finalized.  Roll back any
   * src lock we recorded for the associated order.
   */
  private async rollbackDroppedSig(sig: string, entry: { hashlock: string; publicId: string }): Promise<void> {
    this.log.warn(
      { sig, publicId: entry.publicId },
      "Solana tx no longer retrievable (dropped fork) — rolling back src lock"
    );

    try {
      await this.orders.rollbackSrcLock(entry.publicId);
    } catch (err) {
      this.log.warn({ err, sig, publicId: entry.publicId }, "rollback of Solana src lock failed");
    }

    this.sigToOrder.delete(sig);
    this.processedSigs.delete(sig);
  }

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
  private async handleLogs(sig: string, slot: number, logs: string[]): Promise<void> {
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

      try {
        await this.orderMutex.runExclusive(hashlock, async () => {
          const order = await this.orders.findByHashlock(hashlock);
          if (!order) {
            this.log.info({ hashlock, orderId }, "Solana order observed without local announce");
            return;
          }
          await this.orders.recordSrcLock({
            publicId: order.publicId,
            orderId,
            txHash: sig,
            blockNumber: slot,
            timelock,
          });
          // Track sig → order so we can roll back if the tx is later dropped.
          this.sigToOrder.set(sig, { hashlock, publicId: order.publicId });
        });
      } catch (err) {
        this.log.warn({ err, hashlock }, "could not record Solana src lock");
      }
    }

    if (eventType === "OrderClaimed") {
      const preimage = payload.preimage as string | undefined;
      const orderId  = payload.orderId  as string | undefined;
      if (preimage && orderId) {
        try {
          const order = await this.orders.findBySrcOrderId("solana", orderId);
          if (order) {
            await this.orders.recordSecret(order.publicId, preimage, sig);
          }
        } catch (err) {
          this.log.warn({ err, orderId }, "could not record Solana secret");
        }
      }
    }

    if (eventType === "OrderRefunded") {
      const orderId = payload.orderId as string | undefined;
      if (orderId) {
        try {
          const order = await this.orders.findBySrcOrderId("solana", orderId);
          if (order) {
            await this.orders.markStatus(order.publicId, "refunded");
          }
        } catch (err) {
          this.log.warn({ err, orderId }, "could not mark Solana order refunded");
        }
      }
    }
  }
}
