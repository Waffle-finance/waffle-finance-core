/**
 * Recovery replay summary — operator-facing view of missed-event recovery.
 *
 * Issue 49 (listener recovery after partial outage): the reconciler already
 * replays missed events deterministically (seeded cursors, bounded windows,
 * forced-resync classification), but operators had to reconstruct "what will
 * the reconciler scan, and how far behind are we?" by correlating several
 * per-chain log lines. This module is the single, pure place that turns one
 * reconciler run into a per-chain recovery report with an overall verdict, so
 * the startup and per-run logs are self-explanatory.
 *
 * All of it is pure: given the persisted cursor HWM, the chain tip, and the
 * replay start, it derives the window actually scanned, whether the window
 * was exceeded (potential silent loss), and whether the gap was severe enough
 * to force a historical re-sync.
 */

import type { Chain } from "../persistence/orders-repo.js";
import {
  ETH_LOOKBACK_BLOCKS,
  SOROBAN_LOOKBACK_LEDGERS,
  SOLANA_LOOKBACK_SLOTS,
} from "./ledger-cursor.js";
import { FORCED_RESYNC_MULTIPLIER } from "./replay-policy.js";

/**
 * Listener startup catch-up windows (EVENT_RECONCILIATION.md).
 * Ethereum's listener uses a shorter window than the reconciler.
 */
export const LISTENER_LOOKBACKS: Record<Chain, number> = {
  ethereum: 5_000,
  stellar: 34_560,
  solana: 432_000,
};

/**
 * The reconciler's authoritative recovery windows — the 48 h replay window
 * used to derive `fromBlock` on every run (matches LedgerCursor init).
 */
export const RECONCILER_LOOKBACKS: Record<Chain, number> = {
  ethereum: ETH_LOOKBACK_BLOCKS,
  stellar: SOROBAN_LOOKBACK_LEDGERS,
  solana: SOLANA_LOOKBACK_SLOTS,
};

/** Per-chain recovery verdict for one reconciler run. */
export type RecoveryOutcome =
  | "up_to_date"
  | "within_lookback"
  | "lookback_exceeded"
  | "forced_resync";

/** Aggregate verdict across all chains for a run. */
export type RecoveryOverall =
  | "healthy"
  | "recovering"
  | "at_risk"
  | "intervention_required";

/** Per-chain row in a recovery report. */
export interface ChainRecoverySummary {
  chain: Chain;
  outcome: RecoveryOutcome;
  /** Persisted cursor high-water mark at the start of this run. */
  hwm: number;
  /** Current chain tip at the time of the assessment. */
  tip: number;
  /** Cursor HWM → tip distance (clamped to ≥ 0). */
  gap: number;
  /** Blocks/ledgers/slots actually scanned this run. */
  windowSize: number;
  /** The 48 h replay window configured for this chain. */
  lookback: number;
  /** True when `gap` exceeded the lookback and `fromBlock` was clamped. */
  lookbackExceeded: boolean;
  /** True when `gap` exceeded FORCED_RESYNC_MULTIPLIER × lookback. */
  forcedHistoricalResync: boolean;
}

export interface RecoveryReport {
  chainSummaries: ChainRecoverySummary[];
  overall: RecoveryOverall;
}

/** Minimal per-chain inputs a caller must supply to build a report. */
export interface ChainRecoveryInput {
  chain: Chain;
  /** Persisted cursor HWM at the start of the run. */
  hwm: number;
  /** Chain tip at assessment time. */
  tip: number;
  /** Block/ledger/slot the reconciler actually started scanning from. */
  fromBlock: number;
  /** Override the reconciler lookback (used by tests / listener windows). */
  lookback?: number;
}

/**
 * Build a recovery report from one run's per-chain observations.
 *
 * `fromBlock` is the reconciler's *effective* start (already clamped to
 * `tip - lookback` when the gap exceeded the window), so the window actually
 * scanned is `tip - fromBlock` even after a fallback.
 */
export function buildRecoveryReport(inputs: ChainRecoveryInput[]): RecoveryReport {
  const chainSummaries: ChainRecoverySummary[] = inputs.map((input) => {
    const lookback = input.lookback ?? RECONCILER_LOOKBACKS[input.chain];
    const gap = Math.max(input.tip - input.hwm, 0);
    const windowSize = Math.max(input.tip - input.fromBlock, 0);
    const lookbackExceeded = gap > lookback;
    const forcedHistoricalResync = gap > FORCED_RESYNC_MULTIPLIER * lookback;

    let outcome: RecoveryOutcome;
    if (forcedHistoricalResync) outcome = "forced_resync";
    else if (lookbackExceeded) outcome = "lookback_exceeded";
    else if (gap > 0) outcome = "within_lookback";
    else outcome = "up_to_date";

    return {
      chain: input.chain,
      outcome,
      hwm: input.hwm,
      tip: input.tip,
      gap,
      windowSize,
      lookback,
      lookbackExceeded,
      forcedHistoricalResync,
    };
  });

  const overall = aggregateRecoveryOverall(chainSummaries);
  return { chainSummaries, overall };
}

/** Aggregate the per-chain verdicts into one operator-facing overall check. */
export function aggregateRecoveryOverall(
  chainSummaries: ChainRecoverySummary[]
): RecoveryOverall {
  if (chainSummaries.some((c) => c.forcedHistoricalResync)) {
    return "intervention_required";
  }
  if (chainSummaries.some((c) => c.lookbackExceeded)) {
    return "at_risk";
  }
  if (chainSummaries.some((c) => c.outcome === "within_lookback")) {
    return "recovering";
  }
  return "healthy";
}

const numberFormatter = new Intl.NumberFormat("en-US");

/** Format a single number with thousands separators. */
function fmt(n: number): string {
  return numberFormatter.format(n);
}

/**
 * Render a report as an operator-readable block for logs.
 *
 * Example:
 *
 *   recovery replay summary — overall=recovering
 *     ethereum   hwm=1,234,500 tip=1,234,700 gap=200 window=200/14,400 → within_lookback
 *     stellar    hwm=100      tip=1,240,000 gap=big  window=34,560/34,560 → lookback_exceeded
 */
export function formatRecoveryReport(report: RecoveryReport): string {
  const lines = [`recovery replay summary — overall=${report.overall}`];
  for (const row of report.chainSummaries) {
    lines.push(
      `  ${row.chain.padEnd(10)} hwm=${fmt(row.hwm)} tip=${fmt(row.tip)} ` +
        `gap=${fmt(row.gap)} window=${fmt(row.windowSize)}/${fmt(row.lookback)} → ${row.outcome}`
    );
  }
  return lines.join("\n");
}