import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import NetworkMismatchBanner from './NetworkMismatchBanner';
import { vi } from 'vitest';

// Mock isMainnetEnabled and getNetworkConfigForMode to prevent layout runtime exceptions
vi.mock('../config/networks', () => ({
  isMainnetEnabled: vi.fn(() => true),
  getNetworkConfigForMode: vi.fn((mode: 'testnet' | 'mainnet') => ({
    ethereum: {
      id: mode === 'mainnet' ? 1 : 11155111,
      displayName: mode === 'mainnet' ? 'Ethereum Mainnet' : 'Sepolia Testnet',
      rpcUrl: '',
      explorerUrl: '',
    },
    stellar: {
      networkPassphrase: mode === 'mainnet'
        ? 'Public Global Stellar Network ; September 2015'
        : 'Test SDF Network ; September 2015',
      displayName: mode === 'mainnet' ? 'Stellar Mainnet' : 'Stellar Testnet',
      horizonUrl: '',
      explorerUrl: '',
    },
    solana: {
      rpcUrl: '',
      explorerUrl: '',
    },
  })),
}));

const mockNetworkState = {
  mode: 'testnet' as const,
  expectedEthChainIdHex: '0xaa36a7',
  expectedStellarPassphrase: 'Test SDF Network ; September 2015',
  metamaskChainId: null,
  metamaskConnected: false,
  metamaskMatches: true,
  freighterNetworkPassphrase: null,
  freighterConnected: false,
  freighterMatches: true,
  hasAnyMismatch: false,
  setMode: vi.fn().mockResolvedValue({ ok: true }),
  syncWalletsToAppMode: vi.fn().mockResolvedValue({ ok: true }),
  refreshWalletNetworks: vi.fn(),
};

describe('NetworkMismatchBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('does not render when there is no mismatch', () => {
    render(<NetworkMismatchBanner networkState={mockNetworkState} />);
    expect(screen.queryByText(/Your wallet network does not match/i)).not.toBeInTheDocument();
  });

  test('renders when there is a MetaMask mismatch', () => {
    const mismatchState = {
      ...mockNetworkState,
      metamaskConnected: true,
      metamaskChainId: '0x1', // Mainnet chain ID
      metamaskMatches: false,
      hasAnyMismatch: true,
    };

    render(<NetworkMismatchBanner networkState={mismatchState} />);

    // Should show the banner
    expect(screen.getByText(/Your wallet network does not match/i)).toBeInTheDocument();

    // Check for App is set to Testnet
    expect(screen.getByText(/App is set to/i)).toBeInTheDocument();

    // Should show MetaMask is on mainnet
    expect(screen.getByText(/Ethereum wallet is on/i)).toBeInTheDocument();
    expect(screen.getByText(/Ethereum Mainnet/i)).toBeInTheDocument();

    // Should show switch wallet to app button
    expect(screen.getByRole('button', { name: /Switch wallet to Testnet/i })).toBeInTheDocument();

    // Should show switch app to wallet button
    expect(screen.getByRole('button', { name: /Switch app to wallet/i })).toBeInTheDocument();
  });

  test('renders when there is a Freighter mismatch', () => {
    const mismatchState = {
      ...mockNetworkState,
      freighterConnected: true,
      freighterNetworkPassphrase: 'Public Global Stellar Network ; September 2015', // Mainnet
      freighterMatches: false,
      hasAnyMismatch: true,
    };

    render(<NetworkMismatchBanner networkState={mismatchState} />);

    // Should show the banner
    expect(screen.getByText(/Your wallet network does not match/i)).toBeInTheDocument();

    // Check for App is set to Testnet
    expect(screen.getByText(/App is set to/i)).toBeInTheDocument();

    // Should show Freighter is on mainnet
    expect(screen.getByText(/Freighter is on/i)).toBeInTheDocument();
    expect(screen.getByText(/Stellar Mainnet/i)).toBeInTheDocument();

    // Should show switch wallet to app button
    expect(screen.getByRole('button', { name: /Switch wallet to Testnet/i })).toBeInTheDocument();

    // Should show switch app to wallet button
    expect(screen.getByRole('button', { name: /Switch app to wallet/i })).toBeInTheDocument();
  });

  test('calls syncWalletsToAppMode when switch wallet to app button clicked', async () => {
    const mismatchState = {
      ...mockNetworkState,
      metamaskConnected: true,
      metamaskChainId: '0x1', // Mainnet chain ID
      metamaskMatches: false,
      hasAnyMismatch: true,
    };

    render(<NetworkMismatchBanner networkState={mismatchState} />);

    await userEvent.click(screen.getByRole('button', { name: /Switch wallet to Testnet/i }));

    expect(mockNetworkState.syncWalletsToAppMode).toHaveBeenCalledTimes(1);
  });

  test('calls setMode when switch app to wallet button clicked', async () => {
    const mismatchState = {
      ...mockNetworkState,
      metamaskConnected: true,
      metamaskChainId: '0x1', // Mainnet chain ID
      metamaskMatches: false,
      hasAnyMismatch: true,
    };

    render(<NetworkMismatchBanner networkState={mismatchState} />);

    await userEvent.click(screen.getByRole('button', { name: /Switch app to wallet/i }));

    expect(mockNetworkState.setMode).toHaveBeenCalledWith('mainnet');
  });

  test('does not show switch app to wallet button when mainnet is disabled and wallet wants mainnet', async () => {
    const { isMainnetEnabled } = await import('../config/networks');
    vi.mocked(isMainnetEnabled).mockReturnValue(false);

    const mismatchState = {
      ...mockNetworkState,
      metamaskConnected: true,
      metamaskChainId: '0x1', // Mainnet chain ID
      metamaskMatches: false,
      hasAnyMismatch: true,
    };

    render(<NetworkMismatchBanner networkState={mismatchState} />);

    // Should NOT show switch app to wallet button
    expect(screen.queryByRole('button', { name: /Switch app to wallet/i })).not.toBeInTheDocument();
  });
});
