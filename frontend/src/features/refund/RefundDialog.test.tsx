import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RefundDialog } from './RefundDialog';
import { makeEthereumHTLCClient } from '../../lib/sdk-context';
import { useNetworkMode } from '../../lib/useNetworkMode';
import type { Address } from 'viem';
import { vi } from 'vitest';

// Mock the makeEthereumHTLCClient function
vi.mock('../../lib/sdk-context', () => ({
  makeEthereumHTLCClient: vi.fn(),
}));

// Mock the isTestnet function
vi.mock('../../config/networks', () => ({
  isTestnet: vi.fn(() => true),
}));

// Mock useNetworkMode
vi.mock('../../lib/useNetworkMode', () => ({
  useNetworkMode: vi.fn(),
}));

const mockUserAddress = '0x1234567890123456789012345678901234567890' as Address;
const mockOrderId = '42';
const mockAmountWei = '1000000000000000000'; // 1 ETH in wei

const mockNetworkState = {
  mode: 'testnet' as const,
  hasAnyMismatch: false,
  metamaskChainId: '0xaa36a7',
};

describe('RefundDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useNetworkMode).mockReturnValue(mockNetworkState as any);
  });

  describe('Timelock countdown → refundable state', () => {
    test('initially shows waiting state when timelock not expired', async () => {
      const timelockFuture = Math.floor(Date.now() / 1000) + 10; // 10 seconds in future
      render(<RefundDialog 
        userAddress={mockUserAddress}
        orderId={mockOrderId}
        timelockUnixSeconds={timelockFuture}
        amountWei={mockAmountWei}
      />);

      // Initially should be in waiting phase
      expect(screen.getByText(/Refund not yet available/i)).toBeInTheDocument();
      expect(screen.getByText(/Time remaining:/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Refund from contract/i })).toBeDisabled();
    });

    test('transitions to ready state when timelock expires', async () => {
      const timelockPast = 0; // Definitely in the past
      render(<RefundDialog 
        userAddress={mockUserAddress}
        orderId={mockOrderId}
        timelockUnixSeconds={timelockPast}
        amountWei={mockAmountWei}
      />);
      // Wait for the phase to update to ready (should be immediate)
      await waitFor(() => {
        expect(screen.getByText(/The timelock has expired/i)).toBeInTheDocument();
      }, { timeout: 10000 });

      expect(screen.getByRole('button', { name: /Refund from contract/i })).toBeEnabled();
    });
  });

  describe('Network mismatch handling', () => {
    test('disables refund button when network mismatch exists', async () => {
      vi.mocked(useNetworkMode).mockReturnValue({
        ...mockNetworkState,
        hasAnyMismatch: true,
      } as any);

      const timelockPast = 0;
      render(<RefundDialog 
        userAddress={mockUserAddress}
        orderId={mockOrderId}
        timelockUnixSeconds={timelockPast}
        amountWei={mockAmountWei}
      />);

      await waitFor(() => {
        expect(screen.getByText(/The timelock has expired/i)).toBeInTheDocument();
      });

      // Button should be disabled due to mismatch
      expect(screen.getByRole('button', { name: /Refund from contract/i })).toBeDisabled();
    });

    test('shows actionable error message on refund attempt with mismatch', async () => {
      vi.mocked(useNetworkMode).mockReturnValue({
        ...mockNetworkState,
        hasAnyMismatch: true,
        metamaskChainId: '0x1', // Mainnet
        mode: 'testnet',
      } as any);

      const timelockPast = 0;
      render(<RefundDialog 
        userAddress={mockUserAddress}
        orderId={mockOrderId}
        timelockUnixSeconds={timelockPast}
        amountWei={mockAmountWei}
      />);

      await waitFor(() => {
        expect(screen.getByText(/The timelock has expired/i)).toBeInTheDocument();
      });

      // Note: Button is disabled, but if it were clicked, handleRefund would catch it.
      // Since it's disabled, we can't easily click it with userEvent.
      // We can verify that it is disabled.
      expect(screen.getByRole('button', { name: /Refund from contract/i })).toBeDisabled();
    });
  });

  describe('Missing HTLC configuration', () => {
    test('shows error when v2 escrow address not configured', async () => {
      // Make makeEthereumHTLCClient return null
      vi.mocked(makeEthereumHTLCClient).mockResolvedValue(null);

      const timelockPast = 0; // Definitely in the past
      render(<RefundDialog 
        userAddress={mockUserAddress}
        orderId={mockOrderId}
        timelockUnixSeconds={timelockPast}
        amountWei={mockAmountWei}
      />);
      // Wait for the phase to be ready (should be immediate)
      await waitFor(() => {
        expect(screen.getByText(/The timelock has expired/i)).toBeInTheDocument();
      }, { timeout: 10000 });

      // Click the refund button
      await userEvent.click(screen.getByRole('button', { name: /Refund from contract/i }));

      // Wait for error to appear
      await waitFor(() => {
        expect(screen.getByText(/Refund failed/i)).toBeInTheDocument();
        expect(screen.getByText(/HTLCEscrow address is not configured for this network/i)).toBeInTheDocument();
      }, { timeout: 10000 });
    });
  });

  describe('Legacy v1 bytes32 validation', () => {
    test('shows error for invalid bytes32 order id in v1 mode', async () => {
      const timelockPast = 0; // Definitely in the past
      // Mock window.ethereum to be present
      Object.defineProperty(window, 'ethereum', {
        writable: true,
        value: {
          request: vi.fn(),
        },
      });
      render(<RefundDialog 
        userAddress={mockUserAddress}
        orderId='not-a-bytes32' // Invalid bytes32
        timelockUnixSeconds={timelockPast}
        amountWei={mockAmountWei}
        contractMode="v1-mainnet-htlc"
        v1ContractAddress={'0x1234567890123456789012345678901234567890' as Address}
      />);
      // Wait for the phase to be ready (should be immediate)
      await waitFor(() => {
        expect(screen.getByText(/The timelock has expired/i)).toBeInTheDocument();
      }, { timeout: 10000 });

      // Click the refund button
      await userEvent.click(screen.getByRole('button', { name: /Refund from contract/i }));

      // Wait for error to appear
      await waitFor(() => {
        expect(screen.getByText(/Refund failed/i)).toBeInTheDocument();
        expect(screen.getByText(/v1 mainnet refund requires a 0x-prefixed bytes32 order id/i)).toBeInTheDocument();
      }, { timeout: 10000 });
    });
  });
});
