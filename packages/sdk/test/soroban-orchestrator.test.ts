/**
 * Tests for the Soroban transaction orchestration layer.
 *
 * Covered:
 *  - Happy path: build → simulate → assemble → sign → submit → poll
 *  - Retry on transient simulation RPC error
 *  - Retry on TRY_AGAIN_LATER submission status
 *  - tx_bad_seq: sequence refresh and fresh buildTx on retry
 *  - tx_insufficient_fee: fee-bump within cap succeeds
 *  - tx_insufficient_fee: fee-bump cap exceeded throws HTLCError(tx_rejected)
 *  - Multiple successive fee-bumps recorded in feeBumpHistory
 *  - Terminal submission error (tx_failed)
 *  - Polling: SUCCESS after NOT_FOUND attempts
 *  - Polling: FAILED surfaces HTLCError(tx_rejected)
 *  - Polling timeout surfaces HTLCError(chain_error, retryable=true)
 *  - Transient poll RPC errors are swallowed and retried
 *  - Signer rejection surfaces HTLCError(wallet_unavailable)
 *  - submissionMeta carries attempt count, feeBumpHistory, lastHash
 *  - Max retries exhausted on persistent transient failure
 *  - DUPLICATE treated like PENDING (poll for status)
 *  - Simulation failure is terminal (not retried)
 *  - SorobanHTLCAdapter: createOrder / claimOrder / refundOrder compatibility
 *  - Adapter config overrides forwarded to client
 *  - Error metadata preserved through adapter
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  orchestrateTransaction,
  type OrchestrateOptions,
  type OrchestrationConfig,
} from "../src/soroban/orchestrator.js";
import {
  SorobanHTLCAdapter,
  encodeSorobanOrderRef,
  decodeSorobanOrderRef,
} from "../src/soroban/adapter.js";
import { HTLCError } from "../src/htlc-client.js";

// ── Test doubles ──────────────────────────────────────────────────────────────

const TX_HASH = "a".repeat(64);
const STELLAR_ADDR = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422";

function makeFakeTx(fee = "1000"): any {
  return { fee, toXDR: () => "fake-xdr", operations: [{}] };
}

function makeFakeFeeBump(fee = "2000"): any {
  return { fee, toXDR: () => "fee-bump-xdr" };
}

function makeSuccessGetTx(ledger = 42): any {
  return { status: "SUCCESS", ledger, resultXdr: { toXDR: () => "result-xdr-base64" } };
}

function makeFailedGetTx(): any {
  return { status: "FAILED", ledger: 1, resultXdr: { toXDR: () => "failed-xdr-base64" } };
}

function makeBadSeqErrorResult(): any {
  return {
    toXDR: () => "",
    result: () => ({ switch: () => ({ name: "txBadSeq" }) }),
  };
}

function makeInsufficientFeeErrorResult(): any {
  return {
    toXDR: () => "",
    result: () => ({ switch: () => ({ name: "txInsufficientFee" }) }),
  };
}

function makeTxFailedErrorResult(): any {
  return {
    toXDR: () => "failed-envelope-xdr",
    result: () => ({ switch: () => ({ name: "txFailed" }) }),
  };
}

/** Mock RPC server with sensible happy-path defaults. */
function makeMockServer(overrides: Partial<Record<string, ReturnType<typeof vi.fn>>> = {}): any {
  return {
    getAccount: vi.fn().mockResolvedValue({ id: STELLAR_ADDR }),
    simulateTransaction: vi.fn().mockResolvedValue({ minResourceFee: "500" }),
    sendTransaction: vi.fn().mockResolvedValue({ status: "PENDING", hash: TX_HASH }),
    getTransaction: vi.fn().mockResolvedValue(makeSuccessGetTx()),
    ...overrides,
  };
}

/** Stable injected SDK overrides that bypass the real stellar-sdk. */
function makeSdkOverrides() {
  return {
    _assembleTransaction: vi.fn().mockReturnValue({ build: () => makeFakeTx() }),
    _fromXDR: vi.fn().mockReturnValue(makeFakeTx()),
    _buildFeeBumpTransaction: vi.fn().mockReturnValue(makeFakeFeeBump()),
  };
}

const DEFAULT_CONFIG: OrchestrationConfig = {
  maxRetries: 3,
  retryDelayMs: 0,
  pollingIntervalMs: 0,
  pollingTimeoutMs: 5_000,
  feeBumpCap: 10_000,
  feeBumpMultiplier: 2,
};

function makeOptions(
  overrides: Partial<OrchestrateOptions> & { serverOverrides?: Partial<Record<string, any>> } = {}
): OrchestrateOptions {
  const { serverOverrides, ...rest } = overrides;
  return {
    server: makeMockServer(serverOverrides ?? {}),
    networkPassphrase: "Test SDF Network ; September 2015",
    signer: vi.fn().mockResolvedValue("signed-xdr"),
    sourceAccountId: STELLAR_ADDR,
    buildTx: vi.fn().mockResolvedValue(makeFakeTx()),
    config: DEFAULT_CONFIG,
    ...makeSdkOverrides(),
    ...rest,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("orchestrateTransaction", () => {
  beforeEach(() => vi.clearAllMocks());

  // ── Happy path ──────────────────────────────────────────────────────────────

  describe("happy path", () => {
    it("returns hash, ledger, resultXdr (string), and meta on first-attempt success", async () => {
      const result = await orchestrateTransaction(makeOptions());

      expect(result.hash).toBe(TX_HASH);
      expect(result.ledger).toBe(42);
      expect(typeof result.resultXdr).toBe("string");
      expect(result.meta.attempts).toBe(1);
      expect(result.meta.feeBumpHistory).toHaveLength(0);
      expect(result.meta.lastHash).toBe(TX_HASH);
    });

    it("calls pipeline steps in correct order", async () => {
      const calls: string[] = [];
      const buildTx = vi.fn().mockImplementation(async () => { calls.push("build"); return makeFakeTx(); });
      const signer = vi.fn().mockImplementation(async () => { calls.push("sign"); return "signed"; });
      const server = makeMockServer({
        simulateTransaction: vi.fn().mockImplementation(async () => { calls.push("simulate"); return {}; }),
        sendTransaction: vi.fn().mockImplementation(async () => { calls.push("submit"); return { status: "PENDING", hash: TX_HASH }; }),
        getTransaction: vi.fn().mockImplementation(async () => { calls.push("poll"); return makeSuccessGetTx(); }),
      });

      await orchestrateTransaction({ ...makeOptions(), server, buildTx, signer });

      expect(calls).toEqual(["build", "simulate", "sign", "submit", "poll"]);
    });

    it("passes sourceAccountId to signer", async () => {
      const signer = vi.fn().mockResolvedValue("signed");
      await orchestrateTransaction(makeOptions({ signer }));
      expect(signer).toHaveBeenCalledWith(
        expect.objectContaining({ publicKey: STELLAR_ADDR }),
      );
    });
  });

  // ── Retry on transient simulation RPC error ─────────────────────────────────

  describe("transient simulation RPC error", () => {
    it("retries and succeeds on second attempt", async () => {
      const opts = makeOptions({
        serverOverrides: {
          simulateTransaction: vi.fn()
            .mockRejectedValueOnce(new Error("network timeout"))
            .mockResolvedValue({}),
        },
      });
      const result = await orchestrateTransaction(opts);
      expect(result.meta.attempts).toBe(2);
    });

    it("throws chain_error after all retries exhausted on persistent RPC failure", async () => {
      const opts = makeOptions({
        serverOverrides: {
          simulateTransaction: vi.fn().mockRejectedValue(new Error("timeout")),
        },
      });
      const err = await orchestrateTransaction(opts).catch((e) => e);
      expect(err).toBeInstanceOf(HTLCError);
      expect(err.code).toBe("chain_error");
      expect(err.submissionMeta?.attempts).toBe(3);
    });
  });

  // ── Retry on TRY_AGAIN_LATER ────────────────────────────────────────────────

  describe("TRY_AGAIN_LATER", () => {
    it("retries and succeeds when next attempt returns PENDING", async () => {
      const opts = makeOptions({
        serverOverrides: {
          sendTransaction: vi.fn()
            .mockResolvedValueOnce({ status: "TRY_AGAIN_LATER", hash: TX_HASH })
            .mockResolvedValue({ status: "PENDING", hash: TX_HASH }),
        },
      });
      const result = await orchestrateTransaction(opts);
      expect(result.meta.attempts).toBe(2);
    });

    it("throws chain_error after max retries on persistent TRY_AGAIN_LATER", async () => {
      const opts = makeOptions({
        serverOverrides: {
          sendTransaction: vi.fn().mockResolvedValue({ status: "TRY_AGAIN_LATER", hash: TX_HASH }),
        },
      });
      await expect(orchestrateTransaction(opts)).rejects.toMatchObject({ code: "chain_error" });
    });
  });

  // ── tx_bad_seq ──────────────────────────────────────────────────────────────

  describe("tx_bad_seq", () => {
    it("calls buildTx again (fresh sequence) after tx_bad_seq, then succeeds", async () => {
      const buildTx = vi.fn()
        .mockResolvedValueOnce(makeFakeTx())
        .mockResolvedValue(makeFakeTx());

      const opts = makeOptions({
        buildTx,
        serverOverrides: {
          sendTransaction: vi.fn()
            .mockResolvedValueOnce({ status: "ERROR", hash: TX_HASH, errorResult: makeBadSeqErrorResult() })
            .mockResolvedValue({ status: "PENDING", hash: TX_HASH }),
        },
      });

      const result = await orchestrateTransaction(opts);
      expect(buildTx).toHaveBeenCalledTimes(2);
      expect(result.meta.attempts).toBe(2);
    });

    it("throws tx_rejected with attempt count after max retries on persistent tx_bad_seq", async () => {
      const opts = makeOptions({
        serverOverrides: {
          sendTransaction: vi.fn().mockResolvedValue({
            status: "ERROR",
            hash: TX_HASH,
            errorResult: makeBadSeqErrorResult(),
          }),
        },
      });
      await expect(orchestrateTransaction(opts)).rejects.toMatchObject({
        code: "tx_rejected",
        submissionMeta: expect.objectContaining({ attempts: 3 }),
      });
    });
  });

  // ── tx_insufficient_fee / fee-bump ──────────────────────────────────────────

  describe("tx_insufficient_fee", () => {
    it("fee-bumps once and succeeds when bumped fee is within cap", async () => {
      const opts = makeOptions({
        serverOverrides: {
          sendTransaction: vi.fn()
            .mockResolvedValueOnce({ status: "ERROR", hash: TX_HASH, errorResult: makeInsufficientFeeErrorResult() })
            .mockResolvedValue({ status: "PENDING", hash: TX_HASH }),
        },
      });
      const result = await orchestrateTransaction(opts);
      expect(result.meta.feeBumpHistory).toHaveLength(1);
    });

    it("records the bumped fee in feeBumpHistory", async () => {
      const opts = makeOptions({
        serverOverrides: {
          sendTransaction: vi.fn()
            .mockResolvedValueOnce({ status: "ERROR", hash: TX_HASH, errorResult: makeInsufficientFeeErrorResult() })
            .mockResolvedValue({ status: "PENDING", hash: TX_HASH }),
        },
        config: { ...DEFAULT_CONFIG, feeBumpMultiplier: 3 },
      });
      const result = await orchestrateTransaction(opts);
      // Initial fee from makeFakeTx is 1000; multiplier 3 → 3000
      expect(result.meta.feeBumpHistory[0]).toBe(3000);
    });

    it("throws tx_rejected immediately when bumped fee would exceed cap", async () => {
      const opts = makeOptions({
        serverOverrides: {
          sendTransaction: vi.fn().mockResolvedValue({
            status: "ERROR",
            hash: TX_HASH,
            errorResult: makeInsufficientFeeErrorResult(),
          }),
        },
        // Fee 1000 × 2 = 2000, cap is 500 → cap exceeded
        config: { ...DEFAULT_CONFIG, feeBumpCap: 500, feeBumpMultiplier: 2 },
      });
      const err = await orchestrateTransaction(opts).catch((e) => e);
      expect(err.code).toBe("tx_rejected");
      expect(err.submissionMeta?.feeBumpHistory).toHaveLength(0);
    });

    it("records multiple fee-bumps for successive tx_insufficient_fee rejections", async () => {
      const opts = makeOptions({
        serverOverrides: {
          sendTransaction: vi.fn()
            .mockResolvedValueOnce({ status: "ERROR", hash: TX_HASH, errorResult: makeInsufficientFeeErrorResult() })
            .mockResolvedValueOnce({ status: "ERROR", hash: TX_HASH, errorResult: makeInsufficientFeeErrorResult() })
            .mockResolvedValue({ status: "PENDING", hash: TX_HASH }),
        },
        config: { ...DEFAULT_CONFIG, feeBumpCap: 100_000, feeBumpMultiplier: 2 },
      });
      const result = await orchestrateTransaction(opts);
      expect(result.meta.feeBumpHistory).toHaveLength(2);
      // First bump: 1000 × 2 = 2000; second: 2000 × 2 = 4000
      expect(result.meta.feeBumpHistory).toEqual([2000, 4000]);
    });

    it("signs the fee-bump transaction via the signer", async () => {
      const signer = vi.fn().mockResolvedValue("signed-xdr");
      const opts = makeOptions({
        signer,
        serverOverrides: {
          sendTransaction: vi.fn()
            .mockResolvedValueOnce({ status: "ERROR", hash: TX_HASH, errorResult: makeInsufficientFeeErrorResult() })
            .mockResolvedValue({ status: "PENDING", hash: TX_HASH }),
        },
      });
      await orchestrateTransaction(opts);
      // Called twice: once for the original tx, once for the fee-bump
      expect(signer).toHaveBeenCalledTimes(2);
    });

    it("throws wallet_unavailable when signer rejects the fee-bump", async () => {
      const signer = vi.fn()
        .mockResolvedValueOnce("signed-xdr")
        .mockRejectedValue(new Error("User cancelled fee bump"));

      const opts = makeOptions({
        signer,
        serverOverrides: {
          sendTransaction: vi.fn().mockResolvedValue({
            status: "ERROR",
            hash: TX_HASH,
            errorResult: makeInsufficientFeeErrorResult(),
          }),
        },
        config: { ...DEFAULT_CONFIG, feeBumpCap: 100_000 },
      });

      await expect(orchestrateTransaction(opts)).rejects.toMatchObject({
        code: "wallet_unavailable",
      });
    });
  });

  // ── Terminal submission error ────────────────────────────────────────────────

  describe("terminal submission error", () => {
    it("throws tx_rejected immediately for tx_failed without retrying", async () => {
      const sendTransaction = vi.fn().mockResolvedValue({
        status: "ERROR",
        hash: TX_HASH,
        errorResult: makeTxFailedErrorResult(),
      });
      const opts = makeOptions({ serverOverrides: { sendTransaction } });

      await expect(orchestrateTransaction(opts)).rejects.toMatchObject({
        code: "tx_rejected",
        retryable: false,
      });
      // Only one attempt — terminal errors are not retried
      expect(sendTransaction).toHaveBeenCalledTimes(1);
    });
  });

  // ── Funding / balance errors (#706) ──────────────────────────────────────────

  describe("tx_insufficient_balance", () => {
    function makeInsufficientBalanceResult(): any {
      return {
        toXDR: () => "",
        result: () => ({ switch: () => ({ name: "txInsufficientBalance" }) }),
      };
    }

    it("throws tx_rejected with a balance guidance message without retrying", async () => {
      const sendTransaction = vi.fn().mockResolvedValue({
        status: "ERROR",
        hash: TX_HASH,
        errorResult: makeInsufficientBalanceResult(),
      });
      const opts = makeOptions({ serverOverrides: { sendTransaction } });

      const err = await orchestrateTransaction(opts).catch((e) => e);
      expect(err.code).toBe("tx_rejected");
      expect(err.retryable).toBe(false);
      expect(err.message).toMatch(/insufficient.*balance/i);
      // Balance errors are not retried — no point without external remediation.
      expect(sendTransaction).toHaveBeenCalledTimes(1);
    });

    it("error message names the source account for operator diagnosis", async () => {
      const opts = makeOptions({
        sourceAccountId: "GBALANCE123",
        serverOverrides: {
          sendTransaction: vi.fn().mockResolvedValue({
            status: "ERROR",
            hash: TX_HASH,
            errorResult: makeInsufficientBalanceResult(),
          }),
        },
      });
      const err = await orchestrateTransaction(opts).catch((e) => e);
      expect(err.message).toContain("GBALANCE123");
    });
  });

  // ── Bad auth / mis-signed transactions (#706) ────────────────────────────────

  describe("tx_bad_auth", () => {
    function makeBadAuthErrorResult(): any {
      return {
        toXDR: () => "",
        result: () => ({ switch: () => ({ name: "txBadAuth" }) }),
      };
    }

    it("throws tx_rejected with an auth guidance message without retrying", async () => {
      const sendTransaction = vi.fn().mockResolvedValue({
        status: "ERROR",
        hash: TX_HASH,
        errorResult: makeBadAuthErrorResult(),
      });
      const opts = makeOptions({ serverOverrides: { sendTransaction } });

      const err = await orchestrateTransaction(opts).catch((e) => e);
      expect(err.code).toBe("tx_rejected");
      expect(err.retryable).toBe(false);
      expect(err.message).toMatch(/bad auth/i);
      expect(sendTransaction).toHaveBeenCalledTimes(1);
    });

    it("error message names the source account", async () => {
      const opts = makeOptions({
        sourceAccountId: "GBADKEY456",
        serverOverrides: {
          sendTransaction: vi.fn().mockResolvedValue({
            status: "ERROR",
            hash: TX_HASH,
            errorResult: makeBadAuthErrorResult(),
          }),
        },
      });
      const err = await orchestrateTransaction(opts).catch((e) => e);
      expect(err.message).toContain("GBADKEY456");
    });
  });

  // ── Polling ─────────────────────────────────────────────────────────────────

  describe("status polling", () => {
    it("polls until SUCCESS after several NOT_FOUND responses", async () => {
      const getTransaction = vi.fn()
        .mockResolvedValueOnce({ status: "NOT_FOUND" })
        .mockResolvedValueOnce({ status: "NOT_FOUND" })
        .mockResolvedValue(makeSuccessGetTx(99));

      const opts = makeOptions({ serverOverrides: { getTransaction } });
      const result = await orchestrateTransaction(opts);

      expect(result.ledger).toBe(99);
      expect(getTransaction).toHaveBeenCalledTimes(3);
    });

    it("surfaces tx_rejected when poll returns FAILED", async () => {
      const opts = makeOptions({
        serverOverrides: { getTransaction: vi.fn().mockResolvedValue(makeFailedGetTx()) },
      });
      await expect(orchestrateTransaction(opts)).rejects.toMatchObject({
        code: "tx_rejected",
        retryable: false,
        submissionMeta: expect.objectContaining({ lastHash: TX_HASH }),
      });
    });

    it("surfaces chain_error with retryable=true on polling timeout", async () => {
      const opts = makeOptions({
        serverOverrides: { getTransaction: vi.fn().mockResolvedValue({ status: "NOT_FOUND" }) },
        config: { ...DEFAULT_CONFIG, pollingTimeoutMs: 1, pollingIntervalMs: 0 },
      });
      await expect(orchestrateTransaction(opts)).rejects.toMatchObject({
        code: "chain_error",
        retryable: true,
      });
    });

    it("continues polling through transient getTransaction RPC errors", async () => {
      const getTransaction = vi.fn()
        .mockRejectedValueOnce(new Error("network blip"))
        .mockResolvedValue(makeSuccessGetTx(7));

      const opts = makeOptions({ serverOverrides: { getTransaction } });
      const result = await orchestrateTransaction(opts);
      expect(result.ledger).toBe(7);
    });
  });

  // ── DUPLICATE status ────────────────────────────────────────────────────────

  describe("DUPLICATE status", () => {
    it("treats DUPLICATE like PENDING and polls for final status", async () => {
      const opts = makeOptions({
        serverOverrides: {
          sendTransaction: vi.fn().mockResolvedValue({ status: "DUPLICATE", hash: TX_HASH }),
          getTransaction: vi.fn().mockResolvedValue(makeSuccessGetTx(5)),
        },
      });
      const result = await orchestrateTransaction(opts);
      expect(result.ledger).toBe(5);
    });
  });

  // ── Simulation failure (terminal) ───────────────────────────────────────────

  describe("simulation failure", () => {
    it("throws simulation_failed immediately without retrying", async () => {
      const simulateTransaction = vi.fn().mockResolvedValue({ error: "InsufficientBalance" });
      const opts = makeOptions({ serverOverrides: { simulateTransaction } });

      const err = await orchestrateTransaction(opts).catch((e) => e);
      expect(err.code).toBe("simulation_failed");
      expect(err.retryable).toBe(false);
      // Only called once — simulation failures are not retried
      expect(simulateTransaction).toHaveBeenCalledTimes(1);
    });
  });

  // ── Signer rejection ────────────────────────────────────────────────────────

  describe("signer rejection", () => {
    it("throws wallet_unavailable when signer throws for the initial tx", async () => {
      const signer = vi.fn().mockRejectedValue(new Error("User cancelled"));
      await expect(orchestrateTransaction(makeOptions({ signer }))).rejects.toMatchObject({
        code: "wallet_unavailable",
        retryable: false,
      });
    });
  });

  // ── submissionMeta ──────────────────────────────────────────────────────────

  describe("submissionMeta", () => {
    it("carries attempts=1 and empty feeBumpHistory on first-attempt success", async () => {
      const result = await orchestrateTransaction(makeOptions());
      expect(result.meta).toMatchObject({ attempts: 1, feeBumpHistory: [], lastHash: TX_HASH });
    });

    it("carries attempt count in errors thrown after retries are exhausted", async () => {
      const opts = makeOptions({
        serverOverrides: {
          simulateTransaction: vi.fn().mockRejectedValue(new Error("timeout")),
        },
      });
      const err = await orchestrateTransaction(opts).catch((e) => e);
      expect(err.submissionMeta?.attempts).toBe(3);
    });

    it("carries lastHash for the last submitted transaction", async () => {
      const result = await orchestrateTransaction(makeOptions());
      expect(result.meta.lastHash).toBe(TX_HASH);
    });
  });

  // ── Max retries exhausted ───────────────────────────────────────────────────

  describe("max retries exhausted", () => {
    it("attempts exactly maxRetries times before throwing", async () => {
      const buildTx = vi.fn().mockResolvedValue(makeFakeTx());
      const opts = makeOptions({
        buildTx,
        serverOverrides: {
          simulateTransaction: vi.fn().mockRejectedValue(new Error("persistent rpc failure")),
        },
        config: { ...DEFAULT_CONFIG, maxRetries: 5 },
      });
      await orchestrateTransaction(opts).catch(() => {});
      expect(buildTx).toHaveBeenCalledTimes(5);
    });
  });
});

// ── SorobanHTLCAdapter compatibility ──────────────────────────────────────────

describe("SorobanHTLCAdapter", () => {
  const PREIMAGE = ("0x" + "cd".repeat(32)) as `0x${string}`;

  function makeMockClient(overrides: Partial<Record<string, ReturnType<typeof vi.fn>>> = {}): any {
    return {
      createOrder: vi.fn().mockResolvedValue(TX_HASH),
      claimOrder: vi.fn().mockResolvedValue(TX_HASH),
      refundOrder: vi.fn().mockResolvedValue(TX_HASH),
      ...overrides,
    };
  }

  const fakeSigner = vi.fn().mockResolvedValue("signed-xdr");

  beforeEach(() => vi.clearAllMocks());

  describe("createOrder", () => {
    it("returns { txId, orderId } where orderId encodes caller + txHash", async () => {
      const adapter = new SorobanHTLCAdapter(makeMockClient());
      const result = await adapter.createOrder({ sender: STELLAR_ADDR } as any, fakeSigner);

      expect(result.txId).toBe(TX_HASH);
      const { callerAccountId, numericId } = decodeSorobanOrderRef(result.orderId);
      expect(callerAccountId).toBe(STELLAR_ADDR);
      expect(numericId).toBe(TX_HASH);
    });

    it("passes orchestration config override to client.createOrder", async () => {
      const client = makeMockClient();
      const config: OrchestrationConfig = { maxRetries: 5 };
      const adapter = new SorobanHTLCAdapter(client, config);
      await adapter.createOrder({ sender: STELLAR_ADDR } as any, fakeSigner);
      expect(client.createOrder).toHaveBeenCalledWith(
        expect.anything(),
        fakeSigner,
        config,
      );
    });

    it("does not re-wrap an HTLCError", async () => {
      const original = new HTLCError({ code: "chain_error", message: "already" });
      const client = makeMockClient({ createOrder: vi.fn().mockRejectedValue(original) });
      await expect(
        new SorobanHTLCAdapter(client).createOrder({} as any, fakeSigner),
      ).rejects.toBe(original);
    });

    it("wraps plain simulation errors as HTLCError(simulation_failed)", async () => {
      const client = makeMockClient({
        createOrder: vi.fn().mockRejectedValue(new Error("Simulation failed: contract error")),
      });
      await expect(
        new SorobanHTLCAdapter(client).createOrder({ sender: STELLAR_ADDR } as any, fakeSigner),
      ).rejects.toMatchObject({ code: "simulation_failed" });
    });
  });

  describe("claimOrder", () => {
    it("decodes order ref and forwards callerAccountId + BigInt(orderId) to client", async () => {
      const client = makeMockClient();
      const adapter = new SorobanHTLCAdapter(client);
      const ref = encodeSorobanOrderRef(STELLAR_ADDR, 7);
      const result = await adapter.claimOrder(ref, PREIMAGE, fakeSigner);

      expect(result.txId).toBe(TX_HASH);
      expect(client.claimOrder).toHaveBeenCalledWith(
        STELLAR_ADDR, BigInt(7), PREIMAGE, fakeSigner, undefined,
      );
    });

    it("passes adapter config to client.claimOrder", async () => {
      const client = makeMockClient();
      const config: OrchestrationConfig = { pollingIntervalMs: 500 };
      const adapter = new SorobanHTLCAdapter(client, config);
      const ref = encodeSorobanOrderRef(STELLAR_ADDR, 3);
      await adapter.claimOrder(ref, PREIMAGE, fakeSigner);
      expect(client.claimOrder).toHaveBeenCalledWith(
        STELLAR_ADDR, BigInt(3), PREIMAGE, fakeSigner, config,
      );
    });

    it("handles a plain numeric orderId without separator", async () => {
      const client = makeMockClient();
      await new SorobanHTLCAdapter(client).claimOrder("5", PREIMAGE, fakeSigner);
      expect(client.claimOrder).toHaveBeenCalledWith("", BigInt(5), PREIMAGE, fakeSigner, undefined);
    });
  });

  describe("refundOrder", () => {
    it("decodes order ref and forwards to client.refundOrder", async () => {
      const client = makeMockClient();
      const adapter = new SorobanHTLCAdapter(client);
      const ref = encodeSorobanOrderRef(STELLAR_ADDR, 99);
      const result = await adapter.refundOrder(ref, fakeSigner);

      expect(result.txId).toBe(TX_HASH);
      expect(client.refundOrder).toHaveBeenCalledWith(
        STELLAR_ADDR, BigInt(99), fakeSigner, undefined,
      );
    });
  });

  describe("error metadata", () => {
    it("HTLCError from orchestration carries submissionMeta through the adapter", async () => {
      const meta = { attempts: 2, feeBumpHistory: [2000], lastHash: TX_HASH };
      const err = new HTLCError({ code: "tx_rejected", message: "fee cap", submissionMeta: meta });
      const client = makeMockClient({ createOrder: vi.fn().mockRejectedValue(err) });

      let caught: HTLCError | undefined;
      try {
        await new SorobanHTLCAdapter(client).createOrder({} as any, fakeSigner);
      } catch (e) {
        caught = e as HTLCError;
      }
      expect(caught?.submissionMeta).toEqual(meta);
    });
  });
});

// ── Order ref encoding helpers ─────────────────────────────────────────────────

describe("encodeSorobanOrderRef / decodeSorobanOrderRef", () => {
  it("round-trips accountId and numeric id", () => {
    const ref = encodeSorobanOrderRef(STELLAR_ADDR, 42);
    const { callerAccountId, numericId } = decodeSorobanOrderRef(ref);
    expect(callerAccountId).toBe(STELLAR_ADDR);
    expect(numericId).toBe("42");
  });

  it("handles a plain numeric string without separator", () => {
    const { callerAccountId, numericId } = decodeSorobanOrderRef("99");
    expect(callerAccountId).toBe("");
    expect(numericId).toBe("99");
  });

  it("accepts bigint orderId", () => {
    const ref = encodeSorobanOrderRef(STELLAR_ADDR, BigInt(12345678));
    expect(ref).toContain("12345678");
  });

  it("encodes bigint as string without scientific notation", () => {
    const big = BigInt("999999999999999");
    const ref = encodeSorobanOrderRef(STELLAR_ADDR, big);
    expect(ref).not.toContain("e+");
  });
});
