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

/**
 * Regex patterns that indicate the RPC node's history window no longer
 * covers the ledger we are requesting.  The Soroban RPC returns a plain
 * error string whose exact wording varies by node implementation, so we
 * match several variants.
 */
const HISTORY_WINDOW_PATTERNS = [
  /start ledger must be within/i,
  /startLedger must be within/i,
  /ledger.*out of range/i,
  /requested ledger is older/i,
  /ledger.*not available/i,
  /cursor.*too old/i,
  /oldest ledger/i,
];

/**
 * Safely converts an arbitrary thrown value to a string for pattern matching.
 * Falls back to the constructor name when the value is not serialisable (e.g.
 * circular references would make JSON.stringify throw and mask the original
 * classification error).
 */
function safeErrorString(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    // Non-serialisable value (e.g. circular object).  Use a best-effort
    // string that at least preserves the constructor name so callers can
    // still see what kind of thing was thrown.
    return Object.prototype.toString.call(err);
  }
}

function isHistoryWindowError(err: unknown): boolean {
  const msg = safeErrorString(err);
  return HISTORY_WINDOW_PATTERNS.some((re) => re.test(msg));
}

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
  /**
   * Called for contract events whose first topic symbol is not one of the
   * known HTLC event names (created / claimed / refunded).  Examples:
   * admin-transfer events, config updates, etc.
   *
   * Handlers may safely ignore these — the default wiring in run.ts is a
   * no-op.  The callback receives the raw topics and value as base64 XDR
   * strings plus the ledger/tx metadata so callers can inspect them if
   * needed.
   */
  onUnknownEvent?(opts: {
    topics: string[];
    value: string;
    ledger: number;
    txHash: string;
    contractId: string;
  }): void;
}

/** Key used to deduplicate events across a restart-overlap window. */
interface ProcessedKey {
  ledger: number;
  txHash: string;
  topicHash: string; // first-topic base64 — cheap discriminator
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

  /**
   * Deduplication window: tracks the (ledger, txHash, topicHash) of the last
   * N events so that if the listener resumes from a cursor that overlaps with
   * events already dispatched in the previous run, we don't double-fire.
   *
   * We keep at most DEDUP_WINDOW_SIZE entries and evict oldest-first.
   */
  private readonly dedupSet = new Set<string>();
  private readonly dedupQueue: string[] = [];
  private static readonly DEDUP_WINDOW_SIZE = 500;

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

    let events: Awaited<ReturnType<typeof this.server.getEvents>>;
    try {
      events = await retryRpcCall(
        () => this.server.getEvents(req),
        { logger: this.log },
      );
    } catch (err) {
      // ------------------------------------------------------------------
      // History-window overflow: the persisted cursor (or startLedger) is
      // older than what the RPC node retains.  Clamp to the current ledger
      // head, drop the stale cursor, warn, and increment a metric so
      // operators can alert on this — it means we may have missed events
      // during the outage window.
      // ------------------------------------------------------------------
      if (isHistoryWindowError(err)) {
        listenerErrorsTotal.inc({ chain: CHAIN, error_type: "history_window_overflow" });

        const latest = await retryRpcCall(
          () => this.server.getLatestLedger(),
          { logger: this.log },
        );
        const clampedLedger = latest.sequence - 1;

        this.log.warn(
          {
            staleCursor: this.cursor,
            staleStartLedger: startLedger,
            clampedLedger,
            latestLedger: latest.sequence,
          },
          "Soroban history-window overflow: persisted cursor is older than RPC retention window. " +
          "Clamping to current ledger head — events emitted during the gap may have been missed.",
        );

        // Clear the stale cursor so we start fresh from the clamped ledger.
        this.cursor = undefined;

        // Retry the request from the clamped position.
        events = await retryRpcCall(
          () =>
            this.server.getEvents({
              filters: [{ type: "contract", contractIds: [contractId] }],
              startLedger: clampedLedger,
              limit: 100,
            }),
          { logger: this.log },
        );
      } else {
        throw err;
      }
    }

    for (const ev of events.events) {
      // Build dedup key from ledger + txHash + first topic (cheap).
      const firstTopicRaw = (ev.topic[0] as any)?.toXDR
        ? (ev.topic[0] as any).toXDR("base64")
        : String(ev.topic[0]);
      const dedupKey = `${ev.ledger}:${ev.txHash}:${firstTopicRaw}`;

      if (this.dedupSet.has(dedupKey)) {
        // Already dispatched in a previous poll — skip without metrics so
        // we don't inflate counters for duplicate delivery.
        this.log.debug(
          { ledger: ev.ledger, txHash: ev.txHash },
          "skipping duplicate Soroban event (dedup)",
        );
        continue;
      }

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
          // Non-HTLC event (admin transfer, config, etc.).
          eventsTotal.inc({ chain: CHAIN, event_type: "unknown" });
          this.log.debug(
            { ledger: meta.ledger, txHash: meta.txHash },
            "skipping non-HTLC Soroban event",
          );
          if (handlers.onUnknownEvent) {
            handlers.onUnknownEvent({
              topics,
              value: rawValue,
              ...meta,
            });
          }
          // Still record in dedup window.
          this._trackDedup(dedupKey);
          continue;
        }

        switch (typed.type) {
          case "created":
            eventsTotal.inc({ chain: CHAIN, event_type: "created" });
            handlers.onOrderCreated(typed);
            break;
          case "claimed":
            eventsTotal.inc({ chain: CHAIN, event_type: "claimed" });
            handlers.onOrderClaimed(typed);
            break;
          case "refunded":
            eventsTotal.inc({ chain: CHAIN, event_type: "refunded" });
            handlers.onOrderRefunded(typed);
            break;
        }

        // Record in dedup window only after successful dispatch.
        this._trackDedup(dedupKey);
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
          // Still advance dedup so we don't re-attempt on next poll.
          this._trackDedup(dedupKey);
        } else {
          listenerErrorsTotal.inc({
            chain: CHAIN,
            error_type: "handler_error",
          });
          this.log.warn({ err }, "Soroban event handler threw");
          // Do NOT advance dedup on handler error — allow retry on next poll.
          throw err;
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

  /** Add a key to the dedup window, evicting the oldest entry if full. */
  private _trackDedup(key: string): void {
    if (this.dedupSet.has(key)) return;
    if (this.dedupQueue.length >= SorobanListener.DEDUP_WINDOW_SIZE) {
      const evicted = this.dedupQueue.shift()!;
      this.dedupSet.delete(evicted);
    }
    this.dedupSet.add(key);
    this.dedupQueue.push(key);
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

  /**
   * Expose the dedup window size (useful in tests to verify dedup is working).
   */
  getDedupSize(): number {
    return this.dedupSet.size;
  }
}
