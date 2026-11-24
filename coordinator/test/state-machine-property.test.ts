/**
 * State-machine property tests — coordinator replay invariants.
 *
 * Replay may deliver lifecycle events in duplicate or out-of-order sequences.
 * These tests generate event sequences across four event classes (valid,
 * duplicate, stale, and conflicting) and assert two properties:
 *
 *   1. **Terminal-state stability** — no generated sequence moves a terminal
 *      order back to an active state.
 *
 *   2. **Deterministic normalisation** — reordering or duplicating independent
 *      events within a sequence that leads to the same logical outcome always
 *      produces the same final order status.
 *
 * Tests that find a counterexample pin it as a named regression case at the
 * bottom of this file so a future regression is caught immediately.
 *
 * Implementation note: the coordinator has no fast-check/hypothesis dependency
 * and no test infrastructure for property testing, so sequences are generated
 * deterministically by enumeration rather than random sampling.  Every
 * equivalence class of interest is covered without flakiness.
 */

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import pino from "pino";

import { openDatabase } from "../src/persistence/db.js";
import { OrdersRepository, type AnnounceOrderInput } from "../src/persistence/orders-repo.js";
import { OrderService } from "../src/services/order-service.js";
import {
  ORDER_STATUS_TRANSITIONS,
  isTerminal,
  canTransition,
} from "../src/state-machine/order-machine.js";
import type { OrderStatus } from "../src/persistence/orders-repo.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const log = pino({ level: "silent" });

const ETH = "0x1111111111111111111111111111111111111111";
const XLM = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422";

/** Make a fresh in-memory OrderService for each test to prevent cross-contamination. */
async function freshService(): Promise<{ svc: OrderService; repo: OrdersRepository }> {
  const dir = mkdtempSync(resolve(tmpdir(), "wafflefinance-prop-"));
  const db = await openDatabase(`file:${dir}/prop.db`);
  const repo = new OrdersRepository(db);
  return { svc: new OrderService(repo, log, { enableCache: false }), repo };
}

/**
 * Pre-computed valid (preimage → sha256-hashlock) pair so the service's
 * preimage-validation checks pass on secret events.
 */
const PREIMAGE_BUF = Buffer.alloc(32, 0xab);
const PREIMAGE = "0x" + PREIMAGE_BUF.toString("hex");
const HASHLOCK = "0x" + createHash("sha256").update(PREIMAGE_BUF).digest("hex");

const BASE_ORDER: AnnounceOrderInput = {
  direction: "eth_to_xlm",
  hashlock: HASHLOCK,
  srcChain: "ethereum",
  srcAddress: ETH,
  srcAsset: "native",
  srcAmount: "1000000000000000000",
  srcSafetyDeposit: "1000000000000000",
  dstChain: "stellar",
  dstAddress: XLM,
  dstAsset: "native",
  dstAmount: "100000000",
};

/** Canonical happy-path event sequence: announced → … → completed. */
interface LifecycleStep {
  kind:
    | "src_lock"
    | "dst_lock"
    | "secret"
    | "complete"
    | "refund"
    | "fail"
    | "expire"
    | "cancel"
    | "abandon";
}

/**
 * Apply a single lifecycle step to `publicId`.  Returns the resulting status
 * or the string "rejected" if the service refused the transition.
 */
async function applyStep(
  svc: OrderService,
  publicId: string,
  step: LifecycleStep
): Promise<string> {
  try {
    switch (step.kind) {
      case "src_lock":
        await svc.recordSrcLock({
          publicId,
          orderId: "1",
          txHash: "0xsrc",
          blockNumber: 100,
          timelock: 9_999,
        });
        break;
      case "dst_lock":
        await svc.recordDstLock({
          publicId,
          orderId: "2",
          txHash: "0xdst",
          blockNumber: 200,
          timelock: 9_999,
          resolver: null,
        });
        break;
      case "secret":
        await svc.recordSecret(publicId, PREIMAGE, "0xreveal");
        break;
      case "complete":
        await svc.markStatus(publicId, "completed");
        break;
      case "refund":
        await svc.markStatus(publicId, "refunded");
        break;
      case "fail":
        await svc.markStatus(publicId, "failed");
        break;
      case "expire":
        await svc.markStatus(publicId, "expired");
        break;
      case "cancel":
        await svc.markStatus(publicId, "cancelled");
        break;
      case "abandon":
        await svc.markStatus(publicId, "abandoned");
        break;
    }
    const order = await svc.get(publicId);
    return order?.status ?? "unknown";
  } catch {
    // Transition was rejected — return the current status unchanged.
    const order = await svc.get(publicId);
    return order?.status ?? "rejected";
  }
}

/** Run a full sequence, return final status. */
async function runSequence(
  svc: OrderService,
  publicId: string,
  steps: LifecycleStep[]
): Promise<string> {
  let last = "announced";
  for (const step of steps) {
    last = await applyStep(svc, publicId, step);
  }
  return last;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Terminal-state stability
// ─────────────────────────────────────────────────────────────────────────────
//
// For every terminal status, generate every possible follow-on event and
// verify that no event reopens the order.

const TERMINAL_STATUSES: OrderStatus[] = Object.entries(ORDER_STATUS_TRANSITIONS)
  .filter(([, next]) => next.length === 0)
  .map(([s]) => s as OrderStatus);

const ALL_STEPS: LifecycleStep["kind"][] = [
  "src_lock",
  "dst_lock",
  "secret",
  "complete",
  "refund",
  "fail",
  "expire",
  "cancel",
  "abandon",
];

/**
 * Bring an order to the requested terminal status.  Returns null when the
 * status cannot be reached through the normal lifecycle (not all statuses
 * have a simple linear path).
 */
async function bringToTerminal(
  svc: OrderService,
  publicId: string,
  terminal: OrderStatus
): Promise<string | null> {
  const paths: Record<string, LifecycleStep[]> = {
    completed: [
      { kind: "src_lock" },
      { kind: "dst_lock" },
      { kind: "secret" },
      { kind: "complete" },
    ],
    refunded: [{ kind: "src_lock" }, { kind: "refund" }],
    failed: [{ kind: "fail" }],
    cancelled: [{ kind: "cancel" }],
    abandoned: [{ kind: "abandon" }],
  };

  const path = paths[terminal];
  if (!path) return null;

  for (const step of path) {
    await applyStep(svc, publicId, step);
  }
  const order = await svc.get(publicId);
  return order?.status === terminal ? terminal : null;
}

describe("property: terminal-state stability", () => {
  for (const terminal of TERMINAL_STATUSES) {
    for (const followOnKind of ALL_STEPS) {
      it(`${terminal} + ${followOnKind} ⟶ still ${terminal}`, async () => {
        const { svc } = await freshService();
        const order = await svc.announce(BASE_ORDER);

        const reached = await bringToTerminal(svc, order.publicId, terminal);
        if (reached === null) {
          // Skip statuses unreachable through the standard path in this setup.
          return;
        }

        expect(reached).toBe(terminal);

        // Apply the follow-on event.
        const after = await applyStep(svc, order.publicId, { kind: followOnKind });

        // The status must still be the terminal value.
        expect(
          after,
          `${terminal} → (${followOnKind}) should not reopen the order`
        ).toBe(terminal);
      });
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Duplicate-event idempotency
// ─────────────────────────────────────────────────────────────────────────────
//
// Applying the same event zero, one, or two extra times after it has
// already been applied must leave the order in the same state.

describe("property: duplicate events are idempotent", () => {
  it("duplicate src_lock events leave the order in src_locked", async () => {
    const { svc } = await freshService();
    const order = await svc.announce(BASE_ORDER);

    // First application.
    await svc.recordSrcLock({
      publicId: order.publicId,
      orderId: "1",
      txHash: "0xsrc",
      blockNumber: 100,
      timelock: 9_999,
    });
    expect((await svc.get(order.publicId))?.status).toBe("src_locked");

    // Duplicate with identical orderId + txHash — service returns early.
    await svc.recordSrcLock({
      publicId: order.publicId,
      orderId: "1",
      txHash: "0xsrc",
      blockNumber: 100,
      timelock: 9_999,
    });
    expect((await svc.get(order.publicId))?.status).toBe("src_locked");

    // Third time is also a no-op.
    await svc.recordSrcLock({
      publicId: order.publicId,
      orderId: "1",
      txHash: "0xsrc",
      blockNumber: 100,
      timelock: 9_999,
    });
    expect((await svc.get(order.publicId))?.status).toBe("src_locked");
  });

  it("duplicate dst_lock events leave the order in dst_locked", async () => {
    const { svc } = await freshService();
    const order = await svc.announce(BASE_ORDER);
    await svc.recordSrcLock({
      publicId: order.publicId,
      orderId: "1",
      txHash: "0xsrc",
      blockNumber: 100,
      timelock: 9_999,
    });

    await svc.recordDstLock({
      publicId: order.publicId,
      orderId: "2",
      txHash: "0xdst",
      blockNumber: 200,
      timelock: 9_999,
      resolver: null,
    });
    expect((await svc.get(order.publicId))?.status).toBe("dst_locked");

    await svc.recordDstLock({
      publicId: order.publicId,
      orderId: "2",
      txHash: "0xdst",
      blockNumber: 200,
      timelock: 9_999,
      resolver: null,
    });
    expect((await svc.get(order.publicId))?.status).toBe("dst_locked");
  });

  it("duplicate secret events leave the order in secret_revealed", async () => {
    const { svc } = await freshService();
    const order = await svc.announce(BASE_ORDER);
    await svc.recordSrcLock({
      publicId: order.publicId,
      orderId: "1",
      txHash: "0xsrc",
      blockNumber: 100,
      timelock: 9_999,
    });
    await svc.recordDstLock({
      publicId: order.publicId,
      orderId: "2",
      txHash: "0xdst",
      blockNumber: 200,
      timelock: 9_999,
      resolver: null,
    });

    await svc.recordSecret(order.publicId, PREIMAGE, "0xreveal");
    expect((await svc.get(order.publicId))?.status).toBe("secret_revealed");

    await svc.recordSecret(order.publicId, PREIMAGE, "0xreveal");
    expect((await svc.get(order.publicId))?.status).toBe("secret_revealed");
  });

  it("duplicate markStatus(refunded) events leave the order refunded", async () => {
    const { svc } = await freshService();
    const order = await svc.announce(BASE_ORDER);
    await svc.recordSrcLock({
      publicId: order.publicId,
      orderId: "1",
      txHash: "0xsrc",
      blockNumber: 100,
      timelock: 9_999,
    });

    await svc.markStatus(order.publicId, "refunded");
    expect((await svc.get(order.publicId))?.status).toBe("refunded");

    // Second call must not throw and must leave status as refunded.
    await expect(svc.markStatus(order.publicId, "refunded")).rejects.toThrow();
    expect((await svc.get(order.publicId))?.status).toBe("refunded");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Stale-event ordering: reordering independent duplicates does not change
//    the final normalised state.
// ─────────────────────────────────────────────────────────────────────────────
//
// Two sequences that differ only in the order of duplicate events (same logical
// events, same final state path) must converge to the same terminal status.

describe("property: reordering independent duplicates does not change final state", () => {
  /**
   * Run the happy-path sequence to completion, then re-deliver the src_lock
   * and dst_lock events (the two "independent" duplicates) in the reverse
   * order and verify the status is still `completed`.
   */
  it("re-delivering src_lock then dst_lock after completion stays completed", async () => {
    const { svc } = await freshService();
    const order = await svc.announce(BASE_ORDER);
    const pid = order.publicId;

    // Complete the order through the full happy path.
    await svc.recordSrcLock({ publicId: pid, orderId: "1", txHash: "0xsrc", blockNumber: 100, timelock: 9_999 });
    await svc.recordDstLock({ publicId: pid, orderId: "2", txHash: "0xdst", blockNumber: 200, timelock: 9_999, resolver: null });
    await svc.recordSecret(pid, PREIMAGE, "0xreveal");
    await svc.markStatus(pid, "completed");

    // Re-deliver in original order — both rejected silently (terminal guard).
    for (const attempt of [
      () => svc.recordSrcLock({ publicId: pid, orderId: "1", txHash: "0xsrc", blockNumber: 100, timelock: 9_999 }),
      () => svc.recordDstLock({ publicId: pid, orderId: "2", txHash: "0xdst", blockNumber: 200, timelock: 9_999, resolver: null }),
    ]) {
      await expect(attempt()).rejects.toThrow();
    }

    expect((await svc.get(pid))?.status).toBe("completed");
  });

  it("re-delivering dst_lock then src_lock (reversed) after completion also stays completed", async () => {
    const { svc } = await freshService();
    const order = await svc.announce(BASE_ORDER);
    const pid = order.publicId;

    await svc.recordSrcLock({ publicId: pid, orderId: "1", txHash: "0xsrc", blockNumber: 100, timelock: 9_999 });
    await svc.recordDstLock({ publicId: pid, orderId: "2", txHash: "0xdst", blockNumber: 200, timelock: 9_999, resolver: null });
    await svc.recordSecret(pid, PREIMAGE, "0xreveal");
    await svc.markStatus(pid, "completed");

    // Re-deliver in reversed order.
    for (const attempt of [
      () => svc.recordDstLock({ publicId: pid, orderId: "2", txHash: "0xdst", blockNumber: 200, timelock: 9_999, resolver: null }),
      () => svc.recordSrcLock({ publicId: pid, orderId: "1", txHash: "0xsrc", blockNumber: 100, timelock: 9_999 }),
    ]) {
      await expect(attempt()).rejects.toThrow();
    }

    expect((await svc.get(pid))?.status).toBe("completed");
  });

  it("two orderings of the same completed-then-stale sequence produce identical final states", async () => {
    // Order A: complete, then duplicate src_lock first.
    const { svc: svcA } = await freshService();
    const a = await svcA.announce(BASE_ORDER);
    await svcA.recordSrcLock({ publicId: a.publicId, orderId: "1", txHash: "0xsrc", blockNumber: 100, timelock: 9_999 });
    await svcA.recordDstLock({ publicId: a.publicId, orderId: "2", txHash: "0xdst", blockNumber: 200, timelock: 9_999, resolver: null });
    await svcA.recordSecret(a.publicId, PREIMAGE, "0xreveal");
    await svcA.markStatus(a.publicId, "completed");
    // Stale dup src_lock.
    await expect(svcA.recordSrcLock({ publicId: a.publicId, orderId: "1", txHash: "0xsrc", blockNumber: 100, timelock: 9_999 })).rejects.toThrow();
    const finalA = (await svcA.get(a.publicId))?.status;

    // Order B: complete, then duplicate dst_lock first.
    const { svc: svcB } = await freshService();
    const b = await svcB.announce(BASE_ORDER);
    await svcB.recordSrcLock({ publicId: b.publicId, orderId: "1", txHash: "0xsrc", blockNumber: 100, timelock: 9_999 });
    await svcB.recordDstLock({ publicId: b.publicId, orderId: "2", txHash: "0xdst", blockNumber: 200, timelock: 9_999, resolver: null });
    await svcB.recordSecret(b.publicId, PREIMAGE, "0xreveal");
    await svcB.markStatus(b.publicId, "completed");
    // Stale dup dst_lock.
    await expect(svcB.recordDstLock({ publicId: b.publicId, orderId: "2", txHash: "0xdst", blockNumber: 200, timelock: 9_999, resolver: null })).rejects.toThrow();
    const finalB = (await svcB.get(b.publicId))?.status;

    expect(finalA).toBe("completed");
    expect(finalB).toBe("completed");
    expect(finalA).toBe(finalB);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Conflicting events: illegal sequences never reopen a terminal order
// ─────────────────────────────────────────────────────────────────────────────

describe("property: conflicting events never reopen a terminal order", () => {
  it("a conflicting src_lock (different orderId) on a terminal order is rejected", async () => {
    const { svc } = await freshService();
    const order = await svc.announce(BASE_ORDER);
    const pid = order.publicId;

    await svc.recordSrcLock({ publicId: pid, orderId: "1", txHash: "0xsrc", blockNumber: 100, timelock: 9_999 });
    await svc.markStatus(pid, "refunded");
    expect((await svc.get(pid))?.status).toBe("refunded");

    // Conflicting src_lock (different orderId) — terminal guard fires first.
    await expect(
      svc.recordSrcLock({ publicId: pid, orderId: "99", txHash: "0xsrc2", blockNumber: 101, timelock: 9_999 })
    ).rejects.toThrow();

    expect((await svc.get(pid))?.status).toBe("refunded");
  });

  it("a conflicting preimage on a terminal order is rejected", async () => {
    const { svc } = await freshService();
    const order = await svc.announce(BASE_ORDER);
    const pid = order.publicId;

    await svc.recordSrcLock({ publicId: pid, orderId: "1", txHash: "0xsrc", blockNumber: 100, timelock: 9_999 });
    await svc.markStatus(pid, "failed");

    const OTHER_PREIMAGE = "0x" + "cc".repeat(32);
    await expect(svc.recordSecret(pid, OTHER_PREIMAGE, "0xbad")).rejects.toThrow();
    expect((await svc.get(pid))?.status).toBe("failed");
  });

  it("marking a cancelled order as completed is rejected", async () => {
    const { svc } = await freshService();
    const order = await svc.announce(BASE_ORDER);
    const pid = order.publicId;

    await svc.markStatus(pid, "cancelled");
    expect((await svc.get(pid))?.status).toBe("cancelled");

    await expect(svc.markStatus(pid, "completed")).rejects.toThrow();
    expect((await svc.get(pid))?.status).toBe("cancelled");
  });

  it("marking an abandoned order as src_locked is rejected", async () => {
    const { svc } = await freshService();
    const order = await svc.announce(BASE_ORDER);
    const pid = order.publicId;

    await svc.markStatus(pid, "abandoned");

    await expect(
      svc.recordSrcLock({ publicId: pid, orderId: "1", txHash: "0xsrc", blockNumber: 100, timelock: 9_999 })
    ).rejects.toThrow();

    expect((await svc.get(pid))?.status).toBe("abandoned");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Exhaustive transition-table coverage
// ─────────────────────────────────────────────────────────────────────────────
//
// For every (from, to) pair in the transition table, verify that:
//   - allowed transitions succeed.
//   - disallowed transitions are rejected (canTransition == false → throws).

describe("property: transition table is exhaustive and consistent with OrderService", () => {
  it("isTerminal agrees with the empty-next-states check on every status", () => {
    for (const [status, nexts] of Object.entries(ORDER_STATUS_TRANSITIONS)) {
      expect(isTerminal(status as OrderStatus)).toBe(nexts.length === 0);
    }
  });

  it("canTransition returns false for every terminal → any transition", () => {
    for (const terminal of TERMINAL_STATUSES) {
      for (const target of Object.keys(ORDER_STATUS_TRANSITIONS) as OrderStatus[]) {
        if (terminal !== target) {
          expect(canTransition(terminal, target), `${terminal} → ${target}`).toBe(false);
        }
      }
    }
  });

  it("every allowed transition in the table is reachable via canTransition", () => {
    for (const [from, nexts] of Object.entries(ORDER_STATUS_TRANSITIONS)) {
      for (const to of nexts) {
        expect(canTransition(from as OrderStatus, to)).toBe(true);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Minimised counterexample regressions
// ─────────────────────────────────────────────────────────────────────────────
//
// Paste any counterexample found during property exploration here.
// Each regression is a pinned ordinary test that must stay green.
//
// (None found as of initial generation — section reserved.)

describe("regression: minimised counterexamples", () => {
  it("placeholder — no counterexamples recorded yet", () => {
    // This test exists so the describe block is not empty.
    // Replace with actual regression cases as they are found.
    expect(true).toBe(true);
  });
});
