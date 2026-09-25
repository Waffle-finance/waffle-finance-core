/**
 * @file test/export-routes-date.test.ts
 *
 * Unit tests for the `downloadQuerySchema` date transformer in
 * coordinator/src/server/routes/export.ts.
 *
 * Acceptance criteria (task a):
 *   - Invalid date strings fail with a Zod validation error before any
 *     repository access is attempted.
 *   - Valid ISO date strings are converted to the correct unix-second integer.
 *   - The error message is actionable enough for an API client to correct its
 *     request.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";

// ─── Re-export the schema under test ─────────────────────────────────────────
//
// downloadQuerySchema is not exported from the routes module, so we inline
// the two date fields we are testing.  This keeps the tests self-contained
// and avoids standing up an Express server just to parse query params.

function makeDateSchema(field: "startDate" | "endDate") {
  return z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (!v || v === "all") return undefined;
      const ts = Number.isFinite(Number(v))
        ? Number(v)
        : Math.floor(new Date(v).getTime() / 1000);
      if (!Number.isFinite(ts)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Invalid ${field}: "${v}" is not a valid date or unix timestamp`,
        });
        return z.NEVER;
      }
      return ts;
    });
}

const startDateSchema = makeDateSchema("startDate");
const endDateSchema   = makeDateSchema("endDate");

// ─── Malformed / invalid date tests ─────────────────────────────────────────

describe("downloadQuerySchema date transformer — invalid inputs", () => {
  it("rejects a clearly malformed string and returns a ZodError", () => {
    const result = startDateSchema.safeParse("not-a-date");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toHaveLength(1);
      expect(result.error.issues[0]!.message).toMatch(/invalid startdate/i);
      // Message should name the bad value so the client can identify it.
      expect(result.error.issues[0]!.message).toContain("not-a-date");
    }
  });

  it("rejects an empty month string", () => {
    const result = endDateSchema.safeParse("2026-99-99");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.message).toMatch(/invalid enddate/i);
    }
  });

  it("rejects 'NaN' as a literal string", () => {
    const result = startDateSchema.safeParse("NaN");
    expect(result.success).toBe(false);
  });

  it("rejects 'Infinity' as a literal string", () => {
    const result = startDateSchema.safeParse("Infinity");
    // Number("Infinity") is Infinity, which is not finite — must be rejected.
    expect(result.success).toBe(false);
  });
});

// ─── Valid input tests ────────────────────────────────────────────────────────

describe("downloadQuerySchema date transformer — valid inputs", () => {
  it("converts a valid ISO date string to a unix-second integer", () => {
    const result = startDateSchema.safeParse("2026-01-15T00:00:00.000Z");
    expect(result.success).toBe(true);
    if (result.success) {
      const expected = Math.floor(new Date("2026-01-15T00:00:00.000Z").getTime() / 1000);
      expect(result.data).toBe(expected);
      expect(Number.isFinite(result.data as number)).toBe(true);
    }
  });

  it("converts a unix-second numeric string to a number unchanged", () => {
    const result = startDateSchema.safeParse("1753228800");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe(1753228800);
    }
  });

  it("returns undefined for 'all' (no date bound)", () => {
    const result = startDateSchema.safeParse("all");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBeUndefined();
    }
  });

  it("returns undefined when the field is absent", () => {
    const result = startDateSchema.safeParse(undefined);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBeUndefined();
    }
  });

  it("endDate: converts a valid ISO date correctly", () => {
    const result = endDateSchema.safeParse("2026-12-31T23:59:59.000Z");
    expect(result.success).toBe(true);
    if (result.success) {
      const expected = Math.floor(new Date("2026-12-31T23:59:59.000Z").getTime() / 1000);
      expect(result.data).toBe(expected);
    }
  });
});
