import { describe, it, expect, beforeEach } from "vitest";
import {
  buildReplayDecision,
  classifyConflict,
  classifyUnknownOrder,
  ReplayPolicy,
  type ConflictType,
} from "../src/reconciliation/replay-policy.js";
import {
  LedgerCursor,
} from "../src/reconciliation/ledger-cursor.js";
import type { OrderStatus } from "../src/persistence/orders-repo.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function assess(hwm: number, tip: number, lookback = 1_000) {
  const c = new LedgerCursor("ethereum", lookback, hwm);
  return c.assess(tip);
}

// ─────────────────────────────────────────────────────────────────────────────
// buildReplayDecision — window sizing
// ─────────────────────────────────────────────────────────────────────────────

describe("buildReplayDecision — basic fields", () => {
  it("fromBlock == HWM for normal gap", () => {
    const a = assess(1_000, 1_500);
    const d = buildReplayDecision("ethereum", a);
    expect(d.fromBlock).toBe(1_000);
    expect(d.toBlock).toBe(1_500);
    expect(d.chain).toBe("ethereum");
  });

  it("windowSize == toBlock - fromBlock", () => {
    const a = assess(1_000, 1_300);
    const d = buildReplayDecision("ethereum", a);
    expect(d.windowSize).toBe(300);
  });

  it("windowSize == 0 when tip == HWM (no gap)", () => {
    const a = assess(5_000, 5_000);
    const d = buildReplayDecision("ethereum", a);
    expect(d.windowSize).toBe(0);
  });

  it("gapSeverity is propagated from the assessment", () => {
    const normal = buildReplayDecision("ethereum", assess(5_000, 5_500));
    expect(normal.gapSeverity).toBe("normal");

    const large = buildReplayDecision("ethereum", assess(5_000, 6_500));
    expect(large.gapSeverity).toBe("large");

    const exceeded = buildReplayDecision("ethereum", assess(5_000, 10_000));
    expect(exceeded.gapSeverity).toBe("exceeded");
  });

  it("lookbackExceeded is true only for exceeded gaps", () => {
    expect(buildReplayDecision("ethereum", assess(5_000, 5_500)).lookbackExceeded).toBe(false);
    expect(buildReplayDecision("ethereum", assess(5_000, 10_000)).lookbackExceeded).toBe(true);
  });
});

describe("buildReplayDecision — fromBlock fallback when exceeded", () => {
  it("fromBlock falls back to tip - lookback for exceeded gap", () => {
    const lookback = 1_000;
    const hwm = 0;
    const tip = 10_000; // gap = 10000 >> 2 × 1000
    const a = assess(hwm, tip, lookback);
    const d = buildReplayDecision("ethereum", a);
    expect(d.fromBlock).toBe(tip - lookback); // 9000
    expect(d.toBlock).toBe(tip);
    expect(d.lookbackExceeded).toBe(true);
  });

  it("windowSize for exceeded is exactly lookbackWindow", () => {
    const lookback = 500;
    const a = assess(0, 50_000, lookback);
    const d = buildReplayDecision("ethereum", a);
    expect(d.windowSize).toBe(lookback); // 50000 - 49500
  });
});

describe("buildReplayDecision — different chains", () => {
  it("chain field is preserved verbatim", () => {
    const chains = ["ethereum", "soroban", "solana"] as const;
    for (const chain of chains) {
      const d = buildReplayDecision(chain, assess(0, 100));
      expect(d.chain).toBe(chain);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// classifyConflict — already_applied
// ─────────────────────────────────────────────────────────────────────────────

describe("classifyConflict — already_applied", () => {
  it("classifies as already_applied when currentStatus == eventTargetStatus", () => {
    const conflict = classifyConflict({
      chain: "ethereum",
      eventType: "OrderCreated",
      eventTargetStatus: "src_locked",
      currentStatus: "src_locked",
      isTerminal: false,
      publicId: "wf_order1",
    });
    expect(conflict.conflictType).toBe<ConflictType>("already_applied");
    expect(conflict.publicId).toBe("wf_order1");
    expect(conflict.orderStatus).toBe("src_locked");
  });

  it("includes a human-readable description", () => {
    const conflict = classifyConflict({
      chain: "ethereum",
      eventType: "OrderClaimed",
      eventTargetStatus: "secret_revealed",
      currentStatus: "secret_revealed",
      isTerminal: false,
    });
    expect(conflict.description).toContain("already the current");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// classifyConflict — status_ahead
// ─────────────────────────────────────────────────────────────────────────────

describe("classifyConflict — status_ahead (terminal order)", () => {
  const terminalStatuses: OrderStatus[] = ["completed", "refunded", "failed"];

  for (const status of terminalStatuses) {
    it(`classifies as status_ahead for terminal status '${status}'`, () => {
      const conflict = classifyConflict({
        chain: "ethereum",
        eventType: "OrderCreated",
        eventTargetStatus: "src_locked",
        currentStatus: status,
        isTerminal: true,
      });
      expect(conflict.conflictType).toBe<ConflictType>("status_ahead");
    });
  }

  it("classifies as status_ahead when order is completed and event is OrderClaimed", () => {
    const conflict = classifyConflict({
      chain: "soroban",
      eventType: "OrderClaimed",
      eventTargetStatus: "secret_revealed",
      currentStatus: "completed",
      isTerminal: true,
    });
    expect(conflict.conflictType).toBe<ConflictType>("status_ahead");
  });
});

describe("classifyConflict — status_ahead (non-terminal, order ahead)", () => {
  it("classifies as status_ahead when order is dst_locked and event is OrderCreated", () => {
    // dst_locked is ahead of src_locked; the event is stale but not a contradiction.
    const conflict = classifyConflict({
      chain: "ethereum",
      eventType: "OrderCreated",
      eventTargetStatus: "src_locked",
      currentStatus: "dst_locked",
      isTerminal: false,
    });
    expect(conflict.conflictType).toBe<ConflictType>("status_ahead");
  });

  it("classifies OrderCreated + secret_revealed as state_contradiction (order claimed before locked)", () => {
    const conflict = classifyConflict({
      chain: "ethereum",
      eventType: "OrderCreated",
      eventTargetStatus: "src_locked",
      currentStatus: "secret_revealed",
      isTerminal: false,
    });
    expect(conflict.conflictType).toBe<ConflictType>("state_contradiction");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// classifyConflict — state_contradiction
// ─────────────────────────────────────────────────────────────────────────────

describe("classifyConflict — state_contradiction", () => {
  it("classifies OrderRefunded against a completed order as state_contradiction", () => {
    const conflict = classifyConflict({
      chain: "ethereum",
      eventType: "OrderRefunded",
      eventTargetStatus: "refunded",
      currentStatus: "completed",
      isTerminal: true, // completed IS terminal — status_ahead fires first
    });
    // completed is terminal → status_ahead wins
    expect(conflict.conflictType).toBe<ConflictType>("status_ahead");
  });

  it("classifies OrderClaimed when order is refunded as state_contradiction (non-terminal path)", () => {
    const conflict = classifyConflict({
      chain: "ethereum",
      eventType: "OrderClaimed",
      eventTargetStatus: "secret_revealed",
      currentStatus: "refunded",
      isTerminal: false, // force the non-terminal contradiction branch
    });
    expect(conflict.conflictType).toBe<ConflictType>("state_contradiction");
  });

  it("classifies OrderCreated when order is already secret_revealed as state_contradiction", () => {
    const conflict = classifyConflict({
      chain: "soroban",
      eventType: "OrderCreated",
      eventTargetStatus: "src_locked",
      currentStatus: "secret_revealed",
      isTerminal: false,
    });
    expect(conflict.conflictType).toBe<ConflictType>("state_contradiction");
  });

  it("state_contradiction description mentions 'contradiction' or 'operator'", () => {
    const conflict = classifyConflict({
      chain: "ethereum",
      eventType: "OrderClaimed",
      eventTargetStatus: "secret_revealed",
      currentStatus: "refunded",
      isTerminal: false,
    });
    expect(conflict.description.toLowerCase()).toMatch(/contradict|operator|incompatible/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// classifyUnknownOrder
// ─────────────────────────────────────────────────────────────────────────────

describe("classifyUnknownOrder", () => {
  it("returns conflictType=unknown_order", () => {
    const c = classifyUnknownOrder("ethereum", "OrderCreated", "0xhashlock");
    expect(c.conflictType).toBe<ConflictType>("unknown_order");
  });

  it("includes chain and eventType in the result", () => {
    const c = classifyUnknownOrder("solana", "OrderClaimed", "orderId42");
    expect(c.chain).toBe("solana");
    expect(c.eventType).toBe("OrderClaimed");
  });

  it("includes the identifier in the description", () => {
    const id = "0xdeadbeefhashlock";
    const c = classifyUnknownOrder("soroban", "OrderCreated", id);
    expect(c.description).toContain(id);
  });

  it("publicId is undefined (unknown order has no DB row)", () => {
    const c = classifyUnknownOrder("ethereum", "OrderRefunded", "99");
    expect(c.publicId).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ReplayPolicy — accumulation
// ─────────────────────────────────────────────────────────────────────────────

describe("ReplayPolicy — accumulation", () => {
  let policy: ReplayPolicy;

  beforeEach(() => { policy = new ReplayPolicy(); });

  it("starts empty", () => {
    expect(policy.getDecisions()).toHaveLength(0);
    expect(policy.getConflicts()).toHaveLength(0);
  });

  it("recordDecision accumulates decisions", () => {
    const d = buildReplayDecision("ethereum", assess(0, 500));
    policy.recordDecision(d);
    expect(policy.getDecisions()).toHaveLength(1);
    expect(policy.getDecisions()[0]).toBe(d);
  });

  it("recordConflict accumulates conflicts", () => {
    const c = classifyUnknownOrder("ethereum", "OrderCreated", "id1");
    policy.recordConflict(c);
    expect(policy.getConflicts()).toHaveLength(1);
  });

  it("getDecisions() returns a readonly view (array reference)", () => {
    policy.recordDecision(buildReplayDecision("ethereum", assess(0, 100)));
    const decisions = policy.getDecisions();
    expect(Array.isArray(decisions)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ReplayPolicy.getSummary()
// ─────────────────────────────────────────────────────────────────────────────

describe("ReplayPolicy.getSummary()", () => {
  let policy: ReplayPolicy;

  beforeEach(() => { policy = new ReplayPolicy(); });

  it("returns zero chains and zero windowSize when empty", () => {
    const s = policy.getSummary();
    expect(s.chains).toBe(0);
    expect(s.totalWindowSize).toBe(0);
    expect(s.lookbackExceededChains).toBe(0);
    expect(s.forcedResyncs).toBe(0);
  });

  it("counts chains correctly", () => {
    policy.recordDecision(buildReplayDecision("ethereum", assess(0, 100)));
    policy.recordDecision(buildReplayDecision("soroban", assess(0, 200)));
    expect(policy.getSummary().chains).toBe(2);
  });

  it("sums windowSize across chains", () => {
    policy.recordDecision(buildReplayDecision("ethereum", assess(1_000, 1_300))); // 300
    policy.recordDecision(buildReplayDecision("soroban", assess(5_000, 5_700)));  // 700
    expect(policy.getSummary().totalWindowSize).toBe(1_000);
  });

  it("counts lookbackExceededChains", () => {
    policy.recordDecision(buildReplayDecision("ethereum", assess(0, 10_000))); // exceeded
    policy.recordDecision(buildReplayDecision("soroban", assess(0, 100)));     // normal
    expect(policy.getSummary().lookbackExceededChains).toBe(1);
  });

  it("counts conflictsByType correctly", () => {
    policy.recordConflict(classifyUnknownOrder("ethereum", "OrderCreated", "id1"));
    policy.recordConflict(classifyUnknownOrder("ethereum", "OrderCreated", "id2"));
    policy.recordConflict(classifyConflict({
      chain: "ethereum", eventType: "OrderCreated",
      eventTargetStatus: "src_locked", currentStatus: "src_locked",
      isTerminal: false,
    })); // already_applied
    const s = policy.getSummary();
    expect(s.conflictsByType.unknown_order).toBe(2);
    expect(s.conflictsByType.already_applied).toBe(1);
    expect(s.conflictsByType.status_ahead).toBe(0);
    expect(s.conflictsByType.state_contradiction).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ReplayPolicy.reset()
// ─────────────────────────────────────────────────────────────────────────────

describe("ReplayPolicy.reset()", () => {
  it("clears all accumulated decisions and conflicts", () => {
    const policy = new ReplayPolicy();
    policy.recordDecision(buildReplayDecision("ethereum", assess(0, 100)));
    policy.recordConflict(classifyUnknownOrder("ethereum", "OrderCreated", "id"));
    policy.reset();
    expect(policy.getDecisions()).toHaveLength(0);
    expect(policy.getConflicts()).toHaveLength(0);
  });

  it("getSummary() returns zeroes after reset", () => {
    const policy = new ReplayPolicy();
    policy.recordDecision(buildReplayDecision("ethereum", assess(0, 500)));
    policy.reset();
    const s = policy.getSummary();
    expect(s.chains).toBe(0);
    expect(s.totalWindowSize).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// End-to-end: simulate a full reconciler run's decision sequence
// ─────────────────────────────────────────────────────────────────────────────

describe("ReplayPolicy — full run simulation", () => {
  it("correctly summarises a run with three chains, mixed gaps, and several conflicts", () => {
    const policy = new ReplayPolicy();

    // Ethereum: 200-block normal gap.
    policy.recordDecision(buildReplayDecision("ethereum", assess(10_000, 10_200)));

    // Soroban: exceeded gap → lookback window used.
    policy.recordDecision(buildReplayDecision("soroban", assess(0, 100_000, 1_000)));

    // Solana: up to date.
    policy.recordDecision(buildReplayDecision("solana", assess(500_000, 500_000)));

    // Conflicts from event replay:
    policy.recordConflict(classifyUnknownOrder("ethereum", "OrderCreated", "0xhash1"));
    policy.recordConflict(classifyConflict({
      chain: "ethereum", eventType: "OrderClaimed",
      eventTargetStatus: "secret_revealed", currentStatus: "secret_revealed",
      isTerminal: false,
    })); // already_applied
    policy.recordConflict(classifyConflict({
      chain: "soroban", eventType: "OrderCreated",
      eventTargetStatus: "src_locked", currentStatus: "completed",
      isTerminal: true,
    })); // status_ahead

    const s = policy.getSummary();
    expect(s.chains).toBe(3);
    expect(s.lookbackExceededChains).toBe(1); // only Soroban
    expect(s.conflictsByType.unknown_order).toBe(1);
    expect(s.conflictsByType.already_applied).toBe(1);
    expect(s.conflictsByType.status_ahead).toBe(1);
    expect(s.conflictsByType.state_contradiction).toBe(0);
  });
});
