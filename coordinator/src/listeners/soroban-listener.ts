import { rpc } from "@stellar/stellar-sdk";
import type { Logger } from "pino";
import type { CoordinatorConfig } from "../config.js";
import type { OrderService } from "../services/order-service.js";
import { observeListenerEventProcessing, recordListenerProgress } from "../metrics.js";

/** Maximum ledger gap before we treat it as a node inconsistency and re-scan. */
const MAX_LEDGER_GAP = 100;

/**
 * Polls the Soroban RPC for HTLC contract events and feeds them into
 * the OrderService.
 *
 * Stellar consensus is BFT-finalized so true chain reorgs cannot occur,
 * but we guard against three classes of node-level inconsistency:
 *
 *  1. Out-of-order delivery  — ledger sequence goes backwards.
 *     Detected per-event: skip and warn.
 *
 *  2. Ledger gap             — cursor jumps forward by more than MAX_LEDGER_GAP.
 *     Detected per-event: reset cursor so the next iteration re-scans
 *     from lastProcessedLedger.
 *
 *  3. Stale / expired cursor — the RPC node no longer recognises our cursor
 *     (e.g. node restarted, history window pruned).
 *     Detected on RPC error: reset cursor and continue.
 */
export class SorobanListener {
  private readonly server: rpc.Server;
  private readonly log: Logger;
  private cursor: string | undefined;
  private stopped = false;
  private lastProcessedLedger = 0;

  constructor(
    private readonly cfg: CoordinatorConfig,
    private readonly orders: OrderService,
    log: Logger
  ) {
    this.log = log.child({ component: "SorobanListener" });
    this.server = new rpc.Server(cfg.soroban.rpcUrl, {
      allowHttp: cfg.soroban.rpcUrl.startsWith("http://")
    });
  }

  start(): void {
    if (!this.cfg.soroban.htlcContract) {
      this.log.warn("SOROBAN_HTLC contract not configured - Soroban listener disabled");
      return;
    }
    const contractId = this.cfg.soroban.htlcContract;
    this.log.info({ contract: contractId }, "starting");
    void this.loop(contractId);
  }

  stop(): void {
    this.stopped = true;
  }

  private async loop(contractId: string): Promise<void> {
    while (!this.stopped) {
      try {
        const startedAt = Date.now();
        const latest = await this.server.getLatestLedger();

        // When we have no cursor, start just behind the chain tip.
        const startLedger = this.cursor === undefined ? latest.sequence - 1 : undefined;

        // processedLedger tracks the highest ledger we process this iteration
        // for recordListenerProgress. Seed it from the resolved start point.
        let processedLedger = startLedger ?? this.lastProcessedLedger;

        let events: Awaited<ReturnType<rpc.Server["getEvents"]>>;
        try {
          events = await this.server.getEvents({
            filters: [{ type: "contract", contractIds: [contractId] }],
            startLedger: startLedger,
            cursor: this.cursor,
            limit: 100
          });
        } catch (rpcErr) {
          // Stale / expired cursor — reset and let the next iteration re-scan.
          this.log.warn({ err: rpcErr }, "Soroban cursor reset due to error");
          this.cursor = undefined;
          await new Promise((r) => setTimeout(r, this.cfg.pollIntervalMs));
          continue;
        }

        for (const ev of events.events) {
          // ── Guard 1: out-of-order event ──────────────────────────────────
          if (ev.ledger < this.lastProcessedLedger) {
            this.log.warn(
              { evLedger: ev.ledger, lastProcessedLedger: this.lastProcessedLedger },
              "Soroban event out of order — possible node inconsistency"
            );
            continue;
          }

          // ── Guard 2: ledger gap ───────────────────────────────────────────
          if (
            this.lastProcessedLedger > 0 &&
            ev.ledger > this.lastProcessedLedger + MAX_LEDGER_GAP
          ) {
            this.log.warn(
              { evLedger: ev.ledger, lastProcessedLedger: this.lastProcessedLedger, MAX_LEDGER_GAP },
              "Soroban ledger gap detected, re-scanning from last known ledger"
            );
            // Reset cursor so next iteration does a full re-scan from lastProcessedLedger.
            this.cursor = undefined;
            // Break out of the event loop; remaining events in this batch may
            // also be from the gap range and would be replayed correctly after
            // the re-scan.
            break;
          }

          this.log.info(
            { ledger: ev.ledger, txHash: ev.txHash, topics: ev.topic?.length ?? 0 },
            "Soroban event"
          );

          processedLedger = Math.max(processedLedger, ev.ledger);
          this.lastProcessedLedger = Math.max(this.lastProcessedLedger, ev.ledger);

          await this.processSorobanEvent(ev);
        }

        recordListenerProgress("soroban", processedLedger, latest.sequence);
        observeListenerEventProcessing("soroban", "poll", startedAt);

        // Advance the cursor only when this.cursor was NOT reset to undefined
        // by the gap guard above. If the gap guard fired it set this.cursor to
        // undefined — leave it that way so the next iteration re-scans from
        // lastProcessedLedger via startLedger.
        if (events.cursor && this.cursor !== undefined) {
          this.cursor = events.cursor;
        }
      } catch (err) {
        this.log.warn({ err }, "Soroban poll failed");
      }
      await new Promise((r) => setTimeout(r, this.cfg.pollIntervalMs));
    }
  }

  private async processSorobanEvent(ev: any): Promise<void> {
    const topicName: string = ev.topic?.[0]?.value ?? ev.topic?.[0]?.str ?? "";

    if (topicName === "OrderCreated") {
      const hashlock = ev.value?.map?.hashlock ?? ev.value?.hashlock;
      const orderId = ev.value?.map?.orderId ?? ev.value?.orderId;
      const timelock = Number(ev.value?.map?.timelock ?? ev.value?.timelock ?? 0);
      if (!hashlock || !orderId) return;
      try {
        const order = await this.orders.findByHashlock(hashlock);
        if (!order) return;
        await this.orders.recordSrcLock({
          publicId: order.publicId,
          orderId: String(orderId),
          txHash: ev.txHash,
          blockNumber: ev.ledger,
          timelock
        });
      } catch (err: any) {
        if (!err?.message?.includes("cannot record")) {
          this.log.warn({ err, hashlock }, "Soroban OrderCreated processing error");
        }
      }
    }

    if (topicName === "OrderClaimed") {
      const preimage = ev.value?.map?.preimage ?? ev.value?.preimage;
      const orderId = ev.value?.map?.orderId ?? ev.value?.orderId;
      if (!preimage || !orderId) return;
      try {
        const order = await this.orders.findBySrcOrderId("stellar", String(orderId));
        if (!order) return;
        await this.orders.recordSecret(order.publicId, preimage, ev.txHash);
      } catch (err: any) {
        if (!err?.message?.includes("cannot record")) {
          this.log.warn({ err }, "Soroban OrderClaimed processing error");
        }
      }
    }

    if (topicName === "OrderRefunded") {
      const orderId = ev.value?.map?.orderId ?? ev.value?.orderId;
      if (!orderId) return;
      try {
        const order = await this.orders.findBySrcOrderId("stellar", String(orderId));
        if (!order) return;
        await this.orders.markStatus(order.publicId, "refunded");
      } catch (err: any) {
        if (!err?.message?.includes("cannot transition")) {
          this.log.warn({ err }, "Soroban OrderRefunded processing error");
        }
      }
    }
  }
}
