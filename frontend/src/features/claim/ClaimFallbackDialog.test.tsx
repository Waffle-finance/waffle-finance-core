import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { Address } from 'viem';
import { ClaimFallbackDialog } from './ClaimFallbackDialog';
import { makeEthereumHTLCClient } from '../../lib/sdk-context';
import { useNetworkMode } from '../../lib/useNetworkMode';

vi.mock('../../lib/sdk-context', () => ({
  makeEthereumHTLCClient: vi.fn(),
}));

vi.mock('../../lib/useNetworkMode', () => ({
  useNetworkMode: vi.fn(),
}));

vi.mock('../../config/networks', () => ({
  isMainnetEnabled: vi.fn(() => false),
  isTestnet: vi.fn(() => true),
  resolveNetworkMode: vi.fn((m: string) => m),
}));

const USER_ADDRESS = '0x1234567890123456789012345678901234567890' as Address;
const ORDER_ID = '9999';
const PREIMAGE = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' as `0x${string}`;
const COORDINATOR_URL = 'https://coordinator.example.com';
const TX_HASH = '0xaabb1122aabb1122aabb1122aabb1122aabb1122aabb1122aabb1122aabb1122';

const baseNetworkState = {
  mode: 'testnet' as const,
  hasAnyMismatch: false,
  expectedEthChainIdHex: '0xaa36a7',
  expectedStellarPassphrase: 'Test SDF Network ; September 2015',
  metamaskChainId: '0xaa36a7',
  metamaskConnected: true,
  metamaskMatches: true,
  freighterNetworkPassphrase: null,
  freighterConnected: false,
  freighterMatches: true,
  setMode: vi.fn(),
  syncWalletsToAppMode: vi.fn(),
  refreshWalletNetworks: vi.fn(),
};

const mockClaimOrder = vi.fn();

function defaultProps() {
  return {
    userAddress: USER_ADDRESS,
    orderId: ORDER_ID,
    preimage: PREIMAGE,
    coordinatorUrl: COORDINATOR_URL,
  };
}

describe('ClaimFallbackDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useNetworkMode).mockReturnValue(baseNetworkState as any);
    vi.mocked(makeEthereumHTLCClient).mockResolvedValue({
      claimOrder: mockClaimOrder,
    } as any);
    mockClaimOrder.mockResolvedValue(TX_HASH);
    // Default: coordinator is up
    global.fetch = vi.fn().mockResolvedValue({ ok: true });
  });

  it('shows checking state before the coordinator probe resolves', async () => {
    // Hold the fetch promise so we can inspect the initial render
    let resolveFetch!: (v: any) => void;
    global.fetch = vi.fn().mockReturnValue(new Promise((res) => { resolveFetch = res; }));

    render(<ClaimFallbackDialog {...defaultProps()} />);

    expect(screen.getByText(/Checking coordinator availability/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Claim directly on-chain/i })).toBeDisabled();

    // Resolve and wait for the probe to settle to avoid act() warnings
    resolveFetch({ ok: true });
    await waitFor(() => screen.getByText(/Coordinator is available/i));
  });

  it('shows coordinator-available banner when health check returns 200', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true });

    render(<ClaimFallbackDialog {...defaultProps()} />);

    await waitFor(() => {
      expect(screen.getByText(/Coordinator is available/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/Coordinator unavailable/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Claim directly on-chain/i })).toBeDisabled();
    expect(screen.getByText(/Fallback is not needed while the coordinator is reachable/i)).toBeInTheDocument();
  });

  it('shows fallback warning when health check returns non-ok', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503 });

    render(<ClaimFallbackDialog {...defaultProps()} />);

    await waitFor(() => {
      expect(screen.getByText(/Coordinator unavailable — fallback mode/i)).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /Claim directly on-chain/i })).toBeEnabled();
  });

  it('shows fallback warning when health check throws (network error)', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('network error'));

    render(<ClaimFallbackDialog {...defaultProps()} />);

    await waitFor(() => {
      expect(screen.getByText(/Coordinator unavailable — fallback mode/i)).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /Claim directly on-chain/i })).toBeEnabled();
  });

  it('calls claimOrder with BigInt(orderId) and preimage on claim', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false });

    render(<ClaimFallbackDialog {...defaultProps()} />);

    await waitFor(() => screen.getByRole('button', { name: /Claim directly on-chain/i }));
    await userEvent.click(screen.getByRole('button', { name: /Claim directly on-chain/i }));

    await waitFor(() => {
      expect(makeEthereumHTLCClient).toHaveBeenCalledWith(USER_ADDRESS);
      expect(mockClaimOrder).toHaveBeenCalledWith(BigInt(ORDER_ID), PREIMAGE);
    });
  });

  it('shows transaction hash link on successful claim', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false });

    render(<ClaimFallbackDialog {...defaultProps()} />);

    await waitFor(() => screen.getByRole('button', { name: /Claim directly on-chain/i }));
    await userEvent.click(screen.getByRole('button', { name: /Claim directly on-chain/i }));

    await waitFor(() => {
      expect(screen.getByText(/Claim submitted/i)).toBeInTheDocument();
      expect(screen.getByRole('link', { name: TX_HASH })).toBeInTheDocument();
    });
  });

  it('invokes onClaimed callback with tx hash after successful claim', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false });
    const onClaimed = vi.fn();

    render(<ClaimFallbackDialog {...defaultProps()} onClaimed={onClaimed} />);

    await waitFor(() => screen.getByRole('button', { name: /Claim directly on-chain/i }));
    await userEvent.click(screen.getByRole('button', { name: /Claim directly on-chain/i }));

    await waitFor(() => expect(onClaimed).toHaveBeenCalledWith(TX_HASH));
  });

  it('shows error state when makeEthereumHTLCClient returns null', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false });
    vi.mocked(makeEthereumHTLCClient).mockResolvedValue(null);

    render(<ClaimFallbackDialog {...defaultProps()} />);

    await waitFor(() => screen.getByRole('button', { name: /Claim directly on-chain/i }));
    await userEvent.click(screen.getByRole('button', { name: /Claim directly on-chain/i }));

    await waitFor(() => {
      expect(screen.getByText(/Claim failed/i)).toBeInTheDocument();
      expect(screen.getByText(/HTLCEscrow address is not configured for this network/i)).toBeInTheDocument();
    });
  });

  it('shows error state when claimOrder rejects', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false });
    mockClaimOrder.mockRejectedValue(new Error('user rejected the request'));

    render(<ClaimFallbackDialog {...defaultProps()} />);

    await waitFor(() => screen.getByRole('button', { name: /Claim directly on-chain/i }));
    await userEvent.click(screen.getByRole('button', { name: /Claim directly on-chain/i }));

    await waitFor(() => {
      expect(screen.getByText(/Claim failed/i)).toBeInTheDocument();
      expect(screen.getByText(/user rejected the request/i)).toBeInTheDocument();
    });
  });

  it('disables claim button and shows error when wallet network mismatches', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false });
    vi.mocked(useNetworkMode).mockReturnValue({
      ...baseNetworkState,
      hasAnyMismatch: true,
      metamaskChainId: '0x1',
    } as any);

    render(<ClaimFallbackDialog {...defaultProps()} />);

    await waitFor(() => screen.getByText(/Coordinator unavailable/i));

    expect(screen.getByRole('button', { name: /Claim directly on-chain/i })).toBeDisabled();
  });

  it('calls onClose when the close button is clicked', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true });
    const onClose = vi.fn();

    render(<ClaimFallbackDialog {...defaultProps()} onClose={onClose} />);

    await userEvent.click(screen.getByRole('button', { name: /Close/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders the order id in the metadata row', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true });

    render(<ClaimFallbackDialog {...defaultProps()} />);

    expect(screen.getByText('Order id')).toBeInTheDocument();
    expect(screen.getByText(ORDER_ID)).toBeInTheDocument();
    // Wait for probe to settle
    await waitFor(() => screen.getByText(/Coordinator is available/i));
  });

  it('link points to sepolia explorer in testnet mode', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false });

    render(<ClaimFallbackDialog {...defaultProps()} />);

    await waitFor(() => screen.getByRole('button', { name: /Claim directly on-chain/i }));
    await userEvent.click(screen.getByRole('button', { name: /Claim directly on-chain/i }));

    await waitFor(() => {
      const link = screen.getByRole('link', { name: TX_HASH });
      expect(link).toHaveAttribute('href', `https://sepolia.etherscan.io/tx/${TX_HASH}`);
    });
  });
});
