import { describe, it, expect } from "vitest";
import { sanitizeForLog } from "../src/utils/sanitize-for-log.js";

describe("sanitizeForLog", () => {
  it("redacts long hex strings in simple strings", () => {
    const input = "bad preimage: 0xabcdef1234567890abcdef";
    const result = sanitizeForLog(input);
    expect(result).toBe("bad preimage: [REDACTED_SECRET]");
  });

  it("leaves short hex strings intact", () => {
    const input = "selector: 0xabcdef12";
    const result = sanitizeForLog(input);
    expect(result).toBe("selector: 0xabcdef12");
  });

  it("redacts long hex strings in Error objects", () => {
    const err = new Error("bad preimage: 0xabcdef1234567890abcdef");
    const result = sanitizeForLog(err) as any;
    expect(result.message).toBe("bad preimage: [REDACTED_SECRET]");
    expect(result.stack).toContain("[REDACTED_SECRET]");
  });

  it("redacts deep object properties up to limit", () => {
    const obj = {
      level1: {
        level2: {
          secret: "0xabcdef1234567890abcdef"
        }
      }
    };
    const result = sanitizeForLog(obj) as any;
    expect(result.level1.level2.secret).toBe("[REDACTED_SECRET]");
  });

  it("stops recursing at depth 3", () => {
    const obj = {
      level1: {
        level2: {
          level3: {
            level4: {
              secret: "0xabcdef1234567890abcdef"
            }
          }
        }
      }
    };
    const result = sanitizeForLog(obj) as any;
    expect(result.level1.level2.level3).toBe("[MAX_DEPTH_REACHED]");
  });

  it("handles arrays", () => {
    const arr = ["safe", "0xabcdef1234567890abcdef"];
    const result = sanitizeForLog(arr) as any;
    expect(result[0]).toBe("safe");
    expect(result[1]).toBe("[REDACTED_SECRET]");
  });

  it("handles null/undefined primitives safely", () => {
    expect(sanitizeForLog(null)).toBe(null);
    expect(sanitizeForLog(undefined)).toBe(undefined);
    expect(sanitizeForLog(123)).toBe(123);
  });
});
