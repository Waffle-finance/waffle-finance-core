/**
 * walletCompat.test.ts
 *
 * Unit tests for the shared wallet-extension compatibility utilities.
 * These tests exercise pure functions — no React, no network, no real extensions.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getEthWalletName,
  pickBestEthProvider,
  detectEthereumProvider,
  probeEthCapabilities,
  safeRemoveListener,
  getSolanaWalletName,
  detectSolanaProvider,
  safeRemoveSolanaListener,
  type Eip1193Provider,
  type SolanaProvider,
} from './walletCompat';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEthProvider(flags: Partial<Eip1193Provider> = {}): Eip1193Provider {
  return {
    request: async () => null,
    on: () => {},
    removeListener: () => {},
    ...flags,
  };
}

function makeSolanaProvider(flags: Partial<SolanaProvider> = {}): SolanaProvider {
  return {
    publicKey: null,
    isConnected: false,
    connect: async () => ({ publicKey: { toString: () => 'PUBKEY' } }),
    disconnect: async () => {},
    signTransaction: async (tx: unknown) => tx,
    signAllTransactions: async (txs: unknown[]) => txs,
    on: () => {},
    removeListener: () => {},
    ...flags,
  };
}

// ---------------------------------------------------------------------------
// getEthWalletName
// ---------------------------------------------------------------------------

describe('getEthWalletName', () => {
  it('returns MetaMask for isMetaMask', () => {
    expect(getEthWalletName(makeEthProvider({ isMetaMask: true }))).toBe('MetaMask');
  });

  it('returns Brave Wallet for isBraveWallet (takes priority over isMetaMask)', () => {
    // Brave injects both flags; isBraveWallet should win.
    expect(getEthWalletName(makeEthProvider({ isBraveWallet: true, isMetaMask: true }))).toBe('Brave Wallet');
  });

  it('returns Coinbase Wallet for isCoinbaseWallet', () => {
    expect(getEthWalletName(makeEthProvider({ isCoinbaseWallet: true }))).toBe('Coinbase Wallet');
  });

  it('returns Rainbow for isRainbow', () => {
    expect(getEthWalletName(makeEthProvider({ isRainbow: true }))).toBe('Rainbow');
  });

  it('returns Trust Wallet for isTrust', () => {
    expect(getEthWalletName(makeEthProvider({ isTrust: true }))).toBe('Trust Wallet');
  });

  it('returns OKX Wallet for isOkxWallet', () => {
    expect(getEthWalletName(makeEthProvider({ isOkxWallet: true }))).toBe('OKX Wallet');
  });

  it('returns generic fallback when no flags are set', () => {
    expect(getEthWalletName(makeEthProvider())).toBe('Ethereum Wallet');
  });
});

// ---------------------------------------------------------------------------
// pickBestEthProvider
// ---------------------------------------------------------------------------

describe('pickBestEthProvider', () => {
  it('prefers MetaMask over an unknown provider', () => {
    const mm = makeEthProvider({ isMetaMask: true });
    const unknown = makeEthProvider();
    expect(pickBestEthProvider([unknown, mm])).toBe(mm);
  });

  it('prefers Coinbase Wallet when MetaMask is absent', () => {
    const cb = makeEthProvider({ isCoinbaseWallet: true });
    const rb = makeEthProvider({ isRainbow: true });
    expect(pickBestEthProvider([rb, cb])).toBe(cb);
  });

  it('falls back to first entry when no known flags match', () => {
    const a = makeEthProvider();
    const b = makeEthProvider();
    expect(pickBestEthProvider([a, b])).toBe(a);
  });
});

// ---------------------------------------------------------------------------
// detectEthereumProvider
// ---------------------------------------------------------------------------

describe('detectEthereumProvider', () => {
  const originalEthereum = (window as unknown as { ethereum?: Eip1193Provider }).ethereum;

  afterEach(() => {
    (window as unknown as { ethereum?: Eip1193Provider }).ethereum = originalEthereum;
  });

  it('returns null when window.ethereum is absent', () => {
    (window as unknown as { ethereum?: undefined }).ethereum = undefined;
    expect(detectEthereumProvider()).toBeNull();
  });

  it('returns null when window.ethereum has no request method', () => {
    (window as unknown as { ethereum?: object }).ethereum = { on: () => {} };
    expect(detectEthereumProvider()).toBeNull();
  });

  it('detects a single MetaMask provider', () => {
    const mm = makeEthProvider({ isMetaMask: true });
    (window as unknown as { ethereum?: Eip1193Provider }).ethereum = mm;
    const result = detectEthereumProvider();
    expect(result).not.toBeNull();
    expect(result!.walletName).toBe('MetaMask');
    expect(result!.provider).toBe(mm);
  });

  it('picks the best provider from the providers[] array', () => {
    const cb  = makeEthProvider({ isCoinbaseWallet: true });
    const mm  = makeEthProvider({ isMetaMask: true });
    const agg = makeEthProvider({ providers: [cb, mm] });
    (window as unknown as { ethereum?: Eip1193Provider }).ethereum = agg;
    const result = detectEthereumProvider();
    expect(result).not.toBeNull();
    // MetaMask wins over Coinbase Wallet in priority order
    expect(result!.walletName).toBe('MetaMask');
    expect(result!.provider).toBe(mm);
  });

  it('returns Coinbase Wallet name when that is the only provider', () => {
    const cb = makeEthProvider({ isCoinbaseWallet: true });
    (window as unknown as { ethereum?: Eip1193Provider }).ethereum = cb;
    const result = detectEthereumProvider();
    expect(result!.walletName).toBe('Coinbase Wallet');
  });
});

// ---------------------------------------------------------------------------
// probeEthCapabilities
// ---------------------------------------------------------------------------

describe('probeEthCapabilities', () => {
  it('reports removeListener support when the method exists', () => {
    const p = makeEthProvider({ removeListener: () => {} });
    expect(probeEthCapabilities(p).supportsRemoveListener).toBe(true);
  });

  it('reports no removeListener support when the method is absent', () => {
    const p = makeEthProvider();
    delete (p as { removeListener?: unknown }).removeListener;
    expect(probeEthCapabilities(p).supportsRemoveListener).toBe(false);
  });

  it('reports chain switch as supported for standard providers', () => {
    expect(probeEthCapabilities(makeEthProvider()).supportsChainSwitch).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// safeRemoveListener
// ---------------------------------------------------------------------------

describe('safeRemoveListener', () => {
  it('calls removeListener when available', () => {
    let called = false;
    const p = makeEthProvider({ removeListener: () => { called = true; } });
    safeRemoveListener(p, 'accountsChanged', () => {});
    expect(called).toBe(true);
  });

  it('does not throw when removeListener is absent', () => {
    const p = makeEthProvider();
    delete (p as { removeListener?: unknown }).removeListener;
    expect(() => safeRemoveListener(p, 'accountsChanged', () => {})).not.toThrow();
  });

  it('does not throw when removeListener itself throws', () => {
    const p = makeEthProvider({ removeListener: () => { throw new Error('boom'); } });
    expect(() => safeRemoveListener(p, 'accountsChanged', () => {})).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// getSolanaWalletName
// ---------------------------------------------------------------------------

describe('getSolanaWalletName', () => {
  it('returns Phantom for isPhantom', () => {
    expect(getSolanaWalletName(makeSolanaProvider({ isPhantom: true }))).toBe('Phantom');
  });

  it('returns Solflare for isSolflare', () => {
    expect(getSolanaWalletName(makeSolanaProvider({ isSolflare: true }))).toBe('Solflare');
  });

  it('returns Backpack for isBackpack', () => {
    expect(getSolanaWalletName(makeSolanaProvider({ isBackpack: true }))).toBe('Backpack');
  });

  it('returns generic fallback', () => {
    expect(getSolanaWalletName(makeSolanaProvider())).toBe('Solana Wallet');
  });
});

// ---------------------------------------------------------------------------
// detectSolanaProvider
// ---------------------------------------------------------------------------

type WindowExt = {
  phantom?: { solana?: SolanaProvider };
  solflare?: SolanaProvider;
  backpack?: SolanaProvider;
  solana?: SolanaProvider;
};

describe('detectSolanaProvider', () => {
  let saved: WindowExt;

  beforeEach(() => {
    const w = window as unknown as WindowExt;
    saved = { phantom: w.phantom, solflare: w.solflare, backpack: w.backpack, solana: w.solana };
    delete w.phantom;
    delete w.solflare;
    delete w.backpack;
    delete w.solana;
  });

  afterEach(() => {
    const w = window as unknown as WindowExt;
    w.phantom  = saved.phantom;
    w.solflare = saved.solflare;
    w.backpack = saved.backpack;
    w.solana   = saved.solana;
  });

  it('returns null when no Solana provider is present', () => {
    expect(detectSolanaProvider()).toBeNull();
  });

  it('detects Phantom via window.phantom.solana', () => {
    const p = makeSolanaProvider({ isPhantom: true });
    (window as unknown as WindowExt).phantom = { solana: p };
    const result = detectSolanaProvider();
    expect(result).not.toBeNull();
    expect(result!.walletName).toBe('Phantom');
    expect(result!.provider).toBe(p);
  });

  it('detects Solflare via window.solflare', () => {
    const p = makeSolanaProvider({ isSolflare: true });
    (window as unknown as WindowExt).solflare = p;
    const result = detectSolanaProvider();
    expect(result!.walletName).toBe('Solflare');
  });

  it('detects Backpack via window.backpack', () => {
    const p = makeSolanaProvider({ isBackpack: true });
    (window as unknown as WindowExt).backpack = p;
    const result = detectSolanaProvider();
    expect(result!.walletName).toBe('Backpack');
  });

  it('falls back to window.solana (Phantom legacy)', () => {
    const p = makeSolanaProvider({ isPhantom: true });
    (window as unknown as WindowExt).solana = p;
    const result = detectSolanaProvider();
    expect(result!.walletName).toBe('Phantom');
  });

  it('prefers window.phantom.solana over window.solana', () => {
    const namespaced = makeSolanaProvider({ isPhantom: true });
    const legacy     = makeSolanaProvider({ isPhantom: true });
    (window as unknown as WindowExt).phantom = { solana: namespaced };
    (window as unknown as WindowExt).solana  = legacy;
    expect(detectSolanaProvider()!.provider).toBe(namespaced);
  });
});

// ---------------------------------------------------------------------------
// safeRemoveSolanaListener
// ---------------------------------------------------------------------------

describe('safeRemoveSolanaListener', () => {
  it('calls removeListener when available', () => {
    let called = false;
    const p = makeSolanaProvider({ removeListener: () => { called = true; } });
    safeRemoveSolanaListener(p, 'disconnect', () => {});
    expect(called).toBe(true);
  });

  it('does not throw when removeListener is absent', () => {
    const p = makeSolanaProvider();
    delete (p as { removeListener?: unknown }).removeListener;
    expect(() => safeRemoveSolanaListener(p, 'disconnect', () => {})).not.toThrow();
  });
});
