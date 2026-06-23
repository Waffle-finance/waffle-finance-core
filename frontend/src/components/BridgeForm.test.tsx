import { render, screen, fireEvent, act } from '@testing-library/react';
import { vi } from 'vitest';
import BridgeForm from './BridgeForm';

// Flush the component's async balance effect (an async fetch that settles in a
// microtask after the synchronous render) inside act() to avoid noisy warnings.
const flush = () => act(async () => { await Promise.resolve(); });

// Keep the component offline and on a known (testnet) network so the recovery
// behaviour is what's under test, not balance/quote fetching.
vi.mock('../config/networks', () => ({
  isTestnet: () => true,
  getCurrentNetwork: () => ({
    ethereum: { explorerUrl: 'https://sepolia.etherscan.io' },
    stellar: {
      horizonUrl: 'https://horizon-testnet.stellar.org',
      networkPassphrase: 'Test SDF Network ; September 2015',
      explorerUrl: 'https://stellar.expert',
    },
  }),
}));

const ETH = '0x1111111111111111111111111111111111111111';
const XLM = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422';
const SOL = '11111111111111111111111111111111';

const noopSign = async () => 'signed-xdr';

describe('BridgeForm wallet recovery', () => {
  it('warns and blocks submit when a route wallet disconnects mid-session', async () => {
    const { rerender } = render(
      <BridgeForm ethAddress={ETH} stellarAddress={XLM} signStellarTransaction={noopSign} />
    );

    // Connected → no recovery warning yet.
    expect(screen.queryByRole('alert')).toBeNull();

    // Stellar (Freighter) disconnects mid-session.
    rerender(<BridgeForm ethAddress={ETH} stellarAddress={''} signStellarTransaction={noopSign} />);

    expect(screen.getByRole('alert').textContent).toMatch(/Stellar wallet connection lost/i);

    // The action button now requires reconnection and is disabled.
    const submit = screen.getByRole('button', { name: /Reconnect Wallet/i });
    expect(submit).toBeDisabled();

    await flush();
  });

  it('resets a Solana route to the default ETH→XLM route when Phantom disconnects', async () => {
    const { rerender } = render(
      <BridgeForm
        ethAddress={ETH}
        stellarAddress={''}
        solanaAddress={SOL}
        signStellarTransaction={noopSign}
      />
    );

    // Select the Solana route; the receive side is now SOL "on Solana".
    fireEvent.click(screen.getByRole('button', { name: /ETH\s*→\s*SOL/i }));
    expect(screen.getByText(/on Solana/i)).toBeInTheDocument();

    // Phantom disconnects.
    rerender(
      <BridgeForm
        ethAddress={ETH}
        stellarAddress={''}
        solanaAddress={undefined}
        signStellarTransaction={noopSign}
      />
    );

    // Route invalidated → fell back to ETH→XLM (no Solana token), with a warning.
    expect(screen.queryByText(/on Solana/i)).toBeNull();
    expect(screen.getByText(/on Stellar/i)).toBeInTheDocument();
    expect(screen.getByRole('alert').textContent).toMatch(/Solana wallet connection lost/i);

    await flush();
  });

  it('clears the recovery warning once the wallet reconnects', async () => {
    const { rerender } = render(
      <BridgeForm ethAddress={ETH} stellarAddress={XLM} signStellarTransaction={noopSign} />
    );

    rerender(<BridgeForm ethAddress={ETH} stellarAddress={''} signStellarTransaction={noopSign} />);
    expect(screen.getByRole('alert')).toBeInTheDocument();

    rerender(<BridgeForm ethAddress={ETH} stellarAddress={XLM} signStellarTransaction={noopSign} />);
    expect(screen.queryByRole('alert')).toBeNull();

    await flush();
  });
});
