/**
 * Tests for bounded memory structures in listener-state.ts
 * (issue: memory hygiene and long-running stability).
 *
 * Covers:
 *  - BoundedSet: cap enforcement, eviction order, dedup behaviour
 *  - BoundedMap: cap enforcement, value update, eviction order
 *  - TimedEvictionMap: TTL expiry, lazy eviction, purge()
 *  - RetryContextStore: record / remove / exhaustion / purgeStale
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  BoundedSet,
  BoundedMap,
  TimedEvictionMap,
  RetryContextStore,
} from "../src/listener-state.js";

// ── BoundedSet ────────────────────────────────────────────────────────────────

describe("BoundedSet", () => {
  it("throws RangeError for maxSize < 1", () => {
    expect(() => new BoundedSet(0)).toThrow(RangeError);
    expect(() => new BoundedSet(-1)).toThrow(RangeError);
  });

  it("accepts entries up to maxSize without eviction", () => {
    const s = new BoundedSet<string>(3);
    s.add("a");
    s.add("b");
    s.add("c");
    expect(s.size).toBe(3);
    expect(s.has("a") && s.has("b") && s.has("c")).toBe(true);
  });

  it("evicts the oldest entry when maxSize is exceeded", () => {
    const s = new BoundedSet<string>(3);
    s.add("a");
    s.add("b");
    s.add("c");
    s.add("d"); // 'a' should be evicted
    expect(s.has("a")).toBe(false);
    expect(s.has("d")).toBe(true);
    expect(s.size).toBe(3);
  });

  it("does not double-count or evict on re-adding an existing entry", () => {
    const s = new BoundedSet<string>(3);
    s.add("a");
    s.add("b");
    s.add("a"); // re-add 'a' — no eviction, no size change
    expect(s.size).toBe(2);
    s.add("c"); // should not evict 'a' since size is still 2
    expect(s.has("a")).toBe(true);
    expect(s.has("b")).toBe(true);
    expect(s.has("c")).toBe(true);
  });

  it("delete removes an entry and allows re-insertion without eviction", () => {
    const s = new BoundedSet<string>(2);
    s.add("a");
    s.add("b");
    s.delete("a");
    s.add("c"); // should not evict 'b' since we're at size 1 after delete
    expect(s.has("b")).toBe(true);
    expect(s.has("c")).toBe(true);
    expect(s.size).toBe(2);
  });

  it("clear empties the set", () => {
    const s = new BoundedSet<number>(5);
    [1, 2, 3].forEach((n) => s.add(n));
    s.clear();
    expect(s.size).toBe(0);
    expect(s.has(1)).toBe(false);
  });

  it("is iterable in insertion order", () => {
    const s = new BoundedSet<string>(10);
    ["c", "a", "b"].forEach((k) => s.add(k));
    expect([...s]).toEqual(["c", "a", "b"]);
  });

  it("eviction is FIFO — oldest-inserted entry is evicted first", () => {
    const s = new BoundedSet<number>(3);
    // Insert in order 1, 2, 3 — then overflow with 4, 5.
    [1, 2, 3, 4, 5].forEach((n) => s.add(n));
    expect(s.has(1)).toBe(false);
    expect(s.has(2)).toBe(false);
    expect(s.has(3)).toBe(true);
    expect(s.has(4)).toBe(true);
    expect(s.has(5)).toBe(true);
  });
});

// ── BoundedMap ────────────────────────────────────────────────────────────────

describe("BoundedMap", () => {
  it("throws RangeError for maxSize < 1", () => {
    expect(() => new BoundedMap(0)).toThrow(RangeError);
  });

  it("stores and retrieves values", () => {
    const m = new BoundedMap<string, number>(5);
    m.set("x", 42);
    expect(m.get("x")).toBe(42);
  });

  it("evicts the oldest entry when maxSize is exceeded", () => {
    const m = new BoundedMap<string, number>(2);
    m.set("a", 1);
    m.set("b", 2);
    m.set("c", 3); // 'a' evicted
    expect(m.has("a")).toBe(false);
    expect(m.get("b")).toBe(2);
    expect(m.get("c")).toBe(3);
  });

  it("updating an existing key updates the value but does not add a new slot", () => {
    const m = new BoundedMap<string, number>(2);
    m.set("a", 1);
    m.set("b", 2);
    // Updating "a" in-place: size stays 2, value changes, no new slot consumed.
    m.set("a", 99);
    expect(m.size).toBe(2);
    expect(m.get("a")).toBe(99);
    expect(m.get("b")).toBe(2);
    // Next insert overflows the cap: oldest-inserted key ("a") is evicted.
    m.set("c", 3);
    expect(m.has("a")).toBe(false);
    expect(m.get("b")).toBe(2);
    expect(m.get("c")).toBe(3);
  });

  it("delete removes a key and frees a slot", () => {
    const m = new BoundedMap<string, number>(2);
    m.set("a", 1);
    m.set("b", 2);
    m.delete("a");
    m.set("c", 3); // should not evict 'b'
    expect(m.has("b")).toBe(true);
    expect(m.get("c")).toBe(3);
  });

  it("clear empties the map", () => {
    const m = new BoundedMap<string, string>(5);
    m.set("k", "v");
    m.clear();
    expect(m.size).toBe(0);
    expect(m.get("k")).toBeUndefined();
  });

  it("size reflects the current number of entries", () => {
    const m = new BoundedMap<number, string>(10);
    expect(m.size).toBe(0);
    m.set(1, "a");
    m.set(2, "b");
    expect(m.size).toBe(2);
  });
});

// ── TimedEvictionMap ──────────────────────────────────────────────────────────

describe("TimedEvictionMap", () => {
  afterEach(() => vi.useRealTimers());

  it("throws RangeError for ttlMs < 1", () => {
    expect(() => new TimedEvictionMap(0)).toThrow(RangeError);
    expect(() => new TimedEvictionMap(-100)).toThrow(RangeError);
  });

  it("returns a value before its TTL expires", () => {
    const m = new TimedEvictionMap<string, number>(10_000);
    m.set("k", 1, 0);
    expect(m.get("k", 5_000)).toBe(1); // 5 s < 10 s TTL
  });

  it("returns undefined for an entry past its TTL", () => {
    const m = new TimedEvictionMap<string, number>(1_000);
    m.set("k", 1, 0);
    expect(m.get("k", 1_001)).toBeUndefined(); // 1001 ms > 1000 ms TTL
  });

  it("has() returns false for an expired entry", () => {
    const m = new TimedEvictionMap<string, number>(500);
    m.set("k", 42, 0);
    expect(m.has("k", 501)).toBe(false);
  });

  it("purge() removes all expired entries and returns the count", () => {
    const m = new TimedEvictionMap<string, number>(1_000);
    m.set("a", 1, 0);
    m.set("b", 2, 0);
    m.set("c", 3, 500); // expires at 1500
    const removed = m.purge(1_001);
    expect(removed).toBe(2); // 'a' and 'b' expired; 'c' not yet
    expect(m.size).toBe(1);
    expect(m.get("c", 1_001)).toBe(3);
  });

  it("purge() does not remove live entries", () => {
    const m = new TimedEvictionMap<string, string>(60_000);
    m.set("live", "yes", 0);
    const removed = m.purge(1_000); // 1 s < 60 s TTL
    expect(removed).toBe(0);
    expect(m.size).toBe(1);
  });

  it("size reflects entries including expired ones (lazy eviction)", () => {
    const m = new TimedEvictionMap<string, number>(500);
    m.set("x", 1, 0);
    // 'x' is expired at t=600 but size hasn't been decremented yet
    expect(m.size).toBe(1);
    m.purge(600); // now it's evicted
    expect(m.size).toBe(0);
  });

  it("delete removes an entry regardless of TTL", () => {
    const m = new TimedEvictionMap<string, number>(60_000);
    m.set("k", 1);
    m.delete("k");
    expect(m.has("k")).toBe(false);
    expect(m.size).toBe(0);
  });
});

// ── RetryContextStore ─────────────────────────────────────────────────────────

describe("RetryContextStore", () => {
  it("record() returns true and counts the first attempt", () => {
    const store = new RetryContextStore({ maxAttempts: 3 });
    expect(store.record("order-1")).toBe(true);
    expect(store.attempts("order-1")).toBe(1);
  });

  it("record() accumulates attempts across calls", () => {
    const store = new RetryContextStore({ maxAttempts: 5 });
    store.record("order-1");
    store.record("order-1");
    store.record("order-1");
    expect(store.attempts("order-1")).toBe(3);
  });

  it("record() returns false and removes the context when maxAttempts is exhausted", () => {
    const store = new RetryContextStore({ maxAttempts: 3 });
    store.record("k");
    store.record("k");
    const result = store.record("k"); // 3rd attempt — exhausted
    expect(result).toBe(false);
    expect(store.attempts("k")).toBe(0); // context removed
    expect(store.size).toBe(0);
  });

  it("remove() clears the context for a key", () => {
    const store = new RetryContextStore({ maxAttempts: 10 });
    store.record("order-2");
    store.remove("order-2");
    expect(store.attempts("order-2")).toBe(0);
    expect(store.size).toBe(0);
  });

  it("attempts() returns 0 for an untracked key", () => {
    const store = new RetryContextStore();
    expect(store.attempts("unknown")).toBe(0);
  });

  it("stores the last error message", () => {
    const store = new RetryContextStore({ maxAttempts: 5 });
    store.record("k", "RPC timeout");
    const snap = store.snapshot();
    expect(snap[0]?.lastError).toBe("RPC timeout");
  });

  it("snapshot returns copies — mutating does not affect store", () => {
    const store = new RetryContextStore({ maxAttempts: 5 });
    store.record("k");
    const snap = store.snapshot();
    snap[0]!.attempts = 999;
    expect(store.attempts("k")).toBe(1);
  });

  it("purgeStale() removes contexts not updated within staleTtlMs", () => {
    const store = new RetryContextStore({ maxAttempts: 10, staleTtlMs: 1_000 });
    store.record("old");
    store.record("fresh");
    const now = Date.now();
    // Simulate 'old' having been recorded 2 seconds ago.
    const ctx = (store as any).store.get("old");
    ctx.lastAttemptAt = now - 2_000;

    const removed = store.purgeStale(now);
    expect(removed).toBe(1);
    expect(store.attempts("old")).toBe(0);
    expect(store.attempts("fresh")).toBeGreaterThan(0);
  });

  it("purgeStale() does not remove recently-updated contexts", () => {
    const store = new RetryContextStore({ maxAttempts: 10, staleTtlMs: 60_000 });
    store.record("active");
    const removed = store.purgeStale(Date.now());
    expect(removed).toBe(0);
    expect(store.attempts("active")).toBe(1);
  });

  it("maxContexts cap evicts oldest context when exceeded", () => {
    const store = new RetryContextStore({ maxContexts: 2, maxAttempts: 10 });
    store.record("a");
    store.record("b");
    store.record("c"); // 'a' should be evicted (BoundedMap FIFO eviction)
    expect(store.attempts("a")).toBe(0); // evicted
    expect(store.attempts("b")).toBe(1);
    expect(store.attempts("c")).toBe(1);
    expect(store.size).toBe(2);
  });
});
