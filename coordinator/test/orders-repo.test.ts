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

// ── #310: recordSecretRevealed idempotence ────────────────────────────────────

describe("OrdersRepository.recordSecretRevealed", () => {
  const PREIMAGE = "0x" + "aa".repeat(32);
  const TX = "0xreveal";

  it("transitions dst_locked -> secret_revealed and persists the preimage", async () => {
    const repo = await freshRepo();
    const order = await announce(repo);
    await repo.recordSrcLock({ publicId: order.publicId, ...SRC_LOCK });
    await repo.recordDstLock({ publicId: order.publicId, ...DST_LOCK });

    await repo.recordSecretRevealed({ publicId: order.publicId, preimage: PREIMAGE, txHash: TX });

    const updated = await repo.findByPublicId(order.publicId);
    expect(updated!.status).toBe("secret_revealed");
    expect(updated!.preimage).toBe(PREIMAGE);
    expect(updated!.secretRevealedTx).toBe(TX);
  });

  it("is idempotent — same preimage delivered twice leaves the order unchanged", async () => {
    const repo = await freshRepo();
    const order = await announce(repo);
    await repo.recordSrcLock({ publicId: order.publicId, ...SRC_LOCK });
    await repo.recordDstLock({ publicId: order.publicId, ...DST_LOCK });

    await repo.recordSecretRevealed({ publicId: order.publicId, preimage: PREIMAGE, txHash: TX });
    await repo.recordSecretRevealed({ publicId: order.publicId, preimage: PREIMAGE, txHash: "0xreplay" });

    const updated = await repo.findByPublicId(order.publicId);
    expect(updated!.status).toBe("secret_revealed");
    expect(updated!.preimage).toBe(PREIMAGE);
    // txHash must not have been overwritten by the replay
    expect(updated!.secretRevealedTx).toBe(TX);
  });

  it.each(TERMINAL_STATUSES)(
    "is a full no-op for terminal order in status %s",
    async (status) => {
      const repo = await freshRepo();
      const order = await announce(repo);
      await repo.setStatus(order.publicId, status);

      await repo.recordSecretRevealed({ publicId: order.publicId, preimage: PREIMAGE, txHash: TX });

      const updated = await repo.findByPublicId(order.publicId);
      expect(updated!.status).toBe(status);
      expect(updated!.preimage).toBeNull();
    }
  );

  it("does nothing for an unknown order", async () => {
    const repo = await freshRepo();
    await expect(
      repo.recordSecretRevealed({ publicId: "no-such-order", preimage: PREIMAGE, txHash: TX })
    ).resolves.toBeUndefined();
  });
});

// ── #310: durable transition event trail ─────────────────────────────────────

describe("OrdersRepository — transition event trail", () => {
  it("appends a transitioned event when src lock advances the order", async () => {
    const repo = await freshRepo();
    const order = await announce(repo);

    await repo.recordSrcLock({ publicId: order.publicId, ...SRC_LOCK, actor: "eth-listener" });

    const events = await repo.findTransitionEvents(order.publicId);
    expect(events.length).toBeGreaterThanOrEqual(1);
    const ev = events.find((e) => e.eventType === "src_lock.transitioned");
    expect(ev).toBeDefined();
    expect(ev!.payload.fromStatus).toBe("announced");
    expect(ev!.payload.toStatus).toBe("src_locked");
    expect(ev!.payload.actor).toBe("eth-listener");
    expect(ev!.payload.outcome).toBe("transitioned");
  });

  it("appends a no_op event (terminal) when a terminal order receives a replayed lock", async () => {
    const repo = await freshRepo();
    const order = await announce(repo);
    await repo.setStatus(order.publicId, "completed");

    await repo.recordSrcLock({ publicId: order.publicId, ...SRC_LOCK });

    const events = await repo.findTransitionEvents(order.publicId);
    const noOp = events.find((e) => e.eventType === "src_lock.no_op");
    expect(noOp).toBeDefined();
    expect(noOp!.payload.outcome).toBe("no_op:terminal");
  });

  it("appends a no_op:idempotent event when the same preimage is delivered twice", async () => {
    const repo = await freshRepo();
    const order = await announce(repo);
    await repo.recordSrcLock({ publicId: order.publicId, ...SRC_LOCK });
    await repo.recordDstLock({ publicId: order.publicId, ...DST_LOCK });

    const PREIMAGE = "0x" + "bb".repeat(32);
    await repo.recordSecretRevealed({ publicId: order.publicId, preimage: PREIMAGE, txHash: "0x1" });
    await repo.recordSecretRevealed({ publicId: order.publicId, preimage: PREIMAGE, txHash: "0x2" });

    const events = await repo.findTransitionEvents(order.publicId);
    const idempotent = events.find(
      (e) => e.eventType === "secret_revealed.no_op" && e.payload.outcome === "no_op:idempotent"
    );
    expect(idempotent).toBeDefined();
  });

  it("records a status.transitioned event for setStatus calls", async () => {
    const repo = await freshRepo();
    const order = await announce(repo);

    await repo.setStatus(order.publicId, "failed", "operator");

    const events = await repo.findTransitionEvents(order.publicId);
    const ev = events.find((e) => e.eventType === "status.transitioned");
    expect(ev).toBeDefined();
    expect(ev!.payload.fromStatus).toBe("announced");
    expect(ev!.payload.toStatus).toBe("failed");
    expect(ev!.payload.actor).toBe("operator");
  });

  it("returns empty array for an order with no recorded events", async () => {
    const repo = await freshRepo();
    const events = await repo.findTransitionEvents("wf_0x" + "00".repeat(32));
    expect(events).toHaveLength(0);
  });
});

// ── #568: setStatus distinguishes NOT_FOUND vs STALE_STATUS ──────────────────

describe("OrdersRepository.setStatus — NOT_FOUND vs STALE_STATUS (#568)", () => {
  it("throws with code=NOT_FOUND when the order does not exist", async () => {
    const repo = await freshRepo();
    const err = await repo
      .setStatus("wf_nonexistent_order_id", "failed")
      .catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as any).code).toBe("NOT_FOUND");
    expect(err.message).toMatch(/not found/i);
  });

  it("throws with code=STALE_STATUS when the order exists but expectedStatus does not match", async () => {
    const repo = await freshRepo();
    const order = await announce(repo);
    // The order is in "announced" — expect "src_locked" which is wrong
    const err = await repo
      .setStatus(order.publicId, "failed", "system", "src_locked")
      .catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as any).code).toBe("STALE_STATUS");
    expect((err as any).currentStatus).toBe("announced");
    expect(err.message).toMatch(/src_locked/);
  });

  it("succeeds when expectedStatus matches the current status", async () => {
    const repo = await freshRepo();
    const order = await announce(repo);
    // order starts as "announced" — update with matching expected status
    await expect(
      repo.setStatus(order.publicId, "failed", "system", "announced")
    ).resolves.toBeUndefined();
    const updated = await repo.findByPublicId(order.publicId);
    expect(updated!.status).toBe("failed");
  });

  it("succeeds unconditionally (no expectedStatus) when the order exists", async () => {
    const repo = await freshRepo();
    const order = await announce(repo);
    await expect(
      repo.setStatus(order.publicId, "completed")
    ).resolves.toBeUndefined();
    const updated = await repo.findByPublicId(order.publicId);
    expect(updated!.status).toBe("completed");
  });

  it("throws NOT_FOUND (not STALE_STATUS) when order does not exist even with expectedStatus", async () => {
    const repo = await freshRepo();
    const err = await repo
      .setStatus("wf_no_such_order", "completed", "system", "announced")
      .catch((e) => e);
    expect((err as any).code).toBe("NOT_FOUND");
  });
});

describe("OrdersRepository per-order cursors (TD-043)", () => {
  it("updates and retrieves per-order cursors correctly", async () => {
    const repo = await freshRepo();
    const order = await announce(repo);

    expect(order.lastEthBlock).toBeNull();
    expect(order.lastSorobanLedger).toBeNull();
    expect(order.lastSolanaSlot).toBeNull();

    await repo.updateOrderCursor(order.publicId, "ethereum", 100);
    await repo.updateOrderCursor(order.publicId, "stellar", 500);
    await repo.updateOrderCursor(order.publicId, "solana", 1200);

    const updated = await repo.findByPublicId(order.publicId);
    expect(updated!.lastEthBlock).toBe(100);
    expect(updated!.lastSorobanLedger).toBe(500);
    expect(updated!.lastSolanaSlot).toBe(1200);
  });

  it("only advances per-order cursor forward (monotonic)", async () => {
    const repo = await freshRepo();
    const order = await announce(repo);

    await repo.updateOrderCursor(order.publicId, "ethereum", 200);
    await repo.updateOrderCursor(order.publicId, "ethereum", 150); // lower value ignored

    const updated = await repo.findByPublicId(order.publicId);
    expect(updated!.lastEthBlock).toBe(200);
  });

  it("computes min active order cursor across active orders and ignores terminal orders", async () => {
    const repo = await freshRepo();
    const o1 = await repo.announce(BASE_ORDER);
    const o2 = await repo.announce({
      ...BASE_ORDER,
      hashlock: "0x" + "c".repeat(64)
    });

    await repo.updateOrderCursor(o1.publicId, "ethereum", 100);
    await repo.updateOrderCursor(o2.publicId, "ethereum", 150);

    let min = await repo.getMinActiveOrderCursor("ethereum");
    expect(min).toBe(100);

    // Mark o1 as completed (terminal)
    await repo.setStatus(o1.publicId, "completed");

    min = await repo.getMinActiveOrderCursor("ethereum");
    expect(min).toBe(150);
  });
});
