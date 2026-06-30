import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/persistence/db.js";
import {
  OrdersRepository,
  type AnnounceOrderInput,
  type OrderRow,
  type OrderStatus
} from "../src/persistence/orders-repo.js";

const VALID_HASHLOCK = "0x" + "b".repeat(64);
const VALID_ETH_ADDR = "0x2222222222222222222222222222222222222222";
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

async function freshRepo() {
  const dir = mkdtempSync(resolve(tmpdir(), "wafflefinance-repo-test-"));
  const db = await openDatabase(`file:${dir}/test.db`);
  return new OrdersRepository(db);
}

const SRC_LOCK = {
  orderId: "src-1",
  txHash: "0xsrc",
  blockNumber: 10,
  timelock: 1000
};

const DST_LOCK = {
  orderId: "dst-1",
  txHash: "0xdst",
  blockNumber: 20,
  timelock: 2000,
  resolver: VALID_ETH_ADDR
};

// Matches order-machine `isTerminal`: states with no outgoing transitions.
// `expired` is deliberately NOT here — it can still transition to refunded/failed.
const TERMINAL_STATUSES: OrderStatus[] = ["completed", "refunded", "failed"];

async function announce(repo: OrdersRepository): Promise<OrderRow> {
  return repo.announce(BASE_ORDER);
}

describe("OrdersRepository.announce", () => {
  it("derives the public order id from the canonical hashlock", async () => {
    const repo = await freshRepo();
    const order = await repo.announce({
      ...BASE_ORDER,
      hashlock: "0x" + "A".repeat(64)
    });

    expect(order.publicId).toBe(`wf_${"0x" + "a".repeat(64)}`);
  });
});

describe("OrdersRepository.recordSrcLock", () => {
  it("transitions announced -> src_locked and records lock fields", async () => {
    const repo = await freshRepo();
    const order = await announce(repo);

    await repo.recordSrcLock({ publicId: order.publicId, ...SRC_LOCK });

    const updated = await repo.findByPublicId(order.publicId);
    expect(updated!.status).toBe("src_locked");
    expect(updated!.srcOrderId).toBe(SRC_LOCK.orderId);
    expect(updated!.srcLockTx).toBe(SRC_LOCK.txHash);
    expect(updated!.srcLockBlock).toBe(SRC_LOCK.blockNumber);
    expect(updated!.srcTimelock).toBe(SRC_LOCK.timelock);
  });

  it("is a status no-op when the order has already advanced past src_locked", async () => {
    const repo = await freshRepo();
    const order = await announce(repo);
    await repo.recordSrcLock({ publicId: order.publicId, ...SRC_LOCK });
    await repo.recordDstLock({ publicId: order.publicId, ...DST_LOCK });

    await repo.recordSrcLock({
      publicId: order.publicId,
      orderId: "src-2",
      txHash: "0xsrc2",
      blockNumber: 11,
      timelock: 1001
    });

    const updated = await repo.findByPublicId(order.publicId);
    // status must not regress from dst_locked back to src_locked
    expect(updated!.status).toBe("dst_locked");
    // but the lock fields are still refreshed
    expect(updated!.srcOrderId).toBe("src-2");
  });

  it("repeated calls in src_locked stay src_locked (idempotent)", async () => {
    const repo = await freshRepo();
    const order = await announce(repo);
    await repo.recordSrcLock({ publicId: order.publicId, ...SRC_LOCK });
    await repo.recordSrcLock({ publicId: order.publicId, ...SRC_LOCK });

    const updated = await repo.findByPublicId(order.publicId);
    expect(updated!.status).toBe("src_locked");
  });

  it.each(TERMINAL_STATUSES)(
    "is a full no-op for terminal order in status %s",
    async (status) => {
      const repo = await freshRepo();
      const order = await announce(repo);
      await repo.setStatus(order.publicId, status);

      await repo.recordSrcLock({ publicId: order.publicId, ...SRC_LOCK });

      const updated = await repo.findByPublicId(order.publicId);
      expect(updated!.status).toBe(status);
      // no lock fields were written
      expect(updated!.srcOrderId).toBeNull();
      expect(updated!.srcLockTx).toBeNull();
    }
  );

  it("keeps an expired order in expired (never src_locked)", async () => {
    const repo = await freshRepo();
    const order = await announce(repo);
    await repo.setStatus(order.publicId, "expired");

    await repo.recordSrcLock({ publicId: order.publicId, ...SRC_LOCK });

    const updated = await repo.findByPublicId(order.publicId);
    expect(updated!.status).toBe("expired");
  });

  it("does nothing for an unknown order", async () => {
    const repo = await freshRepo();
    await expect(
      repo.recordSrcLock({ publicId: "does-not-exist", ...SRC_LOCK })
    ).resolves.toBeUndefined();
  });
});

describe("OrdersRepository.recordDstLock", () => {
  it("transitions src_locked -> dst_locked and records lock fields", async () => {
    const repo = await freshRepo();
    const order = await announce(repo);
    await repo.recordSrcLock({ publicId: order.publicId, ...SRC_LOCK });

    await repo.recordDstLock({ publicId: order.publicId, ...DST_LOCK });

    const updated = await repo.findByPublicId(order.publicId);
    expect(updated!.status).toBe("dst_locked");
    expect(updated!.dstOrderId).toBe(DST_LOCK.orderId);
    expect(updated!.dstLockTx).toBe(DST_LOCK.txHash);
    expect(updated!.resolverAddress).toBe(DST_LOCK.resolver);
  });

  it("does NOT move announced directly to dst_locked (not a valid transition)", async () => {
    const repo = await freshRepo();
    const order = await announce(repo);

    await repo.recordDstLock({ publicId: order.publicId, ...DST_LOCK });

    const updated = await repo.findByPublicId(order.publicId);
    // state machine forbids announced -> dst_locked, status is kept
    expect(updated!.status).toBe("announced");
  });

  it("repeated calls in dst_locked stay dst_locked (idempotent)", async () => {
    const repo = await freshRepo();
    const order = await announce(repo);
    await repo.recordSrcLock({ publicId: order.publicId, ...SRC_LOCK });
    await repo.recordDstLock({ publicId: order.publicId, ...DST_LOCK });
    await repo.recordDstLock({ publicId: order.publicId, ...DST_LOCK });

    const updated = await repo.findByPublicId(order.publicId);
    expect(updated!.status).toBe("dst_locked");
  });

  it.each(TERMINAL_STATUSES)(
    "repeated recordDstLock does not move terminal order %s into dst_locked",
    async (status) => {
      const repo = await freshRepo();
      const order = await announce(repo);
      await repo.recordSrcLock({ publicId: order.publicId, ...SRC_LOCK });
      await repo.setStatus(order.publicId, status);

      await repo.recordDstLock({ publicId: order.publicId, ...DST_LOCK });

      const updated = await repo.findByPublicId(order.publicId);
      expect(updated!.status).toBe(status);
      // no dst lock fields were written
      expect(updated!.dstOrderId).toBeNull();
      expect(updated!.dstLockTx).toBeNull();
    }
  );

  it("keeps an expired order in expired (never dst_locked)", async () => {
    const repo = await freshRepo();
    const order = await announce(repo);
    await repo.recordSrcLock({ publicId: order.publicId, ...SRC_LOCK });
    await repo.setStatus(order.publicId, "expired");

    await repo.recordDstLock({ publicId: order.publicId, ...DST_LOCK });

    const updated = await repo.findByPublicId(order.publicId);
    expect(updated!.status).toBe("expired");
  });

  it("does nothing for an unknown order", async () => {
    const repo = await freshRepo();
    await expect(
      repo.recordDstLock({ publicId: "does-not-exist", ...DST_LOCK })
    ).resolves.toBeUndefined();
  });
});
