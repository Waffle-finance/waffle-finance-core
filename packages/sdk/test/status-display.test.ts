import { describe, it, expect } from "vitest";
import {
  describeOrderStatus,
  displayStatusFor,
  statusDisplay,
  isDisplayStatus,
  ALL_DISPLAY_STATUSES,
  ORDER_STATUS_TO_DISPLAY,
} from "../src/status-display/index.js";
import { ORDER_STATUSES, TERMINAL_ORDER_STATUSES } from "../src/types/index.js";
import type { OrderStatus } from "../src/types/index.js";

const ALL_ORDER_STATUSES: OrderStatus[] = [...ORDER_STATUSES];

describe("status-display taxonomy", () => {
  it("maps every canonical OrderStatus atom to a DisplayStatus", () => {
    for (const atom of ALL_ORDER_STATUSES) {
      const display = displayStatusFor(atom);
      expect(ALL_DISPLAY_STATUSES).toContain(display);
    }
  });

  it("ORDER_STATUS_TO_DISPLAY is a total function over ORDER_STATUSES", () => {
    // Every canonical atom resolves to a valid display status (no undefined,
    // no invented statuses).
    for (const atom of ORDER_STATUSES) {
      const display = ORDER_STATUS_TO_DISPLAY[atom];
      expect(ALL_DISPLAY_STATUSES).toContain(display);
    }
  });

  it("maps pre-lock atoms to 'pending'", () => {
    expect(displayStatusFor("announced")).toBe("pending");
    expect(displayStatusFor("src_locked")).toBe("pending");
  });

  it("maps both-legs-committed atoms to 'confirmed'", () => {
    expect(displayStatusFor("dst_locked")).toBe("confirmed");
    expect(displayStatusFor("secret_revealed")).toBe("confirmed");
  });

  it("maps terminal atoms to the correct display status", () => {
    expect(displayStatusFor("completed")).toBe("completed");
    expect(displayStatusFor("failed")).toBe("failed");
    expect(displayStatusFor("refunded")).toBe("refunded");
    expect(displayStatusFor("expired")).toBe("expired");
    expect(displayStatusFor("cancelled")).toBe("cancelled");
    // Abandoned orders never had funds locked; the user sees "Cancelled".
    expect(displayStatusFor("abandoned")).toBe("cancelled");
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

  it("uses a success tone only for completed", () => {
    expect(describeOrderStatus("completed").tone).toBe("success");
    const completed = statusDisplay("completed");
    expect(completed.tone).toBe("success");
    expect(completed.label).toBe("Completed");
    // 'confirmed' is irreversible-but-not-final, distinct from delivered.
    expect(describeOrderStatus("dst_locked").tone).toBe("info");
    expect(statusDisplay("confirmed").label).toBe("Confirmed");
  });

  it("uses an error tone for failed", () => {
    expect(describeOrderStatus("failed").tone).toBe("error");
  });

  it("agrees with the frontend-visible semantics for every atom", () => {
    // Pins the canonical meaning the UI relies on: same atom → same display.
    expect(displayStatusFor("announced")).toBe("pending");
    expect(displayStatusFor("src_locked")).toBe("pending");
    expect(displayStatusFor("dst_locked")).toBe("confirmed");
    expect(displayStatusFor("secret_revealed")).toBe("confirmed");
    expect(displayStatusFor("completed")).toBe("completed");
    expect(displayStatusFor("refunded")).toBe("refunded");
    expect(displayStatusFor("failed")).toBe("failed");
  });

  it("expired OrderStatus surfaces as the 'expired' display status", () => {
    const expired = describeOrderStatus("expired");
    expect(expired.status).toBe("expired");
    expect(expired.label).toBe("Timelock expired");
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

  it("statusDisplay returns the canonical display for each atom", () => {
    expect(statusDisplay("pending")).toEqual(describeOrderStatus("announced"));
    expect(statusDisplay("confirmed")).toEqual(describeOrderStatus("dst_locked"));
    expect(statusDisplay("completed")).toEqual(describeOrderStatus("completed"));
    expect(statusDisplay("expired")).toEqual(describeOrderStatus("expired"));
    expect(statusDisplay("cancelled")).toEqual(describeOrderStatus("abandoned"));
  });

  it("isDisplayStatus accepts valid display statuses and rejects raw atoms", () => {
    expect(isDisplayStatus("pending")).toBe(true);
    expect(isDisplayStatus("completed")).toBe(true);
    expect(isDisplayStatus("confirmed")).toBe(true);
    expect(isDisplayStatus("cancelled")).toBe(true);
    expect(isDisplayStatus("expired")).toBe(true);
    expect(isDisplayStatus("timed_out")).toBe(true);
    expect(isDisplayStatus("announced")).toBe(false);
    expect(isDisplayStatus("src_locked")).toBe(false);
    expect(isDisplayStatus("secret_revealed")).toBe(false);
    expect(isDisplayStatus("abandoned")).toBe(false);
  });

  it("ALL_DISPLAY_STATUSES includes all user-facing statuses", () => {
    expect(ALL_DISPLAY_STATUSES).toContain("pending");
    expect(ALL_DISPLAY_STATUSES).toContain("confirmed");
    expect(ALL_DISPLAY_STATUSES).toContain("completed");
    expect(ALL_DISPLAY_STATUSES).toContain("cancelled");
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