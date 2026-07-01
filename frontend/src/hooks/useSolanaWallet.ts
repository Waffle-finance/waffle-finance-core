/**
 * useSolanaWallet — Multi-wallet Solana integration.
 *
 * Supports Phantom, Solflare, Backpack and any generic Solana provider
 * through the shared detectSolanaProvider() utility from walletCompat.
 *
 * Mirrors the structure of useFreighter so the rest of the app can treat
 * all three chains (Ethereum / Stellar / Solana) uniformly.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  detectSolanaProvider,
  safeRemoveSolanaListener,
  type SolanaProvider,
} from '../lib/walletCompat';

export type ConnectionPhase = 'idle' | 'checking' | 'requesting_permission' | 'connected' | 'error';

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
  /** Human-readable name of the detected wallet, e.g. "Phantom", "Solflare". */
  walletName: string | null;
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
  walletName: null,
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
    const detected = detectSolanaProvider();

    if (!detected) {
      setState((prev) => transition(prev, { isInstalled: false, walletName: null }));
      return;
    }

    const { provider, walletName } = detected;

    setState((prev) =>
      transition(prev, { isInstalled: true, walletName, phase: 'checking' })
    );

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

    const handleAccountChange = (pubkey: unknown) => {
      const pk = pubkey as { toString(): string } | null;
      setState((prev) => {
        if (!pk) {
          return transition(prev, {
            isConnected: false,
            address: null,
            phase: 'idle',
          });
        }
        return transition(prev, {
          isConnected: true,
          address: pk.toString(),
          error: null,
          errorCode: null,
          hint: null,
          phase: 'connected',
        });
      });
    };

    const handleConnect = (pubkey: unknown) => {
      const pk = pubkey as { toString(): string } | null;
      if (!pk) return;
      setState((prev) =>
        transition(prev, {
          isConnected: true,
          address: pk.toString(),
          error: null,
          errorCode: null,
          hint: null,
          phase: 'connected',
        })
      );
    };

    const handleDisconnect = () => {
      setState((prev) =>
        transition(prev, { isConnected: false, address: null, phase: 'idle' })
      );
    };

    try { provider.on('connect', handleConnect); }          catch { /* ignore */ }
    try { provider.on('accountChanged', handleAccountChange); } catch { /* ignore */ }
    try { provider.on('disconnect', handleDisconnect); }    catch { /* ignore */ }

    return () => {
      safeRemoveSolanaListener(provider, 'connect', handleConnect);
      safeRemoveSolanaListener(provider, 'accountChanged', handleAccountChange);
      safeRemoveSolanaListener(provider, 'disconnect', handleDisconnect);
    };
  }, []);

  const connect = useCallback(async () => {
    const detected = detectSolanaProvider();

    if (!detected) {
      const msg = 'No Solana wallet extension found. Install Phantom, Solflare, or Backpack.';
      setError(
        'solana_wallet_unavailable',
        msg,
        'Install a Solana wallet browser extension (e.g. phantom.app) and reload the page.'
      );
      // Open install page for the most common wallet
      if (typeof window !== 'undefined') {
        window.open('https://phantom.app', '_blank');
      }
      return;
    }

    const { provider, walletName } = detected;

    setState((prev) =>
      transition(prev, {
        isLoading: true,
        error: null,
        errorCode: null,
        hint: null,
        phase: 'requesting_permission',
        walletName,
      })
    );

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
    } catch (err: unknown) {
      const anyErr = err as { message?: string };
      setError(
        'solana_connect_failed',
        anyErr?.message ?? `${walletName} connection failed`,
        `Check the ${walletName} popup. If you denied access, approve it and retry.`
      );
    }
  }, [setError]);

  const disconnect = useCallback(async () => {
    const detected = detectSolanaProvider();
    if (detected) {
      try { await detected.provider.disconnect(); } catch { /* ignore */ }
    }
    setState((prev) =>
      transition(prev, {
        isConnected: false,
        address: null,
        isLoading: false,
        error: null,
        errorCode: null,
        hint: null,
        phase: 'idle',
      })
    );
  }, []);

  const isInstalled = !!detectSolanaProvider();

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
    walletName: state.walletName,
    connect,
    disconnect,
  };
}
