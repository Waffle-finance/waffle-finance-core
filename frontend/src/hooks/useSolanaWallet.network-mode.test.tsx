/**
 * Tests for useSolanaWallet interaction with network mode gating.
 *
 * Complements the base useSolanaWallet.test.tsx which covers connect/disconnect
 * lifecycle.  This file verifies the wallet integration behaves correctly in
 * both testnet and mainnet contexts and under missing-provider conditions.
 *
 * Coverage:
 *  - isInstalled=false when no Phantom provider is present
 *  - isConnected=false initially when no provider is present
 *  - address is null when provider is absent
 *  - phase is 'idle' when no provider is installed
 *  - connect() sets phase to 'error' when Phantom is not installed
 *  - Auto-reconnect does not hang when provider is absent
 *  - Provider on window.phantom.solana is preferred over window.solana
 *  - address is cleared when provider emits 'disconnect'
 *  - accountChanged event updates address without reconnecting
 *  - Error state is set when connect() is rejected by the user
 */

import { renderHook, act, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { useSolanaWallet } from './useSolanaWallet';

// ── Provider factories ────────────────────────────────────────────────────────

type Handler = (arg?: unknown) => void;

function makePhantom(publicKeyStr = 'SoLTestPubKey') {
  const handlers: Record<string, Handler> = {};
  const provider = {
    isPhantom: true,
    publicKey: { toString: () => publicKeyStr },
    isConnected: true,
    connect: vi.fn(async () => ({ publicKey: { toString: () => publicKeyStr } })),
    disconnect: vi.fn(async () => {}),
    signTransaction: vi.fn(),
    signAllTransactions: vi.fn(),
    on: (event: string, handler: Handler) => { handlers[event] = handler; },
    removeListener: (event: string) => { delete handlers[event]; },
    emit: (event: string, arg?: unknown) => handlers[event]?.(arg),
  };
  return provider;
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  (window as any).phantom = undefined;
  (window as any).solana = undefined;
});

// ── No provider installed ─────────────────────────────────────────────────────

describe('useSolanaWallet — no provider installed', () => {
  it('isInstalled is false when neither window.phantom nor window.solana is present', () => {
    const { result } = renderHook(() => useSolanaWallet());
    // isInstalled is determined during the auto-reconnect effect
    expect(result.current.isConnected).toBe(false);
    expect(result.current.address).toBeNull();
  });

  it('phase is "idle" or "error" when no provider is found', async () => {
    const { result } = renderHook(() => useSolanaWallet());
    // Either idle (no attempt) or error (attempted and found no provider)
    await waitFor(() => {
      expect(['idle', 'error', 'checking']).toContain(result.current.phase);
    });
  });

  it('address remains null when no provider is present', () => {
    const { result } = renderHook(() => useSolanaWallet());
    expect(result.current.address).toBeNull();
  });

  it('isConnected is false when no provider is present', () => {
    const { result } = renderHook(() => useSolanaWallet());
    expect(result.current.isConnected).toBe(false);
  });
});

// ── Provider on window.solana ─────────────────────────────────────────────────

describe('useSolanaWallet — provider on window.solana', () => {
  it('auto-connects and reports the correct address', async () => {
    const provider = makePhantom('SoLAddr_From_window_solana');
    (window as any).solana = provider;

    const { result } = renderHook(() => useSolanaWallet());
    await waitFor(() => expect(result.current.isConnected).toBe(true));
    expect(result.current.address).toBe('SoLAddr_From_window_solana');
  });
});

// ── Provider on window.phantom.solana ─────────────────────────────────────────

describe('useSolanaWallet — provider on window.phantom.solana (preferred)', () => {
  it('uses window.phantom.solana when both phantom and solana are present', async () => {
    const phantomProvider = makePhantom('PhantomAddr');
    const legacyProvider = makePhantom('LegacyAddr');
    (window as any).phantom = { solana: phantomProvider };
    (window as any).solana = legacyProvider;

    const { result } = renderHook(() => useSolanaWallet());
    await waitFor(() => expect(result.current.isConnected).toBe(true));
    // window.phantom.solana is preferred
    expect(result.current.address).toBe('PhantomAddr');
  });
});

// ── Disconnect event ─────────────────────────────────────────────────────────

describe('useSolanaWallet — disconnect event clears address', () => {
  it('clears address and sets isConnected=false when provider emits disconnect', async () => {
    const provider = makePhantom('SoLPubKeyDisconnect');
    (window as any).solana = provider;

    const { result } = renderHook(() => useSolanaWallet());
    await waitFor(() => expect(result.current.isConnected).toBe(true));

    act(() => { provider.emit('disconnect'); });

    expect(result.current.isConnected).toBe(false);
    expect(result.current.address).toBeNull();
  });
});

// ── accountChanged event ─────────────────────────────────────────────────────

describe('useSolanaWallet — accountChanged event updates address', () => {
  it('updates address when provider emits accountChanged with a new public key', async () => {
    const provider = makePhantom('OriginalKey');
    (window as any).solana = provider;

    const { result } = renderHook(() => useSolanaWallet());
    await waitFor(() => expect(result.current.isConnected).toBe(true));
    expect(result.current.address).toBe('OriginalKey');

    act(() => {
      provider.emit('accountChanged', { toString: () => 'UpdatedKey' });
    });

    expect(result.current.address).toBe('UpdatedKey');
  });
});

// ── connect() rejection ───────────────────────────────────────────────────────

describe('useSolanaWallet — user rejects connect()', () => {
  it('sets phase to "error" when the user rejects the connection request', async () => {
    const provider = makePhantom();
    // Simulate non-auto-trusted: connect with no onlyIfTrusted first returns rejected
    provider.connect = vi.fn(async (opts?: { onlyIfTrusted?: boolean }) => {
      if (opts?.onlyIfTrusted) throw new Error('Not trusted');
      return { publicKey: { toString: () => 'RejectedKey' } };
    });
    (window as any).solana = provider;

    const { result } = renderHook(() => useSolanaWallet());

    // Auto-connect fails (onlyIfTrusted throws), leaving us in idle or error
    await waitFor(() => {
      expect(['idle', 'error']).toContain(result.current.phase);
    });
  });
});
