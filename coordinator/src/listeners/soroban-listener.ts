import { rpc } from "@stellar/stellar-sdk";
import type { xdr } from "@stellar/stellar-sdk";
import type { Logger } from "pino";
import type { CoordinatorConfig } from "../config.js";
import type { OrderService } from "../services/order-service.js";
import {
  observeListenerEventProcessing,
  recordListenerProgress,
  sorobanDecodeErrors,
  workflowDispatchDecisions,
  listenerCheckpointPersistTotal,
  listenerCheckpointLedger,
  listenerReplayWindowLedgers,
  listenerReplayEventsTotal,
  listenerRecoveryRunsTotal,
  listenerCursorResetsTotal,
} from "../metrics.js";
import {
  decodeHtlcEvent,
  isMalformedEvent,
  type DecodedHtlcEvent,
} from "../soroban-events.js";
import {
  decideDispatch,
  type WorkflowPath,
  type WorkflowMutation,
} from "../services/workflow-priority-policy.js";
import type { SorobanRecoveryMarker } from "../persistence/orders-repo.js";

/** Maximum ledger gap before we treat it as a node inconsistency and re-scan. */
const MAX_LEDGER_GAP = 100;

/**
 * Upper bound on the ledger span a single bounded replay/recovery pass will
 * scan.  Sized at ~48h of Stellar ledgers (~5s/ledger) — the same window the
 * reconciler uses.  If the checkpoint is further behind than this we can only
 * cover the tail; the periodic reconciler backfills the remainder and we log
 * the shortfall so operators can trigger a full historical replay if needed.
 */
const MAX_REPLAY_LEDGERS = 34_560;

/** Page size for the getEvents scan during bounded replay/recovery. */
const REPLAY_PAGE_LIMIT = 200;

/**
 * Maximum number of processed event keys retained in the in-process
 * deduplication cache (same sizing rationale as the Ethereum listener).
 */
const DEDUP_CACHE_MAX = 10_000;

// ─── Typed RPC event shape ────────────────────────────────────────────────────

/**
 * Minimal typed wrapper for the raw Soroban RPC event returned by
 * `rpc.Server.getEvents()`.  The full type is not exported by the SDK at
 * the version we use, so we extract the relevant slice.
 */
interface SorobanRpcEvent {
  ledger: number;
  txHash: string;
  /** Array of xdr.ScVal — the published topics. */
  topic: xdr.ScVal[];
  /** Single xdr.ScVal — the published data (a Soroban Vec/tuple). */
  value: xdr.ScVal;
}

// ─── SorobanListener ─────────────────────────────────────────────────────────

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
 *     Detected per-event: run a bounded replay of the missed range from the
 *     last safe ledger instead of silently jumping to the tip.
 *
 *  3. Stale / expired cursor — the RPC node no longer recognises our cursor
 *     (e.g. node restarted, history window pruned).
 *     Detected on RPC error: reset cursor and replay from the last safe ledger.
 *
 * Durable checkpointing & replay-recovery
 * ───────────────────────────────────────
 * The listener persists a {@link SorobanCheckpoint} (last safe ledger,
 * effective cursor, contract id, recovery marker) after every poll.  On
 * startup it loads that checkpoint and resumes from the last safe point
 * rather than reprocessing from scratch or jumping blindly to the chain tip.
 * If the checkpoint is marked for replay (a gap / stale cursor / restart was
 * observed and not yet reconciled), or a cursor reset happens in-loop, the
 * listener runs a bounded replay of the missed ledger range.  Idempotency is
 * guaranteed by the in-process dedup cache plus the {@link decideDispatch}
 * policy, so replayed events never create duplicate source-lock, secret-reveal,
 * or refunded transitions.
 *
 * Event decoding
 * ──────────────
 * All decoding is delegated to {@link decodeHtlcEvent} from `soroban-events.ts`,
 * which is the single canonical decoder shared with the reconciler.  A
 * {@link MalformedEventError} is counted and logged as an operational failure;
 * it does NOT stall the poll loop.  An `null` result (unknown/governance topic)
 * is silently skipped.
 */
export class SorobanListener {
  private readonly server: rpc.Server;
  private readonly log: Logger;
  private cursor: string | undefined;
  private stopped = false;
  private lastProcessedLedger = 0;
  /** The HTLC contract this listener is bound to; set in start(). */
  private contractId: string | undefined;

  /**
   * In-process event deduplication cache.
   * Key: `"<kind>:<txHash>"` — e.g. `"created:0xabc…"`.
   * Bounded at DEDUP_CACHE_MAX entries; oldest evicted on overflow.
   */
  private readonly processedEventKeys = new Map<string, true>();

  constructor(
    private readonly cfg: CoordinatorConfig,
    private readonly orders: OrderService,
    log: Logger
  ) {
    this.log = log.child({ component: "SorobanListener" });
    this.server = new rpc.Server(cfg.soroban.rpcUrl, {
      allowHttp: cfg.soroban.rpcUrl.startsWith("http://"),
    });
  }

  start(): void {
    if (!this.cfg.soroban.htlcContract) {
      this.log.warn(
        "SOROBAN_HTLC contract not configured - Soroban listener disabled"
      );
      return;
    }
    const contractId = this.cfg.soroban.htlcContract;
    this.contractId = contractId;
    this.log.info({ contract: contractId }, "starting");
    void this.bootstrapAndLoop(contractId);
  }

  stop(): void {
    this.stopped = true;
  }

  // ─── Event deduplication helpers ─────────────────────────────────────────

  /** Build the dedup cache key: `"<kind>:<txHash>"`. */
  private dedupKey(kind: string, txHash: string): string {
    return `${kind}:${txHash}`;
  }

  /** Returns true if this (kind, txHash) pair was already processed in-process. */
  isDuplicate(kind: string, txHash: string): boolean {
    return this.processedEventKeys.has(this.dedupKey(kind, txHash));
  }

  /** Mark (kind, txHash) as processed; evicts oldest entry on overflow. */
  private markProcessed(kind: string, txHash: string): void {
    const key = this.dedupKey(kind, txHash);
    if (this.processedEventKeys.has(key)) return;
    if (this.processedEventKeys.size >= DEDUP_CACHE_MAX) {
      const oldest = this.processedEventKeys.keys().next().value;
      if (oldest !== undefined) this.processedEventKeys.delete(oldest);
    }
    this.processedEventKeys.set(key, true);
  }

  // ─── Durable checkpointing ────────────────────────────────────────────────

  /**
   * Load the persisted checkpoint and resume from the last safe point.
   *
   *  - No checkpoint (fresh install, or re-pointed at a new contract): start
   *    just behind the chain tip; the reconciler backfills any older history.
   *  - Clean checkpoint with a cursor: resume the live stream directly from the
   *    cursor — the RPC returns every event after it, including those that
   *    occurred while the coordinator was offline.
   *  - Checkpoint marked for replay, or clean without a cursor: run a bounded
   *    replay of the missed range from the last safe ledger before going live.
   */
  private async bootstrap(contractId: string): Promise<void> {
    const cp = await this.orders.getSorobanCheckpoint(contractId);
    if (!cp) {
      this.log.info(
        { contract: contractId },
        "no Soroban checkpoint found — starting near chain tip"
      );
      return;
    }

    this.lastProcessedLedger = cp.lastSafeLedger;
    listenerCheckpointLedger.set({ chain: "stellar" }, cp.lastSafeLedger);
    this.log.info(
      {
        contract: contractId,
        lastSafeLedger: cp.lastSafeLedger,
        hasCursor: cp.effectiveCursor !== null,
        recoveryMarker: cp.recoveryMarker,
      },
      "resuming Soroban listener from persisted checkpoint"
    );

    if (cp.recoveryMarker !== "clean") {
      // A prior run flagged a gap/stale cursor/restart and did not finish
      // reconciling it (possibly crashed mid-replay). Replay before going live.
      listenerCursorResetsTotal.inc({ chain: "stellar", reason: "restart" });
      this.cursor = undefined;
      await this.runBoundedReplay(contractId, cp.lastSafeLedger, "restart");
      return;
    }

    if (cp.effectiveCursor) {
      // Fast path: continue the live stream straight from the cursor.
      this.cursor = cp.effectiveCursor;
      return;
    }

    if (cp.lastSafeLedger > 0) {
      // Clean, but no cursor to resume from — replay the offline gap so we
      // don't silently skip events that landed since the last safe ledger.
      await this.runBoundedReplay(contractId, cp.lastSafeLedger, "restart");
    }
  }

  /**
   * Persist the current listener position as a durable checkpoint.  Never
   * throws: a persistence failure is counted and logged but must not stall
   * event ingestion (the reconciler remains a safety net).
   */
  private async persistCheckpoint(marker: SorobanRecoveryMarker): Promise<void> {
    if (!this.contractId) return;
    try {
      await this.orders.saveSorobanCheckpoint({
        contractId: this.contractId,
        lastSafeLedger: this.lastProcessedLedger,
        effectiveCursor: this.cursor ?? null,
        recoveryMarker: marker,
      });
      listenerCheckpointPersistTotal.inc({ chain: "stellar", result: "success" });
      listenerCheckpointLedger.set({ chain: "stellar" }, this.lastProcessedLedger);
    } catch (err) {
      listenerCheckpointPersistTotal.inc({ chain: "stellar", result: "failure" });
      this.log.warn(
        { err, contract: this.contractId },
        "Soroban checkpoint persist failed — resume will fall back to the reconciler"
      );
    }
  }

  private async bootstrapAndLoop(contractId: string): Promise<void> {
    try {
      await this.bootstrap(contractId);
    } catch (err) {
      // A bootstrap failure must not prevent the listener from running; fall
      // back to a tip-relative start and let the reconciler backfill.
      this.cursor = undefined;
      this.log.warn(
        { err, contract: contractId },
        "Soroban listener bootstrap failed — starting from chain tip"
      );
    }
    await this.loop(contractId);
  }

  // ─── Bounded replay / recovery ────────────────────────────────────────────

  /**
   * Scan a bounded ledger range from `fromLedger` up to the current chain tip
   * and reconcile every HTLC event through the same idempotent dispatch path
   * used by the live stream.  Adopts the RPC cursor returned by the final page
   * so the listener can continue the live stream seamlessly afterwards.
   *
   * Marks the checkpoint `recovering` for the duration so a crash mid-replay
   * re-runs it on the next start, and `clean` on success.
   */
  private async runBoundedReplay(
    contractId: string,
    fromLedger: number,
    reason: "restart" | "ledger_gap" | "stale_cursor"
  ): Promise<number> {
    const startedAt = Date.now();
    let applied = 0;
    try {
      await this.persistCheckpoint("recovering");

      const latest = await this.server.getLatestLedger();
      const tip = latest.sequence;
      const boundedFrom = Math.max(0, fromLedger, tip - MAX_REPLAY_LEDGERS);
      const window = Math.max(0, tip - boundedFrom);
      listenerReplayWindowLedgers.set({ chain: "stellar" }, window);

      if (fromLedger > 0 && fromLedger < tip - MAX_REPLAY_LEDGERS) {
        this.log.warn(
          { contract: contractId, reason, fromLedger, boundedFrom, tip, MAX_REPLAY_LEDGERS },
          "Soroban replay window exceeds MAX_REPLAY_LEDGERS — some events may be " +
            "permanently missed by the listener; the reconciler will backfill the remainder"
        );
      }

      this.log.info(
        { contract: contractId, reason, fromLedger, boundedFrom, tip, window },
        "Soroban listener starting bounded replay/recovery"
      );

      let pageCursor: string | undefined;
      let startLedger: number | undefined = boundedFrom;
      do {
        const events = await this.server.getEvents({
          filters: [{ type: "contract", contractIds: [contractId] }],
          startLedger: pageCursor ? undefined : startLedger,
          cursor: pageCursor,
          limit: REPLAY_PAGE_LIMIT,
        });

        for (const ev of events.events) {
          const rpcEv = ev as unknown as SorobanRpcEvent;
          if (await this.processSorobanEvent(rpcEv, "recovery")) applied++;
          this.lastProcessedLedger = Math.max(this.lastProcessedLedger, rpcEv.ledger);
        }

        pageCursor = events.cursor ?? undefined;
        // Adopt the cursor so the live loop resumes exactly where replay ended.
        if (pageCursor) this.cursor = pageCursor;
        if (events.events.length < REPLAY_PAGE_LIMIT) break;
        startLedger = undefined;
      } while (pageCursor && !this.stopped);

      // Recovery reconciled the whole window: the safe point is now the tip.
      this.lastProcessedLedger = Math.max(this.lastProcessedLedger, tip);
      await this.persistCheckpoint("clean");

      listenerRecoveryRunsTotal.inc({ chain: "stellar", result: "success" });
      this.log.info(
        { contract: contractId, reason, applied, window, ms: Date.now() - startedAt },
        "Soroban listener replay/recovery complete"
      );
    } catch (err) {
      listenerRecoveryRunsTotal.inc({ chain: "stellar", result: "failure" });
      this.log.warn(
        { err, contract: contractId, reason },
        "Soroban listener replay/recovery failed — will retry on next trigger"
      );
    }
    return applied;
  }

  private async loop(contractId: string): Promise<void> {
    while (!this.stopped) {
      try {
        const startedAt = Date.now();
        const latest = await this.server.getLatestLedger();

        // When we have no cursor, start just behind the chain tip.
        const startLedger =
          this.cursor === undefined ? latest.sequence - 1 : undefined;

        // processedLedger tracks the highest ledger we process this iteration
        // for recordListenerProgress. Seed it from the resolved start point.
        let processedLedger = startLedger ?? this.lastProcessedLedger;

        let events: Awaited<ReturnType<rpc.Server["getEvents"]>>;
        try {
          events = await this.server.getEvents({
            filters: [{ type: "contract", contractIds: [contractId] }],
            startLedger: startLedger,
            cursor: this.cursor,
            limit: 100,
          });
        } catch (rpcErr) {
          // Stale / expired cursor — reset, flag the checkpoint, and recover the
          // missed range by replaying from the last safe ledger.
          this.log.warn({ err: rpcErr }, "Soroban cursor reset due to error");
          this.cursor = undefined;
          listenerCursorResetsTotal.inc({ chain: "stellar", reason: "stale_cursor" });
          await this.orders
            .markSorobanRecovery(contractId, "pending_replay")
            .catch(() => {});
          await this.runBoundedReplay(contractId, this.lastProcessedLedger, "stale_cursor");
          await new Promise((r) => setTimeout(r, this.cfg.pollIntervalMs));
          continue;
        }

        let gapDetected = false;
        for (const ev of events.events) {
          // ── Guard 1: out-of-order event ──────────────────────────────────
          if (ev.ledger < this.lastProcessedLedger) {
            this.log.warn(
              {
                evLedger: ev.ledger,
                lastProcessedLedger: this.lastProcessedLedger,
              },
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
              {
                evLedger: ev.ledger,
                lastProcessedLedger: this.lastProcessedLedger,
                MAX_LEDGER_GAP,
              },
              "Soroban ledger gap detected — replaying missed range from last safe ledger"
            );
            this.cursor = undefined;
            listenerCursorResetsTotal.inc({ chain: "stellar", reason: "ledger_gap" });
            gapDetected = true;
            break;
          }

          processedLedger = Math.max(processedLedger, ev.ledger);
          this.lastProcessedLedger = Math.max(
            this.lastProcessedLedger,
            ev.ledger
          );

          await this.processSorobanEvent(ev as unknown as SorobanRpcEvent, "live");
        }

        recordListenerProgress("soroban", processedLedger, latest.sequence);
        observeListenerEventProcessing("soroban", "poll", startedAt);

        if (gapDetected) {
          await this.orders
            .markSorobanRecovery(contractId, "pending_replay")
            .catch(() => {});
          await this.runBoundedReplay(contractId, this.lastProcessedLedger, "ledger_gap");
          await new Promise((r) => setTimeout(r, this.cfg.pollIntervalMs));
          continue;
        }

        // Adopt the RPC cursor so subsequent polls (and the persisted
        // checkpoint's effective cursor) continue exactly from here.  The gap
        // guard clears this.cursor and `continue`s above, so we never reach
        // this line with a cursor that should have been reset.
        if (events.cursor) {
          this.cursor = events.cursor;
        }

        // Persist the durable checkpoint so the next restart resumes here.
        await this.persistCheckpoint("clean");
      } catch (err) {
        this.log.warn({ err }, "Soroban poll failed");
      }
      await new Promise((r) => setTimeout(r, this.cfg.pollIntervalMs));
    }
  }

  /**
   * Record that a mutation was applied and, on the replay/recovery path,
   * increment the recovery-events metric.
   */
  private onApplied(path: WorkflowPath, mutation: WorkflowMutation): void {
    if (path !== "live") {
      listenerReplayEventsTotal.inc({ chain: "stellar", mutation });
    }
  }

  /**
   * Decode a single Soroban contract event via the shared
   * {@link decodeHtlcEvent} utility and dispatch to the appropriate
   * OrderService method.
   *
   * `path` distinguishes the live poll stream (`"live"`) from the bounded
   * replay/recovery scan (`"recovery"`); it feeds the {@link decideDispatch}
   * priority policy so a replayed event never overrides a live one and never
   * re-applies an already-recorded transition.
   *
   * A {@link MalformedEventError} is treated as an operational failure:
   * it is counted, logged at warn level, and skipped — it does NOT mutate
   * order state.  Unknown/governance topics (null) are silently skipped.
   *
   * Duplicate events (same kind + txHash already processed in this session)
   * are dropped before any DB interaction.
   *
   * @returns `true` when a state transition was applied, `false` otherwise.
   */
  private async processSorobanEvent(
    ev: SorobanRpcEvent,
    path: WorkflowPath = "live"
  ): Promise<boolean> {
    const result = decodeHtlcEvent(ev.topic, ev.value);

    // ── Malformed payload ─────────────────────────────────────────────────
    if (isMalformedEvent(result)) {
      sorobanDecodeErrors.inc({ reason: result.reason });
      this.log.warn(
        {
          ledger: ev.ledger,
          txHash: ev.txHash,
          kind: result.kind,
          reason: result.reason,
          detail: result.detail,
        },
        "Soroban event payload malformed — skipping without mutating order state"
      );
      return false;
    }

    // ── Unknown / governance topic ────────────────────────────────────────
    if (result === null) {
      this.log.debug(
        { ledger: ev.ledger, txHash: ev.txHash },
        "Soroban event with unknown topic — skipping"
      );
      return false;
    }

    const decoded: DecodedHtlcEvent = result;

    // ── In-process deduplication ──────────────────────────────────────────
    if (this.isDuplicate(decoded.kind, ev.txHash)) {
      this.log.debug(
        { kind: decoded.kind, txHash: ev.txHash, ledger: ev.ledger, path },
        "Soroban event duplicate skipped (in-process cache)"
      );
      return false;
    }

    this.log.info(
      { kind: decoded.kind, schemaVersion: decoded.schemaVersion, ledger: ev.ledger, txHash: ev.txHash, path },
      "Soroban HTLC event decoded"
    );

    // ── created ────────────────────────────────────────────────────────────
    if (decoded.kind === "created") {
      try {
        const order = await this.orders.findByHashlock(decoded.hashlock);
        if (!order) {
          this.log.info(
            {
              hashlock: decoded.hashlock,
              orderId: decoded.orderId.toString(),
            },
            "Soroban created event: no matching announced order — skipping"
          );
          return false;
        }
        const decision = decideDispatch({
          path,
          mutation: "src_lock",
          incomingSequence: ev.ledger,
          existingSequence: order.srcLockBlock,
          alreadyApplied: order.srcOrderId !== null,
        });
        workflowDispatchDecisions.inc({
          path,
          mutation: "src_lock",
          outcome: decision.reason,
        });
        if (!decision.shouldApply) return false;
        await this.orders.recordSrcLock({
          publicId: order.publicId,
          orderId: decoded.orderId.toString(),
          txHash: ev.txHash,
          blockNumber: ev.ledger,
          timelock: decoded.timelock,
        });
        this.markProcessed(decoded.kind, ev.txHash);
        this.onApplied(path, "src_lock");
        return true;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("cannot record") && !msg.includes("duplicate")) {
          this.log.warn(
            { err, hashlock: decoded.hashlock },
            "Soroban created event processing error"
          );
        }
      }
      return false;
    }

    // ── claimed ────────────────────────────────────────────────────────────
    if (decoded.kind === "claimed") {
      try {
        const order = await this.orders.findBySrcOrderId(
          "stellar",
          decoded.orderId.toString()
        );
        if (!order) {
          const byHash = await this.orders.findByHashlock(decoded.hashlock);
          if (!byHash) {
            this.log.info(
              {
                orderId: decoded.orderId.toString(),
                hashlock: decoded.hashlock,
              },
              "Soroban claimed event: order not found — skipping"
            );
            return false;
          }
          const decision = decideDispatch({
            path,
            mutation: "secret_reveal",
            incomingSequence: ev.ledger,
            existingSequence: null,
            alreadyApplied: byHash.preimage !== null,
          });
          workflowDispatchDecisions.inc({
            path,
            mutation: "secret_reveal",
            outcome: decision.reason,
          });
          if (!decision.shouldApply) return false;
          await this.orders.recordSecret(
            byHash.publicId,
            decoded.preimage,
            ev.txHash
          );
          this.markProcessed(decoded.kind, ev.txHash);
          this.onApplied(path, "secret_reveal");
          return true;
        }
        const decision = decideDispatch({
          path,
          mutation: "secret_reveal",
          incomingSequence: ev.ledger,
          existingSequence: null,
          alreadyApplied: order.preimage !== null,
        });
        workflowDispatchDecisions.inc({
          path,
          mutation: "secret_reveal",
          outcome: decision.reason,
        });
        if (!decision.shouldApply) return false;
        await this.orders.recordSecret(
          order.publicId,
          decoded.preimage,
          ev.txHash
        );
        this.markProcessed(decoded.kind, ev.txHash);
        this.onApplied(path, "secret_reveal");
        return true;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("cannot record") && !msg.includes("duplicate")) {
          this.log.warn(
            { err, orderId: decoded.orderId.toString() },
            "Soroban claimed event processing error"
          );
        }
      }
      return false;
    }

    // ── refunded ───────────────────────────────────────────────────────────
    if (decoded.kind === "refunded") {
      try {
        const order = await this.orders.findBySrcOrderId(
          "stellar",
          decoded.orderId.toString()
        );
        if (!order) {
          const byHash = await this.orders.findByHashlock(decoded.hashlock);
          if (!byHash) {
            this.log.info(
              {
                orderId: decoded.orderId.toString(),
                hashlock: decoded.hashlock,
              },
              "Soroban refunded event: order not found — skipping"
            );
            return false;
          }
          const decision = decideDispatch({
            path,
            mutation: "refund",
            incomingSequence: ev.ledger,
            existingSequence: byHash.srcLockBlock,
            alreadyApplied: byHash.status === "refunded" || byHash.status === "completed",
          });
          workflowDispatchDecisions.inc({
            path,
            mutation: "refund",
            outcome: decision.reason,
          });
          if (!decision.shouldApply) return false;
          await this.orders.markStatus(byHash.publicId, "refunded");
          this.markProcessed(decoded.kind, ev.txHash);
          this.onApplied(path, "refund");
          return true;
        }
        const decision = decideDispatch({
          path,
          mutation: "refund",
          incomingSequence: ev.ledger,
          existingSequence: order.srcLockBlock,
          alreadyApplied: order.status === "refunded" || order.status === "completed",
        });
        workflowDispatchDecisions.inc({
          path,
          mutation: "refund",
          outcome: decision.reason,
        });
        if (!decision.shouldApply) return false;
        await this.orders.markStatus(order.publicId, "refunded");
        this.markProcessed(decoded.kind, ev.txHash);
        this.onApplied(path, "refund");
        return true;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("cannot transition") && !msg.includes("duplicate")) {
          this.log.warn(
            { err, orderId: decoded.orderId.toString() },
            "Soroban refunded event processing error"
          );
        }
      }
      return false;
    }

    return false;
  }
}
