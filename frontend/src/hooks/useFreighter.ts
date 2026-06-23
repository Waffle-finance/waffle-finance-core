import { useCallback, useEffect, useState } from 'react';
import freighterApi from '@stellar/freighter-api';

interface FreighterState {
  isConnected: boolean;
  address: string | null;
  /** Freighter network name, e.g. "TESTNET" / "PUBLIC". Null until known. */
  network: string | null;
  /** Stellar network passphrase reported by Freighter. Null until known. */
  networkPassphrase: string | null;
  isLoading: boolean;
  error: string | null;
}

export function useFreighter() {
  const [state, setState] = useState<FreighterState>({
    isConnected: false,
    address: null,
    network: null,
    networkPassphrase: null,
    isLoading: false,
    error: null,
  });

  // Check if Freighter is connected on mount
  useEffect(() => {
    const checkConnection = async () => {
      console.log('🚀 Checking Freighter connection...');
      
      try {
        // Check if Freighter is available
        if (!freighterApi || typeof freighterApi.isConnected !== 'function') {
          console.log('❌ Freighter API not available');
          return;
        }
        
        const isConnected = await freighterApi.isConnected();
        console.log('🚀 Freighter connection status:', isConnected);
        
        if (isConnected) {
          const { address } = await freighterApi.getAddress();
          console.log('🚀 Freighter address:', address);

          let network: string | null = null;
          let networkPassphrase: string | null = null;
          try {
            const net = await freighterApi.getNetwork();
            network = net.network;
            networkPassphrase = net.networkPassphrase;
          } catch {
            // Network details unavailable — leave null, the watcher will fill in.
          }

          setState(prev => ({
            ...prev,
            isConnected: true,
            address,
            network,
            networkPassphrase,
            error: null,
          }));
        }
      } catch (error) {
        console.error('❌ Error checking Freighter connection:', error);
        setState(prev => ({
          ...prev,
          error: error instanceof Error ? error.message : 'Connection check failed',
        }));
      }
    };

    checkConnection();
  }, []);

  // Poll Freighter for address / network changes (including disconnect). The
  // extension has no event emitter, so we poll on an interval and only update
  // state when something actually changes. The interval is cleared on unmount
  // so the poller does not leak across the session.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    let cancelled = false;

    const markDisconnected = () => {
      setState(prev =>
        prev.isConnected || prev.address
          ? { ...prev, isConnected: false, address: null, network: null, networkPassphrase: null }
          : prev
      );
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
        setState(prev => {
          if (
            prev.isConnected &&
            prev.address === address &&
            prev.network === network &&
            prev.networkPassphrase === networkPassphrase
          ) {
            return prev;
          }
          return { ...prev, isConnected: true, address, network, networkPassphrase, error: null };
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
    console.log('🚀 Connecting to Freighter...');
    setState(prev => ({ ...prev, isLoading: true, error: null }));
    
    try {
      // Check if Freighter is available
      if (!freighterApi || typeof freighterApi.isConnected !== 'function') {
        throw new Error('Freighter wallet extension bulunamadı. Lütfen Freighter extension\'ı yükleyin.');
      }
      
      const isAvailable = await freighterApi.isConnected();
      console.log('🚀 Freighter availability:', isAvailable);
      
      if (!isAvailable) {
        throw new Error('Freighter wallet is not available. Please install Freighter extension.');
      }

      console.log('🚀 Requesting Freighter permission...');
      await freighterApi.setAllowed();
      
      console.log('🚀 Getting Freighter address...');
      const { address } = await freighterApi.getAddress();
      console.log('🚀 Freighter connected successfully:', address);

      let network: string | null = null;
      let networkPassphrase: string | null = null;
      try {
        const net = await freighterApi.getNetwork();
        network = net.network;
        networkPassphrase = net.networkPassphrase;
      } catch {
        // Non-fatal — network details will be populated by the watcher.
      }

      setState(prev => ({
        ...prev,
        isConnected: true,
        address,
        network,
        networkPassphrase,
        isLoading: false,
        error: null,
      }));

      return address;
    } catch (error) {
      console.error('❌ Freighter connection error:', error);
      const errorMessage = error instanceof Error ? error.message : 'Failed to connect to Freighter';
      setState(prev => ({
        ...prev,
        isConnected: false,
        address: null,
        isLoading: false,
        error: errorMessage,
      }));
      throw error;
    }
  }, []);

  // Disconnect from Freighter
  const disconnect = useCallback(() => {
    setState({
      isConnected: false,
      address: null,
      network: null,
      networkPassphrase: null,
      isLoading: false,
      error: null,
    });
  }, []);

  // Get network info
  const getNetworkInfo = useCallback(async () => {
    try {
      const networkInfo = await freighterApi.getNetwork();
      return networkInfo;
    } catch (error) {
      console.error('Error getting network info:', error);
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
      throw new Error('Wallet not connected');
    }

    try {
      const result = await freighterApi.signTransaction(xdr, {
        networkPassphrase,
        address: signerAddress,
      });
      return result.signedTxXdr;
    } catch (error) {
      console.error('Error signing transaction:', error);
      throw error;
    }
  }, [state.address]);

  return {
    ...state,
    connect,
    disconnect,
    getNetworkInfo,
    signTransaction,
  };
} 