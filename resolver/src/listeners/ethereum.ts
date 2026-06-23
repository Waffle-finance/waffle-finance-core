import {
  createPublicClient,
  http,
  parseAbiItem,
  type PublicClient
} from "viem";
import { sepolia, mainnet } from "viem/chains";
import { type Logger } from "pino";
import type { EthereumConfig } from "../config.js";

/**
 * Stream HTLCEscrow events from the configured Ethereum chain.
 *
 * This listener only OBSERVES — it does not submit transactions. Acting
 * on observed events (e.g. claiming on the opposite chain when a
 * preimage is revealed) is the resolver runtime's job and lives outside
 * this listener so it can be tested independently.
 */
export class EthereumListener {
  private readonly client: PublicClient;
  private readonly log: Logger;
  private readonly cfg: EthereumConfig;
  private unwatchOrderCreated?: () => void;
  private unwatchOrderClaimed?: () => void;
  private unwatchOrderRefunded?: () => void;

  constructor(cfg: EthereumConfig, log: Logger) {
    this.cfg = cfg;
    this.log = log.child({ component: "EthereumListener" });
    this.client = createPublicClient({
      chain: cfg.chainId === 1 ? mainnet : sepolia,
      transport: http(cfg.rpcUrl)
    });
  }

  async start(handlers: EthereumEventHandlers): Promise<void> {
    if (!this.cfg.htlcEscrow) {
      this.log.warn("ETH_HTLC_ESCROW address not configured — skipping Ethereum listener");
      return;
    }
    await this.stop();

    const address = this.cfg.htlcEscrow;
    this.log.info({ chainId: this.cfg.chainId, contract: address }, "starting Ethereum listener");

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
        }
      }
    });

    this.unwatchOrderClaimed = this.client.watchEvent({
      address,
      event: orderClaimed,
      onLogs: (logs) => {
        for (const log of logs) {
          handlers.onOrderClaimed({
            orderId: log.args.orderId!,
            claimer: log.args.claimer!,
            preimage: log.args.preimage!,
            blockNumber: log.blockNumber,
            txHash: log.transactionHash
          });
        }
      }
    });

    this.unwatchOrderRefunded = this.client.watchEvent({
      address,
      event: orderRefunded,
      onLogs: (logs) => {
        for (const log of logs) {
          handlers.onOrderRefunded({
            orderId: log.args.orderId!,
            caller: log.args.caller!,
            blockNumber: log.blockNumber,
            txHash: log.transactionHash
          });
        }
      }
    });
  }

  async stop(): Promise<void> {
    this.unwatchOrderCreated?.();
    this.unwatchOrderClaimed?.();
    this.unwatchOrderRefunded?.();
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
