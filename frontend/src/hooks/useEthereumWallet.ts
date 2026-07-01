import { useCallback, useEffect, useState } from 'react';
import { t } from '../i18n';

export type ConnectionPhase = 'idle' | 'checking' | 'requesting_permission' | 'connected' | 'error';

export interface EthereumWalletState {
  isConnected: boolean;
  address: string | null;
  chainId: string | null;
  isLoading: boolean;
  error: string | null;
  errorCode: string | null;
  hint: string | null;
  phase: ConnectionPhase;
  lastTransitionAt: number | null;
  isInstalled: boolean;
}

const INITIAL_STATE: EthereumWalletState = {
  isConnected: false,
  address: null,
  chainId: null,
  isLoading: false,
  error: null,
  errorCode: null,
  hint: null,
  phase: 'idle',
  lastTransitionAt: null,
  isInstalled: false,
};

function transition(prev: EthereumWalletState, patch: Partial<EthereumWalletState>): EthereumWalletState {
  return {
    ...prev,
    ...patch,
    lastTransitionAt: Date.now(),
    phase: patch.phase ?? prev.phase,
  };
}

export function useEthereumWallet() {
  const [state, setState] = useState<EthereumWalletState>(INITIAL_STATE);

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

  useEffect(() => {
    const provider = typeof window !== 'undefined' ? window.ethereum : undefined;
    const installed = !!provider;
    setState((prev) => transition(prev, { isInstalled: installed, phase: installed ? 'checking' : 'idle' }));

    if (!provider) {
      setError(
        'metamask_unavailable',
        t('wallet.errors.metamaskUnavailable'),
        t('wallet.metamask.hint')
      );
      return;
    }

    const check = async () => {
      try {
        const accounts = await provider.request({ method: 'eth_accounts' });
        const chainId = await provider.request({ method: 'eth_chainId' }).catch(() => null);
        if (accounts.length > 0) {
          setState((prev) =>
            transition(prev, {
              isConnected: true,
              address: accounts[0],
              chainId: chainId as string | null,
              error: null,
              errorCode: null,
              hint: null,
              phase: 'connected',
            })
          );
        } else {
          setState((prev) => transition(prev, { phase: 'idle' }));
        }
      } catch (err) {
        setError(
          'ethereum_check_failed',
          err instanceof Error ? err.message : t('wallet.errors.metamaskCheckFailed'),
          t('wallet.errors.metamaskReloadHint')
        );
      }
    };

    check();

    const handleAccountsChanged = (accounts: string[]) => {
      setState((prev) => {
        if (accounts.length === 0) {
          return transition(prev, { isConnected: false, address: null, phase: 'idle' });
        }
        return transition(prev, {
          isConnected: true,
          address: accounts[0],
          error: null,
          errorCode: null,
          hint: null,
          phase: 'connected',
        });
      });
    };

    const handleChainChanged = (chainId: string) => {
      setState((prev) =>
        transition(prev, {
          chainId,
          error: null,
          errorCode: null,
          hint: null,
          phase: prev.isConnected ? 'connected' : prev.phase,
        })
      );
    };

    const handleDisconnect = () => {
      setState((prev) => transition(prev, { isConnected: false, address: null, phase: 'idle' }));
    };

    provider.on('accountsChanged', handleAccountsChanged as any);
    provider.on('chainChanged', handleChainChanged as any);
    provider.on('disconnect', handleDisconnect as any);

    return () => {
      provider.removeListener('accountsChanged', handleAccountsChanged as any);
      provider.removeListener('chainChanged', handleChainChanged as any);
      provider.removeListener('disconnect', handleDisconnect as any);
    };
  }, [setError]);

  const connect = useCallback(async () => {
    const provider = typeof window !== 'undefined' ? window.ethereum : undefined;
    if (!provider) {
      setError('metamask_unavailable', t('wallet.errors.metamaskUnavailable'), t('wallet.metamask.hint'));
      return;
    }

    setState((prev) => transition(prev, { isLoading: true, error: null, errorCode: null, hint: null, phase: 'requesting_permission' }));
    try {
      const accounts = await provider.request({ method: 'eth_requestAccounts' });
      const chainId = await provider.request({ method: 'eth_chainId' }).catch(() => null);
      if (accounts.length > 0) {
        setState((prev) =>
          transition(prev, {
            isConnected: true,
            address: accounts[0],
            chainId: chainId as string | null,
            isLoading: false,
            error: null,
            errorCode: null,
            hint: null,
            phase: 'connected',
          })
        );
      }
    } catch (err: any) {
      setError(
        'metamask_connect_failed',
        err?.message ?? t('wallet.errors.metamaskConnectFailed'),
        err?.code === 4001
          ? t('wallet.errors.metamaskConnectHintRejected')
          : t('wallet.errors.metamaskConnectHintGeneral')
      );
    }
  }, [setError]);

  const disconnect = useCallback(() => {
    setState((prev) => transition(prev, { isConnected: false, address: null, isLoading: false, error: null, errorCode: null, hint: null, phase: 'idle' }));
  }, []);

  return {
    ...state,
    connect,
    disconnect,
  };
}
