import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchWithRetry } from '../lib/fetchWithRetry';

export interface Transaction {
  id: string;
  txHash: string;
  fromNetwork: string;
  toNetwork: string;
  fromToken: string;
  toToken: string;
  amount: string;
  estimatedAmount: string;
  status: 'pending' | 'completed' | 'confirmed' | 'cancelled' | 'failed' | 'refunded' | 'expired' | 'timed_out';
  timestamp: number;
  ethTxHash?: string;
  stellarTxHash?: string;
  ethAddress?: string;
  stellarAddress?: string;
  direction: 'eth-to-xlm' | 'xlm-to-eth';
  onChainOrderId?: string;
  htlcContractAddress?: string;
  htlcContractMode?: 'v1-mainnet-htlc' | 'v2-escrow';
  timelockUnixSeconds?: number;
  amountWei?: string;
  refundTxHash?: string;
  refundNetwork?: 'ethereum' | 'stellar';
  refundedAt?: number;
  autoRefundFailed?: boolean;
  autoRefundError?: string;
  networkMode?: 'mainnet' | 'testnet';
}

interface HistoryCachePayload {
  fetchedAt: number;
  transactions: Transaction[];
}

interface UseTransactionHistoryCacheOptions {
  ethAddress?: string;
  stellarAddress?: string;
  apiBase: string;
  staleMs?: number;
  fetcher?: typeof fetch;
}

interface RefreshOptions {
  force?: boolean;
}

const STORAGE_KEY = 'wafflefinance_transactions_v2';
const HISTORY_CACHE_PREFIX = 'wafflefinance_history_cache_v1';
const DEFAULT_STALE_MS = 60_000;
const MAX_CACHED_TRANSACTIONS = 100;

// Hash patterns that indicate fabricated/demo data, used to filter out legacy entries
// persisted by older builds. New entries can never match these because v2 only stores
// real on-chain hashes returned from the coordinator.
const KNOWN_FAKE_HASHES = new Set([
  '0x1234567890abcdef1234567890abcdef12345678',
  '0xabcdef1234567890abcdef1234567890abcdef12',
  '0x9876543210fedcba9876543210fedcba98765432',
  '0x0000000000000000000000000000000000000000000000000000000000000000',
  '0x0000000000000000000000000000000000000000',
]);

function isRealHash(hash?: string): boolean {
  if (!hash) return true;
  if (KNOWN_FAKE_HASHES.has(hash)) return false;
  if (hash.startsWith('mock_')) return false;
  if (hash.startsWith('placeholder')) return false;
  if (/^0x0+$/.test(hash)) return false;
  return true;
}

function isRealTransaction(tx: Transaction): boolean {
  return isRealHash(tx.txHash) && isRealHash(tx.ethTxHash) && isRealHash(tx.stellarTxHash);
}

function normalizeAddress(address?: string): string {
  return address?.trim().toLowerCase() || '';
}

export function getTransactionHistoryCacheKey(ethAddress?: string, stellarAddress?: string): string {
  const eth = normalizeAddress(ethAddress);
  const stellar = normalizeAddress(stellarAddress);
  return `${HISTORY_CACHE_PREFIX}:${eth || '-'}:${stellar || '-'}`;
}

function parseTransactions(raw: string | null): Transaction[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRealTransaction as (tx: unknown) => tx is Transaction);
  } catch (err) {
    console.warn('Could not parse stored transactions:', err);
    return [];
  }
}

function parseHistoryCache(raw: string | null): HistoryCachePayload | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<HistoryCachePayload>;
    if (!parsed || typeof parsed.fetchedAt !== 'number' || !Array.isArray(parsed.transactions)) {
      return null;
    }

    return {
      fetchedAt: parsed.fetchedAt,
      transactions: parsed.transactions.filter(isRealTransaction),
    };
  } catch (err) {
    console.warn('Could not parse history cache:', err);
    return null;
  }
}

function mergeTransactions(...sources: Transaction[][]): Transaction[] {
  const byId = new Map<string, Transaction>();

  for (const source of sources) {
    for (const tx of source) {
      if (isRealTransaction(tx)) {
        byId.set(tx.id, tx);
      }
    }
  }

  return Array.from(byId.values()).sort((a, b) => b.timestamp - a.timestamp);
}

export function useTransactionHistoryCache({
  ethAddress,
  stellarAddress,
  apiBase,
  staleMs = DEFAULT_STALE_MS,
  fetcher = fetch,
}: UseTransactionHistoryCacheOptions) {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastFetchedAt, setLastFetchedAt] = useState<number | null>(null);
  const inFlightRef = useRef(false);
  const walletCacheKey = useMemo(
    () => getTransactionHistoryCacheKey(ethAddress, stellarAddress),
    [ethAddress, stellarAddress],
  );

  const hasWalletAddress = Boolean(ethAddress || stellarAddress);

  const loadFromStorage = useCallback((): Transaction[] => {
    return parseTransactions(localStorage.getItem(STORAGE_KEY));
  }, []);

  const readWalletCache = useCallback((): HistoryCachePayload | null => {
    return parseHistoryCache(localStorage.getItem(walletCacheKey));
  }, [walletCacheKey]);

  const isCacheStale = useCallback(
    (fetchedAt: number | null): boolean => {
      if (!fetchedAt) return true;
      return Date.now() - fetchedAt >= staleMs;
    },
    [staleMs],
  );

  const writeWalletCache = useCallback(
    (nextTransactions: Transaction[]) => {
      const payload: HistoryCachePayload = {
        fetchedAt: Date.now(),
        transactions: nextTransactions.slice(0, MAX_CACHED_TRANSACTIONS),
      };

      localStorage.setItem(walletCacheKey, JSON.stringify(payload));
      setLastFetchedAt(payload.fetchedAt);
    },
    [walletCacheKey],
  );

  const refreshFromCoordinator = useCallback(
    async ({ force = false }: RefreshOptions = {}) => {
      const cache = readWalletCache();

      if (!hasWalletAddress) {
        const local = loadFromStorage();
        setTransactions(local);
        setLastFetchedAt(null);
        return;
      }

      if (!force && cache && !isCacheStale(cache.fetchedAt)) {
        setTransactions(cache.transactions);
        setLastFetchedAt(cache.fetchedAt);
        return;
      }

      if (inFlightRef.current) return;

      inFlightRef.current = true;
      const hasImmediateRows = Boolean(cache?.transactions.length || transactions.length);
      setIsLoading(!hasImmediateRows);
      setIsRefreshing(hasImmediateRows);

      try {
        const params = new URLSearchParams();
        if (ethAddress) params.set('eth', ethAddress);
        if (stellarAddress) params.set('stellar', stellarAddress);

        const res = await fetchWithRetry(`${apiBase}/api/orders/history?${params.toString()}`, {
          maxRetries: 2,
          retryDelayMs: 1000,
          fetcher,
        });
        if (!res.ok) throw new Error(`Coordinator returned ${res.status}`);

        const body = await res.json();
        const remote: Transaction[] = Array.isArray(body?.transactions)
          ? body.transactions.filter(isRealTransaction)
          : [];
        const merged = mergeTransactions(loadFromStorage(), remote);

        localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
        writeWalletCache(merged);
        setTransactions(merged);
      } catch (err) {
        console.warn('Coordinator history unavailable, falling back to local cache:', err);
        setTransactions(cache?.transactions ?? loadFromStorage());
        setLastFetchedAt(cache?.fetchedAt ?? null);
      } finally {
        inFlightRef.current = false;
        setIsLoading(false);
        setIsRefreshing(false);
      }
    },
    [
      apiBase,
      ethAddress,
      fetcher,
      hasWalletAddress,
      isCacheStale,
      loadFromStorage,
      readWalletCache,
      stellarAddress,
      transactions.length,
      writeWalletCache,
    ],
  );

  const updateTransactions = useCallback(
    (updater: (previous: Transaction[]) => Transaction[]) => {
      setTransactions((previous) => {
        const next = updater(previous);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));

        if (hasWalletAddress) {
          writeWalletCache(next);
        }

        return next;
      });
    },
    [hasWalletAddress, writeWalletCache],
  );

  useEffect(() => {
    const cache = readWalletCache();
    const immediate = hasWalletAddress ? cache?.transactions ?? loadFromStorage() : loadFromStorage();

    setTransactions(immediate);
    setLastFetchedAt(cache?.fetchedAt ?? null);

    if (hasWalletAddress) {
      void refreshFromCoordinator({ force: !cache || isCacheStale(cache.fetchedAt) });
    }
  }, [hasWalletAddress, isCacheStale, loadFromStorage, readWalletCache, refreshFromCoordinator]);

  useEffect(() => {
    if (!hasWalletAddress) return;

    const refreshIfStale = () => {
      const cache = readWalletCache();
      if (!cache || isCacheStale(cache.fetchedAt)) {
        void refreshFromCoordinator({ force: true });
      }
    };

    window.addEventListener('focus', refreshIfStale);
    const intervalId = window.setInterval(refreshIfStale, staleMs);

    return () => {
      window.removeEventListener('focus', refreshIfStale);
      window.clearInterval(intervalId);
    };
  }, [hasWalletAddress, isCacheStale, readWalletCache, refreshFromCoordinator, staleMs]);

  return {
    transactions,
    isLoading,
    isRefreshing,
    isStale: isCacheStale(lastFetchedAt),
    refreshFromCoordinator: () => refreshFromCoordinator({ force: true }),
    updateTransactions,
    loadFromStorage,
  };
}
