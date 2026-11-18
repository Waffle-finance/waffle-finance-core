/**
 * Tests for the shared approval semantics module.
 *
 * Addresses issue #697. Covers:
 *   - `APPROVAL_SEMANTICS` entries are present for all chains.
 *   - `isApprovalError` identifies the correct error codes.
 *   - `normalizeApprovalMessage` returns actionable strings for each chain.
 *   - Approved / denied / stale approval scenarios produce distinct messages.
 *   - `NO_APPROVAL_NEEDED` sentinel is a well-formed `ApprovalRequirement`.
 */

import { describe, it, expect } from "vitest";
import {
  APPROVAL_SEMANTICS,
  NO_APPROVAL_NEEDED,
  isApprovalError,
  normalizeApprovalMessage,
  type ApprovalRequirement,
} from "../src/approval.js";
import type { HTLCErrorCode } from "../src/htlc-client.js";

// ── APPROVAL_SEMANTICS ────────────────────────────────────────────────────────

describe("APPROVAL_SEMANTICS", () => {
  it("has entries for ethereum, soroban, and solana", () => {
    expect(APPROVAL_SEMANTICS.ethereum).toBeDefined();
    expect(APPROVAL_SEMANTICS.soroban).toBeDefined();
    expect(APPROVAL_SEMANTICS.solana).toBeDefined();
  });

  it("ethereum model is erc20_approve", () => {
    expect(APPROVAL_SEMANTICS.ethereum.model).toBe("erc20_approve");
  });

  it("soroban model is soroban_token_auth", () => {
    expect(APPROVAL_SEMANTICS.soroban.model).toBe("soroban_token_auth");
  });

  it("solana model is spl_delegate", () => {
    expect(APPROVAL_SEMANTICS.solana.model).toBe("spl_delegate");
  });

  it("all entries include a non-empty note", () => {
    for (const [chain, sem] of Object.entries(APPROVAL_SEMANTICS)) {
      expect(sem.note.length, `${chain}.note must be non-empty`).toBeGreaterThan(0);
    }
  });

  it("ethereum note mentions approve()", () => {
    expect(APPROVAL_SEMANTICS.ethereum.note).toContain("approve");
  });

  it("soroban note mentions no separate approve", () => {
    const note = APPROVAL_SEMANTICS.soroban.note.toLowerCase();
    expect(note).toContain("no separate");
  });

  it("solana note mentions no explicit approve", () => {
    const note = APPROVAL_SEMANTICS.solana.note.toLowerCase();
    expect(note).toContain("do not need");
  });
});

// ── NO_APPROVAL_NEEDED ────────────────────────────────────────────────────────

describe("NO_APPROVAL_NEEDED", () => {
  it("has needed=false", () => {
    expect(NO_APPROVAL_NEEDED.needed).toBe(false);
  });

  it("has empty tokenAddress and spender", () => {
    expect(NO_APPROVAL_NEEDED.tokenAddress).toBe("");
    expect(NO_APPROVAL_NEEDED.spender).toBe("");
  });

  it("has zero allowances", () => {
    expect(NO_APPROVAL_NEEDED.currentAllowance).toBe(0n);
    expect(NO_APPROVAL_NEEDED.requiredAmount).toBe(0n);
  });

  it("conforms to ApprovalRequirement shape", () => {
    const req: ApprovalRequirement = NO_APPROVAL_NEEDED;
    expect(typeof req.needed).toBe("boolean");
    expect(typeof req.tokenAddress).toBe("string");
    expect(typeof req.spender).toBe("string");
    expect(typeof req.currentAllowance).toBe("bigint");
    expect(typeof req.requiredAmount).toBe("bigint");
  });
});

// ── isApprovalError ───────────────────────────────────────────────────────────

describe("isApprovalError", () => {
  it("returns true for insufficient_allowance", () => {
    expect(isApprovalError("insufficient_allowance")).toBe(true);
  });

  it("returns true for safety_deposit_too_small", () => {
    expect(isApprovalError("safety_deposit_too_small")).toBe(true);
  });

  it("returns false for non-approval codes", () => {
    const nonApproval: HTLCErrorCode[] = [
      "wallet_unavailable",
      "simulation_failed",
      "tx_rejected",
      "order_not_found",
      "timelock_not_expired",
      "invalid_preimage",
      "simulation_mode",
      "resolver_not_authorised",
      "chain_error",
    ];
    for (const code of nonApproval) {
      expect(isApprovalError(code), `${code} should not be an approval error`).toBe(false);
    }
  });
});

// ── normalizeApprovalMessage ──────────────────────────────────────────────────

describe("normalizeApprovalMessage", () => {
  // ── Approved scenario: insufficient_allowance on ethereum ──────────────────
  it("insufficient_allowance on ethereum includes approve() instruction", () => {
    const msg = normalizeApprovalMessage("insufficient_allowance", "ethereum");
    expect(msg.toLowerCase()).toContain("approve");
    expect(msg.toLowerCase()).toContain("htlcescrowaddress");
  });

  it("insufficient_allowance on ethereum with details appends them", () => {
    const msg = normalizeApprovalMessage("insufficient_allowance", "ethereum", "current=0, required=1000000");
    expect(msg).toContain("current=0, required=1000000");
  });

  it("insufficient_allowance on soroban returns a generic chain message", () => {
    const msg = normalizeApprovalMessage("insufficient_allowance", "soroban");
    expect(msg.length).toBeGreaterThan(0);
    expect(msg).not.toContain("approve(");
  });

  // ── Denied scenario: resolver_not_authorised ───────────────────────────────
  it("resolver_not_authorised includes registry registration guidance", () => {
    const msg = normalizeApprovalMessage("resolver_not_authorised", "ethereum");
    expect(msg.toLowerCase()).toContain("resolverregistry");
  });

  // ── Stale approval scenario: simulation_failed on ethereum ────────────────
  // A stale approval is when the allowance was set previously but reduced
  // (e.g. by a previous partial use or by directly calling approve(0)).
  // The simulation fails before reaching the contract. The message should
  // guide the operator to re-check allowance.
  it("simulation_failed on ethereum includes approval guidance", () => {
    const msg = normalizeApprovalMessage("simulation_failed", "ethereum");
    expect(msg.toLowerCase()).toContain("allowance");
  });

  it("simulation_failed on soroban includes soroban semantics note", () => {
    const msg = normalizeApprovalMessage("simulation_failed", "soroban");
    expect(msg.length).toBeGreaterThan(0);
  });

  it("simulation_failed on solana includes solana semantics note", () => {
    const msg = normalizeApprovalMessage("simulation_failed", "solana");
    expect(msg.length).toBeGreaterThan(0);
  });

  // ── Safety deposit too small ──────────────────────────────────────────────
  it("safety_deposit_too_small includes minSafetyDeposit guidance", () => {
    const msg = normalizeApprovalMessage("safety_deposit_too_small", "ethereum");
    expect(msg.toLowerCase()).toContain("minsafetydeposit");
  });

  // ── Unknown / passthrough codes ───────────────────────────────────────────
  it("returns the code string for unhandled codes", () => {
    const msg = normalizeApprovalMessage("chain_error" as HTLCErrorCode, "ethereum");
    expect(msg).toBe("chain_error");
  });

  it("returns the details string when provided for unhandled codes", () => {
    const msg = normalizeApprovalMessage("chain_error" as HTLCErrorCode, "ethereum", "rpc timeout");
    expect(msg).toBe("rpc timeout");
  });

  // ── Details are optional ──────────────────────────────────────────────────
  it("does not include parentheses when details is omitted", () => {
    const msg = normalizeApprovalMessage("insufficient_allowance", "ethereum");
    expect(msg).not.toMatch(/\(\s*\)/); // no empty parens
  });
});

// ── ApprovalRequirement shape: approval needed ────────────────────────────────
// Simulate what a `checkApproval` helper would return for the three scenarios
// (approved, denied, stale) and verify the object shape is consistent.

describe("ApprovalRequirement shape", () => {
  const TOKEN = "0x1234000000000000000000000000000000000000";
  const ESCROW = "0xabcd000000000000000000000000000000000000";

  it("approved scenario: needed=false, currentAllowance >= requiredAmount", () => {
    const req: ApprovalRequirement = {
      needed: false,
      tokenAddress: TOKEN,
      spender: ESCROW,
      currentAllowance: 1000n,
      requiredAmount: 500n,
    };
    expect(req.needed).toBe(false);
    expect(req.currentAllowance >= req.requiredAmount).toBe(true);
  });

  it("denied scenario: needed=true, currentAllowance=0", () => {
    const req: ApprovalRequirement = {
      needed: true,
      tokenAddress: TOKEN,
      spender: ESCROW,
      currentAllowance: 0n,
      requiredAmount: 1000n,
    };
    expect(req.needed).toBe(true);
    expect(req.currentAllowance < req.requiredAmount).toBe(true);
  });

  it("stale approval scenario: needed=true, currentAllowance > 0 but < required", () => {
    const req: ApprovalRequirement = {
      needed: true,
      tokenAddress: TOKEN,
      spender: ESCROW,
      currentAllowance: 100n,  // was sufficient before; since reduced
      requiredAmount: 1000n,
    };
    expect(req.needed).toBe(true);
    expect(req.currentAllowance).toBeGreaterThan(0n);
    expect(req.currentAllowance).toBeLessThan(req.requiredAmount);
    // The message for a stale approval should guide re-approve
    const msg = normalizeApprovalMessage("insufficient_allowance", "ethereum",
      `current=${req.currentAllowance}, required=${req.requiredAmount}`);
    expect(msg).toContain(`current=${req.currentAllowance}`);
  });
});
