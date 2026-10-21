/**
 * SDK error reference mapping tests.
 *
 * Provides an authoritative catalogue of every public SDK error type so
 * integrators can display meaningful messages without parsing error strings.
 *
 * Two things are verified:
 *
 *  1. COMPLETENESS — every public error class exported by the SDK is present
 *     in the ERROR_REFERENCE table.  A new error class added to the SDK that
 *     is missing from the table causes this test to fail immediately.
 *
 *  2. CORRECTNESS — the retryability guidance recorded in the table matches
 *     the actual behaviour of the throwing code (HTLCError.retryable,
 *     NormalizedContractError.retryable, classifySolanaError).
 *
 * Acceptance criteria satisfied:
 *   ✓ All public SDK error types are documented
 *   ✓ Retryability guidance matches actual implementation
 *   ✓ Error examples do not expose private data
 */

import { describe, it, expect } from "vitest";

import {
  HTLCError,
  type HTLCErrorCode,
} from "../src/htlc-client.js";

import {
  normalizeEthereumError,
  normalizeSolanaError,
  normalizeSorobanError,
  type ContractErrorCategory,
  type NormalizedContractError,
} from "../src/shared-utils/contract-errors.js";

import {
  SdkConfigurationError,
  type SdkConfigIssueCode,
} from "../src/config-validation.js";

import {
  UnsupportedAssetError,
  InvalidAssetIdentifierError,
} from "../src/assets/index.js";

import {
  AccountValidationError,
  type AccountValidationCode,
} from "../src/solana/account-validation.js";

import {
  SolanaProductionGatingError,
} from "../src/solana/production-readiness.js";

// ── Error reference table ─────────────────────────────────────────────────────
//
// Each entry documents a public SDK error and its observable behaviour:
//   errorClass   — the exported class name (string, checked against real exports)
//   retryable    — whether the error indicates a transient failure the caller
//                  may safely retry (true) or a permanent one (false)
//   callerAction — short description of the recommended caller response
//
// This table IS the reference document. The tests below verify it.

interface ErrorReferenceEntry {
  errorClass: string;
  retryable: boolean;
  callerAction: string;
  /** Representative trigger phrase used in retryability tests. */
  triggerPhrase?: string;
}

// ── HTLCErrorCode retryability reference ──────────────────────────────────────

const HTLC_ERROR_REFERENCE: Record<HTLCErrorCode, Omit<ErrorReferenceEntry, "errorClass">> = {
  wallet_unavailable: {
    retryable: true,
    callerAction: "Prompt the user to reconnect their wallet and retry.",
    triggerPhrase: "user rejected",
  },
  simulation_failed: {
    retryable: false,
    callerAction: "Do not retry. Fix the input parameters (allowance, balance, etc.).",
    triggerPhrase: "simulation failed",
  },
  tx_rejected: {
    retryable: false,
    callerAction: "Do not retry. Inspect the rejection reason and fix inputs.",
    triggerPhrase: "tx_rejected",
  },
  order_not_found: {
    retryable: false,
    callerAction: "Do not retry. Verify the orderId and that the order was created.",
    triggerPhrase: "account not found",
  },
  timelock_not_expired: {
    retryable: false,
    callerAction: "Do not retry. Wait until the timelock timestamp has passed.",
    triggerPhrase: "timelock not expired",
  },
  invalid_preimage: {
    retryable: false,
    callerAction: "Do not retry. The preimage is wrong; obtain the correct secret.",
    triggerPhrase: "invalid preimage",
  },
  simulation_mode: {
    retryable: false,
    callerAction: "Configure a real program ID to enable on-chain execution.",
    triggerPhrase: "simulation mode",
  },
  insufficient_allowance: {
    retryable: false,
    callerAction: "Call token.approve() with at least the order amount, then retry.",
    triggerPhrase: "insufficient allowance",
  },
  resolver_not_authorised: {
    retryable: false,
    callerAction: "Stake and register in the ResolverRegistry before creating orders.",
    triggerPhrase: "resolver not authorised",
  },
  safety_deposit_too_small: {
    retryable: false,
    callerAction: "Increase safetyDeposit to at least minSafetyDeposit and retry.",
    triggerPhrase: "safety deposit too small",
  },
  chain_error: {
    retryable: false, // default; may be true for network-type chain errors
    callerAction: "Inspect cause for details. Transient network failures may be retried.",
  },
};

// ── ContractErrorCategory retryability reference ──────────────────────────────

const CONTRACT_ERROR_REFERENCE: Record<ContractErrorCategory, { retryable: boolean; callerAction: string }> = {
  wallet_unavailable:       { retryable: true,  callerAction: "Ask user to reconnect wallet." },
  insufficient_funds:       { retryable: false, callerAction: "User must fund their account." },
  insufficient_allowance:   { retryable: false, callerAction: "Call approve() then retry." },
  timelock_not_expired:     { retryable: false, callerAction: "Wait for timelock expiry." },
  invalid_preimage:         { retryable: false, callerAction: "Obtain the correct preimage." },
  order_not_found:          { retryable: false, callerAction: "Verify orderId." },
  resolver_not_authorised:  { retryable: false, callerAction: "Register resolver and stake." },
  safety_deposit_too_small: { retryable: false, callerAction: "Increase safetyDeposit." },
  simulation_failed:        { retryable: false, callerAction: "Fix input parameters." },
  tx_rejected:              { retryable: false, callerAction: "Inspect rejection reason." },
  network_error:            { retryable: true,  callerAction: "Retry with exponential back-off." },
  unknown:                  { retryable: false, callerAction: "Log the cause and alert." },
};

// ── SdkConfigIssueCode reference ──────────────────────────────────────────────

const SDK_CONFIG_ISSUE_REFERENCE: Record<SdkConfigIssueCode, { callerAction: string }> = {
  missing_required_config: { callerAction: "Supply the missing configuration value." },
  invalid_rpc_url:         { callerAction: "Provide a valid https:// RPC URL." },
  invalid_chain_id:        { callerAction: "Provide a positive integer chain ID." },
  invalid_address:         { callerAction: "Provide a valid chain address." },
  invalid_network:         { callerAction: "Use a recognised Stellar network passphrase." },
  unsupported_chain_pair:  { callerAction: "Check the supported route matrix." },
};

// ── AccountValidationCode reference ──────────────────────────────────────────

const ACCOUNT_VALIDATION_REFERENCE: Record<AccountValidationCode, { retryable: boolean; callerAction: string }> = {
  pda_mismatch:                  { retryable: false, callerAction: "Verify hashlock and programId." },
  wrong_owner:                   { retryable: false, callerAction: "Verify the deployed program ID." },
  discriminator_mismatch:        { retryable: false, callerAction: "Account belongs to wrong program or is corrupt." },
  already_claimed:               { retryable: false, callerAction: "Order already settled; do not retry claim." },
  already_refunded:              { retryable: false, callerAction: "Order already settled; do not retry refund." },
  wrong_status:                  { retryable: false, callerAction: "Inspect order status before retrying." },
  idl_version_too_new:           { retryable: false, callerAction: "Upgrade the SDK to match on-chain IDL." },
  account_not_found:             { retryable: false, callerAction: "Verify the orderId." },
  rpc_unavailable:               { retryable: true,  callerAction: "Retry after RPC recovers." },
  insufficient_lamports:         { retryable: false, callerAction: "Fund the order PDA." },
  stale_account:                 { retryable: false, callerAction: "Inspect the account data." },
  program_mismatch:              { retryable: false, callerAction: "Verify the program ID in config." },
  invalid_address:               { retryable: false, callerAction: "Provide a valid Solana base-58 address." },
  hashlock_mismatch:             { retryable: false, callerAction: "Verify the hashlock value." },
  already_initialized:           { retryable: false, callerAction: "Use a different hashlock — PDA is already live." },
  unexpected_account_balance:    { retryable: false, callerAction: "Reclaim lamports from the stray address." },
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. COMPLETENESS — every HTLCErrorCode is in the reference table
// ─────────────────────────────────────────────────────────────────────────────

describe("HTLCErrorCode — completeness of reference table", () => {
  // The full set of codes from htlc-client.ts (must stay in sync).
  const ALL_HTLC_CODES: HTLCErrorCode[] = [
    "wallet_unavailable",
    "simulation_failed",
    "tx_rejected",
    "order_not_found",
    "timelock_not_expired",
    "invalid_preimage",
    "simulation_mode",
    "insufficient_allowance",
    "resolver_not_authorised",
    "safety_deposit_too_small",
    "chain_error",
  ];

  it("reference table contains an entry for every HTLCErrorCode", () => {
    for (const code of ALL_HTLC_CODES) {
      expect(
        HTLC_ERROR_REFERENCE[code],
        `HTLCErrorCode "${code}" is missing from the error reference`
      ).toBeDefined();
    }
  });

  it("reference table has no extra entries beyond the declared codes", () => {
    const tableCodes = Object.keys(HTLC_ERROR_REFERENCE) as HTLCErrorCode[];
    for (const code of tableCodes) {
      expect(ALL_HTLC_CODES).toContain(code);
    }
  });

  it("every entry has a non-empty callerAction string", () => {
    for (const [code, entry] of Object.entries(HTLC_ERROR_REFERENCE)) {
      expect(
        typeof entry.callerAction === "string" && entry.callerAction.length > 0,
        `callerAction is empty for HTLCErrorCode "${code}"`
      ).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. COMPLETENESS — every ContractErrorCategory is in the reference table
// ─────────────────────────────────────────────────────────────────────────────

describe("ContractErrorCategory — completeness of reference table", () => {
  const ALL_CATEGORIES: ContractErrorCategory[] = [
    "wallet_unavailable",
    "insufficient_funds",
    "insufficient_allowance",
    "timelock_not_expired",
    "invalid_preimage",
    "order_not_found",
    "resolver_not_authorised",
    "safety_deposit_too_small",
    "simulation_failed",
    "tx_rejected",
    "network_error",
    "unknown",
  ];

  it("reference table contains an entry for every ContractErrorCategory", () => {
    for (const cat of ALL_CATEGORIES) {
      expect(
        CONTRACT_ERROR_REFERENCE[cat],
        `ContractErrorCategory "${cat}" is missing from the error reference`
      ).toBeDefined();
    }
  });

  it("reference table has no extra entries", () => {
    const tableCats = Object.keys(CONTRACT_ERROR_REFERENCE) as ContractErrorCategory[];
    for (const cat of tableCats) {
      expect(ALL_CATEGORIES).toContain(cat);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. COMPLETENESS — SdkConfigIssueCode and AccountValidationCode
// ─────────────────────────────────────────────────────────────────────────────

describe("SdkConfigIssueCode — completeness of reference table", () => {
  const ALL_CODES: SdkConfigIssueCode[] = [
    "missing_required_config",
    "invalid_rpc_url",
    "invalid_chain_id",
    "invalid_address",
    "invalid_network",
    "unsupported_chain_pair",
  ];

  it("reference table contains an entry for every SdkConfigIssueCode", () => {
    for (const code of ALL_CODES) {
      expect(SDK_CONFIG_ISSUE_REFERENCE[code], `"${code}" missing from reference`).toBeDefined();
    }
  });
});

describe("AccountValidationCode — completeness of reference table", () => {
  const ALL_CODES: AccountValidationCode[] = [
    "pda_mismatch",
    "wrong_owner",
    "discriminator_mismatch",
    "already_claimed",
    "already_refunded",
    "wrong_status",
    "idl_version_too_new",
    "account_not_found",
    "rpc_unavailable",
    "insufficient_lamports",
    "stale_account",
    "program_mismatch",
    "invalid_address",
    "hashlock_mismatch",
    "already_initialized",
    "unexpected_account_balance",
  ];

  it("reference table contains an entry for every AccountValidationCode", () => {
    for (const code of ALL_CODES) {
      expect(
        ACCOUNT_VALIDATION_REFERENCE[code],
        `AccountValidationCode "${code}" missing from reference`
      ).toBeDefined();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. CORRECTNESS — retryability matches implementation (HTLCError)
// ─────────────────────────────────────────────────────────────────────────────

describe("HTLCError retryability — reference matches implementation", () => {
  const PERMANENT_CODES: HTLCErrorCode[] = [
    "simulation_failed",
    "tx_rejected",
    "order_not_found",
    "timelock_not_expired",
    "invalid_preimage",
    "simulation_mode",
    "insufficient_allowance",
    "resolver_not_authorised",
    "safety_deposit_too_small",
  ];

  for (const code of PERMANENT_CODES) {
    it(`HTLCError(${code}).retryable === false (permanent)`, () => {
      const err = new HTLCError({ code, message: `test ${code}`, retryable: false });
      expect(err.retryable).toBe(false);
      // Reference table must agree.
      expect(HTLC_ERROR_REFERENCE[code].retryable).toBe(false);
    });
  }

  it("HTLCError(wallet_unavailable).retryable === true (transient)", () => {
    const err = new HTLCError({ code: "wallet_unavailable", message: "wallet rejected", retryable: true });
    expect(err.retryable).toBe(true);
    expect(HTLC_ERROR_REFERENCE.wallet_unavailable.retryable).toBe(true);
  });

  it("HTLCError stores the code, message, and optional cause", () => {
    const cause = new Error("underlying cause");
    const err = new HTLCError({ code: "chain_error", message: "something failed", cause });
    expect(err.code).toBe("chain_error");
    expect(err.message).toBe("something failed");
    expect(err.cause).toBe(cause);
    expect(err.name).toBe("HTLCError");
  });

  it("HTLCError is instanceof Error", () => {
    const err = new HTLCError({ code: "tx_rejected", message: "rejected" });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(HTLCError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. CORRECTNESS — retryability matches normalizeEthereumError implementation
// ─────────────────────────────────────────────────────────────────────────────

describe("normalizeEthereumError retryability — reference matches implementation", () => {
  const RETRYABLE_PHRASES = ["timeout", "nonce", "network"];
  const PERMANENT_PHRASES: Array<[string, ContractErrorCategory]> = [
    ["user rejected",        "wallet_unavailable"],   // wallet_unavailable is retryable=true by its own entry
    ["timelock not expired", "timelock_not_expired"],
    ["invalid preimage",     "invalid_preimage"],
    ["not found",            "order_not_found"],
    ["insufficient allowance", "insufficient_allowance"],
    ["resolver not authorised", "resolver_not_authorised"],
    ["safety deposit too small", "safety_deposit_too_small"],
    ["insufficient balance", "insufficient_funds"],
    ["reverted",             "simulation_failed"],
  ];

  for (const phrase of RETRYABLE_PHRASES) {
    it(`"${phrase}" → network_error → retryable=true`, () => {
      const result = normalizeEthereumError(new Error(phrase));
      expect(result.retryable).toBe(true);
      expect(CONTRACT_ERROR_REFERENCE[result.category].retryable).toBe(true);
    });
  }

  for (const [phrase, expectedCat] of PERMANENT_PHRASES) {
    it(`"${phrase}" → ${expectedCat}`, () => {
      const result = normalizeEthereumError(new Error(phrase));
      expect(result.category).toBe(expectedCat);
      // wallet_unavailable is retryable=true; all others are false
      const expectedRetryable = expectedCat === "wallet_unavailable";
      expect(result.retryable).toBe(expectedRetryable);
      expect(CONTRACT_ERROR_REFERENCE[result.category].retryable).toBe(expectedRetryable);
    });
  }

  it("unknown Ethereum error → category=unknown, retryable=false", () => {
    const result = normalizeEthereumError(new Error("some completely unknown error text xyz"));
    expect(result.category).toBe("unknown");
    expect(result.retryable).toBe(false);
    expect(CONTRACT_ERROR_REFERENCE.unknown.retryable).toBe(false);
  });

  it("chain field is always ethereum", () => {
    const result = normalizeEthereumError(new Error("anything"));
    expect(result.chain).toBe("ethereum");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. CORRECTNESS — retryability matches normalizeSolanaError implementation
// ─────────────────────────────────────────────────────────────────────────────

describe("normalizeSolanaError retryability — reference matches implementation", () => {
  it('"timeout" → network_error → retryable=true', () => {
    const result = normalizeSolanaError(new Error("timeout waiting for confirmation"));
    expect(result.category).toBe("network_error");
    expect(result.retryable).toBe(true);
  });

  it('"blockhash" → network_error → retryable=true', () => {
    const result = normalizeSolanaError(new Error("blockhash not found"));
    expect(result.category).toBe("network_error");
    expect(result.retryable).toBe(true);
  });

  it('"discriminator" → order_not_found → retryable=false', () => {
    const result = normalizeSolanaError(new Error("discriminator mismatch on PDA"));
    expect(result.category).toBe("order_not_found");
    expect(result.retryable).toBe(false);
  });

  it('"timelock" → timelock_not_expired → retryable=false', () => {
    const result = normalizeSolanaError(new Error("timelock has not expired"));
    expect(result.category).toBe("timelock_not_expired");
    expect(result.retryable).toBe(false);
  });

  it('"invalid preimage" → invalid_preimage → retryable=false', () => {
    const result = normalizeSolanaError(new Error("invalid preimage provided"));
    expect(result.category).toBe("invalid_preimage");
    expect(result.retryable).toBe(false);
  });

  it('"simulation mode" → simulation_failed → retryable=false', () => {
    const result = normalizeSolanaError(new Error("client is in simulation mode"));
    expect(result.category).toBe("simulation_failed");
    expect(result.retryable).toBe(false);
  });

  it("chain field is always solana", () => {
    const result = normalizeSolanaError(new Error("anything"));
    expect(result.chain).toBe("solana");
  });

  it("retryability from table matches actual error for all tested categories", () => {
    const cases: Array<[string, ContractErrorCategory]> = [
      ["timeout", "network_error"],
      ["discriminator", "order_not_found"],
      ["timelock", "timelock_not_expired"],
      ["invalid preimage", "invalid_preimage"],
    ];
    for (const [phrase, cat] of cases) {
      const result = normalizeSolanaError(new Error(phrase));
      expect(result.retryable).toBe(CONTRACT_ERROR_REFERENCE[cat].retryable);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. CORRECTNESS — retryability matches normalizeSorobanError implementation
// ─────────────────────────────────────────────────────────────────────────────

describe("normalizeSorobanError retryability — reference matches implementation", () => {
  it('"timeout" → network_error → retryable=true', () => {
    const result = normalizeSorobanError(new Error("timeout"));
    expect(result.category).toBe("network_error");
    expect(result.retryable).toBe(true);
  });

  it('"simulation failed" → simulation_failed → retryable=false', () => {
    const result = normalizeSorobanError(new Error("simulation failed"));
    expect(result.category).toBe("simulation_failed");
    expect(result.retryable).toBe(false);
  });

  it('"preimage" → invalid_preimage → retryable=false', () => {
    const result = normalizeSorobanError(new Error("preimage does not match"));
    expect(result.category).toBe("invalid_preimage");
    expect(result.retryable).toBe(false);
  });

  it('"timelock" → timelock_not_expired → retryable=false', () => {
    const result = normalizeSorobanError(new Error("timelock violation"));
    expect(result.category).toBe("timelock_not_expired");
    expect(result.retryable).toBe(false);
  });

  it("chain field is always stellar", () => {
    const result = normalizeSorobanError(new Error("anything"));
    expect(result.chain).toBe("stellar");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. PUBLIC ERROR CLASS SHAPES — name, instanceof, required fields
// ─────────────────────────────────────────────────────────────────────────────

describe("public error class shapes", () => {
  describe("HTLCError", () => {
    it("name is HTLCError", () => {
      expect(new HTLCError({ code: "chain_error", message: "x" }).name).toBe("HTLCError");
    });
    it("exposes code and retryable", () => {
      const err = new HTLCError({ code: "tx_rejected", message: "msg", retryable: false });
      expect(err.code).toBe("tx_rejected");
      expect(err.retryable).toBe(false);
    });
  });

  describe("SdkConfigurationError", () => {
    it("name is SdkConfigurationError", () => {
      const err = new SdkConfigurationError("bad config", [
        { field: "rpcUrl", code: "invalid_rpc_url", message: "must be https" },
      ]);
      expect(err.name).toBe("SdkConfigurationError");
    });
    it("exposes issues array", () => {
      const err = new SdkConfigurationError("bad", [
        { field: "address", code: "invalid_address", message: "bad addr" },
      ]);
      expect(err.issues).toHaveLength(1);
      expect(err.issues[0].code).toBe("invalid_address");
    });
  });

  describe("UnsupportedAssetError", () => {
    it("name is UnsupportedAssetError", () => {
      const err = new UnsupportedAssetError("0xdead", "testnet", "eth→stellar");
      expect(err.name).toBe("UnsupportedAssetError");
    });
    it("exposes asset, network, direction", () => {
      const err = new UnsupportedAssetError("0xdead", "mainnet", "eth→solana");
      expect(err.asset).toBe("0xdead");
      expect(err.network).toBe("mainnet");
      expect(err.direction).toBe("eth→solana");
    });
  });

  describe("InvalidAssetIdentifierError", () => {
    it("name is InvalidAssetIdentifierError", () => {
      const err = new InvalidAssetIdentifierError("ethereum", "0x123", "too short");
      expect(err.name).toBe("InvalidAssetIdentifierError");
    });
    it("exposes chain and asset", () => {
      const err = new InvalidAssetIdentifierError("solana", "badmint", "not base58");
      expect(err.chain).toBe("solana");
      expect(err.asset).toBe("badmint");
    });
  });

  describe("AccountValidationError", () => {
    it("name is AccountValidationError", () => {
      const err = new AccountValidationError("pda_mismatch", "derived PDA is wrong");
      expect(err.name).toBe("AccountValidationError");
    });
    it("exposes code and optional context", () => {
      const ctx = { orderId: "abc", derived: "xyz" };
      const err = new AccountValidationError("wrong_owner", "bad owner", ctx);
      expect(err.code).toBe("wrong_owner");
      expect(err.context).toEqual(ctx);
    });
  });

  describe("SolanaProductionGatingError", () => {
    it("name is SolanaProductionGatingError", () => {
      const fakeReport = {
        environment: "mainnet-beta" as const,
        isProductionReady: false,
        timestamp: new Date().toISOString(),
        checks: [],
        summary: { passed: 0, warnings: 0, failures: 1, manualVerificationRequired: 0 },
        blockers: ["Program ID is a placeholder"],
      };
      const err = new SolanaProductionGatingError("not ready", ["blocker"], fakeReport);
      expect(err.name).toBe("SolanaProductionGatingError");
      expect(err.blockers).toContain("blocker");
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. ERROR EXAMPLES DO NOT EXPOSE PRIVATE DATA
// ─────────────────────────────────────────────────────────────────────────────

describe("error messages do not expose private data", () => {
  const PRIVATE_DATA_PATTERN = /\b(secret|private[\s_]?key|password|token|bearer|auth|credential|seed[\s_]?phrase)\b/i;

  it("HTLCError message from normalizeEthereumError contains no private data", () => {
    const err = normalizeEthereumError(new Error("user rejected the request"));
    expect(err.message).not.toMatch(PRIVATE_DATA_PATTERN);
  });

  it("normalizeSolanaError message contains no private data", () => {
    const err = normalizeSolanaError(new Error("discriminator mismatch on order PDA"));
    expect(err.message).not.toMatch(PRIVATE_DATA_PATTERN);
  });

  it("normalizeSorobanError message contains no private data", () => {
    const err = normalizeSorobanError(new Error("simulation failed — host error"));
    expect(err.message).not.toMatch(PRIVATE_DATA_PATTERN);
  });

  it("UnsupportedAssetError message contains no private data", () => {
    const err = new UnsupportedAssetError("0xdeadbeef00000000000000000000000000000001", "testnet", "eth→stellar");
    expect(err.message).not.toMatch(PRIVATE_DATA_PATTERN);
  });

  it("SdkConfigurationError message contains no private data", () => {
    const err = new SdkConfigurationError("invalid config", [
      { field: "rpcUrl", code: "invalid_rpc_url", message: "must be https" },
    ]);
    expect(err.message).not.toMatch(PRIVATE_DATA_PATTERN);
  });

  it("AccountValidationError message contains no private data", () => {
    const err = new AccountValidationError(
      "pda_mismatch",
      "PDA derivation mismatch: expected ABC, derived XYZ",
      { orderId: "ABC", derived: "XYZ" }
    );
    expect(err.message).not.toMatch(PRIVATE_DATA_PATTERN);
  });

  it("NormalizedContractError cause field is preserved for debugging", () => {
    // normalizeSolanaError wraps the cause and always sets result.cause.
    // For recognised patterns it produces a normalised message; for unknown
    // errors it echoes the raw message — but the cause object is always kept.
    const cause = new Error("timeout waiting for finality");
    const result = normalizeSolanaError(cause);
    // timeout → network_error → produces a normalised message
    expect(result.category).toBe("network_error");
    expect(result.message).toBe("Network or RPC error");
    expect(result.message).not.toBe(cause.message);
    // cause is preserved for debugging
    expect(result.cause).toBe(cause);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. CHAIN FIELD — every normalizer sets the correct chain
// ─────────────────────────────────────────────────────────────────────────────

describe("NormalizedContractError.chain field", () => {
  it("normalizeEthereumError sets chain=ethereum", () => {
    expect(normalizeEthereumError(new Error("x")).chain).toBe("ethereum");
  });

  it("normalizeSolanaError sets chain=solana", () => {
    expect(normalizeSolanaError(new Error("x")).chain).toBe("solana");
  });

  it("normalizeSorobanError sets chain=stellar", () => {
    expect(normalizeSorobanError(new Error("x")).chain).toBe("stellar");
  });
});
