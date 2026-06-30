import { describe, it, expect } from "vitest";
import {
  hexToBuffer,
  bufferToHex,
  writeU64LE,
  readU64LE,
  readI64LE,
  validateOrderId,
  orderIdFromHashlock,
  hashlockFromOrderId,
  validateHashlock,
  ORDER_ID_PREFIX,
  hex32ToBuffer,
  escrowNativeValue,
  isTimeoutTransition,
  isFailureTransition,
  estimateTimelockRemaining,
} from "../src/shared-utils/index.js";

describe("hexToBuffer", () => {
  it("converts 0x-prefixed hex to buffer", () => {
    expect(hexToBuffer("0x00010203").toString("hex")).toBe("00010203");
  });

  it("handles unprefixed hex strings", () => {
    expect(hexToBuffer("abcd").toString("hex")).toBe("abcd");
  });

  it("throws for invalid hex characters", () => {
    expect(() => hexToBuffer("0xzzzz")).toThrow("hex string must contain an even number of hex characters");
  });
});

describe("hex32ToBuffer", () => {
  it("validates and converts 32-byte hex values", () => {
    const hashlock = "0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
    expect(hex32ToBuffer(hashlock, "hashlock")).toHaveLength(32);
  });

  it("throws a labeled error for non-bytes32 values", () => {
    expect(() => hex32ToBuffer("0x1234", "preimage")).toThrow(
      "preimage must be 0x + 64 hex chars"
    );
  });
});

describe("bufferToHex", () => {
  it("converts buffer to 0x-prefixed hex", () => {
    expect(bufferToHex(Buffer.from([0x00, 0x01, 0x02, 0x03]))).toBe("0x00010203");
  });

  it("handles Uint8Array", () => {
    expect(bufferToHex(new Uint8Array([0xff, 0xaa]))).toBe("0xffaa");
  });
});

describe("writeU64LE / readU64LE", () => {
  it("round-trips a small value", () => {
    const buf = Buffer.alloc(8);
    writeU64LE(buf, 12345n, 0);
    expect(readU64LE(buf, 0)).toBe(12345n);
  });

  it("round-trips a large value", () => {
    const buf = Buffer.alloc(8);
    const val = BigInt("0xfffffffffffffffe");
    writeU64LE(buf, val, 0);
    expect(readU64LE(buf, 0)).toBe(val);
  });

  it("round-trips at an offset", () => {
    const buf = Buffer.alloc(24);
    writeU64LE(buf, 100n, 4);
    writeU64LE(buf, 200n, 16);
    expect(readU64LE(buf, 4)).toBe(100n);
    expect(readU64LE(buf, 16)).toBe(200n);
  });
});

describe("readI64LE", () => {
  it("reads a positive signed value", () => {
    const buf = Buffer.alloc(8);
    buf.writeBigInt64LE(42n, 0);
    expect(readI64LE(buf, 0)).toBe(42n);
  });

  it("reads a negative signed value", () => {
    const buf = Buffer.alloc(8);
    buf.writeBigInt64LE(-42n, 0);
    expect(readI64LE(buf, 0)).toBe(-42n);
  });
});

describe("ORDER_ID_PREFIX", () => {
  it("has the expected value", () => {
    expect(ORDER_ID_PREFIX).toBe("wf_");
  });
});

describe("validateOrderId", () => {
  it("accepts valid order IDs", () => {
    expect(validateOrderId("wf_0x0000000000000000000000000000000000000000000000000000000000000000")).toBe(null);
  });

  it("rejects missing prefix", () => {
    expect(validateOrderId("0x0000000000000000000000000000000000000000000000000000000000000000")).toBe(
      `Order ID must start with "${ORDER_ID_PREFIX}"`
    );
  });

  it("rejects short hashlock", () => {
    expect(validateOrderId("wf_0x123")).toBe(
      "Order ID must contain 0x-prefixed 64 hex characters (32 bytes)"
    );
  });

  it("rejects non-string input", () => {
    expect(validateOrderId(123 as any)).toBe("Order ID must be a string");
  });
});

describe("orderIdFromHashlock", () => {
  it("generates correct format from valid hashlock", () => {
    const hashlock = "0x0000000000000000000000000000000000000000000000000000000000000001";
    expect(orderIdFromHashlock(hashlock)).toBe(`wf_${hashlock}`);
  });

  it("canonicalizes hashlock casing", () => {
    const hashlock = "0xABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789";
    expect(orderIdFromHashlock(hashlock)).toBe(`wf_${hashlock.toLowerCase()}`);
  });

  it("throws for invalid hashlock length", () => {
    expect(() => orderIdFromHashlock("0x123" as any)).toThrow("Hashlock must be 0x + 64 hex chars");
  });
});

describe("escrowNativeValue", () => {
  it("adds amount and safety deposit for native-token locks", () => {
    expect(
      escrowNativeValue({
        token: "0x0000000000000000000000000000000000000000",
        nativeToken: "0x0000000000000000000000000000000000000000",
        amount: 100n,
        safetyDeposit: 5n,
      })
    ).toBe(105n);
  });

  it("uses only safety deposit for token locks", () => {
    expect(
      escrowNativeValue({
        token: "0x0000000000000000000000000000000000000001",
        nativeToken: "0x0000000000000000000000000000000000000000",
        amount: 100n,
        safetyDeposit: 5n,
      })
    ).toBe(5n);
  });
});

describe("hashlockFromOrderId", () => {
  it("extracts hashlock from valid order ID", () => {
    const hashlock = "0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
    const id = orderIdFromHashlock(hashlock);
    expect(hashlockFromOrderId(id)).toBe(hashlock);
  });

  it("throws for invalid order ID", () => {
    expect(() => hashlockFromOrderId("invalid")).toThrow();
  });
});

describe("validateHashlock", () => {
  it("returns true for valid 32-byte hashlock", () => {
    expect(validateHashlock("0x0000000000000000000000000000000000000000000000000000000000000000")).toBe(true);
  });

  it("returns false for wrong length", () => {
    expect(validateHashlock("0x1234")).toBe(false);
  });

  it("returns false for missing 0x prefix", () => {
    expect(validateHashlock("0000000000000000000000000000000000000000000000000000000000000000")).toBe(false);
  });
});

describe("isTimeoutTransition", () => {
  it("detects expired transition from locked states", () => {
    expect(isTimeoutTransition("src_locked", "expired")).toBe(true);
    expect(isTimeoutTransition("dst_locked", "expired")).toBe(true);
  });

  it("detects refund after expired", () => {
    expect(isTimeoutTransition("expired", "refunded")).toBe(true);
  });

  it("detects failed after expired", () => {
    expect(isTimeoutTransition("expired", "failed")).toBe(true);
  });

  it("returns false for non-timeout transitions", () => {
    expect(isTimeoutTransition("announced", "src_locked")).toBe(false);
    expect(isTimeoutTransition("src_locked", "dst_locked")).toBe(false);
  });
});

describe("isFailureTransition", () => {
  it("detects failed status", () => {
    expect(isFailureTransition("failed")).toBe(true);
  });

  it("returns false for other statuses", () => {
    expect(isFailureTransition("completed")).toBe(false);
    expect(isFailureTransition("refunded")).toBe(false);
  });
});

describe("estimateTimelockRemaining", () => {
  it("returns null for wrong status", () => {
    expect(estimateTimelockRemaining("announced", 1000)).toBe(null);
    expect(estimateTimelockRemaining("completed", 1000)).toBe(null);
  });

  it("returns null when timelock is null", () => {
    expect(estimateTimelockRemaining("src_locked", null)).toBe(null);
  });

  it("returns null when timelock already passed", () => {
    expect(estimateTimelockRemaining("src_locked", 1, 1000)).toBe(null);
  });

  it("returns remaining seconds for locked state", () => {
    const futureTime = Math.floor(Date.now() / 1000) + 3600;
    expect(estimateTimelockRemaining("src_locked", futureTime)).toBe(3600);
  });
});
