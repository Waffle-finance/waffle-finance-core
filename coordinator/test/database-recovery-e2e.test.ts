/**
 * End-to-end recovery after loss of the coordinator database (issue #1126).
 *
 * The database is a rebuildable cache: on-chain facts can be reconstructed by
 * a bounded replay, but off-chain order metadata cannot. Cached unrevealed
 * secrets may only be restored from the configured secret recovery source
 * after hash validation. This test makes both limits explicit and emits an
 * operator-facing recovery summary.
 */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import pino from "pino";
import { openTestSqlite } from "./helpers/test-db.js";
import { OrdersRepository, type OrderRow, type AnnounceOrderInput } from "../src/persistence/orders-repo.js";
import { OrderService } from "../src/services/order-service.js";
import { SecretReconciler } from "../src/reconciliation/secret-reconciler.js";
import { buildRecoveryReport } from "../src/reconciliation/recovery-summary.js";

const ETH = "0x1111111111111111111111111111111111111111";
const XLM = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422";
const PREIMAGE_A = "0x" + "aa".repeat(32);
const PREIMAGE_C = "0x" + "cc".repeat(32); // intentionally invalid for its hashlock
const hashlockOf = (preimage: string) =>
  "0x" + createHash("sha256").update(Buffer.from(preimage.slice(2), "hex")).digest("hex");

/** Bounded chain replay fixture — everything here is a public on-chain fact. */
interface ChainEvent { id: string; block: number; input: AnnounceOrderInput; srcOrderId: string }

function chainFixtures(): ChainEvent[] {
  return [
    {
      id: "A", block: 9_100,
      input: {
        direction: "eth_to_xlm", hashlock: hashlockOf(PREIMAGE_A), srcChain: "ethereum",
        srcAddress: ETH, srcAsset: "native", srcAmount: "100", srcSafetyDeposit: "1",
        dstChain: "stellar", dstAddress: XLM, dstAsset: "native", dstAmount: "90",
      },
      srcOrderId: "101",
    },
    {
      id: "C", block: 9_101,
      input: {
        direction: "eth_to_xlm", hashlock: hashlockOf("0x" + "ff".repeat(32)), srcChain: "ethereum",
        srcAddress: ETH, srcAsset: "native", srcAmount: "200", srcSafetyDeposit: "2",
        dstChain: "stellar", dstAddress: XLM, dstAsset: "native", dstAmount: "190",
      },
      srcOrderId: "102",
    },
  ];
}

/** Off-chain metadata is NOT on chain and cannot be reconstructed after DB loss. */
const OFF_CHAIN_METADATA: Record<string, { customerRef: string; settlementNote: string }> = {
  A: { customerRef: "customer-A", settlementNote: "netted batch 7" },
};

/** Configured secret recovery source: authorized, hash-validated records only. */
const SECRET_RECOVERY_SOURCE: Record<string, { preimage: string; authorized: boolean }> = {
  "101": { preimage: PREIMAGE_A, authorized: true },
  "102": { preimage: PREIMAGE_C, authorized: false }, // invalid hash AND unauthorized
};

function chainFacts(order: OrderRow) {
  return {
    publicId: order.publicId, hashlock: order.hashlock, srcAmount: order.srcAmount,
    dstAmount: order.dstAmount, srcOrderId: order.srcOrderId, status: order.status,
  };
}

describe("database loss recovery E2E", () => {
  it("rebuilds chain facts, restores only valid authorized secrets, and reports lost metadata", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "wf-db-loss-recovery-"));
    const dbUrl = `file:${dir}/coordinator.db`;
    const fixtures = chainFixtures();
    const logs: string[] = [];
    const log = pino(
      { level: "info" },
      { write: (msg: string) => { logs.push(msg); } },
    );

    // 1. Original database: on-chain facts + off-chain metadata + cached secrets.
    const db = await openTestSqlite(dbUrl.replace(/^file:/, ""));
    const repo = new OrdersRepository(db);
    let original: Record<string, ReturnType<typeof chainFacts>> = {};
    for (const fixture of fixtures) {
      const announced = await repo.announce(fixture.input);
      await repo.recordSrcLock({
        publicId: announced.publicId, orderId: fixture.srcOrderId,
        txHash: `0xlock${fixture.srcOrderId}`, blockNumber: fixture.block, timelock: 9_999_999,
      });
      original[fixture.id] = chainFacts((await repo.findByPublicId(announced.publicId))!);
    }
    await repo.setChainCursor("ethereum", fixtures[fixtures.length - 1]!.block);
    (db as any).close?.();

    // 2. Simulate total database loss.
    expect(existsSync(`${dir}/coordinator.db`)).toBe(true);
    rmSync(`${dir}/coordinator.db`);
    expect(existsSync(`${dir}/coordinator.db`)).toBe(false);

    // 3. Recreate from schema and replay a BOUNDED window of chain events.
    const rebuiltDb = await openTestSqlite(dbUrl.replace(/^file:/, ""));
    const rebuiltRepo = new OrdersRepository(rebuiltDb);
    const replayStart = fixtures[0]!.block;
    const replayEnd = fixtures[fixtures.length - 1]!.block;
    let replayed = 0;
    for (const fixture of fixtures.filter((f) => f.block >= replayStart && f.block <= replayEnd)) {
      const announced = await rebuiltRepo.announce(fixture.input);
      await rebuiltRepo.recordSrcLock({
        publicId: announced.publicId, orderId: fixture.srcOrderId,
        txHash: `0xlock${fixture.srcOrderId}`, blockNumber: fixture.block, timelock: 9_999_999,
      });
      replayed++;
    }
    await rebuiltRepo.setChainCursor("ethereum", replayEnd);
    expect(replayed).toBe(fixtures.length);
    expect(await rebuiltRepo.getChainCursor("ethereum")).toBe(replayEnd);

    const restored: Record<string, ReturnType<typeof chainFacts>> = {};
    for (const fixture of fixtures) {
      const order = await rebuiltRepo.findBySrcOrderId("ethereum", fixture.srcOrderId);
      expect(order).not.toBeNull();
      restored[fixture.id] = chainFacts(order!);
    }
    expect(restored).toEqual(original); // every reconstructable chain fact matches

    // 4. Invoke authorized secret recovery from the configured source.
    const reconciler = new SecretReconciler({} as any, new OrderService(rebuiltRepo, log), log);
    const outcomes: Record<string, string> = {};
    for (const fixture of fixtures) {
      const src = SECRET_RECOVERY_SOURCE[fixture.srcOrderId];
      if (!src?.authorized) continue;
      outcomes[fixture.srcOrderId] = await reconciler._recoverOneOrder(
        fixture.srcOrderId, src.preimage, `0xclaim${fixture.srcOrderId}`,
      );
    }
    expect(outcomes).toEqual({ "101": "recovered" });

    const recoveredA = await rebuiltRepo.findBySrcOrderId("ethereum", "101");
    const unrecoveredC = await rebuiltRepo.findBySrcOrderId("ethereum", "102");
    expect(recoveredA?.preimage).toBe(PREIMAGE_A);
    expect(recoveredA?.status).toBe("secret_revealed");
    expect(unrecoveredC?.preimage).toBeNull(); // invalid/unauthorized secret never persisted
    expect(unrecoveredC?.status).toBe("src_locked");

    // Preimages never appear in logs.
    expect(logs.join("\n")).not.toContain(PREIMAGE_A);
    expect(logs.join("\n")).not.toContain(PREIMAGE_C);

    // 5. Documented operator recovery summary: what came back, what did not.
    const missingMetadata = fixtures
      .filter((f) => !(f.id in OFF_CHAIN_METADATA))
      .map((f) => ({ orderId: restored[f.id]!.publicId, fields: ["customerRef", "settlementNote"] }));
    const summary = {
      ...buildRecoveryReport([{
        chain: "ethereum" as const, hwm: 0, tip: replayEnd, fromBlock: replayStart,
      }]),
      replayedEvents: replayed,
      restoredChainFacts: Object.keys(restored),
      secretRecovery: outcomes,
      unrecoverableSecrets: ["102"],
      missingOffChainMetadata: missingMetadata,
      manualReconstructionRequired: missingMetadata.length > 0,
    };
    console.log(`[recovery-summary] ${JSON.stringify(summary)}`);
    expect(summary.chainSummaries[0]!.outcome).toBe("within_lookback");
    expect(summary.missingOffChainMetadata).toEqual([{
      orderId: restored["C"]!.publicId, fields: ["customerRef", "settlementNote"],
    }]);
    expect(summary.manualReconstructionRequired).toBe(true);

    (rebuiltDb as any).close?.();
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);
});
