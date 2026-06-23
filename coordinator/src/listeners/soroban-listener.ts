import { rpc } from "@stellar/stellar-sdk";
import type { Logger } from "pino";
import type { CoordinatorConfig } from "../config.js";
import type { OrderService } from "../services/order-service.js";
import { observeListenerEventProcessing, recordListenerProgress } from "../metrics.js";

/**
 * Polls the Soroban RPC for HTLC contract events and feeds them into
 * the OrderService.
 */
export class SorobanListener {
  private readonly server: rpc.Server;
  private readonly log: Logger;
  private cursor: string | undefined;
  private stopped = false;

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
        const startLedger = this.cursor === undefined ? latest.sequence - 1 : undefined;
        let processedLedger = startLedger ?? latest.sequence;
        const events = await this.server.getEvents({
          filters: [{ type: "contract", contractIds: [contractId] }],
          startLedger: startLedger,
          cursor: this.cursor,
          limit: 100
        });

        for (const ev of events.events) {
          this.log.info(
            { ledger: ev.ledger, txHash: ev.txHash, topics: ev.topic?.length ?? 0 },
            "Soroban event"
          );
          processedLedger = Math.max(processedLedger, ev.ledger);
          await this.processSorobanEvent(ev);
        }
        recordListenerProgress("soroban", processedLedger, latest.sequence);
        observeListenerEventProcessing("soroban", "poll", startedAt);
        if (events.cursor) this.cursor = events.cursor;
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
