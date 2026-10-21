import { describe, expect, it } from "vitest";
import { Networks } from "@stellar/stellar-sdk";
import {
  SdkConfigurationError,
  validateChainId,
  validateChainPair,
  validateEthereumAddress,
  validateNetworkPassphrase,
  validateRpcUrl,
  validateSolanaAddress,
  validateSorobanAddress,
} from "../src/config-validation.js";
import { EthereumHTLCClient } from "../src/ethereum/index.js";
import { SolanaHTLCClient } from "../src/solana/index.js";
import { SorobanHTLCClient } from "../src/soroban/index.js";

const ETH = "0x0000000000000000000000000000000000000000";
const SOLANA_PROGRAM = "11111111111111111111111111111111";
const SOROBAN_CONTRACT = "CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR5PNUCGLIMAO4K";

describe("SDK runtime configuration validation", () => {
  it("requires absolute https RPC URLs by default", () => {
    expect(validateRpcUrl("https://rpc.example", "rpcUrl")).toBe("https://rpc.example");
    expect(() => validateRpcUrl("", "rpcUrl")).toThrow(SdkConfigurationError);
    expect(() => validateRpcUrl("http://rpc.example", "rpcUrl")).toThrow(SdkConfigurationError);
    expect(validateRpcUrl("http://localhost:8899", "rpcUrl", { allowHttp: true }))
      .toBe("http://localhost:8899");
  });

  it("validates required chain IDs", () => {
    expect(validateChainId("11155111")).toBe(11155111);
    expect(() => validateChainId(0)).toThrow(SdkConfigurationError);
    expect(() => validateChainId(Number.MAX_SAFE_INTEGER + 1)).toThrow(SdkConfigurationError);
  });

  it("canonicalizes and rejects chain-local addresses", () => {
    expect(validateEthereumAddress("0x1111111111111111111111111111111111111111"))
      .toBe("0x1111111111111111111111111111111111111111");
    expect(validateSolanaAddress(SOLANA_PROGRAM)).toBe(SOLANA_PROGRAM);
    expect(validateSorobanAddress(SOROBAN_CONTRACT)).toBe(SOROBAN_CONTRACT);

    expect(() => validateEthereumAddress("0x123")).toThrow(SdkConfigurationError);
    expect(() => validateSolanaAddress("not-base58")).toThrow(SdkConfigurationError);
    expect(() => validateSorobanAddress("CCONTRACT")).toThrow(SdkConfigurationError);
  });

  it("rejects unknown Stellar network passphrases", () => {
    expect(validateNetworkPassphrase(Networks.TESTNET)).toBe(Networks.TESTNET);
    expect(() => validateNetworkPassphrase("Waffle Local Network ; 2026"))
      .toThrow(SdkConfigurationError);
  });

  it("validates source and destination pairs through the route matrix", () => {
    expect(validateChainPair({ src: "ethereum", dst: "stellar", network: "testnet" }).direction)
      .toBe("eth_to_xlm");
    expect(() => validateChainPair({ src: "ethereum", dst: "ethereum", network: "testnet" }))
      .toThrow(SdkConfigurationError);
    expect(() => validateChainPair({ src: "stellar", dst: "solana", network: "testnet" }))
      .toThrow(/route_not_live/);
    expect(() => validateChainPair({
      src: "ethereum",
      dst: "stellar",
      network: "mainnet",
      tokenGroup: "usdc",
    })).toThrow(/route_not_on_network/);
  });
});

describe("SDK client constructors fail fast", () => {
  it("rejects invalid Ethereum escrow addresses and chain mismatches", () => {
    const publicClient = { chain: { id: 11155111 } } as any;
    expect(() => new EthereumHTLCClient({ address: ETH, chainId: 1, publicClient }))
      .toThrow(/chainId expected 1/);
    expect(() => new EthereumHTLCClient({ address: "0x123" as any, publicClient }))
      .toThrow(SdkConfigurationError);
  });

  it("rejects missing Solana RPC and malformed production program IDs", () => {
    expect(() => new SolanaHTLCClient({ rpcUrl: "", programId: SOLANA_PROGRAM }))
      .toThrow(SdkConfigurationError);
    expect(() => new SolanaHTLCClient({ rpcUrl: "https://api.devnet.solana.com", programId: "" }))
      .toThrow(SdkConfigurationError);
    expect(() => new SolanaHTLCClient({ rpcUrl: "https://api.devnet.solana.com", programId: "PLACEHOLDER" }))
      .not.toThrow();
  });

  it("rejects malformed Soroban RPC, network, and contract configuration", () => {
    expect(() => new SorobanHTLCClient({
      rpcUrl: "http://soroban.example",
      networkPassphrase: Networks.TESTNET,
      contractId: SOROBAN_CONTRACT,
    })).toThrow(SdkConfigurationError);
    expect(() => new SorobanHTLCClient({
      rpcUrl: "https://soroban.example",
      networkPassphrase: "wrong",
      contractId: SOROBAN_CONTRACT,
    })).toThrow(SdkConfigurationError);
    expect(() => new SorobanHTLCClient({
      rpcUrl: "https://soroban.example",
      networkPassphrase: Networks.TESTNET,
      contractId: "CCONTRACT",
    })).toThrow(SdkConfigurationError);
  });
});

describe("table-driven required-field validation (#896)", () => {
  const cases: Array<{
    name: string;
    run: () => unknown;
    expectedField: string;
  }> = [
    { name: "missing rpcUrl", run: () => validateRpcUrl(undefined, "rpcUrl"), expectedField: "rpcUrl" },
    { name: "malformed rpcUrl", run: () => validateRpcUrl("not-a-url", "rpcUrl"), expectedField: "rpcUrl" },
    { name: "missing chainId", run: () => validateChainId(undefined, "chainId"), expectedField: "chainId" },
    { name: "malformed chainId", run: () => validateChainId("abc", "chainId"), expectedField: "chainId" },
    { name: "missing ethereum address", run: () => validateEthereumAddress(undefined, "address"), expectedField: "address" },
    { name: "malformed ethereum address", run: () => validateEthereumAddress("not-hex", "address"), expectedField: "address" },
    { name: "missing solana address", run: () => validateSolanaAddress(undefined, "address"), expectedField: "address" },
    { name: "missing soroban address", run: () => validateSorobanAddress(undefined, "address"), expectedField: "address" },
    { name: "missing network passphrase", run: () => validateNetworkPassphrase(undefined, "networkPassphrase"), expectedField: "networkPassphrase" },
  ];

  it.each(cases)("$name produces a typed error naming the field", ({ run, expectedField }) => {
    try {
      run();
      throw new Error("expected validation to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SdkConfigurationError);
      const issues = (err as SdkConfigurationError).issues;
      expect(issues.some((i) => i.field === expectedField)).toBe(true);
    }
  });

  it("rejects a cross-network mismatch (route valid for testnet, not for mainnet+tokenGroup)", () => {
    expect(() =>
      validateChainPair({ src: "ethereum", dst: "stellar", network: "mainnet", tokenGroup: "usdc" }),
    ).toThrow(SdkConfigurationError);
  });

  it("accepts one valid config per supported chain", () => {
    expect(validateRpcUrl("https://eth.example", "rpcUrl")).toBe("https://eth.example");
    expect(validateEthereumAddress("0x1111111111111111111111111111111111111111", "address"))
      .toBe("0x1111111111111111111111111111111111111111");

    expect(validateRpcUrl("https://api.devnet.solana.com", "rpcUrl")).toBe("https://api.devnet.solana.com");
    expect(validateSolanaAddress(SOLANA_PROGRAM, "address")).toBe(SOLANA_PROGRAM);

    expect(validateRpcUrl("https://soroban.example", "rpcUrl")).toBe("https://soroban.example");
    expect(validateSorobanAddress(SOROBAN_CONTRACT, "address")).toBe(SOROBAN_CONTRACT);
    expect(validateNetworkPassphrase(Networks.TESTNET, "networkPassphrase")).toBe(Networks.TESTNET);
  });
});
