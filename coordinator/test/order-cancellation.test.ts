import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/persistence/db.js";
import {
  OrdersRepository,
  type AnnounceOrderInput,
} from "../src/persistence/orders-repo.js";
import { isTerminal, canTransition } from "../src/state-machine/order-machine.js";

const VALID_ETH_ADDR = "0x4444444444444444444444444444444444444444";
const VALID_STELLAR_ADDR = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422";

const BASE_ORDER: AnnounceOrderInput = {
  direction: "eth_to_xlm",
  hashlock: "0x" + "d".repeat(64),
  srcChain: "ethereum",
  srcAddress: VALID_ETH_ADDR,
  srcAsset: "native",
  srcAmount: "1000000000000000000",
  srcSafetyDeposit: "1000000000000000",
  dstChain: "stellar",
  dstAddress: VALID_STELLAR_ADDR,
  dstAsset: "native",
  dstAmount: "100000000",
};

async function freshRepo() {
  const dir = mkdtempSync(resolve(tmpdir(), "wafflefinance-cancel-test-"));
  const db = await openDatabase(`file:${dir}/test.db`);
  return new OrdersRepository(db);
}

function hashlock(n: number) {
  return "0x" + String(n).padStart(2, "0").repeat(32);
}

// ── State machine ─────────────────────────────────────────────────────────────

describe("order-machine: cancelled and abandoned are terminal", () => {
  it("isTerminal returns true for cancelled", () => {
    expect(isTerminal("cancelled")).toBe(true);
  });

  it("isTerminal returns true for abandoned", () => {
    expect(isTerminal("abandoned")).toBe(true);
  });

  it("announced can transition to cancelled", () => {
    expect(canTransition("announced", "cancelled")).toBe(true);
  });

  it("announced can transition to abandoned", () => {
    expect(canTransition("announced", "abandoned")).toBe(true);
  });

  it("src_locked cannot transition to cancelled", () => {
    expect(canTransition("src_locked", "cancelled")).toBe(false);
  });

  it("src_locked cannot transition to abandoned", () => {
    expect(canTransition("src_locked", "abandoned")).toBe(false);
  });
});

// ── cancelOrder ───────────────────────────────────────────────────────────────

describe("OrdersRepository.cancelOrder", () => {
  it("transitions an announced order to cancelled with the supplied reason", async () => {
    const repo = await freshRepo();
    const order = await repo.announce({ ...BASE_ORDER, hashlock: hashlock(1) });

    await repo.cancelOrder(order.publicId, "user_requested");

    const updated = await repo.findByPublicId(order.publicId);
    expect(updated!.status).toBe("cancelled");
    expect(updated!.cancellationReason).toBe("user_requested");
    expect(updated!.archivedAt).toBeNull();
  });

  it("records a transition event for cancelled", async () => {
    const repo = await freshRepo();
    const order = await repo.announce({ ...BASE_ORDER, hashlock: hashlock(2) });

    await repo.cancelOrder(order.publicId, "operator_requested", "operator");

    const events = await repo.findTransitionEvents(order.publicId);
    const cancelEvent = events.find((e) => e.eventType === "cancel.transitioned");
    expect(cancelEvent).toBeDefined();
    expect(cancelEvent!.payload.fromStatus).toBe("announced");
    expect(cancelEvent!.payload.toStatus).toBe("cancelled");
    expect(cancelEvent!.payload.reason).toBe("operator_requested");
    expect(cancelEvent!.payload.actor).toBe("operator");
  });

  it("throws NOT_FOUND when the order does not exist", async () => {
    const repo = await freshRepo();
    await expect(repo.cancelOrder("wf_nonexistent", "user_requested")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("throws INVALID_TRANSITION when order is past announced (src_locked)", async () => {
    const repo = await freshRepo();
    const order = await repo.announce({ ...BASE_ORDER, hashlock: hashlock(3) });
    await repo.recordSrcLock({
      publicId: order.publicId,
      orderId: "src-1",
      txHash: "0xabc",
      blockNumber: 10,
      timelock: Math.floor(Date.now() / 1000) + 3600,
    });

    await expect(repo.cancelOrder(order.publicId, "user_requested")).rejects.toMatchObject({
      code: "INVALID_TRANSITION",
    });
  });

  it("is a no-op on a terminal order (completed)", async () => {
    const repo = await freshRepo();
    const order = await repo.announce({ ...BASE_ORDER, hashlock: hashlock(4) });
    await repo.setStatus(order.publicId, "completed");

    await repo.cancelOrder(order.publicId, "user_requested");

    const unchanged = await repo.findByPublicId(order.publicId);
    expect(unchanged!.status).toBe("completed");
  });
});

// ── abandonOrder ─────────────────────────────────────────────────────────────

describe("OrdersRepository.abandonOrder", () => {
  it("transitions an announced order to abandoned and archives it", async () => {
    const repo = await freshRepo();
    const order = await repo.announce({ ...BASE_ORDER, hashlock: hashlock(5) });

    await repo.abandonOrder(order.publicId, "stale:no_src_lock");

    const updated = await repo.findByPublicId(order.publicId);
    expect(updated!.status).toBe("abandoned");
    expect(updated!.cancellationReason).toBe("stale:no_src_lock");
    expect(updated!.archivedAt).not.toBeNull();
  });

  it("records a transition event for abandoned", async () => {
    const repo = await freshRepo();
    const order = await repo.announce({ ...BASE_ORDER, hashlock: hashlock(6) });

    await repo.abandonOrder(order.publicId, "stale:no_src_lock", "stale-cleanup");

    const events = await repo.findTransitionEvents(order.publicId);
    const evt = events.find((e) => e.eventType === "abandon.transitioned");
    expect(evt).toBeDefined();
    expect(evt!.payload.fromStatus).toBe("announced");
    expect(evt!.payload.toStatus).toBe("abandoned");
    expect(evt!.payload.reason).toBe("stale:no_src_lock");
    expect(evt!.payload.actor).toBe("stale-cleanup");
  });

  it("silently skips orders that cannot be abandoned (e.g. src_locked)", async () => {
    const repo = await freshRepo();
    const order = await repo.announce({ ...BASE_ORDER, hashlock: hashlock(7) });
    await repo.recordSrcLock({
      publicId: order.publicId,
      orderId: "src-2",
      txHash: "0xdef",
      blockNumber: 20,
      timelock: Math.floor(Date.now() / 1000) + 3600,
    });

    await repo.abandonOrder(order.publicId, "stale:no_src_lock");

    const unchanged = await repo.findByPublicId(order.publicId);
    expect(unchanged!.status).toBe("src_locked");
    expect(unchanged!.cancellationReason).toBeNull();
  });

  it("silently skips a missing order", async () => {
    const repo = await freshRepo();
    await expect(repo.abandonOrder("wf_nonexistent", "stale:no_src_lock")).resolves.toBeUndefined();
  });

  it("is a no-op on a terminal order (failed)", async () => {
    const repo = await freshRepo();
    const order = await repo.announce({ ...BASE_ORDER, hashlock: hashlock(8) });
    await repo.setStatus(order.publicId, "failed");

    await repo.abandonOrder(order.publicId, "stale:no_src_lock");

    const unchanged = await repo.findByPublicId(order.publicId);
    expect(unchanged!.status).toBe("failed");
    expect(unchanged!.cancellationReason).toBeNull();
  });
});
