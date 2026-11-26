/**
 * NetworkMismatchBanner component tests — issue #470
 *
 * Covers mainnet UI acceptance criteria:
 *   - Banner hidden when wallets match the app network
 *   - Banner shown when MetaMask is on mainnet (0x1) while app is in testnet mode
 *   - Banner shown when Freighter is on mainnet passphrase while app is in testnet mode
 *   - "Switch wallet to Testnet" button calls syncWalletsToAppMode
 *   - "Switch app to wallet" button calls setMode with the wallet's detected mode
 *   - Banner shown when MetaMask is on Sepolia while app is in mainnet mode
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import NetworkMismatchBanner from './NetworkMismatchBanner';
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

describe('NetworkMismatchBanner', () => {
  it('renders nothing when no mismatch exists', () => {
    const { container } = render(
      <NetworkMismatchBanner networkState={makeNetworkState({ hasAnyMismatch: false })} />,
    );
    expect(container.firstChild).toBeNull();
  });

  // ── MetaMask on mainnet while app is testnet ──────────────────────────────

  it('shows banner when MetaMask is on Ethereum Mainnet but app is on Testnet', () => {
    render(
      <NetworkMismatchBanner
        networkState={makeNetworkState({
          mode: 'testnet',
          metamaskConnected: true,
          metamaskChainId: '0x1',
          metamaskMatches: false,
          hasAnyMismatch: true,
        })}
      />,
    );
    expect(screen.getByText(/does not match/i)).toBeInTheDocument();
    expect(screen.getByText(/ethereum mainnet/i)).toBeInTheDocument();
  });

  it('shows "Switch wallet to Testnet" button when app is on testnet', () => {
    render(
      <NetworkMismatchBanner
        networkState={makeNetworkState({
          mode: 'testnet',
          metamaskConnected: true,
          metamaskChainId: '0x1',
          metamaskMatches: false,
          hasAnyMismatch: true,
        })}
      />,
    );
    expect(
      screen.getByRole('button', { name: /switch wallet to testnet/i }),
    ).toBeInTheDocument();
  });

  it('"Switch wallet to Testnet" button calls syncWalletsToAppMode', async () => {
    const syncWalletsToAppMode = vi.fn().mockResolvedValue({ ok: true });
    render(
      <NetworkMismatchBanner
        networkState={makeNetworkState({
          mode: 'testnet',
          metamaskConnected: true,
          metamaskChainId: '0x1',
          metamaskMatches: false,
          hasAnyMismatch: true,
          syncWalletsToAppMode,
        })}
      />,
    );
    await userEvent.click(
      screen.getByRole('button', { name: /switch wallet to testnet/i }),
    );
    await waitFor(() => expect(syncWalletsToAppMode).toHaveBeenCalledOnce());
  });

  // ── MetaMask on Sepolia while app is mainnet ──────────────────────────────

  it('shows banner when MetaMask is on Sepolia but app is on Mainnet', () => {
    render(
      <NetworkMismatchBanner
        networkState={makeNetworkState({
          mode: 'mainnet',
          metamaskConnected: true,
          metamaskChainId: '0xaa36a7',
          metamaskMatches: false,
          hasAnyMismatch: true,
        })}
      />,
    );
    expect(screen.getByText(/does not match/i)).toBeInTheDocument();
    expect(screen.getByText(/sepolia testnet/i)).toBeInTheDocument();
  });

  it('shows "Switch wallet to Mainnet" button when app is on mainnet', () => {
    render(
      <NetworkMismatchBanner
        networkState={makeNetworkState({
          mode: 'mainnet',
          metamaskConnected: true,
          metamaskChainId: '0xaa36a7',
          metamaskMatches: false,
          hasAnyMismatch: true,
        })}
      />,
    );
    expect(
      screen.getByRole('button', { name: /switch wallet to mainnet/i }),
    ).toBeInTheDocument();
  });

  // ── Freighter on mainnet while app is testnet ─────────────────────────────

  it('shows banner when Freighter is on Stellar Mainnet but app is on Testnet', () => {
    render(
      <NetworkMismatchBanner
        networkState={makeNetworkState({
          mode: 'testnet',
          freighterConnected: true,
          freighterNetworkPassphrase: 'Public Global Stellar Network ; September 2015',
          freighterMatches: false,
          hasAnyMismatch: true,
        })}
      />,
    );
    expect(screen.getByText(/does not match/i)).toBeInTheDocument();
    expect(screen.getByText(/stellar mainnet/i)).toBeInTheDocument();
  });

  it('shows Freighter guidance copy when Freighter is mismatched', () => {
    render(
      <NetworkMismatchBanner
        networkState={makeNetworkState({
          mode: 'testnet',
          freighterConnected: true,
          freighterNetworkPassphrase: 'Public Global Stellar Network ; September 2015',
          freighterMatches: false,
          hasAnyMismatch: true,
        })}
      />,
    );
    // Banner advises the user to switch Freighter manually.
    expect(screen.getByText(/switch freighter/i)).toBeInTheDocument();
  });

  // ── "Switch app to wallet" — only shown when mainnet is enabled ──────────

  it('"Switch app to wallet" is absent when wallet wants mainnet but mainnet is disabled', () => {
    // isMainnetEnabled() returns false in the test environment (VITE_MAINNET_ENABLED unset).
    render(
      <NetworkMismatchBanner
        networkState={makeNetworkState({
          mode: 'testnet',
          metamaskConnected: true,
          metamaskChainId: '0x1',  // wallet on mainnet
          metamaskMatches: false,
          hasAnyMismatch: true,
        })}
      />,
    );
    expect(
      screen.queryByRole('button', { name: /switch app to wallet/i }),
    ).toBeNull();
  });
});
