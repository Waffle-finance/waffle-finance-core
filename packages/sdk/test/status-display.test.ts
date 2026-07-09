import { describe, it, expect } from "vitest";
import {
  describeOrderStatus,
  displayStatusFor,
  statusDisplay,
  isDisplayStatus,
  ALL_DISPLAY_STATUSES,
} from "../src/status-display/index.js";
import type { OrderStatus } from "../src/types/index.js";

const ALL_ORDER_STATUSES: OrderStatus[] = [
  "announced",
  "src_locked",
  "dst_locked",
  "secret_revealed",
  "completed",
  "refunded",
  "failed",
  "expired",
];

describe("status-display taxonomy", () => {
  it("maps every OrderStatus atom to a DisplayStatus", () => {
    for (const atom of ALL_ORDER_STATUSES) {
      const display = displayStatusFor(atom);
      expect(ALL_DISPLAY_STATUSES).toContain(display);
    }
  });

  it("maps intermediate order sub-states to 'pending'", () => {
    expect(displayStatusFor("announced")).toBe("pending");
    expect(displayStatusFor("src_locked")).toBe("pending");
    expect(displayStatusFor("dst_locked")).toBe("pending");
    expect(displayStatusFor("secret_revealed")).toBe("pending");
  });

  it("maps terminal atoms to the correct display status", () => {
    expect(displayStatusFor("completed")).toBe("confirmed");
    expect(displayStatusFor("failed")).toBe("failed");
    expect(displayStatusFor("refunded")).toBe("refunded");
    expect(displayStatusFor("expired")).toBe("timed_out");
  });

  it("describeOrderStatus returns a non-empty label, message, and action", () => {
    for (const atom of ALL_ORDER_STATUSES) {
      const display = describeOrderStatus(atom);
      expect(display.label.length).toBeGreaterThan(0);
      expect(display.message.length).toBeGreaterThan(0);
      expect(display.action.length).toBeGreaterThan(0);
      expect(["neutral", "info", "success", "warning", "error"]).toContain(
        display.tone
      );
    }
  });

  it("uses a success tone for completed/confirmed", () => {
    expect(describeOrderStatus("completed").tone).toBe("success");
    const confirmed = statusDisplay("confirmed");
    expect(confirmed.tone).toBe("success");
    expect(confirmed.label).toBe("Confirmed");
  });

  it("uses an error tone for failed", () => {
    expect(describeOrderStatus("failed").tone).toBe("error");
  });

  it("expired OrderStatus surfaces as 'Timed out' display status", () => {
    const expired = describeOrderStatus("expired");
    expect(expired.status).toBe("timed_out");
    expect(expired.label).toBe("Timed out");
    expect(expired.tone).toBe("warning");
  });

  it("timed_out DisplayStatus is separate from expired DisplayStatus", () => {
    const timedOut = statusDisplay("timed_out");
    const expired = statusDisplay("expired");
    expect(timedOut.status).toBe("timed_out");
    expect(expired.status).toBe("expired");
    expect(timedOut.label).toBe("Timed out");
    expect(expired.label).toBe("Timelock expired");
    expect(timedOut.tone).toBe("warning");
    expect(expired.tone).toBe("warning");
  });

  it("statusDisplay returns the same object as describeOrderStatus for the mapped atom", () => {
    expect(statusDisplay("timed_out")).toEqual(describeOrderStatus("expired"));
    expect(statusDisplay("confirmed")).toEqual(describeOrderStatus("completed"));
    expect(statusDisplay("pending")).toEqual(describeOrderStatus("announced"));
  });

  it("isDisplayStatus accepts valid display statuses and rejects raw atoms", () => {
    expect(isDisplayStatus("pending")).toBe(true);
    expect(isDisplayStatus("completed")).toBe(true);
    expect(isDisplayStatus("confirmed")).toBe(true);
    expect(isDisplayStatus("expired")).toBe(true);
    expect(isDisplayStatus("timed_out")).toBe(true);
    expect(isDisplayStatus("announced")).toBe(false);
    expect(isDisplayStatus("src_locked")).toBe(false);
    expect(isDisplayStatus("secret_revealed")).toBe(false);
  });

  it("ALL_DISPLAY_STATUSES includes all user-facing statuses", () => {
    expect(ALL_DISPLAY_STATUSES).toContain("pending");
    expect(ALL_DISPLAY_STATUSES).toContain("confirmed");
    expect(ALL_DISPLAY_STATUSES).toContain("completed");
    expect(ALL_DISPLAY_STATUSES).toContain("failed");
    expect(ALL_DISPLAY_STATUSES).toContain("refunded");
    expect(ALL_DISPLAY_STATUSES).toContain("expired");
    expect(ALL_DISPLAY_STATUSES).toContain("timed_out");
  });

  it("all status messages are non-technical and actionable", () => {
    for (const status of ALL_DISPLAY_STATUSES) {
      const display = statusDisplay(status);
      expect(display.message.length).toBeGreaterThan(10);
      expect(display.action.length).toBeGreaterThan(5);
      expect(display.message).not.toContain("HTLC");
      expect(display.message).not.toContain("timelock");
    }
  });
});
