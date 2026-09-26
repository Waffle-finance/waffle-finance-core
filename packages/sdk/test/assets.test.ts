import { describe, it, expect } from "vitest";
import {
  resolveStellarAsset,
  resolveEthereumToken,
  resolveSolanaAsset,
  resolveEthereumTokenFromSolana,
  normalizeEthereumAddress,
  normalizeStellarAssetKey,
  normalizeSolanaMint,
  isSupportedEthToStellar,
  isSupportedStellarToEth,
  isSupportedEthToSolana,
  isSupportedSolanaToEth,
  isSupportedStellarToSolana,
  isSupportedSolanaToStellar,
  assertSupportedEthToStellar,
  assertSupportedStellarToEth,
  assertSupportedEthToSolana,
  assertSupportedSolanaToEth,
  assertSupportedStellarToSolana,
  assertSupportedSolanaToStellar,
  resolveSolanaAssetFromStellar,
  resolveStellarAssetFromSolana,
  getSupportedEthereumAddresses,
  getSupportedStellarAssets,
  getSupportedSolanaMints,
  getSupportedStellarToSolana,
  getSupportedSolanaToStellar,
  toCanonicalId,
  UnsupportedAssetError,
  NATIVE_ETH_ADDRESS,
  NATIVE_STELLAR_ASSET,
  NATIVE_SOL_MINT,
  NATIVE_SOL_ASSET,
} from "../src/assets/index.js";

// ── Shared fixtures ───────────────────────────────────────────────────────

const SEPOLIA_USDC = "0xa0b86a33e6417c4fd30ad9d05d6b9b7cd6dd11b";
const STELLAR_USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const SEPOLIA_USDC_STELLAR = { code: "USDC", issuer: STELLAR_USDC_ISSUER };
const STELLAR_USDC_KEY = `USDC:${STELLAR_USDC_ISSUER}`;
const DEVNET_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const UNKNOWN_ETH = "0x1111111111111111111111111111111111111111";
const UNKNOWN_MINT = "UnknownMintAddressXXXXXXXXXXXXXXXXXXXXXXXXX";

// ── resolveStellarAsset (original behaviour preserved) ────────────────────

describe("resolveStellarAsset", () => {
  it("maps native ETH to native XLM on testnet", () => {
    expect(resolveStellarAsset(NATIVE_ETH_ADDRESS, "testnet")).toEqual(NATIVE_STELLAR_ASSET);
  });

  it("maps a known ERC-20 token to Stellar USDC on testnet", () => {
    expect(resolveStellarAsset(SEPOLIA_USDC, "testnet")).toEqual(SEPOLIA_USDC_STELLAR);
  });

  it("falls back to native XLM for an unknown Ethereum token address on testnet", () => {
    expect(resolveStellarAsset(UNKNOWN_ETH, "testnet")).toEqual(NATIVE_STELLAR_ASSET);
  });

  it("accepts mixed-case Ethereum addresses (case-insensitive lookup)", () => {
    const mixed = "0xA0B86A33E6417C4FD30AD9D05D6B9B7CD6DD11B";
    expect(resolveStellarAsset(mixed, "testnet")).toEqual(SEPOLIA_USDC_STELLAR);
  });

  it("accepts addresses with surrounding whitespace", () => {
    expect(resolveStellarAsset(`  ${SEPOLIA_USDC}  `, "testnet")).toEqual(SEPOLIA_USDC_STELLAR);
  });

  it("USDC mapping is absent on mainnet (native ETH still maps to XLM)", () => {
    expect(resolveStellarAsset(SEPOLIA_USDC, "mainnet")).toEqual(NATIVE_STELLAR_ASSET);
    expect(resolveStellarAsset(NATIVE_ETH_ADDRESS, "mainnet")).toEqual(NATIVE_STELLAR_ASSET);
  });
});

// ── resolveEthereumToken (original behaviour preserved) ───────────────────

describe("resolveEthereumToken", () => {
  it("resolves a known Stellar USDC asset object back to the ERC-20 address", () => {
    expect(resolveEthereumToken(SEPOLIA_USDC_STELLAR, "testnet")).toBe(SEPOLIA_USDC);
  });

  it("resolves a Stellar asset by string key", () => {
    expect(resolveEthereumToken(STELLAR_USDC_KEY, "testnet")).toBe(SEPOLIA_USDC);
  });

  it("resolves native XLM string to native ETH", () => {
    expect(resolveEthereumToken("XLM", "testnet")).toBe(NATIVE_ETH_ADDRESS);
  });

  it("falls back to native ETH for an unknown Stellar asset on testnet", () => {
    expect(resolveEthereumToken("UNKNOWN_ASSET", "testnet")).toBe(NATIVE_ETH_ADDRESS);
  });

  it("USDC key maps to native ETH on mainnet (not mapped there)", () => {
    expect(resolveEthereumToken(STELLAR_USDC_KEY, "mainnet")).toBe(NATIVE_ETH_ADDRESS);
  });

  it("trims whitespace from string-form Stellar asset keys", () => {
    expect(resolveEthereumToken("  XLM  ", "testnet")).toBe(NATIVE_ETH_ADDRESS);
  });
});

// ── resolveSolanaAsset ────────────────────────────────────────────────────

describe("resolveSolanaAsset", () => {
  it("maps native ETH to native SOL on testnet", () => {
    expect(resolveSolanaAsset(NATIVE_ETH_ADDRESS, "testnet")).toEqual(NATIVE_SOL_ASSET);
  });

  it("maps native ETH to native SOL on mainnet", () => {
    expect(resolveSolanaAsset(NATIVE_ETH_ADDRESS, "mainnet")).toEqual(NATIVE_SOL_ASSET);
  });

  it("maps Sepolia USDC to devnet USDC mint on testnet", () => {
    expect(resolveSolanaAsset(SEPOLIA_USDC, "testnet")).toEqual({
      mint: DEVNET_USDC_MINT,
      symbol: "USDC",
    });
  });

  it("USDC mapping is absent on mainnet — falls back to native SOL", () => {
    expect(resolveSolanaAsset(SEPOLIA_USDC, "mainnet")).toEqual(NATIVE_SOL_ASSET);
  });

  it("falls back to native SOL for an unknown Ethereum address", () => {
    expect(resolveSolanaAsset(UNKNOWN_ETH, "testnet")).toEqual(NATIVE_SOL_ASSET);
  });

  it("accepts mixed-case Ethereum addresses (case-insensitive lookup)", () => {
    const mixed = "0xA0B86A33E6417C4FD30AD9D05D6B9B7CD6DD11B";
    expect(resolveSolanaAsset(mixed, "testnet")).toEqual({ mint: DEVNET_USDC_MINT, symbol: "USDC" });
  });

  it("accepts addresses with surrounding whitespace", () => {
    expect(resolveSolanaAsset(`  ${SEPOLIA_USDC}  `, "testnet")).toEqual({
      mint: DEVNET_USDC_MINT,
      symbol: "USDC",
    });
  });
});

// ── resolveEthereumTokenFromSolana ────────────────────────────────────────

describe("resolveEthereumTokenFromSolana", () => {
  it("maps native SOL mint to native ETH on testnet", () => {
    expect(resolveEthereumTokenFromSolana(NATIVE_SOL_MINT, "testnet")).toBe(NATIVE_ETH_ADDRESS);
  });

  it("maps native SOL mint to native ETH on mainnet", () => {
    expect(resolveEthereumTokenFromSolana(NATIVE_SOL_MINT, "mainnet")).toBe(NATIVE_ETH_ADDRESS);
  });

  it("maps devnet USDC mint to Sepolia USDC ERC-20 on testnet", () => {
    expect(resolveEthereumTokenFromSolana(DEVNET_USDC_MINT, "testnet")).toBe(SEPOLIA_USDC);
  });

  it("devnet USDC mint falls back to native ETH on mainnet (not mapped there)", () => {
    expect(resolveEthereumTokenFromSolana(DEVNET_USDC_MINT, "mainnet")).toBe(NATIVE_ETH_ADDRESS);
  });

  it("falls back to native ETH for an unknown Solana mint", () => {
    expect(resolveEthereumTokenFromSolana(UNKNOWN_MINT, "testnet")).toBe(NATIVE_ETH_ADDRESS);
  });

  it("trims surrounding whitespace from the mint address", () => {
    expect(resolveEthereumTokenFromSolana(`  ${NATIVE_SOL_MINT}  `, "testnet")).toBe(NATIVE_ETH_ADDRESS);
  });
});

// ── normalizeEthereumAddress ──────────────────────────────────────────────

describe("normalizeEthereumAddress", () => {
  it("lowercases a mixed-case address", () => {
    expect(normalizeEthereumAddress("0xABCDEF1234567890abcdef1234567890ABCDEF12")).toBe(
      "0xabcdef1234567890abcdef1234567890abcdef12",
    );
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeEthereumAddress("  0xabc  ")).toBe("0xabc");
  });

  it("leaves an already-normalised address unchanged", () => {
    expect(normalizeEthereumAddress(NATIVE_ETH_ADDRESS)).toBe(NATIVE_ETH_ADDRESS);
  });
});

// ── normalizeStellarAssetKey ──────────────────────────────────────────────

describe("normalizeStellarAssetKey", () => {
  it("returns the code directly for native XLM (no issuer)", () => {
    expect(normalizeStellarAssetKey({ code: "XLM" })).toBe("XLM");
  });

  it("returns CODE:ISSUER for an issued Stellar asset", () => {
    expect(normalizeStellarAssetKey(SEPOLIA_USDC_STELLAR)).toBe(STELLAR_USDC_KEY);
  });

  it("trims whitespace from a string-form key", () => {
    expect(normalizeStellarAssetKey("  XLM  ")).toBe("XLM");
  });

  it("passes a pre-formatted CODE:ISSUER string through unchanged (after trim)", () => {
    expect(normalizeStellarAssetKey(STELLAR_USDC_KEY)).toBe(STELLAR_USDC_KEY);
  });
});

// ── normalizeSolanaMint ───────────────────────────────────────────────────

describe("normalizeSolanaMint", () => {
  it("trims leading and trailing whitespace", () => {
    expect(normalizeSolanaMint(`  ${NATIVE_SOL_MINT}  `)).toBe(NATIVE_SOL_MINT);
  });

  it("preserves case (Solana addresses are case-sensitive)", () => {
    const mint = "So11111111111111111111111111111111111111112";
    expect(normalizeSolanaMint(mint)).toBe(mint);
  });

  it("leaves a clean mint address unchanged", () => {
    expect(normalizeSolanaMint(DEVNET_USDC_MINT)).toBe(DEVNET_USDC_MINT);
  });
});

// ── isSupportedEthToStellar ───────────────────────────────────────────────

describe("isSupportedEthToStellar", () => {
  it("returns true for native ETH on testnet", () => {
    expect(isSupportedEthToStellar(NATIVE_ETH_ADDRESS, "testnet")).toBe(true);
  });

  it("returns true for a known ERC-20 token on testnet", () => {
    expect(isSupportedEthToStellar(SEPOLIA_USDC, "testnet")).toBe(true);
  });

  it("returns false for an unknown Ethereum address", () => {
    expect(isSupportedEthToStellar(UNKNOWN_ETH, "testnet")).toBe(false);
  });

  it("returns false for Sepolia USDC on mainnet (only native ETH is mapped there)", () => {
    expect(isSupportedEthToStellar(SEPOLIA_USDC, "mainnet")).toBe(false);
  });

  it("returns true for native ETH on mainnet", () => {
    expect(isSupportedEthToStellar(NATIVE_ETH_ADDRESS, "mainnet")).toBe(true);
  });

  it("accepts mixed-case Ethereum addresses", () => {
    expect(isSupportedEthToStellar(SEPOLIA_USDC.toUpperCase(), "testnet")).toBe(true);
  });
});

// ── isSupportedStellarToEth ───────────────────────────────────────────────

describe("isSupportedStellarToEth", () => {
  it("returns true for native XLM string key on testnet", () => {
    expect(isSupportedStellarToEth("XLM", "testnet")).toBe(true);
  });

  it("returns true for the CanonicalStellarAsset object form of USDC on testnet", () => {
    expect(isSupportedStellarToEth(SEPOLIA_USDC_STELLAR, "testnet")).toBe(true);
  });

  it("returns true for the string key form of USDC on testnet", () => {
    expect(isSupportedStellarToEth(STELLAR_USDC_KEY, "testnet")).toBe(true);
  });

  it("returns false for an unknown Stellar asset", () => {
    expect(isSupportedStellarToEth("FOO:GISSUER", "testnet")).toBe(false);
  });

  it("returns false for Stellar USDC on mainnet", () => {
    expect(isSupportedStellarToEth(SEPOLIA_USDC_STELLAR, "mainnet")).toBe(false);
  });

  it("returns true for XLM on mainnet", () => {
    expect(isSupportedStellarToEth("XLM", "mainnet")).toBe(true);
  });
});

// ── isSupportedEthToSolana ────────────────────────────────────────────────

describe("isSupportedEthToSolana", () => {
  it("returns true for native ETH on testnet", () => {
    expect(isSupportedEthToSolana(NATIVE_ETH_ADDRESS, "testnet")).toBe(true);
  });

  it("returns true for a known ERC-20 token on testnet", () => {
    expect(isSupportedEthToSolana(SEPOLIA_USDC, "testnet")).toBe(true);
  });

  it("returns false for an unknown Ethereum address", () => {
    expect(isSupportedEthToSolana(UNKNOWN_ETH, "testnet")).toBe(false);
  });

  it("returns false for Sepolia USDC on mainnet", () => {
    expect(isSupportedEthToSolana(SEPOLIA_USDC, "mainnet")).toBe(false);
  });

  it("accepts mixed-case Ethereum addresses", () => {
    expect(isSupportedEthToSolana(SEPOLIA_USDC.toUpperCase(), "testnet")).toBe(true);
  });
});

// ── isSupportedSolanaToEth ────────────────────────────────────────────────

describe("isSupportedSolanaToEth", () => {
  it("returns true for native SOL mint on testnet", () => {
    expect(isSupportedSolanaToEth(NATIVE_SOL_MINT, "testnet")).toBe(true);
  });

  it("returns true for native SOL mint on mainnet", () => {
    expect(isSupportedSolanaToEth(NATIVE_SOL_MINT, "mainnet")).toBe(true);
  });

  it("returns true for devnet USDC mint on testnet", () => {
    expect(isSupportedSolanaToEth(DEVNET_USDC_MINT, "testnet")).toBe(true);
  });

  it("returns false for devnet USDC mint on mainnet", () => {
    expect(isSupportedSolanaToEth(DEVNET_USDC_MINT, "mainnet")).toBe(false);
  });

  it("returns false for an unknown mint", () => {
    expect(isSupportedSolanaToEth(UNKNOWN_MINT, "testnet")).toBe(false);
  });

  it("trims whitespace before lookup", () => {
    expect(isSupportedSolanaToEth(`  ${NATIVE_SOL_MINT}  `, "testnet")).toBe(true);
  });
});

// ── assertSupportedEthToStellar ───────────────────────────────────────────

describe("assertSupportedEthToStellar", () => {
  it("does not throw for a supported Ethereum address", () => {
    expect(() => assertSupportedEthToStellar(NATIVE_ETH_ADDRESS, "testnet")).not.toThrow();
    expect(() => assertSupportedEthToStellar(SEPOLIA_USDC, "testnet")).not.toThrow();
  });

  it("throws UnsupportedAssetError for an unknown address", () => {
    expect(() => assertSupportedEthToStellar(UNKNOWN_ETH, "testnet")).toThrow(UnsupportedAssetError);
  });

  it("error message contains the asset, network, and direction", () => {
    try {
      assertSupportedEthToStellar(UNKNOWN_ETH, "testnet");
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedAssetError);
      const e = err as UnsupportedAssetError;
      expect(e.asset).toBe(UNKNOWN_ETH);
      expect(e.network).toBe("testnet");
      expect(e.direction).toBe("eth→stellar");
      expect(e.message).toContain(UNKNOWN_ETH);
      expect(e.message).toContain("testnet");
      expect(e.name).toBe("UnsupportedAssetError");
    }
  });

  it("throws for Sepolia USDC on mainnet", () => {
    expect(() => assertSupportedEthToStellar(SEPOLIA_USDC, "mainnet")).toThrow(UnsupportedAssetError);
  });

  it("normalises the address in the thrown error (lowercase)", () => {
    try {
      assertSupportedEthToStellar(UNKNOWN_ETH.toUpperCase(), "testnet");
    } catch (err) {
      expect((err as UnsupportedAssetError).asset).toBe(UNKNOWN_ETH);
    }
  });
});

// ── assertSupportedStellarToEth ───────────────────────────────────────────

describe("assertSupportedStellarToEth", () => {
  it("does not throw for supported Stellar assets", () => {
    expect(() => assertSupportedStellarToEth("XLM", "testnet")).not.toThrow();
    expect(() => assertSupportedStellarToEth(SEPOLIA_USDC_STELLAR, "testnet")).not.toThrow();
    expect(() => assertSupportedStellarToEth(STELLAR_USDC_KEY, "testnet")).not.toThrow();
  });

  it("throws UnsupportedAssetError for an unknown Stellar asset", () => {
    expect(() => assertSupportedStellarToEth("UNKNOWN:GISSUER", "testnet")).toThrow(UnsupportedAssetError);
  });

  it("error carries the normalised asset key, network, and direction", () => {
    try {
      assertSupportedStellarToEth(SEPOLIA_USDC_STELLAR, "mainnet");
    } catch (err) {
      const e = err as UnsupportedAssetError;
      expect(e.asset).toBe(STELLAR_USDC_KEY);
      expect(e.network).toBe("mainnet");
      expect(e.direction).toBe("stellar→eth");
    }
  });
});

// ── assertSupportedEthToSolana ────────────────────────────────────────────

describe("assertSupportedEthToSolana", () => {
  it("does not throw for supported Ethereum addresses", () => {
    expect(() => assertSupportedEthToSolana(NATIVE_ETH_ADDRESS, "testnet")).not.toThrow();
    expect(() => assertSupportedEthToSolana(SEPOLIA_USDC, "testnet")).not.toThrow();
  });

  it("throws UnsupportedAssetError for an unknown Ethereum address", () => {
    expect(() => assertSupportedEthToSolana(UNKNOWN_ETH, "testnet")).toThrow(UnsupportedAssetError);
  });

  it("throws for Sepolia USDC on mainnet", () => {
    expect(() => assertSupportedEthToSolana(SEPOLIA_USDC, "mainnet")).toThrow(UnsupportedAssetError);
  });

  it("error carries asset, network, and direction", () => {
    try {
      assertSupportedEthToSolana(UNKNOWN_ETH, "testnet");
    } catch (err) {
      const e = err as UnsupportedAssetError;
      expect(e.asset).toBe(UNKNOWN_ETH);
      expect(e.network).toBe("testnet");
      expect(e.direction).toBe("eth→solana");
    }
  });
});

// ── assertSupportedSolanaToEth ────────────────────────────────────────────

describe("assertSupportedSolanaToEth", () => {
  it("does not throw for supported Solana mints", () => {
    expect(() => assertSupportedSolanaToEth(NATIVE_SOL_MINT, "testnet")).not.toThrow();
    expect(() => assertSupportedSolanaToEth(DEVNET_USDC_MINT, "testnet")).not.toThrow();
  });

  it("throws UnsupportedAssetError for an unknown Solana mint", () => {
    expect(() => assertSupportedSolanaToEth(UNKNOWN_MINT, "testnet")).toThrow(UnsupportedAssetError);
  });

  it("throws for devnet USDC mint on mainnet", () => {
    expect(() => assertSupportedSolanaToEth(DEVNET_USDC_MINT, "mainnet")).toThrow(UnsupportedAssetError);
  });

  it("error carries the trimmed mint, network, and direction", () => {
    try {
      assertSupportedSolanaToEth(`  ${UNKNOWN_MINT}  `, "testnet");
    } catch (err) {
      const e = err as UnsupportedAssetError;
      expect(e.asset).toBe(UNKNOWN_MINT);
      expect(e.network).toBe("testnet");
      expect(e.direction).toBe("solana→eth");
    }
  });
});

// ── getSupportedEthereumAddresses ─────────────────────────────────────────

describe("getSupportedEthereumAddresses", () => {
  it("testnet stellar direction contains native ETH and Sepolia USDC", () => {
    const addrs = getSupportedEthereumAddresses("stellar", "testnet");
    expect(addrs).toContain(NATIVE_ETH_ADDRESS);
    expect(addrs).toContain(SEPOLIA_USDC);
  });

  it("mainnet stellar direction contains only native ETH", () => {
    const addrs = getSupportedEthereumAddresses("stellar", "mainnet");
    expect(addrs).toContain(NATIVE_ETH_ADDRESS);
    expect(addrs).not.toContain(SEPOLIA_USDC);
    expect(addrs).toHaveLength(1);
  });

  it("testnet solana direction contains native ETH and Sepolia USDC", () => {
    const addrs = getSupportedEthereumAddresses("solana", "testnet");
    expect(addrs).toContain(NATIVE_ETH_ADDRESS);
    expect(addrs).toContain(SEPOLIA_USDC);
  });

  it("mainnet solana direction contains only native ETH", () => {
    const addrs = getSupportedEthereumAddresses("solana", "mainnet");
    expect(addrs).toContain(NATIVE_ETH_ADDRESS);
    expect(addrs).not.toContain(SEPOLIA_USDC);
    expect(addrs).toHaveLength(1);
  });
});

// ── getSupportedStellarAssets ─────────────────────────────────────────────

describe("getSupportedStellarAssets", () => {
  it("testnet list contains XLM and the USDC key", () => {
    const assets = getSupportedStellarAssets("testnet");
    expect(assets).toContain("XLM");
    expect(assets).toContain(STELLAR_USDC_KEY);
  });

  it("mainnet list contains XLM but not the testnet USDC key", () => {
    const assets = getSupportedStellarAssets("mainnet");
    expect(assets).toContain("XLM");
    expect(assets).not.toContain(STELLAR_USDC_KEY);
    expect(assets).toHaveLength(1);
  });
});

// ── getSupportedSolanaMints ───────────────────────────────────────────────

describe("getSupportedSolanaMints", () => {
  it("testnet list contains native SOL mint and devnet USDC mint", () => {
    const mints = getSupportedSolanaMints("testnet");
    expect(mints).toContain(NATIVE_SOL_MINT);
    expect(mints).toContain(DEVNET_USDC_MINT);
  });

  it("mainnet list contains only native SOL mint", () => {
    const mints = getSupportedSolanaMints("mainnet");
    expect(mints).toContain(NATIVE_SOL_MINT);
    expect(mints).not.toContain(DEVNET_USDC_MINT);
    expect(mints).toHaveLength(1);
  });
});

// ── Round-trip consistency ────────────────────────────────────────────────

describe("round-trip consistency", () => {
  it("eth→stellar→eth round-trips for native ETH on testnet", () => {
    const stellar = resolveStellarAsset(NATIVE_ETH_ADDRESS, "testnet");
    expect(resolveEthereumToken(stellar, "testnet")).toBe(NATIVE_ETH_ADDRESS);
  });

  it("eth→stellar→eth round-trips for Sepolia USDC on testnet", () => {
    const stellar = resolveStellarAsset(SEPOLIA_USDC, "testnet");
    expect(resolveEthereumToken(stellar, "testnet")).toBe(SEPOLIA_USDC);
  });

  it("eth→solana→eth round-trips for native ETH on testnet", () => {
    const sol = resolveSolanaAsset(NATIVE_ETH_ADDRESS, "testnet");
    expect(resolveEthereumTokenFromSolana(sol.mint, "testnet")).toBe(NATIVE_ETH_ADDRESS);
  });

  it("eth→solana→eth round-trips for Sepolia USDC on testnet", () => {
    const sol = resolveSolanaAsset(SEPOLIA_USDC, "testnet");
    expect(resolveEthereumTokenFromSolana(sol.mint, "testnet")).toBe(SEPOLIA_USDC);
  });
});

// ── Stellar ↔ Solana mappings ─────────────────────────────────────────────────

describe("isSupportedStellarToSolana", () => {
  it("returns true for native XLM on testnet", () => {
    expect(isSupportedStellarToSolana("XLM", "testnet")).toBe(true);
  });

  it("returns true for Stellar USDC on testnet", () => {
    expect(isSupportedStellarToSolana(STELLAR_USDC_KEY, "testnet")).toBe(true);
  });

  it("returns false for an unknown Stellar asset", () => {
    expect(isSupportedStellarToSolana("UNKNOWN:GXXX", "testnet")).toBe(false);
  });

  it("accepts CanonicalStellarAsset object", () => {
    expect(isSupportedStellarToSolana({ code: "XLM" }, "testnet")).toBe(true);
  });
});

describe("isSupportedSolanaToStellar", () => {
  it("returns true for native SOL on testnet", () => {
    expect(isSupportedSolanaToStellar(NATIVE_SOL_MINT, "testnet")).toBe(true);
  });

  it("returns true for devnet USDC mint on testnet", () => {
    expect(isSupportedSolanaToStellar(DEVNET_USDC_MINT, "testnet")).toBe(true);
  });

  it("returns false for an unknown mint", () => {
    expect(isSupportedSolanaToStellar("UnknownMint1111111111111111111111111111111", "testnet")).toBe(false);
  });
});

describe("assertSupportedStellarToSolana", () => {
  it("does not throw for a supported asset", () => {
    expect(() => assertSupportedStellarToSolana("XLM", "testnet")).not.toThrow();
  });

  it("throws UnsupportedAssetError for an unsupported asset", () => {
    expect(() => assertSupportedStellarToSolana("UNKN:GXXX", "testnet")).toThrow(UnsupportedAssetError);
  });
});

describe("assertSupportedSolanaToStellar", () => {
  it("does not throw for a supported mint", () => {
    expect(() => assertSupportedSolanaToStellar(NATIVE_SOL_MINT, "testnet")).not.toThrow();
  });

  it("throws UnsupportedAssetError for an unsupported mint", () => {
    expect(() => assertSupportedSolanaToStellar("UnknownMint1111111111111111111111111111111", "testnet")).toThrow(UnsupportedAssetError);
  });
});

describe("resolveSolanaAssetFromStellar", () => {
  it("maps native XLM to native SOL", () => {
    expect(resolveSolanaAssetFromStellar("XLM", "testnet")).toEqual(NATIVE_SOL_ASSET);
  });

  it("maps Stellar USDC to devnet USDC mint", () => {
    const sol = resolveSolanaAssetFromStellar(STELLAR_USDC_KEY, "testnet");
    expect(sol.mint).toBe(DEVNET_USDC_MINT);
    expect(sol.symbol).toBe("USDC");
  });

  it("falls back to native SOL for an unknown asset", () => {
    expect(resolveSolanaAssetFromStellar("UNKN:GXXX", "testnet")).toEqual(NATIVE_SOL_ASSET);
  });
});

describe("resolveStellarAssetFromSolana", () => {
  it("maps native SOL to native XLM", () => {
    expect(resolveStellarAssetFromSolana(NATIVE_SOL_MINT, "testnet")).toEqual(NATIVE_STELLAR_ASSET);
  });

  it("maps devnet USDC mint to Stellar USDC", () => {
    const stellar = resolveStellarAssetFromSolana(DEVNET_USDC_MINT, "testnet");
    expect(stellar.code).toBe("USDC");
    expect(stellar.issuer).toBeTruthy();
  });

  it("falls back to native XLM for an unknown mint", () => {
    expect(resolveStellarAssetFromSolana("UnknownMint1111111111111111111111111111111", "testnet")).toEqual(NATIVE_STELLAR_ASSET);
  });
});

describe("stellar↔solana round-trips", () => {
  it("XLM round-trips through solana and back", () => {
    const sol = resolveSolanaAssetFromStellar("XLM", "testnet");
    const stellar = resolveStellarAssetFromSolana(sol.mint, "testnet");
    expect(stellar).toEqual(NATIVE_STELLAR_ASSET);
  });

  it("USDC round-trips through solana and back", () => {
    const sol = resolveSolanaAssetFromStellar(STELLAR_USDC_KEY, "testnet");
    const stellar = resolveStellarAssetFromSolana(sol.mint, "testnet");
    expect(stellar.code).toBe("USDC");
  });
});

describe("getSupportedStellarToSolana / getSupportedSolanaToStellar", () => {
  it("returns a non-empty list on testnet", () => {
    expect(getSupportedStellarToSolana("testnet").length).toBeGreaterThan(0);
    expect(getSupportedSolanaToStellar("testnet").length).toBeGreaterThan(0);
  });

  it("includes XLM in stellar-to-solana list", () => {
    expect(getSupportedStellarToSolana("testnet")).toContain("XLM");
  });

  it("includes native SOL mint in solana-to-stellar list", () => {
    expect(getSupportedSolanaToStellar("testnet")).toContain(NATIVE_SOL_MINT);
  });
});

// ── toCanonicalId ─────────────────────────────────────────────────────────────

describe("toCanonicalId", () => {
  it("produces chain:native:SYMBOL for assets without an address", () => {
    expect(toCanonicalId("ethereum", "ETH")).toBe("ethereum:native:ETH");
    expect(toCanonicalId("stellar", "XLM")).toBe("stellar:native:XLM");
    expect(toCanonicalId("solana", "SOL")).toBe("solana:native:SOL");
  });

  it("upper-cases the symbol", () => {
    expect(toCanonicalId("ethereum", "eth")).toBe("ethereum:native:ETH");
  });

  it("produces chain:contract:SYMBOL:address for contract assets", () => {
    const id = toCanonicalId("ethereum", "USDC", "0xA0b86a33e6417C4fd30aD9d05D6b9b7CD6Dd11b");
    expect(id).toBe("ethereum:contract:USDC:0xa0b86a33e6417c4fd30ad9d05d6b9b7cd6dd11b");
  });

  it("lower-cases the address in contract canonical ids", () => {
    const id = toCanonicalId("ethereum", "WETH", "0xC02AAA39B223FE8D0A0E5C4F27EAD9083C756CC2");
    expect(id).toBe("ethereum:contract:WETH:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2");
  });

  it("matches the frontend NormalizedAsset.canonicalId format", () => {
    // Native ETH — same as frontend NATIVE_ASSETS.ethereum.canonicalId
    expect(toCanonicalId("ethereum", "ETH")).toBe("ethereum:native:ETH");
    // Native XLM
    expect(toCanonicalId("stellar", "XLM")).toBe("stellar:native:XLM");
    // Native SOL
    expect(toCanonicalId("solana", "SOL")).toBe("solana:native:SOL");
  });

  it("produces distinct ids for the same symbol on different chains", () => {
    const ethUsdc = toCanonicalId("ethereum", "USDC", "0xa0b86a33e6417c4fd30ad9d05d6b9b7cd6dd11b");
    const solUsdc = toCanonicalId("solana", "USDC", "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
    expect(ethUsdc).not.toBe(solUsdc);
  });

  it("unsupported assets that have no mapping fail predictably via assert guards", () => {
    expect(() => assertSupportedStellarToSolana("UNKNOWN:GXXX", "testnet")).toThrow(UnsupportedAssetError);
    expect(() => assertSupportedSolanaToStellar("UnknownMint1111111111111111111111111111111", "testnet")).toThrow(UnsupportedAssetError);
    expect(() => assertSupportedEthToStellar("0x1111111111111111111111111111111111111111", "testnet")).toThrow(UnsupportedAssetError);
    expect(() => assertSupportedEthToSolana("0x1111111111111111111111111111111111111111", "testnet")).toThrow(UnsupportedAssetError);
  });
});
