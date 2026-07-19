import { rpc } from "@stellar/stellar-sdk";
import type { Logger } from "pino";
import type { ResolverConfig } from "../config.js";
import { retryRpcCall } from "../retry.js";
import {
  eventsTotal,
  listenerErrorsTotal,
  listenerPollDurationSeconds,
  listenerPollRunsTotal,
  listenerLastEventTimestampSeconds,
  activeListeners,
} from "../metrics.js";
import { SorobanCursorStore } from "../utils/cursor-store.js";
import {
  decodeSorobanHtlcEvent,
  SorobanEventDecodeError,
  type SorobanOrderCreatedEvent,
  type SorobanOrderClaimedEvent,
  type SorobanOrderRefundedEvent,
  type SorobanHtlcEvent,
} from "./soroban-events.js";

// Re-export all public types so callers can import from one place.
export type {
  SorobanOrderCreatedEvent,
  SorobanOrderClaimedEvent,
  SorobanOrderRefundedEvent,
  SorobanHtlcEvent,
  SorobanEventDecodeError,
} from "./soroban-events.js";

const CHAIN = "soroban";

export interface SorobanListenerOptions {
  /**
   * Pre-constructed cursor store.  When omitted the listener creates
   * its own store under `<cwd>/.soroban-cursor`.  Pass an explicit
   * instance (e.g. backed by a temp directory) in tests.
   */
  cursorStore?: SorobanCursorStore;
  /**
   * Label used as the cursor file key.  Defaults to
   * `"soroban-<htlc-contract-id>"` so that different contract
   * deployments keep independent cursor files.
   */
  cursorLabel?: string;
}

export interface SorobanEventHandlers {
  onOrderCreated(e: SorobanOrderCreatedEvent): void;
  onOrderClaimed(e: SorobanOrderClaimedEvent): void;
  onOrderRefunded(e: SorobanOrderRefundedEvent): void;
}

export class SorobanListener {
  private readonly server: rpc.Server;
  private readonly log: Logger;
  private readonly cfg: ResolverConfig;
  private readonly pollMs: number;
  private readonly cursorStore: SorobanCursorStore;
  private readonly cursorLabel: string;
  /** In-flight cursor — written to disk after every successful batch. */
  private cursor: string | undefined;
  private stopped = false;
  private timeoutId?: ReturnType<typeof setTimeout>;

  constructor(
    cfg: ResolverConfig,
    pollMs: number,
    log: Logger,
    options: SorobanListenerOptions = {},
  ) {
    this.cfg = cfg;
    this.pollMs = pollMs;
    this.log = log.child({ component: "SorobanListener" });
    this.server = new rpc.Server(cfg.soroban.rpcUrl, {
      allowHttp: cfg.soroban.rpcUrl.startsWith("http://"),
    });
    this.cursorStore =
      options.cursorStore ?? new SorobanCursorStore();
    this.cursorLabel =
      options.cursorLabel ??
      `soroban-${cfg.soroban.htlc ?? "unknown"}`;
  }

  async start(handlers: SorobanEventHandlers): Promise<void> {
    if (!this.cfg.soroban.htlc) {
      this.log.warn(
        "SOROBAN_HTLC contract id not configured — skipping Soroban listener",
      );
      return;
    }

    // Clear any existing timer from a previous start() call.
    this.stop();
    this.stopped = false;

    const contractId = this.cfg.soroban.htlc;

    // ------------------------------------------------------------------
    // Resume semantics: load the persisted cursor before the first poll.
    // If none exists the cursor stays undefined and fetchAndProcess()
    // anchors the query at the current ledger head.
    // ------------------------------------------------------------------
    const persisted = this.cursorStore.load(this.cursorLabel);
    if (persisted !== null) {
      this.cursor = persisted;
      this.log.info(
        { contract: contractId, cursor: this.cursor },
        "resuming Soroban listener from persisted cursor",
      );
    } else {
      this.cursor = undefined;
      this.log.info(
        { contract: contractId, rpc: this.cfg.soroban.rpcUrl },
        "starting Soroban listener from current ledger head (no persisted cursor)",
      );
    }

    activeListeners.set({ chain: CHAIN }, 1);

    const tick = async () => {
      if (this.stopped) return;
      const endTimer = listenerPollDurationSeconds.startTimer({ chain: CHAIN });
      try {
        await this.fetchAndProcess(contractId, handlers);
        endTimer();
        listenerPollRunsTotal.inc({ chain: CHAIN, result: "success" });
      } catch (err) {
        endTimer();
        listenerPollRunsTotal.inc({ chain: CHAIN, result: "failure" });
        listenerErrorsTotal.inc({ chain: CHAIN, error_type: "poll_error" });
        this.log.warn({ err }, "Soroban poll failed");
      } finally {
        if (!this.stopped) {
          this.timeoutId = setTimeout(tick, this.pollMs);
        }
      }
    };

    void tick();
  }

  private async fetchAndProcess(
    contractId: string,
    handlers: SorobanEventHandlers,
  ): Promise<void> {
    // When we have no cursor we need a startLedger to anchor the query.
    // Use (latestLedger - 1) so we don't miss in-flight events on the
    // very first poll but also don't replay the entire chain history.
    let startLedger: number | undefined;
    if (this.cursor === undefined) {
      const latest = await retryRpcCall(
        () => this.server.getLatestLedger(),
        { logger: this.log },
      );
      startLedger = latest.sequence - 1;
    }

    const req: rpc.Server.GetEventsRequest = {
      filters: [{ type: "contract", contractIds: [contractId] }],
      startLedger,
      cursor: this.cursor,
      limit: 100,
    };

    const events = await retryRpcCall(
      () => this.server.getEvents(req),
      { logger: this.log },
    );

    for (const ev of events.events) {
      eventsTotal.inc({ chain: CHAIN, event_type: "contract_event" });
      listenerLastEventTimestampSeconds.set(
        { chain: CHAIN },
        Math.floor(Date.now() / 1000),
      );

      // Serialise topics and value to base64 XDR so the decoder can
      // call xdr.ScVal.fromXDR() on them without needing the raw SDK
      // objects here.
      const topics: string[] = ev.topic.map((t: any) =>
        t.toXDR ? t.toXDR("base64") : String(t),
      );
      const rawValue: string = (ev.value as any)?.toXDR
        ? (ev.value as any).toXDR("base64")
        : String(ev.value);

      const meta = {
        ledger: Number(ev.ledger),
        txHash: ev.txHash,
        contractId: ev.contractId?.toString() ?? contractId,
      };

      try {
        const typed: SorobanHtlcEvent | null = decodeSorobanHtlcEvent(
          topics,
          rawValue,
          meta,
        );

        if (typed === null) {
          // Non-HTLC event (admin transfer, config, etc.) — skip quietly.
          this.log.debug(
            { ledger: meta.ledger, txHash: meta.txHash },
            "skipping non-HTLC Soroban event",
          );
          continue;
        }

        switch (typed.type) {
          case "created":
            handlers.onOrderCreated(typed);
            break;
          case "claimed":
            handlers.onOrderClaimed(typed);
            break;
          case "refunded":
            handlers.onOrderRefunded(typed);
            break;
        }
      } catch (err) {
        if (err instanceof SorobanEventDecodeError) {
          // Known event name but unexpected payload shape — likely a
          // contract schema change.  Log a warning and keep processing
          // subsequent events rather than crashing the whole poll loop.
          listenerErrorsTotal.inc({
            chain: CHAIN,
            error_type: "decode_error",
          });
          this.log.warn(
            {
              eventName: err.eventName,
              reason: err.reason,
              ledger: meta.ledger,
              txHash: meta.txHash,
            },
            "Soroban event decode error — skipping event",
          );
        } else {
          listenerErrorsTotal.inc({
            chain: CHAIN,
            error_type: "handler_error",
          });
          this.log.warn({ err }, "Soroban event handler threw");
        }
      }
    }

    // ------------------------------------------------------------------
    // Persist cursor AFTER the entire batch so that on a crash mid-batch
    // we never advance past events that weren't fully dispatched.
    // The cursor is always updated when the RPC returns one, even on an
    // empty event batch, so we make steady forward progress.
    // ------------------------------------------------------------------
    if (events.cursor) {
      this.cursor = events.cursor;
      try {
        this.cursorStore.save(this.cursorLabel, this.cursor);
      } catch (err) {
        // Non-fatal: worst case we reprocess the batch after a restart.
        this.log.warn({ err }, "failed to persist Soroban cursor to disk");
      }
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = undefined;
    }
    activeListeners.set({ chain: CHAIN }, 0);
  }

  /** Expose current in-memory cursor (useful in tests). */
  getCursor(): string | undefined {
    return this.cursor;
  }
}
