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
});
