import { Connection, PublicKey } from "@solana/web3.js";
import type { Logger } from "pino";
import type { CoordinatorConfig } from "../config.js";
import type { OrderService } from "../services/order-service.js";
import { observeListenerEventProcessing, recordListenerProgress } from "../metrics.js";
import { CursorStore } from "../utils/cursor-store.js";

const CURSOR_LABEL = "solana-listener";

/**
 * Polls the Solana RPC for HTLC program logs and feeds order events into
 * the OrderService. Mirrors the pattern of EthereumListener and SorobanListener.
 *
 * Until the Anchor program is deployed this listener is automatically
 * disabled (programId === "PLACEHOLDER") and logs a single warning.
 *
 * The last processed slot is persisted to disk so restarts resume scanning
 * from the correct position instead of starting from the current slot head
 * and silently missing events that landed while the service was offline.
 */
export class SolanaListener {
  private readonly connection: Connection;
  private readonly log: Logger;
  private readonly cursorStore: CursorStore;
  private stopped = false;
  private lastSlot = 0;

  constructor(
    private readonly cfg: CoordinatorConfig,
    private readonly orders: OrderService,
    log: Logger,
    cursorStore?: CursorStore
  ) {
    this.log = log.child({ component: "SolanaListener" });
    this.connection = new Connection(cfg.solana.rpcUrl, cfg.solana.commitment);
    this.cursorStore = cursorStore ?? new CursorStore();
  }

  start(): void {
    if (!this.cfg.solana.programId || this.cfg.solana.programId === "PLACEHOLDER") {
      this.log.warn("SOLANA_HTLC_PROGRAM not configured - Solana listener disabled");
      return;
    }

    // Restore last processed slot so we don't miss slots that arrived
    // while the process was offline.
    const persisted = this.cursorStore.load(CURSOR_LABEL);
    if (persisted !== null && typeof persisted === "number" && persisted > 0) {
      this.lastSlot = persisted;
      this.log.info(
        { program: this.cfg.solana.programId, lastSlot: this.lastSlot },
        "Solana listener starting (slot restored)"
      );
    } else {
      this.log.info({ program: this.cfg.solana.programId }, "Solana listener starting");
    }

    void this.loop();
  }

  stop(): void {
    this.stopped = true;
  }

  private async loop(): Promise<void> {
    const programPk = new PublicKey(this.cfg.solana.programId);

    while (!this.stopped) {
      try {
        const startedAt = Date.now();
        const slot = await this.connection.getSlot(this.cfg.solana.commitment);

        // Seed lastSlot on first run when no persisted value was available.
        if (this.lastSlot === 0) {
          this.lastSlot = slot - 1;
          // Immediately persist the seed so that even a clean-start is
          // recorded; this also makes the cursor available to tests that
          // want to verify persistence without needing newer signatures.
          try {
            this.cursorStore.save(CURSOR_LABEL, this.lastSlot);
          } catch (saveErr) {
            this.log.warn({ err: saveErr }, "failed to persist Solana slot cursor (seed)");
          }
        }

        // Fetch confirmed signatures for the program since our last processed slot.
        const sigs = await this.connection.getSignaturesForAddress(programPk, {
          limit: 50,
        });

        for (const sigInfo of sigs) {
          if (sigInfo.slot <= this.lastSlot) continue;
          if (sigInfo.err) continue;

          try {
            const tx = await this.connection.getParsedTransaction(sigInfo.signature, {
              commitment: "confirmed",
              maxSupportedTransactionVersion: 0,
            });

            if (!tx?.meta?.logMessages) continue;

            // Parse log messages emitted by the Anchor program.
            this.handleLogs(sigInfo.signature, tx.meta.logMessages);
          } catch (txErr) {
            this.log.warn({ sig: sigInfo.signature, err: txErr }, "failed to fetch tx");
          }
        }

        if (sigs.length > 0) {
          const newSlot = Math.max(...sigs.map((s) => s.slot));
          if (newSlot > this.lastSlot) {
            this.lastSlot = newSlot;
            // Persist after a successful scan so restarts resume from here.
            try {
              this.cursorStore.save(CURSOR_LABEL, this.lastSlot);
            } catch (saveErr) {
              this.log.warn({ err: saveErr }, "failed to persist Solana slot cursor");
            }
          }
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
  private handleLogs(sig: string, logs: string[]): void {
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
            blockNumber: this.lastSlot,
            timelock,
          });
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
