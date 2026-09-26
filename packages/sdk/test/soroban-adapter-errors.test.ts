/**
 * Tests for classifySorobanError inside SorobanHTLCAdapter.
 *
 * The classifier is exercised indirectly through the adapter's public methods.
 * Each test injects a plain Error with a specific message pattern into the
 * mock SorobanHTLCClient and asserts the resulting HTLCError code and
 * retryable flag.
 *
 * Covered patterns:
 *  - Network / RPC timeouts → chain_error, retryable=true
 *  - Soroban host error / WasmVm → simulation_failed, retryable=false
 *  - Preimage / hashlock mismatch → invalid_preimage, retryable=false
 *  - Timelock not expired → timelock_not_expired, retryable=false
 *  - Bad auth / mis-signed transaction → tx_rejected, retryable=false
 *  - Unknown method / function not found → tx_rejected, retryable=false
 *  - Malformed XDR / data → tx_rejected, retryable=false
 *  - Explicit submit rejection → tx_rejected, retryable=false
 *  - HTLCError passthrough (not re-wrapped)
 *  - Unknown errors → chain_error, retryable=false
 */

import { describe, it, expect, vi } from "vitest";
import { SorobanHTLCAdapter } from "../src/soroban/adapter.js";
import { HTLCError } from "../src/htlc-client.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const STELLAR_ADDR = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422";
const PREIMAGE = ("0x" + "ab".repeat(32)) as `0x${string}`;
const VALID_REF = `${STELLAR_ADDR}:1`;

const fakeSigner = vi.fn().mockResolvedValue("signed-xdr");

function makeClientThrowing(method: "createOrder" | "claimOrder" | "refundOrder", err: Error): any {
  return {
    createOrder: vi.fn(),
    claimOrder: vi.fn(),
    refundOrder: vi.fn(),
    [method]: vi.fn().mockRejectedValue(err),
  };
}

async function captureError(fn: () => Promise<unknown>): Promise<HTLCError> {
  try {
    await fn();
    throw new Error("Expected fn to throw");
  } catch (err) {
    if (err instanceof HTLCError) return err;
    throw err;
  }
}

// ── Network / RPC timeout errors ─────────────────────────────────────────────

describe("classifySorobanError — network timeouts", () => {
  const timeoutMessages = [
    "Request timeout after 30000ms",
    "ETIMEDOUT: connection timed out",
    "ECONNRESET: socket hang up",
    "Network error: socket hang up",
    "connection refused on port 8000",
    "ECONNREFUSED 127.0.0.1:8000",
  ];

  for (const message of timeoutMessages) {
    it(`maps "${message}" → chain_error, retryable=true`, async () => {
      const adapter = new SorobanHTLCAdapter(
        makeClientThrowing("createOrder", new Error(message)),
      );
      const err = await captureError(() =>
        adapter.createOrder({ sender: STELLAR_ADDR } as any, fakeSigner),
      );
      expect(err.code).toBe("chain_error");
      expect(err.retryable).toBe(true);
    });
  }
});

// ── Soroban host / WasmVm errors ─────────────────────────────────────────────

describe("classifySorobanError — contract host errors", () => {
  const hostMessages = [
    "Simulation failed: HostError(Contract, #3)",
    "simulation rejected: InvokeHostFunctionError",
    "host error: WasmVm trap at offset 0x42",
    "Host error: Error(Contract, #7)",
    "WasmVm execution failed",
    "contracterror code 5",
  ];

  for (const message of hostMessages) {
    it(`maps "${message}" → simulation_failed, retryable=false`, async () => {
      const adapter = new SorobanHTLCAdapter(
        makeClientThrowing("claimOrder", new Error(message)),
      );
      const err = await captureError(() =>
        adapter.claimOrder(VALID_REF, PREIMAGE, fakeSigner),
      );
      expect(err.code).toBe("simulation_failed");
      expect(err.retryable).toBe(false);
    });
  }
});

// ── Preimage / hashlock mismatch ─────────────────────────────────────────────

describe("classifySorobanError — preimage errors", () => {
  it("maps hashlock mismatch → invalid_preimage", async () => {
    const adapter = new SorobanHTLCAdapter(
      makeClientThrowing("claimOrder", new Error("hashlock verification failed")),
    );
    const err = await captureError(() =>
      adapter.claimOrder(VALID_REF, PREIMAGE, fakeSigner),
    );
    expect(err.code).toBe("invalid_preimage");
    expect(err.retryable).toBe(false);
  });

  it("maps preimage rejection → invalid_preimage", async () => {
    const adapter = new SorobanHTLCAdapter(
      makeClientThrowing("claimOrder", new Error("preimage does not match")),
    );
    const err = await captureError(() =>
      adapter.claimOrder(VALID_REF, PREIMAGE, fakeSigner),
    );
    expect(err.code).toBe("invalid_preimage");
  });
});

// ── Timelock not expired ─────────────────────────────────────────────────────

describe("classifySorobanError — timelock errors", () => {
  it("maps timelock not expired → timelock_not_expired", async () => {
    const adapter = new SorobanHTLCAdapter(
      makeClientThrowing("refundOrder", new Error("timelock has not expired yet")),
    );
    const err = await captureError(() =>
      adapter.refundOrder(VALID_REF, fakeSigner),
    );
    expect(err.code).toBe("timelock_not_expired");
    expect(err.retryable).toBe(false);
  });
});

// ── Bad auth / mis-signed transaction ────────────────────────────────────────

describe("classifySorobanError — bad auth / mis-signed", () => {
  const badAuthMessages = [
    "tx_bad_auth: authentication failed",
    "txBadAuth: source account mismatch",
    "bad auth — missing required signer",
    "signature invalid for account",
  ];

  for (const message of badAuthMessages) {
    it(`maps "${message}" → tx_rejected, retryable=false`, async () => {
      const adapter = new SorobanHTLCAdapter(
        makeClientThrowing("createOrder", new Error(message)),
      );
      const err = await captureError(() =>
        adapter.createOrder({ sender: STELLAR_ADDR } as any, fakeSigner),
      );
      expect(err.code).toBe("tx_rejected");
      expect(err.retryable).toBe(false);
    });
  }
});

// ── Unknown method / function not found ─────────────────────────────────────

describe("classifySorobanError — unknown method", () => {
  const unknownMethodMessages = [
    "function not found: claim_order",
    "unknown method on contract",
    "method not found in WASM",
    "no such method: refund_order",
    "no such function: create_order",
  ];

  for (const message of unknownMethodMessages) {
    it(`maps "${message}" → tx_rejected, retryable=false`, async () => {
      const adapter = new SorobanHTLCAdapter(
        makeClientThrowing("claimOrder", new Error(message)),
      );
      const err = await captureError(() =>
        adapter.claimOrder(VALID_REF, PREIMAGE, fakeSigner),
      );
      expect(err.code).toBe("tx_rejected");
      expect(err.retryable).toBe(false);
    });
  }
});

// ── Malformed XDR / data errors ──────────────────────────────────────────────

describe("classifySorobanError — malformed data", () => {
  it("maps XDR decode error → tx_rejected, retryable=false", async () => {
    const adapter = new SorobanHTLCAdapter(
      makeClientThrowing("createOrder", new Error("XDR decode failed at offset 12")),
    );
    const err = await captureError(() =>
      adapter.createOrder({ sender: STELLAR_ADDR } as any, fakeSigner),
    );
    expect(err.code).toBe("tx_rejected");
    expect(err.retryable).toBe(false);
  });

  it("maps malformed response → tx_rejected, retryable=false", async () => {
    const adapter = new SorobanHTLCAdapter(
      makeClientThrowing("claimOrder", new Error("malformed response from RPC")),
    );
    const err = await captureError(() =>
      adapter.claimOrder(VALID_REF, PREIMAGE, fakeSigner),
    );
    expect(err.code).toBe("tx_rejected");
    expect(err.retryable).toBe(false);
  });
});

// ── HTLCError passthrough ─────────────────────────────────────────────────────

describe("classifySorobanError — HTLCError passthrough", () => {
  it("does not re-wrap an HTLCError from the orchestration layer", async () => {
    const original = new HTLCError({
      code: "simulation_failed",
      message: "already classified",
      retryable: false,
    });
    const adapter = new SorobanHTLCAdapter(
      makeClientThrowing("createOrder", original),
    );
    const caught = await captureError(() =>
      adapter.createOrder({ sender: STELLAR_ADDR } as any, fakeSigner),
    );
    expect(caught).toBe(original);
    expect(caught.message).toBe("already classified");
  });

  it("preserves submissionMeta from the orchestration layer HTLCError", async () => {
    const meta = { attempts: 3, feeBumpHistory: [2000, 4000], lastHash: "abc123" };
    const original = new HTLCError({
      code: "tx_rejected",
      message: "fee cap exceeded",
      submissionMeta: meta,
    });
    const adapter = new SorobanHTLCAdapter(
      makeClientThrowing("refundOrder", original),
    );
    const caught = await captureError(() =>
      adapter.refundOrder(VALID_REF, fakeSigner),
    );
    expect(caught.submissionMeta).toEqual(meta);
  });
});

// ── Unknown / fallback errors ────────────────────────────────────────────────

describe("classifySorobanError — unknown errors", () => {
  it("maps an unrecognised Error to chain_error, retryable=false", async () => {
    const adapter = new SorobanHTLCAdapter(
      makeClientThrowing("createOrder", new Error("something completely unexpected")),
    );
    const err = await captureError(() =>
      adapter.createOrder({ sender: STELLAR_ADDR } as any, fakeSigner),
    );
    expect(err.code).toBe("chain_error");
    expect(err.retryable).toBe(false);
  });

  it("maps a thrown string to chain_error", async () => {
    const client = {
      createOrder: vi.fn().mockRejectedValue("raw string rejection"),
      claimOrder: vi.fn(),
      refundOrder: vi.fn(),
    };
    const adapter = new SorobanHTLCAdapter(client as any);
    const err = await captureError(() =>
      adapter.createOrder({ sender: STELLAR_ADDR } as any, fakeSigner),
    );
    expect(err.code).toBe("chain_error");
  });
});

// ── Error message content ────────────────────────────────────────────────────

describe("classifySorobanError — error messages are actionable", () => {
  it("includes the original message in the HTLCError message", async () => {
    const original = "Contract rejected: insufficient safety deposit";
    const adapter = new SorobanHTLCAdapter(
      makeClientThrowing("createOrder", new Error(original)),
    );
    const err = await captureError(() =>
      adapter.createOrder({ sender: STELLAR_ADDR } as any, fakeSigner),
    );
    expect(err.message).toContain(original);
  });

  it("preserves the original error in cause for debugging", async () => {
    const original = new Error("raw Stellar SDK error");
    const adapter = new SorobanHTLCAdapter(
      makeClientThrowing("createOrder", original),
    );
    const err = await captureError(() =>
      adapter.createOrder({ sender: STELLAR_ADDR } as any, fakeSigner),
    );
    expect(err.cause).toBe(original);
  });
});
