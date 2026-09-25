/**
 * @fileoverview Ethereum Event Listener for WaffleFinance
 * @description Monitors HTLCBridge contract events and triggers Stellar operations
 */

import { ethers, Contract, EventLog } from 'ethers';
import { RELAYER_CONFIG } from '../index.js';
import { startAdaptivePoll, type AdaptivePollHandle } from '../utils/adaptive-poll.js';
import { sanitizeForLog } from '../utils/sanitize-for-log.js';
import { getLogger } from '../logger.js';
import {
  createEthOrderCreatedEvent,
  createEthOrderClaimedEvent,
  createEthOrderRefundedEvent,
  type NormalizedRelayEvent,
} from '../events/relay-event.js';
import { getLogger } from '../logger.js';

const logger = getLogger().child({ component: 'ethereum-listener' });

// HTLCBridge contract ABI (focusing on OrderCreated event)
const HTLC_BRIDGE_ABI = [
  "event OrderCreated(uint256 indexed orderId, address indexed sender, address indexed token, uint256 amount, bytes32 hashLock, uint256 timelock, uint256 feeRate, bool partialFillEnabled)",
  "event OrderClaimed(uint256 indexed orderId, address indexed claimer, uint256 amount, uint256 totalFilled, bytes32 preimage)",
  "event OrderRefunded(uint256 indexed orderId, address indexed sender, uint256 refundAmount)"
];

/** Relay event handler registered via `setRelayEventHandler`. */
export type RelayEventHandler = (event: NormalizedRelayEvent) => void | Promise<void>;

/**
 * Ethereum OrderCreated event data
 */
interface OrderCreatedEvent {
  orderId: bigint;
  sender: string;
  token: string;
  amount: bigint;
  hashLock: string;
  timelock: bigint;
  feeRate: bigint;
  partialFillEnabled: boolean;
  transactionHash: string;
  blockNumber: number;
}

/**
 * Ethereum Event Listener for HTLCBridge contract
 */
/**
 * Hard cap on the size of a single `getLogs` window. Public RPCs
 * reject very wide ranges; if the relayer was offline for a long
 * time we walk forward in chunks of this size instead of one giant
 * query.
 */
const MAX_BLOCK_WINDOW = 500;

export class EthereumEventListener {
  private provider?: ethers.JsonRpcProvider;
  private contract?: Contract;
  private isListening: boolean = false;
  /**
   * Cursor for the block-polling loop. We never re-scan blocks at or
   * below this number, which makes the loop crash-safe across ticks
   * even if individual `queryFilter` calls fail.
   */
  private lastProcessedBlock: number = 0;
  private pollHandle: AdaptivePollHandle | null = null;
  /** Re-entrancy guard so a slow poll doesn't overlap the next tick. */
  private isPolling: boolean = false;
  private isActiveFn: () => boolean = () => true;
  private isAttentiveFn: () => boolean = () => true;
  /** Downstream handler for normalized relay events. */
  private relayEventHandler: RelayEventHandler | null = null;

  constructor() {
    // Lazy initialization - will be done in startListening()
  }

  /** Register a handler that receives every normalized relay event this listener emits. */
  setRelayEventHandler(handler: RelayEventHandler): void {
    this.relayEventHandler = handler;
  }

  /** Dispatch a normalized event to the registered handler (fire-and-forget). */
  private dispatchRelayEvent(event: NormalizedRelayEvent): void {
    if (!this.relayEventHandler) return;
    try {
      const result = this.relayEventHandler(event);
      if (result instanceof Promise) {
        result.catch((err: unknown) =>
          logger.warn({ err: sanitizeForLog(err) }, '[eth-listener] relay event handler error')
        );
      }
    } catch (err) {
      logger.warn({ err: sanitizeForLog(err) }, '[eth-listener] relay event handler threw synchronously');
    }
  }

  /** Wire idle/active gating before `startListening()`. */
  configurePolling(opts: { isActive?: () => boolean; isAttentive?: () => boolean }): void {
    if (opts.isActive) this.isActiveFn = opts.isActive;
    if (opts.isAttentive) this.isAttentiveFn = opts.isAttentive;
  }

  /**
   * Initialize components with configuration
   */
  private initializeComponents() {
    if (this.provider) return; // Already initialized

    // In mock mode, don't initialize real provider to avoid RPC errors
    if (RELAYER_CONFIG.enableMockMode) {
      logger.info('Mock mode: Skipping Ethereum provider initialization');
      return;
    }

    // Initialize Ethereum provider
    this.provider = new ethers.JsonRpcProvider(RELAYER_CONFIG.ethereum.rpcUrl);

    // Initialize contract
    this.contract = new Contract(
      RELAYER_CONFIG.ethereum.contractAddress,
      HTLC_BRIDGE_ABI,
      this.provider
    );

    logger.debug('Stellar client initialization placeholder');
  }

  /**
   * Start listening to Ethereum events
   */
  async startListening(): Promise<void> {
    if (this.isListening) {
      getLogger().warn('[eth-listener] event listener is already running');
      return;
    }

    try {
      this.initializeComponents();

      logger.info('Starting Ethereum event listener');
      logger.info({ contractAddress: RELAYER_CONFIG.ethereum.contractAddress }, 'Contract address');
      logger.info({ network: RELAYER_CONFIG.ethereum.network }, 'Network');

      await this.validateConfiguration();

      if (RELAYER_CONFIG.enableMockMode) {
        logger.info('Mock mode: Simulating event listener (no real blockchain connection)');
      } else {
        this.lastProcessedBlock = await this.provider!.getBlockNumber();
        logger.info(
          { fromBlock: this.lastProcessedBlock, activeIntervalMs: RELAYER_CONFIG.activePollIntervalMs, idleIntervalMs: RELAYER_CONFIG.idlePollIntervalMs },
          'Polling from current block forward',
        );

        this.pollHandle = startAdaptivePoll({
          label: 'eth-listener',
          activeIntervalMs: RELAYER_CONFIG.activePollIntervalMs,
          idleIntervalMs: RELAYER_CONFIG.idlePollIntervalMs,
          isActive: this.isActiveFn,
          isAttentive: this.isAttentiveFn,
          tick: () => this.pollEvents(),
        });
      }

      this.isListening = true;
      logger.info('Ethereum event listener started successfully');
      logger.info('Listening for OrderCreated events');

    } catch (error) {
      logger.error({ err: error }, 'Failed to start event listener');
      throw error;
    }
  }

  /**
   * Stop listening to events
   */
  async stopListening(): Promise<void> {
    if (!this.isListening) {
      logger.warn('Event listener is not running');
      return;
    }

    try {
      if (this.pollHandle) {
        this.pollHandle.stop();
        this.pollHandle = null;
      }
      this.isListening = false;
      logger.info('Ethereum event listener stopped');
    } catch (error) {
      logger.error({ err: error }, 'Error stopping event listener');
    }
  }

  /**
   * Poll for new OrderCreated events. Designed to be safe across:
   *  - transient RPC failures (we keep the cursor; retry next tick)
   *  - long offline windows (we walk forward MAX_BLOCK_WINDOW at a time)
   *  - re-entrancy (a slow getLogs won't pile up on the next interval)
   */
  private async pollEvents(): Promise<void> {
    if (this.isPolling || !this.contract || !this.provider) return;
    this.isPolling = true;
    try {
      const head = await this.provider.getBlockNumber();
      if (head <= this.lastProcessedBlock) return;

      const fromBlock = this.lastProcessedBlock + 1;
      const toBlock = Math.min(head, fromBlock + MAX_BLOCK_WINDOW - 1);

      const filter = this.contract.filters.OrderCreated();
      const events = await this.contract.queryFilter(filter, fromBlock, toBlock);

      for (const ev of events) {
        // `queryFilter` returns plain `Log` objects unless the ABI
        // matches, in which case ethers gives us `EventLog` with
        // decoded `args`. Filter to the typed case so we don't NPE
        // on raw logs (e.g. from a contract that emits a colliding
        // anonymous event).
        if (!('args' in ev) || !ev.args) continue;
        const args = ev.args as unknown as [
          bigint, string, string, bigint, string, bigint, bigint, boolean
        ];
        await this.handleOrderCreatedEvent(
          args[0], args[1], args[2], args[3], args[4], args[5], args[6], args[7],
          ev as EventLog
        );
      }

      this.lastProcessedBlock = toBlock;
    } catch (err: any) {
      // Don't advance the cursor — we'll retry the same window next
      // tick. Public RPCs occasionally return 429s or transient
      // upstream errors; logging once per failure is enough.
      logger.warn({ err: err?.shortMessage ?? err?.message ?? String(err) }, '[eth-listener] poll failed, will retry next tick');
    } finally {
      this.isPolling = false;
    }
  }

  /**
   * Handle OrderCreated event from HTLCBridge contract.
   *
   * Emits a `NormalizedRelayEvent` via the registered handler so downstream
   * relay logic is decoupled from raw Ethereum event shapes.
   */
  private async handleOrderCreatedEvent(
    orderId: bigint,
    sender: string,
    token: string,
    amount: bigint,
    hashLock: string,
    timelock: bigint,
    feeRate: bigint,
    partialFillEnabled: boolean,
    event: EventLog
  ): Promise<void> {
    try {
      const orderIdStr = orderId.toString();
      logger.info({ orderId: orderIdStr, blockNumber: event.blockNumber, txHash: event.transactionHash }, '[eth-listener] OrderCreated');

      const normalizedEvent = createEthOrderCreatedEvent({
        orderId: orderIdStr,
        txHash: event.transactionHash,
        blockNumber: event.blockNumber,
        hashlock: hashLock,
        timelock: Number(timelock),
        amount: amount.toString(),
        tokenAddress: token,
        feeRateBps: Number(feeRate),
        partialFillEnabled,
      });

      this.dispatchRelayEvent(normalizedEvent);
      this.processCrossChainOrder({ orderId: orderIdStr, hashLock });

    } catch (error) {
      logger.error({ orderId: orderId.toString(), err: sanitizeForLog(error) }, '[eth-listener] error handling OrderCreated');
    }
  }

  /**
   * Process cross-chain order by creating Stellar HTLC.
   *
   * The v1 implementation only logged a `placeholder-tx-hash` here and
   * never actually created a Stellar HTLC. v2 routes this through the
   * Soroban HTLC contract via the coordinator's StellarBridgeService.
   * Until that wiring is in place (Phase 4) we explicitly NO-OP and let
   * the user's own claim/refund handle settlement, rather than logging
   * fake success messages.
   */
  private processCrossChainOrder(order: { orderId: string; hashLock: string }): void {
    logger.info({ orderId: order.orderId, hashlock: order.hashLock }, '[eth-listener] OrderCreated observed on Ethereum');
    logger.info('[eth-listener] v1 placeholder Stellar HTLC path disabled. The v2 coordinator (Phase 4) creates the Soroban HTLC. Until then the user can refund permissionlessly after the timelock.');
  }

  /**
   * Validate configuration before starting
   */
  private async validateConfiguration(): Promise<void> {
    // Check if contract address is set
    if (!RELAYER_CONFIG.ethereum.contractAddress || RELAYER_CONFIG.ethereum.contractAddress === '') {
      throw new Error('HTLCBridge contract address not configured');
    }

    // Skip network validation in mock mode
    if (RELAYER_CONFIG.enableMockMode) {
      logger.info('Mock mode enabled - skipping network validation');
      logger.info('Mock configuration validated');
      return;
    }

    if (RELAYER_CONFIG.ethereum.rpcUrl.includes('YOUR_')) {
      throw new Error('Ethereum RPC URL contains placeholder values');
    }

    try {
      const network = await this.provider!.getNetwork();
      logger.info({ networkName: network.name, chainId: network.chainId.toString() }, 'Connected to Ethereum network');

      const code = await this.provider!.getCode(RELAYER_CONFIG.ethereum.contractAddress);
      if (code === '0x') {
        throw new Error(`No contract deployed at address: ${RELAYER_CONFIG.ethereum.contractAddress}`);
      }

      logger.info('Contract validation successful');

    } catch (error) {
      logger.error({ err: error }, 'Configuration validation failed');
      throw error;
    }
  }

  /** Trigger an immediate chain scan (e.g. after a new order is stored). */
  wakePolling(): void {
    this.pollHandle?.wake();
  }

  /**
   * Get current listening status
   */
  public isListeningToEvents(): boolean {
    return this.isListening;
  }

  /**
   * Get contract address being monitored
   */
  public getContractAddress(): string {
    return RELAYER_CONFIG.ethereum.contractAddress;
  }
}

// Export singleton instance
export const ethereumListener = new EthereumEventListener(); 