import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { loadConfig } from "../src/config.js";
import { ConfigValidationError } from "../src/validation.js";

const VALID_ETH_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

// Env vars touched by these tests, cleared between runs for isolation.
const MANAGED_KEYS = [
  "NETWORK_MODE",
  "RESOLVER_ETH_PRIVATE_KEY",
  "RESOLVER_STELLAR_SECRET",
  "ETH_HTLC_ESCROW_TESTNET",
  "SOROBAN_HTLC_TESTNET"
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of MANAGED_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of MANAGED_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("loadConfig", () => {
  it("defaults to the testnet network with sepolia chain id", () => {
    const cfg = loadConfig();
    expect(cfg.network).toBe("testnet");
    expect(cfg.ethereum.chainId).toBe(11_155_111);
    expect(cfg.soroban.networkPassphrase).toContain("Test SDF Network");
  });

  it("selects mainnet chain id and passphrase when NETWORK_MODE=mainnet", () => {
    process.env.NETWORK_MODE = "mainnet";
    const cfg = loadConfig();
    expect(cfg.network).toBe("mainnet");
    expect(cfg.ethereum.chainId).toBe(1);
    expect(cfg.soroban.networkPassphrase).toContain("Public Global Stellar Network");
  });

  it("throws on an unknown NETWORK_MODE", () => {
    process.env.NETWORK_MODE = "devnet";
    expect(() => loadConfig()).toThrow(/NETWORK_MODE/);
  });

  it("leaves optional secrets null when env vars are missing", () => {
    const cfg = loadConfig();
    expect(cfg.ethereum.resolverPrivateKey).toBeNull();
    expect(cfg.soroban.resolverSecret).toBeNull();
  });

  it("accepts valid secret material", () => {
    process.env.RESOLVER_ETH_PRIVATE_KEY = VALID_ETH_KEY;
    process.env.RESOLVER_STELLAR_SECRET = Keypair.random().secret();
    const cfg = loadConfig();
    expect(cfg.ethereum.resolverPrivateKey).toBe(VALID_ETH_KEY);
    expect(cfg.soroban.resolverSecret).not.toBeNull();
  });

  it("fails fast on an invalid Stellar secret without leaking it", () => {
    process.env.RESOLVER_STELLAR_SECRET = "INVALID_STELLAR_SECRET_VALUE";
    try {
      loadConfig();
      throw new Error("expected loadConfig to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigValidationError);
      expect((err as Error).message).not.toContain("INVALID_STELLAR_SECRET_VALUE");
    }
  });

  it("fails fast on an invalid Ethereum private key", () => {
    process.env.RESOLVER_ETH_PRIVATE_KEY = "0xtooshort";
    expect(() => loadConfig()).toThrow(ConfigValidationError);
  });
});
