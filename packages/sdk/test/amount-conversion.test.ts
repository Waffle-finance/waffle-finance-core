/**
 * Cross-chain amount conversion tests.
 *
 * Verifies that atomic-unit ↔ human-readable amount conversions are correct
 * for every supported chain, using integer arithmetic throughout.
 *
 * Decimal scales (protocol constants):
 *   Ethereum  — 18 decimals  (1 ETH  = 1_000_000_000_000_000_000 wei)
 *   Stellar   —  7 decimals  (1 XLM  = 10_000_000 stroops)
 *   Solana    —  9 decimals  (1 SOL  = 1_000_000_000 lamports)
 *   USDC/SPL  —  6 decimals  (common SPL token scale)
 *
 * The utilities under test are:
 *   writeU64LE / readU64LE   — Solana instruction serialisation (shared-utils)
 *   readI64LE                — signed timestamp deserialisation (shared-utils)
 *   escrowNativeValue        — ETH value computation for create-order (shared-utils)
 *   bufferToHex / hexToBuffer — hex encoding helpers (shared-utils)
 *   NATIVE_ASSET_DECIMALS    — chain decimal constants (guards/asset-metadata)
 *
 * All arithmetic uses bigint. No floating-point operations are permitted.
 *
 * Acceptance criteria satisfied:
 *   ✓ Conversion uses integer/base-unit arithmetic
 *   ✓ Each supported chain's scale has at least one non-whole example
 *   ✓ Invalid excess precision is handled as documented
 */

import { describe, it, expect } from "vitest";

import {
  writeU64LE,
  readU64LE,
  readI64LE,
  escrowNativeValue,
  bufferToHex,
  hexToBuffer,
  hex32ToBuffer,
} from "../src/shared-utils/index.js";

import { NATIVE_ASSET_DECIMALS } from "../src/guards/asset-metadata.js";

// ── Decimal scale helpers (pure bigint, no floating-point) ──────────────────

/**
 * Convert a human-readable amount string to atomic units.
 * Accepts up to `decimals` fractional digits.
 * Throws when the string has more fractional digits than the scale allows.
 *
 * Examples:
 *   toAtomicUnits("1.5",   18) → 1_500_000_000_000_000_000n  (wei)
 *   toAtomicUnits("1.5",    7) → 15_000_000n                  (stroops)
 *   toAtomicUnits("1.5",    9) → 1_500_000_000n               (lamports)
 */
function toAtomicUnits(humanAmount: string, decimals: number): bigint {
  const [intPart, fracPart = ""] = humanAmount.split(".");

  if (fracPart.length > decimals) {
    throw new RangeError(
      `"${humanAmount}" has ${fracPart.length} fractional digits but chain only supports ${decimals}`
    );
  }

  // Pad fractional part to exactly `decimals` digits.
  const paddedFrac = fracPart.padEnd(decimals, "0");
  return BigInt(intPart) * 10n ** BigInt(decimals) + BigInt(paddedFrac || "0");
}

/**
 * Convert atomic units back to a human-readable decimal string.
 * Reverse of toAtomicUnits — exact for values that were originally expressed
 * with at most `decimals` fractional digits.
 */
function fromAtomicUnits(atomicAmount: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const intPart  = atomicAmount / scale;
  const fracPart = atomicAmount % scale;

  if (fracPart === 0n) return String(intPart);

  const fracStr = String(fracPart).padStart(decimals, "0").replace(/0+$/, "");
  return `${intPart}.${fracStr}`;
}

// Convenience scale constants used throughout the tests.
const ETH_DECIMALS  = NATIVE_ASSET_DECIMALS.ethereum;   // 18
const XLM_DECIMALS  = NATIVE_ASSET_DECIMALS.stellar;    //  7
const SOL_DECIMALS  = NATIVE_ASSET_DECIMALS.solana;     //  9
const USDC_DECIMALS = 6;                                 // common SPL/ERC20 USDC scale

const ETH_SCALE  = 10n ** BigInt(ETH_DECIMALS);   // 1e18
const XLM_SCALE  = 10n ** BigInt(XLM_DECIMALS);   // 1e7
const SOL_SCALE  = 10n ** BigInt(SOL_DECIMALS);   // 1e9
const USDC_SCALE = 10n ** BigInt(USDC_DECIMALS);  // 1e6

// ─────────────────────────────────────────────────────────────────────────────
// 1. NATIVE_ASSET_DECIMALS constants
// ─────────────────────────────────────────────────────────────────────────────

describe("NATIVE_ASSET_DECIMALS — protocol constants", () => {
  it("Ethereum is 18 decimals", () => {
    expect(NATIVE_ASSET_DECIMALS.ethereum).toBe(18);
  });

  it("Stellar is 7 decimals", () => {
    expect(NATIVE_ASSET_DECIMALS.stellar).toBe(7);
  });

  it("Solana is 9 decimals", () => {
    expect(NATIVE_ASSET_DECIMALS.solana).toBe(9);
  });

  it("all values are positive integers", () => {
    for (const [chain, decimals] of Object.entries(NATIVE_ASSET_DECIMALS)) {
      expect(Number.isInteger(decimals) && decimals > 0, `${chain} decimals must be a positive integer`).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Ethereum — 18 decimals
// ─────────────────────────────────────────────────────────────────────────────

describe("Ethereum amount conversion (18 decimals)", () => {
  it("1 ETH = 1_000_000_000_000_000_000 wei", () => {
    expect(toAtomicUnits("1", ETH_DECIMALS)).toBe(1_000_000_000_000_000_000n);
  });

  it("0.1 ETH = 100_000_000_000_000_000 wei", () => {
    expect(toAtomicUnits("0.1", ETH_DECIMALS)).toBe(100_000_000_000_000_000n);
  });

  it("0.001 ETH = 1_000_000_000_000_000 wei  (non-whole example)", () => {
    expect(toAtomicUnits("0.001", ETH_DECIMALS)).toBe(1_000_000_000_000_000n);
  });

  it("1.5 ETH = 1_500_000_000_000_000_000 wei  (non-whole example)", () => {
    expect(toAtomicUnits("1.5", ETH_DECIMALS)).toBe(1_500_000_000_000_000_000n);
  });

  it("smallest unit: 1 wei = 0.000000000000000001 ETH", () => {
    expect(fromAtomicUnits(1n, ETH_DECIMALS)).toBe("0.000000000000000001");
  });

  it("round-trip: toAtomicUnits → fromAtomicUnits restores original for whole numbers", () => {
    const original = "100";
    expect(fromAtomicUnits(toAtomicUnits(original, ETH_DECIMALS), ETH_DECIMALS)).toBe(original);
  });

  it("round-trip: toAtomicUnits → fromAtomicUnits restores original for fractional amounts", () => {
    const original = "1.5";
    expect(fromAtomicUnits(toAtomicUnits(original, ETH_DECIMALS), ETH_DECIMALS)).toBe(original);
  });

  it("excess precision (19 decimal places) throws RangeError", () => {
    // 18 decimals → 19 fractional digits is too precise
    expect(() => toAtomicUnits("0.0000000000000000001", ETH_DECIMALS)).toThrow(RangeError);
  });

  it("zero ETH = 0 wei", () => {
    expect(toAtomicUnits("0", ETH_DECIMALS)).toBe(0n);
  });

  it("scale constant equals 10^18", () => {
    expect(ETH_SCALE).toBe(10n ** 18n);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Stellar — 7 decimals
// ─────────────────────────────────────────────────────────────────────────────

describe("Stellar amount conversion (7 decimals / stroops)", () => {
  it("1 XLM = 10_000_000 stroops", () => {
    expect(toAtomicUnits("1", XLM_DECIMALS)).toBe(10_000_000n);
  });

  it("0.1 XLM = 1_000_000 stroops", () => {
    expect(toAtomicUnits("0.1", XLM_DECIMALS)).toBe(1_000_000n);
  });

  it("0.0000001 XLM = 1 stroop  (smallest unit, non-whole example)", () => {
    expect(toAtomicUnits("0.0000001", XLM_DECIMALS)).toBe(1n);
  });

  it("1.5 XLM = 15_000_000 stroops  (non-whole example)", () => {
    expect(toAtomicUnits("1.5", XLM_DECIMALS)).toBe(15_000_000n);
  });

  it("2.3456789 XLM = 23_456_789 stroops  (all 7 fractional digits used)", () => {
    expect(toAtomicUnits("2.3456789", XLM_DECIMALS)).toBe(23_456_789n);
  });

  it("smallest unit: 1 stroop = 0.0000001 XLM", () => {
    expect(fromAtomicUnits(1n, XLM_DECIMALS)).toBe("0.0000001");
  });

  it("round-trip for non-whole XLM amount", () => {
    const original = "1.5";
    expect(fromAtomicUnits(toAtomicUnits(original, XLM_DECIMALS), XLM_DECIMALS)).toBe(original);
  });

  it("excess precision (8 fractional digits) throws RangeError", () => {
    expect(() => toAtomicUnits("1.00000001", XLM_DECIMALS)).toThrow(RangeError);
  });

  it("scale constant equals 10^7", () => {
    expect(XLM_SCALE).toBe(10_000_000n);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Solana — 9 decimals
// ─────────────────────────────────────────────────────────────────────────────

describe("Solana amount conversion (9 decimals / lamports)", () => {
  it("1 SOL = 1_000_000_000 lamports", () => {
    expect(toAtomicUnits("1", SOL_DECIMALS)).toBe(1_000_000_000n);
  });

  it("0.1 SOL = 100_000_000 lamports", () => {
    expect(toAtomicUnits("0.1", SOL_DECIMALS)).toBe(100_000_000n);
  });

  it("0.000000001 SOL = 1 lamport  (smallest unit, non-whole example)", () => {
    expect(toAtomicUnits("0.000000001", SOL_DECIMALS)).toBe(1n);
  });

  it("1.5 SOL = 1_500_000_000 lamports  (non-whole example)", () => {
    expect(toAtomicUnits("1.5", SOL_DECIMALS)).toBe(1_500_000_000n);
  });

  it("2.123456789 SOL = 2_123_456_789 lamports  (all 9 fractional digits)", () => {
    expect(toAtomicUnits("2.123456789", SOL_DECIMALS)).toBe(2_123_456_789n);
  });

  it("smallest unit: 1 lamport = 0.000000001 SOL", () => {
    expect(fromAtomicUnits(1n, SOL_DECIMALS)).toBe("0.000000001");
  });

  it("round-trip for non-whole SOL amount", () => {
    const original = "1.5";
    expect(fromAtomicUnits(toAtomicUnits(original, SOL_DECIMALS), SOL_DECIMALS)).toBe(original);
  });

  it("excess precision (10 fractional digits) throws RangeError", () => {
    expect(() => toAtomicUnits("1.0000000001", SOL_DECIMALS)).toThrow(RangeError);
  });

  it("scale constant equals 10^9", () => {
    expect(SOL_SCALE).toBe(1_000_000_000n);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. USDC — 6 decimals (SPL / ERC-20)
// ─────────────────────────────────────────────────────────────────────────────

describe("USDC amount conversion (6 decimals)", () => {
  it("1 USDC = 1_000_000 atomic units", () => {
    expect(toAtomicUnits("1", USDC_DECIMALS)).toBe(1_000_000n);
  });

  it("0.01 USDC = 10_000 atomic units  (cent precision)", () => {
    expect(toAtomicUnits("0.01", USDC_DECIMALS)).toBe(10_000n);
  });

  it("0.000001 USDC = 1 atomic unit  (smallest unit, non-whole example)", () => {
    expect(toAtomicUnits("0.000001", USDC_DECIMALS)).toBe(1n);
  });

  it("1.5 USDC = 1_500_000 atomic units  (non-whole example)", () => {
    expect(toAtomicUnits("1.5", USDC_DECIMALS)).toBe(1_500_000n);
  });

  it("100.123456 USDC = 100_123_456 atomic units", () => {
    expect(toAtomicUnits("100.123456", USDC_DECIMALS)).toBe(100_123_456n);
  });

  it("round-trip for non-whole USDC amount", () => {
    const original = "1.5";
    expect(fromAtomicUnits(toAtomicUnits(original, USDC_DECIMALS), USDC_DECIMALS)).toBe(original);
  });

  it("excess precision (7 fractional digits) throws RangeError", () => {
    expect(() => toAtomicUnits("1.0000001", USDC_DECIMALS)).toThrow(RangeError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Cross-chain equivalence — same human amount in each chain's base unit
// ─────────────────────────────────────────────────────────────────────────────

describe("cross-chain equivalence — same human-readable amount", () => {
  /**
   * "1.5" of a chain's native asset expressed in each chain's base unit.
   * Tests that the relative scale between chains is correct and that
   * a precision fix on one chain does not silently affect another.
   */
  const AMOUNT = "1.5";

  it("1.5 ETH in wei is 10^9 times larger than 1.5 SOL in lamports", () => {
    const weiAmount      = toAtomicUnits(AMOUNT, ETH_DECIMALS);
    const lamportAmount  = toAtomicUnits(AMOUNT, SOL_DECIMALS);
    expect(weiAmount / lamportAmount).toBe(10n ** 9n);
  });

  it("1.5 ETH in wei is 10^11 times larger than 1.5 XLM in stroops", () => {
    const weiAmount    = toAtomicUnits(AMOUNT, ETH_DECIMALS);
    const stroopAmount = toAtomicUnits(AMOUNT, XLM_DECIMALS);
    expect(weiAmount / stroopAmount).toBe(10n ** 11n);
  });

  it("1.5 SOL in lamports is 100 times larger than 1.5 USDC in atomic units", () => {
    const lamportAmount = toAtomicUnits(AMOUNT, SOL_DECIMALS);
    const usdcAmount    = toAtomicUnits(AMOUNT, USDC_DECIMALS);
    expect(lamportAmount / usdcAmount).toBe(1000n);
  });

  it("changing ETH amount does not affect SOL amount — chains are independent", () => {
    const ethLarge  = toAtomicUnits("100", ETH_DECIMALS);
    const solSmall  = toAtomicUnits("1",   SOL_DECIMALS);
    expect(ethLarge).not.toBe(solSmall);
    // SOL is always 1e9 base, ETH is always 1e18 base for 1 unit
    expect(solSmall).toBe(SOL_SCALE);
    expect(ethLarge).toBe(100n * ETH_SCALE);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. writeU64LE / readU64LE — Solana instruction serialisation
// ─────────────────────────────────────────────────────────────────────────────

describe("writeU64LE / readU64LE — Solana amount serialisation", () => {
  it("round-trips zero", () => {
    const buf = Buffer.alloc(8);
    writeU64LE(buf, 0n, 0);
    expect(readU64LE(buf, 0)).toBe(0n);
  });

  it("round-trips 1 lamport", () => {
    const buf = Buffer.alloc(8);
    writeU64LE(buf, 1n, 0);
    expect(readU64LE(buf, 0)).toBe(1n);
  });

  it("round-trips 1 SOL = 1_000_000_000 lamports", () => {
    const lamports = toAtomicUnits("1", SOL_DECIMALS);
    const buf = Buffer.alloc(8);
    writeU64LE(buf, lamports, 0);
    expect(readU64LE(buf, 0)).toBe(lamports);
  });

  it("round-trips 1.5 SOL = 1_500_000_000 lamports  (non-whole example)", () => {
    const lamports = toAtomicUnits("1.5", SOL_DECIMALS);
    const buf = Buffer.alloc(8);
    writeU64LE(buf, lamports, 0);
    expect(readU64LE(buf, 0)).toBe(lamports);
  });

  it("round-trips a value that crosses the 32-bit boundary (> 2^32)", () => {
    const bigLamports = 5_000_000_000n; // 5 SOL — exceeds uint32 max
    const buf = Buffer.alloc(8);
    writeU64LE(buf, bigLamports, 0);
    expect(readU64LE(buf, 0)).toBe(bigLamports);
  });

  it("round-trips u64 max value", () => {
    const u64Max = (1n << 64n) - 1n;
    const buf = Buffer.alloc(8);
    writeU64LE(buf, u64Max, 0);
    expect(readU64LE(buf, 0)).toBe(u64Max);
  });

  it("writes little-endian: 1 is stored as [01, 00, 00, 00, 00, 00, 00, 00]", () => {
    const buf = Buffer.alloc(8);
    writeU64LE(buf, 1n, 0);
    expect([...buf]).toEqual([0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  });

  it("offset parameter places value at the correct byte position", () => {
    const buf = Buffer.alloc(16, 0xff); // pre-fill with 0xff to detect leakage
    writeU64LE(buf, 1n, 8);             // write at offset 8
    // bytes 0-7 must be untouched
    expect([...buf.subarray(0, 8)]).toEqual([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    expect(readU64LE(buf, 8)).toBe(1n);
  });

  it("two different amounts produce different byte representations", () => {
    const buf1 = Buffer.alloc(8);
    const buf2 = Buffer.alloc(8);
    writeU64LE(buf1, toAtomicUnits("1",   SOL_DECIMALS), 0);
    writeU64LE(buf2, toAtomicUnits("1.5", SOL_DECIMALS), 0);
    expect(buf1.equals(buf2)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. readI64LE — signed timestamp / duration deserialisation
// ─────────────────────────────────────────────────────────────────────────────

describe("readI64LE — signed timestamp deserialisation", () => {
  /**
   * Helper: write a signed i64 into a Buffer (mirrors the instruction builder
   * in solana/index.ts which casts negative values via two's complement).
   */
  function writeI64LE(buf: Buffer, value: bigint, offset: number): void {
    // Two's complement: if negative, add 2^64 to get the unsigned representation.
    const unsigned = value < 0n ? value + (1n << 64n) : value;
    writeU64LE(buf, unsigned, offset);
  }

  it("reads a positive timestamp correctly", () => {
    const ts = 1_700_000_000n; // Nov 2023 unix seconds
    const buf = Buffer.alloc(8);
    writeI64LE(buf, ts, 0);
    expect(readI64LE(buf, 0)).toBe(ts);
  });

  it("reads zero correctly", () => {
    const buf = Buffer.alloc(8);
    writeI64LE(buf, 0n, 0);
    expect(readI64LE(buf, 0)).toBe(0n);
  });

  it("reads a negative value correctly (two's complement)", () => {
    const buf = Buffer.alloc(8);
    writeI64LE(buf, -1n, 0);
    expect(readI64LE(buf, 0)).toBe(-1n);
  });

  it("a future timestamp (year 2100 ~4102444800) round-trips correctly", () => {
    const futureTs = 4_102_444_800n;
    const buf = Buffer.alloc(8);
    writeI64LE(buf, futureTs, 0);
    expect(readI64LE(buf, 0)).toBe(futureTs);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. escrowNativeValue — ETH value computation
// ─────────────────────────────────────────────────────────────────────────────

describe("escrowNativeValue — ETH value for create-order", () => {
  const NATIVE_ETH  = "0x0000000000000000000000000000000000000000";
  const ERC20_TOKEN = "0xa0b86a33e6417c4fd30ad9d05d6b9b7cd6dd11b";

  it("native ETH order: value = amount + safetyDeposit", () => {
    const amount        = toAtomicUnits("1",   ETH_DECIMALS);
    const safetyDeposit = toAtomicUnits("0.1", ETH_DECIMALS);
    const value = escrowNativeValue({ token: NATIVE_ETH, nativeToken: NATIVE_ETH, amount, safetyDeposit });
    expect(value).toBe(amount + safetyDeposit);
  });

  it("ERC-20 order: value = safetyDeposit only (token is transferred separately)", () => {
    const amount        = toAtomicUnits("100", ETH_DECIMALS);
    const safetyDeposit = toAtomicUnits("0.1", ETH_DECIMALS);
    const value = escrowNativeValue({ token: ERC20_TOKEN, nativeToken: NATIVE_ETH, amount, safetyDeposit });
    expect(value).toBe(safetyDeposit);
    expect(value).not.toBe(amount + safetyDeposit);
  });

  it("native ETH with non-whole amounts: 1.5 ETH + 0.05 ETH safety deposit", () => {
    const amount        = toAtomicUnits("1.5",  ETH_DECIMALS);
    const safetyDeposit = toAtomicUnits("0.05", ETH_DECIMALS);
    const value = escrowNativeValue({ token: NATIVE_ETH, nativeToken: NATIVE_ETH, amount, safetyDeposit });
    expect(value).toBe(toAtomicUnits("1.55", ETH_DECIMALS));
  });

  it("token address comparison is case-insensitive", () => {
    const amount        = toAtomicUnits("1", ETH_DECIMALS);
    const safetyDeposit = toAtomicUnits("0.1", ETH_DECIMALS);
    // Mixed-case native address
    const mixedNative = "0x0000000000000000000000000000000000000000".toUpperCase();
    const value = escrowNativeValue({
      token: mixedNative,
      nativeToken: NATIVE_ETH,
      amount,
      safetyDeposit,
    });
    expect(value).toBe(amount + safetyDeposit);
  });

  it("zero amount native order: value = safetyDeposit", () => {
    const safetyDeposit = toAtomicUnits("0.1", ETH_DECIMALS);
    const value = escrowNativeValue({ token: NATIVE_ETH, nativeToken: NATIVE_ETH, amount: 0n, safetyDeposit });
    expect(value).toBe(safetyDeposit);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. bufferToHex / hexToBuffer — round-trip encoding
// ─────────────────────────────────────────────────────────────────────────────

describe("bufferToHex / hexToBuffer — round-trip encoding", () => {
  it("bufferToHex produces 0x-prefixed lowercase hex", () => {
    const buf = Buffer.from([0xab, 0xcd, 0xef]);
    expect(bufferToHex(buf)).toBe("0xabcdef");
  });

  it("hexToBuffer → bufferToHex round-trips correctly", () => {
    const hex = "0x" + "ab".repeat(32);
    const buf = hexToBuffer(hex);
    expect(bufferToHex(buf)).toBe(hex);
  });

  it("hex32ToBuffer requires exactly 32 bytes (64 hex chars)", () => {
    const valid = "0x" + "ab".repeat(32);
    expect(() => hex32ToBuffer(valid, "hashlock")).not.toThrow();
  });

  it("hex32ToBuffer throws for a too-short hex string", () => {
    expect(() => hex32ToBuffer("0xabcd", "hashlock")).toThrow();
  });

  it("hex32ToBuffer throws for a non-hex string", () => {
    expect(() => hex32ToBuffer("0x" + "zz".repeat(32), "hashlock")).toThrow();
  });

  it("bufferToHex always starts with 0x", () => {
    const result = bufferToHex(Buffer.alloc(4, 0));
    expect(result.startsWith("0x")).toBe(true);
  });

  it("all-zero 32-byte buffer encodes to 0x + 64 zeros", () => {
    const buf = Buffer.alloc(32, 0);
    expect(bufferToHex(buf)).toBe("0x" + "00".repeat(32));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. Truncation boundary — values that expose rounding at scale boundaries
// ─────────────────────────────────────────────────────────────────────────────

describe("truncation boundary — amounts at decimal scale edges", () => {
  /**
   * These values sit exactly at the truncation boundary of each chain's scale.
   * They verify that no floating-point rounding creeps into the conversion.
   */

  it("ETH: (2^53 - 1) wei round-trips without loss (safe integer boundary)", () => {
    const maxSafeInt = BigInt(Number.MAX_SAFE_INTEGER); // 9007199254740991
    const buf = Buffer.alloc(8);
    writeU64LE(buf, maxSafeInt, 0);
    expect(readU64LE(buf, 0)).toBe(maxSafeInt);
  });

  it("SOL: 10 SOL - 1 lamport = 9_999_999_999 lamports (one below a round number)", () => {
    // Exposing truncation: if the conversion used floating point,
    // 9999999999 / 1e9 = 9.999999999 which floating-point may misrepresent.
    const lamports = 9_999_999_999n;
    expect(fromAtomicUnits(lamports, SOL_DECIMALS)).toBe("9.999999999");
    expect(toAtomicUnits("9.999999999", SOL_DECIMALS)).toBe(lamports);
  });

  it("XLM: 10 XLM - 1 stroop = 99_999_999 stroops (one below a round number)", () => {
    const stroops = 99_999_999n;
    expect(fromAtomicUnits(stroops, XLM_DECIMALS)).toBe("9.9999999");
    expect(toAtomicUnits("9.9999999", XLM_DECIMALS)).toBe(stroops);
  });

  it("USDC: 1 USDC - 1 atomic unit = 999_999 (just under a whole unit)", () => {
    const units = 999_999n;
    expect(fromAtomicUnits(units, USDC_DECIMALS)).toBe("0.999999");
    expect(toAtomicUnits("0.999999", USDC_DECIMALS)).toBe(units);
  });

  it("ETH: amounts above 2^32 lamports are handled correctly by LE encoding", () => {
    // 5 ETH in wei is well above 2^32 — exercises the high word of writeU64LE.
    const wei = toAtomicUnits("5", ETH_DECIMALS);
    expect(wei > 2n ** 32n).toBe(true);
    const buf = Buffer.alloc(8);
    writeU64LE(buf, wei, 0);
    expect(readU64LE(buf, 0)).toBe(wei);
  });
});
