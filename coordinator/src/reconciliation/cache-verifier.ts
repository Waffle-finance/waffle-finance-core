/**
 * @file cache-verifier.ts
 *
 * Snapshot verification job for the coordinator's DB cache.
 *
 * ## Why this file exists
 *
 * The coordinator's SQLite/Postgres database is explicitly a CACHE of on-chain
 * state (see the comment in schema.sql).  After a recovery, schema migration,
 * or extended downtime the cache may drift from the authoritative on-chain
 * evidence.  This verifier runs on demand or on a schedule and compares a
 * representative sample of cached order state against the on-chain evidence
 * from each configured chain.
 *
 * ## Design choices
 *
 * - The verifier NEVER mutates order state.  It is strictly read-only.
 *   Reconciliation (reconciler.ts) owns all state repair.
 * - Mismatches are classified and logged with enough context for operators to
 *   understand what drifted and which reconciliation action would fix it.
 * - The result is exposed via a `CacheVerificationStatus` value that the
 *   readiness layer can surface as a `cache_alignment` check.
 * - To keep RPC costs low the verifier works on a sample of non-terminal
 *   orders up to `sampleSize` (default 50).  Operators can call `run()` with
 *   a specific `orderIds` array to verify a targeted range.
 *
 * ## Mismatch types
 *
 * | code                     | meaning                                                     |
 * |--------------------------|-------------------------------------------------------------|
 * | `src_lock_missing`       | DB says src_locked but on-chain has no matching lock event  |
 * | `src_lock_unexpected`    | DB says announced but on-chain has a lock event for it      |
 * | `claimed_missing`        | DB has no preimage but on-chain emitted a Claimed event      |
 * | `refunded_missing`       | DB is not refunded but on-chain emitted a Refunded event     |
 * | `status_stale`           | DB status is non-terminal but on-chain shows terminal state  |
 */

import {
  createPublicClient,
  http,
  parseAbiItem,
  type PublicClient,
} from "viem";
import { sepolia, mainnet } from "viem/chains";
import { rpc } from "@stellar/stellar-sdk";
import type { Logger } from "pino";
import type { CoordinatorConfig } from "../config.js";
import type { OrdersRepository } from "../persistence/orders-repo.js";
import type { OrderRow, OrderStatus } from "../persistence/orders-repo.js";
import {
  cacheVerifierRuns,
  cacheVerifierMismatches,
  cacheVerifierSampleSize,
  cacheVerifierLastRun,
  cacheVerifierLastRunMismatches,
} from "../metrics.js";

// ── ABI fragments (identical to Reconciler) ───────────────────────────────────

const ORDER_CREATED = parseAbiItem(
  "event OrderCreated(uint256 indexed orderId, address indexed sender, address indexed beneficiary, address token, uint256 amount, uint256 safetyDeposit, bytes32 hashlock, uint64 timelock)"
);
const ORDER_CLAIMED = parseAbiItem(
  "event OrderClaimed(uint256 indexed orderId, address indexed claimer, bytes32 preimage, uint256 amount, uint256 safetyDeposit)"
);
const ORDER_REFUNDED = parseAbiItem(
  "event OrderRefunded(uint256 indexed orderId, address indexed caller, uint256 amount, uint256 safetyDeposit)"
);

/** Ethereum block lookback for a single verification pass (~24 h at 12 s/block). */
const ETH_VERIFY_LOOKBACK = 7_200n;
/** Soroban ledger lookback (~5 s/ledger, ~24 h). */
const SOROBAN_VERIFY_LOOKBACK = 17_280;

// ── Public types ──────────────────────────────────────────────────────────────

export type MismatchType =
  | "src_lock_missing"      // DB src_locked but no on-chain lock event found
  | "src_lock_unexpected"   // DB announced but on-chain has a lock event
  | "claimed_missing"       // DB has no preimage but on-chain emitted Claimed
  | "refunded_missing"      // DB not refunded but on-chain emitted Refunded
  | "status_stale";         // DB non-terminal but on-chain implies terminal state

export interface CacheMismatch {
  /** The coordinator public ID of the affected order. */
  publicId: string;
  /** The hashlock used to look up the order on-chain. */
  hashlock: string;
  /** Which chain the on-chain evidence came from. */
  chain: "ethereum" | "stellar" | "solana";
  /** Structured mismatch code for metrics and alerting. */
  mismatchType: MismatchType;
  /** DB status at the time the mismatch was detected. */
  cachedStatus: OrderStatus;
  /** Human-readable description suitable for structured logs. */
  detail: string;
}

export interface CacheVerificationStatus {
  /** Whether the last verification run completed without errors. */
  lastRunOk: boolean | null;
  /** Unix timestamp (ms) of the last completed run, or null if never run. */
  lastRunAt: number | null;
  /** Number of orders sampled in the last run. */
  sampleSize: number;
  /** Mismatches found in the last run. Empty when none or never run. */
  mismatches: CacheMismatch[];
  /** Whether cache alignment is considered healthy (ok=true and 0 mismatches). */
  aligned: boolean;
  /**
   * Number of on-chain events skipped because required fields (hashlock or
   * orderId) were absent.  Non-zero means malformed chain data was encountered;
   * operators should inspect logs tagged `cache-verifier:incomplete_event`.
   */
  incompleteEvents: number;
}

export interface CacheVerifierOptions {
  /**
   * Maximum number of non-terminal orders to sample per run.
   * Defaults to 50. Set to 0 to skip on-chain queries (dry-run mode).
   */
  sampleSize?: number;
  /**
   * If provided, only these public IDs are verified rather than sampling
   * from the DB.  Useful for targeted post-incident verification.
   */
  targetOrderIds?: string[];
}

// ── CacheVerifier ─────────────────────────────────────────────────────────────

export class CacheVerifier {
  private readonly log: Logger;
  private readonly ethClient: PublicClient;
  private readonly sorobanServer: rpc.Server;

  private status: CacheVerificationStatus = {
    lastRunOk: null,
    lastRunAt: null,
    sampleSize: 0,
    mismatches: [],
    aligned: true,
    incompleteEvents: 0,
  };

  constructor(
    private readonly cfg: CoordinatorConfig,
    private readonly repo: OrdersRepository,
    log: Logger
  ) {
    this.log = log.child({ component: "CacheVerifier" });
    this.ethClient = createPublicClient({
      chain: cfg.ethereum.chainId === 1 ? mainnet : sepolia,
      transport: http(cfg.ethereum.rpcUrl),
    });
    this.sorobanServer = new rpc.Server(cfg.soroban.rpcUrl, {
      allowHttp: cfg.soroban.rpcUrl.startsWith("http://"),
    });
  }

  /** Return a snapshot of the last verification result. */
  getStatus(): CacheVerificationStatus {
    return { ...this.status, mismatches: [...this.status.mismatches] };
  }

  /**
   * Run a verification pass.
   *
   * Samples up to `sampleSize` non-terminal orders from the DB and probes
   * each configured chain for the corresponding on-chain evidence.  Any
   * discrepancy is recorded as a `CacheMismatch` and emitted as a structured
   * log entry so operators can act on it.
   *
   * This method never throws — errors from RPC probes are caught and recorded
   * as a failed run so the readiness check can reflect the degraded state
   * without crashing the coordinator.
   */
  async run(opts: CacheVerifierOptions = {}): Promise<CacheVerificationStatus> {
    const sampleSize = opts.sampleSize ?? 50;
    this.log.info({ sampleSize }, "cache verification run starting");

    const mismatches: CacheMismatch[] = [];
    let sampledCount = 0;
    let incompleteEvents = 0;

    try {
      // ── 1. Pick orders to verify ───────────────────────────────────────────
      const orders = await this.selectSample(opts.targetOrderIds, sampleSize);
      sampledCount = orders.length;
      cacheVerifierSampleSize.set(sampledCount);

      if (sampledCount === 0) {
        this.log.info("cache verification: no non-terminal orders to verify");
        cacheVerifierRuns.inc({ result: "skipped" });
        this.status = {
          lastRunOk: true,
          lastRunAt: Date.now(),
          sampleSize: 0,
          mismatches: [],
          aligned: true,
          incompleteEvents: 0,
        };
        cacheVerifierLastRun.set(Date.now() / 1000);
        cacheVerifierLastRunMismatches.set(0);
        return this.getStatus();
      }

      // ── 2. Partition orders by source chain ───────────────────────────────
      const ethOrders = orders.filter((o) => o.srcChain === "ethereum");
      const stellarOrders = orders.filter((o) => o.srcChain === "stellar");

      // ── 3. Verify each chain ───────────────────────────────────────────────
      if (this.cfg.ethereum.htlcEscrow && ethOrders.length > 0) {
        const { mismatches: ethMismatches, incompleteEvents: ethIncomplete } =
          await this.verifyEthereum(ethOrders);
        mismatches.push(...ethMismatches);
        incompleteEvents += ethIncomplete;
      }

      if (this.cfg.soroban.htlcContract && stellarOrders.length > 0) {
        const { mismatches: stellarMismatches, incompleteEvents: stellarIncomplete } =
          await this.verifySoroban(stellarOrders);
        mismatches.push(...stellarMismatches);
        incompleteEvents += stellarIncomplete;
      }

      // ── 4. Record metrics ─────────────────────────────────────────────────
      for (const m of mismatches) {
        cacheVerifierMismatches.inc({ chain: m.chain, mismatch_type: m.mismatchType });
        this.log.warn(
          {
            publicId: m.publicId,
            hashlock: m.hashlock,
            chain: m.chain,
            mismatchType: m.mismatchType,
            cachedStatus: m.cachedStatus,
          },
          `cache/chain mismatch detected: ${m.detail}`
        );
      }

      cacheVerifierRuns.inc({ result: "success" });
      cacheVerifierLastRun.set(Date.now() / 1000);
      cacheVerifierLastRunMismatches.set(mismatches.length);

      this.status = {
        lastRunOk: true,
        lastRunAt: Date.now(),
        sampleSize: sampledCount,
        mismatches,
        aligned: mismatches.length === 0,
        incompleteEvents,
      };

      this.log.info(
        { sampledCount, mismatchCount: mismatches.length, incompleteEvents },
        mismatches.length === 0
          ? "cache verification complete — cache is aligned"
          : "cache verification complete — mismatches detected"
      );
    } catch (err) {
      cacheVerifierRuns.inc({ result: "failure" });
      cacheVerifierLastRun.set(Date.now() / 1000);
      this.log.error({ err }, "cache verification run failed");

      this.status = {
        lastRunOk: false,
        lastRunAt: Date.now(),
        sampleSize: sampledCount,
        mismatches,
        aligned: false,
        incompleteEvents,
      };
    }

    return this.getStatus();
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Select the orders to verify.
   *
   * When `targetOrderIds` is provided those are fetched by public ID.
   * Otherwise we query the DB for non-terminal, non-archived orders ordered
   * by most recently updated, capped at `sampleSize`.
   */
  private async selectSample(
    targetOrderIds: string[] | undefined,
    sampleSize: number
  ): Promise<OrderRow[]> {
    if (targetOrderIds && targetOrderIds.length > 0) {
      const results: OrderRow[] = [];
      for (const id of targetOrderIds) {
        const order = await this.repo.findByPublicId(id);
        if (order) results.push(order);
      }
      return results;
    }
    return this.repo.findNonTerminalSample(sampleSize);
  }

  // ── Ethereum verification ──────────────────────────────────────────────────

  private async verifyEthereum(
    orders: OrderRow[]
  ): Promise<{ mismatches: CacheMismatch[]; incompleteEvents: number }> {
    const address = this.cfg.ethereum.htlcEscrow!;
    const mismatches: CacheMismatch[] = [];
    let incompleteEvents = 0;

    let latest: bigint;
    try {
      latest = await this.ethClient.getBlockNumber();
    } catch (err) {
      this.log.warn({ err }, "cache-verifier: cannot fetch Ethereum block number — skipping ETH check");
      return { mismatches, incompleteEvents };
    }

    const fromBlock = latest > ETH_VERIFY_LOOKBACK ? latest - ETH_VERIFY_LOOKBACK : 0n;

    // Build hashlock → order map for fast lookup.
    const byHashlock = new Map<string, OrderRow>(
      orders.map((o) => [o.hashlock.toLowerCase(), o])
    );
    const hashlocks = Array.from(byHashlock.keys()) as `0x${string}`[];

    // Fetch Created / Claimed / Refunded events for the sampled hashlocks.
    let createdLogs: any[] = [];
    let claimedLogs: any[] = [];
    let refundedLogs: any[] = [];
    try {
      [createdLogs, claimedLogs, refundedLogs] = await Promise.all([
        this.ethClient.getLogs({ address, event: ORDER_CREATED, fromBlock, toBlock: latest }),
        this.ethClient.getLogs({ address, event: ORDER_CLAIMED, fromBlock, toBlock: latest }),
        this.ethClient.getLogs({ address, event: ORDER_REFUNDED, fromBlock, toBlock: latest }),
      ]);
    } catch (err) {
      this.log.warn({ err }, "cache-verifier: Ethereum getLogs failed — skipping ETH check");
      return { mismatches, incompleteEvents };
    }

    // ── Check: on-chain Created events vs DB status ────────────────────────
    for (const log of createdLogs) {
      const args = (log as any).args as { hashlock?: `0x${string}` };
      if (!args?.hashlock) {
        // #577: missing required field — skip and record structured error
        incompleteEvents++;
        this.log.warn(
          { event: "OrderCreated", chain: "ethereum", reason: "missing_hashlock" },
          "cache-verifier:incomplete_event OrderCreated missing hashlock — skipping"
        );
        continue;
      }
      const order = byHashlock.get(args.hashlock.toLowerCase());
      if (!order) continue; // not in our sample

      if (order.status === "announced") {
        mismatches.push({
          publicId: order.publicId,
          hashlock: order.hashlock,
          chain: "ethereum",
          mismatchType: "src_lock_unexpected",
          cachedStatus: order.status,
          detail:
            `DB status is "announced" but on-chain OrderCreated event exists for hashlock ` +
            `${order.hashlock}. The src lock was likely missed by the listener. ` +
            `Run reconciliation to repair.`,
        });
      }
    }

    // ── Check: DB src_locked but no on-chain Created event ────────────────
    const onChainCreatedHashlocks = new Set(
      createdLogs
        .map((l: any) => l.args?.hashlock?.toLowerCase())
        .filter(Boolean) as string[]
    );
    for (const [hl, order] of byHashlock) {
      if (order.srcChain !== "ethereum") continue;
      if (order.status === "src_locked" && !onChainCreatedHashlocks.has(hl)) {
        // Only flag if the lock is old enough that it should appear in the
        // lookback window. A very recent lock might not be indexed yet.
        const ageSeconds = (Date.now() / 1000) - order.updatedAt;
        if (ageSeconds > 300) { // 5 minutes grace period
          mismatches.push({
            publicId: order.publicId,
            hashlock: order.hashlock,
            chain: "ethereum",
            mismatchType: "src_lock_missing",
            cachedStatus: order.status,
            detail:
              `DB status is "src_locked" but no on-chain OrderCreated event was found in the ` +
              `lookback window for hashlock ${order.hashlock}. ` +
              `The cache may have been updated without a corresponding chain event.`,
          });
        }
      }
    }

    // ── Check: on-chain Claimed but DB has no preimage ─────────────────────
    for (const log of claimedLogs) {
      const args = (log as any).args as { orderId?: bigint };
      if (!args?.orderId) {
        // #577: missing required field — skip and record structured error
        incompleteEvents++;
        this.log.warn(
          { event: "OrderClaimed", chain: "ethereum", reason: "missing_orderId" },
          "cache-verifier:incomplete_event OrderClaimed missing orderId — skipping"
        );
        continue;
      }
      const order = orders.find((o) => o.srcOrderId === args.orderId?.toString());
      if (!order) continue;

      if (!order.preimage) {
        mismatches.push({
          publicId: order.publicId,
          hashlock: order.hashlock,
          chain: "ethereum",
          mismatchType: "claimed_missing",
          cachedStatus: order.status,
          detail:
            `On-chain OrderClaimed event found for orderId ${args.orderId} but DB has no preimage. ` +
            `Run reconciliation to recover the secret.`,
        });
      }
    }

    // ── Check: on-chain Refunded but DB not refunded ───────────────────────
    for (const log of refundedLogs) {
      const args = (log as any).args as { orderId?: bigint };
      if (!args?.orderId) {
        // #577: missing required field — skip and record structured error
        incompleteEvents++;
        this.log.warn(
          { event: "OrderRefunded", chain: "ethereum", reason: "missing_orderId" },
          "cache-verifier:incomplete_event OrderRefunded missing orderId — skipping"
        );
        continue;
      }
      const order = orders.find((o) => o.srcOrderId === args.orderId?.toString());
      if (!order) continue;

      if (order.status !== "refunded" && order.status !== "completed" && order.status !== "failed") {
        mismatches.push({
          publicId: order.publicId,
          hashlock: order.hashlock,
          chain: "ethereum",
          mismatchType: "refunded_missing",
          cachedStatus: order.status,
          detail:
            `On-chain OrderRefunded event found for orderId ${args.orderId} but DB status is ` +
            `"${order.status}". Run reconciliation to advance the order to refunded.`,
        });
      }
    }

    // Filter to only hashlocks in our sample
    return {
      mismatches: mismatches.filter((m) =>
        hashlocks.some((hl) => hl.toLowerCase() === m.hashlock.toLowerCase())
      ),
      incompleteEvents,
    };
  }

  // ── Soroban verification ───────────────────────────────────────────────────

  private async verifySoroban(
    orders: OrderRow[]
  ): Promise<{ mismatches: CacheMismatch[]; incompleteEvents: number }> {
    const contractId = this.cfg.soroban.htlcContract!;
    const mismatches: CacheMismatch[] = [];
    let incompleteEvents = 0;

    const byOrderId = new Map<string, OrderRow>(
      orders
        .filter((o) => o.srcOrderId !== null)
        .map((o) => [o.srcOrderId!, o])
    );
    const byHashlock = new Map<string, OrderRow>(
      orders.map((o) => [o.hashlock.toLowerCase(), o])
    );

    let latest: { sequence: number };
    try {
      latest = await this.sorobanServer.getLatestLedger();
    } catch (err) {
      this.log.warn({ err }, "cache-verifier: cannot fetch Soroban latest ledger — skipping Soroban check");
      return { mismatches, incompleteEvents };
    }

    const startLedger = Math.max(0, latest.sequence - SOROBAN_VERIFY_LOOKBACK);

    let events: any[] = [];
    try {
      let cursor: string | undefined;
      do {
        const page = await this.sorobanServer.getEvents({
          filters: [{ type: "contract", contractIds: [contractId] }],
          startLedger: cursor ? undefined : startLedger,
          cursor,
          limit: 200,
        });
        events.push(...page.events);
        cursor = page.cursor ?? undefined;
        if (page.events.length < 200) break;
      } while (cursor);
    } catch (err) {
      this.log.warn({ err }, "cache-verifier: Soroban getEvents failed — skipping Soroban check");
      return { mismatches, incompleteEvents };
    }

    for (const ev of events) {
      const topics: unknown[] = [];
      let eventKind = "";
      try {
        const { scValToNative } = await import("@stellar/stellar-sdk");
        for (const t of ev.topic ?? []) topics.push(scValToNative(t));
        if (topics.length === 0) continue;
        eventKind = typeof topics[0] === "string" ? topics[0] : "";
      } catch {
        continue;
      }

      // ── created — cross-check DB status ─────────────────────────────────
      if (eventKind === "created") {
        const hashlockRaw = topics[3];
        if (!hashlockRaw || !(hashlockRaw instanceof Uint8Array || Buffer.isBuffer(hashlockRaw))) {
          // #577: missing required hashlock field — skip and record structured error
          incompleteEvents++;
          this.log.warn(
            { event: "created", chain: "stellar", ledger: ev.ledger, reason: "missing_hashlock" },
            "cache-verifier:incomplete_event Soroban created missing hashlock — skipping"
          );
          continue;
        }
        const hashlock = "0x" + Buffer.from(hashlockRaw as Uint8Array).toString("hex");
        const order = byHashlock.get(hashlock.toLowerCase());
        if (!order) continue;

        if (order.status === "announced") {
          mismatches.push({
            publicId: order.publicId,
            hashlock: order.hashlock,
            chain: "stellar",
            mismatchType: "src_lock_unexpected",
            cachedStatus: order.status,
            detail:
              `DB status is "announced" but Soroban "created" event exists for hashlock ` +
              `${hashlock}. Run reconciliation to repair.`,
          });
        }
      }

      // ── claimed — check DB has preimage ──────────────────────────────────
      if (eventKind === "claimed") {
        let dataArr: unknown[] = [];
        try {
          const { scValToNative } = await import("@stellar/stellar-sdk");
          const decoded = scValToNative(ev.value);
          if (Array.isArray(decoded)) dataArr = decoded;
        } catch { continue; }

        const orderId = typeof dataArr[0] === "bigint" ? dataArr[0].toString() : null;
        if (!orderId) {
          // #577: missing required orderId field — skip and record structured error
          incompleteEvents++;
          this.log.warn(
            { event: "claimed", chain: "stellar", ledger: ev.ledger, reason: "missing_orderId" },
            "cache-verifier:incomplete_event Soroban claimed missing orderId — skipping"
          );
          continue;
        }
        const order = byOrderId.get(orderId);
        if (!order) continue;

        if (!order.preimage) {
          mismatches.push({
            publicId: order.publicId,
            hashlock: order.hashlock,
            chain: "stellar",
            mismatchType: "claimed_missing",
            cachedStatus: order.status,
            detail:
              `Soroban "claimed" event found for orderId ${orderId} but DB has no preimage. ` +
              `Run reconciliation to recover the secret.`,
          });
        }
      }

      // ── refunded — check DB status ────────────────────────────────────────
      if (eventKind === "refunded") {
        let dataArr: unknown[] = [];
        try {
          const { scValToNative } = await import("@stellar/stellar-sdk");
          const decoded = scValToNative(ev.value);
          if (Array.isArray(decoded)) dataArr = decoded;
        } catch { continue; }

        const orderId = typeof dataArr[0] === "bigint" ? dataArr[0].toString() : null;
        if (!orderId) {
          // #577: missing required orderId field — skip and record structured error
          incompleteEvents++;
          this.log.warn(
            { event: "refunded", chain: "stellar", ledger: ev.ledger, reason: "missing_orderId" },
            "cache-verifier:incomplete_event Soroban refunded missing orderId — skipping"
          );
          continue;
        }
        const order = byOrderId.get(orderId);
        if (!order) continue;

        if (order.status !== "refunded" && order.status !== "completed" && order.status !== "failed") {
          mismatches.push({
            publicId: order.publicId,
            hashlock: order.hashlock,
            chain: "stellar",
            mismatchType: "refunded_missing",
            cachedStatus: order.status,
            detail:
              `Soroban "refunded" event found for orderId ${orderId} but DB status is ` +
              `"${order.status}". Run reconciliation to advance to refunded.`,
          });
        }
      }
    }

    return { mismatches, incompleteEvents };
  }
}
