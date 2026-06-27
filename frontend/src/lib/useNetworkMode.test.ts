/**
 * Tests for the useNetworkMode hook.
 *
 * Wallets (MetaMask + Freighter) are mocked so no real extensions are
 * required. isMainnetEnabled is mocked to return a controlled value.
 *
 * Coverage:
 *  - Default mode is testnet (no URL param, mainnet disabled)
 *  - hasAnyMismatch is false when no wallets are connected
 *  - setMode('mainnet') returns { ok: false, reason: 'mainnet-disabled' } when gated
 *  - setMode to same mode returns { ok: true } immediately
 *  - setMode('testnet') from testnet is a no-op (returns ok: true)
 *  - expectedEthChainIdHex is Sepolia for testnet mode
 *  - freighterConnected / metamaskConnected flags follow address presence
 *  - refreshWalletNetworks is callable without error
 */

import { renderHook, act } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// Keep freighter silent — Freighter API is not available in jsdom.
vi.mock('@stellar/freighter-api', () => ({
  default: {
    isConnected: vi.fn(async () => false),
    getNetwork: vi.fn(async () => null),
  },
}));

// Control the mainnet gate — default to disabled (mirrors CI/test env).
vi.mock('../config/networks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/networks')>();
  return {
    ...actual,
    isMainnetEnabled: vi.fn(() => false),
    isTestnet: vi.fn(() => true),
    resolveNetworkMode: vi.fn((m: string) => (m === 'mainnet' ? 'testnet' : m)),
  };
});

import { useNetworkMode } from './useNetworkMode';

const ETH_ADDR = '0x1111111111111111111111111111111111111111';
const XLM_ADDR = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422';

beforeEach(() => {
  // No injected wallet by default.
  Object.defineProperty(window, 'ethereum', {
    value: undefined,
    writable: true,
    configurable: true,
  });
  // Clear any ?network= query param.
  window.history.replaceState({}, '', '/');
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Default mode
// ---------------------------------------------------------------------------

describe('useNetworkMode — default state (no wallets)', () => {
  it('starts in testnet mode', () => {
    const { result } = renderHook(() =>
      useNetworkMode({ ethAddress: undefined, stellarAddress: undefined })
    );
    expect(result.current.mode).toBe('testnet');
  });

  it('has no wallet-mismatch when no wallets are connected', () => {
    const { result } = renderHook(() =>
      useNetworkMode({ ethAddress: undefined, stellarAddress: undefined })
    );
    expect(result.current.hasAnyMismatch).toBe(false);
  });

  it('reports metamaskConnected=false when no ethAddress is provided', () => {
    const { result } = renderHook(() =>
      useNetworkMode({ ethAddress: undefined, stellarAddress: undefined })
    );
    expect(result.current.metamaskConnected).toBe(false);
  });

  it('reports freighterConnected=false when no stellarAddress is provided', () => {
    const { result } = renderHook(() =>
      useNetworkMode({ ethAddress: undefined, stellarAddress: undefined })
    );
    expect(result.current.freighterConnected).toBe(false);
  });

  it('reports metamaskConnected=true when an ethAddress is provided', () => {
    const { result } = renderHook(() =>
      useNetworkMode({ ethAddress: ETH_ADDR, stellarAddress: undefined })
    );
    expect(result.current.metamaskConnected).toBe(true);
  });

  it('reports freighterConnected=true when a stellarAddress is provided', () => {
    const { result } = renderHook(() =>
      useNetworkMode({ ethAddress: undefined, stellarAddress: XLM_ADDR })
    );
    expect(result.current.freighterConnected).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// expectedEthChainIdHex
// ---------------------------------------------------------------------------

describe('useNetworkMode — chain ID expectations', () => {
  it('expectedEthChainIdHex is Sepolia (0xaa36a7) in testnet mode', () => {
    const { result } = renderHook(() =>
      useNetworkMode({ ethAddress: undefined, stellarAddress: undefined })
    );
    expect(result.current.expectedEthChainIdHex).toBe('0xaa36a7');
  });

  it('expectedStellarPassphrase is the testnet passphrase in testnet mode', () => {
    const { result } = renderHook(() =>
      useNetworkMode({ ethAddress: undefined, stellarAddress: undefined })
    );
    expect(result.current.expectedStellarPassphrase).toContain('Test SDF Network');
  });
});

// ---------------------------------------------------------------------------
// setMode — mainnet gating
// ---------------------------------------------------------------------------

describe('useNetworkMode — setMode mainnet gating', () => {
  it('setMode("mainnet") returns { ok: false, reason: "mainnet-disabled" } when gate is off', async () => {
    const { result } = renderHook(() =>
      useNetworkMode({ ethAddress: undefined, stellarAddress: undefined })
    );

    let outcome: { ok: boolean; reason?: string } = { ok: true };
    await act(async () => {
      outcome = await result.current.setMode('mainnet');
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('mainnet-disabled');
  });

  it('setMode("testnet") when already in testnet returns { ok: true }', async () => {
    const { result } = renderHook(() =>
      useNetworkMode({ ethAddress: undefined, stellarAddress: undefined })
    );

    let outcome: { ok: boolean; reason?: string } = { ok: false };
    await act(async () => {
      outcome = await result.current.setMode('testnet');
    });

    expect(outcome.ok).toBe(true);
  });

  it('mode remains testnet after a rejected mainnet setMode', async () => {
    const { result } = renderHook(() =>
      useNetworkMode({ ethAddress: undefined, stellarAddress: undefined })
    );

    await act(async () => {
      await result.current.setMode('mainnet');
    });

    expect(result.current.mode).toBe('testnet');
  });
});

// ---------------------------------------------------------------------------
// refreshWalletNetworks
// ---------------------------------------------------------------------------

describe('useNetworkMode — refreshWalletNetworks', () => {
  it('is callable without throwing', () => {
    const { result } = renderHook(() =>
      useNetworkMode({ ethAddress: undefined, stellarAddress: undefined })
    );
    expect(() => result.current.refreshWalletNetworks()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Wallet matching: no wallet = match by convention
// ---------------------------------------------------------------------------

describe('useNetworkMode — wallet match logic with no wallets', () => {
  it('metamaskMatches is true when metamask is not connected', () => {
    const { result } = renderHook(() =>
      useNetworkMode({ ethAddress: undefined, stellarAddress: undefined })
    );
    expect(result.current.metamaskMatches).toBe(true);
  });

  it('freighterMatches is true when freighter is not connected', () => {
    const { result } = renderHook(() =>
      useNetworkMode({ ethAddress: undefined, stellarAddress: undefined })
    );
    expect(result.current.freighterMatches).toBe(true);
  });
});
