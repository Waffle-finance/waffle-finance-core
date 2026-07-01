import { useCallback, useEffect, useState } from 'react';
import freighterApi from '@stellar/freighter-api';
import { t } from '../i18n';

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
}

function transition(prev: FreighterState, patch: Partial<FreighterState>): FreighterState {
  return {
    ...prev,
    ...patch,
    lastTransitionAt: Date.now(),
    phase: patch.phase ?? prev.phase,
  };
}

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
        if (!freighterApi || typeof freighterApi.isConnected !== 'function') {
          console.log('❌ [freighter] API unavailable');
          setError(
            'freighter_unavailable',
            t('wallet.errors.freighterUnavailable'),
            t('wallet.errors.freighterUnavailableHint')
          );
          return;
        }

        const isConnected = await freighterApi.isConnected();
        console.log('🔍 [freighter] connected:', isConnected);

        if (!isConnected) {
          setState((prev) => transition(prev, { phase: 'idle' }));
          return;
        }

        const { address } = await freighterApi.getAddress();
        console.log('🔍 [freighter] address:', address);

        let network: string | null = null;
        let networkPassphrase: string | null = null;
        try {
          const net = await freighterApi.getNetwork();
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
        if (typeof freighterApi?.isConnected !== 'function') return;
        const available = await freighterApi.isConnected();
        if (!available) {
          if (!cancelled) markDisconnected();
          return;
        }

        const { address } = await freighterApi.getAddress();
        if (!address) {
          if (!cancelled) markDisconnected();
          return;
        }

        let network: string | null = null;
        let networkPassphrase: string | null = null;
        try {
          const net = await freighterApi.getNetwork();
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
  }, [setError]);

  // Connect to Freighter
  const connect = useCallback(async () => {
    console.log('🔌 [freighter] connect requested');
    setState((prev) => transition(prev, { isLoading: true, error: null, errorCode: null, hint: null }));

    try {
      if (!freighterApi || typeof freighterApi.isConnected !== 'function') {
        throw new Error('Freighter wallet extension not found. Please install Freighter.');
      }

      const isAvailable = await freighterApi.isConnected();
      console.log('🔍 [freighter] availability:', isAvailable);

      if (!isAvailable) {
        throw new Error('Freighter wallet is not available. Please install Freighter extension.');
      }

      setState((prev) => transition(prev, { phase: 'requesting_permission' }));

      console.log('🔌 [freighter] requesting permission');
      await freighterApi.setAllowed();

      console.log('🔍 [freighter] getting address');
      const { address } = await freighterApi.getAddress();
      console.log('✅ [freighter] connected:', address);

      let network: string | null = null;
      let networkPassphrase: string | null = null;
      try {
        const net = await freighterApi.getNetwork();
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
          hint: null,
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
  const signTransaction = useCallback(async (
    xdr: string,
    networkPassphrase?: string,
    addressOverride?: string,
  ) => {
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
      setError(
        'freighter_sign_failed',
        msg,
        error instanceof Error && error.message?.includes('User declined')
          ? 'You rejected the signature request in Freighter.'
          : 'Check the Freighter popup and try again.'
      );
      throw error;
    }
  }, [state.address, setError]);

  return {
    ...state,
    connect,
    disconnect,
    getNetworkInfo,
    signTransaction,
  };
}
