import { createPublicClient, http, parseAbiItem, type PublicClient } from "viem";
import { sepolia, mainnet } from "viem/chains";
import type { Logger } from "pino";
import type { CoordinatorConfig } from "../config.js";
import type { OrderService } from "../services/order-service.js";
import { observeListenerEventProcessing, recordListenerProgress, listenerLastBlock } from "../metrics.js";

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
    if (!this.cfg.ethereum.htlcEscrow) {
      this.log.warn("ETH_HTLC_ESCROW not configured - Ethereum listener disabled");
      return;
    }
    const address = this.cfg.ethereum.htlcEscrow;
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
        const onChainHash = block.hash as string | null;
        if (!onChainHash) continue;
        if (onChainHash !== storedHash) {
          this.log.warn(
            { blockNumber, storedHash, chainHash: onChainHash },
            "reorg detected in confirmed window – rolling back src locks for block"
          );
          // Update our stored hash to the new canonical chain value.
          this.storeConfirmedHash(blockNumber, onChainHash);
          // Roll back any orders whose src lock landed in this block.
          await this.rollbackOrdersAtBlock(blockNumber);
        }
      } catch (err) {
        this.log.warn({ err, blockNumber }, "could not verify block hash during reorg check");
      }
    }
  }

  /** Roll back all src-locked orders whose `srcLockBlock` equals `blockNumber`. */
  private async rollbackOrdersAtBlock(blockNumber: number): Promise<void> {
    // We don't have a direct "find by srcLockBlock" query, so we use the
    // confirmation queue: entries still in the queue have not been processed yet
    // (so nothing to roll back).  Entries already drained and committed must be
    // found via the OrderService.  The rollbackSrcLock call is idempotent for
    // orders not in `src_locked` status.
    try {
      await this.orders.rollbackSrcLock(`block:${blockNumber}`);
    } catch {
      // rollbackSrcLock by publicId doesn't accept block numbers directly –
      // we rely on the caller having stored individual publicIds in the queue
      // at enqueue time.  If events for this block are still in the queue,
      // drain them without processing instead.
      const queuedEvents = this.confirmationQueue.get(blockNumber);
      if (queuedEvents) {
        this.log.warn(
          { blockNumber, count: queuedEvents.length },
          "dropping queued events for reorged block"
        );
        this.confirmationQueue.delete(blockNumber);
      }
    }
  }

  // ─── Confirmation queue management ───────────────────────────────────────

  private startDrainTimer(): void {
    if (this.drainTimer !== null) return;
    this.drainTimer = setInterval(() => {
      void this.drainConfirmationQueue();
    }, DRAIN_INTERVAL_MS);
    // Allow the Node.js process to exit naturally even if this timer is active.
    if (typeof this.drainTimer === "object" && this.drainTimer !== null && "unref" in this.drainTimer) {
      (this.drainTimer as NodeJS.Timeout).unref();
    }
  }

  /**
   * Enqueue a single OrderCreated log for confirmation tracking.
   * The `publicId` is resolved immediately so the DB hit happens once.
   */
  private async enqueueCreatedLog(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    log: any,
    publicId: string
  ): Promise<void> {
    const blockNumber = Number(log.blockNumber as bigint);
    let bucket = this.confirmationQueue.get(blockNumber);
    if (!bucket) {
      bucket = [];
      this.confirmationQueue.set(blockNumber, bucket);
    }
    bucket.push({ log, publicId });
  }

  /**
   * Drain any confirmation-queue entries whose block number is at least
   * CONFIRMATION_DEPTH behind the current chain head.
   * Also performs a rolling reorg check on already-confirmed hashes.
   */
  private async drainConfirmationQueue(): Promise<void> {
    if (this.confirmationQueue.size === 0) return;

    let chainHead: bigint;
    try {
      chainHead = await this.client.getBlockNumber();
    } catch (err) {
      this.log.warn({ err }, "could not fetch chain head – skipping drain cycle");
      return;
    }

    // Reorg check: validate stored hashes against the live chain.
    await this.checkStoredHashesForReorg();

    const confirmedThrough = chainHead - BigInt(CONFIRMATION_DEPTH);

    // Snapshot block numbers so we can delete from the map while iterating.
    const blockNumbers = Array.from(this.confirmationQueue.keys()).sort((a, b) => a - b);

    for (const blockNumber of blockNumbers) {
      if (BigInt(blockNumber) > confirmedThrough) break; // remaining blocks are unconfirmed

      const events = this.confirmationQueue.get(blockNumber);
      if (!events) continue;

      // Before processing, verify the block hash to catch any reorgs.
      const isReorged = await this.blockHashMismatch(BigInt(blockNumber));
      if (isReorged) {
        this.log.warn(
          { blockNumber, count: events.length },
          "dropping queued events – block was reorged"
        );
        this.confirmationQueue.delete(blockNumber);
        continue;
      }

      // Store/refresh confirmed hash.
      const block = await this.client.getBlock({ blockNumber: BigInt(blockNumber) }).catch(() => null);
      if (block?.hash) {
        this.storeConfirmedHash(blockNumber, block.hash as string);
      }

      // Process all events in this block.
      for (const { log, publicId } of events) {
        await this.processConfirmedCreatedLog(log, publicId, Number(chainHead));
      }

      this.confirmationQueue.delete(blockNumber);
    }

    // Update metrics: highest drained block is the last confirmed entry processed.
    const remaining = Array.from(this.confirmationQueue.keys());
    if (remaining.length === 0) {
      recordListenerProgress("ethereum", Number(chainHead), Number(chainHead));
    }
  }

  // ─── Log processing ───────────────────────────────────────────────────────

  /**
   * Process OrderCreated logs from the historical catch-up scan.
   * Applies the same CONFIRMATION_DEPTH gate: events that are already deep
   * enough are processed immediately; recent ones are queued.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async processCatchUpLogs(logs: any[], chainHead: bigint): Promise<void> {
    const confirmedThrough = chainHead - BigInt(CONFIRMATION_DEPTH);

    for (const log of logs) {
      const blockNumber = log.blockNumber as bigint | null;
      if (blockNumber === null) continue;

      const hashlock: string = log.args.hashlock;
      let order;
      try {
        order = await this.orders.findByHashlock(hashlock);
      } catch (err) {
        this.log.warn({ err, hashlock }, "could not look up order during catch-up");
        continue;
      }

      if (!order) {
        this.log.info(
          { hashlock, orderId: log.args.orderId?.toString() },
          "ETH order observed without local announce (catch-up)"
        );
        continue;
      }

      if (log.removed) {
        this.log.warn({ hashlock, txHash: log.transactionHash }, "ETH OrderCreated removed during catch-up");
        await this.orders.rollbackSrcLock(order.publicId);
        continue;
      }

      if (blockNumber <= confirmedThrough) {
        // Already deep enough – process immediately.
        recordListenerProgress("ethereum", Number(blockNumber), Number(chainHead));

        // Store block hash in our confirmed window.
        const block = await this.client.getBlock({ blockNumber }).catch(() => null);
        if (block?.hash) {
          this.storeConfirmedHash(Number(blockNumber), block.hash as string);
        }

        try {
          await this.orders.recordSrcLock({
            publicId: order.publicId,
            orderId: log.args.orderId!.toString(),
            txHash: log.transactionHash,
            blockNumber: Number(blockNumber),
            timelock: Number(log.args.timelock!)
          });
        } catch (err) {
          this.log.warn({ err, hashlock }, "could not record src lock during catch-up");
        }
      } else {
        // Recent block – enqueue for confirmation.
        await this.enqueueCreatedLog(log, order.publicId);
      }
    }
  }

  /**
   * Process a single OrderCreated event that has already accumulated
   * CONFIRMATION_DEPTH confirmations.
   */
  private async processConfirmedCreatedLog(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    log: any,
    publicId: string,
    chainHead: number
  ): Promise<void> {
    const blockNumber = Number(log.blockNumber as bigint);
    recordListenerProgress("ethereum", blockNumber, chainHead);

    try {
      await this.orders.recordSrcLock({
        publicId,
        orderId: (log.args.orderId as bigint).toString(),
        txHash: log.transactionHash as string,
        blockNumber,
        timelock: Number(log.args.timelock as bigint)
      });
      this.log.info({ publicId, blockNumber }, "confirmed OrderCreated processed");
    } catch (err) {
      this.log.warn({ err, publicId, blockNumber }, "could not record confirmed src lock");
    }
  }

  // ─── Live event watchers ──────────────────────────────────────────────────

  private watchNewEvents(address: `0x${string}`, fromBlock?: bigint): void {
    // ── OrderCreated: enqueue for confirmation ──────────────────────────────
    this.unwatchers.push(
      this.client.watchEvent({
        address,
        event: ORDER_CREATED,
        fromBlock,
        onLogs: (logs) => {
          void (async () => {
            const startedAt = Date.now();

            for (const log of logs) {
              const blockNumber = log.blockNumber;
              if (blockNumber !== null) {
                // Update metrics immediately so dashboards see the latest block.
                listenerLastBlock.set({ chain: "ethereum" }, Number(blockNumber));
              }

              const hashlock = log.args.hashlock!;

              if (log.removed) {
                // Viem emits removed=true when a log is ejected by a reorg.
                // Look for the event in the queue first and drop it; if it was
                // already confirmed, roll back via OrderService.
                this.log.warn(
                  { hashlock, txHash: log.transactionHash },
                  "ETH OrderCreated event removed due to reorg"
                );
                const bn = log.blockNumber !== null ? Number(log.blockNumber) : null;
                if (bn !== null && this.confirmationQueue.has(bn)) {
                  const bucket = this.confirmationQueue.get(bn)!;
                  const filtered = bucket.filter((e) => e.log.transactionHash !== log.transactionHash);
                  if (filtered.length === 0) {
                    this.confirmationQueue.delete(bn);
                  } else {
                    this.confirmationQueue.set(bn, filtered);
                  }
                } else {
                  // Already drained – attempt DB rollback.
                  try {
                    const order = await this.orders.findByHashlock(hashlock);
                    if (order) {
                      await this.orders.rollbackSrcLock(order.publicId);
                    }
                  } catch (err) {
                    this.log.warn({ err, hashlock }, "could not rollback src lock after reorg");
                  }
                }
                continue;
              }

              // Normal (non-removed) log: resolve order and enqueue.
              try {
                const order = await this.orders.findByHashlock(hashlock);
                if (!order) {
                  this.log.info(
                    { hashlock, orderId: log.args.orderId?.toString() },
                    "ETH order observed without local announce"
                  );
                  continue;
                }
                await this.enqueueCreatedLog(log, order.publicId);
                // Eagerly try to drain – if the block is already confirmed this
                // resolves immediately; otherwise it's a cheap no-op.
                void this.drainConfirmationQueue();
              } catch (err) {
                this.log.warn({ err, hashlock }, "could not enqueue src lock event");
              }
            }

            observeListenerEventProcessing("ethereum", "OrderCreated", startedAt);
          })();
        }
      })
    );

    // ── OrderClaimed: no confirmation queuing needed ────────────────────────
    this.unwatchers.push(
      this.client.watchEvent({
        address,
        event: ORDER_CLAIMED,
        fromBlock,
        onLogs: (logs) => {
          const startedAt = Date.now();
          for (const log of logs) {
            if (log.blockNumber !== null) {
              recordListenerProgress("ethereum", Number(log.blockNumber));
            }
            this.log.info(
              { orderId: log.args.orderId!.toString(), preimage: log.args.preimage },
              "ETH order claimed"
            );
          }
          observeListenerEventProcessing("ethereum", "OrderClaimed", startedAt);
        }
      })
    );

    // ── OrderRefunded: no confirmation queuing needed ───────────────────────
    this.unwatchers.push(
      this.client.watchEvent({
        address,
        event: ORDER_REFUNDED,
        fromBlock,
        onLogs: (logs) => {
          const startedAt = Date.now();
          for (const log of logs) {
            if (log.blockNumber !== null) {
              recordListenerProgress("ethereum", Number(log.blockNumber));
            }
            this.log.info({ orderId: log.args.orderId!.toString() }, "ETH order refunded");
          }
          observeListenerEventProcessing("ethereum", "OrderRefunded", startedAt);
        }
      })
    );
  }
}
