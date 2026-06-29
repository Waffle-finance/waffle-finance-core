/**
 * useEthereumWallet.test.ts
 *
 * Tests focused on the browser-wallet compatibility improvements added in
 * issue #151: multi-provider selection, walletName exposure, and safe
 * removeListener handling.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useEthereumWallet } from './useEthereumWallet';
import type { Eip1193Provider } from '../lib/walletCompat';

// ---------------------------------------------------------------------------
// Provider factory helpers
// ---------------------------------------------------------------------------

function makeProvider(flags: Partial<Eip1193Provider> = {}, accounts: string[] = []): Eip1193Provider {
  return {
    request: vi.fn(async ({ method }: { method: string }) => {
      if (method === 'eth_accounts') return accounts;
      if (method === 'eth_chainId')  return '0x1';
      if (method === 'eth_requestAccounts') return accounts;
      return null;
    }),
    on: vi.fn(),
    removeListener: vi.fn(),
    ...flags,
  };
}

type WindowEth = { ethereum?: Eip1193Provider };

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let originalEthereum: Eip1193Provider | undefined;

beforeEach(() => {
  originalEthereum = (window as unknown as WindowEth).ethereum;
});

afterEach(() => {
  (window as unknown as WindowEth).ethereum = originalEthereum;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useEthereumWallet — compatibility', () => {
  it('sets isInstalled=false and surfaces an actionable error when no provider exists', async () => {
    (window as unknown as WindowEth).ethereum = undefined;

    const { result } = renderHook(() => useEthereumWallet());

    await waitFor(() => expect(result.current.phase).toBe('error'));
    expect(result.current.isInstalled).toBe(false);
    expect(result.current.walletName).toBeNull();
    expect(result.current.errorCode).toBe('ethereum_wallet_unavailable');
    expect(result.current.hint).toMatch(/MetaMask|Coinbase|Brave/);
  });

  it('detects MetaMask and sets walletName', async () => {
    const provider = makeProvider({ isMetaMask: true }, ['0xMetaMaskAddr']);
    (window as unknown as WindowEth).ethereum = provider;

    const { result } = renderHook(() => useEthereumWallet());

    await waitFor(() => expect(result.current.isConnected).toBe(true));
    expect(result.current.walletName).toBe('MetaMask');
    expect(result.current.address).toBe('0xMetaMaskAddr');
  });

  it('detects Coinbase Wallet and sets walletName', async () => {
    const provider = makeProvider({ isCoinbaseWallet: true }, ['0xCoinbaseAddr']);
    (window as unknown as WindowEth).ethereum = provider;

    const { result } = renderHook(() => useEthereumWallet());

    await waitFor(() => expect(result.current.isConnected).toBe(true));
    expect(result.current.walletName).toBe('Coinbase Wallet');
  });

  it('picks MetaMask over Coinbase Wallet from a providers[] array', async () => {
    const cb = makeProvider({ isCoinbaseWallet: true }, ['0xCoinbase']);
    const mm = makeProvider({ isMetaMask: true },       ['0xMetaMask']);
    // Aggregate provider (no accounts itself) that advertises both via providers[]
    const agg = makeProvider({ providers: [cb, mm] }, []);
    // Override request so that the aggregate delegates to mm
    (agg.request as ReturnType<typeof vi.fn>).mockImplementation(mm.request);
    (window as unknown as WindowEth).ethereum = agg;

    const { result } = renderHook(() => useEthereumWallet());

    await waitFor(() => expect(result.current.walletName).not.toBeNull());
    expect(result.current.walletName).toBe('MetaMask');
  });

  it('does not throw when the provider has no removeListener (Brave legacy)', async () => {
    const provider = makeProvider({ isMetaMask: false, isBraveWallet: true }, []);
    // Simulate a provider that doesn't implement removeListener
    delete (provider as { removeListener?: unknown }).removeListener;
    (window as unknown as WindowEth).ethereum = provider;

    const { result, unmount } = renderHook(() => useEthereumWallet());

    await waitFor(() => expect(result.current.phase).not.toBe('checking'));
    // Unmounting should not throw even though removeListener is absent
    expect(() => unmount()).not.toThrow();
  });

  it('includes the wallet name in user-facing error messages on connect failure', async () => {
    const provider = makeProvider({ isMetaMask: true }, []);
    (provider.request as ReturnType<typeof vi.fn>).mockImplementation(async ({ method }: { method: string }) => {
      if (method === 'eth_accounts') return [];
      if (method === 'eth_requestAccounts') throw Object.assign(new Error('User rejected'), { code: 4001 });
      return null;
    });
    (window as unknown as WindowEth).ethereum = provider;

    const { result } = renderHook(() => useEthereumWallet());
    await waitFor(() => expect(result.current.phase).toBe('idle'));

    await result.current.connect();

    await waitFor(() => expect(result.current.phase).toBe('error'));
    expect(result.current.hint).toContain('MetaMask');
  });

  it('surfaces a capability-unsupported error from switchChain gracefully', async () => {
    const provider = makeProvider({ isMetaMask: true }, ['0xAddr']);
    (window as unknown as WindowEth).ethereum = provider;

    const { result } = renderHook(() => useEthereumWallet());
    await waitFor(() => expect(result.current.isConnected).toBe(true));

    // Override request to simulate wallet_switchEthereumChain rejection by user
    (provider.request as ReturnType<typeof vi.fn>).mockImplementation(async ({ method }: { method: string }) => {
      if (method === 'wallet_switchEthereumChain') {
        throw Object.assign(new Error('User rejected'), { code: 4001 });
      }
      return null;
    });

    const switched = await result.current.switchChain('0xaa36a7');
    // 4001 = user rejected, not an error state — just returns false
    expect(switched).toBe(false);
    expect(result.current.phase).toBe('connected'); // no error transition
  });
});
