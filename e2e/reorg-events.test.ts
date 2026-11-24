import { describe, expect, it } from "vitest";
import {
  canTransition,
  isTerminal,
  type OrderStatus,
} from "@wafflefinance/sdk/state-machine";
import {
  ethEventKey,
  EventSeenSet,
  semanticKey,
} from "../coordinator/src/reconciliation/event-identity.js";
import { classifyConflict } from "../coordinator/src/reconciliation/replay-policy.js";

/**
 * Deterministic EVM event-reconciliation scenarios (#1125).
 * The fixtures mirror listener envelopes: block hash, removed flag, tx hash,
 * log index and finalized flag. No network or database is involved.
 */
interface ChainLog {
  readonly eventType: "OrderCreated" | "OrderClaimed" | "OrderRefunded";
  readonly blockNumber: number;
  readonly blockHash: string;
  readonly txHash: string;
  readonly logIndex: number;
  readonly removed: boolean;
  /** Hashlock for OrderCreated; on-chain order id otherwise. */
  readonly identifier: string;
  /** True once the listener's confirmation depth has been reached. */
  readonly finalized?: boolean;
}

const HASHLOCK = "0x" + "aa".repeat(32);
const TX_A = ("0x" + "11".repeat(32)) as const;
const TX_B = ("0x" + "22".repeat(32)) as const;
const BLOCK_A = "0x" + "ab".repeat(32);
const BLOCK_B = "0x" + "cd".repeat(32);

function created(txHash: string, blockHash: string, removed = false, finalized = false): ChainLog {
  return {
    eventType: "OrderCreated",
    blockNumber: 100,
    blockHash,
    txHash,
    logIndex: 0,
    removed,
    identifier: HASHLOCK,
    finalized,
  };
}

interface ObservedState {
  status: OrderStatus;
  srcOrderId?: string;
  lockTx?: string;
  applied: string[];
  rolledBack: string[];
  duplicates: number;
  settlements: number;
}

class EventLedger {
  readonly state: ObservedState = {
    status: "announced",
    applied: [],
    rolledBack: [],
    duplicates: 0,
    settlements: 0,
  };
  private readonly seen = new EventSeenSet();
  private readonly finalizedKeys = new Set<string>();

  apply(log: ChainLog): "applied" | "rolled-back" | "duplicate" | "ignored-finalized" {
    const key = ethEventKey(log.eventType, log.txHash, log.logIndex);
    const sem = semanticKey("ethereum", log.eventType, log.identifier);

    if (log.removed) {
      // A finalized event cannot be reversed by a stale provider response.
      if (this.finalizedKeys.has(key) || this.finalizedKeys.has(sem)) return "ignored-finalized";
      if (isTerminal(this.state.status)) return "ignored-finalized";
      if (this.state.lockTx?.toLowerCase() === log.txHash.toLowerCase()) {
        this.state.status = "announced";
        this.state.srcOrderId = undefined;
        this.state.lockTx = undefined;
        this.state.rolledBack.push(key);
        return "rolled-back";
      }
      return "ignored-finalized";
    }

    const conflict = this.seen.checkAndMark("ethereum", log.eventType, key, sem);
    if (conflict?.kind === "duplicate") {
      this.state.duplicates++;
      return "duplicate";
    }
    // A `reordered` conflict is the replacement log of a fork: it carries the
    // same semantic identity as the removed log but a new tx/block hash, so it
    // must be applied once.

    if (log.finalized) {
      this.finalizedKeys.add(key);
      this.finalizedKeys.add(sem);
    }
    if (log.eventType === "OrderCreated" && this.state.status === "announced") {
      this.state.status = "src_locked";
      this.state.srcOrderId = log.identifier;
      this.state.lockTx = log.txHash;
      this.state.applied.push(key);
    } else if (log.eventType === "OrderRefunded" && !isTerminal(this.state.status)) {
      this.state.status = "refunded";
      this.state.settlements++;
      this.state.applied.push(key);
    }
    return "applied";
  }
}

describe("deterministic duplicate and reorg event scenarios (#1125)", () => {
  it("rolls back an unfinalized log and applies the replacement only once", () => {
    const ledger = new EventLedger();
    expect(ledger.apply(created(TX_A, BLOCK_A))).toBe("applied");
    expect(ledger.state.lockTx).toBe(TX_A);

    expect(ledger.apply(created(TX_A, BLOCK_A, true))).toBe("rolled-back");
    expect(ledger.state.status).toBe("announced");
    expect(ledger.state.lockTx).toBeUndefined();

    expect(ledger.apply(created(TX_B, BLOCK_B))).toBe("applied");
    expect(ledger.apply(created(TX_B, BLOCK_B))).toBe("duplicate");
    expect(ledger.state.lockTx).toBe(TX_B);
    expect(ledger.state.applied).toEqual([
      ethEventKey("OrderCreated", TX_A, 0),
      ethEventKey("OrderCreated", TX_B, 0),
    ]);
    expect(ledger.state.duplicates).toBe(1);
  });

  it("converges to the replacement canonical chain state", () => {
    const ledger = new EventLedger();
    const staleFork = [
      created(TX_A, BLOCK_A),
      created(TX_A, BLOCK_A),
      created(TX_A, BLOCK_A, true),
    ];
    const replacement = [created(TX_B, BLOCK_B), created(TX_B, BLOCK_B)];

    for (const log of [...staleFork, ...replacement]) ledger.apply(log);

    expect(ledger.state.lockTx).toBe(TX_B);
    expect(ledger.state.rolledBack).toEqual([ethEventKey("OrderCreated", TX_A, 0)]);
    expect(ledger.state.duplicates).toBe(2);
    expect(ledger.state.status).toBe("src_locked");
  });

  it("does not duplicate settlement or regress a terminal state", () => {
    const ledger = new EventLedger();
    ledger.apply(created(TX_B, BLOCK_B));

    const refund: ChainLog = {
      eventType: "OrderRefunded",
      blockNumber: 150,
      blockHash: BLOCK_B,
      txHash: TX_B,
      logIndex: 1,
      removed: false,
      identifier: "4721",
      finalized: true,
    };
    expect(ledger.apply(refund)).toBe("applied");
    expect(ledger.apply(refund)).toBe("duplicate");
    expect(ledger.state.settlements).toBe(1);
    expect(ledger.state.status).toBe("refunded");

    // Stale provider response for the funding log cannot undo the settlement.
    expect(ledger.apply(created(TX_B, BLOCK_B, true))).toBe("ignored-finalized");
    expect(ledger.state.status).toBe("refunded");
    expect(isTerminal(ledger.state.status)).toBe(true);
    expect(canTransition("refunded", "src_locked")).toBe(false);

    const conflict = classifyConflict({
      chain: "ethereum",
      eventType: "OrderCreated",
      eventTargetStatus: "src_locked",
      currentStatus: "refunded",
      isTerminal: true,
    });
    expect(conflict.conflictType).toBe("status_ahead");
  });
});
