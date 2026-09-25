/**
 * Performance benchmark: fixed 48h lookback vs incremental chain-cursor scan.
 *
 * Demonstrates ≥50% RPC reduction when the reconciler resumes from a persisted
 * chain cursor instead of re-scanning the full lookback window every cycle.
 */
import { describe, it, expect } from "vitest";
import {
  computeIncrementalScanStart,
  ETH_LOOKBACK_BLOCKS,
} from "../src/reconciliation/ledger-cursor.js";

/** Approximate eth_getLogs calls per reconciliation run (3 event types). */
const ETH_GET_LOGS_PER_RUN = 3;

function blocksScanned(from: number, tip: number): number {
  return Math.max(tip - from, 0);
}

function estimateRpcCalls(blocks: number): number {
  // One getBlockNumber + getLogs triple per run; cost scales with range width
  // for providers that bill by block span (conservative linear proxy).
  return ETH_GET_LOGS_PER_RUN + Math.ceil(blocks / 2000);
}

describe("reconciler cursor benchmark — RPC reduction", () => {
  const tip = 1_000_000;

  it("fixed lookback rescans ~48h window every run", () => {
    const from = tip - ETH_LOOKBACK_BLOCKS;
    const blocks = blocksScanned(from, tip);
    expect(blocks).toBe(ETH_LOOKBACK_BLOCKS);
  });

  it("incremental cursor scan covers only the gap since last run", () => {
    const chainCursor = tip - 50; // 50 blocks since last 15s poll
    const { from, usedLookbackFallback } = computeIncrementalScanStart(
      chainCursor,
      tip,
      ETH_LOOKBACK_BLOCKS
    );
    expect(usedLookbackFallback).toBe(false);
    expect(from).toBe(chainCursor);
    expect(blocksScanned(from, tip)).toBe(50);
  });

  it("incremental mode reduces estimated RPC cost by ≥50% after steady state", () => {
    const lookbackFrom = tip - ETH_LOOKBACK_BLOCKS;
    const lookbackBlocks = blocksScanned(lookbackFrom, tip);
    const lookbackRpc = estimateRpcCalls(lookbackBlocks);

    const chainCursor = tip - 100;
    const incremental = computeIncrementalScanStart(chainCursor, tip, ETH_LOOKBACK_BLOCKS);
    const incrementalBlocks = blocksScanned(incremental.from, tip);
    const incrementalRpc = estimateRpcCalls(incrementalBlocks);

    const reduction = 1 - incrementalRpc / lookbackRpc;
    expect(reduction).toBeGreaterThanOrEqual(0.5);
  });

  it("second reconciliation run after cursor persist is near-zero block span", () => {
    const afterFirstRun = computeIncrementalScanStart(tip, tip, ETH_LOOKBACK_BLOCKS);
    expect(afterFirstRun.from).toBe(tip);
    expect(blocksScanned(afterFirstRun.from, tip)).toBe(0);
  });
});
