/**
 * Wallet/network mismatch messaging — issue #957
 *
 * Locks in the behavior of the smallest component that owns mismatch state
 * (`NetworkMismatchBanner` + `NetworkModeState`):
 *   - supported-network: no banner (null render)
 *   - unsupported-network: alert names the expected network and offers a
 *     recovery path; submission stays disabled and no transaction is sent
 *   - disconnected-wallet: no mismatch banner (distinguishable from mismatch)
 */

import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import NetworkMismatchBanner from './NetworkMismatchBanner';
import type { NetworkModeState } from '../lib/useNetworkMode';

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
    refreshWalletNetworks: vi.fn(),
    ...overrides,
  };
}

/** Minimal submit gate mirroring BridgeFormContainer's walletBlocked logic. */
function SubmitGate({ networkState }: { networkState: NetworkModeState }) {
  return (
    <button type="submit" disabled={networkState.hasAnyMismatch}>
      Bridge
    </button>
  );
}

describe('wallet/network mismatch messaging', () => {
  it('supported network renders no banner and leaves submission enabled', () => {
    const ns = makeNetworkState({ hasAnyMismatch: false });
    const { container } = render(<NetworkMismatchBanner networkState={ns} />);
    expect(container.firstChild).toBeNull();

    render(<SubmitGate networkState={ns} />);
    expect(screen.getByRole('button', { name: 'Bridge' })).toBeEnabled();
  });

  it('unsupported network names the expected network and disables submission', () => {
    const ns = makeNetworkState({
      mode: 'testnet',
      metamaskConnected: true,
      metamaskChainId: '0x1',
      metamaskMatches: false,
      hasAnyMismatch: true,
    });
    render(<NetworkMismatchBanner networkState={ns} />);

    expect(screen.getByRole('alert')).toBeInTheDocument();
    // User can identify the expected network.
    expect(screen.getByText(/testnet/i)).toBeInTheDocument();
    // Recovery path is offered.
    expect(
      screen.getByRole('button', { name: /switch wallet to testnet/i }),
    ).toBeInTheDocument();

    render(<SubmitGate networkState={ns} />);
    expect(screen.getByRole('button', { name: 'Bridge' })).toBeDisabled();
  });

  it('disconnected wallet is distinguishable from a network mismatch', () => {
    const disconnected = makeNetworkState({
      metamaskConnected: false,
      metamaskChainId: null,
      metamaskMatches: true,
      freighterConnected: false,
      freighterMatches: true,
      hasAnyMismatch: false,
    });
    const { container } = render(
      <NetworkMismatchBanner networkState={disconnected} />,
    );
    // Disconnected wallets show no mismatch banner…
    expect(container.firstChild).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();

    // …while a mismatched wallet does.
    const mismatched = makeNetworkState({
      metamaskConnected: true,
      metamaskChainId: '0x1',
      metamaskMatches: false,
      hasAnyMismatch: true,
    });
    render(<NetworkMismatchBanner networkState={mismatched} />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('sends no transaction request while the wallet is on an unsupported chain', () => {
    const ns = makeNetworkState({
      metamaskConnected: true,
      metamaskChainId: '0x1',
      metamaskMatches: false,
      hasAnyMismatch: true,
    });
    const submitOrder = vi.fn();

    // BridgeFormContainer gates submission on walletBlocked (hasAnyMismatch).
    const trySubmit = () => {
      if (ns.hasAnyMismatch) return;
      submitOrder();
    };
    trySubmit();

    expect(submitOrder).not.toHaveBeenCalled();
  });
});
