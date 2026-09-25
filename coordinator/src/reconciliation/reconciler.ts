/**
 * Reconciler — formal replay/recovery pipeline for the WaffleFinance coordinator.
 *
 * ## Architecture
 *
 * The reconciler runs on a configurable interval and on startup.  Each run
 * executes a deterministic, provable re-sync of on-chain state against the
 * coordinator's DB across all three chains.
 *
 * ### Key invariants
 *
 * 1. **No silent event loss** — every run starts from the cursor HWM seeded
 *    from the DB, not a fixed constant.  Events in the scan window are
 *    processed even after a restart.
 *
 * 2. **No silent mis-interpretation** — duplicate and reordered events are
 *    identified by `EventSeenSet` and skipped before any DB write.
 *
 * 3. **No silent gap exceedance** — when the cursor gap exceeds the lookback
 *    window, the reconciler emits a structured warning log, a Prometheus metric
 *    increment, and falls back deterministically to `tip - lookback`.
 *
 * 4. **Idempotent recovery** — every OrderService write (recordSrcLock,
 *    recordSecret, markStatus) is idempotent: re-running the reconciler after
 *    a crash leaves the DB in the same state as a single successful run.
 *
 * 5. **Operator observability** — every decision (window size, gap severity,
 *    conflict type, resync) is emitted as a metric and a structured log entry.
 *
 * ### Per-chain cursors
 *
 * Each chain has its own `LedgerCursor` seeded at startup from the DB.  The
 * HWM advances to the highest block/ledger/slot processed in each run so
 * subsequent runs start from where the previous one left off.
 *
 * ### Startup recovery
 *
 * On the first `run()` call (or after a process restart), `initCursors()`
 * queries the DB for the highest known block per chain and seeds each cursor.
 * This ensures the very first run covers the full missed window without any
 * manual operator action.
 *
 * ### Partial RPC failure
 *
 * If a single chain's RPC fails, that chain is skipped for this run (the
 * cursor does not advance) and an error metric is incremented.  The other
 * chains are not affected.  On the next run the cursor for the failed chain
 * will reassess the gap from the same HWM and retry.
 */

import {
  createPublicClient,
  http,
  parseAbiItem,
  type PublicClient,
  type Log,
} from "viem";
import { sepolia, mainnet } from "viem/chains";
import { rpc } from "@stellar/stellar-sdk";
import { Connection, PublicKey } from "@solana/web3.js";
import type { Logger } from "pino";
import type { CoordinatorConfig } from "../config.js";
import type { OrderService } from "../services/order-service.js";
import {
  reconciliationRuns,
  reconciliationErrors,
  reconciliationLastRun,
  reconciliationEventsReplayed,
  reconciliationEventsSkipped,
  reconciliationConflicts,
  reconciliationGapBlocks,
  reconciliationLookbackCoverage,
  reconciliationRestartRecoveryEvents,
  sorobanDecodeErrors,
  workflowDispatchDecisions,
} from "../metrics.js";
import { isTerminal } from "../state-machine/order-machine.js";
import { validatePreimage } from "./secret-reconciler.js";
import {
  decodeHtlcEvent,
  isMalformedEvent,
} from "../soroban-events.js";
import { decideDispatch } from "../services/workflow-priority-policy.js";

const ORDER_CREATED = parseAbiItem(
  "event OrderCreated(uint256 indexed orderId, address indexed sender, address indexed beneficiary, address token, uint256 amount, uint256 safetyDeposit, bytes32 hashlock, uint64 timelock)"
);
const ORDER_CLAIMED = parseAbiItem(
  "event OrderClaimed(uint256 indexed orderId, address indexed claimer, bytes32 preimage, uint256 amount, uint256 safetyDeposit)"
);
const ORDER_REFUNDED = parseAbiItem(
  "event OrderRefunded(uint256 indexed orderId, address indexed caller, uint256 amount, uint256 safetyDeposit)"
);

interface SorobanRpcEvent {
  ledger: number;
  txHash: string;
  topic?: xdr.ScVal[];
  value: xdr.ScVal;
}

import {
  computeIncrementalScanStart,
  ETH_LOOKBACK_BLOCKS,
  SOROBAN_LOOKBACK_LEDGERS,
  SOLANA_LOOKBACK_SLOTS,
  isEventBehindOrderCursor,
} from "./ledger-cursor.js";

// ─── Status types ─────────────────────────────────────────────────────────────

export interface ReconciliationStatus {
  lastRunAt: number | null;
  lastRunOk: boolean | null;
  eventsReplayed: number;
  /** Populated after the first successful run. */
  cursors?: {
    ethereum: number;
    soroban: number;
    solana: number;
  };
}

/**
 * Structured error recorded when a numeric field (block number, timelock, etc.)
 * exceeds the safe JS integer range and cannot be safely converted.
 */
export interface ReconciliationNumericError {
  code: "UNSAFE_INTEGER";
  chain: "ethereum" | "stellar" | "solana";
  field: string;
  rawValue: unknown;
  context: string;
}

/**
 * Convert a bigint or number to a JS safe integer.
 *
 * Returns `null` and emits a structured error when the value is outside the
 * `Number.MAX_SAFE_INTEGER` range, preventing silent precision loss that would
 * corrupt block-cursor or timelock comparisons.
 */
function safeToNumber(
  value: bigint | number | undefined | null,
  field: string,
  context: string,
  chain: "ethereum" | "stellar" | "solana",
  onError: (err: ReconciliationNumericError) => void
): number | null {
  if (value == null) return null;
  const n = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isFinite(n) || !Number.isSafeInteger(n)) {
    onError({
      code: "UNSAFE_INTEGER",
      chain,
      field,
      rawValue: value,
      context,
    });
    return null;
  }
  return n;
}

export class Reconciler {
  private readonly log: Logger;
  private readonly ethClient: PublicClient;
  private readonly sorobanServer: rpc.Server;
  private readonly solanaConn: Connection;

  // Per-chain cursors — seeded from DB on first run via initCursors().
  private ethCursor: LedgerCursor | null = null;
  private sorobanCursor: LedgerCursor | null = null;
  private sorobanRpcCursor: string | undefined = undefined; // Soroban's opaque page cursor
  private solanaCursor: LedgerCursor | null = null;

  // Per-run deduplication set.  Cleared at the start of each run.
  private readonly seenSet = new EventSeenSet();

  // Replay policy accumulator.  Reset at the start of each run.
  private readonly policy = new ReplayPolicy();

  // Whether cursors have been initialised from the DB.
  private cursorsReady = false;

  private status: ReconciliationStatus = {
    lastRunAt: null,
    lastRunOk: null,
    eventsReplayed: 0,
  };

  constructor(
    private readonly cfg: CoordinatorConfig,
    private readonly orders: OrderService,
    log: Logger,
  ) {
    this.log = log.child({ component: "Reconciler" });
    this.ethClient = createPublicClient({
      chain: cfg.ethereum.chainId === 1 ? mainnet : sepolia,
      transport: http(cfg.ethereum.rpcUrl),
    });
    this.sorobanServer = new rpc.Server(cfg.soroban.rpcUrl, {
      allowHttp: cfg.soroban.rpcUrl.startsWith("http://"),
    });
    this.solanaConn = new Connection(cfg.solana.rpcUrl, cfg.solana.commitment);
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  getStatus(): ReconciliationStatus {
    return { ...this.status };
  }

  /**
   * Execute one full reconciliation run across all configured chains.
   *
   * Run sequence:
   *   1. Initialise cursors from DB (once, on first call).
   *   2. Clear per-run dedup set and policy accumulator.
   *   3. For each chain: assess gap, decide window, replay events, advance cursor.
   *   4. Emit metrics from policy summary.
   *   5. Update status and run-level metrics.
   */
  async run(): Promise<void> {
    this.log.info("reconciliation run starting");

    // Seed cursors from DB on first run (startup recovery).
    if (!this.cursorsReady) {
      await this.initCursors();
    }

    // Clear per-run state.
    this.seenSet.clear();
    this.policy.reset();

    let replayed = 0;
    let runOk = true;

    try {
      replayed += await this.reconcileEthereum();
    } catch (err) {
      this.log.error({ err, chain: "ethereum" }, "reconciler: Ethereum chain run failed");
      reconciliationChainErrors.inc({ chain: "ethereum" });
      runOk = false;
    }

    try {
      replayed += await this.reconcileSoroban();
    } catch (err) {
      this.log.error({ err, chain: "soroban" }, "reconciler: Soroban chain run failed");
      reconciliationChainErrors.inc({ chain: "soroban" });
      runOk = false;
    }

    try {
      replayed += await this.reconcileSolana();
    } catch (err) {
      this.log.error({ err, chain: "solana" }, "reconciler: Solana chain run failed");
      reconciliationChainErrors.inc({ chain: "solana" });
      runOk = false;
    }

    // Emit policy metrics.
    this.emitPolicyMetrics();

    // Emit dedup metrics.
    const dedupStats = this.seenSet.getStats();
    if (dedupStats.duplicates > 0) {
      reconciliationDuplicatesSkipped.inc(dedupStats.duplicates);
    }

    // Update run-level status.
    this.status = {
      lastRunAt: Date.now(),
      lastRunOk: runOk,
      eventsReplayed: replayed,
      cursors: {
        ethereum: this.ethCursor?.getHwm() ?? 0,
        soroban: this.sorobanCursor?.getHwm() ?? 0,
        solana: this.solanaCursor?.getHwm() ?? 0,
      },
    };

    if (runOk) {
      reconciliationRuns.inc({ result: "success" });
    } else {
      reconciliationRuns.inc({ result: "failure" });
      reconciliationErrors.inc();
    }

    reconciliationEventsReplayed.inc(replayed);
    reconciliationLastRun.set(Date.now() / 1000);

    this.log.info(
      {
        replayed,
        runOk,
        dedupStats,
        policySummary: this.policy.getSummary(),
      },
      "reconciliation run complete",
    );
  }

  /**
   * Measure and emit the gap between the persistent cursor and the current
   * chain tip.  Returns the effective fromBlock/fromLedger/fromSlot the
   * reconciler should use — either the cursor position (when the gap is
   * within the lookback window) or tip minus lookback (when the gap is too
   * large to fully cover, which we log as a warning).
   */
  private async computeEthFromBlock(latest: bigint): Promise<bigint> {
    const chainCursor = await this.orders.getChainCursor("ethereum");
    const minOrderCursor = await this.orders.getMinActiveOrderCursor("ethereum");

    let cursor = chainCursor;
    if (minOrderCursor !== null && minOrderCursor > 0) {
      cursor = cursor > 0 ? Math.min(cursor, minOrderCursor) : minOrderCursor;
    }

    const tip = Number(latest);
    const { from, gap, usedLookbackFallback } = computeIncrementalScanStart(
      cursor,
      tip,
      ETH_LOOKBACK_BLOCKS
    );

    reconciliationGapBlocks.set({ chain: "ethereum" }, gap);
    reconciliationLookbackCoverage.set({ chain: "ethereum" }, Math.min(gap, ETH_LOOKBACK_BLOCKS));

    if (cursor > 0 && gap > ETH_LOOKBACK_BLOCKS) {
      this.log.warn(
        { chain: "ethereum", cursor, tip, gap, lookback: ETH_LOOKBACK_BLOCKS },
        "reconciler: gap exceeds lookback window — some events may be permanently missed; " +
        "increase ETH_LOOKBACK_BLOCKS or trigger a full historical replay"
      );
      reconciliationConflicts.inc({ chain: "ethereum", conflict_type: "gap_exceeds_lookback" });
    } else if (cursor > 0 && !usedLookbackFallback) {
      this.log.info({ chain: "ethereum", cursor, tip, gap }, "reconciler: ethereum incremental scan from chain cursor");
    }

    return BigInt(from);
  }

  private async computeSorobanFromLedger(latestSeq: number): Promise<number> {
    const chainCursor = await this.orders.getChainCursor("stellar");
    const minOrderCursor = await this.orders.getMinActiveOrderCursor("stellar");

    let cursor = chainCursor;
    if (minOrderCursor !== null && minOrderCursor > 0) {
      cursor = cursor > 0 ? Math.min(cursor, minOrderCursor) : minOrderCursor;
    }

    const { from, gap, usedLookbackFallback } = computeIncrementalScanStart(
      cursor,
      latestSeq,
      SOROBAN_LOOKBACK_LEDGERS
    );

    reconciliationGapBlocks.set({ chain: "stellar" }, gap);
    reconciliationLookbackCoverage.set({ chain: "stellar" }, Math.min(gap, SOROBAN_LOOKBACK_LEDGERS));

    if (cursor > 0 && gap > SOROBAN_LOOKBACK_LEDGERS) {
      this.log.warn(
        { chain: "stellar", cursor, tip: latestSeq, gap, lookback: SOROBAN_LOOKBACK_LEDGERS },
        "reconciler: Soroban gap exceeds lookback window — some events may be permanently missed"
      );
      reconciliationConflicts.inc({ chain: "stellar", conflict_type: "gap_exceeds_lookback" });
    } else if (cursor > 0 && !usedLookbackFallback) {
      this.log.info({ chain: "stellar", cursor, tip: latestSeq, gap }, "reconciler: soroban incremental scan from chain cursor");
    }

    return from;
  }

  private async computeSolanaFromSlot(tipSlot: number): Promise<number> {
    const chainCursor = await this.orders.getChainCursor("solana");
    const minOrderCursor = await this.orders.getMinActiveOrderCursor("solana");

    let cursor = chainCursor;
    if (minOrderCursor !== null && minOrderCursor > 0) {
      cursor = cursor > 0 ? Math.min(cursor, minOrderCursor) : minOrderCursor;
    }

    const { from, gap, usedLookbackFallback } = computeIncrementalScanStart(
      cursor,
      tipSlot,
      SOLANA_LOOKBACK_SLOTS
    );

    reconciliationGapBlocks.set({ chain: "solana" }, gap);
    reconciliationLookbackCoverage.set({ chain: "solana" }, Math.min(gap, SOLANA_LOOKBACK_SLOTS));

    if (cursor > 0 && gap > SOLANA_LOOKBACK_SLOTS) {
      this.log.warn(
        { chain: "solana", cursor, tip: tipSlot, gap, lookback: SOLANA_LOOKBACK_SLOTS },
        "reconciler: Solana gap exceeds lookback window — some events may be permanently missed"
      );
      reconciliationConflicts.inc({ chain: "solana", conflict_type: "gap_exceeds_lookback" });
    } else if (cursor > 0 && !usedLookbackFallback) {
      this.log.info({ chain: "solana", cursor, tip: tipSlot, gap }, "reconciler: solana incremental scan from chain cursor");
    }

    return from;
  }

  private async advanceOrderCursor(
    publicId: string,
    chain: "ethereum" | "stellar" | "solana",
    position: number
  ): Promise<void> {
    if (position <= 0) return;
    switch (chain) {
      case "ethereum":
        await this.orders.advanceOrderLedgerCursor(publicId, { lastEthBlock: position });
        break;
      case "stellar":
        await this.orders.advanceOrderLedgerCursor(publicId, { lastSorobanLedger: position });
        break;
      case "solana":
        await this.orders.advanceOrderLedgerCursor(publicId, { lastSolanaSlot: position });
        break;
    }
  }

  // ─── Ethereum ─────────────────────────────────────────────────────────────

  private async reconcileEthereum(): Promise<number> {
    if (!this.cfg.ethereum.htlcEscrow) return 0;
    if (!this.ethCursor) return 0;

    const address = this.cfg.ethereum.htlcEscrow;
    const latest = await this.ethClient.getBlockNumber();
    const fromBlock = await this.computeEthFromBlock(latest);

    const [createdLogs, claimedLogs, refundedLogs] = await Promise.all([
      this.ethClient.getLogs({ address, event: ORDER_CREATED, fromBlock, toBlock }),
      this.ethClient.getLogs({ address, event: ORDER_CLAIMED, fromBlock, toBlock }),
      this.ethClient.getLogs({ address, event: ORDER_REFUNDED, fromBlock, toBlock }),
    ]);

    let replayed = 0;
    replayed += await this.replayEthCreated(createdLogs);
    replayed += await this.replayEthClaimed(claimedLogs);
    replayed += await this.replayEthRefunded(refundedLogs);

    // Persist cursor so the next run knows where we got to.
    await this.orders.setChainCursor("ethereum", Number(latest));
    return replayed;
  }

  private async replayEthCreated(logs: Log[]): Promise<number> {
    let n = 0;
    for (const log of logs) {
      const args = (log as any).args as {
        orderId?: bigint;
        hashlock?: `0x${string}`;
        timelock?: bigint;
      };
      if (!args?.hashlock || args.orderId === undefined) continue;

      const logIndex = (log as any).logIndex ?? 0;
      const txHash = log.transactionHash ?? "0x";
      const key = ethEventKey("OrderCreated", txHash, logIndex);
      const semKey = semanticKey("ethereum", "OrderCreated", args.hashlock);

      const conflict = this.seenSet.checkAndMark("ethereum", "OrderCreated", key, semKey);
      if (conflict) {
        this.log.debug({ key, kind: conflict.kind }, "reconciler: ETH OrderCreated dedup skip");
        continue;
      }

      try {
        const order = await this.orders.findByHashlock(args.hashlock);
        if (!order) {
          // Chain has an event for an order we have no announcement for.
          // This is normal for orders announced by other clients; emit a
          // debug log rather than a warning.
          this.log.debug({ hashlock: args.hashlock }, "reconciler: ETH OrderCreated for unknown order — skipping");
          reconciliationEventsSkipped.inc({ chain: "ethereum", reason: "order_not_found" });
          continue;
        }

        const blockNum = safeToNumber(
          log.blockNumber ?? 0n,
          "blockNumber",
          `ETH OrderCreated hashlock=${args.hashlock}`,
          "ethereum",
          (e) => this.log.warn(e, "reconciler: unsafe block number — skipping ETH OrderCreated")
        );
        if (blockNum === null) {
          reconciliationEventsSkipped.inc({ chain: "ethereum", reason: "unsafe_integer" });
          continue;
        }

        if (isEventBehindOrderCursor(order.lastEthBlock, blockNum)) {
          reconciliationEventsSkipped.inc({ chain: "ethereum", reason: "cursor_already_processed" });
          continue;
        }

        const decision = decideDispatch({
          path: "replay",
          mutation: "src_lock",
          incomingSequence: blockNum,
          existingSequence: order.srcLockBlock ?? null,
          alreadyApplied: order.srcOrderId !== null,
        });
        workflowDispatchDecisions.inc({ path: "replay", mutation: "src_lock", outcome: decision.reason });

        if (!decision.shouldApply) {
          reconciliationEventsSkipped.inc({ chain: "ethereum", reason: decision.reason });
          await this.advanceOrderCursor(order.publicId, "ethereum", blockNum);
          // Conflict detection: chain shows a created event but DB is already
          // terminal — this indicates the order completed/refunded in a prior
          // session and is expected during replay of old history.
          if (isTerminal(order.status)) {
            reconciliationConflicts.inc({ chain: "ethereum", conflict_type: "chain_ahead" });
            this.log.info(
              { publicId: order.publicId, status: order.status, hashlock: args.hashlock },
              "reconciler: ETH OrderCreated skipped — order already terminal (expected after refund/complete)"
            );
          }
          continue;
        }

        const timelockNum = safeToNumber(
          args.timelock,
          "timelock",
          `ETH OrderCreated hashlock=${args.hashlock}`,
          "ethereum",
          (e) => this.log.warn(e, "reconciler: unsafe timelock — skipping ETH OrderCreated")
        );
        if (timelockNum === null) {
          reconciliationEventsSkipped.inc({ chain: "ethereum", reason: "unsafe_integer" });
          continue;
        }

        await this.orders.recordSrcLock({
          publicId: order.publicId,
          orderId: args.orderId.toString(),
          txHash: log.transactionHash ?? "0x",
          blockNumber: blockNum,
          timelock: timelockNum,
        });
        await this.advanceOrderCursor(order.publicId, "ethereum", blockNum);
        n++;
        reconciliationRestartRecoveryEvents.inc({ chain: "ethereum" });
        this.log.info({ hashlock: args.hashlock }, "reconciler: replayed ETH OrderCreated");
      } catch (err: any) {
        if (err?.message?.includes("cannot record") || err?.message?.includes("terminal")) {
          reconciliationEventsSkipped.inc({ chain: "ethereum", reason: "already_applied" });
          const blockNum = safeToNumber(
            log.blockNumber ?? 0n,
            "blockNumber",
            `ETH OrderCreated catch hashlock=${args?.hashlock}`,
            "ethereum",
            () => {}
          );
          if (blockNum !== null && args?.hashlock) {
            const order = await this.orders.findByHashlock(args.hashlock);
            if (order) await this.advanceOrderCursor(order.publicId, "ethereum", blockNum);
          }
          continue;
        }
        this.log.warn({ err, hashlock: args.hashlock }, "reconciler: ETH created replay error");
      }
    }
    return n;
  }

  private async replayEthClaimed(logs: Log[]): Promise<number> {
    let n = 0;
    for (const log of logs) {
      const args = (log as any).args as { orderId: bigint; preimage: `0x${string}` };
      if (!args?.orderId || !args?.preimage) continue;

      const logIndex = (log as any).logIndex ?? 0;
      const txHash = log.transactionHash ?? "0x";
      const key = ethEventKey("OrderClaimed", txHash, logIndex);
      const semKey = semanticKey("ethereum", "OrderClaimed", args.orderId.toString());

      const conflict = this.seenSet.checkAndMark("ethereum", "OrderClaimed", key, semKey);
      if (conflict) continue;

      try {
        const order = await this.orders.findBySrcOrderId("ethereum", args.orderId.toString());
        if (!order) {
          reconciliationEventsSkipped.inc({ chain: "ethereum", reason: "order_not_found" });
          continue;
        }

        const blockNum = safeToNumber(
          log.blockNumber ?? 0n,
          "blockNumber",
          `ETH OrderClaimed orderId=${args.orderId}`,
          "ethereum",
          (e) => this.log.warn(e, "reconciler: unsafe block number — skipping ETH OrderClaimed")
        );
        if (blockNum === null) {
          reconciliationEventsSkipped.inc({ chain: "ethereum", reason: "unsafe_integer" });
          continue;
        }

        if (isEventBehindOrderCursor(order.lastEthBlock, blockNum)) {
          reconciliationEventsSkipped.inc({ chain: "ethereum", reason: "cursor_already_processed" });
          continue;
        }

        const decision = decideDispatch({
          path: "replay",
          mutation: "secret_reveal",
          incomingSequence: blockNum,
          existingSequence: null,
          alreadyApplied: order.preimage !== null,
        });
        workflowDispatchDecisions.inc({ path: "replay", mutation: "secret_reveal", outcome: decision.reason });

        if (!decision.shouldApply) {
          reconciliationEventsSkipped.inc({ chain: "ethereum", reason: decision.reason });
          await this.advanceOrderCursor(order.publicId, "ethereum", blockNum);
          continue;
        }

        if (!validatePreimage(args.preimage, order.hashlock)) {
          reconciliationConflicts.inc({ chain: "ethereum", conflict_type: "terminal_clash" });
          this.log.warn(
            { orderId: args.orderId.toString(), publicId: order.publicId, hashlock: order.hashlock },
            "reconciler: ETH OrderClaimed preimage/hashlock mismatch — chain evidence disagrees with DB record; manual review required"
          );
          reconciliationEventsSkipped.inc({ chain: "ethereum", reason: "preimage_mismatch" });
          await this.advanceOrderCursor(order.publicId, "ethereum", blockNum);
          continue;
        }

        await this.orders.recordSecret(order.publicId, args.preimage, log.transactionHash ?? "0x");
        await this.advanceOrderCursor(order.publicId, "ethereum", blockNum);
        n++;
        reconciliationRestartRecoveryEvents.inc({ chain: "ethereum" });
        this.log.info({ orderId: args.orderId.toString() }, "reconciler: replayed ETH OrderClaimed");
      } catch (err: any) {
        if (err?.message?.includes("cannot record") || err?.message?.includes("terminal")) {
          reconciliationEventsSkipped.inc({ chain: "ethereum", reason: "already_applied" });
          const blockNum = safeToNumber(log.blockNumber ?? 0n, "blockNumber", "ETH OrderClaimed catch", "ethereum", () => {});
          if (blockNum !== null) {
            const order = args?.orderId
              ? await this.orders.findBySrcOrderId("ethereum", args.orderId.toString())
              : null;
            if (order) await this.advanceOrderCursor(order.publicId, "ethereum", blockNum);
          }
          continue;
        }
        this.log.warn({ err }, "reconciler: ETH claimed replay error");
      }
    }
    return n;
  }

  private async replayEthRefunded(logs: Log[]): Promise<number> {
    let n = 0;
    for (const log of logs) {
      const args = (log as any).args as { orderId?: bigint };
      if (!args?.orderId) continue;

      const logIndex = (log as any).logIndex ?? 0;
      const txHash = log.transactionHash ?? "0x";
      const key = ethEventKey("OrderRefunded", txHash, logIndex);
      const semKey = semanticKey("ethereum", "OrderRefunded", args.orderId.toString());

      const conflict = this.seenSet.checkAndMark("ethereum", "OrderRefunded", key, semKey);
      if (conflict) continue;

      try {
        const order = await this.orders.findBySrcOrderId("ethereum", args.orderId.toString());
        if (!order) {
          reconciliationEventsSkipped.inc({ chain: "ethereum", reason: "order_not_found" });
          continue;
        }

        const blockNum = safeToNumber(
          log.blockNumber ?? 0n,
          "blockNumber",
          `ETH OrderRefunded orderId=${args.orderId}`,
          "ethereum",
          (e) => this.log.warn(e, "reconciler: unsafe block number — skipping ETH OrderRefunded")
        );
        if (blockNum === null) {
          reconciliationEventsSkipped.inc({ chain: "ethereum", reason: "unsafe_integer" });
          continue;
        }

        if (isEventBehindOrderCursor(order.lastEthBlock, blockNum)) {
          reconciliationEventsSkipped.inc({ chain: "ethereum", reason: "cursor_already_processed" });
          continue;
        }

        const decision = decideDispatch({
          path: "replay",
          mutation: "refund",
          incomingSequence: blockNum,
          existingSequence: order.srcLockBlock ?? null,
          alreadyApplied: order.status === "refunded" || order.status === "completed",
        });
        workflowDispatchDecisions.inc({ path: "replay", mutation: "refund", outcome: decision.reason });

        if (!decision.shouldApply) {
          reconciliationEventsSkipped.inc({ chain: "ethereum", reason: decision.reason });
          await this.advanceOrderCursor(order.publicId, "ethereum", blockNum);
          // DB says completed but chain shows refund — that's an ambiguous conflict.
          if (order.status === "completed") {
            reconciliationConflicts.inc({ chain: "ethereum", conflict_type: "terminal_clash" });
            this.log.error(
              { publicId: order.publicId, orderId: args.orderId.toString() },
              "reconciler: ETH OrderRefunded conflicts with DB status=completed — ambiguous terminal state; manual review required"
            );
          }
          continue;
        }

        await this.orders.markStatus(order.publicId, "refunded");
        await this.advanceOrderCursor(order.publicId, "ethereum", blockNum);
        n++;
        reconciliationRestartRecoveryEvents.inc({ chain: "ethereum" });
        this.log.info({ orderId: args.orderId.toString() }, "reconciler: replayed ETH OrderRefunded");
      } catch (err: any) {
        if (err?.message?.includes("cannot transition") || err?.message?.includes("terminal")) {
          reconciliationEventsSkipped.inc({ chain: "ethereum", reason: "already_applied" });
          const blockNum = safeToNumber(log.blockNumber ?? 0n, "blockNumber", "ETH OrderRefunded catch", "ethereum", () => {});
          if (blockNum !== null) {
            const order = args?.orderId
              ? await this.orders.findBySrcOrderId("ethereum", args.orderId.toString())
              : null;
            if (order) await this.advanceOrderCursor(order.publicId, "ethereum", blockNum);
          }
          continue;
        }
        this.log.warn({ err }, "reconciler: ETH refunded replay error");
      }
    }
    return n;
  }

  // ─── Soroban ──────────────────────────────────────────────────────────────

  private async reconcileSoroban(): Promise<number> {
    if (!this.cfg.soroban.htlcContract) return 0;
    if (!this.sorobanCursor) return 0;

    const contractId = this.cfg.soroban.htlcContract;
    const latest = await this.sorobanServer.getLatestLedger();
    const tip = latest.sequence;

    const assessment = this.sorobanCursor.assess(tip);
    const decision = buildReplayDecision("soroban", assessment);
    this.policy.recordDecision(decision);

    if (decision.windowSize === 0) {
      this.log.debug({ chain: "soroban", hwm: assessment.hwm, tip }, "reconciler: Soroban up to date");
      return 0;
    }

    this.log.info(
      {
        chain: "soroban",
        fromBlock: decision.fromBlock,
        toBlock: decision.toBlock,
        windowSize: decision.windowSize,
        gapSeverity: decision.gapSeverity,
      },
      "reconciler: Soroban replay window",
    );

    let replayed = 0;
    let eventIndex = 0;

    try {
      const latest = await this.sorobanServer.getLatestLedger();
      const startLedger = await this.computeSorobanFromLedger(latest.sequence);

    try {
      do {
        const events = await this.sorobanServer.getEvents({
          filters: [{ type: "contract", contractIds: [contractId] }],
          startLedger: pageCursor ? undefined : startLedger,
          cursor: pageCursor,
          limit: 200,
        });

        for (const ev of events.events) {
          replayed += await this.replaySorobanEvent(ev, eventIndex++);
        }

        cursor = events.cursor ?? undefined;
        if (events.events.length < 200) break;
      } while (cursor);

      await this.orders.setChainCursor("stellar", latest.sequence);
    } catch (err) {
      // Stale page cursor — clear it so the next run re-scans from HWM.
      this.sorobanRpcCursor = undefined;
      this.log.warn({ err }, "reconciler: Soroban fetch failed — page cursor reset");
      throw err; // Let the caller count this as a chain error.
    }

    this.sorobanCursor.advance(tip);
    return replayed;
  }

  private async replaySorobanEvent(ev: any): Promise<number> {
    const result = decodeHtlcEvent(ev.topic ?? [], ev.value);

    if (isMalformedEvent(result)) {
      sorobanDecodeErrors.inc({ reason: result.reason });
      this.log.warn(
        { ledger: ev.ledger, txHash: ev.txHash, kind: result.kind, reason: result.reason },
        "reconciler: Soroban event payload malformed — skipping"
      );
      reconciliationEventsSkipped.inc({ chain: "stellar", reason: "malformed_payload" });
      return 0;
    }

    if (result === null) return 0;

    if (result.kind === "created") {
      try {
        const order = await this.orders.findByHashlock(result.hashlock);
        if (!order) {
          reconciliationEventsSkipped.inc({ chain: "stellar", reason: "order_not_found" });
          return 0;
        }
        if (isEventBehindOrderCursor(order.lastSorobanLedger, ev.ledger)) {
          reconciliationEventsSkipped.inc({ chain: "stellar", reason: "cursor_already_processed" });
          return 0;
        }
        const decision = decideDispatch({
          path: "replay",
          mutation: "src_lock",
          incomingSequence: ev.ledger,
          existingSequence: order.srcLockBlock ?? null,
          alreadyApplied: order.srcOrderId !== null,
        });
        workflowDispatchDecisions.inc({ path: "replay", mutation: "src_lock", outcome: decision.reason });
        if (!decision.shouldApply) {
          reconciliationEventsSkipped.inc({ chain: "stellar", reason: decision.reason });
          await this.advanceOrderCursor(order.publicId, "stellar", ev.ledger);
          if (isTerminal(order.status)) {
            reconciliationConflicts.inc({ chain: "stellar", conflict_type: "chain_ahead" });
          }
          return 0;
        }
        await this.orders.recordSrcLock({
          publicId: order.publicId,
          orderId: result.orderId.toString(),
          txHash: ev.txHash,
          blockNumber: ev.ledger,
          timelock: result.timelock,
        });
        await this.advanceOrderCursor(order.publicId, "stellar", ev.ledger);
        reconciliationRestartRecoveryEvents.inc({ chain: "stellar" });
        this.log.info({ hashlock: result.hashlock }, "reconciler: replayed Soroban created");
        return 1;
      } catch (err: any) {
        if (err?.message?.includes("cannot record") || err?.message?.includes("terminal")) {
          reconciliationEventsSkipped.inc({ chain: "stellar", reason: "already_applied" });
          const order = await this.orders.findByHashlock(result.hashlock);
          if (order) await this.advanceOrderCursor(order.publicId, "stellar", ev.ledger);
          return 0;
        }
        this.log.warn({ err, hashlock: result.hashlock }, "reconciler: Soroban created replay error");
        return 0;
      }
    }

    if (result.kind === "claimed") {
      try {
        const order = await this.orders.findBySrcOrderId("stellar", result.orderId.toString());
        if (!order) {
          reconciliationEventsSkipped.inc({ chain: "stellar", reason: "order_not_found" });
          return 0;
        }
        if (isEventBehindOrderCursor(order.lastSorobanLedger, ev.ledger)) {
          reconciliationEventsSkipped.inc({ chain: "stellar", reason: "cursor_already_processed" });
          return 0;
        }
        const decision = decideDispatch({
          path: "replay",
          mutation: "secret_reveal",
          incomingSequence: ev.ledger,
          existingSequence: null,
          alreadyApplied: order.preimage !== null,
        });
        workflowDispatchDecisions.inc({ path: "replay", mutation: "secret_reveal", outcome: decision.reason });
        if (!decision.shouldApply) {
          reconciliationEventsSkipped.inc({ chain: "stellar", reason: decision.reason });
          await this.advanceOrderCursor(order.publicId, "stellar", ev.ledger);
          return 0;
        }
        if (!validatePreimage(result.preimage, order.hashlock)) {
          reconciliationConflicts.inc({ chain: "stellar", conflict_type: "terminal_clash" });
          this.log.warn(
            { orderId: result.orderId.toString(), publicId: order.publicId },
            "reconciler: Soroban claimed preimage/hashlock mismatch — chain evidence disagrees; manual review required"
          );
          reconciliationEventsSkipped.inc({ chain: "stellar", reason: "preimage_mismatch" });
          await this.advanceOrderCursor(order.publicId, "stellar", ev.ledger);
          return 0;
        }
        await this.orders.recordSecret(order.publicId, result.preimage, ev.txHash);
        await this.advanceOrderCursor(order.publicId, "stellar", ev.ledger);
        reconciliationRestartRecoveryEvents.inc({ chain: "stellar" });
        this.log.info({ orderId: result.orderId.toString() }, "reconciler: replayed Soroban claimed");
        return 1;
      } catch (err: any) {
        if (err?.message?.includes("cannot record") || err?.message?.includes("terminal")) {
          reconciliationEventsSkipped.inc({ chain: "stellar", reason: "already_applied" });
          const order = await this.orders.findBySrcOrderId("stellar", result.orderId.toString());
          if (order) await this.advanceOrderCursor(order.publicId, "stellar", ev.ledger);
          return 0;
        }
        this.log.warn({ err }, "reconciler: Soroban claimed replay error");
        return 0;
      }
    }

    if (result.kind === "refunded") {
      try {
        const order = await this.orders.findBySrcOrderId("stellar", result.orderId.toString());
        if (!order) {
          reconciliationEventsSkipped.inc({ chain: "stellar", reason: "order_not_found" });
          return 0;
        }
        if (isEventBehindOrderCursor(order.lastSorobanLedger, ev.ledger)) {
          reconciliationEventsSkipped.inc({ chain: "stellar", reason: "cursor_already_processed" });
          return 0;
        }
        const decision = decideDispatch({
          path: "replay",
          mutation: "refund",
          incomingSequence: ev.ledger,
          existingSequence: order.srcLockBlock ?? null,
          alreadyApplied: order.status === "refunded" || order.status === "completed",
        });
        workflowDispatchDecisions.inc({ path: "replay", mutation: "refund", outcome: decision.reason });
        if (!decision.shouldApply) {
          reconciliationEventsSkipped.inc({ chain: "stellar", reason: decision.reason });
          await this.advanceOrderCursor(order.publicId, "stellar", ev.ledger);
          if (order.status === "completed") {
            reconciliationConflicts.inc({ chain: "stellar", conflict_type: "terminal_clash" });
            this.log.error(
              { publicId: order.publicId, orderId: result.orderId.toString() },
              "reconciler: Soroban OrderRefunded conflicts with DB status=completed — manual review required"
            );
          }
          return 0;
        }
        await this.orders.markStatus(order.publicId, "refunded");
        await this.advanceOrderCursor(order.publicId, "stellar", ev.ledger);
        reconciliationRestartRecoveryEvents.inc({ chain: "stellar" });
        this.log.info({ orderId: result.orderId.toString() }, "reconciler: replayed Soroban refunded");
        return 1;
      } catch (err: any) {
        if (err?.message?.includes("cannot transition") || err?.message?.includes("terminal")) {
          reconciliationEventsSkipped.inc({ chain: "stellar", reason: "already_applied" });
          const order = await this.orders.findBySrcOrderId("stellar", result.orderId.toString());
          if (order) await this.advanceOrderCursor(order.publicId, "stellar", ev.ledger);
          return 0;
        }
        this.log.warn({ err }, "reconciler: Soroban refunded replay error");
        return 0;
      }
    }

    return 0;
  }

  // ─── Solana ───────────────────────────────────────────────────────────────

  private async reconcileSolana(): Promise<number> {
    if (!this.cfg.solana.programId || this.cfg.solana.programId === "PLACEHOLDER") return 0;
    if (!this.solanaCursor) return 0;

    const tip = await this.solanaConn.getSlot(this.cfg.solana.commitment);
    const assessment = this.solanaCursor.assess(tip);
    const decision = buildReplayDecision("solana", assessment);
    this.policy.recordDecision(decision);

    if (decision.windowSize === 0) {
      this.log.debug({ chain: "solana", hwm: assessment.hwm, tip }, "reconciler: Solana up to date");
      return 0;
    }

    this.log.info(
      {
        chain: "solana",
        fromBlock: decision.fromBlock,
        toBlock: decision.toBlock,
        windowSize: decision.windowSize,
        gapSeverity: decision.gapSeverity,
      },
      "reconciler: Solana replay window",
    );

    const programPk = new PublicKey(this.cfg.solana.programId);
    const minContextSlot = Math.max(0, decision.fromBlock);

    let replayed = 0;
    try {
      const slot = await this.solanaConn.getSlot(this.cfg.solana.commitment);
      const minSlot = await this.computeSolanaFromSlot(slot);
      const programPk = new PublicKey(this.cfg.solana.programId);

      const sigs = await this.solanaConn.getSignaturesForAddress(programPk, {
        limit: 1000,
        minContextSlot,
      });

      for (const sigInfo of sigs) {
        if (sigInfo.err) continue;
        // Only process signatures within our window.
        if (sigInfo.slot < decision.fromBlock || sigInfo.slot > decision.toBlock) continue;
        try {
          const tx = await this.solanaConn.getParsedTransaction(sigInfo.signature, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
          });
          if (!tx?.meta?.logMessages) continue;
          replayed += await this.replaySolanaLogs(
            sigInfo.signature,
            tx.meta.logMessages,
            sigInfo.slot ?? 0
          );
        } catch (err) {
          this.log.warn({ sig: sigInfo.signature, err }, "reconciler: Solana tx fetch failed");
        }
      }

      await this.orders.setChainCursor("solana", slot);
    } catch (err) {
      this.log.warn({ err }, "reconciler: Solana signatures fetch failed");
      throw err;
    }

    this.solanaCursor.advance(tip);
    return replayed;
  }

  private async replaySolanaLogs(sig: string, logs: string[], slot: number): Promise<number> {
    let eventType: string | null = null;
    const payload: Record<string, unknown> = {};

    for (const line of logs) {
      if (line.includes("OrderCreated")) eventType = "OrderCreated";
      if (line.includes("OrderClaimed")) eventType = "OrderClaimed";
      if (line.includes("OrderRefunded")) eventType = "OrderRefunded";
      const jsonMatch = line.match(/\{.*\}/);
      if (jsonMatch) {
        try { Object.assign(payload, JSON.parse(jsonMatch[0])); } catch { /* skip */ }
      }
    }

    if (!eventType) return 0;

    if (eventType === "OrderCreated") {
      const { hashlock, orderId, timelock } = payload as {
        hashlock?: string; orderId?: string; timelock?: number;
      };
      if (!hashlock || !orderId) return 0;

      const key = solanaEventKey("OrderCreated", sig);
      const semKey = semanticKey("solana", "OrderCreated", hashlock);
      const conflict = this.seenSet.checkAndMark("solana", "OrderCreated", key, semKey);
      if (conflict) return 0;

      try {
        const order = await this.orders.findByHashlock(hashlock);
        if (!order) {
          reconciliationEventsSkipped.inc({ chain: "solana", reason: "order_not_found" });
          return 0;
        }
        if (isEventBehindOrderCursor(order.lastSolanaSlot, slot)) {
          reconciliationEventsSkipped.inc({ chain: "solana", reason: "cursor_already_processed" });
          return 0;
        }
        const decision = decideDispatch({
          path: "replay",
          mutation: "src_lock",
          incomingSequence: slot,
          existingSequence: order.srcLockBlock ?? null,
          alreadyApplied: order.srcOrderId !== null,
        });
        workflowDispatchDecisions.inc({ path: "replay", mutation: "src_lock", outcome: decision.reason });
        if (!decision.shouldApply) {
          reconciliationEventsSkipped.inc({ chain: "solana", reason: decision.reason });
          await this.advanceOrderCursor(order.publicId, "solana", slot);
          if (isTerminal(order.status)) {
            reconciliationConflicts.inc({ chain: "solana", conflict_type: "chain_ahead" });
          }
          return 0;
        }
        await this.orders.recordSrcLock({ publicId: order.publicId, orderId, txHash: sig, blockNumber: slot, timelock: timelock ?? 0 });
        await this.advanceOrderCursor(order.publicId, "solana", slot);
        reconciliationRestartRecoveryEvents.inc({ chain: "solana" });
        return 1;
      } catch (err: any) {
        if (err?.message?.includes("cannot record") || err?.message?.includes("terminal")) {
          reconciliationEventsSkipped.inc({ chain: "solana", reason: "already_applied" });
          const order = hashlock ? await this.orders.findByHashlock(hashlock) : null;
          if (order) await this.advanceOrderCursor(order.publicId, "solana", slot);
          return 0;
        }
        this.log.warn({ err, hashlock }, "reconciler: Solana OrderCreated replay error");
        return 0;
      }
    }

    if (eventType === "OrderClaimed") {
      const { preimage, orderId } = payload as { preimage?: string; orderId?: string };
      if (!preimage || !orderId) return 0;

      const key = solanaEventKey("OrderClaimed", sig);
      const semKey = semanticKey("solana", "OrderClaimed", orderId);
      const conflict = this.seenSet.checkAndMark("solana", "OrderClaimed", key, semKey);
      if (conflict) return 0;

      try {
        const order = await this.orders.findBySrcOrderId("solana", orderId);
        if (!order) {
          reconciliationEventsSkipped.inc({ chain: "solana", reason: "order_not_found" });
          return 0;
        }
        if (isEventBehindOrderCursor(order.lastSolanaSlot, slot)) {
          reconciliationEventsSkipped.inc({ chain: "solana", reason: "cursor_already_processed" });
          return 0;
        }
        const decision = decideDispatch({
          path: "replay",
          mutation: "secret_reveal",
          incomingSequence: slot,
          existingSequence: null,
          alreadyApplied: order.preimage !== null,
        });
        workflowDispatchDecisions.inc({ path: "replay", mutation: "secret_reveal", outcome: decision.reason });
        if (!decision.shouldApply) {
          reconciliationEventsSkipped.inc({ chain: "solana", reason: decision.reason });
          await this.advanceOrderCursor(order.publicId, "solana", slot);
          return 0;
        }
        if (!validatePreimage(preimage, order.hashlock)) {
          reconciliationConflicts.inc({ chain: "solana", conflict_type: "terminal_clash" });
          this.log.warn({ orderId, publicId: order.publicId }, "reconciler: Solana OrderClaimed preimage/hashlock mismatch — manual review required");
          reconciliationEventsSkipped.inc({ chain: "solana", reason: "preimage_mismatch" });
          await this.advanceOrderCursor(order.publicId, "solana", slot);
          return 0;
        }
        await this.orders.recordSecret(order.publicId, preimage, sig);
        await this.advanceOrderCursor(order.publicId, "solana", slot);
        reconciliationRestartRecoveryEvents.inc({ chain: "solana" });
        return 1;
      } catch (err: any) {
        if (err?.message?.includes("cannot record") || err?.message?.includes("terminal")) {
          reconciliationEventsSkipped.inc({ chain: "solana", reason: "already_applied" });
          const order = orderId ? await this.orders.findBySrcOrderId("solana", orderId) : null;
          if (order) await this.advanceOrderCursor(order.publicId, "solana", slot);
          return 0;
        }
        this.log.warn({ err }, "reconciler: Solana OrderClaimed replay error");
        return 0;
      }
    }

    if (eventType === "OrderRefunded") {
      const { orderId } = payload as { orderId?: string };
      if (!orderId) return 0;

      const key = solanaEventKey("OrderRefunded", sig);
      const semKey = semanticKey("solana", "OrderRefunded", orderId);
      const conflict = this.seenSet.checkAndMark("solana", "OrderRefunded", key, semKey);
      if (conflict) return 0;

      try {
        const order = await this.orders.findBySrcOrderId("solana", orderId);
        if (!order) {
          reconciliationEventsSkipped.inc({ chain: "solana", reason: "order_not_found" });
          return 0;
        }
        if (isEventBehindOrderCursor(order.lastSolanaSlot, slot)) {
          reconciliationEventsSkipped.inc({ chain: "solana", reason: "cursor_already_processed" });
          return 0;
        }
        const decision = decideDispatch({
          path: "replay",
          mutation: "refund",
          incomingSequence: slot,
          existingSequence: order.srcLockBlock ?? null,
          alreadyApplied: order.status === "refunded" || order.status === "completed",
        });
        workflowDispatchDecisions.inc({ path: "replay", mutation: "refund", outcome: decision.reason });
        if (!decision.shouldApply) {
          reconciliationEventsSkipped.inc({ chain: "solana", reason: decision.reason });
          await this.advanceOrderCursor(order.publicId, "solana", slot);
          if (order.status === "completed") {
            reconciliationConflicts.inc({ chain: "solana", conflict_type: "terminal_clash" });
            this.log.error({ publicId: order.publicId, orderId }, "reconciler: Solana OrderRefunded conflicts with DB status=completed — manual review required");
          }
          return 0;
        }
        await this.orders.markStatus(order.publicId, "refunded");
        await this.advanceOrderCursor(order.publicId, "solana", slot);
        reconciliationRestartRecoveryEvents.inc({ chain: "solana" });
        return 1;
      } catch (err: any) {
        if (err?.message?.includes("cannot transition") || err?.message?.includes("terminal")) {
          reconciliationEventsSkipped.inc({ chain: "solana", reason: "already_applied" });
          const order = orderId ? await this.orders.findBySrcOrderId("solana", orderId) : null;
          if (order) await this.advanceOrderCursor(order.publicId, "solana", slot);
          return 0;
        }
        this.log.warn({ err }, "reconciler: Solana OrderRefunded replay error");
        return 0;
      }
    }

    return 0;
  }
}
