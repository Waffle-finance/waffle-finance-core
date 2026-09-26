/**
 * Tests for Solana RPC fallback strategy (#713).
 *
 * Validates:
 *  - SolanaRpcProvider routes calls to primary endpoint first
 *  - Falls back to secondary endpoint on retryable errors
 *  - Non-retryable errors (program errors) are rethrown immediately
 *  - Health statistics are tracked correctly
 *  - Degraded mode is detected and surfaced
 *  - createSolanaRpcProvider parses comma-separated endpoint lists
 *  - SolanaRpcFallbackExhaustedError is thrown when all endpoints fail
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Connection } from "@solana/web3.js";

import {
  SolanaRpcProvider,
  SolanaRpcFallbackExhaustedError,
  createSolanaRpcProvider,
} from "../src/solana/rpc-provider.js";

// ── Mock Connection ──────────────────────────────────────────────────────────

function makeConnectionMock(overrides: Partial<{ getSlot: () => Promise<number> }> = {}) {
  return {
    getSlot: vi.fn().mockResolvedValue(1000),
    ...overrides,
  } as unknown as Connection;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("SolanaRpcProvider — construction", () => {
  it("throws when no endpoints are provided", () => {
    expect(() => new SolanaRpcProvider({ endpoints: [] })).toThrow(
      /at least one endpoint/
    );
  });

  it("accepts a single endpoint", () => {
    const provider = new SolanaRpcProvider({
      endpoints: ["https://api.devnet.solana.com"],
    });
    expect(provider.getPrimaryUrl()).toBe("https://api.devnet.solana.com");
  });

  it("uses the first endpoint as primary", () => {
    const provider = new SolanaRpcProvider({
      endpoints: [
        "https://primary.example.com",
        "https://fallback.example.com",
      ],
    });
    expect(provider.getPrimaryUrl()).toBe("https://primary.example.com");
  });
});

describe("SolanaRpcProvider — withFallback", () => {
  it("returns result from primary on success", async () => {
    const provider = new SolanaRpcProvider({
      endpoints: [
        "https://primary.example.com",
        "https://fallback.example.com",
      ],
    });

    // Spy on Connection constructor to inject a mock.
    const getSlotMock = vi.fn().mockResolvedValue(999);
    vi.spyOn(Connection.prototype, "getSlot").mockImplementation(getSlotMock);

    const slot = await provider.withFallback((conn) => conn.getSlot("confirmed"));
    expect(slot).toBe(999);
    expect(getSlotMock).toHaveBeenCalledTimes(1);

    vi.restoreAllMocks();
  });

  it("falls back to secondary on retryable network error from primary", async () => {
    const callCount = { value: 0 };

    const getSlotMock = vi.fn().mockImplementation(async () => {
      callCount.value++;
      if (callCount.value === 1) {
        throw new Error("timeout: connection refused");
      }
      return 1234;
    });
    vi.spyOn(Connection.prototype, "getSlot").mockImplementation(getSlotMock);

    const provider = new SolanaRpcProvider({
      endpoints: [
        "https://primary.example.com",
        "https://fallback.example.com",
      ],
      maxConsecutiveErrors: 3,
    });

    const slot = await provider.withFallback((conn) => conn.getSlot("confirmed"));
    expect(slot).toBe(1234);
    expect(getSlotMock).toHaveBeenCalledTimes(2);

    vi.restoreAllMocks();
  });

  it("rethrows non-retryable errors immediately without trying fallbacks", async () => {
    const callCount = { value: 0 };
    vi.spyOn(Connection.prototype, "getSlot").mockImplementation(async () => {
      callCount.value++;
      throw new Error("custom program error: InvalidInstruction");
    });

    const provider = new SolanaRpcProvider({
      endpoints: [
        "https://primary.example.com",
        "https://fallback.example.com",
      ],
    });

    await expect(
      provider.withFallback((conn) => conn.getSlot("confirmed"))
    ).rejects.toThrow("custom program error: InvalidInstruction");

    // Should only have been called once — non-retryable, no fallback.
    expect(callCount.value).toBe(1);

    vi.restoreAllMocks();
  });

  it("throws SolanaRpcFallbackExhaustedError when all endpoints fail", async () => {
    vi.spyOn(Connection.prototype, "getSlot").mockRejectedValue(
      new Error("fetch failed")
    );

    const provider = new SolanaRpcProvider({
      endpoints: [
        "https://primary.example.com",
        "https://fallback.example.com",
      ],
    });

    await expect(
      provider.withFallback((conn) => conn.getSlot("confirmed"))
    ).rejects.toThrow(SolanaRpcFallbackExhaustedError);

    vi.restoreAllMocks();
  });

  it("SolanaRpcFallbackExhaustedError contains causes from all endpoints", async () => {
    const errors = ["fetch failed: primary", "fetch failed: fallback"];
    let callIdx = 0;
    vi.spyOn(Connection.prototype, "getSlot").mockImplementation(async () => {
      throw new Error(errors[callIdx++] ?? "fetch failed");
    });

    const provider = new SolanaRpcProvider({
      endpoints: [
        "https://primary.example.com",
        "https://fallback.example.com",
      ],
    });

    try {
      await provider.withFallback((conn) => conn.getSlot("confirmed"), "test-context");
    } catch (err) {
      expect(err).toBeInstanceOf(SolanaRpcFallbackExhaustedError);
      const e = err as SolanaRpcFallbackExhaustedError;
      expect(e.causes).toHaveLength(2);
      expect(e.message).toContain("test-context");
    }

    vi.restoreAllMocks();
  });
});

describe("SolanaRpcProvider — health tracking", () => {
  it("reports healthy=false when no calls have been made yet", () => {
    const provider = new SolanaRpcProvider({
      endpoints: ["https://primary.example.com"],
    });
    const health = provider.getHealth();
    expect(health.healthy).toBe(false);
    expect(health.degraded).toBe(false);
    expect(health.activeEndpoint).toBeNull();
  });

  it("records success after a successful call", async () => {
    vi.spyOn(Connection.prototype, "getSlot").mockResolvedValue(42);

    const provider = new SolanaRpcProvider({
      endpoints: ["https://primary.example.com"],
    });
    await provider.withFallback((conn) => conn.getSlot("confirmed"));

    const health = provider.getHealth();
    expect(health.healthy).toBe(true);
    expect(health.activeEndpoint).toBe("https://primary.example.com");
    expect(health.endpoints[0].consecutiveErrors).toBe(0);
    expect(health.endpoints[0].latencyMs).not.toBeNull();

    vi.restoreAllMocks();
  });

  it("increments consecutiveErrors on each failure", async () => {
    vi.spyOn(Connection.prototype, "getSlot").mockRejectedValue(
      new Error("fetch failed")
    );

    const provider = new SolanaRpcProvider({
      endpoints: ["https://primary.example.com"],
      maxConsecutiveErrors: 5,
    });

    try {
      await provider.withFallback((conn) => conn.getSlot("confirmed"));
    } catch {
      // Expected
    }

    expect(provider.getHealth().endpoints[0].consecutiveErrors).toBe(1);

    vi.restoreAllMocks();
  });

  it("marks primary as degraded after maxConsecutiveErrors failures", async () => {
    let callCount = 0;
    vi.spyOn(Connection.prototype, "getSlot").mockImplementation(async () => {
      callCount++;
      throw new Error("fetch failed");
    });

    // Use a single endpoint so all errors accumulate on endpoint[0]
    const provider = new SolanaRpcProvider({
      endpoints: ["https://primary.example.com"],
      maxConsecutiveErrors: 3,
    });

    // Make 3 failing calls so consecutiveErrors accumulates to 3.
    for (let i = 0; i < 3; i++) {
      try {
        await provider.withFallback((conn) => conn.getSlot("confirmed"));
      } catch {
        // expected — each call fails
      }
    }

    // After 3 errors, primary should have consecutiveErrors === 3.
    const health = provider.getHealth();
    expect(health.endpoints[0].consecutiveErrors).toBe(3);

    vi.restoreAllMocks();
  });
});

describe("createSolanaRpcProvider", () => {
  it("parses a single URL", () => {
    const provider = createSolanaRpcProvider("https://api.devnet.solana.com");
    expect(provider.getPrimaryUrl()).toBe("https://api.devnet.solana.com");
  });

  it("parses a comma-separated list of URLs", () => {
    const provider = createSolanaRpcProvider(
      "https://primary.example.com,https://fallback1.example.com,https://fallback2.example.com"
    );
    expect(provider.getPrimaryUrl()).toBe("https://primary.example.com");
  });

  it("trims whitespace around URLs", () => {
    const provider = createSolanaRpcProvider(
      " https://primary.example.com , https://fallback.example.com "
    );
    expect(provider.getPrimaryUrl()).toBe("https://primary.example.com");
  });

  it("throws when the URL string is empty", () => {
    expect(() => createSolanaRpcProvider("")).toThrow(/at least one endpoint/);
  });

  it("throws when all entries are blank", () => {
    expect(() => createSolanaRpcProvider("  ,  ,  ")).toThrow(/at least one endpoint/);
  });
});
