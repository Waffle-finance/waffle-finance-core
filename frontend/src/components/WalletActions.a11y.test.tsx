// @vitest-environment jsdom

/**
 * Accessible names for wallet and transaction actions — issue #960
 *
 * Icon-adjacent controls must expose concise accessible names so assistive
 * tech and automated tests can identify them. Labels stay unique where
 * multiple actions appear in a row (per-order refund labels).
 */

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, vi } from 'vitest';
import type { Transaction } from '../hooks/useTransactionHistoryCache';
import NetworkMismatchBanner from './NetworkMismatchBanner';
import WalletStateBanner from './WalletStateBanner';
import type { NetworkModeState } from '../lib/useNetworkMode';

vi.mock('../config/networks', () => ({
  isTestnet: () => true,
}));

vi.mock('../features/refund/RefundDialog', () => ({
  default: () => null,
}));

const cacheState: {
  transactions: Transaction[];
  isLoading: boolean;
  isRefreshing: boolean;
  isStale: boolean;
  refreshFromCoordinator: ReturnType<typeof vi.fn>;
  updateTransactions: ReturnType<typeof vi.fn>;
  streamError: null;
  streamFailures: number;
} = {
  transactions: [],
  isLoading: false,
  isRefreshing: false,
  isStale: false,
  refreshFromCoordinator: vi.fn(),
  updateTransactions: vi.fn(),
  streamError: null,
  streamFailures: 0,
};

vi.mock('../hooks/useTransactionHistoryCache', () => ({
  useTransactionHistoryCache: () => cacheState,
}));

const { default: TransactionHistory } = await import('./TransactionHistory');

function makeNetworkState(overrides: Partial<NetworkModeState> = {}): NetworkModeState {
  return {
    mode: 'testnet',
    expectedEthChainIdHex: '0xaa36a7',
    expectedStellarPassphrase: 'Test SDF Network ; September 2015',
    metamaskChainId: '0x1',
    metamaskConnected: true,
    metamaskMatches: false,
    freighterNetworkPassphrase: null,
    freighterConnected: false,
    freighterMatches: true,
    hasAnyMismatch: true,
    setMode: vi.fn().mockResolvedValue({ ok: true }),
    syncWalletsToAppMode: vi.fn().mockResolvedValue({ ok: true }),
    refreshWalletNetworks: vi.fn(),
    ...overrides,
  };
}

function makeTransaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 'order-1',
    txHash: '0xrealhash',
    fromNetwork: 'ETH Sepolia',
    toNetwork: 'Stellar Testnet',
    fromToken: 'ETH',
    toToken: 'XLM',
    amount: '0.5',
    estimatedAmount: '5000',
    status: 'pending',
    timestamp: Date.now(),
    direction: 'eth-to-xlm',
    onChainOrderId: 'order-1',
    htlcContractAddress: '0x1234567890123456789012345678901234567890',
    timelockUnixSeconds: Math.floor(Date.now() / 1000) - 100,
    ...overrides,
  } as Transaction;
}

describe('wallet and transaction action accessible names', () => {
  beforeEach(() => {
    cacheState.transactions = [];
  });

  it('network mismatch recovery buttons expose action names', () => {
    render(<NetworkMismatchBanner networkState={makeNetworkState()} />);
    expect(
      screen.getByRole('button', { name: 'Switch wallet to Testnet' }),
    ).toBeInTheDocument();
  });

  it('wallet state action button exposes its action label as its name', () => {
    render(
      <WalletStateBanner
        walletState={{
          banners: [
            {
              id: 'eth-mismatch',
              wallet: 'ethereum',
              kind: 'chain_mismatch',
              message: 'MetaMask is on the wrong network.',
              hint: 'Switch MetaMask and try again.',
              onAction: vi.fn(),
              actionLabel: 'Switch to Sepolia',
            },
          ],
          isBlocked: true,
          dismiss: vi.fn(),
        }}
      />,
    );
    expect(
      screen.getByRole('button', { name: 'Switch to Sepolia' }),
    ).toBeInTheDocument();
    // Dismiss control keeps its existing accessible name.
    expect(
      screen.getByRole('button', { name: 'Dismiss notification' }),
    ).toBeInTheDocument();
  });

  it('transaction history refresh, filter, and refund controls have names', () => {
    cacheState.transactions = [
      makeTransaction({ id: 'order-1', txHash: '0xaaa' }),
      makeTransaction({ id: 'order-2', txHash: '0xbbb' }),
    ];
    render(<TransactionHistory ethAddress="0xabc" />);

    expect(
      screen.getByRole('button', { name: 'Refresh transaction history' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Filter transactions by pending' }),
    ).toBeInTheDocument();
    // Per-order labels stay unique when multiple refund actions appear in a row.
    expect(
      screen.getByRole('button', { name: 'Refund ETH for order order-1' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Refund ETH for order order-2' }),
    ).toBeInTheDocument();
  });
});
