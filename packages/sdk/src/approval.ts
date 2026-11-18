/**
 * Shared approval semantics for HTLC order creation across all supported chains.
 *
 * Problem
 * ───────
 * Each chain handles token custody authorisation differently:
 *
 * - **Ethereum (ERC20)**: the caller must call `token.approve(escrow, amount)`
 *   before calling `HTLCEscrow.createOrder`. Without approval the contract
 *   reverts with `InsufficientAllowance(allowance, required)`.
 *
 * - **Soroban / Stellar**: the Soroban token interface uses Soroban's built-in
 *   authorisation model. The SDK builds the necessary auth entries from the
 *   signer callback; no separate approve transaction is required.
 *
 * - **Solana (SPL)**: the Anchor program instruction builder includes the
 *   correct delegate authority in the instruction; no explicit approval step
 *   is needed from SDK callers.
 *
 * - **Native assets (ETH, XLM, SOL)**: never require approval — the value is
 *   included in the transaction's native value field.
 *
 * This module exposes:
 *   - `ApprovalRequirement` — the result of an approval check.
 *   - `APPROVAL_SEMANTICS` — per-chain description used for documentation,
 *     UI hints, and operator runbooks.
 *   - `normalizeApprovalMessage` — converts an `HTLCErrorCode` into an
 *     actionable human-readable message so frontends and service code present
 *     consistent guidance regardless of which adapter raised the error.
 *   - `isApprovalError` — predicate that identifies errors attributable to the
 *     approval flow so callers can separate them from other failures.
 */

import type { HTLCErrorCode } from "./htlc-client.js";

// ── Approval requirement ─────────────────────────────────────────────────────

/**
 * The result of checking whether a `createOrder` call requires a prior token
 * approval step.
 *
 * `needed === false` means the caller can proceed directly to `createOrder`
 * (either native asset, or allowance already sufficient).
 */
export interface ApprovalRequirement {
  /** Whether an approval transaction must be submitted before createOrder. */
  needed: boolean;
  /**
   * Address of the ERC20 token that needs approval.
   * Empty string when `needed` is false or for native assets.
   */
  tokenAddress: string;
  /**
   * Address of the contract that needs to be approved as a spender.
   * For Ethereum this is the HTLCEscrow address.
   */
  spender: string;
  /** Current allowance granted to `spender` (in token atomic units). */
  currentAllowance: bigint;
  /** Minimum allowance required to cover the order amount. */
  requiredAmount: bigint;
}

/** Approval is not needed (native asset or allowance already sufficient). */
export const NO_APPROVAL_NEEDED: ApprovalRequirement = {
  needed: false,
  tokenAddress: "",
  spender: "",
  currentAllowance: 0n,
  requiredAmount: 0n,
};

// ── Per-chain approval model documentation ───────────────────────────────────

/**
 * Describes how a chain handles token custody authorisation for HTLC order
 * creation.
 */
export interface ApprovalSemantics {
  /**
   * Canonical label for the authorisation model.
   *
   * - `erc20_approve`       — EIP-20 `approve(spender, amount)` must be called
   *                           before `createOrder` for non-native assets.
   * - `soroban_token_auth`  — Soroban's built-in contract auth model; no
   *                           separate approve transaction from SDK callers.
   * - `spl_delegate`        — SPL token delegate included in the Anchor ix;
   *                           no explicit approve step from SDK callers.
   * - `native_no_approval`  — Native assets (ETH, XLM, SOL) never need approval.
   */
  model:
    | "erc20_approve"
    | "soroban_token_auth"
    | "spl_delegate"
    | "native_no_approval";
  /**
   * Human-readable note for operators and frontend copy. Explains exactly what
   * callers must do (or not do) before calling `createOrder`.
   */
  note: string;
}

/**
 * Canonical per-chain approval semantics used by UI hints, operator runbooks,
 * and error message generation.
 */
export const APPROVAL_SEMANTICS: Record<
  "ethereum" | "soroban" | "solana",
  ApprovalSemantics
> = {
  ethereum: {
    model: "erc20_approve",
    note:
      "For ERC20 orders call `token.approve(htlcEscrowAddress, amount)` before " +
      "`createOrder`. Native ETH orders do not require approval — the value is " +
      "sent as `msg.value`. If approval is stale (allowance reduced since last " +
      "use) call `approve` again with the new amount.",
  },
  soroban: {
    model: "soroban_token_auth",
    note:
      "Soroban uses the token contract's built-in authorisation flow. The SDK " +
      "signer callback attaches the required `invoke_contract` auth entries " +
      "automatically. No separate approve transaction is needed from callers.",
  },
  solana: {
    model: "spl_delegate",
    note:
      "The Anchor program instruction builder includes the correct delegate " +
      "authority in the instruction accounts. SDK callers do not need to " +
      "issue a separate SPL `approve` instruction before calling `createOrder`.",
  },
};

// ── Error helpers ────────────────────────────────────────────────────────────

/**
 * Returns `true` when the given error code is attributable to the token
 * approval flow. Callers can use this to distinguish approval failures from
 * other `simulation_failed` or `chain_error` cases.
 */
export function isApprovalError(code: HTLCErrorCode): boolean {
  return code === "insufficient_allowance" || code === "safety_deposit_too_small";
}

/**
 * Convert an `HTLCErrorCode` into an actionable, chain-specific message that
 * frontends and service code can surface to operators without leaking raw
 * contract error strings.
 *
 * @param code    The error code from the thrown `HTLCError`.
 * @param chain   The chain on which the error occurred.
 * @param details Optional raw detail string to append (e.g. allowance values).
 */
export function normalizeApprovalMessage(
  code: HTLCErrorCode,
  chain: "ethereum" | "soroban" | "solana",
  details?: string
): string {
  const suffix = details ? ` (${details})` : "";

  switch (code) {
    case "insufficient_allowance":
      if (chain === "ethereum") {
        return (
          "ERC20 allowance is insufficient. Call " +
          "`token.approve(htlcEscrowAddress, amount)` and retry." +
          suffix
        );
      }
      return "Token approval is insufficient for this chain." + suffix;

    case "safety_deposit_too_small":
      return (
        "The safety deposit is below the contract minimum. " +
        "Increase `safetyDeposit` to at least `minSafetyDeposit`." +
        suffix
      );

    case "resolver_not_authorised":
      return (
        "This address is not registered as an active resolver. " +
        "Stake and register in the ResolverRegistry before creating orders." +
        suffix
      );

    case "simulation_failed":
      return (
        "Transaction simulation failed. " +
        (chain === "ethereum"
          ? "Check ERC20 allowance and balance, then retry. " + APPROVAL_SEMANTICS.ethereum.note
          : APPROVAL_SEMANTICS[chain].note) +
        suffix
      );

    default:
      return details ?? String(code);
  }
}
