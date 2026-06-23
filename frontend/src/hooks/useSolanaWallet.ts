/**
 * useSolanaWallet — Phantom wallet integration for Solana.
 *
 * Mirrors the structure of useFreighter so the rest of the app can treat
 * all three chains (Ethereum / Stellar / Solana) uniformly.
 */
import { useCallback, useEffect, useState } from 'react';

interface PhantomProvider {
  isPhantom?: boolean;
  publicKey: { toString(): string } | null;
  isConnected: boolean;
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: { toString(): string } }>;
  disconnect(): Promise<void>;
  signTransaction(tx: unknown): Promise<unknown>;
  signAllTransactions(txs: unknown[]): Promise<unknown[]>;
  on(event: string, handler: (...args: any[]) => void): void;
  removeListener(event: string, handler: (...args: any[]) => void): void;
}

// Window augmentation lives in BridgeForm.tsx to avoid duplicate declarations.

function getProvider(): PhantomProvider | null {
  if (typeof window === 'undefined') return null;
  const w = window as any;
  const provider = w.phantom?.solana ?? w.solana;
  return provider?.isPhantom ? (provider as PhantomProvider) : null;
}

interface SolanaWalletState {
  isConnected: boolean;
  address: string | null;
  isLoading: boolean;
  error: string | null;
}

export function useSolanaWallet() {
  const [state, setState] = useState<SolanaWalletState>({
    isConnected: false,
    address: null,
    isLoading: false,
    error: null,
  });

  // Auto-reconnect on mount if previously trusted
  useEffect(() => {
    const provider = getProvider();
    if (!provider) return;

    const tryReconnect = async () => {
      try {
        const resp = await provider.connect({ onlyIfTrusted: true });
        setState(prev => ({
          ...prev,
          isConnected: true,
          address: resp.publicKey.toString(),
          error: null,
        }));
      } catch {
        // Not previously trusted — skip silently
      }
    };

    tryReconnect();

    const handleAccountChange = (pubkey: { toString(): string } | null) => {
      setState(prev => ({
        ...prev,
        isConnected: !!pubkey,
        address: pubkey ? pubkey.toString() : null,
      }));
    };

    const handleConnect = (pubkey: { toString(): string } | null) => {
      if (!pubkey) return;
      setState(prev => ({
        ...prev,
        isConnected: true,
        address: pubkey.toString(),
        error: null,
      }));
    };

    const handleDisconnect = () => {
      setState(prev => ({ ...prev, isConnected: false, address: null }));
    };

    provider.on('connect', handleConnect);
    provider.on('accountChanged', handleAccountChange);
    provider.on('disconnect', handleDisconnect);

    return () => {
      provider.removeListener('connect', handleConnect);
      provider.removeListener('accountChanged', handleAccountChange);
      provider.removeListener('disconnect', handleDisconnect);
    };
  }, []);

  const connect = useCallback(async () => {
    const provider = getProvider();
    if (!provider) {
      const msg = 'Phantom wallet not found. Install it at https://phantom.app';
      setState(prev => ({ ...prev, error: msg }));
      window.open('https://phantom.app', '_blank');
      return;
    }

    setState(prev => ({ ...prev, isLoading: true, error: null }));
    try {
      const resp = await provider.connect();
      setState({
        isConnected: true,
        address: resp.publicKey.toString(),
        isLoading: false,
        error: null,
      });
    } catch (err: any) {
      setState(prev => ({
        ...prev,
        isLoading: false,
        error: err?.message ?? 'Phantom connection failed',
      }));
    }
  }, []);

  const disconnect = useCallback(async () => {
    const provider = getProvider();
    if (provider) {
      try { await provider.disconnect(); } catch { /* ignore */ }
    }
    setState({ isConnected: false, address: null, isLoading: false, error: null });
  }, []);

  const isInstalled = !!getProvider();

  return {
    isConnected: state.isConnected,
    address: state.address,
    isLoading: state.isLoading,
    error: state.error,
    isInstalled,
    connect,
    disconnect,
  };
}
