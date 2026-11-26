/**
 * MainnetVersionBanner component tests — issue #470
 *
 * Verifies:
 *   - Banner is not rendered in testnet mode (default)
 *   - Banner renders in mainnet mode with expected copy
 *   - "Try v2 on testnet" button calls setMode('testnet')
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import MainnetVersionBanner from './MainnetVersionBanner';
import type { NetworkModeState } from '../lib/useNetworkMode';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeNetworkState(overrides: Partial<NetworkModeState> = {}): NetworkModeState {
  return {
    mode: 'testnet',
    expectedEthChainIdHex: '0xaa36a7',
    expectedStellarPassphrase: 'Test SDF Network ; September 2015',
    metamaskChainId: '0xaa36a7',
    metamaskConnected: false,
    metamaskMatches: true,
    freighterNetworkPassphrase: null,
    freighterConnected: false,
    freighterMatches: true,
    hasAnyMismatch: false,
    setMode: vi.fn().mockResolvedValue({ ok: true }),
    syncWalletsToAppMode: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('MainnetVersionBanner', () => {
  it('renders nothing when mode is testnet', () => {
    const { container } = render(
      <MainnetVersionBanner networkState={makeNetworkState({ mode: 'testnet' })} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders the mainnet banner when mode is mainnet', () => {
    render(
      <MainnetVersionBanner networkState={makeNetworkState({ mode: 'mainnet' })} />,
    );
    expect(
      screen.getByText(/v1 single-relayer bridge active/i),
    ).toBeInTheDocument();
  });

  it('shows v2 testnet availability copy in mainnet mode', () => {
    render(
      <MainnetVersionBanner networkState={makeNetworkState({ mode: 'mainnet' })} />,
    );
    expect(screen.getByText(/v2 decentralized HTLC stack/i)).toBeInTheDocument();
    expect(screen.getByText(/testnet/i)).toBeInTheDocument();
  });

  it('"Try v2 on testnet" button calls setMode("testnet")', async () => {
    const setMode = vi.fn().mockResolvedValue({ ok: true });
    render(
      <MainnetVersionBanner
        networkState={makeNetworkState({ mode: 'mainnet', setMode })}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /try v2 on testnet/i }));
    expect(setMode).toHaveBeenCalledWith('testnet');
  });
});
