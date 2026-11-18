/**
 * Recovery replay summary — pure module tests.
 *
 * Issue 49 (listener recovery after partial outage): the operator-facing
 * recovery report must make the replay window and recovery path unambiguous.
 * These tests pin:
 *   1. outcome classification (up to date / within lookback / exceeded /
 *      forced re-sync),
 *   2. the overall verdict aggregation,
 *   3. the lookback windows matching the documented values, and
 *   4. the human-readable formatting.
 */

import { describe, it, expect } from "vitest";
import {
  buildRecoveryReport,
  aggregateRecoveryOverall,
  formatRecoveryReport,
  LISTENER_LOOKBACKS,
  RECONCILER_LOOKBACKS,
  type ChainRecoverySummary,
} from "../src/reconciliation/recovery-summary.js";
import {
  ETH_LOOKBACK_BLOCKS,
  SOROBAN_LOOKBACK_LEDGERS,
  SOLANA_LOOKBACK_SLOTS,
} from "../src/reconciliation/ledger-cursor.js";
import { FORCED_RESYNC_MULTIPLIER } from "../src/reconciliation/replay-policy.js";

const ETH_LOOKBACK = RECONCILER_LOOKBACKS.ethereum;

describe("buildRecoveryReport — outcome classification", () => {
  it("flags a chain as up_to_date when the gap is zero", () => {
    const report = buildRecoveryReport([
      { chain: "ethereum", hwm: 1_000, tip: 1_000, fromBlock: 1_000 },
    ]);
    const [row] = report.chainSummaries;
    expect(row.outcome).toBe("up_to_date");
    expect(row.gap).toBe(0);
    expect(row.windowSize).toBe(0);
  });

  it("flags a normal catch-up gap as within_lookback", () => {
    const report = buildRecoveryReport([
      { chain: "ethereum", hwm: 1_000, tip: 1_200, fromBlock: 1_000 },
    ]);
    const [row] = report.chainSummaries;
    expect(row.outcome).toBe("within_lookback");
    expect(row.gap).toBe(200);
    expect(row.windowSize).toBe(200);
    expect(row.lookbackExceeded).toBe(false);
    expect(row.forcedHistoricalResync).toBe(false);
  });

  it("flags a gap past the lookback as lookback_exceeded with a clamped window", () => {
    const tip = 1_000 + ETH_LOOKBACK + 500;
    const report = buildRecoveryReport([
      {
        chain: "ethereum",
        hwm: 1_000,
        tip,
        fromBlock: tip - ETH_LOOKBACK, // reconciler fell back to tip - lookback
      },
    ]);
    const [row] = report.chainSummaries;
    expect(row.outcome).toBe("lookback_exceeded");
    expect(row.lookback).toBe(ETH_LOOKBACK);
    expect(row.lookbackExceeded).toBe(true);
    // Window scanned is bounded by the lookback even though the gap is bigger.
    expect(row.windowSize).toBe(ETH_LOOKBACK);
    expect(row.gap).toBe(ETH_LOOKBACK + 500);
  });

  it("flags a gap over 3× lookback as forced_resync", () => {
    const lookback = ETH_LOOKBACK;
    const hwm = 1_000;
    const tip = hwm + FORCED_RESYNC_MULTIPLIER * lookback + 10_000;
    const report = buildRecoveryReport([
      { chain: "ethereum", hwm, tip, fromBlock: tip - lookback },
    ]);
    const [row] = report.chainSummaries;
    expect(row.outcome).toBe("forced_resync");
    expect(row.forcedHistoricalResync).toBe(true);
  });

  it("honours an explicit lookback override", () => {
    const report = buildRecoveryReport([
      { chain: "ethereum", hwm: 0, tip: 7_000, fromBlock: 2_000, lookback: 5_000 },
    ]);
    const [row] = report.chainSummaries;
    expect(row.lookback).toBe(5_000);
    expect(row.outcome).toBe("lookback_exceeded");
  });
});

describe("aggregateRecoveryOverall", () => {
  const row = (outcome: ChainRecoverySummary["outcome"]): ChainRecoverySummary => ({
    chain: "ethereum",
    outcome,
    hwm: 0,
    tip: 0,
    gap: 0,
    windowSize: 0,
    lookback: ETH_LOOKBACK,
    lookbackExceeded: outcome === "lookback_exceeded" || outcome === "forced_resync",
    forcedHistoricalResync: outcome === "forced_resync",
  });

  it("is healthy when every chain is up to date", () => {
    expect(aggregateRecoveryOverall([row("up_to_date"), row("up_to_date")])).toBe("healthy");
  });

  it("is recovering when some chain is still catching up within its window", () => {
    expect(aggregateRecoveryOverall([row("up_to_date"), row("within_lookback")])).toBe("recovering");
  });

  it("is at risk when any chain exceeded its lookback", () => {
    expect(aggregateRecoveryOverall([row("up_to_date"), row("lookback_exceeded")])).toBe("at_risk");
  });

  it("is intervention_required when any chain forced a historical re-sync", () => {
    expect(aggregateRecoveryOverall([row("within_lookback"), row("forced_resync")])).toBe(
      "intervention_required"
    );
  });
});

describe("lookback window constants", () => {
  it("reconciler lookbacks match the LedgerCursor constants", () => {
    expect(RECONCILER_LOOKBACKS.ethereum).toBe(ETH_LOOKBACK_BLOCKS);
    expect(RECONCILER_LOOKBACKS.stellar).toBe(SOROBAN_LOOKBACK_LEDGERS);
    expect(RECONCILER_LOOKBACKS.solana).toBe(SOLANA_LOOKBACK_SLOTS);
  });

  it("listener lookbacks match the documented startup catch-up windows", () => {
    expect(LISTENER_LOOKBACKS.ethereum).toBe(5_000);
    expect(LISTENER_LOOKBACKS.stellar).toBe(34_560);
    expect(LISTENER_LOOKBACKS.solana).toBe(432_000);
  });
});

describe("formatRecoveryReport", () => {
  it("includes the overall verdict and one line per chain", () => {
    const report = buildRecoveryReport([
      { chain: "ethereum", hwm: 1_000, tip: 1_200, fromBlock: 1_000 },
      { chain: "stellar", hwm: 0, tip: 100, fromBlock: 0 },
    ]);
    const text = formatRecoveryReport(report);
    expect(text).toContain("overall=recovering");
    expect(text).toContain("ethereum");
    expect(text).toContain("stellar");
    expect(text).toContain("→ within_lookback");
  });

  it("renders the recovery window as scanned/lookback", () => {
    const report = buildRecoveryReport([
      { chain: "solana", hwm: 10_000, tip: 10_250, fromBlock: 10_000 },
    ]);
    const text = formatRecoveryReport(report);
    expect(text).toContain("window=250/432,000");
  });
});