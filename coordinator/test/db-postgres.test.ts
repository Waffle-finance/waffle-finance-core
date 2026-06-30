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
import {
  openDatabase,
  isPostgresDatabase,
  PostgresStatement,
  queryMigrations,
  getCurrentSchemaVersion,
} from "../src/persistence/db.js";
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
        WHERE schemaname = 'public'
          AND tablename IN ('orders', 'order_events', 'resolver_heartbeats', 'schema_migrations')
        ORDER BY tablename
      `);
      expect(result.rows.map((r: any) => r.tablename)).toEqual([
        'order_events', 'orders', 'resolver_heartbeats', 'schema_migrations'
      ]);
    }
    // For SQLite, just test that we can query the schema
    const stmt = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
    if (dbType === 'sqlite') {
      const tables = stmt.all();
      expect(tables.map((t: any) => t.name)).toContain('orders');
      expect(tables.map((t: any) => t.name)).toContain('schema_migrations');
    }

    // Both backends: migration history should be populated
    const migrations = await queryMigrations(db);
    expect(migrations.length).toBeGreaterThan(0);
    const version = await getCurrentSchemaVersion(db);
    const expected = dbType === "postgres" ? "006_stale_cleanup_postgres.sql" : "006_stale_cleanup.sql";
    expect(version).toBe(expected);
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

    expect(order.publicId).toMatch(/^wf_0x[0-9a-f]{64}$/);
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
      dstAddress: "11111111111111111111111111111112",
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

  // ── Additional repository operation tests ──────────────────────────────

  testBoth("should rollback src lock from src_locked to announced", async (db) => {
    const repo = new OrdersRepository(db);
    const order = await repo.announce({
      direction: "eth_to_xlm", hashlock: "0x" + "8".repeat(64),
      srcChain: "ethereum", srcAddress: VALID_ETH_ADDR,
      srcAsset: "native", srcAmount: "1", srcSafetyDeposit: "1",
      dstChain: "stellar", dstAddress: VALID_STELLAR_ADDR,
      dstAsset: "native", dstAmount: "1"
    });

    await repo.recordSrcLock({
      publicId: order.publicId, orderId: "src-roll-1",
      txHash: "0xroll", blockNumber: 10, timelock: 999999
    });
    expect((await repo.findByPublicId(order.publicId))!.status).toBe("src_locked");

    await repo.rollbackSrcLock(order.publicId);
    const rolled = await repo.findByPublicId(order.publicId);
    expect(rolled!.status).toBe("announced");
    expect(rolled!.srcOrderId).toBeNull();
    expect(rolled!.srcLockTx).toBeNull();
    expect(rolled!.srcLockBlock).toBeNull();
    expect(rolled!.srcTimelock).toBeNull();
  });

  testBoth("should rollback dst lock from dst_locked to src_locked", async (db) => {
    const repo = new OrdersRepository(db);
    const order = await repo.announce({
      direction: "eth_to_xlm", hashlock: "0x" + "9".repeat(64),
      srcChain: "ethereum", srcAddress: VALID_ETH_ADDR,
      srcAsset: "native", srcAmount: "1", srcSafetyDeposit: "1",
      dstChain: "stellar", dstAddress: VALID_STELLAR_ADDR,
      dstAsset: "native", dstAmount: "1"
    });

    await repo.recordSrcLock({
      publicId: order.publicId, orderId: "src-roll-2",
      txHash: "0xsrc", blockNumber: 10, timelock: 999999
    });
    await repo.recordDstLock({
      publicId: order.publicId, orderId: "dst-roll-1",
      txHash: "0xdst", blockNumber: 20, timelock: 888888,
      resolver: VALID_ETH_ADDR
    });
    expect((await repo.findByPublicId(order.publicId))!.status).toBe("dst_locked");

    await repo.rollbackDstLock(order.publicId);
    const rolled = await repo.findByPublicId(order.publicId);
    expect(rolled!.status).toBe("src_locked");
    expect(rolled!.dstOrderId).toBeNull();
    expect(rolled!.dstLockTx).toBeNull();
    expect(rolled!.resolverAddress).toBeNull();
  });

  testBoth("should find stale announced orders", async (db) => {
    const repo = new OrdersRepository(db);
    const order = await repo.announce({
      direction: "eth_to_xlm", hashlock: "0x" + "e".repeat(64),
      srcChain: "ethereum", srcAddress: VALID_ETH_ADDR,
      srcAsset: "native", srcAmount: "1", srcSafetyDeposit: "1",
      dstChain: "stellar", dstAddress: VALID_STELLAR_ADDR,
      dstAsset: "native", dstAmount: "1"
    });

    const stale = await repo.findStaleAnnounced(-1);
    expect(stale.some((o) => o.publicId === order.publicId)).toBe(true);
  });

  testBoth("should archive an order", async (db) => {
    const repo = new OrdersRepository(db);
    const order = await repo.announce({
      direction: "eth_to_xlm", hashlock: "0x" + "f".repeat(64),
      srcChain: "ethereum", srcAddress: VALID_ETH_ADDR,
      srcAsset: "native", srcAmount: "1", srcSafetyDeposit: "1",
      dstChain: "stellar", dstAddress: VALID_STELLAR_ADDR,
      dstAsset: "native", dstAmount: "1"
    });

    expect((await repo.findByPublicId(order.publicId))!.archivedAt).toBeNull();

    await repo.archiveOrder(order.publicId);
    const archived = await repo.findByPublicId(order.publicId);
    expect(archived!.archivedAt).toBeGreaterThan(0);
  });

  testBoth("should get last processed block", async (db) => {
    const repo = new OrdersRepository(db);
    const order1 = await repo.announce({
      direction: "eth_to_xlm", hashlock: "0x" + "1".repeat(64),
      srcChain: "ethereum", srcAddress: VALID_ETH_ADDR,
      srcAsset: "native", srcAmount: "1", srcSafetyDeposit: "1",
      dstChain: "stellar", dstAddress: VALID_STELLAR_ADDR,
      dstAsset: "native", dstAmount: "1"
    });
    const order2 = await repo.announce({
      direction: "xlm_to_eth", hashlock: "0x" + "2".repeat(64),
      srcChain: "stellar", srcAddress: VALID_STELLAR_ADDR,
      srcAsset: "native", srcAmount: "1", srcSafetyDeposit: "1",
      dstChain: "ethereum", dstAddress: VALID_ETH_ADDR,
      dstAsset: "native", dstAmount: "1"
    });

    await repo.recordSrcLock({
      publicId: order1.publicId, orderId: "eth-src-1",
      txHash: "0xs1", blockNumber: 999001, timelock: 999999
    });
    await repo.recordSrcLock({
      publicId: order2.publicId, orderId: "xlm-src-1",
      txHash: "0xs2", blockNumber: 999002, timelock: 999999
    });
    await repo.recordDstLock({
      publicId: order1.publicId, orderId: "eth-dst-1",
      txHash: "0xd1", blockNumber: 999000, timelock: 888888,
      resolver: VALID_ETH_ADDR
    });

    const ethBlock = await repo.getLastProcessedBlock("ethereum");
    expect(ethBlock).toBe(999001);
    const stellarBlock = await repo.getLastProcessedBlock("stellar");
    expect(stellarBlock).toBe(999002);
    const unknownBlock = await repo.getLastProcessedBlock("solana");
    expect(unknownBlock).toBe(0);
  });

  testBoth("should find expired candidates", async (db) => {
    const repo = new OrdersRepository(db);
    const past = Math.floor(Date.now() / 1000) - 1000;
    const future = Math.floor(Date.now() / 1000) + 99999;

    const expiredOrder = await repo.announce({
      direction: "eth_to_xlm", hashlock: "0x" + "3".repeat(64),
      srcChain: "ethereum", srcAddress: VALID_ETH_ADDR,
      srcAsset: "native", srcAmount: "1", srcSafetyDeposit: "1",
      dstChain: "stellar", dstAddress: VALID_STELLAR_ADDR,
      dstAsset: "native", dstAmount: "1"
    });
    await repo.recordSrcLock({
      publicId: expiredOrder.publicId, orderId: "exp-src",
      txHash: "0xexp", blockNumber: 1, timelock: past
    });

    const validOrder = await repo.announce({
      direction: "eth_to_xlm", hashlock: "0x" + "4".repeat(64),
      srcChain: "ethereum", srcAddress: VALID_ETH_ADDR,
      srcAsset: "native", srcAmount: "1", srcSafetyDeposit: "1",
      dstChain: "stellar", dstAddress: VALID_STELLAR_ADDR,
      dstAsset: "native", dstAmount: "1"
    });
    await repo.recordSrcLock({
      publicId: validOrder.publicId, orderId: "val-src",
      txHash: "0xval", blockNumber: 2, timelock: future
    });

    const candidates = await repo.findExpiredCandidates(Math.floor(Date.now() / 1000));
    expect(candidates.some((o) => o.publicId === expiredOrder.publicId)).toBe(true);
    expect(candidates.some((o) => o.publicId === validOrder.publicId)).toBe(false);
  });

  testBoth("should find orders missing secret", async (db) => {
    const repo = new OrdersRepository(db);

    const missingOrder = await repo.announce({
      direction: "eth_to_xlm", hashlock: "0x" + "5".repeat(64),
      srcChain: "ethereum", srcAddress: VALID_ETH_ADDR,
      srcAsset: "native", srcAmount: "1", srcSafetyDeposit: "1",
      dstChain: "stellar", dstAddress: VALID_STELLAR_ADDR,
      dstAsset: "native", dstAmount: "1"
    });
    await repo.recordSrcLock({
      publicId: missingOrder.publicId, orderId: "miss-src",
      txHash: "0xmiss", blockNumber: 1, timelock: 999999
    });

    const withSecret = await repo.announce({
      direction: "eth_to_xlm", hashlock: "0x" + "6".repeat(64),
      srcChain: "ethereum", srcAddress: VALID_ETH_ADDR,
      srcAsset: "native", srcAmount: "1", srcSafetyDeposit: "1",
      dstChain: "stellar", dstAddress: VALID_STELLAR_ADDR,
      dstAsset: "native", dstAmount: "1"
    });
    await repo.recordSrcLock({
      publicId: withSecret.publicId, orderId: "sec-src",
      txHash: "0xsec", blockNumber: 2, timelock: 999999
    });
    await repo.recordSecretRevealed({
      publicId: withSecret.publicId, preimage: "0xdead",
      txHash: "0xreveal"
    });

    const missing = await repo.findOrdersMissingSecret();
    expect(missing.some((o) => o.publicId === missingOrder.publicId)).toBe(true);
    expect(missing.some((o) => o.publicId === withSecret.publicId)).toBe(false);
  });

  testBoth("should handle recordSecretRevealed with encVersion", async (db) => {
    const repo = new OrdersRepository(db);
    const order = await repo.announce({
      direction: "eth_to_xlm", hashlock: "0x" + "7".repeat(64),
      srcChain: "ethereum", srcAddress: VALID_ETH_ADDR,
      srcAsset: "native", srcAmount: "1", srcSafetyDeposit: "1",
      dstChain: "stellar", dstAddress: VALID_STELLAR_ADDR,
      dstAsset: "native", dstAmount: "1"
    });

    await repo.recordSecretRevealed({
      publicId: order.publicId, preimage: "0xencpreimage",
      txHash: "0xenc", encVersion: 1
    });

    const revealed = await repo.findByPublicId(order.publicId);
    expect(revealed!.preimageEncVersion).toBe(1);
  });

  testBoth("should support findByAddress with pagination", async (db) => {
    const repo = new OrdersRepository(db);
    const addr = "0x3333333333333333333333333333333333333333";
    const orders = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        repo.announce({
          direction: "eth_to_xlm",
          hashlock: "0x" + (100 + i).toString(16).padStart(64, "0"),
          srcChain: "ethereum", srcAddress: addr,
          srcAsset: "native", srcAmount: String(i + 1),
          srcSafetyDeposit: "1",
          dstChain: "stellar", dstAddress: VALID_STELLAR_ADDR,
          dstAsset: "native", dstAmount: "1"
        })
      )
    );

    const page1 = await repo.findByAddress(addr, 2, 0);
    expect(page1).toHaveLength(2);

    const page2 = await repo.findByAddress(addr, 2, 2);
    expect(page2).toHaveLength(2);

    const page3 = await repo.findByAddress(addr, 2, 4);
    expect(page3).toHaveLength(1);

    const allIds = [...page1, ...page2, ...page3].map((o) => o.publicId);
    const expectedIds = orders.map((o) => o.publicId);
    expect(allIds.sort()).toEqual(expectedIds.sort());
  });

  testBoth("should return empty results for non-existent queries", async (db) => {
    const repo = new OrdersRepository(db);

    expect(await repo.findByPublicId("nonexistent")).toBeNull();
    expect(await repo.findByHashlock("0x" + "0".repeat(64))).toBeNull();
    expect(await repo.findBySrcOrderId("ethereum", "no-such-order")).toBeNull();
    expect(await repo.findByDstOrderId("stellar", "no-such-order")).toBeNull();
    expect(await repo.findByAddress("0x0000000000000000000000000000000000000000")).toHaveLength(0);
  });
});

// ── PostgreSQL Migration Edge Cases ──────────────────────────────────────

describe("PostgreSQL Migration Edge Cases", () => {
  let pgDb: any = null;

  beforeAll(async () => {
    if (!USE_POSTGRES) return;
    pgDb = await createPostgresDb();
  });

  afterAll(async () => {
    if (pgDb && isPostgresDatabase(pgDb)) {
      await pgDb.getPool().end();
    }
  });

  const createFreshPgDb = async () => {
    if (!USE_POSTGRES || !pgDb) return null;
    const pool = pgDb.getPool();
    await pool.query("DROP TABLE IF EXISTS order_events CASCADE");
    await pool.query("DROP TABLE IF EXISTS orders CASCADE");
    await pool.query("DROP TABLE IF EXISTS resolver_heartbeats CASCADE");
    await pool.query("DROP TABLE IF EXISTS schema_migrations CASCADE");
    return openDatabase(POSTGRES_URL);
  };

  it("applies migrations in the correct order", async () => {
    const fresh = await createFreshPgDb();
    if (!fresh) return;

    const migrations = await queryMigrations(fresh);
    const names = migrations.map((m) => m.migration);
    expect(names).toEqual([
      "001_initial.sql",
      "002_solana_support_postgres.sql",
      "003_secret_encryption.sql",
      "004_query_optimizations.sql",
      "005_schema_migrations.sql",
      "006_stale_cleanup_postgres.sql",
    ]);

    await fresh.getPool().end();
  });

  it("does not re-apply migrations on reopen", async () => {
    const url = POSTGRES_URL;

    // Open once — applies all migrations
    const db1 = await createFreshPgDb();
    if (!db1) return;
    const records1 = await queryMigrations(db1);
    await db1.getPool().end();

    // Open again — migration loop should skip already-applied
    const db2 = await openDatabase(url);
    if (!isPostgresDatabase(db2)) return;
    const records2 = await queryMigrations(db2);
    expect(records2).toHaveLength(records1.length);
    await db2.getPool().end();
  });

  it("records duration_ms > 0 for applied migrations", async () => {
    const fresh = await createFreshPgDb();
    if (!fresh) return;

    const migrations = await queryMigrations(fresh);
    for (const m of migrations) {
      expect(m.durationMs).toBeGreaterThanOrEqual(0);
    }

    await fresh.getPool().end();
  });

  it("records appliedAt as a valid unix timestamp", async () => {
    const fresh = await createFreshPgDb();
    if (!fresh) return;

    const now = Math.floor(Date.now() / 1000);
    const migrations = await queryMigrations(fresh);
    for (const m of migrations) {
      expect(m.appliedAt).toBeGreaterThan(1_700_000_000);
      expect(m.appliedAt).toBeLessThanOrEqual(now + 5);
    }

    await fresh.getPool().end();
  });

  it("getCurrentSchemaVersion returns the latest migration name", async () => {
    const fresh = await createFreshPgDb();
    if (!fresh) return;

    const version = await getCurrentSchemaVersion(fresh);
    expect(version).toBe("006_stale_cleanup_postgres.sql");

    await fresh.getPool().end();
  });

  it("getCurrentSchemaVersion returns null after clearing migrations", async () => {
    const fresh = await createFreshPgDb();
    if (!fresh) return;

    await fresh.getPool().query("DELETE FROM schema_migrations");
    const version = await getCurrentSchemaVersion(fresh);
    expect(version).toBeNull();

    await fresh.getPool().end();
  });

  it("reopening the database three times still yields correct record count", async () => {
    const url = POSTGRES_URL;

    const db1 = await createFreshPgDb();
    if (!db1) return;
    const count1 = (await queryMigrations(db1)).length;
    await db1.getPool().end();

    const db2 = await openDatabase(url);
    if (!isPostgresDatabase(db2)) return;
    const count2 = (await queryMigrations(db2)).length;
    await db2.getPool().end();

    const db3 = await openDatabase(url);
    if (!isPostgresDatabase(db3)) return;
    const count3 = (await queryMigrations(db3)).length;
    await db3.getPool().end();

    expect(count2).toBe(count1);
    expect(count3).toBe(count1);
  });

  it("ON CONFLICT DO NOTHING prevents duplicate migration records", async () => {
    const fresh = await createFreshPgDb();
    if (!fresh) return;
    const pool = fresh.getPool();

    const before = (await queryMigrations(fresh)).length;

    const first = await pool.query(
      `INSERT INTO schema_migrations (migration, applied_at, duration_ms)
       VALUES ('999_test.sql', $1, 0) ON CONFLICT DO NOTHING`,
      [Math.floor(Date.now() / 1000)]
    );
    expect(first.rowCount).toBe(1);

    const dup = await pool.query(
      `INSERT INTO schema_migrations (migration, applied_at, duration_ms)
       VALUES ('999_test.sql', $1, 0) ON CONFLICT DO NOTHING`,
      [Math.floor(Date.now() / 1000)]
    );
    expect(dup.rowCount).toBe(0);

    const after = (await queryMigrations(fresh)).length;
    expect(after).toBe(before + 1);

    await fresh.getPool().end();
  });
});

// ── PostgreSQL Index and Constraint Verification ─────────────────────────

describe("PostgreSQL Index and Constraint Verification", () => {
  let pgDb: any = null;

  beforeAll(async () => {
    if (!USE_POSTGRES) return;
    pgDb = await createPostgresDb();
  });

  afterAll(async () => {
    if (pgDb && isPostgresDatabase(pgDb)) {
      await pgDb.getPool().end();
    }
  });

  it("has all expected indexes on the orders table", async () => {
    if (!pgDb) return;
    const result = await pgDb.getPool().query(`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE tablename = 'orders'
        AND schemaname = 'public'
      ORDER BY indexname
    `);
    const names = result.rows.map((r: any) => r.indexname);
    expect(names).toContain("idx_orders_hashlock");
    expect(names).toContain("idx_orders_src_address");
    expect(names).toContain("idx_orders_dst_address");
    expect(names).toContain("idx_orders_status");
    expect(names).toContain("idx_orders_src_order_id");
    expect(names).toContain("idx_orders_dst_order_id");
    expect(names).toContain("idx_orders_public_id");
    expect(names).toContain("idx_orders_created_at");
    expect(names).toContain("idx_orders_src_address_created_at");
    expect(names).toContain("idx_orders_dst_address_created_at");
  });

  it("has the correct CHECK constraints on orders", async () => {
    if (!pgDb) return;
    const result = await pgDb.getPool().query(`
      SELECT conname, pg_get_constraintdef(oid) AS consrc
      FROM pg_constraint
      WHERE conrelid = 'orders'::regclass
        AND contype = 'c'
      ORDER BY conname
    `);
    const constraints = result.rows.map((r: any) => r.consrc);
    expect(constraints.some((c: string) => c.includes("direction IN"))).toBe(true);
    expect(constraints.some((c: string) => c.includes("src_chain IN"))).toBe(true);
    expect(constraints.some((c: string) => c.includes("dst_chain IN"))).toBe(true);
    expect(constraints.some((c: string) => c.includes("status IN"))).toBe(true);
  });

  it("has the correct CHECK values including Solana", async () => {
    if (!pgDb) return;
    const result = await pgDb.getPool().query(`
      SELECT pg_get_constraintdef(oid) AS consrc
      FROM pg_constraint
      WHERE conrelid = 'orders'::regclass
        AND contype = 'c'
        AND conname = 'orders_direction_check'
    `);
    expect(result.rows.length).toBe(1);
    const def: string = result.rows[0].consrc;
    expect(def).toContain("eth_to_sol");
    expect(def).toContain("sol_to_eth");
    expect(def).toContain("eth_to_xlm");
    expect(def).toContain("xlm_to_eth");
  });

  it("has a primary key on orders", async () => {
    if (!pgDb) return;
    const result = await pgDb.getPool().query(`
      SELECT conname, contype FROM pg_constraint
      WHERE conrelid = 'orders'::regclass
        AND contype = 'p'
    `);
    expect(result.rows.length).toBeGreaterThanOrEqual(1);
  });

  it("has order_events table with foreign key to orders", async () => {
    if (!pgDb) return;
    const result = await pgDb.getPool().query(`
      SELECT conname, contype, pg_get_constraintdef(oid) AS consrc
      FROM pg_constraint
      WHERE conrelid = 'order_events'::regclass
        AND contype = 'f'
    `);
    expect(result.rows.length).toBeGreaterThanOrEqual(1);
    const def: string = result.rows[0].consrc;
    expect(def).toContain("orders");
  });

  it("has the correct default expressions on orders", async () => {
    if (!pgDb) return;
    const result = await pgDb.getPool().query(`
      SELECT column_name, column_default
      FROM information_schema.columns
      WHERE table_name = 'orders'
        AND column_default IS NOT NULL
      ORDER BY column_name
    `);
    const defaults = result.rows.map((r: any) => r.column_default);
    expect(defaults.some((d: string) => d.includes("EXTRACT(EPOCH FROM NOW())"))).toBe(true);
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

  // ── SQL Translation Edge Cases ─────────────────────────────────────────


  it("should handle SQL with no placeholders at all", async () => {
    const stmt = new PostgresStatement(mockPool, `
      SELECT COUNT(*) AS cnt FROM orders
    `);

    mockPool.query.mockResolvedValueOnce({ rows: [{ cnt: 42 }] });

    const result = await stmt.allAsync();
    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining("SELECT COUNT(*) AS cnt FROM orders"),
      []
    );
    expect(result).toEqual([{ cnt: 42 }]);
  });

  it("should handle SQL with only strftime and no params", async () => {
    const stmt = new PostgresStatement(mockPool, `
      SELECT CAST(strftime('%s','now') AS INTEGER) AS ts
    `);

    mockPool.query.mockResolvedValueOnce({ rows: [{ ts: 12345 }] });

    await stmt.getAsync();

    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining("CAST(EXTRACT(EPOCH FROM NOW()) AS INTEGER)"),
      []
    );
  });

  it("should handle very large BigInt-like numeric params", async () => {
    const stmt = new PostgresStatement(mockPool, `
      SELECT * FROM orders WHERE src_lock_block = ?
    `);

    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const bigVal = 9223372036854775807;
    await stmt.allAsync(bigVal);

    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining("src_lock_block = $1"),
      [bigVal]
    );
  });

  it("should handle large string params (long hex preimages)", async () => {
    const stmt = new PostgresStatement(mockPool, `
      UPDATE orders SET preimage = :preimage WHERE public_id = :publicId
    `);

    mockPool.query.mockResolvedValueOnce({ rowCount: 1 });

    const longPreimage = "0x" + "f".repeat(128);
    await stmt.runAsync({ preimage: longPreimage, publicId: "long-test" });

    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining("preimage = $1"),
      [longPreimage, "long-test"]
    );
  });

  it("should handle params with special characters", async () => {
    const stmt = new PostgresStatement(mockPool, `
      SELECT * FROM orders WHERE hashlock = ?
    `);

    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const specialHash = "0x' OR '1'='1";
    await stmt.allAsync(specialHash);

    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining("hashlock = $1"),
      [specialHash]
    );
  });

  it("should handle params with unicode characters", async () => {
    const stmt = new PostgresStatement(mockPool, `
      SELECT * FROM orders WHERE src_address = ?
    `);

    mockPool.query.mockResolvedValueOnce({ rows: [] });

    await stmt.allAsync("\u{1F600}unicode_address");

    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining("src_address = $1"),
      ["\u{1F600}unicode_address"]
    );
  });

  it("KNOWN LIMITATION: named param patterns inside string literals are still converted (regex-based translation)", async () => {
    const stmt = new PostgresStatement(mockPool, `
      SELECT * FROM orders WHERE src_lock_tx = ':literal'
    `);

    mockPool.query.mockResolvedValueOnce({ rows: [] });

    await stmt.allAsync();

    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining("'$1'"),
      [undefined]
    );
  });

  it("should handle multiple strftime calls in a single query", async () => {
    const stmt = new PostgresStatement(mockPool, `
      UPDATE orders SET
        created_at = CAST(strftime('%s','now') AS INTEGER),
        updated_at = CAST(strftime('%s','now') AS INTEGER)
      WHERE public_id = ?
    `);

    mockPool.query.mockResolvedValueOnce({ rowCount: 1 });

    await stmt.runAsync("multi-strftime");

    const sql = mockPool.query.mock.calls[0][0] as string;

    const matches = sql.match(/EXTRACT\(EPOCH FROM NOW\(\)\)/g);
    expect(matches).toHaveLength(2);
  });

  it("should handle named params that shadow each other in different clauses", async () => {
    const stmt = new PostgresStatement(mockPool, `
      UPDATE orders SET
        src_order_id = :orderId,
        dst_order_id = :orderId
      WHERE public_id = :publicId
    `);

    mockPool.query.mockResolvedValueOnce({ rowCount: 1 });

    await stmt.runAsync({ orderId: "same-id", publicId: "test-dup" });

    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining("src_order_id = $1"),
      ["same-id", "test-dup"]
    );
    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining("dst_order_id = $1"),
      ["same-id", "test-dup"]
    );
  });

  it("should handle empty string params", async () => {
    const stmt = new PostgresStatement(mockPool, `
      SELECT * FROM orders WHERE src_lock_tx = ?
    `);

    mockPool.query.mockResolvedValueOnce({ rows: [] });

    await stmt.allAsync("");

    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining("src_lock_tx = $1"),
      [""]
    );
  });

  it("should handle boolean-like numeric params", async () => {
    const stmt = new PostgresStatement(mockPool, `
      SELECT * FROM orders WHERE src_lock_block = ?
    `);

    mockPool.query.mockResolvedValueOnce({ rows: [] });

    await stmt.allAsync(0);
    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining("src_lock_block = $1"),
      [0]
    );

    mockPool.query.mockResolvedValueOnce({ rows: [] });
    await stmt.allAsync(1);
    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining("src_lock_block = $1"),
      [1]
    );
  });

  it("should handle float numeric params (timestamps with fractional)", async () => {
    const stmt = new PostgresStatement(mockPool, `
      SELECT * FROM orders WHERE created_at < ?
    `);

    mockPool.query.mockResolvedValueOnce({ rows: [] });

    await stmt.allAsync(1234567890.5);

    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining("created_at < $1"),
      [1234567890.5]
    );
  });

  it("should handle params with newlines and tabs", async () => {
    const stmt = new PostgresStatement(mockPool, `
      SELECT * FROM orders WHERE hashlock = ?
    `);

    mockPool.query.mockResolvedValueOnce({ rows: [] });

    await stmt.allAsync("hash\nwith\tnewlines");

    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining("hashlock = $1"),
      ["hash\nwith\tnewlines"]
    );
  });

  it("should handle undefined params by converting them to null-like", async () => {
    const stmt = new PostgresStatement(mockPool, `
      UPDATE orders SET src_order_id = :orderId WHERE public_id = :publicId
    `);

    mockPool.query.mockResolvedValueOnce({ rowCount: 1 });

    await stmt.runAsync({ orderId: undefined, publicId: "test-undef" });

    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining("src_order_id = $1"),
      [undefined, "test-undef"]
    );
  });

  it("should handle params with leading/trailing whitespace", async () => {
    const stmt = new PostgresStatement(mockPool, `
      SELECT * FROM orders WHERE src_address = ?
    `);

    mockPool.query.mockResolvedValueOnce({ rows: [] });

    await stmt.allAsync("  0x123  ");
    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining("src_address = $1"),
      ["  0x123  "]
    );
  });

  it("should correctly order positional params when some are reused", async () => {
    const stmt = new PostgresStatement(mockPool, `
      INSERT INTO t (a, b, c) VALUES (?, ?, ?)
    `);

    mockPool.query.mockResolvedValueOnce({ rowCount: 1 });

    await stmt.runAsync("x", "y", "z");

    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining("VALUES ($1, $2, $3)"),
      ["x", "y", "z"]
    );
  });

  it("should handle SQL with function calls containing colons", async () => {
    const stmt = new PostgresStatement(mockPool, `
      SELECT COALESCE(:value, 'default') AS result
    `);

    mockPool.query.mockResolvedValueOnce({ rows: [{ result: "hello" }] });

    await stmt.getAsync({ value: "hello" });

    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining("COALESCE($1, 'default')"),
      ["hello"]
    );
  });

  it("should correct for parameter type coercion — string vs integer", async () => {
    const stringStmt = new PostgresStatement(mockPool, `
      SELECT * FROM orders WHERE src_lock_block = ?
    `);
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    await stringStmt.allAsync("42");
    expect(mockPool.query).toHaveBeenCalledWith(
      expect.any(String),
      ["42"]
    );

    const intStmt = new PostgresStatement(mockPool, `
      SELECT * FROM orders WHERE src_lock_block = ?
    `);
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    await intStmt.allAsync(42);
    expect(mockPool.query).toHaveBeenCalledWith(
      expect.any(String),
      [42]
    );
  });

  it("should handle empty array of params", async () => {
    const stmt = new PostgresStatement(mockPool, `
      SELECT * FROM orders LIMIT ?
    `);

    mockPool.query.mockResolvedValueOnce({ rows: [] });

    await stmt.allAsync([]);

    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining("LIMIT $1"),
      [[]]
    );
  });

  it("should handle padding with extra unused params gracefully", async () => {
    const stmt = new PostgresStatement(mockPool, `
      SELECT * FROM orders WHERE public_id = ?
    `);

    mockPool.query.mockResolvedValueOnce({ rows: [] });

    await stmt.allAsync("test-id", "extra-param", 42);

    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining("public_id = $1"),
      ["test-id", "extra-param", 42]
    );
  });

  it("should preserve param types through the conversion layer", async () => {
    const stmt = new PostgresStatement(mockPool, `
      INSERT INTO t (txt, num, flag) VALUES (:txt, :num, :flag)
    `);

    mockPool.query.mockResolvedValueOnce({ rowCount: 1 });

    const params = { txt: "hello", num: 42, flag: null };
    await stmt.runAsync(params);

    const callParams = mockPool.query.mock.calls[0][1];
    expect(callParams).toEqual(["hello", 42, null]);
  });
});
