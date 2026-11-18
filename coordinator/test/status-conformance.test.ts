/**
 * Order-status ontology conformance.
 *
 * Issue 50 (single source of truth): the SDK's `ORDER_STATUSES`,
 * `ORDER_STATUS_TRANSITIONS`, and `TERMINAL_ORDER_STATUSES` are the canonical
 * definition every layer must match. The coordinator keeps its own
 * `OrderStatus` type and transition table for dependency reasons, but this
 * suite pins them to the SDK so a rename or an added/removed state in either
 * place is caught at test time — before it can surface as a UI that says one
 * thing and a backend that means another.
 */

import { describe, it, expect } from "vitest";
import { ORDER_STATUSES, TERMINAL_ORDER_STATUSES } from "@wafflefinance/sdk/types";
import { ORDER_STATUS_TRANSITIONS } from "@wafflefinance/sdk/state-machine";
import { ORDER_STATUS_TRANSITIONS as COORDINATOR_TRANSITIONS } from "../src/state-machine/order-machine.js";

describe("order-status ontology conformance (backend ↔ SDK)", () => {
  it("backend transitions cover exactly the canonical ORDER_STATUSES", () => {
    expect(Object.keys(COORDINATOR_TRANSITIONS).sort()).toEqual([...ORDER_STATUSES].sort());
  });

  it("backend transition table matches the SDK canonical table", () => {
    for (const from of ORDER_STATUSES) {
      expect(
        [...COORDINATOR_TRANSITIONS[from]].sort(),
        `transitions from ${from} must match the SDK`
      ).toEqual([...ORDER_STATUS_TRANSITIONS[from]].sort());
    }
  });

  it("backend terminal set matches TERMINAL_ORDER_STATUSES", () => {
    const terminals = Object.entries(COORDINATOR_TRANSITIONS)
      .filter(([, next]) => next.length === 0)
      .map(([status]) => status);
    expect(terminals.sort()).toEqual([...TERMINAL_ORDER_STATUSES].sort());
  });
});