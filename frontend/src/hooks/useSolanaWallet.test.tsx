import { renderHook, act, waitFor } from '@testing-library/react';
import { vi, beforeEach } from 'vitest';
import { useSolanaWallet } from './useSolanaWallet';

type Handler = (arg: unknown) => void;

function makePhantom() {
  const handlers: Record<string, Handler> = {};
  return {
    isPhantom: true,
    publicKey: { toString: () => 'SoLPubKey111' },
    isConnected: true,
    connect: vi.fn(async () => ({ publicKey: { toString: () => 'SoLPubKey111' } })),
    disconnect: vi.fn(async () => {}),
    signTransaction: vi.fn(),
    signAllTransactions: vi.fn(),
    on: (event: string, handler: Handler) => { handlers[event] = handler; },
    removeListener: (event: string) => { delete handlers[event]; },
    emit: (event: string, arg?: unknown) => handlers[event]?.(arg),
  };
}

describe('useSolanaWallet', () => {
  beforeEach(() => {
    (window as unknown as { phantom?: unknown }).phantom = undefined;
    (window as unknown as { solana?: unknown }).solana = undefined;
  });

  it('auto-connects when previously trusted and exposes the address', async () => {
    const provider = makePhantom();
    (window as unknown as { solana?: unknown }).solana = provider;

    const { result } = renderHook(() => useSolanaWallet());

    await waitFor(() => expect(result.current.isConnected).toBe(true));
    expect(result.current.address).toBe('SoLPubKey111');
  });

  it('recovers to a disconnected state on a provider disconnect event', async () => {
    const provider = makePhantom();
    (window as unknown as { solana?: unknown }).solana = provider;

    const { result } = renderHook(() => useSolanaWallet());
    await waitFor(() => expect(result.current.isConnected).toBe(true));

    act(() => { provider.emit('disconnect'); });

    expect(result.current.isConnected).toBe(false);
    expect(result.current.address).toBeNull();
  });

  it('re-syncs the address on an accountChanged event', async () => {
    const provider = makePhantom();
    (window as unknown as { solana?: unknown }).solana = provider;

    const { result } = renderHook(() => useSolanaWallet());
    await waitFor(() => expect(result.current.isConnected).toBe(true));

    act(() => { provider.emit('accountChanged', { toString: () => 'SoLPubKey222' }); });

    expect(result.current.address).toBe('SoLPubKey222');
  });
});
