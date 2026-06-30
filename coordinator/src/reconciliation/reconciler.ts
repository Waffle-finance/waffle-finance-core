import {
  createPublicClient,
  http,
  parseAbiItem,
  type PublicClient,
  type Log
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
  reconciliationEventsReplayed
} from "../metrics.js";
import { validatePreimage } from "./secret-reconciler.js";

const ORDER_CREATED = parseAbiItem(
  "event OrderCreated(uint256 indexed orderId, address indexed sender, address indexed beneficiary, address token, uint256 amount, uint256 safetyDeposit, bytes32 hashlock, uint64 timelock)"
);
const ORDER_CLAIMED = parseAbiItem(
  "event OrderClaimed(uint256 indexed orderId, address indexed claimer, bytes32 preimage, uint256 amount, uint256 safetyDeposit)"
);
const ORDER_REFUNDED = parseAbiItem(
  "event OrderRefunded(uint256 indexed orderId, address indexed caller, uint256 amount, uint256 safetyDeposit)"
);

/** How many Ethereum blocks ~48h covers at ~12s/block (increased from 24h for better recovery) */
const ETH_LOOKBACK_BLOCKS = 14_400n;
/** Soroban ledger lookback (~5s/ledger, 48h) */
const SOROBAN_LOOKBACK_LEDGERS = 34_560;
/** Solana slot lookback (~400ms/slot, 48h) */
const SOLANA_LOOKBACK_SLOTS = 432_000;

export interface ReconciliationStatus {
  lastRunAt: number | null;
  lastRunOk: boolean | null;
  eventsReplayed: number;
}

export class Reconciler {
  private readonly log: Logger;
  private readonly ethClient: PublicClient;
  private readonly sorobanServer: rpc.Server;
  private readonly solanaConn: Connection;

  private status: ReconciliationStatus = {
    lastRunAt: null,
    lastRunOk: null,
    eventsReplayed: 0
  };

  constructor(
    private readonly cfg: CoordinatorConfig,
    private readonly orders: OrderService,
    log: Logger
  ) {
    this.log = log.child({ component: "Reconciler" });
    this.ethClient = createPublicClient({
      chain: cfg.ethereum.chainId === 1 ? mainnet : sepolia,
      transport: http(cfg.ethereum.rpcUrl)
    });
    this.sorobanServer = new rpc.Server(cfg.soroban.rpcUrl, {
      allowHttp: cfg.soroban.rpcUrl.startsWith("http://")
    });
    this.solanaConn = new Connection(cfg.solana.rpcUrl, cfg.solana.commitment);
  }

  getStatus(): ReconciliationStatus {
    return { ...this.status };
  }

  async run(): Promise<void> {
    this.log.info("reconciliation run starting");
    let replayed = 0;

    try {
      // Check for gaps between last processed block and current tip
      await this.detectAndReportGaps();
      
      replayed += await this.reconcileEthereum();
      replayed += await this.reconcileSoroban();
      replayed += await this.reconcileSolana();

      this.status = { lastRunAt: Date.now(), lastRunOk: true, eventsReplayed: replayed };
      reconciliationRuns.inc({ result: "success" });
      reconciliationEventsReplayed.inc(replayed);
      reconciliationLastRun.set(Date.now() / 1000);
      this.log.info({ replayed }, "reconciliation run complete");
    } catch (err) {
      this.status = { lastRunAt: Date.now(), lastRunOk: false, eventsReplayed: replayed };
      reconciliationRuns.inc({ result: "failure" });
      reconciliationErrors.inc();
      this.log.error({ err }, "reconciliation run failed");
    }
  }

  private async detectAndReportGaps(): Promise<void> {
    // Ethereum gap detection
    if (this.cfg.ethereum.htlcEscrow) {
      const lastBlock = await this.orders.getLastProcessedBlock("ethereum");
      const latest = await this.ethClient.getBlockNumber();
      const gap = Number(latest) - lastBlock;
      
      if (gap > 100) {
        this.log.warn({ chain: "ethereum", lastBlock, latest, gap }, "detected significant block gap");
      }
    }

    // Soroban gap detection
    if (this.cfg.soroban.htlcContract) {
      const latestLedger = await this.sorobanServer.getLatestLedger();
      // Note: We don't track last processed ledger per order, so this is a simplified check
      this.log.debug({ latestLedger: latestLedger.sequence }, "soroban ledger tip");
    }

    // Solana gap detection
    if (this.cfg.solana.programId && this.cfg.solana.programId !== "PLACEHOLDER") {
      const slot = await this.solanaConn.getSlot(this.cfg.solana.commitment);
      this.log.debug({ slot }, "solana slot tip");
    }
  }

  // ---------------------------------------------------------------------------
  // Ethereum
  // ---------------------------------------------------------------------------

  private async reconcileEthereum(): Promise<number> {
    if (!this.cfg.ethereum.htlcEscrow) return 0;

    const address = this.cfg.ethereum.htlcEscrow;
    const latest = await this.ethClient.getBlockNumber();
    const fromBlock = latest > ETH_LOOKBACK_BLOCKS ? latest - ETH_LOOKBACK_BLOCKS : 0n;

    const [createdLogs, claimedLogs, refundedLogs] = await Promise.all([
      this.ethClient.getLogs({ address, event: ORDER_CREATED, fromBlock, toBlock: latest }),
      this.ethClient.getLogs({ address, event: ORDER_CLAIMED, fromBlock, toBlock: latest }),
      this.ethClient.getLogs({ address, event: ORDER_REFUNDED, fromBlock, toBlock: latest })
    ]);

    let replayed = 0;
    replayed += await this.replayEthCreated(createdLogs);
    replayed += await this.replayEthClaimed(claimedLogs);
    replayed += await this.replayEthRefunded(refundedLogs);
    return replayed;
  }

  private async replayEthCreated(logs: Log[]): Promise<number> {
    let n = 0;
    for (const log of logs) {
      const args = (log as any).args as {
        orderId: bigint;
        hashlock: `0x${string}`;
        timelock: bigint;
      };
      if (!args?.hashlock) continue;
      try {
        const order = await this.orders.findByHashlock(args.hashlock);
        if (!order || order.srcOrderId) continue; // already known
        await this.orders.recordSrcLock({
          publicId: order.publicId,
          orderId: args.orderId.toString(),
          txHash: log.transactionHash ?? "0x",
          blockNumber: Number(log.blockNumber ?? 0n),
          timelock: Number(args.timelock)
        });
        n++;
        this.log.info({ hashlock: args.hashlock }, "reconciler: replayed ETH OrderCreated");
      } catch (err: any) {
        // state-machine guard already advanced — not an error
        if (err?.message?.includes("cannot record")) continue;
        this.log.warn({ err, hashlock: args.hashlock }, "reconciler: ETH created replay error");
      }
    }
    return n;
  }

  private async replayEthClaimed(logs: Log[]): Promise<number> {
    let n = 0;
    for (const log of logs) {
      const args = (log as any).args as {
        orderId: bigint;
        preimage: `0x${string}`;
      };
      if (!args?.orderId || !args?.preimage) continue;
      try {
        const order = await this.orders.findBySrcOrderId("ethereum", args.orderId.toString());
        if (!order || order.preimage) continue;
        if (!validatePreimage(args.preimage, order.hashlock)) {
          this.log.warn(
            { orderId: args.orderId.toString(), hashlock: order.hashlock },
            "reconciler: ETH OrderClaimed preimage/hashlock mismatch — rejected"
          );
          continue;
        }
        await this.orders.recordSecret(
          order.publicId,
          args.preimage,
          log.transactionHash ?? "0x"
        );
        n++;
        this.log.info({ orderId: args.orderId.toString() }, "reconciler: replayed ETH OrderClaimed");
      } catch (err: any) {
        if (err?.message?.includes("cannot record")) continue;
        this.log.warn({ err }, "reconciler: ETH claimed replay error");
      }
    }
    return n;
  }

  private async replayEthRefunded(logs: Log[]): Promise<number> {
    let n = 0;
    for (const log of logs) {
      const args = (log as any).args as { orderId: bigint };
      if (!args?.orderId) continue;
      try {
        const order = await this.orders.findBySrcOrderId("ethereum", args.orderId.toString());
        if (!order || order.status === "refunded" || order.status === "completed") continue;
        await this.orders.markStatus(order.publicId, "refunded");
        n++;
        this.log.info({ orderId: args.orderId.toString() }, "reconciler: replayed ETH OrderRefunded");
      } catch (err: any) {
        if (err?.message?.includes("cannot transition")) continue;
        this.log.warn({ err }, "reconciler: ETH refunded replay error");
      }
    }
    return n;
  }

  // ---------------------------------------------------------------------------
  // Soroban
  // ---------------------------------------------------------------------------

  private async reconcileSoroban(): Promise<number> {
    if (!this.cfg.soroban.htlcContract) return 0;

    const contractId = this.cfg.soroban.htlcContract;
    let replayed = 0;

    try {
      const latest = await this.sorobanServer.getLatestLedger();
      const startLedger = Math.max(0, latest.sequence - SOROBAN_LOOKBACK_LEDGERS);

      let cursor: string | undefined;
      do {
        const events = await this.sorobanServer.getEvents({
          filters: [{ type: "contract", contractIds: [contractId] }],
          startLedger: cursor ? undefined : startLedger,
          cursor,
          limit: 200
        });

        for (const ev of events.events) {
          replayed += await this.replaySorobanEvent(ev);
        }

        cursor = events.cursor ?? undefined;
        // Stop if we got fewer than a full page (no more events)
        if (events.events.length < 200) break;
      } while (cursor);
    } catch (err) {
      this.log.warn({ err }, "reconciler: Soroban fetch failed");
    }

    return replayed;
  }

  private async replaySorobanEvent(ev: any): Promise<number> {
    // Topics are ScVal arrays; topic[0] is the event name symbol
    const topicName: string = ev.topic?.[0]?.value ?? ev.topic?.[0]?.str ?? "";

    if (topicName === "OrderCreated") {
      const hashlock = ev.value?.map?.hashlock ?? ev.value?.hashlock;
      const orderId = ev.value?.map?.orderId ?? ev.value?.orderId;
      const timelock = Number(ev.value?.map?.timelock ?? ev.value?.timelock ?? 0);
      if (!hashlock || !orderId) return 0;
      try {
        const order = await this.orders.findByHashlock(hashlock);
        if (!order || order.srcOrderId) return 0;
        await this.orders.recordSrcLock({
          publicId: order.publicId,
          orderId: String(orderId),
          txHash: ev.txHash,
          blockNumber: ev.ledger,
          timelock
        });
        return 1;
      } catch (err: any) {
        if (err?.message?.includes("cannot record")) return 0;
        this.log.warn({ err, hashlock }, "reconciler: Soroban OrderCreated replay error");
        return 0;
      }
    }

    if (topicName === "OrderClaimed") {
      const preimage = ev.value?.map?.preimage ?? ev.value?.preimage;
      const orderId = ev.value?.map?.orderId ?? ev.value?.orderId;
      if (!preimage || !orderId) return 0;
      try {
        const order = await this.orders.findBySrcOrderId("stellar", String(orderId));
        if (!order || order.preimage) return 0;
        if (!validatePreimage(preimage, order.hashlock)) {
          this.log.warn(
            { orderId: String(orderId), hashlock: order.hashlock },
            "reconciler: Soroban OrderClaimed preimage/hashlock mismatch — rejected"
          );
          return 0;
        }
        await this.orders.recordSecret(order.publicId, preimage, ev.txHash);
        return 1;
      } catch (err: any) {
        if (err?.message?.includes("cannot record")) return 0;
        this.log.warn({ err }, "reconciler: Soroban OrderClaimed replay error");
        return 0;
      }
    }

    if (topicName === "OrderRefunded") {
      const orderId = ev.value?.map?.orderId ?? ev.value?.orderId;
      if (!orderId) return 0;
      try {
        const order = await this.orders.findBySrcOrderId("stellar", String(orderId));
        if (!order || order.status === "refunded" || order.status === "completed") return 0;
        await this.orders.markStatus(order.publicId, "refunded");
        return 1;
      } catch (err: any) {
        if (err?.message?.includes("cannot transition")) return 0;
        this.log.warn({ err }, "reconciler: Soroban OrderRefunded replay error");
        return 0;
      }
    }

    return 0;
  }

  // ---------------------------------------------------------------------------
  // Solana
  // ---------------------------------------------------------------------------

  private async reconcileSolana(): Promise<number> {
    if (!this.cfg.solana.programId || this.cfg.solana.programId === "PLACEHOLDER") return 0;

    let replayed = 0;
    try {
      const slot = await this.solanaConn.getSlot(this.cfg.solana.commitment);
      const minSlot = Math.max(0, slot - SOLANA_LOOKBACK_SLOTS);
      const programPk = new PublicKey(this.cfg.solana.programId);

      const sigs = await this.solanaConn.getSignaturesForAddress(programPk, {
        limit: 1000,
        minContextSlot: minSlot
      });

      for (const sigInfo of sigs) {
        if (sigInfo.err) continue;
        try {
          const tx = await this.solanaConn.getParsedTransaction(sigInfo.signature, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0
          });
          if (!tx?.meta?.logMessages) continue;
          replayed += await this.replaySolanaLogs(sigInfo.signature, tx.meta.logMessages);
        } catch (err) {
          this.log.warn({ sig: sigInfo.signature, err }, "reconciler: Solana tx fetch failed");
        }
      }
    } catch (err) {
      this.log.warn({ err }, "reconciler: Solana fetch failed");
    }

    return replayed;
  }

  private async replaySolanaLogs(sig: string, logs: string[]): Promise<number> {
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
      const { hashlock, orderId, timelock } = payload as { hashlock?: string; orderId?: string; timelock?: number };
      if (!hashlock || !orderId) return 0;
      try {
        const order = await this.orders.findByHashlock(hashlock);
        if (!order || order.srcOrderId) return 0;
        await this.orders.recordSrcLock({
          publicId: order.publicId,
          orderId,
          txHash: sig,
          blockNumber: 0,
          timelock: timelock ?? 0
        });
        return 1;
      } catch (err: any) {
        if (err?.message?.includes("cannot record")) return 0;
        this.log.warn({ err, hashlock }, "reconciler: Solana OrderCreated replay error");
        return 0;
      }
    }

    if (eventType === "OrderClaimed") {
      const { preimage, orderId } = payload as { preimage?: string; orderId?: string };
      if (!preimage || !orderId) return 0;
      try {
        const order = await this.orders.findBySrcOrderId("solana", orderId);
        if (!order || order.preimage) return 0;
        if (!validatePreimage(preimage, order.hashlock)) {
          this.log.warn(
            { orderId, hashlock: order.hashlock },
            "reconciler: Solana OrderClaimed preimage/hashlock mismatch — rejected"
          );
          return 0;
        }
        await this.orders.recordSecret(order.publicId, preimage, sig);
        return 1;
      } catch (err: any) {
        if (err?.message?.includes("cannot record")) return 0;
        this.log.warn({ err }, "reconciler: Solana OrderClaimed replay error");
        return 0;
      }
    }

    if (eventType === "OrderRefunded") {
      const { orderId } = payload as { orderId?: string };
      if (!orderId) return 0;
      try {
        const order = await this.orders.findBySrcOrderId("solana", orderId);
        if (!order || order.status === "refunded" || order.status === "completed") return 0;
        await this.orders.markStatus(order.publicId, "refunded");
        return 1;
      } catch (err: any) {
        if (err?.message?.includes("cannot transition")) return 0;
        this.log.warn({ err }, "reconciler: Solana OrderRefunded replay error");
        return 0;
      }
    }

    return 0;
  }
}
