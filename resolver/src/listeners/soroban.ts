import { rpc, Address } from "@stellar/stellar-sdk";
import type { Logger } from "pino";
import type { SorobanConfig } from "../config.js";

/**
 * Polls the Soroban RPC for HTLC contract events.
 *
 * Soroban does not expose a websocket-style subscription yet, so we
 * poll `getEvents` every `pollIntervalMs`. The cursor is held in memory
 * — restarting the resolver re-fetches from the latest ledger, which is
 * fine because order state is durable on-chain.
 */
export class SorobanListener {
  private readonly server: rpc.Server;
  private readonly log: Logger;
  private readonly cfg: SorobanConfig;
  private readonly pollMs: number;
  private cursor: string | undefined;
  private stopped = false;
  private timeoutId?: ReturnType<typeof setTimeout>;

  constructor(cfg: SorobanConfig, pollMs: number, log: Logger) {
    this.cfg = cfg;
    this.pollMs = pollMs;
    this.log = log.child({ component: "SorobanListener" });
    this.server = new rpc.Server(cfg.rpcUrl, { allowHttp: cfg.rpcUrl.startsWith("http://") });
  }

  async start(handlers: SorobanEventHandlers): Promise<void> {
    if (!this.cfg.htlc) {
      this.log.warn("SOROBAN_HTLC contract id not configured — skipping Soroban listener");
      return;
    }
    this.stop();
    this.stopped = false;

    const contractId = this.cfg.htlc;
    this.log.info({ contract: contractId, rpc: this.cfg.rpcUrl }, "starting Soroban listener");

    const tick = async () => {
      if (this.stopped) return;
      try {
        const latest = await this.server.getLatestLedger();
        const startLedger = this.cursor === undefined ? latest.sequence - 1 : undefined;

        const req: rpc.Server.GetEventsRequest = {
          filters: [
            {
              type: "contract",
              contractIds: [contractId]
            }
          ],
          startLedger: startLedger,
          cursor: this.cursor,
          limit: 100
        };
        const events = await this.server.getEvents(req);

        for (const ev of events.events) {
          handlers.onContractEvent({
            ledger: Number(ev.ledger),
            txHash: ev.txHash,
            contractId: ev.contractId?.toString() ?? contractId,
            topics: ev.topic.map((t: any) => t.toXDR ? t.toXDR("base64") : String(t)),
            value: (ev.value as any)?.toXDR ? (ev.value as any).toXDR("base64") : String(ev.value)
          });
        }
        if (events.cursor) {
          this.cursor = events.cursor;
        }
      } catch (err) {
        this.log.warn({ err }, "Soroban poll failed");
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
  }
}

export interface SorobanRawEvent {
  ledger: number;
  txHash: string;
  contractId: string;
  topics: string[];
  value: string;
}

export interface SorobanEventHandlers {
  onContractEvent(e: SorobanRawEvent): void;
}
