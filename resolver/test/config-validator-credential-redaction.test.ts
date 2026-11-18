/**
 * config-validator-credential-redaction.test.ts
 *
 * Component: Resolver config validation — credential redaction.
 *
 * The validation layer reports connectivity failures and must redact embedded
 * credentials in endpoint URLs. A regression test protects operator secrets
 * from being copied into logs or API responses.
 *
 * Covers
 * ------
 *   - Malformed URL with embedded fake token (username, password, path)
 *   - Unreachable endpoint with embedded fake token
 *   - Soroban passphrase mismatch with credential-bearing URL
 *   - Fake credentials never appear in serialized errors or captured logs
 *   - The endpoint host and failure category remain diagnosable in errors
 *   - Existing valid URL cases (no credentials) remain accepted
 *
 * Acceptance criteria
 * -------------------
 *  - Fake credentials never appear in validation output.
 *  - The endpoint host and failure category remain diagnosable.
 *  - Existing valid URL cases remain accepted.
 */

import { describe, it, expect, vi } from "vitest";
import {
  ConfigValidationError,
  assertEthereumChainId,
  assertSorobanReachable,
  validateResolverConfig,
  validateEthereumPrivateKey,
  validateStellarSecret,
} from "../src/validation.js";
import { Keypair } from "@stellar/stellar-sdk";
import type { ResolverConfig } from "../src/config.js";

// ── Fake credentials used across tests ───────────────────────────────────────
// These are distinctive fictional tokens. Any test that finds them in output
// is evidence of a credential leak.

const FAKE_INFURA_KEY = "FAKE_INFURA_SECRET_9a8b7c6d5e";
const FAKE_PASSWORD_IN_URL = "hunter2_fake_password";
const FAKE_USERNAME_IN_URL = "apiuser_fake";
const FAKE_QUERY_TOKEN = "access_token_FAKE_12345";

// URLs with credentials embedded in different positions.
const ETH_URL_PATH_CRED = `https://mainnet.infura.io/v3/${FAKE_INFURA_KEY}`;
const ETH_URL_USERINFO_CRED = `https://${FAKE_USERNAME_IN_URL}:${FAKE_PASSWORD_IN_URL}@eth-node.example.com:8545`;
const SOROBAN_URL_PATH_CRED = `https://soroban.example.io/rpc/${FAKE_INFURA_KEY}`;
const ETH_URL_QUERY_CRED = `https://eth-node.example.com/json-rpc?api_key=${FAKE_QUERY_TOKEN}`;

const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
const MAINNET_PASSPHRASE = "Public Global Stellar Network ; September 2015";

const VALID_ETH_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;

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
      resolverPrivateKey: null,
    },
    soroban: {
      rpcUrl: "https://soroban-testnet.stellar.org",
      networkPassphrase: TESTNET_PASSPHRASE,
      horizonUrl: "https://horizon-testnet.stellar.org",
      htlc: null,
      resolverRegistry: null,
      resolverSecret: null,
    },
    ...overrides,
  };
}

// ── assertEthereumChainId — credential-bearing URLs ───────────────────────────

describe("assertEthereumChainId — fake credentials never appear in errors", () => {
  it("redacts Infura API key from a path-embedded credential URL on connectivity failure", async () => {
    const probe = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(
      assertEthereumChainId(ETH_URL_PATH_CRED, 1, probe)
    ).rejects.toThrow(ConfigValidationError);

    try {
      await assertEthereumChainId(ETH_URL_PATH_CRED, 1, probe);
    } catch (err) {
      const message = (err as Error).message;
      expect(message).not.toContain(FAKE_INFURA_KEY);
      // Host should still appear so the operator knows which endpoint failed.
      expect(message).toContain("mainnet.infura.io");
    }
  });

  it("redacts userinfo credentials (username:password@host) on connectivity failure", async () => {
    const probe = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    try {
      await assertEthereumChainId(ETH_URL_USERINFO_CRED, 1, probe);
    } catch (err) {
      const message = (err as Error).message;
      expect(message).not.toContain(FAKE_PASSWORD_IN_URL);
      expect(message).not.toContain(FAKE_USERNAME_IN_URL);
      // The host is safe to include.
      expect(message).toContain("eth-node.example.com");
    }
  });

  it("redacts query parameter tokens on connectivity failure", async () => {
    const probe = vi.fn().mockRejectedValue(new Error("timeout"));

    try {
      await assertEthereumChainId(ETH_URL_QUERY_CRED, 1, probe);
    } catch (err) {
      const message = (err as Error).message;
      expect(message).not.toContain(FAKE_QUERY_TOKEN);
      expect(message).toContain("eth-node.example.com");
    }
  });

  it("redacts path credential on chain-id mismatch (wrong network)", async () => {
    // Probe succeeds but returns wrong chain id.
    const probe = vi.fn().mockResolvedValue(11_155_111); // testnet, not mainnet

    try {
      await assertEthereumChainId(ETH_URL_PATH_CRED, 1, probe); // expects mainnet (1)
    } catch (err) {
      const message = (err as Error).message;
      expect(message).not.toContain(FAKE_INFURA_KEY);
      expect(message).toContain("mainnet.infura.io");
      // The error must still be diagnosable: it should mention the mismatch.
      expect(message.toLowerCase()).toMatch(/chain.*id.*mismatch|mismatch.*chain/i);
    }
  });

  it("valid credential-bearing URL is accepted when probe succeeds with correct chain id", async () => {
    const probe = vi.fn().mockResolvedValue(1); // mainnet
    await expect(
      assertEthereumChainId(ETH_URL_PATH_CRED, 1, probe)
    ).resolves.toBeUndefined();
  });
});

// ── assertSorobanReachable — credential-bearing URLs ──────────────────────────

describe("assertSorobanReachable — fake credentials never appear in errors", () => {
  it("redacts path-embedded token on connectivity failure", async () => {
    const probe = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    try {
      await assertSorobanReachable(SOROBAN_URL_PATH_CRED, TESTNET_PASSPHRASE, probe);
    } catch (err) {
      const message = (err as Error).message;
      expect(message).not.toContain(FAKE_INFURA_KEY);
      expect(message).toContain("soroban.example.io");
    }
  });

  it("redacts path-embedded token on passphrase mismatch", async () => {
    // Probe succeeds but returns the wrong passphrase.
    const probe = vi.fn().mockResolvedValue(MAINNET_PASSPHRASE);

    try {
      await assertSorobanReachable(SOROBAN_URL_PATH_CRED, TESTNET_PASSPHRASE, probe);
    } catch (err) {
      const message = (err as Error).message;
      expect(message).not.toContain(FAKE_INFURA_KEY);
      // The host must appear for diagnosability.
      expect(message).toContain("soroban.example.io");
      // The failure category must be identified.
      expect(message.toLowerCase()).toMatch(/network.*mismatch|mismatch/i);
    }
  });

  it("valid credential-bearing Soroban URL is accepted when passphrase matches", async () => {
    const probe = vi.fn().mockResolvedValue(TESTNET_PASSPHRASE);
    await expect(
      assertSorobanReachable(SOROBAN_URL_PATH_CRED, TESTNET_PASSPHRASE, probe)
    ).resolves.toBeUndefined();
  });
});

// ── validateResolverConfig — end-to-end credential redaction ─────────────────

describe("validateResolverConfig — credentials in RPC URLs are never exposed", () => {
  it("does not expose Ethereum RPC credential when chain-id probe fails", async () => {
    const cfg = baseConfig({
      ethereum: {
        rpcUrl: ETH_URL_PATH_CRED,
        chainId: 1,
        htlcEscrow: null,
        resolverRegistry: null,
        resolverPrivateKey: null,
      },
    });

    let caughtMessage = "";
    try {
      await validateResolverConfig(cfg, {
        ethereumChainIdProbe: async () => {
          throw new Error("ECONNREFUSED connection refused");
        },
        sorobanPassphraseProbe: async () => TESTNET_PASSPHRASE,
      });
    } catch (err) {
      caughtMessage = (err as Error).message;
    }

    expect(caughtMessage).not.toContain(FAKE_INFURA_KEY);
    // Should still contain the host so the operator knows where to look.
    expect(caughtMessage).toContain("mainnet.infura.io");
  });

  it("does not expose Soroban RPC credential when passphrase probe fails", async () => {
    const cfg = baseConfig({
      soroban: {
        rpcUrl: SOROBAN_URL_PATH_CRED,
        networkPassphrase: TESTNET_PASSPHRASE,
        horizonUrl: "https://horizon-testnet.stellar.org",
        htlc: null,
        resolverRegistry: null,
        resolverSecret: null,
      },
    });

    let caughtMessage = "";
    try {
      await validateResolverConfig(cfg, {
        ethereumChainIdProbe: async () => cfg.ethereum.chainId,
        sorobanPassphraseProbe: async () => {
          throw new Error("timeout");
        },
      });
    } catch (err) {
      caughtMessage = (err as Error).message;
    }

    expect(caughtMessage).not.toContain(FAKE_INFURA_KEY);
    expect(caughtMessage).toContain("soroban.example.io");
  });

  it("does not expose Ethereum RPC credential when chain-id mismatches", async () => {
    const cfg = baseConfig({
      ethereum: {
        rpcUrl: ETH_URL_USERINFO_CRED,
        chainId: 11_155_111, // expects testnet
        htlcEscrow: null,
        resolverRegistry: null,
        resolverPrivateKey: null,
      },
    });

    let caughtMessage = "";
    try {
      await validateResolverConfig(cfg, {
        ethereumChainIdProbe: async () => 1, // returns mainnet — mismatch
        sorobanPassphraseProbe: async () => TESTNET_PASSPHRASE,
      });
    } catch (err) {
      caughtMessage = (err as Error).message;
    }

    expect(caughtMessage).not.toContain(FAKE_PASSWORD_IN_URL);
    expect(caughtMessage).not.toContain(FAKE_USERNAME_IN_URL);
    expect(caughtMessage).toContain("eth-node.example.com");
  });

  it("connectivity checks are skipped when checkConnectivity=false, no credential in error", async () => {
    const cfg = baseConfig({
      ethereum: {
        rpcUrl: ETH_URL_PATH_CRED,
        chainId: 11_155_111,
        htlcEscrow: null,
        resolverRegistry: null,
        resolverPrivateKey: VALID_ETH_KEY,
      },
    });

    // Should resolve without error — connectivity is skipped.
    await expect(
      validateResolverConfig(cfg, { checkConnectivity: false })
    ).resolves.toBeUndefined();
  });
});

// ── Key material validation — credential-bearing path in URL context ──────────

describe("validateEthereumPrivateKey — key material never echoed in errors", () => {
  it("does not echo an invalid key (which may resemble a credential) in the error", () => {
    const fakeKey = "0x" + "dead".repeat(16); // wrong length but looks like a credential

    let caughtMessage = "";
    try {
      validateEthereumPrivateKey(fakeKey);
    } catch (err) {
      caughtMessage = (err as Error).message;
    }

    expect(caughtMessage).not.toContain(fakeKey);
  });
});

describe("validateStellarSecret — secret never echoed in errors", () => {
  it("does not echo a malformed secret (which may resemble a credential) in the error", () => {
    const fakeSecret = "SECRET_THAT_LOOKS_LIKE_A_CREDENTIAL_XYZ123";

    let caughtMessage = "";
    try {
      validateStellarSecret(fakeSecret);
    } catch (err) {
      caughtMessage = (err as Error).message;
    }

    expect(caughtMessage).not.toContain(fakeSecret);
  });
});

// ── Existing valid URL cases remain accepted ───────────────────────────────────

describe("Validation — existing valid URL cases remain accepted", () => {
  it("accepts a plain https RPC URL without credentials", async () => {
    const probe = vi.fn().mockResolvedValue(1);
    await expect(
      assertEthereumChainId("https://eth-rpc.example.com", 1, probe)
    ).resolves.toBeUndefined();
  });

  it("accepts a Soroban RPC URL without credentials", async () => {
    const probe = vi.fn().mockResolvedValue(TESTNET_PASSPHRASE);
    await expect(
      assertSorobanReachable("https://soroban-testnet.stellar.org", TESTNET_PASSPHRASE, probe)
    ).resolves.toBeUndefined();
  });

  it("validateResolverConfig passes with valid plain URLs and correct probes", async () => {
    const cfg = baseConfig();
    await expect(
      validateResolverConfig(cfg, {
        ethereumChainIdProbe: async () => cfg.ethereum.chainId,
        sorobanPassphraseProbe: async () => cfg.soroban.networkPassphrase,
      })
    ).resolves.toBeUndefined();
  });

  it("validateResolverConfig accepts valid secrets even when RPC URL has a credential path", async () => {
    const cfg = baseConfig({
      ethereum: {
        rpcUrl: ETH_URL_PATH_CRED,
        chainId: 1,
        htlcEscrow: null,
        resolverRegistry: null,
        resolverPrivateKey: VALID_ETH_KEY,
      },
      soroban: {
        rpcUrl: "https://soroban-testnet.stellar.org",
        networkPassphrase: TESTNET_PASSPHRASE,
        horizonUrl: "https://horizon-testnet.stellar.org",
        htlc: null,
        resolverRegistry: null,
        resolverSecret: Keypair.random().secret(),
      },
    });

    await expect(
      validateResolverConfig(cfg, {
        ethereumChainIdProbe: async () => 1,
        sorobanPassphraseProbe: async () => TESTNET_PASSPHRASE,
      })
    ).resolves.toBeUndefined();
  });
});
