import { describe, it, expect } from "vitest";
import {
  loadCoordinatorConfig,
  loadResolverConfig,
  loadRelayerConfig,
} from "../src/node.js";

describe("Consolidated Environment Configuration Validation", () => {
  describe("Coordinator Configuration", () => {
    it("should successfully load valid default configuration", () => {
      const validEnv = {
        NETWORK_MODE: "testnet",
        ETHEREUM_RPC_URL: "https://ethereum-sepolia.publicnode.com",
        STELLAR_HORIZON_URL: "https://horizon-testnet.stellar.org",
        SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
        SOLANA_RPC_URL: "https://api.devnet.solana.com",
      };

      const config = loadCoordinatorConfig(validEnv);
      expect(config.network).toBe("testnet");
      expect(config.ethereum.rpcUrl).toBe("https://ethereum-sepolia.publicnode.com");
      expect(config.port).toBe(3001);
    });

    it("should throw a validation error if ETHEREUM_RPC_URL is missing or invalid", () => {
      const invalidEnv = {
        NETWORK_MODE: "testnet",
        ETHEREUM_RPC_URL: "not-a-url",
      };

      expect(() => loadCoordinatorConfig(invalidEnv)).toThrow();
    });

    it("should reject invalid EVM contract addresses", () => {
      const invalidEnv = {
        NETWORK_MODE: "testnet",
        ETHEREUM_RPC_URL: "https://ethereum-sepolia.publicnode.com",
        ETH_HTLC_ESCROW_TESTNET: "invalid-address",
      };

      expect(() => loadCoordinatorConfig(invalidEnv)).toThrow(/must be a 0x-prefixed 20-byte address/);
    });
  });

  describe("Resolver Configuration", () => {
    it("should fail-fast if resolver private key is set but malformed", () => {
      const invalidEnv = {
        NETWORK_MODE: "testnet",
        ETHEREUM_RPC_URL: "https://ethereum-sepolia.publicnode.com",
        RESOLVER_ETH_PRIVATE_KEY: "0x123", // too short
      };

      expect(() => loadResolverConfig(invalidEnv)).toThrow(/must be a 0x-prefixed 32-byte hex private key/);
    });

    it("should fail-fast if resolver Stellar secret is set but malformed", () => {
      const invalidEnv = {
        NETWORK_MODE: "testnet",
        ETHEREUM_RPC_URL: "https://ethereum-sepolia.publicnode.com",
        RESOLVER_STELLAR_SECRET: "not-a-secret-key",
      };

      expect(() => loadResolverConfig(invalidEnv)).toThrow(/must be a valid Stellar Ed25519 secret seed/);
    });
  });

  describe("Relayer Configuration", () => {
    it("should successfully parse csv for resolver allowlist", () => {
      const env = {
        NETWORK_MODE: "testnet",
        ETHEREUM_RPC_URL: "https://ethereum-sepolia.publicnode.com",
        STELLAR_HORIZON_URL: "https://horizon-testnet.stellar.org",
        RELAYER_RESOLVER_ADDRESSES: "0x1234567890123456789012345678901234567890, 0xABCDEFabcdef1234567890123456789012345678",
      };

      const config = loadRelayerConfig(env);
      expect(config.resolverAllowlist).toEqual([
        "0x1234567890123456789012345678901234567890",
        "0xabcdefabcdef1234567890123456789012345678",
      ]);
    });
  });
});
