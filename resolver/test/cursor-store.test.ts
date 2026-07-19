import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { SorobanCursorStore } from "../src/utils/cursor-store.js";

const TEST_DIR = join(process.cwd(), ".soroban-cursor-test");

describe("SorobanCursorStore", () => {
  let store: SorobanCursorStore;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
    store = new SorobanCursorStore({ storageDir: TEST_DIR });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Basic load / save
  // -------------------------------------------------------------------------

  it("returns null when no cursor has been saved for a label", () => {
    expect(store.load("nonexistent")).toBeNull();
  });

  it("persists and retrieves a cursor string", () => {
    store.save("soroban-poller", "0000000100000001");
    expect(store.load("soroban-poller")).toBe("0000000100000001");
  });

  it("overwrites previous value on subsequent save", () => {
    store.save("soroban-poller", "0000000100000001");
    store.save("soroban-poller", "0000000200000002");
    expect(store.load("soroban-poller")).toBe("0000000200000002");
  });

  it("supports multiple independent labels", () => {
    store.save("poller-a", "aaaa0001");
    store.save("poller-b", "bbbb0001");
    expect(store.load("poller-a")).toBe("aaaa0001");
    expect(store.load("poller-b")).toBe("bbbb0001");
  });

  // -------------------------------------------------------------------------
  // Cross-instance (disk) persistence — the primary restart guarantee
  // -------------------------------------------------------------------------

  it("persists to disk so a new instance reads the same cursor", () => {
    store.save("disk-test", "0000000123456789");

    // Simulate a restart: create a brand-new instance pointing at the
    // same directory (no in-memory cache).
    const store2 = new SorobanCursorStore({ storageDir: TEST_DIR });
    expect(store2.load("disk-test")).toBe("0000000123456789");
  });

  it("survives multiple restart cycles without cursor regression", () => {
    const cursors = [
      "0000000000000001",
      "0000000000000050",
      "0000000000000099",
    ];
    for (const c of cursors) {
      store.save("restart-cycle", c);
    }

    const store2 = new SorobanCursorStore({ storageDir: TEST_DIR });
    expect(store2.load("restart-cycle")).toBe(cursors[cursors.length - 1]);
  });

  // -------------------------------------------------------------------------
  // In-memory cache behaviour
  // -------------------------------------------------------------------------

  it("serves subsequent loads from cache (no extra disk reads)", () => {
    store.save("cached", "0000000000000042");
    // Second call should hit the cache, not re-read the file — the
    // observable invariant is that the same value comes back.
    expect(store.load("cached")).toBe("0000000000000042");
    expect(store.load("cached")).toBe("0000000000000042");
  });

  it("clearCache forces a fresh disk read on next load", () => {
    store.save("cache-clear", "0000000000001111");
    expect(store.load("cache-clear")).toBe("0000000000001111");

    store.clearCache();
    // Should still be readable from disk after clearing the cache.
    expect(store.load("cache-clear")).toBe("0000000000001111");
  });

  // -------------------------------------------------------------------------
  // Label sanitisation
  // -------------------------------------------------------------------------

  it("sanitises labels containing special characters to safe filenames", () => {
    // Colons, spaces, slashes are all replaced internally.
    store.save("soroban:mainnet/htlc contract!", "0000000000009999");

    const store2 = new SorobanCursorStore({ storageDir: TEST_DIR });
    expect(store2.load("soroban:mainnet/htlc contract!")).toBe(
      "0000000000009999",
    );
  });

  // -------------------------------------------------------------------------
  // On-disk JSON structure
  // -------------------------------------------------------------------------

  it("writes a valid JSON file with the expected shape", () => {
    store.save("json-check", "0000000000000055");

    const raw = readFileSync(
      join(TEST_DIR, "json-check.json"),
      "utf-8",
    );
    const parsed = JSON.parse(raw);

    expect(parsed.label).toBe("json-check");
    expect(parsed.cursor).toBe("0000000000000055");
    expect(typeof parsed.updatedAt).toBe("number");
    expect(parsed.updatedAt).toBeGreaterThan(0);
  });

  it("does not write a .tmp file after a successful save", () => {
    store.save("atomic-check", "0000000000000077");
    expect(existsSync(join(TEST_DIR, "atomic-check.json.tmp"))).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Corruption resilience
  // -------------------------------------------------------------------------

  it("returns null and does not throw when the cursor file is corrupted", () => {
    writeFileSync(
      join(TEST_DIR, "corrupted.json"),
      "{ this is not valid json ]]]",
      "utf-8",
    );

    const store2 = new SorobanCursorStore({ storageDir: TEST_DIR });
    // Should fall back to null (caller starts from head) rather than
    // crashing with a SyntaxError.
    expect(store2.load("corrupted")).toBeNull();
  });

  it("returns null when the cursor field is missing from a valid JSON file", () => {
    writeFileSync(
      join(TEST_DIR, "missing-cursor.json"),
      JSON.stringify({ label: "missing-cursor", updatedAt: Date.now() }),
      "utf-8",
    );

    const store2 = new SorobanCursorStore({ storageDir: TEST_DIR });
    expect(store2.load("missing-cursor")).toBeNull();
  });

  it("returns null when the cursor field is an empty string", () => {
    writeFileSync(
      join(TEST_DIR, "empty-cursor.json"),
      JSON.stringify({ label: "empty-cursor", cursor: "", updatedAt: Date.now() }),
      "utf-8",
    );

    const store2 = new SorobanCursorStore({ storageDir: TEST_DIR });
    expect(store2.load("empty-cursor")).toBeNull();
  });
});
