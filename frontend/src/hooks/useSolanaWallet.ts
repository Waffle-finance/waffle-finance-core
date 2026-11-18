/**
 * useSolanaWallet — Phantom wallet integration for Solana.
 *
 * Mirrors the structure of useFreighter so the rest of the app can treat
 * all three chains (Ethereum / Stellar / Solana) uniformly.
 */
import { useCallback, useEffect, useState } from 'react';

export type ConnectionPhase = 'idle' | 'checking' | 'requesting_permission' | 'connected' | 'error';

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
  errorCode: string | null;
  hint: string | null;
  phase: ConnectionPhase;
  lastTransitionAt: number | null;
  isInstalled: boolean;
}

const INITIAL_STATE: SolanaWalletState = {
  isConnected: false,
  address: null,
  isLoading: false,
  error: null,
  errorCode: null,
  hint: null,
  phase: 'idle',
  lastTransitionAt: null,
  isInstalled: false,
};

function transition(prev: SolanaWalletState, patch: Partial<SolanaWalletState>): SolanaWalletState {
  return {
    ...prev,
    ...patch,
    lastTransitionAt: Date.now(),
    phase: patch.phase ?? prev.phase,
  };
}

export function useSolanaWallet() {
  const [state, setState] = useState<SolanaWalletState>(INITIAL_STATE);

  const setError = useCallback((code: string, message: string, hint?: string) => {
    setState((prev) =>
      transition(prev, {
        error: message,
        errorCode: code,
        hint: hint ?? prev.hint,
        phase: 'error',
        isLoading: false,
      })
    );
  }, []);

  // Auto-reconnect on mount if previously trusted
  useEffect(() => {
    const provider = getProvider();
    if (!provider) {
      setState((prev) => transition(prev, { isInstalled: false }));
      return;
    }

    setState((prev) => transition(prev, { isInstalled: true, phase: 'checking' }));

    const tryReconnect = async () => {
      try {
        const resp = await provider.connect({ onlyIfTrusted: true });
        setState((prev) =>
          transition(prev, {
            isConnected: true,
            address: resp.publicKey.toString(),
            error: null,
            errorCode: null,
            hint: null,
            phase: 'connected',
          })
        );
      } catch {
        // Not previously trusted — skip silently
        setState((prev) => transition(prev, { phase: 'idle' }));
      }
    };

    tryReconnect();

    const handleAccountChange = (pubkey: { toString(): string } | null) => {
      setState((prev) => {
        if (!pubkey) {
          return transition(prev, {
            isConnected: false,
            address: null,
            phase: 'idle',
          });
        }
        return transition(prev, {
          isConnected: true,
          address: pubkey.toString(),
          error: null,
          errorCode: null,
          hint: null,
          phase: 'connected',
        });
      });
    };

    const handleConnect = (pubkey?: { toString(): string } | null) => {
      const key = pubkey ?? provider.publicKey;
      if (!key) return;
      setState((prev) =>
        transition(prev, {
          isConnected: true,
          address: key.toString(),
          error: null,
          errorCode: null,
          hint: null,
          phase: 'connected',
        })
      );
    };

    const handleDisconnect = () => {
      setState((prev) => transition(prev, { isConnected: false, address: null, phase: 'idle' }));
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
      setError('phantom_unavailable', msg, 'Install the Phantom browser extension and reload the page.');
      window.open('https://phantom.app', '_blank');
      return;
    }

    setState((prev) => transition(prev, { isLoading: true, error: null, errorCode: null, hint: null, phase: 'requesting_permission' }));
    try {
      const resp = await provider.connect();
      setState((prev) =>
        transition(prev, {
          isConnected: true,
          address: resp.publicKey.toString(),
          isLoading: false,
          error: null,
          errorCode: null,
          hint: null,
          phase: 'connected',
        })
      );
    } catch (err: any) {
      // ── Wallet-locked diagnostic ──────────────────────────────────────────
      // Phantom emits a "Wallet is locked" message when the user has not
      // unlocked the extension. We surface a dedicated error code so the UI
      // can render a targeted recovery hint.
      const isLocked =
        err?.message?.toLowerCase().includes('locked') ||
        err?.message?.toLowerCase().includes('wallet is locked');

      // ── Network mismatch diagnostic ───────────────────────────────────────
      // Phantom exposes a `network` property; "mainnet-beta" is production
      // Solana. In testnet/devnet mode we expect "devnet".
      const expectedNetwork =
        (import.meta as any).env?.VITE_NETWORK_MODE === 'mainnet' ? 'mainnet-beta' : 'devnet';
      const providerNetwork = (provider as any)?.network;
      const isNetworkMismatch =
        providerNetwork &&
        providerNetwork !== expectedNetwork;

      if (isLocked) {
        setError(
          'wallet_locked',
          'Phantom is locked. Please unlock it and try again.',
          'Open Phantom, enter your password to unlock, then retry.',
        );
      } else if (isNetworkMismatch) {
        setError(
          'network_mismatch',
          `Phantom is connected to "${providerNetwork}" but this app expects "${expectedNetwork}".`,
          `Switch Phantom to ${expectedNetwork} in Settings → Network and retry.`,
        );
      } else {
        setError(
          'phantom_connect_failed',
          err?.message ?? 'Phantom connection failed',
          'Check the Phantom popup. If you denied access, approve it and retry.',
        );
      }
    }
  }, [setError]);

  const disconnect = useCallback(async () => {
    const provider = getProvider();
    if (provider) {
      try { await provider.disconnect(); } catch { /* ignore */ }
    }
    setState((prev) => transition(prev, { isConnected: false, address: null, isLoading: false, error: null, errorCode: null, hint: null, phase: 'idle' }));
  }, []);

  const isInstalled = !!getProvider();

  return {
    isConnected: state.isConnected,
    address: state.address,
    isLoading: state.isLoading,
    error: state.error,
    errorCode: state.errorCode,
    hint: state.hint,
    phase: state.phase,
    lastTransitionAt: state.lastTransitionAt,
    isInstalled,
    connect,
    disconnect,
  };
}
