import { describe, it, expect, beforeEach } from "vitest";
import {
  ethEventKey,
  sorobanEventKey,
  solanaEventKey,
  semanticKey,
  EventSeenSet,
  type ConflictKind,
} from "../src/reconciliation/event-identity.js";

// ─────────────────────────────────────────────────────────────────────────────
// Key builders — determinism and uniqueness
// ─────────────────────────────────────────────────────────────────────────────

describe("ethEventKey", () => {
  it("is deterministic for the same inputs", () => {
    const k1 = ethEventKey("OrderCreated", "0xabc", 0);
    const k2 = ethEventKey("OrderCreated", "0xabc", 0);
    expect(k1).toBe(k2);
  });

  it("differs by event type", () => {
    const k1 = ethEventKey("OrderCreated", "0xabc", 0);
    const k2 = ethEventKey("OrderClaimed", "0xabc", 0);
    expect(k1).not.toBe(k2);
  });

  it("differs by tx hash", () => {
    const k1 = ethEventKey("OrderCreated", "0xabc", 0);
    const k2 = ethEventKey("OrderCreated", "0xdef", 0);
    expect(k1).not.toBe(k2);
  });

  it("differs by log index", () => {
    const k1 = ethEventKey("OrderCreated", "0xabc", 0);
    const k2 = ethEventKey("OrderCreated", "0xabc", 1);
    expect(k1).not.toBe(k2);
  });

  it("normalises tx hash to lowercase", () => {
    const lower = ethEventKey("OrderCreated", "0xABCDEF", 0);
    const upper = ethEventKey("OrderCreated", "0xabcdef", 0);
    expect(lower).toBe(upper);
  });

  it("includes chain prefix 'eth:'", () => {
    expect(ethEventKey("OrderCreated", "0xabc", 0)).toMatch(/^eth:/);
  });

  it("two events in same tx with different log indices are distinct", () => {
    const keys = [0, 1, 2, 3].map((i) => ethEventKey("OrderCreated", "0xabc", i));
    const unique = new Set(keys);
    expect(unique.size).toBe(4);
  });
});

describe("sorobanEventKey", () => {
  it("is deterministic", () => {
    const k1 = sorobanEventKey("OrderCreated", "txhash", 1000, 0);
    const k2 = sorobanEventKey("OrderCreated", "txhash", 1000, 0);
    expect(k1).toBe(k2);
  });

  it("differs by ledger", () => {
    const k1 = sorobanEventKey("OrderCreated", "txhash", 1000, 0);
    const k2 = sorobanEventKey("OrderCreated", "txhash", 1001, 0);
    expect(k1).not.toBe(k2);
  });

  it("differs by event index within the ledger", () => {
    const k1 = sorobanEventKey("OrderCreated", "txhash", 1000, 0);
    const k2 = sorobanEventKey("OrderCreated", "txhash", 1000, 1);
    expect(k1).not.toBe(k2);
  });

  it("includes chain prefix 'soroban:'", () => {
    expect(sorobanEventKey("OrderClaimed", "txhash", 1000, 0)).toMatch(/^soroban:/);
  });
});

describe("solanaEventKey", () => {
  it("is deterministic", () => {
    const k1 = solanaEventKey("OrderCreated", "sig123");
    const k2 = solanaEventKey("OrderCreated", "sig123");
    expect(k1).toBe(k2);
  });

  it("differs by signature", () => {
    const k1 = solanaEventKey("OrderCreated", "sig1");
    const k2 = solanaEventKey("OrderCreated", "sig2");
    expect(k1).not.toBe(k2);
  });

  it("differs by event type", () => {
    const k1 = solanaEventKey("OrderCreated", "sig1");
    const k2 = solanaEventKey("OrderClaimed", "sig1");
    expect(k1).not.toBe(k2);
  });

  it("includes chain prefix 'solana:'", () => {
    expect(solanaEventKey("OrderRefunded", "sig1")).toMatch(/^solana:/);
  });
});

describe("semanticKey", () => {
  it("is deterministic", () => {
    const k1 = semanticKey("ethereum", "OrderCreated", "0xAABBCCDD");
    const k2 = semanticKey("ethereum", "OrderCreated", "0xAABBCCDD");
    expect(k1).toBe(k2);
  });

  it("normalises identifier to lowercase", () => {
    const lower = semanticKey("ethereum", "OrderCreated", "0xAABB");
    const upper = semanticKey("ethereum", "OrderCreated", "0xaabb");
    expect(lower).toBe(upper);
  });

  it("differs by chain", () => {
    const eth = semanticKey("ethereum", "OrderCreated", "id1");
    const sol = semanticKey("solana", "OrderCreated", "id1");
    expect(eth).not.toBe(sol);
  });

  it("differs by event type", () => {
    const c = semanticKey("ethereum", "OrderCreated", "id1");
    const cl = semanticKey("ethereum", "OrderClaimed", "id1");
    expect(c).not.toBe(cl);
  });

  it("differs by identifier", () => {
    const k1 = semanticKey("ethereum", "OrderCreated", "0xaaaa");
    const k2 = semanticKey("ethereum", "OrderCreated", "0xbbbb");
    expect(k1).not.toBe(k2);
  });

  it("includes 'semantic:' prefix", () => {
    expect(semanticKey("soroban", "OrderClaimed", "id")).toMatch(/^semantic:/);
  });
});

describe("key uniqueness across chains (no cross-chain collisions)", () => {
  it("eth and soroban keys never collide", () => {
    // Use the same hash string as both txHash and hashlock
    const eth = ethEventKey("OrderCreated", "0xabc", 0);
    const sor = sorobanEventKey("OrderCreated", "0xabc", 0, 0);
    expect(eth).not.toBe(sor);
  });

  it("solana and ethereum semantic keys never collide", () => {
    const eSem = semanticKey("ethereum", "OrderCreated", "0xabc");
    const sSem = semanticKey("solana", "OrderCreated", "0xabc");
    expect(eSem).not.toBe(sSem);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// EventSeenSet — basic operations
// ─────────────────────────────────────────────────────────────────────────────

describe("EventSeenSet — basic operations", () => {
  let seen: EventSeenSet;

  beforeEach(() => { seen = new EventSeenSet(); });

  it("returns null (no conflict) for the first occurrence of a key", () => {
    const result = seen.checkAndMark(
      "ethereum", "OrderCreated",
      "eth:OrderCreated:0xabc:0",
      "semantic:ethereum:OrderCreated:0xabc"
    );
    expect(result).toBeNull();
  });

  it("returns a duplicate conflict on the exact same key", () => {
    const key = "eth:OrderCreated:0xabc:0";
    const sem = "semantic:ethereum:OrderCreated:0xabc";
    seen.checkAndMark("ethereum", "OrderCreated", key, sem);
    const conflict = seen.checkAndMark("ethereum", "OrderCreated", key, sem);
    expect(conflict).not.toBeNull();
    expect(conflict!.kind).toBe<ConflictKind>("duplicate");
    expect(conflict!.chain).toBe("ethereum");
    expect(conflict!.eventType).toBe("OrderCreated");
    expect(conflict!.key).toBe(key);
  });

  it("returns a reordered conflict for same semKey but different dedup key", () => {
    const sem = "semantic:ethereum:OrderClaimed:0xorderId";
    // First occurrence.
    seen.checkAndMark("ethereum", "OrderClaimed", "eth:OrderClaimed:0xtx1:0", sem);
    // Second occurrence — same semantic identity, different tx (fork scenario).
    const conflict = seen.checkAndMark("ethereum", "OrderClaimed", "eth:OrderClaimed:0xtx2:0", sem);
    expect(conflict).not.toBeNull();
    expect(conflict!.kind).toBe<ConflictKind>("reordered");
  });

  it("has() returns false before an event is seen", () => {
    expect(seen.has("some-key")).toBe(false);
  });

  it("has() returns true after an event is seen", () => {
    const key = "eth:OrderCreated:0xabc:0";
    seen.checkAndMark("ethereum", "OrderCreated", key, "sem");
    expect(seen.has(key)).toBe(true);
  });

  it("size() reflects the number of unique dedup keys", () => {
    seen.checkAndMark("ethereum", "OrderCreated", "key1", "sem1");
    seen.checkAndMark("ethereum", "OrderCreated", "key2", "sem2");
    expect(seen.size()).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// EventSeenSet — stats tracking
// ─────────────────────────────────────────────────────────────────────────────

describe("EventSeenSet — stats", () => {
  let seen: EventSeenSet;

  beforeEach(() => { seen = new EventSeenSet(); });

  it("seen count increments for new events only", () => {
    seen.checkAndMark("ethereum", "OrderCreated", "k1", "s1");
    seen.checkAndMark("ethereum", "OrderCreated", "k2", "s2");
    expect(seen.getStats().seen).toBe(2);
  });

  it("duplicates count increments for exact key replays", () => {
    seen.checkAndMark("ethereum", "OrderCreated", "k1", "s1");
    seen.checkAndMark("ethereum", "OrderCreated", "k1", "s1"); // dup
    seen.checkAndMark("ethereum", "OrderCreated", "k1", "s1"); // dup again
    expect(seen.getStats().duplicates).toBe(2);
  });

  it("reordered count increments for semantic-only collisions", () => {
    const sem = "sem:reorder";
    seen.checkAndMark("solana", "OrderCreated", "key-tx1", sem);
    seen.checkAndMark("solana", "OrderCreated", "key-tx2", sem); // reordered
    expect(seen.getStats().reordered).toBe(1);
  });

  it("stats are independent (seen ≠ dup ≠ reordered)", () => {
    // 2 new, 1 dup, 1 reordered
    seen.checkAndMark("ethereum", "OrderCreated", "k1", "s1");
    seen.checkAndMark("ethereum", "OrderCreated", "k2", "s2");
    seen.checkAndMark("ethereum", "OrderCreated", "k1", "s1"); // dup of k1
    seen.checkAndMark("ethereum", "OrderCreated", "k3", "s2"); // reordered (same sem as k2)

    const stats = seen.getStats();
    expect(stats.seen).toBe(2);
    expect(stats.duplicates).toBe(1);
    expect(stats.reordered).toBe(1);
  });

  it("getStats() returns a snapshot, not a live reference", () => {
    seen.checkAndMark("ethereum", "OrderCreated", "k1", "s1");
    const snap = seen.getStats();
    seen.checkAndMark("ethereum", "OrderCreated", "k2", "s2");
    // snap.seen should still be 1
    expect(snap.seen).toBe(1);
    expect(seen.getStats().seen).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// EventSeenSet — clear()
// ─────────────────────────────────────────────────────────────────────────────

describe("EventSeenSet.clear()", () => {
  it("resets all keys so previously seen events are treated as new", () => {
    const seen = new EventSeenSet();
    seen.checkAndMark("ethereum", "OrderCreated", "k1", "s1");
    seen.clear();
    const result = seen.checkAndMark("ethereum", "OrderCreated", "k1", "s1");
    expect(result).toBeNull(); // no conflict after clear
  });

  it("resets stats to zero", () => {
    const seen = new EventSeenSet();
    seen.checkAndMark("ethereum", "OrderCreated", "k1", "s1");
    seen.checkAndMark("ethereum", "OrderCreated", "k1", "s1"); // dup
    seen.clear();
    const stats = seen.getStats();
    expect(stats.seen).toBe(0);
    expect(stats.duplicates).toBe(0);
    expect(stats.reordered).toBe(0);
  });

  it("size() returns 0 after clear", () => {
    const seen = new EventSeenSet();
    seen.checkAndMark("ethereum", "OrderCreated", "k1", "s1");
    seen.clear();
    expect(seen.size()).toBe(0);
  });

  it("allows re-adding the same semantic key after clear without reorder conflict", () => {
    const seen = new EventSeenSet();
    const sem = "semantic:ethereum:OrderCreated:0xhashlock";
    seen.checkAndMark("ethereum", "OrderCreated", "key-tx1", sem);
    seen.clear();
    seen.checkAndMark("ethereum", "OrderCreated", "key-tx2", sem); // different key, same sem
    // After clear, this should be treated as a new event, not a reorder.
    expect(seen.has("key-tx2")).toBe(true);
    expect(seen.getStats().reordered).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// EventSeenSet — idempotency contract
// ─────────────────────────────────────────────────────────────────────────────

describe("EventSeenSet — idempotency", () => {
  it("calling checkAndMark N times with the same key produces N-1 duplicate conflicts", () => {
    const seen = new EventSeenSet();
    const key = "eth:OrderCreated:0xabcdef:0";
    const sem = "semantic:ethereum:OrderCreated:0xhashlock";
    const CALLS = 10;
    let conflicts = 0;
    for (let i = 0; i < CALLS; i++) {
      const c = seen.checkAndMark("ethereum", "OrderCreated", key, sem);
      if (c !== null) conflicts++;
    }
    expect(conflicts).toBe(CALLS - 1);
    expect(seen.getStats().duplicates).toBe(CALLS - 1);
  });

  it("per-run isolation: clear between runs prevents run N's events blocking run N+1", () => {
    const seen = new EventSeenSet();
    const key = "eth:OrderCreated:0xabcdef:0";
    const sem = "semantic:ethereum:OrderCreated:0xhashlock";

    // Run 1: mark event.
    seen.checkAndMark("ethereum", "OrderCreated", key, sem);
    expect(seen.getStats().seen).toBe(1);

    // Run 2: clear first, then same event appears again (overlapping window).
    seen.clear();
    const result = seen.checkAndMark("ethereum", "OrderCreated", key, sem);
    expect(result).toBeNull(); // treated as new in run 2
    expect(seen.getStats().seen).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cross-chain scenarios
// ─────────────────────────────────────────────────────────────────────────────

describe("EventSeenSet — cross-chain dedup", () => {
  it("same logical identifier on different chains produces no conflict", () => {
    const seen = new EventSeenSet();
    const hashlock = "0xdeadbeef";

    // Ethereum OrderCreated
    const ethKey = ethEventKey("OrderCreated", "0xtx1", 0);
    const ethSem = semanticKey("ethereum", "OrderCreated", hashlock);
    const r1 = seen.checkAndMark("ethereum", "OrderCreated", ethKey, ethSem);

    // Soroban OrderCreated — same hashlock, different chain
    const sorKey = sorobanEventKey("OrderCreated", "txhash_sor", 100, 0);
    const sorSem = semanticKey("soroban", "OrderCreated", hashlock);
    const r2 = seen.checkAndMark("soroban", "OrderCreated", sorKey, sorSem);

    expect(r1).toBeNull();
    expect(r2).toBeNull(); // no conflict — different chains
  });

  it("different event types for the same order on the same chain are independent", () => {
    const seen = new EventSeenSet();
    const orderId = "42";

    const createdKey = ethEventKey("OrderCreated", "0xtx1", 0);
    const createdSem = semanticKey("ethereum", "OrderCreated", orderId);
    const claimedKey = ethEventKey("OrderClaimed", "0xtx2", 0);
    const claimedSem = semanticKey("ethereum", "OrderClaimed", orderId);

    const r1 = seen.checkAndMark("ethereum", "OrderCreated", createdKey, createdSem);
    const r2 = seen.checkAndMark("ethereum", "OrderClaimed", claimedKey, claimedSem);

    expect(r1).toBeNull();
    expect(r2).toBeNull();
  });
});
