/**
 * Normalised adapter for EthereumHTLCClient.
 *
 * Wraps the native viem-based client and implements the shared IHTLCClient
 * interface so multi-chain orchestration code can use all three chain clients
 * identically.
 *
 * Error mapping
 * ─────────────
 * viem simulation failures and wallet rejections are caught and re-thrown as
 * HTLCError instances with stable machine-readable codes. The original
 * low-level error is preserved in HTLCError.cause for debugging.
 */

import type { Hex } from "viem";
import { EthereumHTLCClient, type CreateOrderInput } from "./index.js";
import {
  HTLCError,
  type IHTLCClient,
  type HTLCCreateResult,
  type HTLCTxResult,
} from "../htlc-client.js";

// ── Error message heuristics ─────────────────────────────────────────────────
// viem surfaces contract revert reasons in the error message. We inspect the
// string rather than depend on a specific viem version's error class hierarchy.

function classifyViemError(err: unknown): HTLCError {
  const msg = err instanceof Error ? err.message : String(err);
  const lc = msg.toLowerCase();

  // ── wallet / signer ────────────────────────────────────────────────────────
  if (
    lc.includes("user rejected") ||
    lc.includes("rejected the request") ||
    lc.includes("wallet client") ||
    lc.includes("walletclient") ||
    lc.includes("signer")
  ) {
    return new HTLCError({
      code: "wallet_unavailable",
      message: "Wallet rejected or is unavailable: " + msg,
      retryable: true,
      cause: err,
    });
  }

  // ── timelock (check before generic simulation so "timelock not expired" wins)
  if (lc.includes("timelock") && (lc.includes("not expired") || lc.includes("active"))) {
    return new HTLCError({
      code: "timelock_not_expired",
      message: "Timelock has not yet expired: " + msg,
      retryable: false,
      cause: err,
    });
  }

  // ── preimage / hashlock (check before generic simulation so "invalid preimage" wins)
  if (lc.includes("invalid preimage") || lc.includes("hashlock")) {
    return new HTLCError({
      code: "invalid_preimage",
      message: "Preimage does not match the hashlock: " + msg,
      retryable: false,
      cause: err,
    });
  }

  // ── order not found ────────────────────────────────────────────────────────
  if (lc.includes("not found") || lc.includes("does not exist") || lc.includes("ordernotfound")) {
    return new HTLCError({
      code: "order_not_found",
      message: "Order not found on-chain: " + msg,
      retryable: false,
      cause: err,
    });
  }

  // ── ERC20 allowance too low ────────────────────────────────────────────────
  // HTLCEscrow reverts with InsufficientAllowance(allowance, required) when the
  // caller has not approved the escrow for at least `amount` of the ERC20 token.
  // Match both the typed Solidity error name and viem's decoded string form.
  if (lc.includes("insufficientallowance") || lc.includes("insufficient allowance")) {
    return new HTLCError({
      code: "insufficient_allowance",
      message: "ERC20 allowance is too low — call token.approve(escrow, amount) first: " + msg,
      retryable: false,
      cause: err,
    });
  }

  // ── resolver not authorised ────────────────────────────────────────────────
  // HTLCEscrow reverts with ResolverNotAuthorised when the caller is not listed
  // as active in the attached ResolverRegistry.
  if (lc.includes("resolvernotauthorised") || lc.includes("resolver not authorised") || lc.includes("resolver not authorized")) {
    return new HTLCError({
      code: "resolver_not_authorised",
      message: "Caller is not an active resolver — register in the ResolverRegistry first: " + msg,
      retryable: false,
      cause: err,
    });
  }

  // ── safety deposit too small ───────────────────────────────────────────────
  // HTLCEscrow reverts with SafetyDepositTooSmall when safetyDeposit < minSafetyDeposit.
  if (lc.includes("safetydeposittoosmall") || lc.includes("safety deposit too small")) {
    return new HTLCError({
      code: "safety_deposit_too_small",
      message: "Safety deposit is below the contract minimum — increase safetyDeposit: " + msg,
      retryable: false,
      cause: err,
    });
  }

  // ── simulation / contract revert ───────────────────────────────────────────
  // "simulat" matches both "simulate" and "simulation failed".
  // This check is intentionally last among the specific codes so that more
  // precise patterns above (invalid_preimage, timelock_not_expired,
  // insufficient_allowance, resolver_not_authorised, safety_deposit_too_small)
  // win when viem prefixes the message with "simulation: <specific reason>".
  if (
    lc.includes("simulat") ||
    lc.includes("insufficient balance") ||
    lc.includes("invalidtoken") ||
    lc.includes("invalidvalue") ||
    lc.includes("reverted")
  ) {
    return new HTLCError({
      code: "simulation_failed",
      message: "Contract simulation rejected the call: " + msg,
      retryable: false,
      cause: err,
    });
  }

  return new HTLCError({
    code: "chain_error",
    message: "Ethereum chain error: " + msg,
    // Timeouts / nonce conflicts / RPC errors are generally retryable
    retryable: lc.includes("timeout") || lc.includes("nonce") || lc.includes("network"),
    cause: err,
  });
}

// ── Adapter ──────────────────────────────────────────────────────────────────

/**
 * Normalised adapter that wraps `EthereumHTLCClient` and implements the
 * chain-agnostic `IHTLCClient` interface.
 *
 * The Ethereum client does not use an external signer callback — it reads the
 * walletClient passed at construction time. The `signer` parameter in the
 * interface methods is therefore ignored.
 */
export class EthereumHTLCAdapter
  implements IHTLCClient<CreateOrderInput, never>
{
  constructor(private readonly client: EthereumHTLCClient) {}

  /**
   * Lock funds on the Ethereum HTLCEscrow contract.
   *
   * @returns `{ txId, orderId }` where `orderId` is the uint256 id as a
   *          decimal string.
   */
  async createOrder(input: CreateOrderInput): Promise<HTLCCreateResult> {
    try {
      const { txHash, orderId } = await this.client.createOrder(input);
      return { txId: txHash, orderId: orderId.toString() };
    } catch (err) {
      if (err instanceof HTLCError) throw err;
      throw classifyViemError(err);
    }
  }

  /**
   * Claim a locked order by revealing the preimage.
   *
   * @param orderId  Decimal or hex string of the uint256 order id.
   * @param preimage 0x-prefixed 32-byte hex preimage.
   */
  async claimOrder(
    orderId: string,
    preimage: `0x${string}`
  ): Promise<HTLCTxResult> {
    try {
      const txHash = await this.client.claimOrder(BigInt(orderId), preimage as Hex);
      return { txId: txHash };
    } catch (err) {
      if (err instanceof HTLCError) throw err;
      throw classifyViemError(err);
    }
  }

  /**
   * Refund a locked order after the timelock has expired.
   *
   * @param orderId  Decimal or hex string of the uint256 order id.
   */
  async refundOrder(orderId: string): Promise<HTLCTxResult> {
    try {
      const txHash = await this.client.refundOrder(BigInt(orderId));
      return { txId: txHash };
    } catch (err) {
      if (err instanceof HTLCError) throw err;
      throw classifyViemError(err);
    }
  }
}
