import { describe, it, expect } from "vitest";
import { loadChainSettings } from "../src/chains.js";
import {
  loadCoordinatorConfig,
  loadResolverConfig,
  loadRelayerConfig,
} from "../src/node.js";

describe("Consolidated Environment Configuration Validation", () => {
  describe("Chain Settings", () => {
    it("overrides default chain settings from mock environment values", () => {
      const config = loadChainSettings("testnet", {
        ETHEREUM_RPC_URL: "https://rpc.custom.example",
        TESTNET_ETHEREUM_CHAIN_ID: "424242",
        TESTNET_ETHEREUM_EXPLORER_URL: "https://explorer.custom.example",
        ETH_HTLC_ESCROW_TESTNET: "0x1111111111111111111111111111111111111111",
        ETH_ESCROW_FACTORY_TESTNET: "0x2222222222222222222222222222222222222222",
        ETH_HTLC_BRIDGE_TESTNET: "0x3333333333333333333333333333333333333333",
        SOROBAN_RPC_URL: "https://soroban.custom.example",
        STELLAR_HORIZON_URL: "https://horizon.custom.example",
        STELLAR_NETWORK_PASSPHRASE: "Custom Local Network ; 2026",
        SOROBAN_HTLC_TESTNET: "CBZX_CUSTOM_HTLC",
        SOLANA_RPC_URL: "https://solana.custom.example",
        SOLANA_HTLC_PROGRAM_TESTNET: "CustomSolanaProgram111111111111111111111111111",
        RELAYER_FEE_RATE: "75",
      });

      expect(config.ethereum.chainId).toBe(424242);
      expect(config.ethereum.rpcUrl).toBe("https://rpc.custom.example");
      expect(config.ethereum.explorerUrl).toBe("https://explorer.custom.example");
      expect(config.ethereum.htlcEscrow).toBe("0x1111111111111111111111111111111111111111");
      expect(config.ethereum.escrowFactory).toBe("0x2222222222222222222222222222222222222222");
      expect(config.ethereum.htlcBridge).toBe("0x3333333333333333333333333333333333333333");
      expect(config.soroban.rpcUrl).toBe("https://soroban.custom.example");
      expect(config.soroban.horizonUrl).toBe("https://horizon.custom.example");
      expect(config.soroban.networkPassphrase).toBe("Custom Local Network ; 2026");
      expect(config.soroban.htlcContract).toBe("CBZX_CUSTOM_HTLC");
      expect(config.solana.rpcUrl).toBe("https://solana.custom.example");
      expect(config.solana.programId).toBe("CustomSolanaProgram111111111111111111111111111");
      expect(config.fees.feeRateBps).toBe(75);
    });

    it("fails fast for malformed custom chain settings", () => {
      expect(() =>
        loadChainSettings("testnet", {
          ETHEREUM_RPC_URL: "not-a-url",
          ETH_ESCROW_FACTORY_TESTNET: "not-an-address",
        })
      ).toThrow();
    });
  });

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

    it("should use custom chain settings for core coordinator fields", () => {
      const env = {
        NETWORK_MODE: "testnet",
        ETHEREUM_RPC_URL: "https://ethereum-custom.example",
        TESTNET_ETHEREUM_CHAIN_ID: "424242",
        SOROBAN_RPC_URL: "https://soroban-custom.example",
        STELLAR_HORIZON_URL: "https://horizon-custom.example",
        STELLAR_NETWORK_PASSPHRASE: "Custom Coordinator Network ; 2026",
        SOLANA_RPC_URL: "https://solana-custom.example",
      };

      const config = loadCoordinatorConfig(env);
      expect(config.ethereum.chainId).toBe(424242);
      expect(config.soroban.networkPassphrase).toBe("Custom Coordinator Network ; 2026");
      expect(config.soroban.rpcUrl).toBe("https://soroban-custom.example");
      expect(config.solana.rpcUrl).toBe("https://solana-custom.example");
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
