// @vitest-environment jsdom

/**
 * Stale order cache invalidation — issue #963.
 *
 * A terminal order must not remain displayed as pending because of a stale
 * cache entry. This pins the smallest affected data hook
 * (`useTransactionHistoryCache`): a pending row followed by a terminal
 * refresh response must update the visible status without a full-page reload,
 * while unrelated order entries stay intact.
 */

import { renderHook, waitFor, act } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, test, vi } from 'vitest';
import { createOrderEventChannel } from '../lib/orderEventStream';
import {
  getTransactionHistoryCacheKey,
  useTransactionHistoryCache,
  type Transaction,
} from './useTransactionHistoryCache';

const now = new Date('2026-06-21T00:00:00Z').getTime();

function makeTransaction(id: string, status: Transaction['status'] = 'pending'): Transaction {
  return {
    id,
    txHash: `0x${id}`,
    fromNetwork: 'Ethereum',
    toNetwork: 'Stellar',
    fromToken: 'ETH',
    toToken: 'XLM',
    amount: '1',
    estimatedAmount: '100',
    status,
    timestamp: now,
    direction: 'eth-to-xlm',
  };
}

function responseWith(transactions: Transaction[]): Response {
  return {
    ok: true,
    json: async () => ({ transactions }),
  } as Response;
}

describe('useTransactionHistoryCache — stale terminal invalidation (#963)', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  test('terminal refresh replaces stale pending status without a full-page reload', async () => {
    const stalePending = makeTransaction('order-1', 'pending');
    const unrelated = makeTransaction('order-2', 'pending');

    // Deterministic mock: seeded wallet cache is stale, coordinator returns
    // the terminal state for order-1 only.
    const staleAt = now - 120_000;
    localStorage.setItem(
      getTransactionHistoryCacheKey('0xabc', undefined),
      JSON.stringify({ fetchedAt: staleAt, transactions: [stalePending, unrelated] }),
    );

    const terminal = { ...stalePending, status: 'refunded' as const };
    const fetcher = vi.fn(async () => responseWith([terminal, unrelated])) as unknown as typeof fetch;
    const liveChannel = createOrderEventChannel();

    const { result } = renderHook(() =>
      useTransactionHistoryCache({
        ethAddress: '0xabc',
        apiBase: 'https://coordinator.example',
        staleMs: 60_000,
        fetcher,
        liveChannel,
      }),
    );

    // Stale pending rows render first from cache.
    await waitFor(() => expect(result.current.transactions).toHaveLength(2));
    expect(result.current.transactions.find((tx) => tx.id === 'order-1')?.status).toBe('pending');

    // The stale cache triggers exactly one deterministic background refresh.
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    // No full-page reload: the same hook instance reports the terminal status.
    await waitFor(() =>
      expect(result.current.transactions.find((tx) => tx.id === 'order-1')?.status).toBe('refunded'),
    );

    // Unrelated order cache entries remain intact.
    const other = result.current.transactions.find((tx) => tx.id === 'order-2');
    expect(other).toMatchObject({ id: 'order-2', status: 'pending' });
  });

  test('manual refresh picks up a terminal claim update for a cached pending order', async () => {
    const stalePending = makeTransaction('order-9', 'pending');
    localStorage.setItem(
      getTransactionHistoryCacheKey('0xabc', undefined),
      JSON.stringify({ fetchedAt: now, transactions: [stalePending] }),
    );

    const claimed = { ...stalePending, status: 'completed' as const };
    const fetcher = vi.fn(async () => responseWith([claimed])) as unknown as typeof fetch;
    const liveChannel = createOrderEventChannel();

    const { result } = renderHook(() =>
      useTransactionHistoryCache({
        ethAddress: '0xabc',
        apiBase: 'https://coordinator.example',
        staleMs: 60_000,
        fetcher,
        liveChannel,
      }),
    );

    await waitFor(() => expect(result.current.transactions).toHaveLength(1));
    expect(result.current.transactions[0]?.status).toBe('pending');

    // Deterministic mock refresh carrying the terminal claim update.
    await act(async () => {
      await result.current.refreshFromCoordinator();
    });

    await waitFor(() =>
      expect(result.current.transactions.find((tx) => tx.id === 'order-9')?.status).toBe('completed'),
    );
    expect(fetcher).toHaveBeenCalled();
  });
});
