import { createPublicClient, http, parseAbiItem, type PublicClient } from "viem";
import { sepolia, mainnet } from "viem/chains";
import type { Logger } from "pino";
import type { CoordinatorConfig } from "../config.js";
import type { OrderService } from "../services/order-service.js";
import {
  observeListenerEventProcessing,
  recordListenerProgress,
  listenerLastBlock,
  workflowDispatchDecisions,
} from "../metrics.js";
import { decideDispatch } from "../services/workflow-priority-policy.js";

// ---------------------------------------------------------------------------
// ABI event definitions (must remain unchanged)
// ---------------------------------------------------------------------------

const ORDER_CREATED = parseAbiItem(
  "event OrderCreated(uint256 indexed orderId, address indexed sender, address indexed beneficiary, address token, uint256 amount, uint256 safetyDeposit, bytes32 hashlock, uint64 timelock)"
);
const ORDER_CLAIMED = parseAbiItem(
  "event OrderClaimed(uint256 indexed orderId, address indexed claimer, bytes32 preimage, uint256 amount, uint256 safetyDeposit)"
);
const ORDER_REFUNDED = parseAbiItem(
  "event OrderRefunded(uint256 indexed orderId, address indexed caller, uint256 amount, uint256 safetyDeposit)"
);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Number of block confirmations required before an OrderCreated event is
 *  processed.  12 confirmations gives strong finality on Ethereum PoS. */
const CONFIRMATION_DEPTH = 12;

/** How many confirmed-block hashes to retain in the reorg-detection window. */
const BLOCK_HASH_WINDOW = 64;

/** How far back to re-scan when a reorg is detected on restart. */
const REORG_RESTART_LOOKBACK = 64;

/** Interval (ms) at which the confirmation queue is drained proactively. */
const DRAIN_INTERVAL_MS = 30_000;

/**
 * Maximum number of processed event keys to retain in the in-process
 * deduplication cache.  Entries are evicted FIFO once the cap is reached.
 * 10 000 keys ≈ 500 KB at ~50 bytes/key — negligible for a long-running service.
 */
const DEDUP_CACHE_MAX = 10_000;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** A single pending OrderCreated event waiting for enough confirmations. */
interface PendingEvent {
  // The raw viem log (typed as any to avoid duplicating the generated type).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  log: any;
  // The matched order's publicId – resolved at enqueue time so we don't have
  // to hit the DB again during drain.
  publicId: string;
}

// ---------------------------------------------------------------------------
// EthereumListener
// ---------------------------------------------------------------------------

export class EthereumListener {
  private startingOrStarted = false;
  private readonly client: PublicClient;
  private readonly log: Logger;

  /** Active viem unwatch callbacks. */
  private unwatchers: Array<() => void> = [];

  /** Periodic drain timer handle. */
  private drainTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Confirmation queue keyed by block number.
   * Each entry holds all OrderCreated events that landed in that block and
   * have not yet accumulated CONFIRMATION_DEPTH confirmations.
   */
  private readonly confirmationQueue = new Map<number, PendingEvent[]>();

  /**
   * Rolling window of the last BLOCK_HASH_WINDOW confirmed block hashes.
   * Keyed by block number, used to detect reorgs between polling cycles.
   */
  private readonly confirmedBlockHashes = new Map<number, string>();

  /**
   * In-process event deduplication cache.
   *
   * Keys are `"${eventType}:${txHash}"` — e.g. `"OrderCreated:0xabc…"`.
   * Once a txHash has been fully processed (confirmed + written to the DB)
   * it is added here so that any replay (e.g. from a re-scan on restart
   * that overlaps with already-processed blocks) is a cheap in-memory no-op
   * rather than an unnecessary DB round-trip.
   *
   * The cache is bounded at DEDUP_CACHE_MAX entries; the oldest key is evicted
   * once the cap is reached.  Only lives for the lifetime of this process —
   * the DB's own idempotency guards remain the authoritative duplicate filter
   * across restarts.
   */
  private readonly processedEventKeys = new Map<string, true>();

  constructor(
    private readonly cfg: CoordinatorConfig,
    private readonly orders: OrderService,
    log: Logger
  ) {
    this.log = log.child({ component: "EthereumListener" });
    this.client = createPublicClient({
      chain: cfg.ethereum.chainId === 1 ? mainnet : sepolia,
      transport: http(cfg.ethereum.rpcUrl)
    });
  }

  // ─── Public interface ────────────────────────────────────────────────────

  start(): void {
    // Claim startup synchronously before catch-up yields to another wake call.
    if (this.startingOrStarted) return;
    if (!this.cfg.ethereum.htlcEscrow) {
      this.log.warn("ETH_HTLC_ESCROW not configured - Ethereum listener disabled");
      return;
    }
    const address = this.cfg.ethereum.htlcEscrow;
    this.startingOrStarted = true;
    this.log.info({ contract: address }, "starting");

    void (async () => {
      try {
        const latest = await this.client.getBlockNumber();
        const rawLastBlock = await this.orders.getLastProcessedBlock("ethereum");

        // ── Reorg detection on restart ──────────────────────────────────────
        // If we have a previously stored high-water mark, verify its block hash
        // against the actual chain.  A mismatch means a reorg occurred while
        // the service was down; start the catch-up scan from further back.
        let fromBlock: bigint;

        if (rawLastBlock > 0) {
          const storedBlock = BigInt(rawLastBlock);
          const reorgDetected = await this.blockHashMismatch(storedBlock);
          if (reorgDetected) {
            const rollbackTo = storedBlock > BigInt(REORG_RESTART_LOOKBACK)
              ? storedBlock - BigInt(REORG_RESTART_LOOKBACK)
              : 0n;
            this.log.warn(
              { storedBlock: rawLastBlock, rollbackTo: rollbackTo.toString() },
              "reorg detected on restart – rescanning from rollback point"
            );
            fromBlock = rollbackTo;
          } else {
            fromBlock = storedBlock;
          }
        } else {
          // No prior block recorded – look back up to 5 000 blocks.
          fromBlock = latest > 5000n ? latest - 5000n : 0n;
        }

        // ── Historical catch-up ─────────────────────────────────────────────
        if (fromBlock < latest) {
          this.log.info(
            { fromBlock: fromBlock.toString(), toBlock: latest.toString() },
            "replaying historical logs on startup"
          );
          const createdLogs = await this.client.getLogs({
            address,
            event: ORDER_CREATED,
            fromBlock,
            toBlock: latest
          });
          await this.processCatchUpLogs(createdLogs, latest);
        }

        // ── Start periodic drain ────────────────────────────────────────────
        this.startDrainTimer();

        // ── Watch for new events ────────────────────────────────────────────
        this.watchNewEvents(address, latest + 1n);
      } catch (err) {
        this.log.error({ err }, "failed to initialize Ethereum listener catch-up");
        // Still start watching live events even when catch-up fails.
        this.startDrainTimer();
        this.watchNewEvents(this.cfg.ethereum.htlcEscrow!);
      }
    })();
  }

  stop(): void {
    if (this.drainTimer !== null) {
      clearInterval(this.drainTimer);
      this.drainTimer = null;
    }
    for (const u of this.unwatchers) u();
    this.unwatchers = [];
  }

  /** Returns the total number of OrderCreated events waiting for confirmation. */
  getConfirmationQueueSize(): number {
    let total = 0;
    for (const events of this.confirmationQueue.values()) {
      total += events.length;
    }
    return total;
  }

  // ─── Event deduplication helpers ─────────────────────────────────────────

  /**
   * Build the dedup cache key for a processed event.
   * Format: `"<eventType>:<txHash>"`.
   */
  private dedupKey(eventType: string, txHash: string): string {
    return `${eventType}:${txHash}`;
  }

  /**
   * Returns true if this `(eventType, txHash)` pair has already been
   * processed in the current process lifetime.
   */
  isDuplicate(eventType: string, txHash: string): boolean {
    return this.processedEventKeys.has(this.dedupKey(eventType, txHash));
  }

  /**
   * Mark a `(eventType, txHash)` pair as processed.
   * Evicts the oldest entry when the cache exceeds DEDUP_CACHE_MAX.
   */
  private markProcessed(eventType: string, txHash: string): void {
    const key = this.dedupKey(eventType, txHash);
    if (this.processedEventKeys.has(key)) return;
    if (this.processedEventKeys.size >= DEDUP_CACHE_MAX) {
      const oldest = this.processedEventKeys.keys().next().value;
      if (oldest !== undefined) this.processedEventKeys.delete(oldest);
    }
    this.processedEventKeys.set(key, true);
  }

  // ─── Reorg detection helpers ─────────────────────────────────────────────

  /**
   * Fetch the on-chain hash for `blockNumber` and compare against whatever
   * we have stored.  Returns `true` when a mismatch (i.e. a reorg) is
   * detected.  If we have no stored hash for that block yet, stores the
   * fetched hash and returns `false`.
   */
  private async blockHashMismatch(blockNumber: bigint): Promise<boolean> {
    const num = Number(blockNumber);
    try {
      const block = await this.client.getBlock({ blockNumber });
      const onChainHash = block.hash as string | null;
      if (!onChainHash) return false; // pending block – skip check

      const stored = this.confirmedBlockHashes.get(num);
      if (stored === undefined) {
        // First time we've seen this block – record it.
        this.storeConfirmedHash(num, onChainHash);
        return false;
      }
      if (stored !== onChainHash) {
        this.log.warn(
          { blockNumber: num, storedHash: stored, chainHash: onChainHash },
          "block hash mismatch – reorg detected"
        );
        return true;
      }
      return false;
    } catch (err) {
      // If the block doesn't exist on this chain (e.g. very recent fork), treat
      // as a mismatch to be safe.
      this.log.warn({ err, blockNumber: num }, "failed to fetch block for hash check – assuming reorg");
      return true;
    }
  }

  /**
   * Store a confirmed block hash in the rolling window.
   * Evicts the oldest entry once the window exceeds BLOCK_HASH_WINDOW entries.
   */
  private storeConfirmedHash(blockNumber: number, hash: string): void {
    this.confirmedBlockHashes.set(blockNumber, hash);
    if (this.confirmedBlockHashes.size > BLOCK_HASH_WINDOW) {
      // Map iteration order is insertion order; delete the first (oldest) entry.
      const firstKey = this.confirmedBlockHashes.keys().next().value;
      if (firstKey !== undefined) {
        this.confirmedBlockHashes.delete(firstKey);
      }
    }
  }

  /**
   * For every confirmed block number stored in `confirmedBlockHashes`,
   * re-validate the on-chain hash.  On mismatch, rollback orders whose
   * `srcLockBlock` equals that block number.
   */
  private async checkStoredHashesForReorg(): Promise<void> {
    // Snapshot keys so iteration isn't affected by mutations inside the loop.
    const blockNumbers = Array.from(this.confirmedBlockHashes.keys());
    for (const blockNumber of blockNumbers) {
      const storedHash = this.confirmedBlockHashes.get(blockNumber);
      if (storedHash === undefined) continue;
      try {
        const block = await this.client.getBlock({ blockNumber: BigInt(blockNumber) });
        if (block.hash !== storedHash) {
          this.log.warn({ blockNumber, storedHash, chainHash: block.hash }, "stored block hash no longer canonical");
          this.confirmedBlockHashes.delete(blockNumber);
        }
      } catch (err) {
        this.log.warn({ err, blockNumber }, "failed to re-validate stored block hash");
      }
    }
  }
}
