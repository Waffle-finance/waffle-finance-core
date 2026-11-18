/**
 * Asset resolution fallback regression tests.
 *
 * Audits the boundary between "lenient resolver" and "strict assertion guard"
 * behaviour across every resolution direction:
 *
 *   eth → stellar   (resolveStellarAsset / assertSupportedEthToStellar)
 *   stellar → eth   (resolveEthereumToken / assertSupportedStellarToEth)
 *   eth → solana    (resolveSolanaAsset / assertSupportedEthToSolana)
 *   solana → eth    (resolveEthereumTokenFromSolana / assertSupportedSolanaToEth)
 *   stellar → solana (resolveSolanaAssetFromStellar / assertSupportedStellarToSolana)
 *   solana → stellar (resolveStellarAssetFromSolana / assertSupportedSolanaToStellar)
 *
 * Public contract:
 *   • Lenient resolvers (resolve*) always return a value — they fall back to the
 *     chain-native asset for any unknown input. An unknown token must never be
 *     silently misrepresented as the CORRECT mapped asset; it always becomes the
 *     native fallback.
 *   • Strict guards (assert*) throw UnsupportedAssetError for every unknown input.
 *   • The two APIs are consistent: if the guard passes, the resolver returns the
 *     non-fallback mapping. If the guard throws, the resolver returns the native
 *     fallback.
 *
 * Acceptance criteria satisfied:
 *   ✓ Each API's unknown-asset behaviour is deterministic and documented
 *   ✓ A token cannot be misrepresented as native without an explicit fallback contract
 *   ✓ Existing supported asset lookups remain unchanged
 */

import { describe, it, expect } from "vitest";
import {
  // Lenient resolvers
  resolveStellarAsset,
  resolveEthereumToken,
  resolveSolanaAsset,
  resolveEthereumTokenFromSolana,
  resolveSolanaAssetFromStellar,
  resolveStellarAssetFromSolana,
  // Strict assertion guards
  assertSupportedEthToStellar,
  assertSupportedStellarToEth,
  assertSupportedEthToSolana,
  assertSupportedSolanaToEth,
  assertSupportedStellarToSolana,
  assertSupportedSolanaToStellar,
  // Boolean guards
  isSupportedEthToStellar,
  isSupportedStellarToEth,
  isSupportedEthToSolana,
  isSupportedSolanaToEth,
  isSupportedStellarToSolana,
  isSupportedSolanaToStellar,
  // Error types
  UnsupportedAssetError,
  // Native asset constants
  NATIVE_ETH_ADDRESS,
  NATIVE_STELLAR_ASSET,
  NATIVE_SOL_MINT,
  NATIVE_SOL_ASSET,
} from "../src/assets/index.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const SEPOLIA_USDC    = "0xa0b86a33e6417c4fd30ad9d05d6b9b7cd6dd11b";
const STELLAR_ISSUER  = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const STELLAR_USDC_KEY = `USDC:${STELLAR_ISSUER}`;
const DEVNET_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

// Unknown inputs — these must never produce a "known" mapped asset.
const UNKNOWN_ETH_ADDRESS  = "0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead";
const UNKNOWN_ETH_ADDRESS2 = "0x1111111111111111111111111111111111111111";
const UNKNOWN_STELLAR_CODE = "FAKE:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const UNKNOWN_STELLAR_ISSUER_ONLY = "FOO";  // no issuer — not a CODE:ISSUER key
const UNKNOWN_SOLANA_MINT  = "UnknownMintXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
const UNKNOWN_SOLANA_MINT2 = "AaAbBbCcDdEeFfGgHhIiJjKkLlMmNnOoPpQqRrSsTtUu";

// ── eth → stellar ─────────────────────────────────────────────────────────────

describe("eth→stellar: lenient resolver fallback contract", () => {
  it("returns native XLM for an unknown Ethereum address on testnet", () => {
    const result = resolveStellarAsset(UNKNOWN_ETH_ADDRESS, "testnet");
    expect(result).toEqual(NATIVE_STELLAR_ASSET);
  });

  it("returns native XLM for a second unknown address — not the first known mapped asset", () => {
    const result = resolveStellarAsset(UNKNOWN_ETH_ADDRESS2, "testnet");
    expect(result).toEqual(NATIVE_STELLAR_ASSET);
  });

  it("returns native XLM for an unknown address on mainnet", () => {
    const result = resolveStellarAsset(UNKNOWN_ETH_ADDRESS, "mainnet");
    expect(result).toEqual(NATIVE_STELLAR_ASSET);
  });

  it("fallback is always the SAME native constant (object equality)", () => {
    const a = resolveStellarAsset(UNKNOWN_ETH_ADDRESS, "testnet");
    const b = resolveStellarAsset(UNKNOWN_ETH_ADDRESS2, "testnet");
    expect(a).toEqual(b);
    expect(a.code).toBe("XLM");
    expect(a.issuer).toBeUndefined();
  });

  it("unknown addresses do NOT resolve to the same object as a known ERC-20 mapping", () => {
    const known   = resolveStellarAsset(SEPOLIA_USDC, "testnet");
    const unknown = resolveStellarAsset(UNKNOWN_ETH_ADDRESS, "testnet");
    expect(known).not.toEqual(unknown);
    expect(known.code).toBe("USDC");
    expect(unknown.code).toBe("XLM");
  });

  // Supported assets unchanged
  it("native ETH still maps to native XLM", () => {
    expect(resolveStellarAsset(NATIVE_ETH_ADDRESS, "testnet")).toEqual(NATIVE_STELLAR_ASSET);
  });

  it("Sepolia USDC still maps to Stellar USDC on testnet", () => {
    const result = resolveStellarAsset(SEPOLIA_USDC, "testnet");
    expect(result.code).toBe("USDC");
    expect(result.issuer).toBe(STELLAR_ISSUER);
  });
});

describe("eth→stellar: strict guard rejects unknown inputs", () => {
  it("throws UnsupportedAssetError for an unknown Ethereum address", () => {
    expect(() => assertSupportedEthToStellar(UNKNOWN_ETH_ADDRESS, "testnet"))
      .toThrow(UnsupportedAssetError);
  });

  it("error names the asset, network, and direction", () => {
    try {
      assertSupportedEthToStellar(UNKNOWN_ETH_ADDRESS, "testnet");
    } catch (err) {
      const e = err as UnsupportedAssetError;
      expect(e.asset).toBe(UNKNOWN_ETH_ADDRESS);
      expect(e.network).toBe("testnet");
      expect(e.direction).toBe("eth→stellar");
    }
  });

  it("isSupportedEthToStellar is false exactly when the assert guard would throw", () => {
    expect(isSupportedEthToStellar(UNKNOWN_ETH_ADDRESS, "testnet")).toBe(false);
    expect(isSupportedEthToStellar(NATIVE_ETH_ADDRESS, "testnet")).toBe(true);
  });

  it("guard and lenient resolver agree: guard-false → resolver returns native fallback", () => {
    const supported = isSupportedEthToStellar(UNKNOWN_ETH_ADDRESS, "testnet");
    const resolved  = resolveStellarAsset(UNKNOWN_ETH_ADDRESS, "testnet");
    expect(supported).toBe(false);
    expect(resolved).toEqual(NATIVE_STELLAR_ASSET);
  });

  it("guard and lenient resolver agree: guard-true → resolver returns non-native mapping", () => {
    const supported = isSupportedEthToStellar(SEPOLIA_USDC, "testnet");
    const resolved  = resolveStellarAsset(SEPOLIA_USDC, "testnet");
    expect(supported).toBe(true);
    expect(resolved).not.toEqual(NATIVE_STELLAR_ASSET);
  });
});

// ── stellar → eth ─────────────────────────────────────────────────────────────

describe("stellar→eth: lenient resolver fallback contract", () => {
  it("returns native ETH for an unknown Stellar code+issuer combo", () => {
    expect(resolveEthereumToken(UNKNOWN_STELLAR_CODE, "testnet")).toBe(NATIVE_ETH_ADDRESS);
  });

  it("returns native ETH for a bare unrecognised code with no issuer", () => {
    expect(resolveEthereumToken(UNKNOWN_STELLAR_ISSUER_ONLY, "testnet")).toBe(NATIVE_ETH_ADDRESS);
  });

  it("returns native ETH for a well-formed but unmapped CODE:ISSUER string", () => {
    // A perfectly valid Stellar key format but not in the mapping table.
    const unmapped = "WAFL:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
    expect(resolveEthereumToken(unmapped, "testnet")).toBe(NATIVE_ETH_ADDRESS);
  });

  it("unknown Stellar asset → native ETH, not a random ERC-20 address", () => {
    const result = resolveEthereumToken(UNKNOWN_STELLAR_CODE, "testnet");
    expect(result).toBe(NATIVE_ETH_ADDRESS);
    expect(result).not.toBe(SEPOLIA_USDC);
  });

  // Supported assets unchanged
  it("native XLM still maps to native ETH", () => {
    expect(resolveEthereumToken("XLM", "testnet")).toBe(NATIVE_ETH_ADDRESS);
  });

  it("Stellar USDC still maps to Sepolia USDC on testnet", () => {
    expect(resolveEthereumToken(STELLAR_USDC_KEY, "testnet")).toBe(SEPOLIA_USDC);
  });
});

describe("stellar→eth: strict guard rejects unknown inputs", () => {
  it("throws UnsupportedAssetError for an unknown Stellar asset", () => {
    expect(() => assertSupportedStellarToEth(UNKNOWN_STELLAR_CODE, "testnet"))
      .toThrow(UnsupportedAssetError);
  });

  it("isSupportedStellarToEth is false for an unknown asset", () => {
    expect(isSupportedStellarToEth(UNKNOWN_STELLAR_CODE, "testnet")).toBe(false);
  });

  it("guard-false → resolver returns native fallback (consistency)", () => {
    const supported = isSupportedStellarToEth(UNKNOWN_STELLAR_CODE, "testnet");
    const resolved  = resolveEthereumToken(UNKNOWN_STELLAR_CODE, "testnet");
    expect(supported).toBe(false);
    expect(resolved).toBe(NATIVE_ETH_ADDRESS);
  });
});

// ── eth → solana ──────────────────────────────────────────────────────────────

describe("eth→solana: lenient resolver fallback contract", () => {
  it("returns native SOL asset for an unknown Ethereum address on testnet", () => {
    expect(resolveSolanaAsset(UNKNOWN_ETH_ADDRESS, "testnet")).toEqual(NATIVE_SOL_ASSET);
  });

  it("returns native SOL asset on mainnet for any unknown address", () => {
    expect(resolveSolanaAsset(UNKNOWN_ETH_ADDRESS, "mainnet")).toEqual(NATIVE_SOL_ASSET);
  });

  it("unknown ETH address → native SOL, not the devnet USDC mint", () => {
    const result = resolveSolanaAsset(UNKNOWN_ETH_ADDRESS, "testnet");
    expect(result.mint).toBe(NATIVE_SOL_MINT);
    expect(result.mint).not.toBe(DEVNET_USDC_MINT);
    expect(result.symbol).toBe("SOL");
  });

  it("multiple unknown addresses all collapse to the same native SOL fallback", () => {
    const a = resolveSolanaAsset(UNKNOWN_ETH_ADDRESS,  "testnet");
    const b = resolveSolanaAsset(UNKNOWN_ETH_ADDRESS2, "testnet");
    expect(a).toEqual(b);
  });

  // Supported assets unchanged
  it("native ETH still maps to native SOL asset", () => {
    expect(resolveSolanaAsset(NATIVE_ETH_ADDRESS, "testnet")).toEqual(NATIVE_SOL_ASSET);
  });

  it("Sepolia USDC still maps to devnet USDC mint on testnet", () => {
    const result = resolveSolanaAsset(SEPOLIA_USDC, "testnet");
    expect(result.mint).toBe(DEVNET_USDC_MINT);
    expect(result.symbol).toBe("USDC");
  });
});

describe("eth→solana: strict guard rejects unknown inputs", () => {
  it("throws UnsupportedAssetError for an unknown Ethereum address", () => {
    expect(() => assertSupportedEthToSolana(UNKNOWN_ETH_ADDRESS, "testnet"))
      .toThrow(UnsupportedAssetError);
  });

  it("error carries direction eth→solana", () => {
    try {
      assertSupportedEthToSolana(UNKNOWN_ETH_ADDRESS, "testnet");
    } catch (err) {
      expect((err as UnsupportedAssetError).direction).toBe("eth→solana");
    }
  });

  it("isSupportedEthToSolana false → resolver returns native SOL fallback", () => {
    const supported = isSupportedEthToSolana(UNKNOWN_ETH_ADDRESS, "testnet");
    const resolved  = resolveSolanaAsset(UNKNOWN_ETH_ADDRESS, "testnet");
    expect(supported).toBe(false);
    expect(resolved).toEqual(NATIVE_SOL_ASSET);
  });
});

// ── solana → eth ──────────────────────────────────────────────────────────────

describe("solana→eth: lenient resolver fallback contract", () => {
  it("returns native ETH for an unknown Solana mint on testnet", () => {
    expect(resolveEthereumTokenFromSolana(UNKNOWN_SOLANA_MINT, "testnet")).toBe(NATIVE_ETH_ADDRESS);
  });

  it("returns native ETH for a second unknown mint — not a random ERC-20", () => {
    expect(resolveEthereumTokenFromSolana(UNKNOWN_SOLANA_MINT2, "testnet")).toBe(NATIVE_ETH_ADDRESS);
  });

  it("unknown Solana mint → native ETH, not Sepolia USDC", () => {
    const result = resolveEthereumTokenFromSolana(UNKNOWN_SOLANA_MINT, "testnet");
    expect(result).toBe(NATIVE_ETH_ADDRESS);
    expect(result).not.toBe(SEPOLIA_USDC);
  });

  // Supported assets unchanged
  it("native SOL mint still maps to native ETH", () => {
    expect(resolveEthereumTokenFromSolana(NATIVE_SOL_MINT, "testnet")).toBe(NATIVE_ETH_ADDRESS);
  });

  it("devnet USDC mint still maps to Sepolia USDC on testnet", () => {
    expect(resolveEthereumTokenFromSolana(DEVNET_USDC_MINT, "testnet")).toBe(SEPOLIA_USDC);
  });
});

describe("solana→eth: strict guard rejects unknown inputs", () => {
  it("throws UnsupportedAssetError for an unknown Solana mint", () => {
    expect(() => assertSupportedSolanaToEth(UNKNOWN_SOLANA_MINT, "testnet"))
      .toThrow(UnsupportedAssetError);
  });

  it("isSupportedSolanaToEth false → resolver returns native ETH fallback", () => {
    const supported = isSupportedSolanaToEth(UNKNOWN_SOLANA_MINT, "testnet");
    const resolved  = resolveEthereumTokenFromSolana(UNKNOWN_SOLANA_MINT, "testnet");
    expect(supported).toBe(false);
    expect(resolved).toBe(NATIVE_ETH_ADDRESS);
  });
});

// ── stellar → solana ──────────────────────────────────────────────────────────

describe("stellar→solana: lenient resolver fallback contract", () => {
  it("returns native SOL asset for an unknown Stellar asset", () => {
    expect(resolveSolanaAssetFromStellar(UNKNOWN_STELLAR_CODE, "testnet")).toEqual(NATIVE_SOL_ASSET);
  });

  it("unknown Stellar asset → native SOL, not the devnet USDC mint", () => {
    const result = resolveSolanaAssetFromStellar(UNKNOWN_STELLAR_CODE, "testnet");
    expect(result.mint).toBe(NATIVE_SOL_MINT);
    expect(result.mint).not.toBe(DEVNET_USDC_MINT);
  });

  it("a well-formed but unmapped CODE:ISSUER string → native SOL fallback", () => {
    const unmapped = "WAFL:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
    expect(resolveSolanaAssetFromStellar(unmapped, "testnet")).toEqual(NATIVE_SOL_ASSET);
  });

  // Supported assets unchanged
  it("native XLM still maps to native SOL asset", () => {
    expect(resolveSolanaAssetFromStellar("XLM", "testnet")).toEqual(NATIVE_SOL_ASSET);
  });

  it("Stellar USDC still maps to devnet USDC mint on testnet", () => {
    const result = resolveSolanaAssetFromStellar(STELLAR_USDC_KEY, "testnet");
    expect(result.mint).toBe(DEVNET_USDC_MINT);
  });
});

describe("stellar→solana: strict guard rejects unknown inputs", () => {
  it("throws UnsupportedAssetError for an unknown Stellar asset", () => {
    expect(() => assertSupportedStellarToSolana(UNKNOWN_STELLAR_CODE, "testnet"))
      .toThrow(UnsupportedAssetError);
  });

  it("isSupportedStellarToSolana false → resolver returns native SOL fallback", () => {
    const supported = isSupportedStellarToSolana(UNKNOWN_STELLAR_CODE, "testnet");
    const resolved  = resolveSolanaAssetFromStellar(UNKNOWN_STELLAR_CODE, "testnet");
    expect(supported).toBe(false);
    expect(resolved).toEqual(NATIVE_SOL_ASSET);
  });
});

// ── solana → stellar ──────────────────────────────────────────────────────────

describe("solana→stellar: lenient resolver fallback contract", () => {
  it("returns native XLM for an unknown Solana mint", () => {
    expect(resolveStellarAssetFromSolana(UNKNOWN_SOLANA_MINT, "testnet")).toEqual(NATIVE_STELLAR_ASSET);
  });

  it("unknown Solana mint → native XLM, not Stellar USDC", () => {
    const result = resolveStellarAssetFromSolana(UNKNOWN_SOLANA_MINT, "testnet");
    expect(result.code).toBe("XLM");
    expect(result.issuer).toBeUndefined();
  });

  it("multiple unknown mints all collapse to native XLM", () => {
    const a = resolveStellarAssetFromSolana(UNKNOWN_SOLANA_MINT,  "testnet");
    const b = resolveStellarAssetFromSolana(UNKNOWN_SOLANA_MINT2, "testnet");
    expect(a).toEqual(b);
    expect(a).toEqual(NATIVE_STELLAR_ASSET);
  });

  // Supported assets unchanged
  it("native SOL mint still maps to native XLM", () => {
    expect(resolveStellarAssetFromSolana(NATIVE_SOL_MINT, "testnet")).toEqual(NATIVE_STELLAR_ASSET);
  });

  it("devnet USDC mint still maps to Stellar USDC on testnet", () => {
    const result = resolveStellarAssetFromSolana(DEVNET_USDC_MINT, "testnet");
    expect(result.code).toBe("USDC");
    expect(result.issuer).toBe(STELLAR_ISSUER);
  });
});

describe("solana→stellar: strict guard rejects unknown inputs", () => {
  it("throws UnsupportedAssetError for an unknown Solana mint", () => {
    expect(() => assertSupportedSolanaToStellar(UNKNOWN_SOLANA_MINT, "testnet"))
      .toThrow(UnsupportedAssetError);
  });

  it("isSupportedSolanaToStellar false → resolver returns native XLM fallback", () => {
    const supported = isSupportedSolanaToStellar(UNKNOWN_SOLANA_MINT, "testnet");
    const resolved  = resolveStellarAssetFromSolana(UNKNOWN_SOLANA_MINT, "testnet");
    expect(supported).toBe(false);
    expect(resolved).toEqual(NATIVE_STELLAR_ASSET);
  });
});

// ── Cross-direction consistency ───────────────────────────────────────────────

describe("guard / resolver consistency across all directions", () => {
  /**
   * For every direction, the boolean guard and the lenient resolver must agree:
   *  - guard true  → resolver returns a non-native mapping
   *  - guard false → resolver returns the native fallback
   *
   * This prevents a silent mismatch where the guard says "unsupported" but
   * the resolver still happens to return a real token.
   */
  const NATIVE_FALLBACKS = {
    ethToStellar:   NATIVE_STELLAR_ASSET,
    stellarToEth:   NATIVE_ETH_ADDRESS,
    ethToSolana:    NATIVE_SOL_ASSET,
    solanaToEth:    NATIVE_ETH_ADDRESS,
    stellarToSolana: NATIVE_SOL_ASSET,
    solanaToStellar: NATIVE_STELLAR_ASSET,
  };

  it("eth→stellar: guard false implies resolver returns exactly NATIVE_STELLAR_ASSET", () => {
    expect(isSupportedEthToStellar(UNKNOWN_ETH_ADDRESS, "testnet")).toBe(false);
    expect(resolveStellarAsset(UNKNOWN_ETH_ADDRESS, "testnet"))
      .toEqual(NATIVE_FALLBACKS.ethToStellar);
  });

  it("stellar→eth: guard false implies resolver returns exactly NATIVE_ETH_ADDRESS", () => {
    expect(isSupportedStellarToEth(UNKNOWN_STELLAR_CODE, "testnet")).toBe(false);
    expect(resolveEthereumToken(UNKNOWN_STELLAR_CODE, "testnet"))
      .toBe(NATIVE_FALLBACKS.stellarToEth);
  });

  it("eth→solana: guard false implies resolver returns exactly NATIVE_SOL_ASSET", () => {
    expect(isSupportedEthToSolana(UNKNOWN_ETH_ADDRESS, "testnet")).toBe(false);
    expect(resolveSolanaAsset(UNKNOWN_ETH_ADDRESS, "testnet"))
      .toEqual(NATIVE_FALLBACKS.ethToSolana);
  });

  it("solana→eth: guard false implies resolver returns exactly NATIVE_ETH_ADDRESS", () => {
    expect(isSupportedSolanaToEth(UNKNOWN_SOLANA_MINT, "testnet")).toBe(false);
    expect(resolveEthereumTokenFromSolana(UNKNOWN_SOLANA_MINT, "testnet"))
      .toBe(NATIVE_FALLBACKS.solanaToEth);
  });

  it("stellar→solana: guard false implies resolver returns exactly NATIVE_SOL_ASSET", () => {
    expect(isSupportedStellarToSolana(UNKNOWN_STELLAR_CODE, "testnet")).toBe(false);
    expect(resolveSolanaAssetFromStellar(UNKNOWN_STELLAR_CODE, "testnet"))
      .toEqual(NATIVE_FALLBACKS.stellarToSolana);
  });

  it("solana→stellar: guard false implies resolver returns exactly NATIVE_STELLAR_ASSET", () => {
    expect(isSupportedSolanaToStellar(UNKNOWN_SOLANA_MINT, "testnet")).toBe(false);
    expect(resolveStellarAssetFromSolana(UNKNOWN_SOLANA_MINT, "testnet"))
      .toEqual(NATIVE_FALLBACKS.solanaToStellar);
  });
});

// ── UnsupportedAssetError shape ───────────────────────────────────────────────

describe("UnsupportedAssetError — shape and fields", () => {
  it("name is UnsupportedAssetError", () => {
    try {
      assertSupportedEthToStellar(UNKNOWN_ETH_ADDRESS, "testnet");
    } catch (err) {
      expect((err as UnsupportedAssetError).name).toBe("UnsupportedAssetError");
    }
  });

  it("is instanceof Error", () => {
    try {
      assertSupportedEthToSolana(UNKNOWN_ETH_ADDRESS, "testnet");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(UnsupportedAssetError);
    }
  });

  it("message contains the asset identifier", () => {
    try {
      assertSupportedSolanaToEth(UNKNOWN_SOLANA_MINT, "testnet");
    } catch (err) {
      expect((err as UnsupportedAssetError).message).toContain(UNKNOWN_SOLANA_MINT);
    }
  });

  it("message contains the network", () => {
    try {
      assertSupportedSolanaToEth(UNKNOWN_SOLANA_MINT, "mainnet");
    } catch (err) {
      expect((err as UnsupportedAssetError).message).toContain("mainnet");
    }
  });

  it("does not expose any private data in the error message", () => {
    // The asset identifier in the test is a public mint address — not a key,
    // secret, or anything private. Verify the message contains ONLY the
    // normalised asset string and the network.
    try {
      assertSupportedSolanaToEth(UNKNOWN_SOLANA_MINT, "testnet");
    } catch (err) {
      const msg = (err as UnsupportedAssetError).message;
      // Must not contain any RPC URL, private key pattern, or credential-like strings.
      expect(msg).not.toMatch(/\b(key|secret|password|token|auth|bearer|private)\b/i);
    }
  });
});

// ── mainnet vs testnet network isolation ─────────────────────────────────────

describe("network isolation: testnet mappings do not leak into mainnet", () => {
  it("devnet USDC mint is not supported on mainnet (solana→eth)", () => {
    expect(isSupportedSolanaToEth(DEVNET_USDC_MINT, "mainnet")).toBe(false);
    expect(resolveEthereumTokenFromSolana(DEVNET_USDC_MINT, "mainnet")).toBe(NATIVE_ETH_ADDRESS);
  });

  it("Sepolia USDC is not supported on mainnet (eth→stellar)", () => {
    expect(isSupportedEthToStellar(SEPOLIA_USDC, "mainnet")).toBe(false);
    expect(resolveStellarAsset(SEPOLIA_USDC, "mainnet")).toEqual(NATIVE_STELLAR_ASSET);
  });

  it("Sepolia USDC is not supported on mainnet (eth→solana)", () => {
    expect(isSupportedEthToSolana(SEPOLIA_USDC, "mainnet")).toBe(false);
    expect(resolveSolanaAsset(SEPOLIA_USDC, "mainnet")).toEqual(NATIVE_SOL_ASSET);
  });

  it("Stellar USDC is not supported on mainnet (stellar→eth)", () => {
    expect(isSupportedStellarToEth(STELLAR_USDC_KEY, "mainnet")).toBe(false);
    expect(resolveEthereumToken(STELLAR_USDC_KEY, "mainnet")).toBe(NATIVE_ETH_ADDRESS);
  });

  it("devnet USDC is not supported on mainnet (stellar→solana)", () => {
    expect(isSupportedStellarToSolana(STELLAR_USDC_KEY, "mainnet")).toBe(false);
    expect(resolveSolanaAssetFromStellar(STELLAR_USDC_KEY, "mainnet")).toEqual(NATIVE_SOL_ASSET);
  });

  it("devnet USDC mint is not supported on mainnet (solana→stellar)", () => {
    expect(isSupportedSolanaToStellar(DEVNET_USDC_MINT, "mainnet")).toBe(false);
    expect(resolveStellarAssetFromSolana(DEVNET_USDC_MINT, "mainnet")).toEqual(NATIVE_STELLAR_ASSET);
  });
});
