#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { loadConfig } from "../src/config.js";
import { getLogger } from "../src/logger.js";
import { openDatabase } from "../src/persistence/db.js";
import { OrdersRepository } from "../src/persistence/orders-repo.js";
import { retryAsync } from "../src/retry.js";

interface DemoOrder {
  direction: "eth_to_xlm" | "xlm_to_eth" | "eth_to_sol" | "sol_to_eth";
  status: "announced" | "src_locked" | "dst_locked" | "secret_revealed" | "completed" | "refunded" | "failed" | "expired";
  preimage?: string;
  srcChain: "ethereum" | "stellar" | "solana";
  dstChain: "ethereum" | "stellar" | "solana";
}

const DEMO_ORDERS: DemoOrder[] = [
  {
    direction: "eth_to_xlm",
    status: "completed",
    srcChain: "ethereum",
    dstChain: "stellar",
  },
  {
    direction: "eth_to_xlm",
    status: "secret_revealed",
    preimage: "0x" + randomBytes(32).toString("hex"),
    srcChain: "ethereum",
    dstChain: "stellar",
  },
  {
    direction: "eth_to_xlm",
    status: "src_locked",
    srcChain: "ethereum",
    dstChain: "stellar",
  },
  {
    direction: "xlm_to_eth",
    status: "dst_locked",
    srcChain: "stellar",
    dstChain: "ethereum",
  },
  {
    direction: "eth_to_xlm",
    status: "refunded",
    srcChain: "ethereum",
    dstChain: "stellar",
  },
  {
    direction: "xlm_to_eth",
    status: "expired",
    srcChain: "stellar",
    dstChain: "ethereum",
  },
  {
    direction: "eth_to_sol",
    status: "announced",
    srcChain: "ethereum",
    dstChain: "solana",
  },
  {
    direction: "eth_to_sol",
    status: "src_locked",
    srcChain: "ethereum",
    dstChain: "solana",
  },
];

function generateHashlock(): string {
  return "0x" + randomBytes(32).toString("hex");
}

function generateEthAddress(): string {
  return "0x742d35cF0b7bbF6E175239d74a0e0a3d1C7B87E4";
}

function generateStellarAddress(): string {
  return "GBSBPY7EM7OE6I2I3ZD55QMINTEGR8LGUNPJGAYWMQV6M7J3I4K5D6S7";
}

function generateSolanaAddress(): string {
  return "9s4nxUf3qAuTgjBc5Hk7qDp8Jkw9zYfJ5Q2mR4qJ7dN8H";
}

function generateOrderId(): string {
  return (Math.floor(Math.random() * 1_000_000) + 1).toString();
}

function generateTxHash(): string {
  return "0x" + randomBytes(32).toString("hex");
}

function generateBlockNumber(nowSeconds: number): number {
  return Math.floor(nowSeconds - Math.random() * 1000);
}

function toWeiString(eth: number): string {
  return (eth * 10n ** 18n).toString();
}

function toStroopString(xlm: number): string {
  return (xlm * 10n ** 7n).toString();
}

async function seedDatabase(): Promise<void> {
  const cfg = loadConfig();
  const log = getLogger(cfg.logLevel);

  log.info("Opening database for seeding...");
  const db = await retryAsync(() => openDatabase(cfg.databaseUrl), {
    maxAttempts: 5,
    baseDelayMs: 500,
    jitterMs: 200,
  });

  const repo = new OrdersRepository(db);

  log.info(`Seeding ${DEMO_ORDERS.length} demo orders...`);

  const nowSeconds = Math.floor(Date.now() / 1000);
  let seededCount = 0;

  for (const demo of DEMO_ORDERS) {
    const hashlock = generateHashlock();

    const input = {
      direction: demo.direction,
      hashlock,
      srcChain: demo.srcChain,
      srcAddress: demo.srcChain === "ethereum" ? generateEthAddress() : generateStellarAddress(),
      srcAsset: demo.srcChain === "ethereum" ? "0x0000000000000000000000000000000000000000" : "native",
      srcAmount: demo.srcChain === "ethereum" ? toWeiString(0.1 + Math.random() * 2) : toStroopString(0.1 + Math.random() * 2).slice(0, -6),
      srcSafetyDeposit: demo.srcChain === "ethereum" ? toWeiString(0.01).toString() : "1000",
      dstChain: demo.dstChain,
      dstAddress: demo.dstChain === "ethereum" ? generateEthAddress() : generateStellarAddress(),
      dstAsset: demo.dstChain === "ethereum" ? "0x0000000000000000000000000000000000000000" : "native",
      dstAmount: demo.dstChain === "ethereum" ? toWeiString(1).toString() : toStroopString(100).toString(),
    };

    try {
      const order = await repo.announce(input as any);

      if (demo.status === "src_locked" || demo.status === "dst_locked" || demo.status === "secret_revealed" || demo.status === "completed") {
        const timelock = Math.floor(Date.now() / 1000) + (demo.status === "expired" ? -3600 : 86400);
        await repo.recordSrcLock({
          publicId: order.publicId,
          orderId: generateOrderId(),
          txHash: generateTxHash(),
          blockNumber: generateBlockNumber(nowSeconds),
          timelock,
        });
      }

      if (demo.status === "dst_locked" || demo.status === "secret_revealed" || demo.status === "completed") {
        const timelock = Math.floor(Date.now() / 1000) + 43200;
        await repo.recordDstLock({
          publicId: order.publicId,
          orderId: generateOrderId(),
          txHash: generateTxHash(),
          blockNumber: generateBlockNumber(nowSeconds),
          timelock,
          resolver: generateEthAddress(),
        });
      }

      if (demo.status === "secret_revealed" || demo.status === "completed") {
        const preimage = demo.preimage ?? "0x" + randomBytes(32).toString("hex");
        await repo.recordSecretRevealed({
          publicId: order.publicId,
          preimage,
          txHash: generateTxHash(),
        });
      }

      if (demo.status === "completed") {
        await repo.setStatus(order.publicId, "completed");
      } else if (demo.status === "refunded") {
        await repo.setStatus(order.publicId, "refunded");
      } else if (demo.status === "expired") {
        await repo.setStatus(order.publicId, "expired");
      }

      log.info({ publicId: order.publicId, direction: demo.direction, status: demo.status }, "seeded demo order");
      seededCount++;
    } catch (err) {
      log.warn({ err }, "failed to seed demo order (may already exist)");
    }
  }

  log.info(`Seeding complete: ${seededCount} orders added`);
  log.info("Demo data ready. Connect to the coordinator to inspect:");
  log.info("  - GET  /orders/:id   - retrieve a single order");
  log.info("  - GET  /orders/history?address=<address> - list orders for an address");
}

seedDatabase().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});