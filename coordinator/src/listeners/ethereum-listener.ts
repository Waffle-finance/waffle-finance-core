import { createPublicClient, http, parseAbiItem, type PublicClient } from "viem";
import { sepolia, mainnet } from "viem/chains";
import type { Logger } from "pino";
import type { CoordinatorConfig } from "../config.js";
import type { OrderService } from "../services/order-service.js";
import { observeListenerEventProcessing, recordListenerProgress, listenerLastBlock } from "../metrics.js";
import { validatePreimage } from "../reconciliation/secret-reconciler.js";

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
        // Increased lookback from 1000 to 5000 blocks to catch more missed events
        const fromBlock = lastBlock > 0 ? BigInt(lastBlock) : (latest > 5000n ? latest - 5000n : 0n);

        if (fromBlock < latest) {
          this.log.info({ fromBlock, toBlock: latest }, "replaying historical logs on startup");
          const [createdLogs, claimedLogs, refundedLogs] = await Promise.all([
            this.client.getLogs({ address, event: ORDER_CREATED, fromBlock, toBlock: latest }),
            this.client.getLogs({ address, event: ORDER_CLAIMED, fromBlock, toBlock: latest }),
            this.client.getLogs({ address, event: ORDER_REFUNDED, fromBlock, toBlock: latest })
          ]);
          await this.processCreatedLogs(createdLogs);
          await this.processClaimedLogs(claimedLogs);
          await this.processRefundedLogs(refundedLogs);
        }

        this.watchNewEvents(address, latest + 1n);
      } catch (err) {
        this.log.error({ err }, "failed to initialize Ethereum listener catch-up");
        // Still attempt to watch new events even if catch-up fails
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

  private async processClaimedLogs(logs: any[]): Promise<void> {
    for (const log of logs) {
      if (log.blockNumber !== null) {
        recordListenerProgress("ethereum", Number(log.blockNumber));
      }
      const args = log.args as { orderId?: bigint; preimage?: `0x${string}` };
      if (!args?.orderId || !args?.preimage) continue;
      const orderId = args.orderId.toString();
      const preimage = args.preimage;

      if (log.removed) {
        this.log.warn({ orderId }, "ETH OrderClaimed removed due to reorg — state not rolled back");
        continue;
      }

      try {
        const order = await this.orders.findBySrcOrderId("ethereum", orderId);
        if (!order || order.preimage) continue;
        if (!validatePreimage(preimage, order.hashlock)) {
          this.log.warn(
            { orderId, hashlock: order.hashlock },
            "ETH OrderClaimed preimage/hashlock mismatch — rejected"
          );
          continue;
        }
        await this.orders.recordSecret(order.publicId, preimage, log.transactionHash ?? "0x");
        this.log.info({ orderId }, "ETH startup catch-up: recorded secret from OrderClaimed");
      } catch (err: any) {
        if (err?.message?.includes("cannot record")) continue;
        this.log.warn({ err, orderId }, "could not process ETH OrderClaimed");
      }
    }
  }

  private async processRefundedLogs(logs: any[]): Promise<void> {
    for (const log of logs) {
      if (log.blockNumber !== null) {
        recordListenerProgress("ethereum", Number(log.blockNumber));
      }
      const args = log.args as { orderId?: bigint };
      if (!args?.orderId) continue;
      const orderId = args.orderId.toString();

      if (log.removed) {
        this.log.warn({ orderId }, "ETH OrderRefunded removed due to reorg — state not rolled back");
        continue;
      }

      try {
        const order = await this.orders.findBySrcOrderId("ethereum", orderId);
        if (!order || order.status === "refunded" || order.status === "completed") continue;
        await this.orders.markStatus(order.publicId, "refunded");
        this.log.info({ orderId }, "ETH startup catch-up: marked order refunded");
      } catch (err: any) {
        if (err?.message?.includes("cannot transition")) continue;
        this.log.warn({ err, orderId }, "could not process ETH OrderRefunded");
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
          void (async () => {
            const startedAt = Date.now();
            for (const log of logs) {
              if (log.blockNumber !== null) {
                recordListenerProgress("ethereum", Number(log.blockNumber));
              }
              const orderId = log.args.orderId!.toString();
              const preimage = log.args.preimage!;
              this.log.info({ orderId, preimage }, "ETH order claimed");

              if (log.removed) {
                this.log.warn({ orderId }, "ETH OrderClaimed removed due to reorg — state not rolled back");
                continue;
              }

              try {
                const order = await this.orders.findBySrcOrderId("ethereum", orderId);
                if (!order || order.preimage) continue;
                if (!validatePreimage(preimage, order.hashlock)) {
                  this.log.warn(
                    { orderId, hashlock: order.hashlock },
                    "ETH OrderClaimed preimage/hashlock mismatch — rejected"
                  );
                  continue;
                }
                await this.orders.recordSecret(order.publicId, preimage, log.transactionHash ?? "0x");
              } catch (err: any) {
                if (err?.message?.includes("cannot record")) continue;
                this.log.warn({ err, orderId }, "could not record ETH claimed secret");
              }
            }
            observeListenerEventProcessing("ethereum", "OrderClaimed", startedAt);
          })();
        }
      })
    );

    this.unwatchers.push(
      this.client.watchEvent({
        address,
        event: ORDER_REFUNDED,
        fromBlock,
        onLogs: (logs) => {
          void (async () => {
            const startedAt = Date.now();
            for (const log of logs) {
              if (log.blockNumber !== null) {
                recordListenerProgress("ethereum", Number(log.blockNumber));
              }
              const orderId = log.args.orderId!.toString();
              this.log.info({ orderId }, "ETH order refunded");

              if (log.removed) {
                this.log.warn({ orderId }, "ETH OrderRefunded removed due to reorg — state not rolled back");
                continue;
              }

              try {
                const order = await this.orders.findBySrcOrderId("ethereum", orderId);
                if (!order || order.status === "refunded" || order.status === "completed") continue;
                await this.orders.markStatus(order.publicId, "refunded");
              } catch (err: any) {
                if (err?.message?.includes("cannot transition")) continue;
                this.log.warn({ err, orderId }, "could not mark ETH order refunded");
              }
            }
            observeListenerEventProcessing("ethereum", "OrderRefunded", startedAt);
          })();
        }
      })
    );
  }

  stop(): void {
    for (const u of this.unwatchers) u();
    this.unwatchers = [];
  }
}
