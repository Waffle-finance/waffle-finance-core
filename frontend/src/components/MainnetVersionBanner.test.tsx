/**
 * Tests for MainnetVersionBanner component.
 *
 * The banner is shown only in mainnet mode and provides a button to
 * switch back to testnet. No wallet providers are required.
 *
 * Coverage:
 *  - Renders nothing (null) when mode is testnet
 *  - Renders the info banner when mode is mainnet
 *  - Contains the expected heading text in mainnet mode
 *  - Contains the expected v2/testnet explanation copy
 *  - Clicking "Try v2 on testnet" calls setMode("testnet")
 */

import { render, screen, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import MainnetVersionBanner from './MainnetVersionBanner';
import type { NetworkModeState } from '../lib/useNetworkMode';

function makeNetworkState(overrides: Partial<NetworkModeState> = {}): NetworkModeState {
  return {
    mode: 'testnet',
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
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Testnet mode: no banner
// ---------------------------------------------------------------------------

describe('MainnetVersionBanner — testnet mode', () => {
  it('renders nothing when mode is testnet', () => {
    const { container } = render(
      <MainnetVersionBanner networkState={makeNetworkState({ mode: 'testnet' })} />
    );
    expect(container.firstChild).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Mainnet mode: banner visible
// ---------------------------------------------------------------------------

describe('MainnetVersionBanner — mainnet mode', () => {
  it('renders the banner when mode is mainnet', () => {
    render(<MainnetVersionBanner networkState={makeNetworkState({ mode: 'mainnet' })} />);
    expect(screen.getByText(/Mainnet: v1 single-relayer bridge active/i)).toBeInTheDocument();
  });

  it('displays information about v2 being live on testnet', () => {
    render(<MainnetVersionBanner networkState={makeNetworkState({ mode: 'mainnet' })} />);
    // The banner body text mentions v2 decentralized stack — check with a
    // partial string that lives in a single text node.
    expect(screen.getByText(/v2 decentralized HTLC stack/i)).toBeInTheDocument();
  });

  it('renders the "Try v2 on testnet" button', () => {
    render(<MainnetVersionBanner networkState={makeNetworkState({ mode: 'mainnet' })} />);
    expect(
      screen.getByRole('button', { name: /Try v2 on testnet/i })
    ).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Interaction: testnet switch button
// ---------------------------------------------------------------------------

describe('MainnetVersionBanner — testnet switch button', () => {
  it('calls setMode("testnet") when the button is clicked', () => {
    const setMode = vi.fn().mockResolvedValue({ ok: true });
    render(
      <MainnetVersionBanner networkState={makeNetworkState({ mode: 'mainnet', setMode })} />
    );

    fireEvent.click(screen.getByRole('button', { name: /Try v2 on testnet/i }));

    expect(setMode).toHaveBeenCalledOnce();
    expect(setMode).toHaveBeenCalledWith('testnet');
  });

  it('does not call setMode when already in testnet (banner is hidden)', () => {
    const setMode = vi.fn();
    const { container } = render(
      <MainnetVersionBanner networkState={makeNetworkState({ mode: 'testnet', setMode })} />
    );
    // Nothing rendered — no button to click
    expect(container.firstChild).toBeNull();
    expect(setMode).not.toHaveBeenCalled();
  });
});
