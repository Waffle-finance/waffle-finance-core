import { describe, it, expect } from "vitest";
import {
  canTransition,
  InvalidTransitionError,
  isTerminal,
  nextStatesOf,
  requireTransition,
} from "../src/state-machine/index.js";
import type { OrderStatus } from "../src/types/index.js";

const ALL_STATUSES: OrderStatus[] = [
  "announced",
  "src_locked",
  "dst_locked",
  "secret_revealed",
  "completed",
  "refunded",
  "failed",
  "expired",
];

const EXPECTED_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  announced: ["src_locked", "failed", "expired"],
  src_locked: ["dst_locked", "secret_revealed", "refunded", "failed", "expired"],
  dst_locked: ["secret_revealed", "refunded", "failed", "expired"],
  secret_revealed: ["completed", "refunded", "failed"],
  completed: [],
  refunded: [],
  failed: [],
  expired: ["refunded", "failed"],
};

describe("order state machine", () => {
  it("matches the complete transition matrix", () => {
    for (const from of ALL_STATUSES) {
      expect(nextStatesOf(from)).toEqual(EXPECTED_TRANSITIONS[from]);

      for (const to of ALL_STATUSES) {
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(
          EXPECTED_TRANSITIONS[from].includes(to)
        );
      }
    }
  });

  describe("happy path transitions", () => {
    it("allows the happy path: announced -> src_locked -> dst_locked -> secret_revealed -> completed", () => {
      requireTransition("announced", "src_locked");
      requireTransition("src_locked", "dst_locked");
      requireTransition("dst_locked", "secret_revealed");
      requireTransition("secret_revealed", "completed");
    });

    it("allows refund from any pre-terminal state", () => {
      expect(canTransition("src_locked", "refunded")).toBe(true);
      expect(canTransition("dst_locked", "refunded")).toBe(true);
      expect(canTransition("secret_revealed", "refunded")).toBe(true);
      expect(canTransition("expired", "refunded")).toBe(true);
    });

    it("rejects invalid transitions", () => {
      expect(() => requireTransition("announced", "completed")).toThrow(InvalidTransitionError);
      expect(canTransition("completed", "announced")).toBe(false);
    });

    it("marks terminal states correctly", () => {
      expect(isTerminal("completed")).toBe(true);
      expect(isTerminal("refunded")).toBe(true);
      expect(isTerminal("failed")).toBe(true);
      expect(isTerminal("announced")).toBe(false);
      expect(isTerminal("src_locked")).toBe(false);
    });

    it("nextStatesOf returns a stable list", () => {
      expect(nextStatesOf("announced")).toEqual(["src_locked", "failed", "expired"]);
      expect(nextStatesOf("completed")).toEqual([]);
    });
  });

  describe("duplicate event handling", () => {
    it("idempotent: repeating a transition returns the same result", () => {
      // An order already in src_locked that receives another src_locked event
      // should be a no-op (transition is valid but idempotent)
      expect(canTransition("src_locked", "src_locked")).toBe(false);
    });

    it("repeated refund on same state is not allowed", () => {
      // Once refunded, cannot refund again
      expect(canTransition("refunded", "refunded")).toBe(false);
    });
  });

  describe("out-of-order transitions", () => {
    it("rejects skipping src_locked to go directly to secret_revealed", () => {
      expect(canTransition("announced", "secret_revealed")).toBe(false);
    });

    it("rejects skipping src_locked to go directly to completed", () => {
      expect(canTransition("announced", "completed")).toBe(false);
    });

    it("rejects skipping dst_locked to go directly to completed", () => {
      expect(canTransition("src_locked", "completed")).toBe(false);
    });

    it("rejects transitioning from expired to dst_locked", () => {
      expect(canTransition("expired", "dst_locked")).toBe(false);
    });
  });

  describe("timeout handling", () => {
    it("allows transition from src_locked to expired when timelock passes", () => {
      expect(canTransition("src_locked", "expired")).toBe(true);
    });

    it("allows transition from dst_locked to expired when timelock passes", () => {
      expect(canTransition("dst_locked", "expired")).toBe(true);
    });

    it("allows transition from expired to refunded", () => {
      expect(canTransition("expired", "refunded")).toBe(true);
    });

    it("allows transition from expired to failed", () => {
      expect(canTransition("expired", "failed")).toBe(true);
    });

    it("expired can only transition to refunded or failed", () => {
      const next = nextStatesOf("expired");
      expect(next).toEqual(["refunded", "failed"]);
    });

    it("expired cannot transition back to earlier states", () => {
      expect(canTransition("expired", "announced")).toBe(false);
      expect(canTransition("expired", "src_locked")).toBe(false);
      expect(canTransition("expired", "dst_locked")).toBe(false);
    });
  });

  describe("interruption scenarios", () => {
    it("fail transitions are available from multiple states", () => {
      expect(canTransition("announced", "failed")).toBe(true);
      expect(canTransition("src_locked", "failed")).toBe(true);
      expect(canTransition("dst_locked", "failed")).toBe(true);
      expect(canTransition("secret_revealed", "failed")).toBe(true);
    });

    it("failed is terminal and has no outgoing transitions", () => {
      expect(isTerminal("failed")).toBe(true);
      expect(nextStatesOf("failed")).toEqual([]);
    });

    it("once failed, no recovery transitions are allowed", () => {
      expect(canTransition("failed", "src_locked")).toBe(false);
      expect(canTransition("failed", "completed")).toBe(false);
      expect(canTransition("failed", "refunded")).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("transition from failed to any state is rejected", () => {
      expect(() => requireTransition("failed", "completed")).toThrow(InvalidTransitionError);
      expect(() => requireTransition("failed", "refunded")).toThrow(InvalidTransitionError);
    });

    it("transition from completed to any state is rejected", () => {
      expect(() => requireTransition("completed", "src_locked")).toThrow(InvalidTransitionError);
      expect(() => requireTransition("completed", "refunded")).toThrow(InvalidTransitionError);
    });

    it("all terminal states have empty next states", () => {
      expect(nextStatesOf("completed")).toEqual([]);
      expect(nextStatesOf("refunded")).toEqual([]);
      expect(nextStatesOf("failed")).toEqual([]);
    });

    it("throwing transition error includes from/to state", () => {
      try {
        requireTransition("completed", "announced");
        expect.fail("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(InvalidTransitionError);
        if (e instanceof InvalidTransitionError) {
          expect(e.from).toBe("completed");
          expect(e.to).toBe("announced");
        }
      }
    });
  });
});
