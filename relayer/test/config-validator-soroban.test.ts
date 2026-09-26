/**
 * Tests for the Soroban-specific validation rules added to validateRelayerStartup.
 *
 * Covers:
 *  - SOROBAN_RPC_URL: missing, placeholder, invalid format, valid
 *  - STELLAR_NETWORK_PASSPHRASE: missing, wrong passphrase for network mode, valid
 *  - SOROBAN_HTLC_TESTNET / SOROBAN_HTLC_MAINNET: invalid format rejected, valid accepted
 *  - NETWORK_MODE interaction: mainnet passphrase accepted in mainnet mode
 */

import { describe, it, expect } from "vitest";
import {
  validateRelayerStartup,
  type ConfigError,
} from "../src/config-validator.js";

// ── Shared fixtures ───────────────────────────────────────────────────────────

const VALID_ETH_KEY = "0x" + "a".repeat(63) + "1";
const VALID_STELLAR_SECRET = "S" + "A".repeat(55);

const VALID_CFG = {
  ethereumPrivateKey: VALID_ETH_KEY,
  stellarSecretKey: VALID_STELLAR_SECRET,
};

const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
const MAINNET_PASSPHRASE = "Public Global Stellar Network ; September 2015";

// A minimal valid environment that passes all existing and new checks.
const VALID_ENV_BASE = {
  ETHEREUM_RPC_URL: "https://sepolia.infura.io/v3/key",
  STELLAR_HORIZON_URL: "https://horizon-testnet.stellar.org",
  SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
  STELLAR_NETWORK_PASSPHRASE: TESTNET_PASSPHRASE,
};

function fieldCodes(errors: ConfigError[]): Record<string, string> {
  return Object.fromEntries(errors.map((e) => [e.field, e.code]));
}

// ── SOROBAN_RPC_URL ───────────────────────────────────────────────────────────

describe("validateRelayerStartup — SOROBAN_RPC_URL", () => {
  it("reports missing when SOROBAN_RPC_URL is absent", () => {
    const env = { ...VALID_ENV_BASE, SOROBAN_RPC_URL: undefined };
    const codes = fieldCodes(validateRelayerStartup(env, VALID_CFG));
    expect(codes["SOROBAN_RPC_URL"]).toBe("missing");
  });

  it("reports placeholder for a YOUR_-prefixed URL", () => {
    const env = { ...VALID_ENV_BASE, SOROBAN_RPC_URL: "https://YOUR_RPC.sorobanrpc.com" };
    const codes = fieldCodes(validateRelayerStartup(env, VALID_CFG));
    expect(codes["SOROBAN_RPC_URL"]).toBe("placeholder");
  });

  it("reports placeholder for a REPLACE_ME value", () => {
    const env = { ...VALID_ENV_BASE, SOROBAN_RPC_URL: "https://REPLACE_ME" };
    const codes = fieldCodes(validateRelayerStartup(env, VALID_CFG));
    expect(codes["SOROBAN_RPC_URL"]).toBe("placeholder");
  });

  it("reports invalid_format for a non-HTTP URL", () => {
    const env = { ...VALID_ENV_BASE, SOROBAN_RPC_URL: "wss://soroban-testnet.stellar.org" };
    const codes = fieldCodes(validateRelayerStartup(env, VALID_CFG));
    expect(codes["SOROBAN_RPC_URL"]).toBe("invalid_format");
  });

  it("reports invalid_format for a bare hostname", () => {
    const env = { ...VALID_ENV_BASE, SOROBAN_RPC_URL: "soroban-testnet.stellar.org" };
    const codes = fieldCodes(validateRelayerStartup(env, VALID_CFG));
    expect(codes["SOROBAN_RPC_URL"]).toBe("invalid_format");
  });

  it("accepts a valid https testnet RPC URL", () => {
    const errors = validateRelayerStartup(VALID_ENV_BASE, VALID_CFG);
    expect(fieldCodes(errors)["SOROBAN_RPC_URL"]).toBeUndefined();
  });

  it("accepts a valid http localhost URL (sandbox)", () => {
    const env = { ...VALID_ENV_BASE, SOROBAN_RPC_URL: "http://localhost:8000" };
    const errors = validateRelayerStartup(env, VALID_CFG);
    expect(fieldCodes(errors)["SOROBAN_RPC_URL"]).toBeUndefined();
  });

  it("accepts the mainnet Soroban RPC URL", () => {
    const env = {
      ...VALID_ENV_BASE,
      SOROBAN_RPC_URL: "https://mainnet.sorobanrpc.com",
      STELLAR_NETWORK_PASSPHRASE: MAINNET_PASSPHRASE,
      NETWORK_MODE: "mainnet",
      STELLAR_HORIZON_URL: "https://horizon.stellar.org",
      ETHEREUM_RPC_URL: "https://mainnet.infura.io/v3/key",
    };
    const errors = validateRelayerStartup(env, VALID_CFG);
    expect(fieldCodes(errors)["SOROBAN_RPC_URL"]).toBeUndefined();
  });
});

// ── STELLAR_NETWORK_PASSPHRASE ────────────────────────────────────────────────

describe("validateRelayerStartup — STELLAR_NETWORK_PASSPHRASE", () => {
  it("reports missing when STELLAR_NETWORK_PASSPHRASE is absent", () => {
    const env = { ...VALID_ENV_BASE, STELLAR_NETWORK_PASSPHRASE: undefined };
    const codes = fieldCodes(validateRelayerStartup(env, VALID_CFG));
    expect(codes["STELLAR_NETWORK_PASSPHRASE"]).toBe("missing");
  });

  it("reports invalid_value when testnet passphrase is used with mainnet mode", () => {
    const env = {
      ...VALID_ENV_BASE,
      STELLAR_NETWORK_PASSPHRASE: TESTNET_PASSPHRASE,
      NETWORK_MODE: "mainnet",
    };
    const codes = fieldCodes(validateRelayerStartup(env, VALID_CFG));
    expect(codes["STELLAR_NETWORK_PASSPHRASE"]).toBe("invalid_value");
  });

  it("reports invalid_value when mainnet passphrase is used with testnet mode", () => {
    const env = {
      ...VALID_ENV_BASE,
      STELLAR_NETWORK_PASSPHRASE: MAINNET_PASSPHRASE,
      NETWORK_MODE: "testnet",
    };
    const codes = fieldCodes(validateRelayerStartup(env, VALID_CFG));
    expect(codes["STELLAR_NETWORK_PASSPHRASE"]).toBe("invalid_value");
  });

  it("reports invalid_value for a completely wrong passphrase", () => {
    const env = { ...VALID_ENV_BASE, STELLAR_NETWORK_PASSPHRASE: "wrong passphrase" };
    const codes = fieldCodes(validateRelayerStartup(env, VALID_CFG));
    expect(codes["STELLAR_NETWORK_PASSPHRASE"]).toBe("invalid_value");
  });

  it("accepts the correct testnet passphrase when NETWORK_MODE=testnet", () => {
    const env = { ...VALID_ENV_BASE, NETWORK_MODE: "testnet" };
    const errors = validateRelayerStartup(env, VALID_CFG);
    expect(fieldCodes(errors)["STELLAR_NETWORK_PASSPHRASE"]).toBeUndefined();
  });

  it("accepts the correct testnet passphrase when NETWORK_MODE is absent (defaults to testnet)", () => {
    const errors = validateRelayerStartup(VALID_ENV_BASE, VALID_CFG);
    expect(fieldCodes(errors)["STELLAR_NETWORK_PASSPHRASE"]).toBeUndefined();
  });

  it("accepts the correct mainnet passphrase when NETWORK_MODE=mainnet", () => {
    const env = {
      ...VALID_ENV_BASE,
      STELLAR_NETWORK_PASSPHRASE: MAINNET_PASSPHRASE,
      NETWORK_MODE: "mainnet",
    };
    const errors = validateRelayerStartup(env, VALID_CFG);
    expect(fieldCodes(errors)["STELLAR_NETWORK_PASSPHRASE"]).toBeUndefined();
  });

  it("error message includes expected passphrase and network mode", () => {
    const env = { ...VALID_ENV_BASE, STELLAR_NETWORK_PASSPHRASE: "wrong" };
    const errors = validateRelayerStartup(env, VALID_CFG);
    const err = errors.find((e) => e.field === "STELLAR_NETWORK_PASSPHRASE");
    expect(err?.message).toContain(TESTNET_PASSPHRASE);
    expect(err?.message).toContain("testnet");
  });

  it("reads network mode from cfg.network when NETWORK_MODE env var is absent", () => {
    const env = {
      ...VALID_ENV_BASE,
      STELLAR_NETWORK_PASSPHRASE: MAINNET_PASSPHRASE,
      NETWORK_MODE: undefined,
    };
    // cfg.network=mainnet → expects mainnet passphrase
    const errors = validateRelayerStartup(env, { ...VALID_CFG, network: "mainnet" });
    expect(fieldCodes(errors)["STELLAR_NETWORK_PASSPHRASE"]).toBeUndefined();
  });
});

// ── Soroban HTLC contract ID format ──────────────────────────────────────────

describe("validateRelayerStartup — Soroban HTLC contract ID", () => {
  it("does not error when SOROBAN_HTLC_TESTNET is absent", () => {
    const env = { ...VALID_ENV_BASE, SOROBAN_HTLC_TESTNET: undefined };
    const errors = validateRelayerStartup(env, VALID_CFG);
    expect(fieldCodes(errors)["SOROBAN_HTLC_TESTNET"]).toBeUndefined();
  });

  it("does not error when SOROBAN_HTLC_TESTNET is a placeholder", () => {
    const env = { ...VALID_ENV_BASE, SOROBAN_HTLC_TESTNET: "YOUR_SOROBAN_HTLC" };
    const errors = validateRelayerStartup(env, VALID_CFG);
    expect(fieldCodes(errors)["SOROBAN_HTLC_TESTNET"]).toBeUndefined();
  });

  it("reports invalid_format when SOROBAN_HTLC_TESTNET is not a valid StrKey", () => {
    const env = { ...VALID_ENV_BASE, SOROBAN_HTLC_TESTNET: "not-a-stellar-contract" };
    const codes = fieldCodes(validateRelayerStartup(env, VALID_CFG));
    expect(codes["SOROBAN_HTLC_TESTNET"]).toBe("invalid_format");
  });

  it("reports invalid_format for a contract ID that is too short", () => {
    const env = { ...VALID_ENV_BASE, SOROBAN_HTLC_TESTNET: "CSHORT" };
    const codes = fieldCodes(validateRelayerStartup(env, VALID_CFG));
    expect(codes["SOROBAN_HTLC_TESTNET"]).toBe("invalid_format");
  });

  it("reports invalid_format for a contract ID starting with G (account key, not contract)", () => {
    const env = {
      ...VALID_ENV_BASE,
      SOROBAN_HTLC_TESTNET: "G" + "A".repeat(55),
    };
    const codes = fieldCodes(validateRelayerStartup(env, VALID_CFG));
    expect(codes["SOROBAN_HTLC_TESTNET"]).toBe("invalid_format");
  });

  it("accepts a valid 56-char Stellar contract StrKey", () => {
    const validContractId = "C" + "A".repeat(55);
    const env = { ...VALID_ENV_BASE, SOROBAN_HTLC_TESTNET: validContractId };
    const errors = validateRelayerStartup(env, VALID_CFG);
    expect(fieldCodes(errors)["SOROBAN_HTLC_TESTNET"]).toBeUndefined();
  });

  it("checks SOROBAN_HTLC_MAINNET when NETWORK_MODE=mainnet", () => {
    const validContractId = "C" + "A".repeat(55);
    const env = {
      ...VALID_ENV_BASE,
      STELLAR_NETWORK_PASSPHRASE: MAINNET_PASSPHRASE,
      NETWORK_MODE: "mainnet",
      SOROBAN_HTLC_MAINNET: "not-valid",
    };
    const codes = fieldCodes(validateRelayerStartup(env, VALID_CFG));
    expect(codes["SOROBAN_HTLC_MAINNET"]).toBe("invalid_format");
    // Testnet key is not checked in mainnet mode
    expect(codes["SOROBAN_HTLC_TESTNET"]).toBeUndefined();
    void validContractId;
  });
});

// ── All Soroban errors aggregated in one pass ─────────────────────────────────

describe("validateRelayerStartup — Soroban errors aggregated", () => {
  it("collects SOROBAN_RPC_URL and STELLAR_NETWORK_PASSPHRASE errors together", () => {
    const env = {
      ETHEREUM_RPC_URL: "https://sepolia.infura.io/v3/key",
      STELLAR_HORIZON_URL: "https://horizon-testnet.stellar.org",
      SOROBAN_RPC_URL: undefined,
      STELLAR_NETWORK_PASSPHRASE: undefined,
    };
    const errors = validateRelayerStartup(env, VALID_CFG);
    const codes = fieldCodes(errors);
    expect(codes["SOROBAN_RPC_URL"]).toBe("missing");
    expect(codes["STELLAR_NETWORK_PASSPHRASE"]).toBe("missing");
  });
});
