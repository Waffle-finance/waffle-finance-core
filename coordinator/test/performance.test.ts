import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/persistence/db.js";
import {
  OrdersRepository,
  type AnnounceOrderInput
} from "../src/persistence/orders-repo.js";

const VALID_HASHLOCK_BASE = "0x" + "a".repeat(60);
const VALID_ETH_ADDR = "0x1111111111111111111111111111111111111111";
const OTHER_ADDR = "0x2222222222222222222222222222222222222222";
const VALID_STELLAR_ADDR = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422";

async function freshRepo() {
  const dir = mkdtempSync(resolve(tmpdir(), "wafflefinance-perf-test-"));
  const db = await openDatabase(`file:${dir}/test.db`);
  return new OrdersRepository(db);
}

describe("OrdersRepository Performance", () => {
  it("measures findByAddress latency with many orders", async () => {
    const repo = await freshRepo();
    const count = 1000;
    
    const startInsert = Date.now();
    for (let i = 0; i < count; i++) {
      const input: AnnounceOrderInput = {
        direction: "eth_to_xlm",
        hashlock: VALID_HASHLOCK_BASE + i.toString(16).padStart(4, '0'),
        srcChain: "ethereum",
        srcAddress: i % 2 === 0 ? VALID_ETH_ADDR : OTHER_ADDR,
        srcAsset: "native",
        srcAmount: "1000000000000000000",
        srcSafetyDeposit: "1000000000000000",
        dstChain: "stellar",
        dstAddress: VALID_STELLAR_ADDR,
        dstAsset: "native",
        dstAmount: "100000000"
      };
      await repo.announce(input);
    }
    const insertDuration = Date.now() - startInsert;
    console.log(`Insertion of ${count} orders took ${insertDuration}ms`);

    // Warm up
    await repo.findByAddress(VALID_ETH_ADDR);

    const startQuery = performance.now();
    const results = await repo.findByAddress(VALID_ETH_ADDR, 50, 0);
    const endQuery = performance.now();

    console.log(`Query for ${VALID_ETH_ADDR} took ${(endQuery - startQuery).toFixed(4)}ms`);
    expect(results.length).toBe(50);
    
    // Guardrail to avoid regressions: the optimized UNION query should be fast
    expect(endQuery - startQuery).toBeLessThan(50);
    
    // Verify indexes exist
    // @ts-ignore - access private db for verification
    const db = repo.db;
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all();
    const indexNames = indexes.map((idx: any) => idx.name);
    
    expect(indexNames).toContain("idx_orders_src_address_created_at");
    expect(indexNames).toContain("idx_orders_dst_address_created_at");
    expect(indexNames).toContain("idx_orders_created_at");
    expect(indexNames).toContain("idx_orders_public_id");
  });
});
