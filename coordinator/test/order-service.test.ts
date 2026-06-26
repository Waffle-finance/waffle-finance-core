import { describe, it, expect, vi } from "vitest";
import pino from "pino";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { openDatabase, PostgresStatement } from "../src/persistence/db.js";
import { OrdersRepository } from "../src/persistence/orders-repo.js";
import { OrderService, OrderValidationError } from "../src/services/order-service.js";
import { SecretService } from "../src/services/secret-service.js";

const log = pino({ level: "silent" });

const VALID_HASHLOCK = "0x" + "a".repeat(64);
const VALID_ETH_ADDR = "0x1111111111111111111111111111111111111111";
const VALID_STELLAR_ADDR = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422";

async function freshDb() {
  const dir = mkdtempSync(resolve(tmpdir(), "wafflefinance-test-"));
  return openDatabase(`file:${dir}/test.db`);
}

describe("OrderService", () => {
  it("announces an eth->xlm order and round-trips it via getById/history", async () => {
    const db = await freshDb();
    const orders = new OrderService(new OrdersRepository(db), log);

    const order = await orders.announce({
      direction: "eth_to_xlm",
      hashlock: VALID_HASHLOCK,
      srcChain: "ethereum",
      srcAddress: VALID_ETH_ADDR,
      srcAsset: "native",
      srcAmount: "1000000000000000000",
      srcSafetyDeposit: "1000000000000000",
      dstChain: "stellar",
      dstAddress: VALID_STELLAR_ADDR,
      dstAsset: "native",
      dstAmount: "100000000"
    });
    expect(order.publicId).toMatch(/^[a-f0-9]{32}$/);
    expect(order.status).toBe("announced");

    const byId = await orders.get(order.publicId);
    expect(byId).not.toBeNull();
    expect(byId!.hashlock).toBe(VALID_HASHLOCK);

    const list = await orders.history(VALID_ETH_ADDR);
    expect(list).toHaveLength(1);
  });

  it("rejects duplicate hashlocks", async () => {
    const db = await freshDb();
    const orders = new OrderService(new OrdersRepository(db), log);
    await orders.announce({
      direction: "eth_to_xlm",
      hashlock: VALID_HASHLOCK,
      srcChain: "ethereum",
      srcAddress: VALID_ETH_ADDR,
      srcAsset: "native",
      srcAmount: "1",
      srcSafetyDeposit: "1",
      dstChain: "stellar",
      dstAddress: VALID_STELLAR_ADDR,
      dstAsset: "native",
      dstAmount: "1"
    });

    await expect(
      orders.announce({
        direction: "eth_to_xlm",
        hashlock: VALID_HASHLOCK,
        srcChain: "ethereum",
        srcAddress: VALID_ETH_ADDR,
        srcAsset: "native",
        srcAmount: "1",
        srcSafetyDeposit: "1",
        dstChain: "stellar",
        dstAddress: VALID_STELLAR_ADDR,
        dstAsset: "native",
        dstAmount: "1"
      })
    ).rejects.toThrowError(OrderValidationError);
  });

  // Cross-field (direction/chain) and address validation now lives in
  // `announceSchema` — see announce-schema.test.ts for the full matrix.
});

describe("SecretService", () => {
  it("rejects a preimage that doesn't hash to the order's hashlock", async () => {
    const db = await freshDb();
    const orders = new OrderService(new OrdersRepository(db), log);
    const order = await orders.announce({
      direction: "eth_to_xlm",
      hashlock: VALID_HASHLOCK,
      srcChain: "ethereum",
      srcAddress: VALID_ETH_ADDR,
      srcAsset: "native",
      srcAmount: "1",
      srcSafetyDeposit: "1",
      dstChain: "stellar",
      dstAddress: VALID_STELLAR_ADDR,
      dstAsset: "native",
      dstAmount: "1"
    });
    const secrets = new SecretService(orders, log);
    // Need src_locked status first
    await orders.recordSrcLock({
      publicId: order.publicId,
      orderId: "1",
      txHash: "0xdead",
      blockNumber: 1,
      timelock: 0
    });
    await expect(secrets.reveal(order.publicId, "0xdeadbeef", "0xtx")).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// expireStaleOrders
// ---------------------------------------------------------------------------

const BASE_ANNOUNCE_INPUT = {
  direction: "eth_to_xlm" as const,
  hashlock: VALID_HASHLOCK,
  srcChain: "ethereum" as const,
  srcAddress: VALID_ETH_ADDR,
  srcAsset: "native",
  srcAmount: "1000000000000000000",
  srcSafetyDeposit: "1000000000000000",
  dstChain: "stellar" as const,
  dstAddress: VALID_STELLAR_ADDR,
  dstAsset: "native",
  dstAmount: "100000000",
};

describe("expireStaleOrders", () => {
  it("marks a src_locked order as expired when its src_timelock has passed", async () => {
    const db = await freshDb();
    const orders = new OrderService(new OrdersRepository(db), log);

    const order = await orders.announce(BASE_ANNOUNCE_INPUT);
    const pastTimelock = Math.floor(Date.now() / 1000) - 3600;

    await orders.recordSrcLock({
      publicId: order.publicId,
      orderId: "1",
      txHash: "0xdeadbeef",
      blockNumber: 1,
      timelock: pastTimelock,
    });

    const expired = await orders.expireStaleOrders();
    expect(expired).toBe(1);

    const updated = await orders.get(order.publicId);
    expect(updated!.status).toBe("expired");
  });

  it("does not expire a src_locked order whose timelock is still in the future", async () => {
    const db = await freshDb();
    const orders = new OrderService(new OrdersRepository(db), log);

    const order = await orders.announce(BASE_ANNOUNCE_INPUT);
    const futureTimelock = Math.floor(Date.now() / 1000) + 7200;

    await orders.recordSrcLock({
      publicId: order.publicId,
      orderId: "2",
      txHash: "0xdeadbeef",
      blockNumber: 1,
      timelock: futureTimelock,
    });

    const expired = await orders.expireStaleOrders();
    expect(expired).toBe(0);

    const updated = await orders.get(order.publicId);
    expect(updated!.status).toBe("src_locked");
  });

  it("marks a dst_locked order as expired when its dst_timelock has passed", async () => {
    const db = await freshDb();
    const repo = new OrdersRepository(db);
    const orders = new OrderService(repo, log);

    const order = await orders.announce(BASE_ANNOUNCE_INPUT);
    const pastTimelock = Math.floor(Date.now() / 1000) - 3600;

    await orders.recordSrcLock({
      publicId: order.publicId,
      orderId: "3",
      txHash: "0xsrclock",
      blockNumber: 1,
      timelock: Math.floor(Date.now() / 1000) + 7200, // src still live
    });
    await orders.recordDstLock({
      publicId: order.publicId,
      orderId: "4",
      txHash: "0xdstlock",
      blockNumber: 2,
      timelock: pastTimelock, // dst expired
      resolver: null,
    });

    const expired = await orders.expireStaleOrders();
    expect(expired).toBe(1);

    const updated = await orders.get(order.publicId);
    expect(updated!.status).toBe("expired");
  });

  it("does not expire terminal (completed / refunded) orders", async () => {
    const db = await freshDb();
    const orders = new OrderService(new OrdersRepository(db), log);

    // Create + advance to completed via refunded path
    const orderA = await orders.announce({
      ...BASE_ANNOUNCE_INPUT,
      hashlock: "0x" + "b".repeat(64),
    });
    const pastTimelock = Math.floor(Date.now() / 1000) - 3600;
    await orders.recordSrcLock({
      publicId: orderA.publicId,
      orderId: "5",
      txHash: "0xtx",
      blockNumber: 1,
      timelock: pastTimelock,
    });
    await orders.markStatus(orderA.publicId, "refunded");

    const expired = await orders.expireStaleOrders();
    expect(expired).toBe(0);

    const updated = await orders.get(orderA.publicId);
    expect(updated!.status).toBe("refunded");
  });

  it("allows an expired order to subsequently be refunded", async () => {
    const db = await freshDb();
    const orders = new OrderService(new OrdersRepository(db), log);

    const order = await orders.announce(BASE_ANNOUNCE_INPUT);
    const pastTimelock = Math.floor(Date.now() / 1000) - 3600;
    await orders.recordSrcLock({
      publicId: order.publicId,
      orderId: "6",
      txHash: "0xexpiry",
      blockNumber: 1,
      timelock: pastTimelock,
    });

    await orders.expireStaleOrders();
    expect((await orders.get(order.publicId))!.status).toBe("expired");

    await orders.markStatus(order.publicId, "refunded");
    expect((await orders.get(order.publicId))!.status).toBe("refunded");
  });

  it("returns 0 and does nothing when no orders are stale", async () => {
    const db = await freshDb();
    const orders = new OrderService(new OrdersRepository(db), log);

    const expired = await orders.expireStaleOrders();
    expect(expired).toBe(0);
  });
});

describe("PostgresStatement", () => {
  it("uses async execution and converts SQLite timestamp expressions", async () => {
    const query = vi.fn(async () => ({ rowCount: 1, rows: [] }));
    const stmt = new PostgresStatement(
      { query } as unknown as ConstructorParameters<typeof PostgresStatement>[0],
      `
        UPDATE orders
        SET updated_at = CAST(strftime('%s','now') AS INTEGER)
        WHERE public_id = :publicId
      `
    );

    await stmt.runAsync({ publicId: "order-1" });

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("CAST(EXTRACT(EPOCH FROM NOW()) AS INTEGER)"),
      ["order-1"]
    );
  });
});
