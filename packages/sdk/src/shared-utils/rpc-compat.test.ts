import { describe, it, expect, vi } from "vitest";
import {
  classifyRpcError,
  chainIdsMatch,
  normalizeChainId,
  parseBalanceHex,
  rpcCallWithFallback,
} from "./rpc-compat.js";

describe("classifyRpcError", () => {
  it("classifies user rejection", () => {
    expect(classifyRpcError(new Error("MetaMask Tx Signature: User rejected the request."))).toEqual(
      expect.objectContaining({ category: "user_rejection", retryable: false }),
    );
  });

  it("classifies Phantom / Freighter rejections", () => {
    expect(
      classifyRpcError(new Error("Phantom wallet denied the signature request")),
    ).toEqual(
      expect.objectContaining({ category: "user_rejection", retryable: false }),
    );
    expect(
      classifyRpcError(new Error("Freighter: User declined to sign transaction")),
    ).toEqual(
      expect.objectContaining({ category: "user_rejection", retryable: false }),
    );
  });

  it("classifies transaction reverts", () => {
    expect(classifyRpcError(new Error("execution reverted: ERC20: insufficient allowance"))).toEqual(
      expect.objectContaining({ category: "revert", retryable: false }),
    );
  });

  it("classifies gas estimation failures", () => {
    expect(classifyRpcError(new Error("required gas exceeds allowance (5029188)"))).toEqual(
      expect.objectContaining({ category: "gas_estimation_failed", retryable: true }),
    );
  });

  it("classifies insufficient funds across synonyms", () => {
    expect(
      classifyRpcError(new Error("insufficient funds for gas * price + value")),
    ).toEqual(
      expect.objectContaining({ category: "insufficient_funds", retryable: false }),
    );
    expect(
      classifyRpcError(new Error("sender doesn't have enough funds to send tx.")),
    ).toEqual(
      expect.objectContaining({ category: "insufficient_funds", retryable: false }),
    );
  });

  it("classifies nonce conflicts as retryable", () => {
    expect(classifyRpcError(new Error("replacement transaction underpriced"))).toEqual(
      expect.objectContaining({ category: "nonce_conflict", retryable: true }),
    );
    expect(classifyRpcError(new Error("nonce too low"))).toEqual(
      expect.objectContaining({ category: "nonce_conflict", retryable: true }),
    );
  });

  it("classifies timeouts and network errors as retryable", () => {
    expect(classifyRpcError(new Error("Request timeout"))).toEqual(
      expect.objectContaining({ category: "timeout", retryable: true }),
    );
    expect(classifyRpcError(new TypeError("Failed to fetch"))).toEqual(
      expect.objectContaining({ category: "network", retryable: true }),
    );
  });

  it("uses the JSON-RPC code when provided alongside a generic message", () => {
    const err = Object.assign(new Error("something went wrong"), { code: -32005 });
    expect(classifyRpcError(err)).toEqual(
      expect.objectContaining({ category: "nonce_conflict", retryable: true, code: -32005 }),
    );
  });

  it("classifies HTTP status when wrapped on the same shape", () => {
    expect(classifyRpcError({ status: 429, message: "Too Many Requests" })).toEqual(
      expect.objectContaining({ category: "rate_limited" }),
    );
    expect(classifyRpcError({ status: 502, message: "Bad Gateway" })).toEqual(
      expect.objectContaining({ category: "network", retryable: true }),
    );
    expect(classifyRpcError({ status: 401, message: "Unauthorized" })).toEqual(
      expect.objectContaining({ category: "unauthorized", retryable: false }),
    );
    expect(classifyRpcError({ status: 403, message: "Forbidden" })).toEqual(
      expect.objectContaining({ category: "unauthorized", retryable: false }),
    );
  });

  it("returns a stable shape for unrecognised errors", () => {
    const result = classifyRpcError(new Error("totally unknown"));
    expect(result.category).toBe("unknown");
    expect(result.retryable).toBe(false);
    expect(result.message).toContain("totally unknown");
  });

  it("handles string errors", () => {
    expect(classifyRpcError("user rejected").category).toBe("user_rejection");
    expect(classifyRpcError("").category).toBe("unknown");
  });

  it("handles null and undefined without throwing", () => {
    expect(classifyRpcError(null).category).toBe("unknown");
    expect(classifyRpcError(undefined).category).toBe("unknown");
  });
});

describe("chainIdsMatch / normalizeChainId", () => {
  it("matches hex / hex regardless of case and 0x prefix", () => {
    expect(chainIdsMatch("0xaa36a7", "0XAA36A7")).toBe(true);
    expect(chainIdsMatch("0x1", "0x01")).toBe(true);
  });

  it("matches decimal / hex after normalisation", () => {
    expect(chainIdsMatch("11155111", "0xaa36a7")).toBe(true);
    expect(chainIdsMatch("1", "0x1")).toBe(true);
  });

  it("returns false when either side is missing or unparseable", () => {
    expect(chainIdsMatch(null, "0x1")).toBe(false);
    expect(chainIdsMatch("", "0x1")).toBe(false);
    expect(chainIdsMatch("0xnotahex", "0x1")).toBe(false);
  });

  it("normalises valid input and rejects bad input", () => {
    expect(normalizeChainId("11155111")).toBe("0xaa36a7");
    expect(normalizeChainId("0xAA36A7")).toBe("0xaa36a7");
    expect(normalizeChainId("0xnotahex")).toBeNull();
    expect(normalizeChainId(null)).toBeNull();
  });
});

describe("parseBalanceHex", () => {
  it("handles 0x-prefixed and unprefixed hex", () => {
    expect(parseBalanceHex("0xff")).toBe(255n);
    expect(parseBalanceHex("ff")).toBe(255n);
  });

  it("handles decimal strings", () => {
    expect(parseBalanceHex("1234")).toBe(1234n);
  });

  it("returns 0n for null, undefined, empty strings", () => {
    expect(parseBalanceHex(null)).toBe(0n);
    expect(parseBalanceHex(undefined)).toBe(0n);
    expect(parseBalanceHex("")).toBe(0n);
  });

  it("returns 0n for unparseable input instead of throwing", () => {
    expect(parseBalanceHex("not a number")).toBe(0n);
  });
});

describe("rpcCallWithFallback", () => {
  it("returns the first successful provider", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ jsonrpc: "2.0", id: 1, result: "0xff" }),
    });
    const r = await rpcCallWithFallback<string>(["http://a"], "eth_blockNumber", [], { fetcher });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.provider).toBe("http://a");
      expect(r.result).toBe("0xff");
    }
  });

  it("falls through to a second provider when the first returns 429", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        json: async () => ({}),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ jsonrpc: "2.0", id: 1, result: "0xab" }),
      });
    const r = await rpcCallWithFallback<string>(
      ["http://a", "http://b"],
      "eth_blockNumber",
      [],
      { fetcher },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.provider).toBe("http://b");
      expect(r.result).toBe("0xab");
    }
  });

  it("falls through on a thrown network error", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error("Failed to fetch"))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ jsonrpc: "2.0", id: 1, result: "0xcd" }),
      });
    const r = await rpcCallWithFallback<string>(
      ["http://a", "http://b"],
      "eth_blockNumber",
      [],
      { fetcher },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.provider).toBe("http://b");
    }
  });

  it("reports every attempt when all providers fail", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        json: async () => ({}),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "reverted" } }),
      });
    const r = await rpcCallWithFallback(["http://a", "http://b"], "eth_call", [], { fetcher });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.attempts).toHaveLength(2);
      expect(r.attempts[0]?.provider).toBe("http://a");
      expect(r.attempts[1]?.provider).toBe("http://b");
      expect(r.attempts[1]?.error.category).toBe("revert");
    }
  });

  it("returns failure with empty attempts when providers list is empty", async () => {
    const r = await rpcCallWithFallback([], "eth_blockNumber", []);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.attempts).toEqual([]);
    }
  });
});
