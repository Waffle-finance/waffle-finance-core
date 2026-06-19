/**
 * PostgreSQL compatibility tests for the coordinator persistence layer.
 * 
 * These tests verify that SQLite-to-Postgres SQL translation works correctly
 * and that all OrdersRepository operations function identically on both databases.
 * 
 * To run with PostgreSQL:
 * 1. Start a PostgreSQL server (e.g., via Docker):
 *    docker run --name postgres-test -e POSTGRES_PASSWORD=test -e POSTGRES_USER=test -e POSTGRES_DB=waffle_test -p 5432:5432 -d postgres:15
 * 
 * 2. Run tests with PostgreSQL enabled:
 *    TEST_WITH_POSTGRES=true pnpm test db-postgres.test.ts
 * 
 * 3. Optionally specify a custom connection string:
 *    POSTGRES_TEST_URL=postgresql://user:pass@host:5432/db TEST_WITH_POSTGRES=true pnpm test db-postgres.test.ts
 * 
 * Without TEST_WITH_POSTGRES=true, only SQLite tests and SQL translation unit tests will run.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import pino from "pino";
import { Pool } from "pg";
import { openDatabase, isPostgresDatabase, PostgresStatement } from "../src/persistence/db.js";
import { OrdersRepository } from "../src/persistence/orders-repo.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const log = pino({ level: "silent" });

const VALID_HASHLOCK = "0x" + "a".repeat(64);
const VALID_ETH_ADDR = "0x1111111111111111111111111111111111111111";
const VALID_STELLAR_ADDR = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422";

// Test configuration
const POSTGRES_URL = process.env.POSTGRES_TEST_URL || "postgresql://test:test@localhost:5432/waffle_test";
const USE_POSTGRES = process.env.TEST_WITH_POSTGRES === "true";

// Helper to create SQLite database for comparison
async function createSqliteDb() {
  const dir = mkdtempSync(resolve(tmpdir(), "wafflefinance-test-"));
  return openDatabase(`file:${dir}/test.db`);
}

// Helper to create PostgreSQL database
async function createPostgresDb() {
  try {
    const db = await openDatabase(POSTGRES_URL);
    if (!isPostgresDatabase(db)) {
      throw new Error("Expected PostgreSQL database");
    }
    // Clear all tables for clean test
    await db.exec(`
      DROP TABLE IF EXISTS order_events CASCADE;
      DROP TABLE IF EXISTS orders CASCADE;
      DROP TABLE IF EXISTS resolver_heartbeats CASCADE;
    `);
    return db;
  } catch (error) {
    console.warn("PostgreSQL not available for testing:", error);
    return null;
  }
}

describe("PostgreSQL Database Compatibility", () => {
  let pgDb: any = null;
  let sqliteDb: any = null;

  beforeAll(async () => {
    if (USE_POSTGRES) {
      pgDb = await createPostgresDb();
    }
    sqliteDb = await createSqliteDb();
  });

  afterAll(async () => {
    if (pgDb && isPostgresDatabase(pgDb)) {
      const pool = pgDb.getPool();
      await pool.end();
    }
  });

  const testBoth = (testName: string, testFn: (db: any, dbType: 'sqlite' | 'postgres') => Promise<void>) => {
    it(`${testName} (SQLite)`, () => testFn(sqliteDb, 'sqlite'));
    
    if (USE_POSTGRES) {
      it(`${testName} (PostgreSQL)`, async () => {
        if (!pgDb) {
          console.log("PostgreSQL database not available, skipping test");
          return;
        }
        await testFn(pgDb, 'postgres');
      });
    }
  };

  testBoth("should create schema and run migrations", async (db, dbType) => {
    expect(db).toBeTruthy();
    
    // Verify tables were created
    if (dbType === 'postgres') {
      const result = await db.getPool().query(`
        SELECT tablename FROM pg_tables 
        WHERE schemaname = 'public' AND tablename IN ('orders', 'order_events', 'resolver_heartbeats')
        ORDER BY tablename
      `);
      expect(result.rows.map((r: any) => r.tablename)).toEqual(['order_events', 'orders', 'resolver_heartbeats']);
    }
    // For SQLite, just test that we can query the schema
    const stmt = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
    if (dbType === 'sqlite') {
      const tables = stmt.all();
      expect(tables.map((t: any) => t.name)).toContain('orders');
    }
  });

  testBoth("should support all OrdersRepository operations", async (db, dbType) => {
    const repo = new OrdersRepository(db);
    
    // Test announce order
    const order = await repo.announce({
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
    expect(order.hashlock).toBe(VALID_HASHLOCK);

    // Test findByPublicId
    const found = await repo.findByPublicId(order.publicId);
    expect(found).not.toBeNull();
    expect(found!.hashlock).toBe(VALID_HASHLOCK);

    // Test findByHashlock
    const foundByHash = await repo.findByHashlock(VALID_HASHLOCK);
    expect(foundByHash).not.toBeNull();
    expect(foundByHash!.publicId).toBe(order.publicId);

    // Test recordSrcLock
    await repo.recordSrcLock({
      publicId: order.publicId,
      orderId: "eth-order-123",
      txHash: "0xdeadbeef",
      blockNumber: 12345,
      timelock: Math.floor(Date.now() / 1000) + 86400
    });

    // Test findBySrcOrderId
    const foundBySrc = await repo.findBySrcOrderId("ethereum", "eth-order-123");
    expect(foundBySrc).not.toBeNull();
    expect(foundBySrc!.publicId).toBe(order.publicId);
    expect(foundBySrc!.status).toBe("src_locked");

    // Test recordDstLock
    await repo.recordDstLock({
      publicId: order.publicId,
      orderId: "stellar-order-456",
      txHash: "stellar-tx-hash",
      blockNumber: 67890,
      timelock: Math.floor(Date.now() / 1000) + 43200,
      resolver: VALID_ETH_ADDR
    });

    // Test findByDstOrderId
    const foundByDst = await repo.findByDstOrderId("stellar", "stellar-order-456");
    expect(foundByDst).not.toBeNull();
    expect(foundByDst!.publicId).toBe(order.publicId);
    expect(foundByDst!.status).toBe("dst_locked");

    // Test recordSecretRevealed
    const testPreimage = "0x" + "b".repeat(64);
    await repo.recordSecretRevealed({
      publicId: order.publicId,
      preimage: testPreimage,
      txHash: "0xsecrettx"
    });

    const revealed = await repo.findByPublicId(order.publicId);
    expect(revealed).not.toBeNull();
    expect(revealed!.status).toBe("secret_revealed");
    expect(revealed!.preimage).toBe(testPreimage);

    // Test findByAddress
    const userOrders = await repo.findByAddress(VALID_ETH_ADDR);
    expect(userOrders).toHaveLength(1);
    expect(userOrders[0].publicId).toBe(order.publicId);

    // Test setStatus
    await repo.setStatus(order.publicId, "completed");
    const completed = await repo.findByPublicId(order.publicId);
    expect(completed).not.toBeNull();
    expect(completed!.status).toBe("completed");
  });

  testBoth("should handle Solana chains correctly", async (db, dbType) => {
    const repo = new OrdersRepository(db);
    
    const order = await repo.announce({
      direction: "eth_to_sol",
      hashlock: "0x" + "c".repeat(64),
      srcChain: "ethereum",
      srcAddress: VALID_ETH_ADDR,
      srcAsset: "native",
      srcAmount: "1000000000000000000",
      srcSafetyDeposit: "1000000000000000",
      dstChain: "solana",
      dstAddress: "11111111111111111111111111111112", // Valid Solana address format
      dstAsset: "native",
      dstAmount: "1000000000"
    });

    expect(order.direction).toBe("eth_to_sol");
    expect(order.dstChain).toBe("solana");

    const reverse = await repo.announce({
      direction: "sol_to_eth",
      hashlock: "0x" + "d".repeat(64),
      srcChain: "solana",
      srcAddress: "11111111111111111111111111111113",
      srcAsset: "native", 
      srcAmount: "1000000000",
      srcSafetyDeposit: "10000000",
      dstChain: "ethereum",
      dstAddress: VALID_ETH_ADDR,
      dstAsset: "native",
      dstAmount: "500000000000000000"
    });

    expect(reverse.direction).toBe("sol_to_eth");
    expect(reverse.srcChain).toBe("solana");
  });
});

describe("PostgresStatement SQL Translation", () => {
  let mockPool: any;

  beforeEach(() => {
    mockPool = {
      query: vi.fn()
    };
  });

  it("should convert strftime expressions correctly", async () => {
    const stmt = new PostgresStatement(mockPool, `
      UPDATE orders 
      SET updated_at = CAST(strftime('%s','now') AS INTEGER) 
      WHERE public_id = :publicId
    `);

    mockPool.query.mockResolvedValueOnce({ rowCount: 1 });
    
    await stmt.runAsync({ publicId: "test-order" });

    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining("CAST(EXTRACT(EPOCH FROM NOW()) AS INTEGER)"),
      ["test-order"]
    );
    expect(mockPool.query).toHaveBeenCalledWith(
      expect.not.stringContaining("strftime"),
      ["test-order"]
    );
  });

  it("should handle named parameters in correct order", async () => {
    const stmt = new PostgresStatement(mockPool, `
      INSERT INTO orders (public_id, direction, hashlock, src_chain, dst_chain)
      VALUES (:publicId, :direction, :hashlock, :srcChain, :dstChain)
    `);

    mockPool.query.mockResolvedValueOnce({ rowCount: 1 });

    const params = {
      publicId: "test-id",
      direction: "eth_to_xlm",  
      hashlock: "0xhash",
      srcChain: "ethereum",
      dstChain: "stellar"
    };

    await stmt.runAsync(params);

    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining("VALUES ($1, $2, $3, $4, $5)"),
      ["test-id", "eth_to_xlm", "0xhash", "ethereum", "stellar"]
    );
  });

  it("should handle positional parameters", async () => {
    const stmt = new PostgresStatement(mockPool, `
      SELECT * FROM orders WHERE hashlock = ? AND status = ?
    `);

    mockPool.query.mockResolvedValueOnce({ rows: [] });

    await stmt.allAsync("0xhash", "announced");

    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining("WHERE hashlock = $1 AND status = $2"),
      ["0xhash", "announced"]
    );
  });

  it("should handle mixed named parameters with nested objects", async () => {
    const stmt = new PostgresStatement(mockPool, `
      SELECT * FROM orders 
      WHERE (src_address = :addr OR dst_address = :addr)
      ORDER BY created_at DESC
      LIMIT :limit OFFSET :offset
    `);

    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const params = { addr: VALID_ETH_ADDR, limit: 10, offset: 0 };
    await stmt.allAsync(params);

    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining("WHERE (src_address = $1 OR dst_address = $1)"),
      [VALID_ETH_ADDR, 10, 0]
    );
  });

  it("should handle complex UPDATE with multiple named params and strftime", async () => {
    const stmt = new PostgresStatement(mockPool, `
      UPDATE orders SET
        dst_order_id = :orderId,
        dst_lock_tx = :txHash,
        dst_timelock = :timelock,
        resolver_address = :resolver,
        updated_at = CAST(strftime('%s','now') AS INTEGER)
      WHERE public_id = :publicId
    `);

    mockPool.query.mockResolvedValueOnce({ rowCount: 1 });

    const params = {
      orderId: "dst-123",
      txHash: "0xtxhash", 
      timelock: 1234567890,
      resolver: VALID_ETH_ADDR,
      publicId: "order-456"
    };

    await stmt.runAsync(params);

    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining("CAST(EXTRACT(EPOCH FROM NOW()) AS INTEGER)"),
      expect.arrayContaining(["dst-123", "0xtxhash", 1234567890, VALID_ETH_ADDR, "order-456"])
    );
  });

  it("should preserve null handling", async () => {
    const stmt = new PostgresStatement(mockPool, `
      UPDATE orders SET resolver_address = :resolver WHERE public_id = :publicId
    `);

    mockPool.query.mockResolvedValueOnce({ rowCount: 1 });

    await stmt.runAsync({ resolver: null, publicId: "test-order" });

    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringMatching(/UPDATE orders SET resolver_address = \$1 WHERE public_id = \$2/),
      [null, "test-order"]
    );
  });
});
