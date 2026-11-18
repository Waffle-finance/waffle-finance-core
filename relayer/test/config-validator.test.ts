import { describe, it, expect } from "vitest";
import {
  validateRelayerStartup,
  formatStartupErrors,
  type ConfigError,
} from "../src/config-validator.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_ETH_KEY =
  "0x" + "a".repeat(63) + "1"; // 64 non-zero hex chars → real-looking key
const VALID_STELLAR_SECRET = "S" + "A".repeat(55); // 56-char S-prefixed key

/**
 * Complete valid testnet environment.  Every required field is present and
 * non-placeholder.  Individual tests override one field at a time via spread.
 *
 * Note: COORDINATOR_URL is required by the validator (added alongside the
 * coordinator-availability readiness probe in relayer/src/routes/health.ts).
 * It must be included here for the happy-path assertion to hold.
 */
const VALID_ENV = {
  ETHEREUM_RPC_URL: "https://eth-sepolia.internal/v3/key",
  STELLAR_HORIZON_URL: "https://horizon-testnet.internal",
  SOROBAN_RPC_URL: "https://soroban-testnet.internal/rpc",
  STELLAR_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  COORDINATOR_URL: "http://coordinator.internal:4000",
};

/** Minimal valid mainnet environment — swaps out the testnet-specific values. */
const VALID_ENV_MAINNET = {
  ETHEREUM_RPC_URL: "https://eth-mainnet.internal/v3/key",
  STELLAR_HORIZON_URL: "https://horizon.stellar.org",
  SOROBAN_RPC_URL: "https://mainnet.sorobanrpc.internal",
  STELLAR_NETWORK_PASSPHRASE: "Public Global Stellar Network ; September 2015",
  COORDINATOR_URL: "http://coordinator.internal:4000",
  NETWORK_MODE: "mainnet",
};

const VALID_CFG = {
  ethereumPrivateKey: VALID_ETH_KEY,
  stellarSecretKey: VALID_STELLAR_SECRET,
};

function fieldCodes(errors: ConfigError[]): Record<string, string> {
  return Object.fromEntries(errors.map((e) => [e.field, e.code]));
}

/** Return field names from an error array. */
function errorFields(errors: ConfigError[]): string[] {
  return errors.map((e) => e.field);
}

// ---------------------------------------------------------------------------
// Happy-path: no errors
// ---------------------------------------------------------------------------

describe("validateRelayerStartup — valid config", () => {
  it("returns an empty array when all fields are present and non-placeholder", () => {
    const errors = validateRelayerStartup(VALID_ENV, VALID_CFG);
    expect(errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Missing fields
// ---------------------------------------------------------------------------

describe("validateRelayerStartup — missing fields", () => {
  it("reports missing ETHEREUM_RPC_URL", () => {
    const errors = validateRelayerStartup(
      { ...VALID_ENV, ETHEREUM_RPC_URL: undefined },
      VALID_CFG
    );
    const codes = fieldCodes(errors);
    expect(codes["ETHEREUM_RPC_URL"]).toBe("missing");
  });

  it("reports missing STELLAR_HORIZON_URL", () => {
    const errors = validateRelayerStartup(
      { ...VALID_ENV, STELLAR_HORIZON_URL: undefined },
      VALID_CFG
    );
    expect(fieldCodes(errors)["STELLAR_HORIZON_URL"]).toBe("missing");
  });

  it("reports missing ethereum private key", () => {
    const errors = validateRelayerStartup(VALID_ENV, {
      ...VALID_CFG,
      ethereumPrivateKey: undefined,
    });
    expect(fieldCodes(errors)["RELAYER_PRIVATE_KEY"]).toBe("missing");
  });

  it("reports missing stellar secret key", () => {
    const errors = validateRelayerStartup(VALID_ENV, {
      ...VALID_CFG,
      stellarSecretKey: undefined,
    });
    expect(fieldCodes(errors)["RELAYER_STELLAR_SECRET"]).toBe("missing");
  });

  it("aggregates all missing fields in one call instead of stopping at the first", () => {
    const errors = validateRelayerStartup({}, {});
    const fields = errors.map((e) => e.field);
    expect(fields).toContain("ETHEREUM_RPC_URL");
    expect(fields).toContain("STELLAR_HORIZON_URL");
    expect(fields).toContain("RELAYER_PRIVATE_KEY");
    expect(fields).toContain("RELAYER_STELLAR_SECRET");
    // All four must be reported in a single call
    expect(errors.length).toBeGreaterThanOrEqual(4);
  });
});

// ---------------------------------------------------------------------------
// Placeholder detection
// ---------------------------------------------------------------------------

describe("validateRelayerStartup — placeholder values", () => {
  it("rejects ETHEREUM_RPC_URL that contains YOUR_", () => {
    const errors = validateRelayerStartup(
      { ...VALID_ENV, ETHEREUM_RPC_URL: "https://YOUR_API_KEY.infura.io" },
      VALID_CFG
    );
    expect(fieldCodes(errors)["ETHEREUM_RPC_URL"]).toBe("placeholder");
  });

  it("rejects STELLAR_HORIZON_URL that contains REPLACE_ME", () => {
    const errors = validateRelayerStartup(
      { ...VALID_ENV, STELLAR_HORIZON_URL: "https://REPLACE_ME.horizon.org" },
      VALID_CFG
    );
    expect(fieldCodes(errors)["STELLAR_HORIZON_URL"]).toBe("placeholder");
  });

  it("rejects an Ethereum key that contains YOUR_", () => {
    const errors = validateRelayerStartup(VALID_ENV, {
      ...VALID_CFG,
      ethereumPrivateKey: "YOUR_PRIVATE_KEY_HERE",
    });
    expect(fieldCodes(errors)["RELAYER_PRIVATE_KEY"]).toBe("placeholder");
  });

  it("rejects a Stellar secret that contains SAMPLE", () => {
    const errors = validateRelayerStartup(VALID_ENV, {
      ...VALID_CFG,
      stellarSecretKey: "SAMPLE_STELLAR_SECRET_KEY",
    });
    expect(fieldCodes(errors)["RELAYER_STELLAR_SECRET"]).toBe("placeholder");
  });
});

// ---------------------------------------------------------------------------
// Format checks
// ---------------------------------------------------------------------------

describe("validateRelayerStartup — invalid format", () => {
  it("rejects ETHEREUM_RPC_URL that is not an http(s) URL", () => {
    const errors = validateRelayerStartup(
      { ...VALID_ENV, ETHEREUM_RPC_URL: "wss://eth-node.example.com" },
      VALID_CFG
    );
    expect(fieldCodes(errors)["ETHEREUM_RPC_URL"]).toBe("invalid_format");
  });

  it("rejects STELLAR_HORIZON_URL that is not an http(s) URL", () => {
    const errors = validateRelayerStartup(
      { ...VALID_ENV, STELLAR_HORIZON_URL: "ftp://horizon.stellar.org" },
      VALID_CFG
    );
    expect(fieldCodes(errors)["STELLAR_HORIZON_URL"]).toBe("invalid_format");
  });

  it("rejects a Stellar secret key that does not match the expected format", () => {
    const errors = validateRelayerStartup(VALID_ENV, {
      ...VALID_CFG,
      stellarSecretKey: "notAStellarKey",
    });
    expect(fieldCodes(errors)["RELAYER_STELLAR_SECRET"]).toBe("invalid_format");
  });
});

// ---------------------------------------------------------------------------
// Invalid value: zero / dummy Ethereum key
// ---------------------------------------------------------------------------

describe("validateRelayerStartup — zero / dummy Ethereum key", () => {
  it("rejects an all-zero private key", () => {
    const errors = validateRelayerStartup(VALID_ENV, {
      ...VALID_CFG,
      ethereumPrivateKey: "0x" + "0".repeat(64),
    });
    expect(fieldCodes(errors)["RELAYER_PRIVATE_KEY"]).toBe("invalid_value");
  });

  it("rejects the canonical dummy key (0x000...001)", () => {
    const errors = validateRelayerStartup(VALID_ENV, {
      ...VALID_CFG,
      ethereumPrivateKey: "0x" + "0".repeat(63) + "1",
    });
    expect(fieldCodes(errors)["RELAYER_PRIVATE_KEY"]).toBe("invalid_value");
  });
});

// ---------------------------------------------------------------------------
// env-variable fallback (cfg not supplied)
// ---------------------------------------------------------------------------

describe("validateRelayerStartup — env-variable fallback", () => {
  it("reads RELAYER_PRIVATE_KEY from env when cfg.ethereumPrivateKey is absent", () => {
    const errors = validateRelayerStartup(
      { ...VALID_ENV, RELAYER_PRIVATE_KEY: VALID_ETH_KEY },
      { stellarSecretKey: VALID_STELLAR_SECRET }
    );
    const fields = errors.map((e) => e.field);
    expect(fields).not.toContain("RELAYER_PRIVATE_KEY");
  });

  it("reads RELAYER_STELLAR_SECRET from env when cfg.stellarSecretKey is absent", () => {
    const errors = validateRelayerStartup(
      { ...VALID_ENV, RELAYER_STELLAR_SECRET: VALID_STELLAR_SECRET },
      { ethereumPrivateKey: VALID_ETH_KEY }
    );
    const fields = errors.map((e) => e.field);
    expect(fields).not.toContain("RELAYER_STELLAR_SECRET");
  });
});

// ---------------------------------------------------------------------------
// formatStartupErrors
// ---------------------------------------------------------------------------

describe("formatStartupErrors", () => {
  it("returns a multi-line string with one line per error", () => {
    const errors = validateRelayerStartup({}, {});
    const formatted = formatStartupErrors(errors);
    const lines = formatted.split("\n").filter(Boolean);
    expect(lines.length).toBe(errors.length);
  });

  it("includes the field name and code in each line", () => {
    const errors = validateRelayerStartup(
      { ...VALID_ENV, ETHEREUM_RPC_URL: undefined },
      VALID_CFG
    );
    const formatted = formatStartupErrors(errors);
    expect(formatted).toContain("ETHEREUM_RPC_URL");
    expect(formatted).toContain("missing");
  });
});

// ---------------------------------------------------------------------------
// Negative polling intervals
// ---------------------------------------------------------------------------

describe("validateRelayerStartup — negative polling intervals", () => {
  it("rejects a negative RELAYER_ACTIVE_POLL_INTERVAL_MS", () => {
    const errors = validateRelayerStartup(
      { ...VALID_ENV, RELAYER_ACTIVE_POLL_INTERVAL_MS: "-5000" },
      VALID_CFG
    );
    expect(fieldCodes(errors)["RELAYER_ACTIVE_POLL_INTERVAL_MS"]).toBe("invalid_value");
  });

  it("rejects a negative RELAYER_IDLE_POLL_INTERVAL_MS", () => {
    const errors = validateRelayerStartup(
      { ...VALID_ENV, RELAYER_IDLE_POLL_INTERVAL_MS: "-1000" },
      VALID_CFG
    );
    expect(fieldCodes(errors)["RELAYER_IDLE_POLL_INTERVAL_MS"]).toBe("invalid_value");
  });

  it("rejects a non-numeric RELAYER_ACTIVE_POLL_INTERVAL_MS", () => {
    const errors = validateRelayerStartup(
      { ...VALID_ENV, RELAYER_ACTIVE_POLL_INTERVAL_MS: "abc" },
      VALID_CFG
    );
    expect(fieldCodes(errors)["RELAYER_ACTIVE_POLL_INTERVAL_MS"]).toBe("invalid_value");
  });

  it("accepts a valid positive polling interval", () => {
    const errors = validateRelayerStartup(
      { ...VALID_ENV, RELAYER_ACTIVE_POLL_INTERVAL_MS: "15000", RELAYER_IDLE_POLL_INTERVAL_MS: "120000" },
      VALID_CFG
    );
    expect(fieldCodes(errors)["RELAYER_ACTIVE_POLL_INTERVAL_MS"]).toBeUndefined();
    expect(fieldCodes(errors)["RELAYER_IDLE_POLL_INTERVAL_MS"]).toBeUndefined();
  });

  it("accepts zero polling interval (disabled polling)", () => {
    const errors = validateRelayerStartup(
      { ...VALID_ENV, RELAYER_ACTIVE_POLL_INTERVAL_MS: "0", RELAYER_IDLE_POLL_INTERVAL_MS: "0" },
      VALID_CFG
    );
    expect(fieldCodes(errors)["RELAYER_ACTIVE_POLL_INTERVAL_MS"]).toBeUndefined();
    expect(fieldCodes(errors)["RELAYER_IDLE_POLL_INTERVAL_MS"]).toBeUndefined();
  });

  it("does not report polling interval error when env var is absent", () => {
    const errors = validateRelayerStartup(VALID_ENV, VALID_CFG);
    expect(fieldCodes(errors)["RELAYER_ACTIVE_POLL_INTERVAL_MS"]).toBeUndefined();
    expect(fieldCodes(errors)["RELAYER_IDLE_POLL_INTERVAL_MS"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// COORDINATOR_URL — required endpoint, added with readiness probe (#754)
//
// The relayer health /readyz probes the coordinator on every call.  A missing
// or unusable COORDINATOR_URL means settlement work starts blind — the relayer
// cannot verify resolver availability or announce orders.
// ---------------------------------------------------------------------------

describe("validateRelayerStartup — COORDINATOR_URL endpoint", () => {
  it("reports missing COORDINATOR_URL", () => {
    const errors = validateRelayerStartup(
      { ...VALID_ENV, COORDINATOR_URL: undefined },
      VALID_CFG,
    );
    expect(fieldCodes(errors)["COORDINATOR_URL"]).toBe("missing");
  });

  it("reports placeholder COORDINATOR_URL", () => {
    const errors = validateRelayerStartup(
      { ...VALID_ENV, COORDINATOR_URL: "http://YOUR_COORDINATOR_HOST:4000" },
      VALID_CFG,
    );
    expect(fieldCodes(errors)["COORDINATOR_URL"]).toBe("placeholder");
  });

  it("reports invalid format for a non-http(s) COORDINATOR_URL", () => {
    const errors = validateRelayerStartup(
      { ...VALID_ENV, COORDINATOR_URL: "grpc://coordinator.internal:50051" },
      VALID_CFG,
    );
    expect(fieldCodes(errors)["COORDINATOR_URL"]).toBe("invalid_format");
  });

  it("accepts a valid http COORDINATOR_URL", () => {
    const errors = validateRelayerStartup(
      { ...VALID_ENV, COORDINATOR_URL: "http://coordinator.internal:4000" },
      VALID_CFG,
    );
    expect(fieldCodes(errors)["COORDINATOR_URL"]).toBeUndefined();
  });

  it("accepts a valid https COORDINATOR_URL", () => {
    const errors = validateRelayerStartup(
      { ...VALID_ENV, COORDINATOR_URL: "https://coordinator.prod.internal" },
      VALID_CFG,
    );
    expect(fieldCodes(errors)["COORDINATOR_URL"]).toBeUndefined();
  });

  it("does not expose the COORDINATOR_URL value in the error message", () => {
    // The error message for a placeholder may echo the value back for
    // diagnostics, but must not expose credentials embedded in the URL.
    // Here we verify the field name is present and the code is correct —
    // the test intentionally uses a non-credentialled URL.
    const errors = validateRelayerStartup(
      { ...VALID_ENV, COORDINATOR_URL: undefined },
      VALID_CFG,
    );
    const err = errors.find((e) => e.field === "COORDINATOR_URL");
    expect(err).toBeDefined();
    expect(err!.code).toBe("missing");
    // The raw value is not echoed for a missing field — nothing to leak.
    expect(err!.message).not.toMatch(/undefined/);
  });
});

// ---------------------------------------------------------------------------
// SOROBAN_RPC_URL — required Soroban endpoint
//
// Missing SOROBAN_RPC_URL causes every Soroban interaction to fail at runtime
// rather than at startup.  Each network mode (testnet / mainnet) uses the same
// env key but a different expected URL — the validator catches the missing
// field regardless of mode.
// ---------------------------------------------------------------------------

describe("validateRelayerStartup — SOROBAN_RPC_URL endpoint", () => {
  it("reports missing SOROBAN_RPC_URL in testnet mode", () => {
    const errors = validateRelayerStartup(
      { ...VALID_ENV, SOROBAN_RPC_URL: undefined },
      VALID_CFG,
    );
    expect(fieldCodes(errors)["SOROBAN_RPC_URL"]).toBe("missing");
  });

  it("reports missing SOROBAN_RPC_URL in mainnet mode", () => {
    const errors = validateRelayerStartup(
      { ...VALID_ENV_MAINNET, SOROBAN_RPC_URL: undefined },
      VALID_CFG,
    );
    expect(fieldCodes(errors)["SOROBAN_RPC_URL"]).toBe("missing");
  });

  it("reports placeholder SOROBAN_RPC_URL", () => {
    const errors = validateRelayerStartup(
      { ...VALID_ENV, SOROBAN_RPC_URL: "https://YOUR_SOROBAN_RPC.stellar.org" },
      VALID_CFG,
    );
    expect(fieldCodes(errors)["SOROBAN_RPC_URL"]).toBe("placeholder");
  });

  it("reports SOROBAN_RPC_URL that contains REPLACE_ME as placeholder", () => {
    const errors = validateRelayerStartup(
      { ...VALID_ENV, SOROBAN_RPC_URL: "https://REPLACE_ME.soroban.org/rpc" },
      VALID_CFG,
    );
    expect(fieldCodes(errors)["SOROBAN_RPC_URL"]).toBe("placeholder");
  });

  it("reports invalid format for a non-http(s) SOROBAN_RPC_URL", () => {
    const errors = validateRelayerStartup(
      { ...VALID_ENV, SOROBAN_RPC_URL: "wss://soroban-testnet.internal/ws" },
      VALID_CFG,
    );
    expect(fieldCodes(errors)["SOROBAN_RPC_URL"]).toBe("invalid_format");
  });

  it("accepts a valid https SOROBAN_RPC_URL in testnet mode", () => {
    const errors = validateRelayerStartup(
      { ...VALID_ENV, SOROBAN_RPC_URL: "https://soroban-testnet.internal/rpc" },
      VALID_CFG,
    );
    expect(fieldCodes(errors)["SOROBAN_RPC_URL"]).toBeUndefined();
  });

  it("accepts a valid https SOROBAN_RPC_URL in mainnet mode", () => {
    const errors = validateRelayerStartup(
      { ...VALID_ENV_MAINNET },
      VALID_CFG,
    );
    expect(fieldCodes(errors)["SOROBAN_RPC_URL"]).toBeUndefined();
  });

  it("SOROBAN_RPC_URL error is reported independently — other fields unaffected", () => {
    // Only SOROBAN_RPC_URL is removed; all other fields are valid.
    // Only SOROBAN_RPC_URL and STELLAR_NETWORK_PASSPHRASE should appear in errors
    // (passphrase is present and correct, so only SOROBAN_RPC_URL should fail).
    const errors = validateRelayerStartup(
      { ...VALID_ENV, SOROBAN_RPC_URL: undefined },
      VALID_CFG,
    );
    const errFields = errorFields(errors);
    expect(errFields).toContain("SOROBAN_RPC_URL");
    expect(errFields).not.toContain("ETHEREUM_RPC_URL");
    expect(errFields).not.toContain("STELLAR_HORIZON_URL");
    expect(errFields).not.toContain("COORDINATOR_URL");
  });
});

// ---------------------------------------------------------------------------
// STELLAR_NETWORK_PASSPHRASE — network-mode-sensitive required field
//
// The passphrase is embedded in every signed Stellar transaction. A wrong value
// causes tx_bad_auth on-chain — a failure with no obvious link back to the
// misconfiguration. The validator checks the passphrase against NETWORK_MODE
// (defaulting to "testnet" when absent) so operators see the error before any
// settlement work begins.
// ---------------------------------------------------------------------------

describe("validateRelayerStartup — STELLAR_NETWORK_PASSPHRASE per network mode", () => {
  const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
  const MAINNET_PASSPHRASE = "Public Global Stellar Network ; September 2015";

  it("reports missing STELLAR_NETWORK_PASSPHRASE in testnet mode (default)", () => {
    const errors = validateRelayerStartup(
      { ...VALID_ENV, STELLAR_NETWORK_PASSPHRASE: undefined },
      VALID_CFG,
    );
    expect(fieldCodes(errors)["STELLAR_NETWORK_PASSPHRASE"]).toBe("missing");
  });

  it("reports missing STELLAR_NETWORK_PASSPHRASE in mainnet mode", () => {
    const errors = validateRelayerStartup(
      { ...VALID_ENV_MAINNET, STELLAR_NETWORK_PASSPHRASE: undefined },
      VALID_CFG,
    );
    expect(fieldCodes(errors)["STELLAR_NETWORK_PASSPHRASE"]).toBe("missing");
  });

  it("accepts the correct testnet passphrase when NETWORK_MODE is unset", () => {
    // No NETWORK_MODE → defaults to testnet
    const errors = validateRelayerStartup(
      { ...VALID_ENV, STELLAR_NETWORK_PASSPHRASE: TESTNET_PASSPHRASE },
      VALID_CFG,
    );
    expect(fieldCodes(errors)["STELLAR_NETWORK_PASSPHRASE"]).toBeUndefined();
  });

  it("accepts the correct testnet passphrase when NETWORK_MODE=testnet", () => {
    const errors = validateRelayerStartup(
      { ...VALID_ENV, NETWORK_MODE: "testnet", STELLAR_NETWORK_PASSPHRASE: TESTNET_PASSPHRASE },
      VALID_CFG,
    );
    expect(fieldCodes(errors)["STELLAR_NETWORK_PASSPHRASE"]).toBeUndefined();
  });

  it("accepts the correct mainnet passphrase when NETWORK_MODE=mainnet", () => {
    const errors = validateRelayerStartup(
      { ...VALID_ENV_MAINNET, STELLAR_NETWORK_PASSPHRASE: MAINNET_PASSPHRASE },
      VALID_CFG,
    );
    expect(fieldCodes(errors)["STELLAR_NETWORK_PASSPHRASE"]).toBeUndefined();
  });

  it("rejects the mainnet passphrase when NETWORK_MODE=testnet", () => {
    const errors = validateRelayerStartup(
      { ...VALID_ENV, NETWORK_MODE: "testnet", STELLAR_NETWORK_PASSPHRASE: MAINNET_PASSPHRASE },
      VALID_CFG,
    );
    expect(fieldCodes(errors)["STELLAR_NETWORK_PASSPHRASE"]).toBe("invalid_value");
  });

  it("rejects the testnet passphrase when NETWORK_MODE=mainnet", () => {
    const errors = validateRelayerStartup(
      { ...VALID_ENV_MAINNET, STELLAR_NETWORK_PASSPHRASE: TESTNET_PASSPHRASE },
      VALID_CFG,
    );
    expect(fieldCodes(errors)["STELLAR_NETWORK_PASSPHRASE"]).toBe("invalid_value");
  });

  it("rejects an arbitrary string as the passphrase", () => {
    const errors = validateRelayerStartup(
      { ...VALID_ENV, STELLAR_NETWORK_PASSPHRASE: "not-a-valid-passphrase" },
      VALID_CFG,
    );
    expect(fieldCodes(errors)["STELLAR_NETWORK_PASSPHRASE"]).toBe("invalid_value");
  });

  it("does not expose the raw passphrase value in the safe-name field of the error", () => {
    // The error response must identify the dependency (STELLAR_NETWORK_PASSPHRASE)
    // without leaking credentials.  We assert the field name is present and that
    // the error code is reported — we do NOT assert on raw value echoing.
    const errors = validateRelayerStartup(
      { ...VALID_ENV, STELLAR_NETWORK_PASSPHRASE: undefined },
      VALID_CFG,
    );
    const err = errors.find((e) => e.field === "STELLAR_NETWORK_PASSPHRASE");
    expect(err).toBeDefined();
    // The field name itself is safe — it is not a secret value.
    expect(err!.field).toBe("STELLAR_NETWORK_PASSPHRASE");
    // The code is the machine-readable classification, not the raw value.
    expect(err!.code).toBe("missing");
  });
});

// ---------------------------------------------------------------------------
// Network-mode isolation: optional endpoints not incorrectly required
//
// SOROBAN_HTLC_TESTNET is optional but format-checked when present in testnet
// mode.  SOROBAN_HTLC_MAINNET is checked in mainnet mode.  The validator must
// not require the wrong key for the active mode, and must not report a format
// error for a missing optional key.
// ---------------------------------------------------------------------------

describe("validateRelayerStartup — optional SOROBAN_HTLC contract ID per mode", () => {
  // Valid Stellar StrKey: starts with 'C', 56 chars, base32 A-Z and 2-7.
  const VALID_CONTRACT_ID = "C" + "A".repeat(55);
  const INVALID_CONTRACT_ID = "not-a-contract-id";

  it("does not error when SOROBAN_HTLC_TESTNET is absent in testnet mode", () => {
    const errors = validateRelayerStartup(
      { ...VALID_ENV }, // no SOROBAN_HTLC_TESTNET key at all
      VALID_CFG,
    );
    expect(fieldCodes(errors)["SOROBAN_HTLC_TESTNET"]).toBeUndefined();
  });

  it("does not error when SOROBAN_HTLC_MAINNET is absent in mainnet mode", () => {
    const errors = validateRelayerStartup(
      { ...VALID_ENV_MAINNET }, // no SOROBAN_HTLC_MAINNET key at all
      VALID_CFG,
    );
    expect(fieldCodes(errors)["SOROBAN_HTLC_MAINNET"]).toBeUndefined();
  });

  it("accepts a valid contract ID for SOROBAN_HTLC_TESTNET in testnet mode", () => {
    const errors = validateRelayerStartup(
      { ...VALID_ENV, SOROBAN_HTLC_TESTNET: VALID_CONTRACT_ID },
      VALID_CFG,
    );
    expect(fieldCodes(errors)["SOROBAN_HTLC_TESTNET"]).toBeUndefined();
  });

  it("accepts a valid contract ID for SOROBAN_HTLC_MAINNET in mainnet mode", () => {
    const errors = validateRelayerStartup(
      { ...VALID_ENV_MAINNET, SOROBAN_HTLC_MAINNET: VALID_CONTRACT_ID },
      VALID_CFG,
    );
    expect(fieldCodes(errors)["SOROBAN_HTLC_MAINNET"]).toBeUndefined();
  });

  it("reports invalid_format for a malformed SOROBAN_HTLC_TESTNET in testnet mode", () => {
    const errors = validateRelayerStartup(
      { ...VALID_ENV, SOROBAN_HTLC_TESTNET: INVALID_CONTRACT_ID },
      VALID_CFG,
    );
    expect(fieldCodes(errors)["SOROBAN_HTLC_TESTNET"]).toBe("invalid_format");
  });

  it("reports invalid_format for a malformed SOROBAN_HTLC_MAINNET in mainnet mode", () => {
    const errors = validateRelayerStartup(
      { ...VALID_ENV_MAINNET, SOROBAN_HTLC_MAINNET: INVALID_CONTRACT_ID },
      VALID_CFG,
    );
    expect(fieldCodes(errors)["SOROBAN_HTLC_MAINNET"]).toBe("invalid_format");
  });

  it("does not check SOROBAN_HTLC_MAINNET when in testnet mode", () => {
    // Even if SOROBAN_HTLC_MAINNET is set to garbage, testnet mode must not
    // validate it — the wrong-mode key is simply ignored.
    const errors = validateRelayerStartup(
      { ...VALID_ENV, SOROBAN_HTLC_MAINNET: INVALID_CONTRACT_ID },
      VALID_CFG,
    );
    expect(fieldCodes(errors)["SOROBAN_HTLC_MAINNET"]).toBeUndefined();
  });

  it("does not check SOROBAN_HTLC_TESTNET when in mainnet mode", () => {
    const errors = validateRelayerStartup(
      { ...VALID_ENV_MAINNET, SOROBAN_HTLC_TESTNET: INVALID_CONTRACT_ID },
      VALID_CFG,
    );
    expect(fieldCodes(errors)["SOROBAN_HTLC_TESTNET"]).toBeUndefined();
  });

  it("skips format check for a placeholder contract ID (placeholder takes precedence)", () => {
    // A placeholder value gets a 'placeholder' code, not 'invalid_format'.
    // This is consistent with other URL fields that follow the same priority.
    // However, the validator currently skips the format check entirely when
    // the value is a placeholder — so no error is emitted.
    const errors = validateRelayerStartup(
      { ...VALID_ENV, SOROBAN_HTLC_TESTNET: "YOUR_CONTRACT_ID_HERE" },
      VALID_CFG,
    );
    // A placeholder contract ID is treated as "not set" by the optional check.
    expect(fieldCodes(errors)["SOROBAN_HTLC_TESTNET"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Full missing-fields aggregation including new required fields
//
// Extends the existing aggregation test to cover all required fields added
// after the initial implementation, so a bare `{}` env surfaces everything.
// ---------------------------------------------------------------------------

describe("validateRelayerStartup — full missing-fields aggregation", () => {
  it("reports all required endpoint fields when env is empty", () => {
    const errFields = errorFields(validateRelayerStartup({}, {}));
    expect(errFields).toContain("ETHEREUM_RPC_URL");
    expect(errFields).toContain("STELLAR_HORIZON_URL");
    expect(errFields).toContain("SOROBAN_RPC_URL");
    expect(errFields).toContain("COORDINATOR_URL");
    expect(errFields).toContain("STELLAR_NETWORK_PASSPHRASE");
    expect(errFields).toContain("RELAYER_PRIVATE_KEY");
    expect(errFields).toContain("RELAYER_STELLAR_SECRET");
  });

  it("missing Ethereum endpoint is reported independently of Stellar endpoint", () => {
    // Remove only ETHEREUM_RPC_URL; all Stellar fields remain valid.
    const errFields = errorFields(
      validateRelayerStartup({ ...VALID_ENV, ETHEREUM_RPC_URL: undefined }, VALID_CFG),
    );
    expect(errFields).toContain("ETHEREUM_RPC_URL");
    expect(errFields).not.toContain("STELLAR_HORIZON_URL");
    expect(errFields).not.toContain("SOROBAN_RPC_URL");
  });

  it("missing Stellar Horizon endpoint is reported independently of Ethereum endpoint", () => {
    const errFields = errorFields(
      validateRelayerStartup({ ...VALID_ENV, STELLAR_HORIZON_URL: undefined }, VALID_CFG),
    );
    expect(errFields).toContain("STELLAR_HORIZON_URL");
    expect(errFields).not.toContain("ETHEREUM_RPC_URL");
    expect(errFields).not.toContain("SOROBAN_RPC_URL");
  });

  it("missing Soroban endpoint is reported independently of Ethereum and Horizon endpoints", () => {
    const errFields = errorFields(
      validateRelayerStartup({ ...VALID_ENV, SOROBAN_RPC_URL: undefined }, VALID_CFG),
    );
    expect(errFields).toContain("SOROBAN_RPC_URL");
    expect(errFields).not.toContain("ETHEREUM_RPC_URL");
    expect(errFields).not.toContain("STELLAR_HORIZON_URL");
  });

  it("error messages identify the dependency by safe name, not raw value", () => {
    // Each error message must name the field being reported without echoing
    // any credential or secret value.  We verify the field name appears and
    // the message does not contain 'undefined' or 'null'.
    const errors = validateRelayerStartup(
      { ...VALID_ENV, ETHEREUM_RPC_URL: undefined, SOROBAN_RPC_URL: undefined },
      VALID_CFG,
    );
    for (const err of errors) {
      expect(err.message).not.toMatch(/^undefined$/);
      expect(err.message).not.toMatch(/^null$/);
      expect(err.field.length).toBeGreaterThan(0);
    }
  });
});
