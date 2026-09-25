/**
 * ReplayPolicy — explicit, operator-observable replay and recovery decisions.
 *
 * ## Responsibility
 *
 * The reconciler must make several hard decisions on every run:
 *
 *  1. **Window sizing** — how many blocks/ledgers/slots to scan for each chain.
 *     The window is determined by the gap between the cursor HWM and the chain
 *     tip, capped at the configured lookback constant.
 *
 *  2. **Gap classification** — distinguish a normal catch-up gap from a gap
 *     that exceeds the lookback window.  The latter requires the reconciler to
 *     fall back to a fixed window (tip - lookback) and emit an operator warning.
 *
 *  3. **Conflict classification** — when an event would mutate an order that is
 *     already in a terminal or inconsistent state, classify the conflict so the
 *     operator can see whether it is benign (idempotent replay of an already-
 *     applied event) or anomalous (a new event contradicts persisted state).
 *
 *  4. **Forced historical re-sync** — when the gap exceeds a configurable
 *     multiple of the lookback window, the policy records a forced-resync
 *     decision that the reconciler emits as a metric and a structured log entry.
 *
 * ## Design
 *
 * All decisions are made through pure functions so they can be unit-tested
 * without RPC mocks.  The `ReplayPolicy` class accumulates decisions made
 * during a single reconciler run and exposes them for metrics emission after
 * the run completes.
 *
 * ## Conflict classification model
 *
 * | Conflict type         | Meaning                                            |
 * |-----------------------|----------------------------------------------------|
 * | `already_applied`     | Event would set a status/field already at that     |
 * |                       | value — pure idempotent replay, no mutation needed.|
 * | `status_ahead`        | Order is already past the target status (e.g.      |
 * |                       | event is OrderCreated but order is completed).      |
 * |                       | Benign; skip.                                       |
 * | `state_contradiction` | Event contradicts persisted state in a non-trivial |
 * |                       | way (e.g. OrderRefunded but order is completed).   |
 * |                       | Operator should investigate.                        |
 * | `unknown_order`       | Event references an orderId/hashlock with no        |
 * |                       | matching DB row.  May indicate a gap in the         |
 * |                       | announce flow or a missed event window.             |
 */

import type { GapAssessment, GapSeverity } from "./ledger-cursor.js";
import type { ConflictKind } from "./event-identity.js";
import type { OrderStatus } from "../persistence/orders-repo.js";

export type ConflictType =
  | "already_applied"
  | "status_ahead"
  | "state_contradiction"
  | "unknown_order";

export interface ReplayDecision {
  chain: string;
  /** The block/ledger/slot from which replay starts. */
  fromBlock: number;
  /** The block/ledger/slot at which replay ends (the current chain tip). */
  toBlock: number;
  /** Number of blocks/ledgers/slots in the scan window. */
  windowSize: number;
  /** Gap severity from the cursor assessment. */
  gapSeverity: GapSeverity;
  /** True when the lookback window was exceeded and the start fell back. */
  lookbackExceeded: boolean;
  /**
   * True when the gap exceeded FORCED_RESYNC_MULTIPLIER × lookbackWindow.
   * The reconciler emits a structured log and metric when this is true.
   */
  forcedHistoricalResync: boolean;
}

export interface ConflictDecision {
  chain: string;
  eventType: string;
  conflictType: ConflictType;
  /** Conflict kind from the event identity layer (duplicate | reordered). */
  dedupKind?: ConflictKind;
  publicId?: string;
  orderStatus?: OrderStatus;
  description: string;
}

/** Threshold for "forced historical re-sync" warning (multiples of lookbackWindow). */
export const FORCED_RESYNC_MULTIPLIER = 3;

// ─── Pure decision helpers ────────────────────────────────────────────────────

/**
 * Derive the `ReplayDecision` for a single chain from its `GapAssessment` and
 * the current chain tip.
 *
 * The `forcedHistoricalResync` flag is set when the gap exceeds
 * `FORCED_RESYNC_MULTIPLIER × lookbackWindow`, distinguishing a "warn and
 * recover" scenario from a genuinely large but manageable gap.
 */
export function buildReplayDecision(
  chain: string,
  assessment: GapAssessment,
): ReplayDecision {
  const windowSize = Math.max(0, assessment.tip - assessment.fromBlock);

  // A forced historical re-sync is triggered when the gap exceeds
  // FORCED_RESYNC_MULTIPLIER × the configured lookback window.  This is
  // a stronger signal than `lookbackExceeded` (which fires at 2×): it means
  // even the fallback window may not be sufficient to recover all events.
  const forcedHistoricalResync =
    assessment.lookbackExceeded &&
    assessment.gap > FORCED_RESYNC_MULTIPLIER * assessment.lookbackWindow;

  return {
    chain,
    fromBlock: assessment.fromBlock,
    toBlock: assessment.tip,
    windowSize,
    gapSeverity: assessment.severity,
    lookbackExceeded: assessment.lookbackExceeded,
    forcedHistoricalResync,
  };
}

/**
 * Classify an event-vs-state conflict.
 *
 * @param eventTargetStatus  The status the event would move the order to.
 * @param currentStatus      The order's current persisted status.
 * @param isTerminal         Whether `currentStatus` is a terminal state.
 */
export function classifyConflict(params: {
  chain: string;
  eventType: string;
  eventTargetStatus: OrderStatus;
  currentStatus: OrderStatus;
  isTerminal: boolean;
  publicId?: string;
}): ConflictDecision {
  const { chain, eventType, eventTargetStatus, currentStatus, isTerminal, publicId } = params;

  // Exact match: the event would set a status already at that value.
  if (currentStatus === eventTargetStatus) {
    return {
      chain,
      eventType,
      conflictType: "already_applied",
      publicId,
      orderStatus: currentStatus,
      description: `Event ${eventType} targets status '${eventTargetStatus}' which is already the current status`,
    };
  }

  // Terminal order: any event is benign (cannot regress a terminal order).
  if (isTerminal) {
    return {
      chain,
      eventType,
      conflictType: "status_ahead",
      publicId,
      orderStatus: currentStatus,
      description: `Order is in terminal state '${currentStatus}'; event ${eventType} targeting '${eventTargetStatus}' skipped`,
    };
  }

  // Specific contradiction: an event that is logically impossible given the
  // current state.  OrderCreated against secret_revealed means the order
  // was claimed before it was even src_locked — that cannot happen on-chain,
  // so it indicates a reorg, a corrupt RPC response, or a DB inconsistency.
  const isContradiction =
    (eventType === "OrderRefunded" && currentStatus === "completed") ||
    (eventType === "OrderClaimed" && currentStatus === "refunded") ||
    (eventType === "OrderCreated" && currentStatus === "secret_revealed");

  if (isContradiction) {
    return {
      chain,
      eventType,
      conflictType: "state_contradiction",
      publicId,
      orderStatus: currentStatus,
      description: `Event ${eventType} contradicts persisted state '${currentStatus}' — operator investigation recommended`,
    };
  }

  // Generic status-ahead: order has moved past the target.
  return {
    chain,
    eventType,
    conflictType: "status_ahead",
    publicId,
    orderStatus: currentStatus,
    description: `Order is in '${currentStatus}'; event ${eventType} targeting '${eventTargetStatus}' skipped as status is already ahead`,
  };
}

/**
 * Classify a conflict for an event referencing an order that does not exist
 * in the database.
 */
export function classifyUnknownOrder(
  chain: string,
  eventType: string,
  identifier: string,
): ConflictDecision {
  return {
    chain,
    eventType,
    conflictType: "unknown_order",
    description: `No DB order found for ${chain} ${eventType} with identifier '${identifier}'`,
  };
}

// ─── ReplayPolicy ─────────────────────────────────────────────────────────────

/**
 * Accumulates `ReplayDecision` and `ConflictDecision` records during a single
 * reconciler run and exposes them for structured logging and metrics emission.
 */
export class ReplayPolicy {
  private readonly decisions: ReplayDecision[] = [];
  private readonly conflicts: ConflictDecision[] = [];

  /** Record a replay decision for a chain. */
  recordDecision(decision: ReplayDecision): void {
    this.decisions.push(decision);
  }

  /** Record a conflict encountered during event replay. */
  recordConflict(conflict: ConflictDecision): void {
    this.conflicts.push(conflict);
  }

  /** All replay decisions recorded in this run. */
  getDecisions(): ReadonlyArray<ReplayDecision> {
    return this.decisions;
  }

  /** All conflict decisions recorded in this run. */
  getConflicts(): ReadonlyArray<ConflictDecision> {
    return this.conflicts;
  }

  /** Summary counts useful for metrics emission. */
  getSummary(): {
    chains: number;
    totalWindowSize: number;
    lookbackExceededChains: number;
    forcedResyncs: number;
    conflictsByType: Record<ConflictType, number>;
  } {
    const conflictsByType: Record<ConflictType, number> = {
      already_applied: 0,
      status_ahead: 0,
      state_contradiction: 0,
      unknown_order: 0,
    };
    for (const c of this.conflicts) {
      conflictsByType[c.conflictType]++;
    }

    return {
      chains: this.decisions.length,
      totalWindowSize: this.decisions.reduce((sum, d) => sum + d.windowSize, 0),
      lookbackExceededChains: this.decisions.filter((d) => d.lookbackExceeded).length,
      forcedResyncs: this.decisions.filter((d) => d.forcedHistoricalResync).length,
      conflictsByType,
    };
  }

  /** Reset for re-use across runs. */
  reset(): void {
    this.decisions.length = 0;
    this.conflicts.length = 0;
  }
}
