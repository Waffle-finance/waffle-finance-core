import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import BridgeForm, { getUnsupportedRouteReason } from './BridgeForm';

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

// ── getUnsupportedRouteReason unit tests ──────────────────────────────────────

describe('getUnsupportedRouteReason', () => {
  it('returns null for eth_to_xlm when ETH + Stellar are connected', () => {
    expect(getUnsupportedRouteReason('eth_to_xlm', ETH, XLM, '')).toBeNull();
  });

  it('returns null for eth_to_sol when ETH + Solana are connected', () => {
    expect(getUnsupportedRouteReason('eth_to_sol', ETH, '', SOL)).toBeNull();
  });

  it('returns null for sol_to_eth when ETH + Solana are connected', () => {
    expect(getUnsupportedRouteReason('sol_to_eth', ETH, '', SOL)).toBeNull();
  });

  it('returns null for xlm_to_sol when all three wallets are connected', () => {
    expect(getUnsupportedRouteReason('xlm_to_sol', ETH, XLM, SOL)).toBeNull();
  });

  it('mentions missing Stellar wallet for eth_to_xlm without Stellar', () => {
    const reason = getUnsupportedRouteReason('eth_to_xlm', ETH, '', '');
    expect(reason).toMatch(/Stellar wallet/i);
  });

  it('mentions missing Solana wallet for eth_to_sol without Solana', () => {
    const reason = getUnsupportedRouteReason('eth_to_sol', ETH, '', '');
    expect(reason).toMatch(/Solana wallet/i);
  });

  it('mentions missing Ethereum wallet when ETH is absent', () => {
    const reason = getUnsupportedRouteReason('xlm_to_eth', '', XLM, '');
    expect(reason).toMatch(/Ethereum wallet/i);
  });

  it('mentions both Stellar and Solana for xlm_to_sol when neither is connected', () => {
    const reason = getUnsupportedRouteReason('xlm_to_sol', ETH, '', '');
    expect(reason).toMatch(/Stellar wallet/i);
    expect(reason).toMatch(/Solana wallet/i);
  });

  it('mentions both Stellar and Solana for sol_to_xlm when neither is connected', () => {
    const reason = getUnsupportedRouteReason('sol_to_xlm', ETH, '', '');
    expect(reason).toMatch(/Stellar wallet/i);
    expect(reason).toMatch(/Solana wallet/i);
  });
});

// ── Route selector UI tests ───────────────────────────────────────────────────

describe('BridgeForm route selector', () => {
  it('disables ETH→SOL route button when Solana wallet is not connected', async () => {
    render(
      <BridgeForm ethAddress={ETH} stellarAddress={XLM} signStellarTransaction={noopSign} />
    );
    const solBtn = screen.getByRole('button', { name: /ETH\s*→\s*SOL/i });
    expect(solBtn).toBeDisabled();
    await flush();
  });

  it('shows a tooltip on the disabled ETH→SOL button explaining the missing wallet', async () => {
    render(
      <BridgeForm ethAddress={ETH} stellarAddress={XLM} signStellarTransaction={noopSign} />
    );
    const solBtn = screen.getByRole('button', { name: /ETH\s*→\s*SOL/i });
    expect(solBtn.getAttribute('title')).toMatch(/Solana wallet/i);
    await flush();
  });

  it('enables ETH→SOL route button when Solana wallet is connected', async () => {
    render(
      <BridgeForm ethAddress={ETH} stellarAddress={XLM} solanaAddress={SOL} signStellarTransaction={noopSign} />
    );
    const solBtn = screen.getByRole('button', { name: /ETH\s*→\s*SOL/i });
    expect(solBtn).not.toBeDisabled();
    await flush();
  });

  it('does not change the route when a disabled button is clicked', async () => {
    render(
      <BridgeForm ethAddress={ETH} stellarAddress={XLM} signStellarTransaction={noopSign} />
    );

    // ETH→SOL is disabled because Solana wallet is absent.
    const solBtn = screen.getByRole('button', { name: /ETH\s*→\s*SOL/i });
    expect(solBtn).toBeDisabled();

    // After the (disabled) click the receive side must still show Stellar, not Solana.
    fireEvent.click(solBtn);
    expect(screen.getByText(/on Stellar/i)).toBeInTheDocument();
    expect(screen.queryByText(/on Solana/i)).toBeNull();

    await flush();
  });

  it('disables XLM→ETH button when ETH wallet is absent', async () => {
    render(
      <BridgeForm ethAddress={''} stellarAddress={XLM} signStellarTransaction={noopSign} />
    );
    const xlmBtn = screen.getByRole('button', { name: /XLM\s*→\s*ETH/i });
    expect(xlmBtn).toBeDisabled();
    await flush();
  });
});

// ── BridgeForm wallet recovery ────────────────────────────────────────────────

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

describe('BridgeForm cross-chain validation', () => {
  it('blocks a Solana route when the destination address is not a Solana address', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        ethUsd: 3500,
        xlmUsd: 0.12,
        solUsd: 150,
        xlmPerEth: 29166,
        staleness: 'fresh',
        fetchedAt: Date.now(),
      }),
    });

    render(
      <BridgeForm
        ethAddress={ETH}
        stellarAddress={XLM}
        solanaAddress="not-a-solana-address"
        signStellarTransaction={noopSign}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /ETH\s*→\s*SOL/i }));
    fireEvent.change(screen.getByPlaceholderText('0.0'), { target: { value: '0.1' } });
    fireEvent.click(screen.getByRole('button', { name: /^Bridge$/i }));

    expect(await screen.findByText(/Destination must be a Solana address/i)).toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    await flush();
  });

  it('blocks an amount greater than the source asset balance', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        ethUsd: 3500,
        xlmUsd: 0.12,
        solUsd: 150,
        xlmPerEth: 29166,
        staleness: 'fresh',
        fetchedAt: Date.now(),
      }),
    });

    render(
      <BridgeForm ethAddress={ETH} stellarAddress={XLM} signStellarTransaction={noopSign} />
    );

    fireEvent.click(screen.getByRole('button', { name: /XLM\s*→\s*ETH/i }));
    await waitFor(() => expect(screen.getByText(/Balance:\s*0\.0000\s*XLM/i)).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText('0.0'), {
      target: { value: '1' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Bridge$/i }));

    expect(await screen.findByText(/Insufficient XLM balance/i)).toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalledWith(
      expect.stringContaining('/api/orders/create'),
      expect.anything()
    );
    await flush();
  });
});

describe('BridgeForm transaction error classification and UI display', () => {
  const ETH = '0x1111111111111111111111111111111111111111';
  const XLM = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422';
  const noopSign = async () => 'signed-xdr';
  const flushTimers = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

  const mockEthereum = { request: vi.fn(), on: vi.fn(), removeListener: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, 'ethereum', { value: mockEthereum, writable: true, configurable: true });
    
    mockEthereum.request.mockImplementation((req: { method: string }) => {
      if (req.method === 'eth_chainId') return Promise.resolve('0xaa36a7');
      if (req.method === 'eth_getBalance') return Promise.resolve('0xDE0B6B3A7640000');
      return Promise.resolve(null);
    });

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        ethUsd: 3500,
        xlmUsd: 0.12,
        solUsd: 150,
        xlmPerEth: 29166,
        staleness: 'fresh',
        fetchedAt: Date.now(),
      }),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('displays user rejection error correctly when MetaMask rejects transaction signature', async () => {
    global.fetch = vi.fn().mockImplementation((url) => {
      if (url.includes('/api/prices')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            ethUsd: 3500, xlmUsd: 0.12, solUsd: 150,
            xlmPerEth: 29166, staleness: 'fresh', fetchedAt: Date.now()
          })
        });
      }
      if (url.includes('/api/orders/create')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            orderId: 'order-123',
            nextStep: 'deposit',
            approvalTransaction: {
              to: '0x1234567890123456789012345678901234567890',
              value: '0x2386f26fc10000',
              data: '0x'
            },
            orderData: {
              stellarAmount: '100',
              ethAmount: '0.01',
              stellarAddress: XLM,
              ethAddress: ETH
            }
          })
        });
      }
      return Promise.reject(new Error('Unknown URL'));
    });

    mockEthereum.request.mockImplementation((req: { method: string }) => {
      if (req.method === 'eth_chainId') return Promise.resolve('0xaa36a7');
      if (req.method === 'eth_getBalance') return Promise.resolve('0xDE0B6B3A7640000');
      if (req.method === 'eth_sendTransaction') {
        const err = new Error('User rejected the transaction');
        (err as any).code = 4001;
        return Promise.reject(err);
      }
      return Promise.resolve(null);
    });

    render(<BridgeForm ethAddress={ETH} stellarAddress={XLM} signStellarTransaction={noopSign} />);
    await flush();

    fireEvent.change(screen.getByPlaceholderText('0.0'), { target: { value: '0.05' } });
    await flushTimers();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Bridge$/i }));
    });
    await flushTimers();

    expect(await screen.findByRole('alert')).toHaveTextContent(/Transaction request rejected/i);
    expect(screen.getByRole('alert')).toHaveTextContent(/Please approve the transaction signature/i);
  });

  it('displays insufficient funds error correctly when MetaMask returns insufficient funds code', async () => {
    global.fetch = vi.fn().mockImplementation((url) => {
      if (url.includes('/api/prices')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            ethUsd: 3500, xlmUsd: 0.12, solUsd: 150,
            xlmPerEth: 29166, staleness: 'fresh', fetchedAt: Date.now()
          })
        });
      }
      if (url.includes('/api/orders/create')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            orderId: 'order-123',
            nextStep: 'deposit',
            approvalTransaction: {
              to: '0x1234567890123456789012345678901234567890',
              value: '0x2386f26fc10000',
              data: '0x'
            },
            orderData: {
              stellarAmount: '100',
              ethAmount: '0.01',
              stellarAddress: XLM,
              ethAddress: ETH
            }
          })
        });
      }
      return Promise.reject(new Error('Unknown URL'));
    });

    mockEthereum.request.mockImplementation((req: { method: string }) => {
      if (req.method === 'eth_chainId') return Promise.resolve('0xaa36a7');
      if (req.method === 'eth_getBalance') return Promise.resolve('0xDE0B6B3A7640000');
      if (req.method === 'eth_sendTransaction') {
        const err = new Error('Insufficient funds for gas * price + value');
        (err as any).code = -32000;
        return Promise.reject(err);
      }
      return Promise.resolve(null);
    });

    render(<BridgeForm ethAddress={ETH} stellarAddress={XLM} signStellarTransaction={noopSign} />);
    await flush();

    fireEvent.change(screen.getByPlaceholderText('0.0'), { target: { value: '0.05' } });
    await flushTimers();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Bridge$/i }));
    });
    await flushTimers();

    expect(await screen.findByRole('alert')).toHaveTextContent(/Insufficient ETH balance/i);
    expect(screen.getByRole('alert')).toHaveTextContent(/Ensure you have enough ETH/i);
  });
});

