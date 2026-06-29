import { createPublicClient, http, parseAbiItem, type PublicClient } from "viem";
import { sepolia, mainnet } from "viem/chains";
import type { Logger } from "pino";
import type { CoordinatorConfig } from "../config.js";
import type { OrderService } from "../services/order-service.js";
import { observeListenerEventProcessing, recordListenerProgress, listenerLastBlock } from "../metrics.js";

const ORDER_CREATED = parseAbiItem(
  "event OrderCreated(uint256 indexed orderId, address indexed sender, address indexed beneficiary, address token, uint256 amount, uint256 safetyDeposit, bytes32 hashlock, uint64 timelock)"
);
const ORDER_CLAIMED = parseAbiItem(
  "event OrderClaimed(uint256 indexed orderId, address indexed claimer, bytes32 preimage, uint256 amount, uint256 safetyDeposit)"
);
const ORDER_REFUNDED = parseAbiItem(
  "event OrderRefunded(uint256 indexed orderId, address indexed caller, uint256 amount, uint256 safetyDeposit)"
);

export class EthereumListener {
  private readonly client: PublicClient;
  private readonly log: Logger;
  private unwatchers: Array<() => void> = [];

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

  start(): void {
    if (!this.cfg.ethereum.htlcEscrow) {
      this.log.warn("ETH_HTLC_ESCROW not configured - Ethereum listener disabled");
      return;
    }
    const address = this.cfg.ethereum.htlcEscrow;
    this.log.info({ contract: address }, "starting");

    void (async () => {
      try {
        const lastBlock = await this.orders.getLastProcessedBlock("ethereum");
        const latest = await this.client.getBlockNumber();
        const fromBlock = lastBlock > 0 ? BigInt(lastBlock) : (latest > 1000n ? latest - 1000n : 0n);

        if (fromBlock < latest) {
          this.log.info({ fromBlock, toBlock: latest }, "replaying historical logs on startup");
          const createdLogs = await this.client.getLogs({
            address,
            event: ORDER_CREATED,
            fromBlock,
            toBlock: latest
          });
          await this.processCreatedLogs(createdLogs);
        }

        this.watchNewEvents(address, latest + 1n);
      } catch (err) {
        this.log.error({ err }, "failed to initialize Ethereum listener catch-up");
        this.watchNewEvents(address);
      }
    })();
  }

  private async processCreatedLogs(logs: any[]): Promise<void> {
    for (const log of logs) {
      if (log.blockNumber !== null) {
        recordListenerProgress("ethereum", Number(log.blockNumber));
      }
      const hashlock = log.args.hashlock!;
      try {
        const order = await this.orders.findByHashlock(hashlock);
        if (!order) {
          this.log.info(
            { hashlock, orderId: log.args.orderId?.toString() },
            "ETH order observed without local announce"
          );
          continue;
        }

        if (log.removed) {
          this.log.warn({ hashlock, txHash: log.transactionHash }, "ETH OrderCreated event removed due to reorg");
          await this.orders.rollbackSrcLock(order.publicId);
          continue;
        }

        await this.orders.recordSrcLock({
          publicId: order.publicId,
          orderId: log.args.orderId!.toString(),
          txHash: log.transactionHash,
          blockNumber: Number(log.blockNumber),
          timelock: Number(log.args.timelock!)
        });
      } catch (err) {
        this.log.warn({ err, hashlock }, "could not process src lock");
      }
    }
  }

  private watchNewEvents(address: `0x${string}`, fromBlock?: bigint): void {
    this.unwatchers.push(
      this.client.watchEvent({
        address,
        event: ORDER_CREATED,
        fromBlock,
        onLogs: (logs) => {
          void (async () => {
            const startedAt = Date.now();
            for (const log of logs) {
              if (log.blockNumber !== null) {
                recordListenerProgress("ethereum", Number(log.blockNumber));
              }
              const hashlock = log.args.hashlock!;
              try {
                const order = await this.orders.findByHashlock(hashlock);
                if (!order) {
                  this.log.info(
                    { hashlock, orderId: log.args.orderId?.toString() },
                    "ETH order observed without local announce"
                  );
                  continue;
                }
                if (log.removed) {
                  this.log.warn(
                    { hashlock, txHash: log.transactionHash },
                    "ETH OrderCreated event removed due to reorg"
                  );
                  await this.orders.rollbackSrcLock(order.publicId);
                  continue;
                }
                await this.orders.recordSrcLock({
                  publicId: order.publicId,
                  orderId: log.args.orderId!.toString(),
                  txHash: log.transactionHash,
                  blockNumber: Number(log.blockNumber),
                  timelock: Number(log.args.timelock!)
                });
              } catch (err) {
                this.log.warn({ err, hashlock }, "could not record src lock");
              }
            }
            observeListenerEventProcessing("ethereum", "OrderCreated", startedAt);
          })();
        }
      })
    );

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

  stop(): void {
    for (const u of this.unwatchers) u();
    this.unwatchers = [];
  }
}
