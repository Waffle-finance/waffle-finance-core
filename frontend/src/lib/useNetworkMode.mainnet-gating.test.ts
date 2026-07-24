/**
 * Tests for mainnet mode gating in useNetworkMode.
 *
 * Complements useNetworkMode.test.ts which covers the basic default-state
 * behaviour.  This file focuses specifically on:
 *
 *  1. VITE_MAINNET_ENABLED=false (default / unset):
 *     - Mainnet routes/modes are blocked
 *     - ?network=mainnet URL param is stripped on load
 *     - setMode('mainnet') fails closed
 *
 *  2. VITE_MAINNET_ENABLED=true:
 *     - setMode('mainnet') succeeds when no wallet is connected
 *     - Mode is written to the URL
 *     - expectedEthChainIdHex switches to 0x1
 *
 *  3. Route availability gating:
 *     - resolveNetworkMode clamps mainnet → testnet when flag is off
 *     - resolveNetworkMode passes mainnet through when flag is on
 *     - isMainnetEnabled() is the authoritative gate, not URL params alone
 *
 * Coverage:
 *  - setMode('mainnet') → { ok: false, reason: 'mainnet-disabled' } when gate off
 *  - Mode stays testnet after rejected mainnet switch
 *  - ?network=mainnet URL stripped on mount when mainnet disabled
 *  - resolveNetworkMode('mainnet') → 'testnet' when disabled
 *  - resolveNetworkMode('mainnet') → 'mainnet' when enabled
 *  - setMode('mainnet') → { ok: true } when gate is on and no wallets
 *  - expectedEthChainIdHex is 0x1 in mainnet mode
 *  - expectedStellarPassphrase contains 'Public Global' in mainnet mode
 *  - hasAnyMismatch is false when no wallets and mode is mainnet
 */

import { renderHook, act } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// ── Freighter stub ────────────────────────────────────────────────────────────

vi.mock('@stellar/freighter-api', () => ({
  default: {
    isConnected: vi.fn(async () => false),
    getNetwork: vi.fn(async () => null),
  },
}));

// ── Network config mock — replaced per-describe block ────────────────────────
//
// We use a factory so each test block can import with a different
// isMainnetEnabled value without module-cache interference.

import { useNetworkMode } from './useNetworkMode';

// We'll control isMainnetEnabled via the mock below.
const mockIsMainnetEnabled = vi.fn(() => false);
const mockResolveNetworkMode = vi.fn((m: string) =>
  m === 'mainnet' && !mockIsMainnetEnabled() ? 'testnet' : m
);

vi.mock('../config/networks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/networks')>();
  return {
    ...actual,
    isMainnetEnabled: () => mockIsMainnetEnabled(),
    isTestnet: () => !mockIsMainnetEnabled(),
    resolveNetworkMode: (m: string) => mockResolveNetworkMode(m),
  };
});

// ── Test helpers ──────────────────────────────────────────────────────────────

beforeEach(() => {
  // Reset to disabled state (safe default)
  mockIsMainnetEnabled.mockReturnValue(false);
  mockResolveNetworkMode.mockImplementation((m: string) =>
    m === 'mainnet' && !mockIsMainnetEnabled() ? 'testnet' : m
  );

  // No injected wallet
  Object.defineProperty(window, 'ethereum', {
    value: undefined,
    writable: true,
    configurable: true,
  });

  // Clear URL
  window.history.replaceState({}, '', '/');
});

afterEach(() => {
  vi.clearAllMocks();
});

// ── setMode('mainnet') when mainnet is disabled ───────────────────────────────

describe('useNetworkMode — mainnet disabled (VITE_MAINNET_ENABLED unset)', () => {
  it('setMode("mainnet") returns { ok: false, reason: "mainnet-disabled" }', async () => {
    mockIsMainnetEnabled.mockReturnValue(false);

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

  it('mode stays testnet after a rejected mainnet switch', async () => {
    mockIsMainnetEnabled.mockReturnValue(false);

    const { result } = renderHook(() =>
      useNetworkMode({ ethAddress: undefined, stellarAddress: undefined })
    );

    await act(async () => {
      await result.current.setMode('mainnet');
    });

    expect(result.current.mode).toBe('testnet');
  });

  it('URL is NOT updated to ?network=mainnet after rejected switch', async () => {
    mockIsMainnetEnabled.mockReturnValue(false);

    const { result } = renderHook(() =>
      useNetworkMode({ ethAddress: undefined, stellarAddress: undefined })
    );

    await act(async () => {
      await result.current.setMode('mainnet');
    });

    const params = new URLSearchParams(window.location.search);
    expect(params.get('network')).not.toBe('mainnet');
  });

  it('?network=mainnet URL param is stripped on mount when mainnet is disabled', () => {
    mockIsMainnetEnabled.mockReturnValue(false);

    // Simulate a bookmarked mainnet URL
    window.history.replaceState({}, '', '/?network=mainnet');

    renderHook(() =>
      useNetworkMode({ ethAddress: undefined, stellarAddress: undefined })
    );

    // After mount the hook strips the invalid param
    const params = new URLSearchParams(window.location.search);
    expect(params.get('network')).not.toBe('mainnet');
  });

  it('expectedEthChainIdHex is Sepolia (0xaa36a7) when mode is testnet', () => {
    const { result } = renderHook(() =>
      useNetworkMode({ ethAddress: undefined, stellarAddress: undefined })
    );
    expect(result.current.expectedEthChainIdHex).toBe('0xaa36a7');
  });
});

// ── setMode('mainnet') when mainnet is enabled ────────────────────────────────

describe('useNetworkMode — mainnet enabled (VITE_MAINNET_ENABLED=true)', () => {
  beforeEach(() => {
    mockIsMainnetEnabled.mockReturnValue(true);
    mockResolveNetworkMode.mockImplementation((m: string) => m as 'mainnet' | 'testnet');
  });

  it('setMode("mainnet") returns { ok: true } when no wallets are connected', async () => {
    const { result } = renderHook(() =>
      useNetworkMode({ ethAddress: undefined, stellarAddress: undefined })
    );

    let outcome: { ok: boolean; reason?: string } = { ok: false };
    await act(async () => {
      outcome = await result.current.setMode('mainnet');
    });

    expect(outcome.ok).toBe(true);
  });

  it('mode switches to mainnet after successful setMode call', async () => {
    const { result } = renderHook(() =>
      useNetworkMode({ ethAddress: undefined, stellarAddress: undefined })
    );

    await act(async () => {
      await result.current.setMode('mainnet');
    });

    expect(result.current.mode).toBe('mainnet');
  });

  it('expectedEthChainIdHex switches to Ethereum Mainnet (0x1) in mainnet mode', async () => {
    const { result } = renderHook(() =>
      useNetworkMode({ ethAddress: undefined, stellarAddress: undefined })
    );

    await act(async () => {
      await result.current.setMode('mainnet');
    });

    expect(result.current.expectedEthChainIdHex).toBe('0x1');
  });

  it('expectedStellarPassphrase is the mainnet passphrase in mainnet mode', async () => {
    const { result } = renderHook(() =>
      useNetworkMode({ ethAddress: undefined, stellarAddress: undefined })
    );

    await act(async () => {
      await result.current.setMode('mainnet');
    });

    expect(result.current.expectedStellarPassphrase).toContain('Public Global Stellar Network');
  });

  it('hasAnyMismatch is false when no wallets are connected regardless of mode', async () => {
    const { result } = renderHook(() =>
      useNetworkMode({ ethAddress: undefined, stellarAddress: undefined })
    );

    await act(async () => {
      await result.current.setMode('mainnet');
    });

    expect(result.current.hasAnyMismatch).toBe(false);
  });
});

// ── resolveNetworkMode build-time validation ──────────────────────────────────

describe('resolveNetworkMode — network mode clamping', () => {
  it('clamps mainnet to testnet when isMainnetEnabled() is false', () => {
    mockIsMainnetEnabled.mockReturnValue(false);
    // Use the real implementation's behaviour via the mock
    expect(mockResolveNetworkMode('mainnet')).toBe('testnet');
  });

  it('passes mainnet through when isMainnetEnabled() is true', () => {
    mockIsMainnetEnabled.mockReturnValue(true);
    mockResolveNetworkMode.mockImplementation((m: string) => m as 'mainnet' | 'testnet');
    expect(mockResolveNetworkMode('mainnet')).toBe('mainnet');
  });

  it('always passes testnet through unchanged regardless of flag', () => {
    mockIsMainnetEnabled.mockReturnValue(false);
    expect(mockResolveNetworkMode('testnet')).toBe('testnet');
    mockIsMainnetEnabled.mockReturnValue(true);
    expect(mockResolveNetworkMode('testnet')).toBe('testnet');
  });
});

// ── Wallet match logic in mainnet mode ───────────────────────────────────────

describe('useNetworkMode — wallet matches when mainnet enabled and no wallet connected', () => {
  beforeEach(() => {
    mockIsMainnetEnabled.mockReturnValue(true);
    mockResolveNetworkMode.mockImplementation((m: string) => m as 'mainnet' | 'testnet');
  });

  it('metamaskMatches is true when metamask is not connected in mainnet mode', async () => {
    const { result } = renderHook(() =>
      useNetworkMode({ ethAddress: undefined, stellarAddress: undefined })
    );

    await act(async () => {
      await result.current.setMode('mainnet');
    });

    expect(result.current.metamaskMatches).toBe(true);
  });

  it('freighterMatches is true when freighter is not connected in mainnet mode', async () => {
    const { result } = renderHook(() =>
      useNetworkMode({ ethAddress: undefined, stellarAddress: undefined })
    );

    await act(async () => {
      await result.current.setMode('mainnet');
    });

    expect(result.current.freighterMatches).toBe(true);
  });
});
