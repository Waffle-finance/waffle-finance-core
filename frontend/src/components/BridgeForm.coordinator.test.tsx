/**
 * Frontend integration tests: coordinator / relayer API failures in BridgeForm.
 *
 * Covered scenarios:
 *  - /api/prices fails → UI shows "fallback" staleness indicator, still renders
 *  - /api/orders/announce returns 400 (validation error) → error shown, form re-enabled
 *  - /api/orders/announce returns 429 (rate limit) → error shown, form re-enabled
 *  - /api/orders/announce throws (network error) → error shown, form re-enabled
 *  - /api/orders/announce returns 503 → error shown, form re-enabled
 *  - /api/orders/create returns non-ok for ETH→XLM → error path taken
 *  - Submit button is disabled / re-enabled correctly around failures
 *  - Coordinator offline during Solana announce → error message visible
 *
 * Selector note: the BridgeForm includes a settings icon button with
 * title="Bridge settings", whose accessible name also contains "Bridge".
 * All submit-button queries use the exact-match pattern /^Bridge$/i to avoid
 * ambiguity.  The in-flight pattern /^Bridge$|Processing|Announcing/i is used
 * where the button text changes to a status string mid-submit.
 */

import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import BridgeForm from './BridgeForm';

// ── Shared test utilities ─────────────────────────────────────────────────────

const flush = () => act(async () => { await Promise.resolve(); });
const flushTimers = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

/** Find the submit button by exact text "Bridge" (avoids matching "Bridge settings"). */
const getSubmitBtn = () => screen.getByRole('button', { name: /^Bridge$/i });
/** Like getSubmitBtn but also matches in-flight status text. */
const getSubmitBtnInFlight = () =>
  screen.getByRole('button', { name: /^Bridge$|Processing|Announcing/i });

const ETH = '0x1111111111111111111111111111111111111111';
const XLM = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422';
const SOL = '11111111111111111111111111111111';

const noopSign = async () => 'signed-xdr';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('../config/networks', () => ({
  isTestnet: () => true,
  isMainnetEnabled: () => false,
  resolveNetworkMode: (m: string) => m,
  getCurrentNetwork: () => ({
    ethereum: {
      explorerUrl: 'https://sepolia.etherscan.io',
      rpcUrl: 'https://rpc.sepolia.test',
    },
    stellar: {
      horizonUrl: 'https://horizon-testnet.stellar.org',
      networkPassphrase: 'Test SDF Network ; September 2015',
      explorerUrl: 'https://testnet.stellarchain.io',
    },
  }),
}));

vi.mock('../lib/parseHtlcReceipt', () => ({ parseHtlcReceipt: () => null }));
vi.mock('../lib/sanitizeAmountInput', () => ({ sanitizeAmountInput: (v: string) => v }));

const mockEthereum = { request: vi.fn(), on: vi.fn(), removeListener: vi.fn() };

function buildFetchSequence(
  responses: Array<{ ok: boolean; status?: number; json?: () => Promise<unknown> }>
) {
  let index = 0;
  return vi.fn().mockImplementation(() => {
    const entry = responses[Math.min(index++, responses.length - 1)];
    return Promise.resolve({
      ok: entry.ok,
      status: entry.status ?? (entry.ok ? 200 : 500),
      json: entry.json ?? (() => Promise.resolve({})),
    });
  });
}

const okPrices = () => ({
  ok: true,
  json: () =>
    Promise.resolve({
      ethUsd: 3500, xlmUsd: 0.12, solUsd: 150,
      xlmPerEth: 29166, ethPerXlm: 0.0000343,
      source: 'coingecko', staleness: 'fresh',
      fetchedAt: Date.now(), ageMs: 5000,
    }),
});

const okAnnounce = () => ({
  ok: true, status: 201,
  json: () => Promise.resolve({ id: 'pub-123', status: 'announced', hashlock: '0x' + 'ab'.repeat(32) }),
});

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'ethereum', { value: mockEthereum, writable: true, configurable: true });
  mockEthereum.request.mockImplementation((req: { method: string }) => {
    if (req.method === 'eth_chainId') return Promise.resolve('0xaa36a7');
    if (req.method === 'eth_getBalance') return Promise.resolve('0xDE0B6B3A7640000'); // 1 ETH
    return Promise.resolve(null);
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(window, 'alert').mockImplementation(() => {});
});

afterEach(() => { vi.restoreAllMocks(); });

// ── /api/prices endpoint failures ────────────────────────────────────────────

describe('BridgeForm — /api/prices coordinator failures', () => {
  it('renders normally when /api/prices returns 500 (falls back to hardcoded rate)', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({}) });

    render(<BridgeForm ethAddress={ETH} stellarAddress={XLM} signStellarTransaction={noopSign} />);
    await flush();

    fireEvent.change(screen.getByPlaceholderText('0.0'), { target: { value: '1' } });
    await flushTimers();

    // Form must still be usable — submit button present (either "Bridge" or "Connect Wallet")
    expect(screen.getByRole('button', { name: /^Bridge$|^Connect Wallet$/i })).toBeInTheDocument();
  });

  it('shows "fallback" staleness indicator when /api/prices fetch throws', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('network error'));

    render(<BridgeForm ethAddress={ETH} stellarAddress={XLM} signStellarTransaction={noopSign} />);
    await flush();

    fireEvent.change(screen.getByPlaceholderText('0.0'), { target: { value: '1' } });
    await flushTimers();

    await waitFor(() => expect(screen.getByText('fallback')).toBeInTheDocument());
  });

  it('does NOT show "fallback" when /api/prices returns valid data', async () => {
    global.fetch = vi.fn().mockResolvedValue(okPrices());

    render(<BridgeForm ethAddress={ETH} stellarAddress={XLM} signStellarTransaction={noopSign} />);
    await flush();

    fireEvent.change(screen.getByPlaceholderText('0.0'), { target: { value: '1' } });

    await waitFor(() => expect(screen.queryByText('fallback')).not.toBeInTheDocument());
  });
});

// ── Solana /api/orders/announce failures ──────────────────────────────────────

describe('BridgeForm — Solana announce coordinator failures', () => {
  const solProps = { ethAddress: ETH, stellarAddress: XLM, solanaAddress: SOL, signStellarTransaction: noopSign };

  async function selectSolanaRoute() {
    fireEvent.click(screen.getByRole('button', { name: /ETH\s*→\s*SOL/i }));
    await flush();
  }

  it('shows an error alert when /api/orders/announce returns 400', async () => {
    global.fetch = buildFetchSequence([
      okPrices(),
      { ok: false, status: 400, json: () => Promise.resolve({ error: 'validation_error', details: [] }) },
    ]);

    render(<BridgeForm {...solProps} />);
    await flush();
    await selectSolanaRoute();

    fireEvent.change(screen.getByPlaceholderText('0.0'), { target: { value: '0.1' } });
    await flushTimers();

    await act(async () => { fireEvent.click(getSubmitBtn()); });
    await flushTimers();

    expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('validation_error'));
  });

  it('shows an error alert when /api/orders/announce returns 429 (rate limit)', async () => {
    global.fetch = buildFetchSequence([
      okPrices(),
      { ok: false, status: 429, json: () => Promise.resolve({ error: 'too_many_requests' }) },
    ]);

    render(<BridgeForm {...solProps} />);
    await flush();
    await selectSolanaRoute();

    fireEvent.change(screen.getByPlaceholderText('0.0'), { target: { value: '0.1' } });
    await flushTimers();

    await act(async () => { fireEvent.click(getSubmitBtn()); });
    await flushTimers();

    expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('too_many_requests'));
  });

  it('shows an error alert when /api/orders/announce throws a network error', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(okPrices())
      .mockRejectedValueOnce(new Error('Failed to fetch'));

    render(<BridgeForm {...solProps} />);
    await flush();
    await selectSolanaRoute();

    fireEvent.change(screen.getByPlaceholderText('0.0'), { target: { value: '0.1' } });
    await flushTimers();

    await act(async () => { fireEvent.click(getSubmitBtn()); });
    await flushTimers();

    expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('Failed to fetch'));
  });

  it('shows an error alert when /api/orders/announce returns 503 (coordinator down)', async () => {
    global.fetch = buildFetchSequence([
      okPrices(),
      { ok: false, status: 503, json: () => Promise.resolve({ error: 'service_unavailable' }) },
    ]);

    render(<BridgeForm {...solProps} />);
    await flush();
    await selectSolanaRoute();

    fireEvent.change(screen.getByPlaceholderText('0.0'), { target: { value: '0.1' } });
    await flushTimers();

    await act(async () => { fireEvent.click(getSubmitBtn()); });
    await flushTimers();

    expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('service_unavailable'));
  });

  it('re-enables the submit button after a coordinator failure', async () => {
    global.fetch = buildFetchSequence([
      okPrices(),
      { ok: false, status: 500, json: () => Promise.resolve({ error: 'internal_error' }) },
    ]);

    render(<BridgeForm {...solProps} />);
    await flush();
    await selectSolanaRoute();

    fireEvent.change(screen.getByPlaceholderText('0.0'), { target: { value: '0.1' } });
    await flushTimers();

    await act(async () => { fireEvent.click(getSubmitBtn()); });
    await flushTimers();

    await waitFor(() => expect(getSubmitBtn()).not.toBeDisabled());
  });

  it('shows "Order Created" view on successful announce', async () => {
    global.fetch = buildFetchSequence([okPrices(), okAnnounce()]);

    render(<BridgeForm {...solProps} />);
    await flush();
    await selectSolanaRoute();

    fireEvent.change(screen.getByPlaceholderText('0.0'), { target: { value: '0.1' } });
    await flushTimers();

    await act(async () => { fireEvent.click(getSubmitBtn()); });

    await waitFor(() => expect(screen.getByText('Order Created')).toBeInTheDocument());
  });
});

// ── /api/orders/create (relayer) failures — ETH→XLM path ─────────────────────

describe('BridgeForm — /api/orders/create relayer failures (ETH→XLM)', () => {
  const ethToXlmProps = { ethAddress: ETH, stellarAddress: XLM, signStellarTransaction: noopSign };

  it('shows alert when /api/orders/create returns 400', async () => {
    global.fetch = buildFetchSequence([
      okPrices(),
      { ok: false, status: 400, json: () => Promise.resolve({ error: 'invalid_request' }) },
    ]);

    render(<BridgeForm {...ethToXlmProps} />);
    await flush();

    fireEvent.change(screen.getByPlaceholderText('0.0'), { target: { value: '0.05' } });
    await flushTimers();

    await act(async () => { fireEvent.click(getSubmitBtn()); });
    await flushTimers();

    expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('invalid_request'));
  });

  it('shows alert when /api/orders/create returns 503', async () => {
    global.fetch = buildFetchSequence([
      okPrices(),
      { ok: false, status: 503, json: () => Promise.resolve({ error: 'service_unavailable' }) },
    ]);

    render(<BridgeForm {...ethToXlmProps} />);
    await flush();

    fireEvent.change(screen.getByPlaceholderText('0.0'), { target: { value: '0.05' } });
    await flushTimers();

    await act(async () => { fireEvent.click(getSubmitBtn()); });
    await flushTimers();

    expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('service_unavailable'));
  });

  it('shows alert when /api/orders/create throws (network failure)', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(okPrices())
      .mockRejectedValueOnce(new Error('net::ERR_CONNECTION_REFUSED'));

    render(<BridgeForm {...ethToXlmProps} />);
    await flush();

    fireEvent.change(screen.getByPlaceholderText('0.0'), { target: { value: '0.05' } });
    await flushTimers();

    await act(async () => { fireEvent.click(getSubmitBtn()); });
    await flushTimers();

    expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('ERR_CONNECTION_REFUSED'));
  });
});

// ── Retry behaviour ───────────────────────────────────────────────────────────

describe('BridgeForm — retry after coordinator failure', () => {
  const solProps = { ethAddress: ETH, stellarAddress: XLM, solanaAddress: SOL, signStellarTransaction: noopSign };

  it('allows a second submit after the first announce fails', async () => {
    global.fetch = buildFetchSequence([
      okPrices(),
      { ok: false, status: 503, json: () => Promise.resolve({ error: 'service_unavailable' }) },
      okPrices(),
      okAnnounce(),
    ]);

    render(<BridgeForm {...solProps} />);
    await flush();

    fireEvent.click(screen.getByRole('button', { name: /ETH\s*→\s*SOL/i }));
    await flush();

    fireEvent.change(screen.getByPlaceholderText('0.0'), { target: { value: '0.1' } });
    await flushTimers();

    // First attempt — fails
    await act(async () => { fireEvent.click(getSubmitBtn()); });
    await flushTimers();

    expect(window.alert).toHaveBeenCalledTimes(1);

    await waitFor(() => expect(getSubmitBtn()).not.toBeDisabled());

    // Second attempt — succeeds
    await act(async () => { fireEvent.click(getSubmitBtn()); });

    await waitFor(() => expect(screen.getByText('Order Created')).toBeInTheDocument());
  });

  it('preserves entered amount across a failed submit for retry', async () => {
    global.fetch = buildFetchSequence([
      okPrices(),
      { ok: false, status: 500, json: () => Promise.resolve({ error: 'internal_error' }) },
    ]);

    render(<BridgeForm {...solProps} />);
    await flush();

    fireEvent.click(screen.getByRole('button', { name: /ETH\s*→\s*SOL/i }));
    await flush();

    fireEvent.change(screen.getByPlaceholderText('0.0'), { target: { value: '2.5' } });
    await flushTimers();

    await act(async () => { fireEvent.click(getSubmitBtn()); });
    await flushTimers();

    expect((screen.getByPlaceholderText('0.0') as HTMLInputElement).value).toBe('2.5');
  });
});

// ── Submit button state during coordinator calls ──────────────────────────────

describe('BridgeForm — submit button disabled state during coordinator calls', () => {
  it('disables the submit button while a coordinator request is in flight', async () => {
    let resolveAnnounce!: (v: unknown) => void;
    const hangingAnnounce = new Promise((res) => { resolveAnnounce = res; });

    global.fetch = vi.fn()
      .mockResolvedValueOnce(okPrices())
      .mockReturnValueOnce(hangingAnnounce);

    render(<BridgeForm ethAddress={ETH} stellarAddress={XLM} solanaAddress={SOL} signStellarTransaction={noopSign} />);
    await flush();

    fireEvent.click(screen.getByRole('button', { name: /ETH\s*→\s*SOL/i }));
    await flush();

    fireEvent.change(screen.getByPlaceholderText('0.0'), { target: { value: '0.1' } });
    await flushTimers();

    act(() => { fireEvent.click(getSubmitBtn()); });

    await waitFor(() => expect(getSubmitBtnInFlight()).toBeDisabled());

    await act(async () => {
      resolveAnnounce({ ok: true, status: 201, json: () => Promise.resolve({ id: 'pub-ok', status: 'announced' }) });
      await flushTimers();
    });
  });

  it('submit button is not enabled while isSubmitting is true', async () => {
    let resolveAnnounce!: (v: unknown) => void;
    const hangingAnnounce = new Promise((res) => { resolveAnnounce = res; });

    global.fetch = vi.fn()
      .mockResolvedValueOnce(okPrices())
      .mockReturnValueOnce(hangingAnnounce);

    render(<BridgeForm ethAddress={ETH} stellarAddress={XLM} solanaAddress={SOL} signStellarTransaction={noopSign} />);
    await flush();

    fireEvent.click(screen.getByRole('button', { name: /ETH\s*→\s*SOL/i }));
    await flush();

    fireEvent.change(screen.getByPlaceholderText('0.0'), { target: { value: '0.1' } });
    await flushTimers();

    act(() => { fireEvent.click(getSubmitBtn()); });

    await waitFor(() => expect(getSubmitBtnInFlight()).toBeDisabled());

    await act(async () => {
      resolveAnnounce({ ok: true, status: 201, json: () => Promise.resolve({ id: 'x' }) });
      await flushTimers();
    });
  });
});

// ── Error message content ─────────────────────────────────────────────────────

describe('BridgeForm — error message content from coordinator', () => {
  const solProps = { ethAddress: ETH, stellarAddress: XLM, solanaAddress: SOL, signStellarTransaction: noopSign };

  const errorCases = [
    { label: 'validation_error',      errorBody: { error: 'validation_error', details: [] },                    expectedFragment: 'validation_error' },
    { label: 'too_many_requests',     errorBody: { error: 'too_many_requests' },                                 expectedFragment: 'too_many_requests' },
    { label: 'order_validation_error',errorBody: { error: 'order_validation_error', message: 'already exists' }, expectedFragment: 'order_validation_error' },
    { label: 'internal_error',        errorBody: { error: 'internal_error' },                                    expectedFragment: 'internal_error' },
  ];

  for (const { label, errorBody, expectedFragment } of errorCases) {
    it(`alert includes coordinator error code for "${label}"`, async () => {
      global.fetch = buildFetchSequence([
        okPrices(),
        { ok: false, status: 400, json: () => Promise.resolve(errorBody) },
      ]);

      render(<BridgeForm {...solProps} />);
      await flush();

      fireEvent.click(screen.getByRole('button', { name: /ETH\s*→\s*SOL/i }));
      await flush();

      fireEvent.change(screen.getByPlaceholderText('0.0'), { target: { value: '0.1' } });
      await flushTimers();

      await act(async () => { fireEvent.click(getSubmitBtn()); });
      await flushTimers();

      expect(window.alert).toHaveBeenCalledWith(expect.stringContaining(expectedFragment));
    });
  }
});

// ── Coordinator completely offline ────────────────────────────────────────────

describe('BridgeForm — coordinator completely offline', () => {
  beforeEach(() => {
    global.fetch = vi.fn().mockRejectedValue(new Error('coordinator offline'));
  });

  it('renders the route selector and amount input when coordinator is offline', async () => {
    render(<BridgeForm ethAddress={ETH} stellarAddress={XLM} solanaAddress={SOL} signStellarTransaction={noopSign} />);
    await flush();

    expect(screen.getByPlaceholderText('0.0')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /ETH\s*→\s*XLM/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /ETH\s*→\s*SOL/i })).toBeInTheDocument();
  });

  it('shows "fallback" exchange rate indicator when coordinator is offline', async () => {
    render(<BridgeForm ethAddress={ETH} stellarAddress={XLM} signStellarTransaction={noopSign} />);
    await flush();

    fireEvent.change(screen.getByPlaceholderText('0.0'), { target: { value: '1' } });

    await waitFor(() => expect(screen.getByText('fallback')).toBeInTheDocument());
  });

  it('still allows route switching when coordinator is offline', async () => {
    render(<BridgeForm ethAddress={ETH} stellarAddress={XLM} solanaAddress={SOL} signStellarTransaction={noopSign} />);
    await flush();

    fireEvent.click(screen.getByRole('button', { name: /ETH\s*→\s*SOL/i }));
    await flush();

    expect(screen.getByText(/on Solana/i)).toBeInTheDocument();
  });

  it('submit button is enabled while coordinator is offline (ready to attempt)', async () => {
    render(<BridgeForm ethAddress={ETH} stellarAddress={XLM} solanaAddress={SOL} signStellarTransaction={noopSign} />);
    await flush();

    fireEvent.change(screen.getByPlaceholderText('0.0'), { target: { value: '0.5' } });
    await flushTimers();

    expect(getSubmitBtn()).not.toBeDisabled();
  });
});

// ── History endpoint failure isolation ────────────────────────────────────────

describe('BridgeForm — /api/orders/history failure isolation', () => {
  it('successful Solana announce completes even when a subsequent history fetch fails', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(okPrices())
      .mockResolvedValueOnce(okAnnounce())
      .mockRejectedValueOnce(new Error('history offline'));

    render(<BridgeForm ethAddress={ETH} stellarAddress={XLM} solanaAddress={SOL} signStellarTransaction={noopSign} />);
    await flush();

    fireEvent.click(screen.getByRole('button', { name: /ETH\s*→\s*SOL/i }));
    await flush();

    fireEvent.change(screen.getByPlaceholderText('0.0'), { target: { value: '0.1' } });
    await flushTimers();

    await act(async () => { fireEvent.click(getSubmitBtn()); });

    await waitFor(() => expect(screen.getByText('Order Created')).toBeInTheDocument());

    expect(window.alert).not.toHaveBeenCalled();
  });
});
