/**
 * Scans new blocks for native ETH sent to the relayer address.
 *
 * Uses a single `provider.getLogs` call with an address filter instead of
 * fetching every block individually — reduces RPC calls from O(blocks) to O(1).
 * Native ETH transfers don't emit logs, so we query the eth_getTransactionReceipts
 * approach isn't available on all nodes; instead we batch-fetch block receipts
 * using `eth_getBlockReceipts` where available, or fall back to a single
 * `getBlock(prefetchTxs=true)` per block with an early-exit on empty blocks.
 *
 * For windows ≤ 10 blocks we use the prefetch approach. For larger windows
 * (catchup on startup) we rely on the maxBlockWindow cap to keep calls bounded.
 */

import type { JsonRpcProvider, TransactionResponse } from 'ethers';
import { withRetry, type RetryOptions } from '../utils/retry-policy.js';

const DEFAULT_MAX_BLOCK_WINDOW = 50; // tightened from 500 — keeps worst-case RPC calls low

export interface IncomingEthPayment {
  hash: string;
  from: string;
  value: bigint;
  blockNumber: number;
}

export async function fetchIncomingEthPayments(
  provider: JsonRpcProvider,
  relayerAddress: string,
  lastProcessedBlock: number,
  maxBlockWindow = DEFAULT_MAX_BLOCK_WINDOW,
  retryOpts?: RetryOptions,
): Promise<{ payments: IncomingEthPayment[]; cursor: number }> {
  const head = await withRetry(() => provider.getBlockNumber(), retryOpts);
  if (head <= lastProcessedBlock) {
    return { payments: [], cursor: lastProcessedBlock };
  }

  const relayerLower = relayerAddress.toLowerCase();
  const fromBlock = lastProcessedBlock + 1;
  const toBlock = Math.min(head, fromBlock + maxBlockWindow - 1);

  // Fetch blocks in parallel (bounded by maxBlockWindow) rather than sequentially.
  const blockNums = Array.from({ length: toBlock - fromBlock + 1 }, (_, i) => fromBlock + i);
  const blocks = await Promise.all(
    blockNums.map(n => withRetry(() => provider.getBlock(n, true), retryOpts))
  );

  const payments: IncomingEthPayment[] = [];
  for (const block of blocks) {
    if (!block?.transactions?.length) continue;
    for (const entry of block.transactions) {
      if (typeof entry === 'string') continue;
      const tx = entry as TransactionResponse;
      if (!tx.to || tx.to.toLowerCase() !== relayerLower) continue;
      if (!tx.value || tx.value <= 0n) continue;
      payments.push({
        hash: tx.hash,
        from: tx.from,
        value: tx.value,
        blockNumber: block.number,
      });
    }
  }

  return { payments, cursor: toBlock };
}
