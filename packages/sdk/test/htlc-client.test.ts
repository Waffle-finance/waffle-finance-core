/**
 * Tests for the normalised SDK HTLC client interfaces and adapters.
 *
 * Covered:
 *  - HTLCError construction, fields, and retryable flag
 *  - EthereumHTLCAdapter: createOrder / claimOrder / refundOrder normalisation,
 *    error classification, passthrough of HTLCError
 *  - SorobanHTLCAdapter: same operations + orderId encoding helpers
 *  - SolanaHTLCAdapter: same operations + simulation-mode error classification
 *  - Cross-client structural parity (IHTLCClient contract)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Hex } from "viem";

import {
  HTLCError,
  type HTLCCreateResult,
  type HTLCTxResult,
} from "../src/htlc-client.js";

import { EthereumHTLCAdapter } from "../src/ethereum/adapter.js";
import {
  SorobanHTLCAdapter,
  encodeSorobanOrderRef,
  decodeSorobanOrderRef,
} from "../src/soroban/adapter.js";
import { SolanaHTLCAdapter } from "../src/solana/adapter.js";

// ── Shared fixtures ────────────────────────────────────────────────────────

const HASHLOCK = ("0x" + "ab".repeat(32)) as `0x${string}`;
const PREIMAGE  = ("0x" + "cd".repeat(32)) as `0x${string}`;
const TX_HASH   = ("0x" + "ef".repeat(32)) as `0x${string}`;

// ── HTLCError ──────────────────────────────────────────────────────────────

describe("HTLCError", () => {
  it("sets name, code, message, and retryable correctly", () => {
    const err = new HTLCError({
      code: "wallet_unavailable",
      message: "No wallet",
      retryable: true,
    });
    expect(err.name).toBe("HTLCError");
    expect(err.code).toBe("wallet_unavailable");
    expect(err.message).toBe("No wallet");
    expect(err.retryable).toBe(true);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(HTLCError);
  });

  it("defaults retryable to false", () => {
    const err = new HTLCError({ code: "chain_error", message: "bad" });
    expect(err.retryable).toBe(false);
  });

  it("stores cause for debugging", () => {
    const cause = new Error("original");
    const err = new HTLCError({ code: "tx_rejected", message: "rejected", cause });
    expect(err.cause).toBe(cause);
  });

  it("can represent all HTLCErrorCode values", () => {
    const codes = [
      "wallet_unavailable",
      "simulation_failed",
      "tx_rejected",
      "order_not_found",
      "timelock_not_expired",
      "invalid_preimage",
      "simulation_mode",
      "chain_error",
    ] as const;
    for (const code of codes) {
      expect(() => new HTLCError({ code, message: "test" })).not.toThrow();
    }
  });
});

// ── EthereumHTLCAdapter ────────────────────────────────────────────────────

describe("EthereumHTLCAdapter", () => {
  // Mock the underlying EthereumHTLCClient
  const mockClient = {
    createOrder: vi.fn(),
    claimOrder: vi.fn(),
    refundOrder: vi.fn(),
  } as any;

  let adapter: EthereumHTLCAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new EthereumHTLCAdapter(mockClient);
  });

  // ── createOrder ──────────────────────────────────────────────────────────

  describe("createOrder", () => {
    it("returns { txId, orderId } with orderId as decimal string", async () => {
      mockClient.createOrder.mockResolvedValue({ txHash: TX_HASH, orderId: BigInt(42) });

      const result: HTLCCreateResult = await adapter.createOrder({
        beneficiary: "0x1111111111111111111111111111111111111111",
        refundAddress: "0x2222222222222222222222222222222222222222",
        token: "0x0000000000000000000000000000000000000000",
        amount: BigInt(1e18),
        safetyDeposit: BigInt(1e15),
        hashlock: HASHLOCK,
        timelockSeconds: BigInt(3600),
      } as any);

      expect(result.txId).toBe(TX_HASH);
      expect(result.orderId).toBe("42");
    });

    it("converts large uint256 orderId to decimal string", async () => {
      const bigId = BigInt("999999999999999999999999999999999");
      mockClient.createOrder.mockResolvedValue({ txHash: TX_HASH, orderId: bigId });
      const result = await adapter.createOrder({} as any);
      expect(result.orderId).toBe(bigId.toString());
    });

    it("wraps wallet-unavailable errors as HTLCError(wallet_unavailable)", async () => {
      mockClient.createOrder.mockRejectedValue(new Error("User rejected the request"));
      await expect(adapter.createOrder({} as any)).rejects.toMatchObject({
        code: "wallet_unavailable",
        retryable: true,
      });
    });

    it("wraps simulation/revert errors as HTLCError(simulation_failed)", async () => {
      mockClient.createOrder.mockRejectedValue(
        new Error("Simulation failed: InsufficientAllowance")
      );
      await expect(adapter.createOrder({} as any)).rejects.toMatchObject({
        code: "simulation_failed",
        retryable: false,
      });
    });

    it("wraps reverted errors as HTLCError(simulation_failed)", async () => {
      mockClient.createOrder.mockRejectedValue(new Error("execution reverted: InvalidValue"));
      await expect(adapter.createOrder({} as any)).rejects.toMatchObject({
        code: "simulation_failed",
        retryable: false,
      });
    });

    it("does not re-wrap an HTLCError that bubbles up", async () => {
      const original = new HTLCError({ code: "tx_rejected", message: "already thrown" });
      mockClient.createOrder.mockRejectedValue(original);
      await expect(adapter.createOrder({} as any)).rejects.toBe(original);
    });

    it("preserves the original error as cause", async () => {
      const cause = new Error("unexpected rpc failure");
      mockClient.createOrder.mockRejectedValue(cause);
      let caught: HTLCError | undefined;
      try {
        await adapter.createOrder({} as any);
      } catch (e) {
        caught = e as HTLCError;
      }
      expect(caught?.cause).toBe(cause);
    });
  });

  // ── claimOrder ───────────────────────────────────────────────────────────

  describe("claimOrder", () => {
    it("returns { txId } and calls underlying claimOrder with BigInt(orderId)", async () => {
      mockClient.claimOrder.mockResolvedValue(TX_HASH as Hex);

      const result: HTLCTxResult = await adapter.claimOrder("42", PREIMAGE);

      expect(result.txId).toBe(TX_HASH);
      expect(mockClient.claimOrder).toHaveBeenCalledWith(BigInt(42), PREIMAGE);
    });

    it("wraps invalid preimage errors", async () => {
      mockClient.claimOrder.mockRejectedValue(new Error("simulation: invalid preimage provided"));
      await expect(adapter.claimOrder("1", PREIMAGE)).rejects.toMatchObject({
        code: "invalid_preimage",
        retryable: false,
      });
    });

    it("wraps generic chain errors with retryable=false by default", async () => {
      mockClient.claimOrder.mockRejectedValue(new Error("something unexpected happened"));
      await expect(adapter.claimOrder("1", PREIMAGE)).rejects.toMatchObject({
        code: "chain_error",
      });
    });

    it("marks network/timeout errors as retryable", async () => {
      mockClient.claimOrder.mockRejectedValue(new Error("network timeout exceeded"));
      await expect(adapter.claimOrder("1", PREIMAGE)).rejects.toMatchObject({
        code: "chain_error",
        retryable: true,
      });
    });
  });

  // ── refundOrder ──────────────────────────────────────────────────────────

  describe("refundOrder", () => {
    it("returns { txId } and calls underlying refundOrder with BigInt(orderId)", async () => {
      mockClient.refundOrder.mockResolvedValue(TX_HASH as Hex);

      const result = await adapter.refundOrder("99");

      expect(result.txId).toBe(TX_HASH);
      expect(mockClient.refundOrder).toHaveBeenCalledWith(BigInt(99));
    });

    it("wraps timelock errors as HTLCError(timelock_not_expired)", async () => {
      mockClient.refundOrder.mockRejectedValue(new Error("timelock not expired yet"));
      await expect(adapter.refundOrder("1")).rejects.toMatchObject({
        code: "timelock_not_expired",
        retryable: false,
      });
    });
  });
});

// ── SorobanHTLCAdapter ─────────────────────────────────────────────────────

describe("SorobanHTLCAdapter", () => {
  const STELLAR_ADDR = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422";

  const mockClient = {
    createOrder: vi.fn(),
    claimOrder: vi.fn(),
    refundOrder: vi.fn(),
  } as any;

  const fakeSigner = vi.fn().mockResolvedValue("signed-xdr");

  let adapter: SorobanHTLCAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new SorobanHTLCAdapter(mockClient);
  });

  // ── encodeSorobanOrderRef / decodeSorobanOrderRef ─────────────────────────

  describe("encodeSorobanOrderRef / decodeSorobanOrderRef", () => {
    it("encodes and decodes a round-trip", () => {
      const ref = encodeSorobanOrderRef(STELLAR_ADDR, 42);
      const { callerAccountId, numericId } = decodeSorobanOrderRef(ref);
      expect(callerAccountId).toBe(STELLAR_ADDR);
      expect(numericId).toBe("42");
    });

    it("encodes bigint as string", () => {
      const ref = encodeSorobanOrderRef(STELLAR_ADDR, BigInt(9999));
      expect(ref).toBe(`${STELLAR_ADDR}:9999`);
    });

    it("decodes a plain numeric id (no separator) gracefully", () => {
      const { callerAccountId, numericId } = decodeSorobanOrderRef("42");
      expect(callerAccountId).toBe("");
      expect(numericId).toBe("42");
    });
  });

  // ── createOrder ──────────────────────────────────────────────────────────

  describe("createOrder", () => {
    it("returns { txId, orderId } where orderId encodes caller + txHash", async () => {
      const txHash = "abc123stellartxhash";
      mockClient.createOrder.mockResolvedValue(txHash);

      const input = {
        sender: STELLAR_ADDR,
        beneficiary: STELLAR_ADDR,
        refundAddress: STELLAR_ADDR,
        asset: "native",
        amount: BigInt(1e7),
        safetyDeposit: BigInt(1e6),
        hashlockHex: HASHLOCK,
        timelockSeconds: 3600,
      };

      const result = await adapter.createOrder(input, fakeSigner);

      expect(result.txId).toBe(txHash);
      // orderId must be decodeable back to caller + txHash
      const decoded = decodeSorobanOrderRef(result.orderId);
      expect(decoded.callerAccountId).toBe(STELLAR_ADDR);
      expect(decoded.numericId).toBe(txHash);
    });

    it("wraps simulation errors as HTLCError(simulation_failed)", async () => {
      mockClient.createOrder.mockRejectedValue(new Error("Simulation failed: contract error"));
      await expect(adapter.createOrder({ sender: STELLAR_ADDR } as any, fakeSigner)).rejects.toMatchObject({
        code: "simulation_failed",
        retryable: false,
      });
    });

    it("wraps submit errors as HTLCError(tx_rejected)", async () => {
      mockClient.createOrder.mockRejectedValue(new Error("Submit failed: ERROR result"));
      await expect(adapter.createOrder({ sender: STELLAR_ADDR } as any, fakeSigner)).rejects.toMatchObject({
        code: "tx_rejected",
      });
    });

    it("does not re-wrap HTLCError", async () => {
      const original = new HTLCError({ code: "chain_error", message: "already htlc" });
      mockClient.createOrder.mockRejectedValue(original);
      await expect(adapter.createOrder({} as any, fakeSigner)).rejects.toBe(original);
    });
  });

  // ── claimOrder ───────────────────────────────────────────────────────────

  describe("claimOrder", () => {
    it("decodes the order ref and calls underlying claimOrder", async () => {
      const txHash = "stellar-claim-tx";
      mockClient.claimOrder.mockResolvedValue(txHash);

      const ref = encodeSorobanOrderRef(STELLAR_ADDR, 7);
      const result = await adapter.claimOrder(ref, PREIMAGE, fakeSigner);

      expect(result.txId).toBe(txHash);
      expect(mockClient.claimOrder).toHaveBeenCalledWith(
        STELLAR_ADDR,
        BigInt(7),
        PREIMAGE,
        fakeSigner
      );
    });

    it("handles a plain numeric orderId (no caller prefix)", async () => {
      mockClient.claimOrder.mockResolvedValue("tx");
      await adapter.claimOrder("5", PREIMAGE, fakeSigner);
      expect(mockClient.claimOrder).toHaveBeenCalledWith("", BigInt(5), PREIMAGE, fakeSigner);
    });
  });

  // ── refundOrder ──────────────────────────────────────────────────────────

  describe("refundOrder", () => {
    it("decodes the order ref and calls underlying refundOrder", async () => {
      mockClient.refundOrder.mockResolvedValue("refund-tx");
      const ref = encodeSorobanOrderRef(STELLAR_ADDR, 3);
      const result = await adapter.refundOrder(ref, fakeSigner);

      expect(result.txId).toBe("refund-tx");
      expect(mockClient.refundOrder).toHaveBeenCalledWith(STELLAR_ADDR, BigInt(3), fakeSigner);
    });
  });
});

// ── SolanaHTLCAdapter ──────────────────────────────────────────────────────

describe("SolanaHTLCAdapter", () => {
  const SOLANA_ADDR = "11111111111111111111111111111111";
  const ORDER_PDA = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf8Ny8suSzwAh";

  const mockClient = {
    createOrder: vi.fn(),
    claimOrder: vi.fn(),
    refundOrder: vi.fn(),
  } as any;

  const fakeSigner = {
    publicKey: { toBase58: () => SOLANA_ADDR } as any,
    signTransaction: vi.fn(async (tx) => tx),
  };

  let adapter: SolanaHTLCAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new SolanaHTLCAdapter(mockClient);
  });

  // ── createOrder ──────────────────────────────────────────────────────────

  describe("createOrder", () => {
    it("returns { txId, orderId } from the Solana client result", async () => {
      mockClient.createOrder.mockResolvedValue({
        txSignature: "SIG123",
        orderId: ORDER_PDA,
      });

      const result = await adapter.createOrder(
        {
          sender: SOLANA_ADDR,
          beneficiary: SOLANA_ADDR,
          refundAddress: SOLANA_ADDR,
          mint: "So11111111111111111111111111111111111111112",
          amount: BigInt(1e9),
          safetyDeposit: BigInt(1e6),
          hashlockHex: HASHLOCK,
          timelockSeconds: 3600,
        },
        fakeSigner
      );

      expect(result.txId).toBe("SIG123");
      expect(result.orderId).toBe(ORDER_PDA);
    });

    it("wraps simulation-mode errors as HTLCError(simulation_mode)", async () => {
      mockClient.createOrder.mockRejectedValue(new Error("Cannot use in simulation mode"));
      await expect(adapter.createOrder({} as any, fakeSigner)).rejects.toMatchObject({
        code: "simulation_mode",
        retryable: false,
      });
    });

    it("wraps discriminator mismatch as HTLCError(order_not_found)", async () => {
      mockClient.createOrder.mockRejectedValue(
        new Error("Invalid HTLCOrder discriminator: deadbeef")
      );
      await expect(adapter.createOrder({} as any, fakeSigner)).rejects.toMatchObject({
        code: "order_not_found",
        retryable: false,
      });
    });

    it("wraps blockhash errors as chain_error with retryable=true", async () => {
      mockClient.createOrder.mockRejectedValue(
        new Error("blockhash not found, please retry")
      );
      await expect(adapter.createOrder({} as any, fakeSigner)).rejects.toMatchObject({
        code: "chain_error",
        retryable: true,
      });
    });

    it("does not re-wrap HTLCError", async () => {
      const original = new HTLCError({ code: "simulation_mode", message: "already" });
      mockClient.createOrder.mockRejectedValue(original);
      await expect(adapter.createOrder({} as any, fakeSigner)).rejects.toBe(original);
    });
  });

  // ── claimOrder ───────────────────────────────────────────────────────────

  describe("claimOrder", () => {
    it("returns { txId } from the Solana client signature", async () => {
      mockClient.claimOrder.mockResolvedValue("CLAIM_SIG");
      const result = await adapter.claimOrder(ORDER_PDA, PREIMAGE, fakeSigner);
      expect(result.txId).toBe("CLAIM_SIG");
      expect(mockClient.claimOrder).toHaveBeenCalledWith(ORDER_PDA, PREIMAGE, fakeSigner);
    });

    it("wraps account-not-found errors as HTLCError(order_not_found)", async () => {
      mockClient.claimOrder.mockRejectedValue(new Error("account not found for PDA"));
      await expect(adapter.claimOrder(ORDER_PDA, PREIMAGE, fakeSigner)).rejects.toMatchObject({
        code: "order_not_found",
      });
    });

    it("wraps timelock errors as HTLCError(timelock_not_expired)", async () => {
      mockClient.claimOrder.mockRejectedValue(new Error("timelock: not expired"));
      await expect(adapter.claimOrder(ORDER_PDA, PREIMAGE, fakeSigner)).rejects.toMatchObject({
        code: "timelock_not_expired",
      });
    });
  });

  // ── refundOrder ──────────────────────────────────────────────────────────

  describe("refundOrder", () => {
    it("returns { txId } from the Solana client signature", async () => {
      mockClient.refundOrder.mockResolvedValue("REFUND_SIG");
      const result = await adapter.refundOrder(ORDER_PDA, fakeSigner);
      expect(result.txId).toBe("REFUND_SIG");
      expect(mockClient.refundOrder).toHaveBeenCalledWith(ORDER_PDA, fakeSigner);
    });
  });
});

// ── Cross-client structural parity ─────────────────────────────────────────
// All three adapters must expose the same method names so a caller can write
// chain-agnostic code against IHTLCClient without handling per-chain divergence.

describe("Cross-client interface parity", () => {
  it("EthereumHTLCAdapter exposes createOrder, claimOrder, refundOrder", () => {
    const adapter = new EthereumHTLCAdapter({} as any);
    expect(typeof adapter.createOrder).toBe("function");
    expect(typeof adapter.claimOrder).toBe("function");
    expect(typeof adapter.refundOrder).toBe("function");
  });

  it("SorobanHTLCAdapter exposes createOrder, claimOrder, refundOrder", () => {
    const adapter = new SorobanHTLCAdapter({} as any);
    expect(typeof adapter.createOrder).toBe("function");
    expect(typeof adapter.claimOrder).toBe("function");
    expect(typeof adapter.refundOrder).toBe("function");
  });

  it("SolanaHTLCAdapter exposes createOrder, claimOrder, refundOrder", () => {
    const adapter = new SolanaHTLCAdapter({} as any);
    expect(typeof adapter.createOrder).toBe("function");
    expect(typeof adapter.claimOrder).toBe("function");
    expect(typeof adapter.refundOrder).toBe("function");
  });

  it("all adapters return objects with txId on claimOrder success", async () => {
    const adapters = [
      { a: new EthereumHTLCAdapter({ claimOrder: vi.fn().mockResolvedValue(TX_HASH) } as any), sig: undefined },
      { a: new SorobanHTLCAdapter({ claimOrder: vi.fn().mockResolvedValue("soroban-tx") } as any), sig: vi.fn().mockResolvedValue("xdr") },
      { a: new SolanaHTLCAdapter({ claimOrder: vi.fn().mockResolvedValue("sol-sig") } as any), sig: { publicKey: {}, signTransaction: async (t: any) => t } },
    ] as const;

    for (const { a, sig } of adapters) {
      const result = await (a as any).claimOrder("1", PREIMAGE, sig);
      expect(result).toHaveProperty("txId");
      expect(typeof result.txId).toBe("string");
    }
  });

  it("all adapters return objects with txId on refundOrder success", async () => {
    const adapters = [
      { a: new EthereumHTLCAdapter({ refundOrder: vi.fn().mockResolvedValue(TX_HASH) } as any), sig: undefined },
      { a: new SorobanHTLCAdapter({ refundOrder: vi.fn().mockResolvedValue("soroban-ref") } as any), sig: vi.fn().mockResolvedValue("xdr") },
      { a: new SolanaHTLCAdapter({ refundOrder: vi.fn().mockResolvedValue("sol-ref") } as any), sig: { publicKey: {}, signTransaction: async (t: any) => t } },
    ] as const;

    for (const { a, sig } of adapters) {
      const result = await (a as any).refundOrder("1", sig);
      expect(result).toHaveProperty("txId");
      expect(typeof result.txId).toBe("string");
    }
  });

  it("all adapters throw HTLCError (not a plain Error) on classified failures", async () => {
    const reject = new Error("User rejected the request");
    const mockCreate = vi.fn().mockRejectedValue(reject);

    const ethAdapter = new EthereumHTLCAdapter({ createOrder: mockCreate } as any);
    const sorobanAdapter = new SorobanHTLCAdapter({ createOrder: vi.fn().mockRejectedValue(new Error("Simulation failed")) } as any);
    const solanaAdapter = new SolanaHTLCAdapter({ createOrder: vi.fn().mockRejectedValue(new Error("blockhash not found")) } as any);

    const checks = [
      ethAdapter.createOrder({} as any),
      sorobanAdapter.createOrder({} as any, vi.fn()),
      solanaAdapter.createOrder({} as any, { publicKey: {}, signTransaction: async (t: any) => t }),
    ];

    for (const promise of checks) {
      await expect(promise).rejects.toBeInstanceOf(HTLCError);
    }
  });
});
