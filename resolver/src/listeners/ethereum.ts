import {
  createPublicClient,
  http,
  parseAbiItem,
  type PublicClient
} from "viem";
import { sepolia, mainnet } from "viem/chains";
import { type Logger } from "pino";
import type { ResolverConfig } from "../config.js";
import {
  eventsTotal,
  listenerErrorsTotal,
  listenerLastEventTimestampSeconds,
  activeListeners,
} from "../metrics.js";
import { globalStalenessMonitor } from "../telemetry.js";

const CHAIN = "ethereum";

/**
 * Maximum number of event keys retained in the deduplication Set before it is
 * pruned.  Events are emitted at most once per block and the resolver is
 * observe-only, so a window of 10 000 keys is large enough to survive any
 * realistic listener restart without growing without bound.
 */
const DEDUP_MAX_SIZE = 10_000;

/**
 * Build the deduplication key for an Ethereum HTLC event.
 *
 * We key on `txHash:eventType` because a single transaction can contain at
 * most one event of each type for a given contract, so this is sufficient to
 * deduplicate replayed events across listener restarts.
 */
function dedupKey(txHash: string, eventType: string): string {
  return `${txHash}:${eventType}`;
}

/**
 * Stream HTLCEscrow events from the configured Ethereum chain.
 *
 * This listener only OBSERVES — it does not submit transactions. Acting
 * on observed events (e.g. claiming on the opposite chain when a
 * preimage is revealed) is the resolver runtime's job and lives outside
 * this listener so it can be tested independently.
 *
 * ## Deduplication
 *
 * `viem.watchEvent` may replay recently seen logs when the WebSocket
 * reconnects or the listener is restarted by the Supervisor.  A
 * `processedEvents` Set (keyed by `txHash:eventType`) guards every handler
 * dispatch and silently drops duplicates after emitting a debug log.  The
 * Set is bounded to `DEDUP_MAX_SIZE` entries; the oldest half is evicted
 * when the limit is reached so memory stays bounded across long uptimes.
 */
export class EthereumListener {
  private readonly client: PublicClient;
  private readonly log: Logger;
  private readonly cfg: ResolverConfig;
  private unwatchOrderCreated?: () => void;
  private unwatchOrderClaimed?: () => void;
  private unwatchOrderRefunded?: () => void;

  /**
   * Cross-restart deduplication Set.  Lives on the instance so that it
   * survives Supervisor-driven restarts (the Supervisor reuses the same
   * listener instance on each restart attempt).
   */
  private readonly processedEvents = new Set<string>();

  constructor(cfg: ResolverConfig, log: Logger) {
    this.cfg = cfg;
    this.log = log.child({ component: "EthereumListener" });
    this.client = createPublicClient({
      chain: cfg.ethereum.chainId === 1 ? mainnet : sepolia,
      transport: http(cfg.ethereum.rpcUrl)
    });
  }

  // ── Deduplication helpers ─────────────────────────────────────────────────

  /**
   * Returns true when the event has already been processed.
   * Inserts the key into the Set when it is new.
   * Evicts the oldest half of entries once the Set exceeds DEDUP_MAX_SIZE.
   */
  private isDuplicate(txHash: string, eventType: string): boolean {
    const key = dedupKey(txHash, eventType);
    if (this.processedEvents.has(key)) {
      return true;
    }
    // Prune before inserting to keep the Set bounded.
    if (this.processedEvents.size >= DEDUP_MAX_SIZE) {
      const half = DEDUP_MAX_SIZE / 2;
      let pruned = 0;
      for (const k of this.processedEvents) {
        this.processedEvents.delete(k);
        pruned++;
        if (pruned >= half) break;
      }
      this.log.debug({ pruned, remaining: this.processedEvents.size }, "pruned dedup Set");
    }
    this.processedEvents.add(key);
    return false;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async start(handlers: EthereumEventHandlers): Promise<void> {
    if (!this.cfg.ethereum.htlcEscrow) {
      this.log.warn("ETH_HTLC_ESCROW address not configured — skipping Ethereum listener");
      return;
    }
    await this.stop();

    const address = this.cfg.ethereum.htlcEscrow;
    this.log.info({ chainId: this.cfg.ethereum.chainId, contract: address }, "starting Ethereum listener");
    activeListeners.set({ chain: CHAIN }, 1);
    globalStalenessMonitor.recordStarted(CHAIN);

    const orderCreated = parseAbiItem(
      "event OrderCreated(uint256 indexed orderId, address indexed sender, address indexed beneficiary, address token, uint256 amount, uint256 safetyDeposit, bytes32 hashlock, uint64 timelock)"
    );
    const orderClaimed = parseAbiItem(
      "event OrderClaimed(uint256 indexed orderId, address indexed claimer, bytes32 preimage, uint256 amount, uint256 safetyDeposit)"
    );
    const orderRefunded = parseAbiItem(
      "event OrderRefunded(uint256 indexed orderId, address indexed caller, uint256 amount, uint256 safetyDeposit)"
    );

    this.unwatchOrderCreated = this.client.watchEvent({
      address,
      event: orderCreated,
      onLogs: (logs) => {
        for (const log of logs) {
          const txHash = log.transactionHash ?? "";
          const eventType = "order_created";

          // ── Deduplication guard ─────────────────────────────────────────
          if (this.isDuplicate(txHash, eventType)) {
            this.log.debug(
              { txHash, orderId: String(log.args.orderId), eventType },
              "duplicate Ethereum event dropped (already processed)"
            );
            listenerErrorsTotal.inc({ chain: CHAIN, error_type: "duplicate_event" });
            continue;
          }

          eventsTotal.inc({ chain: CHAIN, event_type: eventType });
          listenerLastEventTimestampSeconds.set({ chain: CHAIN }, Math.floor(Date.now() / 1000));
          globalStalenessMonitor.recordHealthyTick(CHAIN);
          try {
            handlers.onOrderCreated({
              orderId: log.args.orderId!,
              sender: log.args.sender!,
              beneficiary: log.args.beneficiary!,
              token: log.args.token!,
              amount: log.args.amount!,
              safetyDeposit: log.args.safetyDeposit!,
              hashlock: log.args.hashlock!,
              timelock: log.args.timelock!,
              blockNumber: log.blockNumber,
              txHash: log.transactionHash
            });
          } catch (err) {
            listenerErrorsTotal.inc({ chain: CHAIN, error_type: "handler_error" });
            this.log.warn({ err }, "onOrderCreated handler failed");
          }
        }
      }
    });

    this.unwatchOrderClaimed = this.client.watchEvent({
      address,
      event: orderClaimed,
      onLogs: (logs) => {
        for (const log of logs) {
          const txHash = log.transactionHash ?? "";
          const eventType = "order_claimed";

          // ── Deduplication guard ─────────────────────────────────────────
          if (this.isDuplicate(txHash, eventType)) {
            this.log.debug(
              { txHash, orderId: String(log.args.orderId), eventType },
              "duplicate Ethereum event dropped (already processed)"
            );
            listenerErrorsTotal.inc({ chain: CHAIN, error_type: "duplicate_event" });
            continue;
          }

          eventsTotal.inc({ chain: CHAIN, event_type: eventType });
          listenerLastEventTimestampSeconds.set({ chain: CHAIN }, Math.floor(Date.now() / 1000));
          globalStalenessMonitor.recordHealthyTick(CHAIN);
          try {
            handlers.onOrderClaimed({
              orderId: log.args.orderId!,
              claimer: log.args.claimer!,
              preimage: log.args.preimage!,
              blockNumber: log.blockNumber,
              txHash: log.transactionHash
            });
          } catch (err) {
            listenerErrorsTotal.inc({ chain: CHAIN, error_type: "handler_error" });
            this.log.warn({ err }, "onOrderClaimed handler failed");
          }
        }
      }
    });

    this.unwatchOrderRefunded = this.client.watchEvent({
      address,
      event: orderRefunded,
      onLogs: (logs) => {
        for (const log of logs) {
          const txHash = log.transactionHash ?? "";
          const eventType = "order_refunded";

          // ── Deduplication guard ─────────────────────────────────────────
          if (this.isDuplicate(txHash, eventType)) {
            this.log.debug(
              { txHash, orderId: String(log.args.orderId), eventType },
              "duplicate Ethereum event dropped (already processed)"
            );
            listenerErrorsTotal.inc({ chain: CHAIN, error_type: "duplicate_event" });
            continue;
          }

          eventsTotal.inc({ chain: CHAIN, event_type: eventType });
          listenerLastEventTimestampSeconds.set({ chain: CHAIN }, Math.floor(Date.now() / 1000));
          globalStalenessMonitor.recordHealthyTick(CHAIN);
          try {
            handlers.onOrderRefunded({
              orderId: log.args.orderId!,
              caller: log.args.caller!,
              blockNumber: log.blockNumber,
              txHash: log.transactionHash
            });
          } catch (err) {
            listenerErrorsTotal.inc({ chain: CHAIN, error_type: "handler_error" });
            this.log.warn({ err }, "onOrderRefunded handler failed");
          }
        }
      }
    });
  }

  async stop(): Promise<void> {
    this.unwatchOrderCreated?.();
    this.unwatchOrderClaimed?.();
    this.unwatchOrderRefunded?.();
    activeListeners.set({ chain: CHAIN }, 0);
    globalStalenessMonitor.recordStopped(CHAIN);
  }
}

export interface EthereumOrderCreatedEvent {
  orderId: bigint;
  sender: `0x${string}`;
  beneficiary: `0x${string}`;
  token: `0x${string}`;
  amount: bigint;
  safetyDeposit: bigint;
  hashlock: `0x${string}`;
  timelock: bigint;
  blockNumber: bigint;
  txHash: `0x${string}`;
}

export interface EthereumOrderClaimedEvent {
  orderId: bigint;
  claimer: `0x${string}`;
  preimage: `0x${string}`;
  blockNumber: bigint;
  txHash: `0x${string}`;
}

export interface EthereumOrderRefundedEvent {
  orderId: bigint;
  caller: `0x${string}`;
  blockNumber: bigint;
  txHash: `0x${string}`;
}

export interface EthereumEventHandlers {
  onOrderCreated(e: EthereumOrderCreatedEvent): void;
  onOrderClaimed(e: EthereumOrderClaimedEvent): void;
  onOrderRefunded(e: EthereumOrderRefundedEvent): void;
}
