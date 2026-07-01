import { useCallback, useEffect, useState } from 'react';
import freighterApi from '@stellar/freighter-api';

export type ConnectionPhase = 'idle' | 'checking' | 'requesting_permission' | 'connected' | 'error';

export interface FreighterState {
  isConnected: boolean;
  address: string | null;
  network: string | null;
  networkPassphrase: string | null;
  isLoading: boolean;
  error: string | null;
  errorCode: string | null;
  hint: string | null;
  phase: ConnectionPhase;
  lastTransitionAt: number | null;
  /** Always "Freighter" — exposed for UI consistency with other wallet hooks. */
  walletName: 'Freighter' | null;
  /** Whether the installed Freighter version is known to be outdated. */
  isLegacyApi: boolean;
}

function transition(prev: FreighterState, patch: Partial<FreighterState>): FreighterState {
  return {
    ...prev,
    ...patch,
    lastTransitionAt: Date.now(),
    phase: patch.phase ?? prev.phase,
  };
}

// ---------------------------------------------------------------------------
// API compatibility helpers
// ---------------------------------------------------------------------------

/** Shape of the Freighter API object (both legacy and current). */
type FreighterApiCompat = typeof freighterApi & {
  /** Older Freighter (< 2.x) exposed getPublicKey instead of getAddress. */
  getPublicKey?: () => Promise<string>;
};

/**
 * Detect whether the injected Freighter API is the older (pre-2.x) shape.
 * Old shape: `getPublicKey()` returns a bare string.
 * New shape: `getAddress()` returns `{ address: string }`.
 */
function detectLegacyApi(api: FreighterApiCompat): boolean {
  return (
    typeof api.getPublicKey === 'function' &&
    typeof api.getAddress !== 'function'
  );
}

/**
 * Retrieve the connected Stellar address, normalising across API versions.
 */
async function fetchAddress(api: FreighterApiCompat): Promise<string | null> {
  if (typeof api.getAddress === 'function') {
    const result = await api.getAddress();
    return result?.address ?? null;
  }
  if (typeof api.getPublicKey === 'function') {
    // Legacy API — returns the public key as a plain string.
    return (await api.getPublicKey()) ?? null;
  }
  return null;
}

/**
 * Request user permission to connect. Guards against older Freighter builds
 * that don't expose `setAllowed`.
 *
 * Returns `true` when the permission request succeeded (or was a no-op on
 * legacy builds), `false` when the user declined.
 */
async function requestPermission(api: FreighterApiCompat, isLegacy: boolean): Promise<boolean> {
  if (isLegacy || typeof api.setAllowed !== 'function') {
    // Older Freighter grants access implicitly once the user unlocks the wallet.
    // We can't request permission programmatically — treat as allowed.
    return true;
  }
  try {
    await api.setAllowed();
    return true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : '';
    // Freighter throws with "User declined" or similar when rejected.
    if (msg.toLowerCase().includes('declin') || msg.toLowerCase().includes('reject')) {
      return false;
    }
    // Unknown error — re-throw so the caller can surface it.
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useFreighter() {
  const [state, setState] = useState<FreighterState>({
    isConnected: false,
    address: null,
    network: null,
    networkPassphrase: null,
    isLoading: false,
    error: null,
    errorCode: null,
    hint: null,
    phase: 'idle',
    lastTransitionAt: null,
    walletName: null,
    isLegacyApi: false,
  });

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

  // Check if Freighter is connected on mount
  useEffect(() => {
    const checkConnection = async () => {
      console.log('🔍 [freighter] checking connection');
      setState((prev) => transition(prev, { phase: 'checking' }));

      try {
        const api = freighterApi as FreighterApiCompat;

        if (!api || typeof api.isConnected !== 'function') {
          console.log('❌ [freighter] API unavailable');
          setError(
            'freighter_unavailable',
            'Freighter wallet extension not found.',
            'Install Freighter from the Chrome Web Store and reload the page.'
          );
          return;
        }

        const isLegacy = detectLegacyApi(api);
        setState((prev) => transition(prev, { walletName: 'Freighter', isLegacyApi: isLegacy }));

        const isConnected = await api.isConnected();
        console.log('🔍 [freighter] connected:', isConnected);

        if (!isConnected) {
          setState((prev) => transition(prev, { phase: 'idle' }));
          return;
        }

        const address = await fetchAddress(api);
        console.log('🔍 [freighter] address:', address);

        if (!address) {
          setState((prev) => transition(prev, { phase: 'idle' }));
          return;
        }

        let network: string | null = null;
        let networkPassphrase: string | null = null;
        try {
          const net = await api.getNetwork();
          network = net.network;
          networkPassphrase = net.networkPassphrase;
        } catch {
          // Network details unavailable — leave null, the watcher will fill in.
        }

        setState((prev) =>
          transition(prev, {
            isConnected: true,
            address,
            network,
            networkPassphrase,
            error: null,
            errorCode: null,
            hint: null,
            phase: 'connected',
          })
        );
      } catch (error) {
        console.error('❌ [freighter] connection check failed:', error);
        setError(
          'connection_check_failed',
          error instanceof Error ? error.message : 'Connection check failed',
          'Refresh the page and try again. If the issue persists, re-login to Freighter.'
        );
      }
    };

    checkConnection();
  }, [setError]);

  // Poll Freighter for address / network changes (including disconnect). The
  // extension has no event emitter, so we poll on an interval and only update
  // state when something actually changes. The interval is cleared on unmount
  // so the poller does not leak across the session.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    let cancelled = false;

    const markDisconnected = () => {
      setState((prev) => {
        if (!prev.isConnected && !prev.address) return prev;
        return transition(prev, {
          isConnected: false,
          address: null,
          network: null,
          networkPassphrase: null,
          phase: 'idle',
        });
      });
    };

    const poll = async () => {
      try {
        const api = freighterApi as FreighterApiCompat;
        if (typeof api?.isConnected !== 'function') return;

        const available = await api.isConnected();
        if (!available) {
          if (!cancelled) markDisconnected();
          return;
        }

        const address = await fetchAddress(api);
        if (!address) {
          if (!cancelled) markDisconnected();
          return;
        }

        let network: string | null = null;
        let networkPassphrase: string | null = null;
        try {
          const net = await api.getNetwork();
          network = net.network;
          networkPassphrase = net.networkPassphrase;
        } catch {
          // Network details transiently unavailable — keep last-known values.
        }

        if (cancelled) return;
        setState((prev) => {
          if (
            prev.isConnected &&
            prev.address === address &&
            prev.network === network &&
            prev.networkPassphrase === networkPassphrase
          ) {
            return prev;
          }
          return transition(prev, {
            isConnected: true,
            address,
            network,
            networkPassphrase,
            error: null,
            errorCode: null,
            hint: null,
            phase: 'connected',
          });
        });
      } catch {
        // Ignore transient polling errors; the next tick re-evaluates.
      }
    };

    const intervalId = window.setInterval(poll, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, []);

  // Connect to Freighter
  const connect = useCallback(async () => {
    console.log('🔌 [freighter] connect requested');
    setState((prev) =>
      transition(prev, { isLoading: true, error: null, errorCode: null, hint: null })
    );

    try {
      const api = freighterApi as FreighterApiCompat;

      if (!api || typeof api.isConnected !== 'function') {
        throw new Error(
          'Freighter wallet extension not found. Please install Freighter from the Chrome Web Store.'
        );
      }

      const isLegacy = detectLegacyApi(api);
      setState((prev) =>
        transition(prev, { walletName: 'Freighter', isLegacyApi: isLegacy })
      );

      const isAvailable = await api.isConnected();
      console.log('🔍 [freighter] availability:', isAvailable);

      if (!isAvailable) {
        throw new Error(
          'Freighter wallet is not available. Please install or unlock the Freighter extension.'
        );
      }

      setState((prev) => transition(prev, { phase: 'requesting_permission' }));
      console.log('🔌 [freighter] requesting permission');

      const permitted = await requestPermission(api, isLegacy);
      if (!permitted) {
        setError(
          'freighter_permission_denied',
          'You declined the Freighter connection request.',
          'Open the Freighter popup and approve the connection to continue.'
        );
        return;
      }

      if (isLegacy) {
        console.log('ℹ️ [freighter] legacy API detected — upgrade Freighter for full features');
      }

      console.log('🔍 [freighter] getting address');
      const address = await fetchAddress(api);
      console.log('✅ [freighter] connected:', address);

      if (!address) {
        throw new Error(
          'Freighter returned an empty address. Ensure your wallet is unlocked and an account is selected.'
        );
      }

      let network: string | null = null;
      let networkPassphrase: string | null = null;
      try {
        const net = await api.getNetwork();
        network = net.network;
        networkPassphrase = net.networkPassphrase;
      } catch {
        // Non-fatal — network details will be populated by the watcher.
      }

      setState((prev) =>
        transition(prev, {
          isConnected: true,
          address,
          network,
          networkPassphrase,
          isLoading: false,
          error: null,
          errorCode: null,
          hint: isLegacy
            ? 'You are using an older Freighter version. Upgrade for the best experience.'
            : null,
          phase: 'connected',
        })
      );

      return address;
    } catch (error) {
      console.error('❌ [freighter] connection error:', error);
      const errorMessage = error instanceof Error ? error.message : 'Failed to connect to Freighter';
      setError(
        'freighter_connect_failed',
        errorMessage,
        'Ensure Freighter is unlocked, the page has permission, and you are on the correct Stellar network.'
      );
      throw error;
    }
  }, [setError]);

  // Disconnect from Freighter
  const disconnect = useCallback(() => {
    console.log('🔌 [freighter] disconnect requested');
    setState({
      isConnected: false,
      address: null,
      network: null,
      networkPassphrase: null,
      isLoading: false,
      error: null,
      errorCode: null,
      hint: null,
      phase: 'idle',
      lastTransitionAt: Date.now(),
      walletName: 'Freighter',
      isLegacyApi: false,
    });
  }, []);

  // Get network info
  const getNetworkInfo = useCallback(async () => {
    try {
      const networkInfo = await freighterApi.getNetwork();
      return networkInfo;
    } catch (error) {
      console.error('❌ [freighter] network info error:', error);
      return null;
    }
  }, []);

  // Sign transaction
  const signTransaction = useCallback(
    async (xdr: string, networkPassphrase?: string, addressOverride?: string) => {
      const signerAddress = addressOverride ?? state.address;
      if (!signerAddress) {
        setError('wallet_not_connected', 'Wallet not connected', 'Connect Freighter before signing.');
        throw new Error('Wallet not connected');
      }

      try {
        const result = await freighterApi.signTransaction(xdr, {
          networkPassphrase,
          address: signerAddress,
        });
        return result.signedTxXdr;
      } catch (error) {
        console.error('❌ [freighter] sign error:', error);
        const msg = error instanceof Error ? error.message : 'Signing failed';
        const isUserDecline =
          error instanceof Error &&
          (error.message?.toLowerCase().includes('declin') ||
            error.message?.toLowerCase().includes('user declined'));
        setError(
          'freighter_sign_failed',
          msg,
          isUserDecline
            ? 'You rejected the signature request in Freighter.'
            : 'Check the Freighter popup and try again.'
        );
        throw error;
      }
    },
    [state.address, setError]
  );

  return {
    ...state,
    connect,
    disconnect,
    getNetworkInfo,
    signTransaction,
  };
}
