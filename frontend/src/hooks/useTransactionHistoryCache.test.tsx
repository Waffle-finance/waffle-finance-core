// @vitest-environment jsdom

import { renderHook, waitFor, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  getTransactionHistoryCacheKey,
  useTransactionHistoryCache,
  type Transaction,
} from './useTransactionHistoryCache';

const now = new Date('2026-06-21T00:00:00Z').getTime();

function makeTransaction(id: string, timestamp = now): Transaction {
  return {
    id,
    txHash: `0x${id}`,
    fromNetwork: 'Ethereum',
    toNetwork: 'Stellar',
    fromToken: 'ETH',
    toToken: 'XLM',
    amount: '1',
    estimatedAmount: '100',
    status: 'completed',
    timestamp,
    direction: 'eth-to-xlm',
  };
}

function writeWalletCache(
  ethAddress: string | undefined,
  stellarAddress: string | undefined,
  fetchedAt: number,
  transactions: Transaction[],
) {
  localStorage.setItem(
    getTransactionHistoryCacheKey(ethAddress, stellarAddress),
    JSON.stringify({ fetchedAt, transactions }),
  );
}

function responseWith(transactions: Transaction[]): Response {
  return {
    ok: true,
    json: async () => ({ transactions }),
  } as Response;
}

describe.skip('useTransactionHistoryCache', () => {
  let currentTime = now;

  beforeEach(() => {
    currentTime = now;
    vi.spyOn(Date, 'now').mockImplementation(() => currentTime);
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  test('serves stale cached history immediately while refreshing in the background', async () => {
    const cached = makeTransaction('cached', now - 10);
    const remote = makeTransaction('remote', now + 10);
    let resolveFetch: (response: Response) => void = () => {};
    const fetcher = vi.fn(
      () => new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    ) as unknown as typeof fetch;

    writeWalletCache('0xabc', undefined, now - 10_000, [cached]);

    const { result } = renderHook(() =>
      useTransactionHistoryCache({
        ethAddress: '0xabc',
        apiBase: 'https://coordinator.example',
        staleMs: 1_000,
        fetcher,
      }),
    );

    await waitFor(() => {
      expect(result.current.transactions.map((tx) => tx.id)).toEqual(['cached']);
    });
    expect(result.current.isRefreshing).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFetch(responseWith([remote]));
    });

    await waitFor(() => {
      expect(result.current.transactions.map((tx) => tx.id)).toEqual(['remote']);
    });
    expect(result.current.isRefreshing).toBe(false);
  });

  test('skips coordinator fetches while wallet cache is still fresh', async () => {
    const cached = makeTransaction('cached');
    const fetcher = vi.fn(async () => responseWith([])) as unknown as typeof fetch;

    writeWalletCache('0xabc', 'GABC', now, [cached]);

    const { result } = renderHook(() =>
      useTransactionHistoryCache({
        ethAddress: '0xABC',
        stellarAddress: 'GABC',
        apiBase: 'https://coordinator.example',
        staleMs: 60_000,
        fetcher,
      }),
    );

    await waitFor(() => {
      expect(result.current.transactions.map((tx) => tx.id)).toEqual(['cached']);
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  test('refreshes on window focus after the cache turns stale', async () => {
    const cached = makeTransaction('cached');
    const remote = makeTransaction('remote', now + 100);
    const fetcher = vi.fn(async () => responseWith([remote])) as unknown as typeof fetch;

    writeWalletCache('0xabc', undefined, now, [cached]);

    const { result } = renderHook(() =>
      useTransactionHistoryCache({
        ethAddress: '0xabc',
        apiBase: 'https://coordinator.example',
        staleMs: 1_000,
        fetcher,
      }),
    );

    await waitFor(() => {
      expect(result.current.transactions.map((tx) => tx.id)).toEqual(['cached']);
    });
    expect(fetcher).not.toHaveBeenCalled();

    currentTime = now + 1_001;

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });

    await waitFor(() => {
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(result.current.transactions.map((tx) => tx.id)).toEqual(['remote']);
    });
  });
});
