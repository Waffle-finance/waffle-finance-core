import { describe, it, expect, vi, afterEach } from "vitest";
import { resolve } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/persistence/db.js";
import { OrdersRepository, type AnnounceOrderInput } from "../src/persistence/orders-repo.js";
import { StaleCleanupService } from "../src/services/stale-cleanup.js";
import pino from "pino";

const VALID_HASHLOCK = "0x" + "c".repeat(64);
const VALID_ETH_ADDR = "0x3333333333333333333333333333333333333333";
const VALID_STELLAR_ADDR = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422";

const BASE_ORDER: AnnounceOrderInput = {
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
};

const nullLog = pino({ level: "silent" });

async function freshRepo() {
  const dir = mkdtempSync(resolve(tmpdir(), "wafflefinance-cleanup-test-"));
  const db = await openDatabase(`file:${dir}/test.db`);
  return new OrdersRepository(db);
}

/** Force a row's created_at to be older than the retention window. */
async function backdateOrder(repo: OrdersRepository, publicId: string, ageSeconds: number) {
  const cutoff = Math.floor(Date.now() / 1000) - ageSeconds;
  const db = (repo as any).db;
  db.prepare(
    "UPDATE orders SET created_at = ? WHERE public_id = ?"
  ).run(cutoff - 1, publicId);
}

describe("StaleCleanupService", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("archives announced orders older than the retention window with no src lock", async () => {
    const repo = await freshRepo();
    const order = await repo.announce({ ...BASE_ORDER, hashlock: "0x" + "a1".repeat(32) });

    // Backdate the order so it appears 31 days old (> 30-day retention).
    await backdateOrder(repo, order.publicId, 31 * 24 * 60 * 60);

    const svc = new StaleCleanupService(repo, nullLog, 30);
    const result = await svc.run();

    expect(result.archivedCount).toBe(1);

    const updated = await repo.findByPublicId(order.publicId);
    expect(updated!.archivedAt).not.toBeNull();
    expect(updated!.status).toBe("announced"); // status unchanged
  });

  it("does not archive orders younger than the retention window", async () => {
    const repo = await freshRepo();
    await repo.announce({ ...BASE_ORDER, hashlock: "0x" + "a2".repeat(32) });
    // No backdating — order is brand new.

    const svc = new StaleCleanupService(repo, nullLog, 30);
    const result = await svc.run();

    expect(result.archivedCount).toBe(0);
  });

  it("does not archive orders that have a source lock (src_order_id set)", async () => {
    const repo = await freshRepo();
    const order = await repo.announce({ ...BASE_ORDER, hashlock: "0x" + "a3".repeat(32) });
    await backdateOrder(repo, order.publicId, 31 * 24 * 60 * 60);

    // Record a source lock so the order is no longer orphaned.
    await repo.recordSrcLock({
      publicId: order.publicId,
      orderId: "src-order-99",
      txHash: "0xabc",
      blockNumber: 100,
      timelock: Math.floor(Date.now() / 1000) + 3600
    });

    const svc = new StaleCleanupService(repo, nullLog, 30);
    const result = await svc.run();

    expect(result.archivedCount).toBe(0);

    const unchanged = await repo.findByPublicId(order.publicId);
    expect(unchanged!.archivedAt).toBeNull();
  });

  it("does not archive orders that are already archived", async () => {
    const repo = await freshRepo();
    const order = await repo.announce({ ...BASE_ORDER, hashlock: "0x" + "a4".repeat(32) });
    await backdateOrder(repo, order.publicId, 31 * 24 * 60 * 60);

    // Run once to archive.
    const svc = new StaleCleanupService(repo, nullLog, 30);
    const first = await svc.run();
    expect(first.archivedCount).toBe(1);

    // Running again should find nothing new to archive.
    const second = await svc.run();
    expect(second.archivedCount).toBe(0);
  });

  it("respects batch size and leaves remaining stale orders for the next run", async () => {
    const repo = await freshRepo();

    // Create 5 stale orders.
    for (let i = 0; i < 5; i++) {
      const order = await repo.announce({
        ...BASE_ORDER,
        hashlock: "0x" + String(i).padStart(2, "0").repeat(32)
      });
      await backdateOrder(repo, order.publicId, 31 * 24 * 60 * 60);
    }

    // batchSize = 3: only 3 should be archived per run.
    const svc = new StaleCleanupService(repo, nullLog, 30, 3);
    const first = await svc.run();
    expect(first.archivedCount).toBe(3);

    const second = await svc.run();
    expect(second.archivedCount).toBe(2);

    const third = await svc.run();
    expect(third.archivedCount).toBe(0);
  });

  it("does not archive orders in non-announced states even if old", async () => {
    const repo = await freshRepo();
    const order = await repo.announce({ ...BASE_ORDER, hashlock: "0x" + "a5".repeat(32) });
    await backdateOrder(repo, order.publicId, 31 * 24 * 60 * 60);

    // Advance the order past 'announced'.
    await repo.setStatus(order.publicId, "failed");

    const svc = new StaleCleanupService(repo, nullLog, 30);
    const result = await svc.run();

    expect(result.archivedCount).toBe(0);
    const unchanged = await repo.findByPublicId(order.publicId);
    expect(unchanged!.archivedAt).toBeNull();
  });

  it("increments metrics counters on each run", async () => {
    const { staleCleanupRuns, staleOrdersArchived } = await import("../src/metrics.js");

    const runsBefore = (await staleCleanupRuns.get()).values.find(
      (v) => v.labels.result === "success"
    )?.value ?? 0;
    const archivedBefore = (await staleOrdersArchived.get()).values[0]?.value ?? 0;

    const repo = await freshRepo();
    const order = await repo.announce({ ...BASE_ORDER, hashlock: "0x" + "a6".repeat(32) });
    await backdateOrder(repo, order.publicId, 31 * 24 * 60 * 60);

    const svc = new StaleCleanupService(repo, nullLog, 30);
    await svc.run();

    const runsAfter = (await staleCleanupRuns.get()).values.find(
      (v) => v.labels.result === "success"
    )?.value ?? 0;
    const archivedAfter = (await staleOrdersArchived.get()).values[0]?.value ?? 0;

    expect(runsAfter).toBe(runsBefore + 1);
    expect(archivedAfter).toBe(archivedBefore + 1);
  });
});
