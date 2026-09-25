import type { Chain } from "../persistence/orders-repo.js";

/** Per-order high-water marks persisted on the `orders` row. */
export interface OrderLedgerCursor {
  lastEthBlock: number | null;
  lastSorobanLedger: number | null;
  lastSolanaSlot: number | null;
}

export interface OrderLedgerCursorSummary extends OrderLedgerCursor {
  publicId: string;
  status: string;
  updatedAt: number;
}

export interface ChainCursorSnapshot {
  chain: Chain;
  position: number;
  updatedAt: number;
}

/** How many Ethereum blocks ~48h covers at ~12s/block. */
export const ETH_LOOKBACK_BLOCKS = 14_400;
/** Soroban ledger lookback (~5s/ledger, 48h). */
export const SOROBAN_LOOKBACK_LEDGERS = 34_560;
/** Solana slot lookback (~400ms/slot, 48h). */
export const SOLANA_LOOKBACK_SLOTS = 432_000;

/**
 * Return true when an on-chain event at `position` was already fully processed
 * for this order according to its per-order cursor.
 */
export function isEventBehindOrderCursor(
  cursor: number | null | undefined,
  position: number
): boolean {
  return cursor != null && cursor > 0 && position > 0 && position <= cursor;
}

/**
 * Compute the lower bound for a chain-wide incremental scan.
 *
 * Uses the persistent chain cursor when the gap to tip is within the lookback
 * window; otherwise falls back to `tip - lookback` so recovery still covers a
 * bounded historical window on first run or after a long outage.
 */
export function computeIncrementalScanStart(
  chainCursor: number,
  tip: number,
  lookback: number
): { from: number; gap: number; usedLookbackFallback: boolean } {
  const gap = Math.max(tip - chainCursor, 0);

  if (chainCursor > 0 && gap <= lookback) {
    return { from: chainCursor, gap, usedLookbackFallback: false };
  }

  return {
    from: Math.max(0, tip - lookback),
    gap,
    usedLookbackFallback: chainCursor === 0 || gap > lookback,
  };
}

/** Pick the per-order cursor field for a given chain. */
export function orderCursorForChain(
  cursors: OrderLedgerCursor,
  chain: Chain
): number | null {
  switch (chain) {
    case "ethereum":
      return cursors.lastEthBlock;
    case "stellar":
      return cursors.lastSorobanLedger;
    case "solana":
      return cursors.lastSolanaSlot;
  }
}

/** Merge an incoming position into a cursor value without regressing. */
export function advanceCursor(current: number | null, incoming: number): number {
  if (incoming <= 0) return current ?? 0;
  return Math.max(current ?? 0, incoming);
}
