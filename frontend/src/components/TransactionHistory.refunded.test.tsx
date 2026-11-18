// @vitest-environment jsdom

/**
 * Refunded-order tests for the transaction history UI (#962).
 *
 * A refunded order is terminal: the history must show the Refunded status
 * and must not offer any claim action. Refund details render safely whether
 * the optional transaction metadata (refund hash) is present or absent.
 */

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { Transaction } from '../hooks/useTransactionHistoryCache';
import { presentOrderStatus } from '../lib/orderStatusPresentation';

vi.mock('../config/networks', () => ({
  isTestnet: () => true,
}));

vi.mock('../features/refund/RefundDialog', () => ({
  default: () => null,
}));

const cacheState = {
  transactions: [] as Transaction[],
  isLoading: false,
  isRefreshing: false,
  isStale: false,
  refreshFromCoordinator: vi.fn(),
  updateTransactions: vi.fn(),
  loadFromStorage: vi.fn(() => [] as Transaction[]),
  streamError: null,
  streamFailures: 0,
  streamPhase: 'active' as const,
};

vi.mock('../hooks/useTransactionHistoryCache', () => ({
  useTransactionHistoryCache: () => cacheState,
}));

// Imported dynamically so `cacheState` is initialised before the hoisted
// `vi.mock` factory above closes over it.
const { default: TransactionHistory } = await import('./TransactionHistory');

function makeRefundedTransaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 'order-refunded-1',
    txHash: '0xrealhash000000000000000000000000000000000001',
    fromNetwork: 'ETH Sepolia',
    toNetwork: 'Stellar Testnet',
    fromToken: 'ETH',
    toToken: 'XLM',
    amount: '0.5',
    estimatedAmount: '5000',
    status: 'refunded',
    timestamp: Date.now(),
    direction: 'eth-to-xlm',
    refundedAt: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  cacheState.transactions = [];
  cacheState.isLoading = false;
  cacheState.isRefreshing = false;
  cacheState.isStale = false;
  cacheState.streamError = null;
  cacheState.streamFailures = 0;
});

describe('TransactionHistory — refunded orders', () => {
  test('identifies the refunded state with the Refunded status label', () => {
    cacheState.transactions = [makeRefundedTransaction()];

    render(<TransactionHistory ethAddress="0xabc" />);

    // Visually and accessibly identified: the badge text is in the document.
    expect(screen.getByText('Refunded')).toBeInTheDocument();
    // The presentation layer marks refunded as terminal.
    expect(presentOrderStatus('refunded').isTerminal).toBe(true);
  });

  test('offers no claim action after refund', () => {
    cacheState.transactions = [makeRefundedTransaction()];

    render(<TransactionHistory ethAddress="0xabc" />);

    expect(screen.queryByText(/Refund ETH/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Refund XLM/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Refunding\.\.\./i)).not.toBeInTheDocument();
  });

  test('renders safely when the refund transaction hash is absent', () => {
    cacheState.transactions = [makeRefundedTransaction({ refundTxHash: undefined })];

    render(<TransactionHistory ethAddress="0xabc" />);

    // Row still renders with its status; no refund explorer link is shown.
    expect(screen.getByText('Refunded')).toBeInTheDocument();
    expect(screen.queryByText(/view on/i)).not.toBeInTheDocument();
  });

  test('renders refund details when the refund transaction hash is present', () => {
    cacheState.transactions = [
      makeRefundedTransaction({
        refundTxHash: '0xrefundhash00000000000000000000000000000002',
        refundNetwork: 'ethereum',
      }),
    ];

    render(<TransactionHistory ethAddress="0xabc" />);

    expect(screen.getByText('Refunded')).toBeInTheDocument();
    const link = screen.getByText(/view on/i).closest('a');
    expect(link).not.toBeNull();
    expect(link!.getAttribute('href')).toContain('0xrefundhash');
    // Still no claim action alongside the refund details.
    expect(screen.queryByText(/Refund ETH/i)).not.toBeInTheDocument();
  });
});
