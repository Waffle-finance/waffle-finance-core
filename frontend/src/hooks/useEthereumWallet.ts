import { useCallback, useEffect, useState } from 'react';
import {
  detectEthereumProvider,
  probeEthCapabilities,
  safeAddListener,
  safeRemoveListener,
  type Eip1193Provider,
} from '../lib/walletCompat';

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
  /** Human-readable name of the detected wallet extension, e.g. "MetaMask", "Coinbase Wallet". */
  walletName: string | null;
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
  walletName: null,
};

function transition(prev: EthereumWalletState, patch: Partial<EthereumWalletState>): EthereumWalletState {
  return {
    ...prev,
    ...patch,
    lastTransitionAt: Date.now(),
    phase: patch.phase ?? prev.phase,
  };
}

/**
 * Build a user-friendly install hint based on the provider-detection result.
 *
 * When no provider is found at all we don't know which extension the user
 * intended, so we give a generic link to EIP-1193-compatible wallets.
 */
function buildInstallHint(): string {
  return (
    'Install a browser wallet extension such as MetaMask (metamask.io), ' +
    'Coinbase Wallet, or Brave Wallet, then reload the page.'
  );
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
    const detected = detectEthereumProvider();

    if (!detected) {
      setState((prev) =>
        transition(prev, { isInstalled: false, walletName: null, phase: 'idle' })
      );
      setError(
        'ethereum_wallet_unavailable',
        'No Ethereum wallet extension found.',
        buildInstallHint()
      );
      return;
    }

    const { provider, walletName } = detected;
    const caps = probeEthCapabilities(provider);

    setState((prev) =>
      transition(prev, { isInstalled: true, walletName, phase: 'checking' })
    );

    const check = async () => {
      try {
        const accounts = (await provider.request({ method: 'eth_accounts' })) as string[];
        let chainId: string | null = null;
        try {
          chainId = (await provider.request({ method: 'eth_chainId' })) as string;
        } catch {
          // eth_chainId is optional — some lightweight providers omit it.
        }
        if (accounts.length > 0) {
          setState((prev) =>
            transition(prev, {
              isConnected: true,
              address: accounts[0],
              chainId,
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
          err instanceof Error ? err.message : `Failed to check ${walletName} state`,
          `Refresh the page. If accounts are locked, unlock ${walletName} and try again.`
        );
      }
    };

    check();

    // --- Event listeners ---

    const handleAccountsChanged = (accounts: unknown) => {
      const accs = accounts as string[];
      setState((prev) => {
        if (accs.length === 0) {
          return transition(prev, { isConnected: false, address: null, phase: 'idle' });
        }
        return transition(prev, {
          isConnected: true,
          address: accs[0],
          error: null,
          errorCode: null,
          hint: null,
          phase: 'connected',
        });
      });
    };

    const handleChainChanged = (chainId: unknown) => {
      setState((prev) =>
        transition(prev, {
          chainId: chainId as string,
          error: null,
          errorCode: null,
          hint: null,
          phase: prev.isConnected ? 'connected' : prev.phase,
        })
      );
    };

    const handleDisconnect = () => {
      setState((prev) =>
        transition(prev, { isConnected: false, address: null, phase: 'idle' })
      );
    };

    safeAddListener(provider, 'accountsChanged', handleAccountsChanged);
    safeAddListener(provider, 'chainChanged', handleChainChanged);
    safeAddListener(provider, 'disconnect', handleDisconnect);

    return () => {
      if (caps.supportsRemoveListener) {
        safeRemoveListener(provider, 'accountsChanged', handleAccountsChanged);
        safeRemoveListener(provider, 'chainChanged', handleChainChanged);
        safeRemoveListener(provider, 'disconnect', handleDisconnect);
      }
    };
  }, [setError]);

  const connect = useCallback(async () => {
    const detected = detectEthereumProvider();

    if (!detected) {
      setError(
        'ethereum_wallet_unavailable',
        'No Ethereum wallet extension found.',
        buildInstallHint()
      );
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
      const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as string[];
      let chainId: string | null = null;
      try {
        chainId = (await provider.request({ method: 'eth_chainId' })) as string;
      } catch {
        // eth_chainId not supported — leave null.
      }
      if (accounts.length > 0) {
        setState((prev) =>
          transition(prev, {
            isConnected: true,
            address: accounts[0],
            chainId,
            isLoading: false,
            error: null,
            errorCode: null,
            hint: null,
            phase: 'connected',
          })
        );
      }
    } catch (err: unknown) {
      const anyErr = err as { message?: string; code?: number };
      const rejected = anyErr?.code === 4001;
      setError(
        'ethereum_connect_failed',
        anyErr?.message ?? `${walletName} connection failed`,
        rejected
          ? `You rejected the connection request in ${walletName}.`
          : `Check the ${walletName} popup and try again.`
      );
    }
  }, [setError]);

  const disconnect = useCallback(() => {
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

  /**
   * Attempt to switch the connected wallet to a different chain.
   *
   * Falls back gracefully when `wallet_switchEthereumChain` is not supported.
   */
  const switchChain = useCallback(
    async (chainIdHex: string): Promise<boolean> => {
      const detected = detectEthereumProvider();
      if (!detected) return false;

      const { provider, walletName } = detected;
      const caps = probeEthCapabilities(provider);

      if (!caps.supportsChainSwitch) {
        setError(
          'chain_switch_unsupported',
          `${walletName} does not support automatic network switching.`,
          'Switch the network manually inside your wallet extension.'
        );
        return false;
      }

      try {
        await provider.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: chainIdHex }],
        });
        return true;
      } catch (err: unknown) {
        const anyErr = err as { code?: number; message?: string };
        if (anyErr?.code === 4001) {
          // User rejected — not an error worth surfacing as red error state.
          return false;
        }
        setError(
          'chain_switch_failed',
          anyErr?.message ?? 'Failed to switch network',
          `Switch the network manually inside ${walletName} and try again.`
        );
        return false;
      }
    },
    [setError]
  );

  return {
    ...state,
    connect,
    disconnect,
    switchChain,
  };
}
