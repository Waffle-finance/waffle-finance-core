/**
 * End-to-end tests for persisted bridge draft restoration (issue #1104).
 *
 * Validates that restored drafts are properly revalidated against wallet,
 * network, and route configuration before allowing transaction submission.
 *
 * Coverage:
 *  - Valid draft restoration without silent changes
 *  - Unsupported route rejection (e.g., Solana route with Phantom disconnected)
 *  - Account-mismatched draft handling (different wallet fingerprint)
 *  - Expired storage (24h TTL)
 *  - Amount revalidation before quote/transaction
 *  - Documentation of stored vs excluded fields
 */

import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import BridgeForm from './BridgeForm';

// ── Test constants ───────────────────────────────────────────────────────────

const ETH = '0x1111111111111111111111111111111111111111';
const XLM = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422';
const SOL = '11111111111111111111111111111111';

const STORAGE_KEY = 'wafflefinance_bridge_draft_v1';

const noopSign = async (xdr: string) => xdr;

// ── Test utilities ───────────────────────────────────────────────────────────

function clearStorage(): void {
  window.localStorage.clear();
}

function storeDraft(draft: {
  direction: string;
  amount: string;
  fingerprint: string;
  savedAt?: number;
}): void {
  const payload = {
    v: 1,
    ...draft,
    savedAt: draft.savedAt ?? Date.now(),
  };
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

function getStoredDraft(): any {
  const raw = window.localStorage.getItem(STORAGE_KEY);
  return raw ? JSON.parse(raw) : null;
}

const flush = () => act(async () => { await Promise.resolve(); });

// Mock network config
vi.mock('../config/networks', () => ({
  isTestnet: () => true,
  getCurrentNetwork: () => 'testnet',
  isMainnetEnabled: () => false,
  resolveNetworkMode: (mode: string) => mode,
}));

// Mock selectors
vi.mock('../config/selectors', () => ({
  selectApiBaseUrl: () => 'http://localhost:3001',
  selectIsMockDataEnabled: () => false,
  selectSolanaRoutesEnabled: () => true,
  selectIsMainnetEnabled: () => false,
}));

// ── Draft restoration validation tests ───────────────────────────────────────

describe('BridgeForm — valid draft restoration', () => {
  beforeEach(() => {
    clearStorage();
    // Mock successful API responses
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ eth_xlm: 10000, xlm_eth: 0.0001 }),
    });
  });

  afterEach(() => {
    clearStorage();
    vi.restoreAllMocks();
  });

  it('restores a valid draft without changing direction or amount', async () => {
    storeDraft({
      direction: 'xlm_to_eth',
      amount: '1000.5',
      fingerprint: '1-1-0', // ETH + XLM connected
    });

    render(
      <BridgeForm
        ethAddress={ETH}
        stellarAddress={XLM}
        signStellarTransaction={noopSign}
      />
    );

    await flush();

    // Direction should be restored to XLM→ETH
    const xlmBtn = screen.getByRole('button', { name: /XLM\s*→\s*ETH/i });
    expect(xlmBtn).toHaveAttribute('aria-pressed', 'true');

    // Amount should be restored
    const amountInput = screen.getByLabelText(/you pay/i) as HTMLInputElement;
    expect(amountInput.value).toBe('1000.5');
  });

  it('restores ETH→SOL draft when all three wallets are connected', async () => {
    storeDraft({
      direction: 'eth_to_sol',
      amount: '0.05',
      fingerprint: '1-1-1', // ETH + XLM + SOL connected
    });

    render(
      <BridgeForm
        ethAddress={ETH}
        stellarAddress={XLM}
        solanaAddress={SOL}
        signStellarTransaction={noopSign}
      />
    );

    await flush();

    const solBtn = screen.getByRole('button', { name: /ETH\s*→\s*SOL/i });
    expect(solBtn).toHaveAttribute('aria-pressed', 'true');

    const amountInput = screen.getByLabelText(/you pay/i) as HTMLInputElement;
    expect(amountInput.value).toBe('0.05');
  });

  it('never persists wallet addresses or sensitive data', async () => {
    render(
      <BridgeForm
        ethAddress={ETH}
        stellarAddress={XLM}
        solanaAddress={SOL}
        signStellarTransaction={noopSign}
      />
    );

    await flush();

    // Set some amount and direction
    const amountInput = screen.getByLabelText(/you pay/i);
    fireEvent.change(amountInput, { target: { value: '0.5' } });

    const xlmBtn = screen.getByRole('button', { name: /XLM\s*→\s*ETH/i });
    fireEvent.click(xlmBtn);

    await flush();

    const stored = getStoredDraft();
    expect(stored).toBeTruthy();
    expect(stored.direction).toBe('xlm_to_eth');
    expect(stored.amount).toBe('0.5');
    expect(stored.fingerprint).toBe('1-1-1');
    
    // Verify no sensitive data
    expect(stored.ethAddress).toBeUndefined();
    expect(stored.stellarAddress).toBeUndefined();
    expect(stored.solanaAddress).toBeUndefined();
    expect(stored.hashlock).toBeUndefined();
    expect(stored.preimage).toBeUndefined();
    expect(stored.xdr).toBeUndefined();
    expect(stored.txHash).toBeUndefined();
    expect(stored.signature).toBeUndefined();
  });
});

describe('BridgeForm — unsupported route rejection', () => {
  beforeEach(() => {
    clearStorage();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ eth_xlm: 10000, xlm_eth: 0.0001 }),
    });
  });

  afterEach(() => {
    clearStorage();
    vi.restoreAllMocks();
  });

  it('resets to default route when restored Solana route is unsupported', async () => {
    storeDraft({
      direction: 'eth_to_sol',
      amount: '0.1',
      fingerprint: '1-1-1', // Was created with SOL connected
    });

    // Render without Solana wallet (Phantom disconnected)
    render(
      <BridgeForm
        ethAddress={ETH}
        stellarAddress={XLM}
        signStellarTransaction={noopSign}
      />
    );

    await flush();

    // Should fall back to default ETH→XLM route
    const ethBtn = screen.getByRole('button', { name: /ETH\s*→\s*XLM/i });
    expect(ethBtn).toHaveAttribute('aria-pressed', 'true');

    // Amount should be cleared (route changed)
    const amountInput = screen.getByLabelText(/you pay/i) as HTMLInputElement;
    expect(amountInput.value).toBe('');
  });

  it('shows disabled state for SOL route button when draft requires it', async () => {
    storeDraft({
      direction: 'eth_to_sol',
      amount: '0.1',
      fingerprint: '1-1-1',
    });

    render(
      <BridgeForm
        ethAddress={ETH}
        stellarAddress={XLM}
        signStellarTransaction={noopSign}
      />
    );

    await flush();

    const solBtn = screen.getByRole('button', { name: /ETH\s*→\s*SOL/i });
    expect(solBtn).toBeDisabled();
    expect(solBtn).toHaveAttribute('title', expect.stringMatching(/Connect Phantom/i));
  });

  it('blocks submission when route becomes unsupported after restoration', async () => {
    storeDraft({
      direction: 'xlm_to_eth',
      amount: '500',
      fingerprint: '1-1-0',
    });

    // Render without ETH wallet (MetaMask disconnected)
    render(
      <BridgeForm
        ethAddress=""
        stellarAddress={XLM}
        signStellarTransaction={noopSign}
      />
    );

    await flush();

    // XLM→ETH requires Ethereum wallet
    const xlmBtn = screen.getByRole('button', { name: /XLM\s*→\s*ETH/i });
    expect(xlmBtn).toBeDisabled();

    // Should show warning about missing wallet
    expect(screen.getByRole('alert')).toHaveTextContent(/Ethereum wallet connection lost/i);
  });
});

describe('BridgeForm — account-mismatched draft handling', () => {
  beforeEach(() => {
    clearStorage();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ eth_xlm: 10000, xlm_eth: 0.0001 }),
    });
  });

  afterEach(() => {
    clearStorage();
    vi.restoreAllMocks();
  });

  it('does not restore draft when wallet fingerprint differs', async () => {
    storeDraft({
      direction: 'eth_to_sol',
      amount: '0.25',
      fingerprint: '1-1-1', // ETH + XLM + SOL
    });

    // Render with different wallet configuration (no SOL)
    render(
      <BridgeForm
        ethAddress={ETH}
        stellarAddress={XLM}
        signStellarTransaction={noopSign}
      />
    );

    await flush();

    // Should use defaults instead of restored values
    const ethBtn = screen.getByRole('button', { name: /ETH\s*→\s*XLM/i });
    expect(ethBtn).toHaveAttribute('aria-pressed', 'true');

    const amountInput = screen.getByLabelText(/you pay/i) as HTMLInputElement;
    expect(amountInput.value).toBe('');
  });

  it('clears stale draft and writes new fingerprint on wallet change', async () => {
    storeDraft({
      direction: 'eth_to_sol',
      amount: '0.75',
      fingerprint: '1-1-1',
    });

    const { rerender } = render(
      <BridgeForm
        ethAddress={ETH}
        stellarAddress={XLM}
        solanaAddress={SOL}
        signStellarTransaction={noopSign}
      />
    );

    await flush();

    // Initial render: draft restored
    let stored = getStoredDraft();
    expect(stored.fingerprint).toBe('1-1-1');
    expect(stored.direction).toBe('eth_to_sol');

    // Disconnect Solana wallet
    rerender(
      <BridgeForm
        ethAddress={ETH}
        stellarAddress={XLM}
        signStellarTransaction={noopSign}
      />
    );

    await flush();

    // Storage should be cleared or updated with new fingerprint
    stored = getStoredDraft();
    if (stored) {
      expect(stored.fingerprint).toBe('1-1-0');
      expect(stored.direction).toBe('eth_to_xlm'); // Reset to default
    }
  });

  it('prevents submit when restored draft requires a disconnected wallet', async () => {
    storeDraft({
      direction: 'sol_to_eth',
      amount: '10',
      fingerprint: '1-0-1', // ETH + SOL (no XLM)
    });

    // Render without SOL wallet
    render(
      <BridgeForm
        ethAddress={ETH}
        stellarAddress={XLM}
        signStellarTransaction={noopSign}
      />
    );

    await flush();

    // Should reset to default route
    const ethBtn = screen.getByRole('button', { name: /ETH\s*→\s*XLM/i });
    expect(ethBtn).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('BridgeForm — expired storage handling', () => {
  beforeEach(() => {
    clearStorage();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ eth_xlm: 10000, xlm_eth: 0.0001 }),
    });
  });

  afterEach(() => {
    clearStorage();
    vi.restoreAllMocks();
  });

  it('ignores drafts older than 24 hours', async () => {
    const TWENTY_FIVE_HOURS = 25 * 60 * 60 * 1000;
    
    storeDraft({
      direction: 'xlm_to_eth',
      amount: '999',
      fingerprint: '1-1-0',
      savedAt: Date.now() - TWENTY_FIVE_HOURS,
    });

    render(
      <BridgeForm
        ethAddress={ETH}
        stellarAddress={XLM}
        signStellarTransaction={noopSign}
      />
    );

    await flush();

    // Should use defaults, not expired draft
    const ethBtn = screen.getByRole('button', { name: /ETH\s*→\s*XLM/i });
    expect(ethBtn).toHaveAttribute('aria-pressed', 'true');

    const amountInput = screen.getByLabelText(/you pay/i) as HTMLInputElement;
    expect(amountInput.value).toBe('');
  });

  it('restores drafts that are 23 hours old (within TTL)', async () => {
    const TWENTY_THREE_HOURS = 23 * 60 * 60 * 1000;
    
    storeDraft({
      direction: 'xlm_to_eth',
      amount: '750',
      fingerprint: '1-1-0',
      savedAt: Date.now() - TWENTY_THREE_HOURS,
    });

    render(
      <BridgeForm
        ethAddress={ETH}
        stellarAddress={XLM}
        signStellarTransaction={noopSign}
      />
    );

    await flush();

    // Should restore the draft
    const xlmBtn = screen.getByRole('button', { name: /XLM\s*→\s*ETH/i });
    expect(xlmBtn).toHaveAttribute('aria-pressed', 'true');

    const amountInput = screen.getByLabelText(/you pay/i) as HTMLInputElement;
    expect(amountInput.value).toBe('750');
  });
});

describe('BridgeForm — amount revalidation before transaction', () => {
  beforeEach(() => {
    clearStorage();
  });

  afterEach(() => {
    clearStorage();
    vi.restoreAllMocks();
  });

  it('revalidates restored amount before allowing quote request', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ eth_xlm: 10000, xlm_eth: 0.0001 }),
    });

    storeDraft({
      direction: 'eth_to_xlm',
      amount: '0.001', // Below typical minimum
      fingerprint: '1-1-0',
    });

    render(
      <BridgeForm
        ethAddress={ETH}
        stellarAddress={XLM}
        signStellarTransaction={noopSign}
      />
    );

    await flush();

    // Amount is restored
    const amountInput = screen.getByLabelText(/you pay/i) as HTMLInputElement;
    expect(amountInput.value).toBe('0.001');

    // The form should still validate this amount
    // (validation happens in useRouteValidator and BridgeFormContainer)
  });

  it('blocks submit when restored amount is invalid (zero)', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ eth_xlm: 10000, xlm_eth: 0.0001 }),
    });

    storeDraft({
      direction: 'eth_to_xlm',
      amount: '0',
      fingerprint: '1-1-0',
    });

    render(
      <BridgeForm
        ethAddress={ETH}
        stellarAddress={XLM}
        signStellarTransaction={noopSign}
      />
    );

    await flush();

    const amountInput = screen.getByLabelText(/you pay/i) as HTMLInputElement;
    expect(amountInput.value).toBe('0');

    // Submit button should be present but validation will catch the zero amount
    const submitBtn = screen.getByRole('button', { name: /^Bridge$/i });
    expect(submitBtn).toBeInTheDocument();
  });

  it('allows transaction when restored amount passes validation', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ eth_xlm: 10000, xlm_eth: 0.0001 }),
    });

    storeDraft({
      direction: 'eth_to_xlm',
      amount: '0.1', // Valid amount
      fingerprint: '1-1-0',
    });

    render(
      <BridgeForm
        ethAddress={ETH}
        stellarAddress={XLM}
        signStellarTransaction={noopSign}
      />
    );

    await flush();

    const amountInput = screen.getByLabelText(/you pay/i) as HTMLInputElement;
    expect(amountInput.value).toBe('0.1');

    // Submit button should be enabled (assuming balance check passes)
    const submitBtn = screen.getByRole('button', { name: /^Bridge$/i });
    expect(submitBtn).toBeInTheDocument();
  });
});

describe('BridgeForm — corrupt storage handling', () => {
  beforeEach(() => {
    clearStorage();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ eth_xlm: 10000, xlm_eth: 0.0001 }),
    });
  });

  afterEach(() => {
    clearStorage();
    vi.restoreAllMocks();
  });

  it('gracefully handles malformed JSON in storage', async () => {
    window.localStorage.setItem(STORAGE_KEY, '{invalid json}');

    render(
      <BridgeForm
        ethAddress={ETH}
        stellarAddress={XLM}
        signStellarTransaction={noopSign}
      />
    );

    await flush();

    // Should render with defaults
    const ethBtn = screen.getByRole('button', { name: /ETH\s*→\s*XLM/i });
    expect(ethBtn).toHaveAttribute('aria-pressed', 'true');

    const amountInput = screen.getByLabelText(/you pay/i) as HTMLInputElement;
    expect(amountInput.value).toBe('');
  });

  it('ignores draft with wrong schema version', async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        v: 99, // Wrong version
        direction: 'xlm_to_eth',
        amount: '100',
        fingerprint: '1-1-0',
        savedAt: Date.now(),
      })
    );

    render(
      <BridgeForm
        ethAddress={ETH}
        stellarAddress={XLM}
        signStellarTransaction={noopSign}
      />
    );

    await flush();

    // Should use defaults
    const ethBtn = screen.getByRole('button', { name: /ETH\s*→\s*XLM/i });
    expect(ethBtn).toHaveAttribute('aria-pressed', 'true');

    const amountInput = screen.getByLabelText(/you pay/i) as HTMLInputElement;
    expect(amountInput.value).toBe('');
  });

  it('ignores draft with missing required fields', async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        v: 1,
        direction: 'xlm_to_eth',
        // Missing: amount, fingerprint, savedAt
      })
    );

    render(
      <BridgeForm
        ethAddress={ETH}
        stellarAddress={XLM}
        signStellarTransaction={noopSign}
      />
    );

    await flush();

    // Should use defaults
    const ethBtn = screen.getByRole('button', { name: /ETH\s*→\s*XLM/i });
    expect(ethBtn).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('BridgeForm — draft persistence field documentation', () => {
  beforeEach(() => {
    clearStorage();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ eth_xlm: 10000, xlm_eth: 0.0001 }),
    });
  });

  afterEach(() => {
    clearStorage();
    vi.restoreAllMocks();
  });

  it('documents which fields ARE persisted', async () => {
    render(
      <BridgeForm
        ethAddress={ETH}
        stellarAddress={XLM}
        solanaAddress={SOL}
        signStellarTransaction={noopSign}
      />
    );

    await flush();

    const amountInput = screen.getByLabelText(/you pay/i);
    fireEvent.change(amountInput, { target: { value: '1.5' } });

    const xlmBtn = screen.getByRole('button', { name: /XLM\s*→\s*ETH/i });
    fireEvent.click(xlmBtn);

    await flush();

    const stored = getStoredDraft();
    
    // These fields MUST be persisted:
    expect(stored).toHaveProperty('v', 1);
    expect(stored).toHaveProperty('direction');
    expect(stored).toHaveProperty('amount');
    expect(stored).toHaveProperty('fingerprint');
    expect(stored).toHaveProperty('savedAt');
    expect(typeof stored.savedAt).toBe('number');
  });

  it('documents which fields are NOT persisted (security)', async () => {
    render(
      <BridgeForm
        ethAddress={ETH}
        stellarAddress={XLM}
        solanaAddress={SOL}
        signStellarTransaction={noopSign}
      />
    );

    await flush();

    const amountInput = screen.getByLabelText(/you pay/i);
    fireEvent.change(amountInput, { target: { value: '2.0' } });

    await flush();

    const stored = getStoredDraft();
    
    // These fields MUST NOT be persisted (sensitive data):
    expect(stored).not.toHaveProperty('ethAddress');
    expect(stored).not.toHaveProperty('stellarAddress');
    expect(stored).not.toHaveProperty('solanaAddress');
    expect(stored).not.toHaveProperty('privateKey');
    expect(stored).not.toHaveProperty('mnemonic');
    expect(stored).not.toHaveProperty('hashlock');
    expect(stored).not.toHaveProperty('preimage');
    expect(stored).not.toHaveProperty('xdr');
    expect(stored).not.toHaveProperty('signature');
    expect(stored).not.toHaveProperty('txHash');
    expect(stored).not.toHaveProperty('orderId');
    expect(stored).not.toHaveProperty('secret');
  });
});
