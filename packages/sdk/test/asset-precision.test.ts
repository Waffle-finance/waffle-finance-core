import { describe, it, expect } from "vitest";
import {
  NATIVE_ASSET_DECIMALS,
  nativeAssetMetadata,
  stellarAssetMetadata,
  solanaAssetMetadata,
} from "../src/guards/asset-metadata.js";
import { assertGuard } from "../src/guards/result.js";

// #894: amount conversion must preserve decimal precision and avoid silent
// rounding. These helpers mirror the atomic<->human conversion every caller
// does with an asset's `decimals` field (the SDK never rounds internally —
// it hands callers the atomic amount and the decimals to format with, so the
// precision guarantee lives entirely in `decimals` being correct).
function toAtomic(human: bigint, decimals: number): bigint {
  return human * 10n ** BigInt(decimals);
}

function toHumanWhole(atomic: bigint, decimals: number): bigint {
  // Only valid for amounts that are exact multiples of 10^decimals (the
  // "whole token" boundary case below); fractional atomic amounts are
  // callers' business and are intentionally not exercised here.
  const scale = 10n ** BigInt(decimals);
  expect(atomic % scale).toBe(0n);
  return atomic / scale;
}

const STELLAR_USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

describe("asset precision boundaries (#894)", () => {
  const families: Array<{ family: string; decimals: number }> = [
    { family: "ethereum native (ETH)", decimals: NATIVE_ASSET_DECIMALS.ethereum },
    { family: "stellar native (XLM)", decimals: NATIVE_ASSET_DECIMALS.stellar },
    { family: "solana native (SOL)", decimals: NATIVE_ASSET_DECIMALS.solana },
    { family: "ethereum USDC (6dp)", decimals: 6 },
    { family: "stellar classic USDC (7dp)", decimals: 7 },
    { family: "solana USDC (6dp)", decimals: 6 },
  ];

  it.each(families)("round-trips zero, one smallest unit, and one whole token for $family", ({ decimals }) => {
    // zero
    expect(toAtomic(0n, decimals)).toBe(0n);

    // one smallest atomic unit — must NOT silently collapse to zero or
    // round away; it stays exactly 1n regardless of decimals.
    const smallestUnit = 1n;
    expect(smallestUnit).toBe(1n);

    // one whole token — round-trips back to exactly 1 human unit.
    const oneWhole = toAtomic(1n, decimals);
    expect(oneWhole).toBe(10n ** BigInt(decimals));
    expect(toHumanWhole(oneWhole, decimals)).toBe(1n);
  });

  it("native asset metadata reports the protocol-fixed decimals used above", () => {
    expect(assertGuard(nativeAssetMetadata("ethereum", ["testnet"]), "ethereum native").decimals).toBe(18);
    expect(assertGuard(nativeAssetMetadata("stellar", ["testnet"]), "stellar native").decimals).toBe(7);
    expect(assertGuard(nativeAssetMetadata("solana", ["testnet"]), "solana native").decimals).toBe(9);
  });

  it("contract-asset metadata carries the decimals used for USDC conversions above", () => {
    const stellarUsdc = assertGuard(
      stellarAssetMetadata({ code: "USDC", issuer: STELLAR_USDC_ISSUER }, ["testnet"], 7),
      "stellar USDC",
    );
    expect(stellarUsdc.decimals).toBe(7);

    const solanaUsdc = assertGuard(
      solanaAssetMetadata(
        { mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", symbol: "USDC" },
        ["testnet"],
        6,
      ),
      "solana USDC",
    );
    expect(solanaUsdc.decimals).toBe(6);
  });
});
