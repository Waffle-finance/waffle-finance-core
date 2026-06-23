import { describe, it, expect } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  ConfigValidationError,
  validateStellarSecret,
  validateEthereumPrivateKey,
  assertEthereumChainId,
  assertSorobanReachable,
  validateResolverConfig
} from "../src/validation.js";
import type { ResolverConfig } from "../src/config.js";

// Well-known throwaway test key (Anvil/Hardhat account #1). Public test material.
const VALID_ETH_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const VALID_ETH_ADDRESS = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

const MAINNET_PASSPHRASE = "Public Global Stellar Network ; September 2015";
const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";

function baseConfig(overrides: Partial<ResolverConfig> = {}): ResolverConfig {
  return {
    network: "testnet",
    pollIntervalMs: 15_000,
    coordinatorUrl: "http://localhost:3001",
    logLevel: "info",
    ethereum: {
      rpcUrl: "https://rpc.example/testnet",
      chainId: 11_155_111,
      htlcEscrow: null,
      resolverRegistry: null,
      resolverPrivateKey: null
    },
    soroban: {
      rpcUrl: "https://soroban-testnet.stellar.org",
      networkPassphrase: TESTNET_PASSPHRASE,
      horizonUrl: "https://horizon-testnet.stellar.org",
      htlc: null,
      resolverRegistry: null,
      resolverSecret: null
    },
    ...overrides
  };
}

describe("validateStellarSecret", () => {
  it("returns the public key for a valid S... seed", () => {
    const kp = Keypair.random();
    const pub = validateStellarSecret(kp.secret());
    expect(pub).toBe(kp.publicKey());
    expect(pub.startsWith("G")).toBe(true);
  });

  it("throws ConfigValidationError on a malformed seed", () => {
    expect(() => validateStellarSecret("not-a-real-secret")).toThrow(ConfigValidationError);
  });

  it("rejects a public key supplied where a secret is expected", () => {
    const kp = Keypair.random();
    expect(() => validateStellarSecret(kp.publicKey())).toThrow(ConfigValidationError);
  });

  it("never echoes the secret in the error message", () => {
    const secret = "SECRETVALUE_SHOULD_NOT_APPEAR_1234567890";
    try {
      validateStellarSecret(secret);
      throw new Error("expected validation to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigValidationError);
      expect((err as Error).message).not.toContain(secret);
    }
  });
});

describe("validateEthereumPrivateKey", () => {
  it("returns the derived address for a valid key", () => {
    const addr = validateEthereumPrivateKey(VALID_ETH_KEY);
    expect(addr).toBe(VALID_ETH_ADDRESS);
  });

  it("rejects a key missing the 0x prefix", () => {
    expect(() => validateEthereumPrivateKey(VALID_ETH_KEY.slice(2))).toThrow(
      ConfigValidationError
    );
  });

  it("rejects a key of the wrong length", () => {
    expect(() => validateEthereumPrivateKey("0xdeadbeef")).toThrow(ConfigValidationError);
  });

  it("never echoes the key in the error message", () => {
    const key = "0xZZZ_invalid_key_material_that_must_not_be_logged";
    try {
      validateEthereumPrivateKey(key);
      throw new Error("expected validation to throw");
    } catch (err) {
      expect((err as Error).message).not.toContain(key);
    }
  });
});

describe("assertEthereumChainId", () => {
  it("passes when the RPC reports the expected chain id", async () => {
    await expect(
      assertEthereumChainId("https://rpc.example", 1, async () => 1)
    ).resolves.toBeUndefined();
  });

  it("throws a clear mismatch error on the wrong chain id", async () => {
    await expect(
      assertEthereumChainId("https://rpc.example", 1, async () => 11_155_111)
    ).rejects.toThrow(/chain id mismatch/i);
  });

  it("wraps connectivity failures without leaking URL credentials", async () => {
    const url = "https://mainnet.infura.io/v3/SUPERSECRETKEY";
    try {
      await assertEthereumChainId(url, 1, async () => {
        throw new Error("ECONNREFUSED");
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigValidationError);
      expect((err as Error).message).toContain("https://mainnet.infura.io");
      expect((err as Error).message).not.toContain("SUPERSECRETKEY");
    }
  });
});

describe("assertSorobanReachable", () => {
  it("passes when the passphrase matches", async () => {
    await expect(
      assertSorobanReachable("https://soroban", TESTNET_PASSPHRASE, async () => TESTNET_PASSPHRASE)
    ).resolves.toBeUndefined();
  });

  it("throws on a network passphrase mismatch", async () => {
    await expect(
      assertSorobanReachable("https://soroban", TESTNET_PASSPHRASE, async () => MAINNET_PASSPHRASE)
    ).rejects.toThrow(/network mismatch/i);
  });

  it("wraps connectivity failures", async () => {
    await expect(
      assertSorobanReachable("https://soroban", TESTNET_PASSPHRASE, async () => {
        throw new Error("timeout");
      })
    ).rejects.toThrow(ConfigValidationError);
  });
});

describe("validateResolverConfig", () => {
  it("passes with no secrets when connectivity checks are skipped (observe-only)", async () => {
    await expect(
      validateResolverConfig(baseConfig(), { checkConnectivity: false })
    ).resolves.toBeUndefined();
  });

  it("validates well-formed secrets without network access", async () => {
    const cfg = baseConfig();
    cfg.ethereum.resolverPrivateKey = VALID_ETH_KEY;
    cfg.soroban.resolverSecret = Keypair.random().secret();
    await expect(
      validateResolverConfig(cfg, { checkConnectivity: false })
    ).resolves.toBeUndefined();
  });

  it("fails fast on an invalid Stellar secret before any connectivity check", async () => {
    const cfg = baseConfig();
    cfg.soroban.resolverSecret = "bogus-secret";
    let probed = false;
    await expect(
      validateResolverConfig(cfg, {
        ethereumChainIdProbe: async () => {
          probed = true;
          return cfg.ethereum.chainId;
        }
      })
    ).rejects.toThrow(ConfigValidationError);
    expect(probed).toBe(false); // synchronous key checks run before network checks
  });

  it("fails on an invalid Ethereum private key", async () => {
    const cfg = baseConfig();
    cfg.ethereum.resolverPrivateKey = "0xnothex" as `0x${string}`;
    await expect(
      validateResolverConfig(cfg, { checkConnectivity: false })
    ).rejects.toThrow(ConfigValidationError);
  });

  it("runs connectivity checks with injected probes when enabled", async () => {
    const cfg = baseConfig();
    await expect(
      validateResolverConfig(cfg, {
        ethereumChainIdProbe: async () => cfg.ethereum.chainId,
        sorobanPassphraseProbe: async () => cfg.soroban.networkPassphrase
      })
    ).resolves.toBeUndefined();
  });

  it("rejects a wrong-chain Ethereum endpoint during startup validation", async () => {
    const cfg = baseConfig();
    await expect(
      validateResolverConfig(cfg, {
        ethereumChainIdProbe: async () => 1, // mainnet RPC while NETWORK_MODE=testnet
        sorobanPassphraseProbe: async () => cfg.soroban.networkPassphrase
      })
    ).rejects.toThrow(/chain id mismatch/i);
  });
});
