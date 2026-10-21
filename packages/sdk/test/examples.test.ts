/**
 * Executes the documentation examples under packages/sdk/examples/ against
 * mocked coordinator responses.
 *
 * These are not "SDK feature" tests — coverage of CoordinatorClient,
 * OrderSubscriber, etc. lives in their own test files. This file exists so
 * that renaming, removing, or reshaping a public export breaks CI here
 * instead of silently going stale in the README/examples.
 */
import { describe, it, expect, vi } from "vitest";
import { announceAndTrackOrder, summarizeHistoryRecord } from "../examples/announce-and-track-order.js";
import { classifySdkError, isRetryable } from "../examples/error-handling.js";
import { isDirectionLive, resolveDestinationAsset } from "../examples/asset-resolution.js";
import {
  createSwapSecret,
  hashKnownPreimage,
  hashKnownPreimageBytes,
  verifyRevealedPreimage,
  redactSecretForLogging,
  TEST_VECTOR_PREIMAGE,
} from "../examples/secrets-walkthrough.js";
import {
  CoordinatorApiError,
  CoordinatorNetworkError,
  CoordinatorParseError,
  CoordinatorValidationError,
  type CoordinatorOrder,
} from "../src/coordinator/index.js";
import { HTLCError } from "../src/htlc-client.js";
import { UnsupportedAssetError } from "../src/assets/index.js";
import type { HistoryRecord } from "../src/coordinator/history-client.js";

const ETH_ADDR = "0x1111111111111111111111111111111111111111";
const XLM_ADDR = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422";
const HASHLOCK = "0x" + "ab".repeat(32);
const ORDER_ID = `wf_${HASHLOCK}`;

function makeOrder(overrides: Partial<CoordinatorOrder> = {}): CoordinatorOrder {
  return {
    id: ORDER_ID,
    direction: "eth_to_xlm",
    status: "announced",
    hashlock: HASHLOCK,
    src: {
      chain: "ethereum",
      address: ETH_ADDR,
      asset: "native",
      amount: "1000000000000000000",
      safetyDeposit: "1000000000000000",
      orderId: null,
      lockTx: null,
      lockBlock: null,
      timelock: null,
    },
    dst: {
      chain: "stellar",
      address: XLM_ADDR,
      asset: "native",
      amount: "100000000",
      orderId: null,
      lockTx: null,
      lockBlock: null,
      timelock: null,
    },
    secret: { revealed: false, preimage: null, revealedTx: null },
    resolver: null,
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_000,
    ...overrides,
  };
}

describe("examples/announce-and-track-order", () => {
  it("announces, watches status changes, and resolves on settlement", async () => {
    let call = 0;
    const fetcher = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/api/orders/announce")) {
        expect(init?.method).toBe("POST");
        return new Response(JSON.stringify(makeOrder()), { status: 201 });
      }
      if (u.endsWith(`/api/orders/${ORDER_ID}`)) {
        call++;
        const status = call === 1 ? "announced" : "completed";
        return new Response(JSON.stringify(makeOrder({ status })), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${u}`);
    });

    // Patch the base URL's fetch globally isn't needed — CoordinatorClient
    // takes a fetcher directly, but this example only accepts a baseUrl.
    // We inject fetch via the global so the example stays representative of
    // real usage (no fetcher param needed by callers in a browser/Node 18+).
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetcher as unknown as typeof fetch;

    try {
      const result = await announceAndTrackOrder(
        "https://coordinator.example",
        {
          direction: "eth_to_xlm",
          hashlock: HASHLOCK,
          srcChain: "ethereum",
          srcAddress: ETH_ADDR,
          srcAsset: "native",
          srcAmount: "1000000000000000000",
          srcSafetyDeposit: "1000000000000000",
          dstChain: "stellar",
          dstAddress: XLM_ADDR,
          dstAsset: "native",
          dstAmount: "100000000",
        },
        10
      );

      expect(result.publicId).toBe(ORDER_ID);
      expect(result.finalStatus).toBe("completed");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("summarizes a HistoryRecord down to UI-relevant fields", () => {
    const record: HistoryRecord = {
      id: ORDER_ID,
      direction: "eth_to_xlm",
      status: "src_locked",
      hashlock: HASHLOCK,
      src: {
        chain: "ethereum",
        address: ETH_ADDR,
        asset: "native",
        amount: "1000000000000000000",
        safetyDeposit: "1000000000000000",
        orderId: "1",
        lockTx: "0xabc",
        timelock: 1_700_000_100,
      },
      dst: {
        chain: "stellar",
        address: XLM_ADDR,
        asset: "native",
        amount: "100000000",
        orderId: null,
        lockTx: null,
        timelock: null,
      },
      secret: { revealed: false, preimage: null, revealedTx: null },
      resolver: null,
      createdAt: 1_700_000_000,
      updatedAt: 1_700_000_050,
    };

    expect(summarizeHistoryRecord(record)).toEqual({
      id: ORDER_ID,
      direction: "eth_to_xlm",
      status: "src_locked",
      srcChain: "ethereum",
      dstChain: "stellar",
    });
  });
});

describe("examples/error-handling", () => {
  it("classifies every error class in the documented hierarchy", () => {
    expect(classifySdkError(new CoordinatorValidationError("bad field", "hashlock"))).toBe(
      "invalid_request"
    );
    expect(classifySdkError(new CoordinatorApiError(409, "order_conflict", "already exists"))).toBe(
      "rejected_by_coordinator"
    );
    expect(classifySdkError(new CoordinatorNetworkError("timeout"))).toBe("network_or_parse");
    expect(classifySdkError(new CoordinatorParseError("bad json"))).toBe("network_or_parse");
    expect(
      classifySdkError(new HTLCError({ code: "tx_rejected", message: "reverted" }))
    ).toBe("chain_operation_failed");
    expect(
      classifySdkError(new UnsupportedAssetError("0xdead", "testnet", "eth→stellar"))
    ).toBe("unsupported_asset");
    expect(classifySdkError(new Error("plain error"))).toBe("unknown");
  });

  it("flags retryable errors correctly", () => {
    expect(isRetryable(new CoordinatorNetworkError("timeout"))).toBe(true);
    expect(isRetryable(new CoordinatorApiError(503, "unavailable", "try later", true))).toBe(true);
    expect(isRetryable(new CoordinatorApiError(400, "bad_request", "nope", false))).toBe(false);
    expect(
      isRetryable(new HTLCError({ code: "chain_error", message: "rpc blip", retryable: true }))
    ).toBe(true);
    expect(isRetryable(new CoordinatorValidationError("bad field", "hashlock"))).toBe(false);
  });
});

describe("examples/asset-resolution", () => {
  it("reports the four coordinator-supported directions as live", () => {
    expect(isDirectionLive("eth_to_xlm")).toBe(true);
    expect(isDirectionLive("xlm_to_eth")).toBe(true);
    expect(isDirectionLive("eth_to_sol")).toBe(true);
    expect(isDirectionLive("sol_to_eth")).toBe(true);
  });

  it("reports xlm_to_sol and sol_to_xlm as not yet live", () => {
    expect(isDirectionLive("xlm_to_sol")).toBe(false);
    expect(isDirectionLive("sol_to_xlm")).toBe(false);
  });

  it("resolves the destination asset for each live direction", () => {
    expect(resolveDestinationAsset("eth_to_xlm", "0x0000000000000000000000000000000000000000")).toBe(
      "XLM"
    );
    expect(resolveDestinationAsset("xlm_to_eth", "XLM")).toBe(
      "0x0000000000000000000000000000000000000000"
    );
    expect(resolveDestinationAsset("eth_to_sol", "0x0000000000000000000000000000000000000000")).toBe(
      "So11111111111111111111111111111111111111112"
    );
    expect(resolveDestinationAsset("sol_to_eth", "So11111111111111111111111111111111111111112")).toBe(
      "0x0000000000000000000000000000000000000000"
    );
  });
});

describe("examples/secrets-walkthrough", () => {
  it("generates a fresh secret with matching sha256/keccak256 digests", () => {
    const secret = createSwapSecret();
    expect(secret.preimage).toMatch(/^0x[0-9a-f]{64}$/);
    expect(secret.sha256).toMatch(/^0x[0-9a-f]{64}$/);
    expect(secret.keccak256).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("derives the same digests from a deterministic test vector (hex and bytes)", () => {
    const fromHex = hashKnownPreimage(TEST_VECTOR_PREIMAGE);
    expect(fromHex.preimage).toBe(TEST_VECTOR_PREIMAGE);

    const bytes = new Uint8Array(32);
    bytes[31] = 0x2a;
    const fromBytes = hashKnownPreimageBytes(bytes);

    expect(fromBytes.sha256).toBe(fromHex.sha256);
    expect(fromBytes.keccak256).toBe(fromHex.keccak256);
  });

  it("verifies a revealed preimage against either digest convention, and rejects a mismatch", () => {
    const secret = hashKnownPreimage(TEST_VECTOR_PREIMAGE);
    expect(verifyRevealedPreimage(secret.preimage, secret.sha256)).toBe("sha256");
    expect(verifyRevealedPreimage(secret.preimage, secret.keccak256)).toBe("keccak256");
    expect(
      verifyRevealedPreimage(secret.preimage, ("0x" + "00".repeat(32)) as `0x${string}`)
    ).toBeNull();
  });

  it("redacts the preimage before a secret is logged", () => {
    const secret = createSwapSecret();
    const redacted = redactSecretForLogging(secret);
    expect(redacted.preimage).toBe("[REDACTED]");
    expect(redacted.sha256).toBe(secret.sha256);
    expect(redacted.keccak256).toBe(secret.keccak256);
    expect(JSON.stringify(redacted)).not.toContain(secret.preimage.slice(2));
  });
});
