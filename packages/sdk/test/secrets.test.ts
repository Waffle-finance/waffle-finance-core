import { describe, it, expect } from "vitest";
import { keccak256, sha256 } from "viem";
import { generateSecret, hashSecret, verifyPreimage } from "../src/secrets/index.js";

describe("secrets", () => {
  it("generates a 32-byte secret with both digests", () => {
    const s = generateSecret();
    expect(s.preimage).toMatch(/^0x[0-9a-f]{64}$/);
    expect(s.sha256).toMatch(/^0x[0-9a-f]{64}$/);
    expect(s.keccak256).toMatch(/^0x[0-9a-f]{64}$/);
    expect(s.sha256).not.toBe(s.keccak256);
  });

  it("hashSecret is deterministic", () => {
    const s = generateSecret();
    const s2 = hashSecret(s.preimage);
    expect(s2.sha256).toBe(s.sha256);
    expect(s2.keccak256).toBe(s.keccak256);
  });

  it("normalizes uppercase preimages while preserving cross-chain digest parity", () => {
    const preimage = `0x${"AB".repeat(32)}` as `0x${string}`;
    const normalized = `0x${"ab".repeat(32)}` as `0x${string}`;

    const s = hashSecret(preimage);

    expect(s.preimage).toBe(normalized);
    expect(s.sha256).toBe(sha256(normalized));
    expect(s.keccak256).toBe(keccak256(normalized));
  });

  it("accepts exactly 32-byte Uint8Array preimages", () => {
    const bytes = new Uint8Array(32).fill(0x11);
    const s = hashSecret(bytes);

    expect(s.preimage).toBe(`0x${"11".repeat(32)}`);
    expect(s.sha256).toBe(sha256(s.preimage));
    expect(s.keccak256).toBe(keccak256(s.preimage));
  });

  it("rejects malformed hex preimages", () => {
    const cases = [
      "ab".repeat(32),
      `0X${"ab".repeat(32)}`,
      `0x${"ab".repeat(31)}`,
      `0x${"ab".repeat(33)}`,
      `0x${"ab".repeat(31)}a`,
      `0x${"gg".repeat(32)}`
    ];

    for (const value of cases) {
      expect(() => hashSecret(value as `0x${string}`)).toThrow(/preimage/);
    }
  });

  it("rejects non-32-byte Uint8Array preimages", () => {
    expect(() => hashSecret(new Uint8Array(31))).toThrow(/preimage must be exactly 32 bytes/);
    expect(() => hashSecret(new Uint8Array(33))).toThrow(/preimage must be exactly 32 bytes/);
  });

  it("verifyPreimage detects both sha256 and keccak256 commitments", () => {
    const s = generateSecret();
    expect(verifyPreimage(s.preimage, s.sha256)).toBe("sha256");
    expect(verifyPreimage(s.preimage, s.keccak256)).toBe("keccak256");
    const other = generateSecret();
    expect(verifyPreimage(s.preimage, other.sha256)).toBeNull();
  });

  it("verifyPreimage rejects malformed expected digests", () => {
    const s = generateSecret();
    expect(() => verifyPreimage(s.preimage, `0x${"00".repeat(31)}`)).toThrow(/expected digest/);
    expect(() => verifyPreimage(s.preimage, `0x${"zz".repeat(32)}` as `0x${string}`)).toThrow(/expected digest/);
  });

  // ---------------------------------------------------------------------------
  // Published cross-chain hashlock test vector (closes #866)
  //
  // This vector is reproduced in contracts/docs/HASHLOCK_COMPATIBILITY.md.
  // If either the SDK implementation or the documented digests drift, this
  // test fails before the mismatch reaches production.
  //
  // NEVER use this preimage for a real order — it is publicly known.
  // ---------------------------------------------------------------------------
  it("published cross-chain hashlock test vector matches documented digests", () => {
    // Fixed 32-byte preimage: bytes 0x01..0x20.
    const preimage =
      "0x0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20" as `0x${string}`;

    const s = hashSecret(preimage);

    // The sha256 digest is the authoritative hashlock for cross-chain orders
    // (Ethereum + Stellar + Solana all accept it).
    expect(s.sha256).toBe(
      "0xae216c2ef5247a3782c135efa279a3e4cdc61094270f5d2be58c6204b7a612c9"
    );

    // The keccak256 digest is accepted by Ethereum only and must NOT be used
    // as the hashlock for cross-chain orders.
    expect(s.keccak256).toBe(
      "0x52b3f53ff196a28e7d2d01283ef9427070bda64128fb5630b97b6ab17a8ff0a8"
    );

    // verifyPreimage correctly identifies the digest type for the known vector.
    expect(verifyPreimage(preimage, s.sha256)).toBe("sha256");
    expect(verifyPreimage(preimage, s.keccak256)).toBe("keccak256");
  });
});
