import { useCallback, useEffect, useState } from 'react';
import freighterApi from '@stellar/freighter-api';
import { getNetworkConfigForMode, isMainnetEnabled, isTestnet, resolveNetworkMode } from '../config/networks';

export type NetworkMode = 'testnet' | 'mainnet';

/** Normalize eth_chainId responses (0xaa36a7 vs 11155111 vs mixed case). */
function normalizeChainId(chainId: string | null): string | null {
  if (!chainId) return null;
  const trimmed = chainId.trim();
  try {
    if (trimmed.startsWith('0x') || trimmed.startsWith('0X')) {
      return `0x${BigInt(trimmed).toString(16)}`;
    }
    if (/^\d+$/.test(trimmed)) {
      return `0x${BigInt(trimmed).toString(16)}`;
    }
  } catch {
    return trimmed.toLowerCase();
  }
  return trimmed.toLowerCase();
}

function readModeFromUrl(): NetworkMode {
  if (typeof window === 'undefined') {
    return 'testnet';
  }
  const url = new URLSearchParams(window.location.search).get('network');
  if (url === 'mainnet' || url === 'testnet') {
    return resolveNetworkMode(url);
  }
  return isTestnet() ? 'testnet' : 'mainnet';
}

function expectedEthChainIdHex(mode: NetworkMode): string {
  return `0x${BigInt(getNetworkConfigForMode(mode).ethereum.id).toString(16)}`;
}

function expectedStellarPassphrase(mode: NetworkMode): string {
  return getNetworkConfigForMode(mode).stellar.networkPassphrase;
}

function eqHexChainId(a: string | null, b: string): boolean {
  const left = normalizeChainId(a);
  const right = normalizeChainId(b);
  if (!left || !right) return false;
  return left === right;
}

export interface NetworkModeState {
  mode: NetworkMode;
  expectedEthChainIdHex: string;
  expectedStellarPassphrase: string;

  metamaskChainId: string | null;
  metamaskConnected: boolean;
  metamaskMatches: boolean;

  freighterNetworkPassphrase: string | null;
  freighterConnected: boolean;
  freighterMatches: boolean;

  hasAnyMismatch: boolean;

  setMode: (next: NetworkMode) => Promise<{ ok: boolean; reason?: string }>;
  /** Ask connected wallets to match the current app mode (even if mode unchanged). */
  syncWalletsToAppMode: () => Promise<{ ok: boolean; reason?: string }>;
  refreshWalletNetworks: () => void;
}

/**
 * Single source of truth for "is the app in testnet or mainnet mode?".
 *
 * - Reads the chosen mode from the `?network=` URL param (falls back to env).
 * - Subscribes to `chainChanged` from MetaMask so manual wallet switches
 *   are reflected immediately.
 * - Polls Freighter once on mount and once every 4s to detect manual
 *   network switches (Freighter exposes no event API).
 * - `setMode` first asks the connected wallets to switch; only once a
 *   wallet acknowledges (or no wallet is connected) does it update the
 *   URL. This removes the previous race where the URL could flip while
 *   one wallet stayed on the wrong chain.
 */
export function useNetworkMode(opts: {
  ethAddress?: string;
  stellarAddress?: string;
}): NetworkModeState {
  const [mode, setLocalMode] = useState<NetworkMode>(() => readModeFromUrl());
  const [metamaskChainId, setMetamaskChainId] = useState<string | null>(null);
  const [freighterNetworkPassphrase, setFreighterNetworkPassphrase] = useState<string | null>(null);

  const metamaskConnected = Boolean(opts.ethAddress);
  const freighterConnected = Boolean(opts.stellarAddress);

  useEffect(() => {
    const handler = () => setLocalMode(readModeFromUrl());
    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  }, []);

  // When mainnet is disabled, strip ?network=mainnet from the URL so bookmarks stay on testnet.
  useEffect(() => {
    if (typeof window === 'undefined' || isMainnetEnabled()) {
      return;
    }
    const url = new URL(window.location.href);
    if (url.searchParams.get('network') === 'mainnet') {
      url.searchParams.set('network', 'testnet');
      window.history.replaceState({}, '', url.toString());
      setLocalMode('testnet');
    }
  }, []);

  const refreshMetamask = useCallback(async () => {
    if (typeof window === 'undefined' || !window.ethereum) {
      setMetamaskChainId(null);
      return;
    }
    try {
      const chainId = (await window.ethereum.request({ method: 'eth_chainId' })) as string;
      setMetamaskChainId(normalizeChainId(chainId));
    } catch {
      setMetamaskChainId(null);
    }
  }, []);

  const refreshFreighter = useCallback(async () => {
    try {
      if (!freighterApi || typeof freighterApi.isConnected !== 'function') {
        setFreighterNetworkPassphrase(null);
        return;
      }
      const connectedRaw: any = await freighterApi.isConnected();
      const connected =
        typeof connectedRaw === 'boolean'
          ? connectedRaw
          : Boolean(connectedRaw?.isConnected);
      if (!connected) {
        setFreighterNetworkPassphrase(null);
        return;
      }
      const info: any = await freighterApi.getNetwork();
      const passphrase =
        (info && typeof info === 'object' && info.networkPassphrase) ||
        (typeof info === 'string' ? info : null);
      setFreighterNetworkPassphrase(passphrase || null);
    } catch {
      setFreighterNetworkPassphrase(null);
    }
  }, []);

  useEffect(() => {
    refreshMetamask();

    if (typeof window === 'undefined' || !window.ethereum) {
      return;
    }
    const eth = window.ethereum as any;
    const onChainChanged = (next: string) => setMetamaskChainId(normalizeChainId(next));
    if (typeof eth.on === 'function') {
      eth.on('chainChanged', onChainChanged);
    }
    return () => {
      if (typeof eth.removeListener === 'function') {
        eth.removeListener('chainChanged', onChainChanged);
      }
    };
  }, [refreshMetamask]);

  // Re-read chain when MetaMask connects; poll while connected (some wallets omit chainChanged).
  useEffect(() => {
    if (!metamaskConnected) {
      return;
    }
    refreshMetamask();
    const id = window.setInterval(refreshMetamask, 4000);
    return () => window.clearInterval(id);
  }, [metamaskConnected, refreshMetamask]);

  useEffect(() => {
    refreshFreighter();
    const id = window.setInterval(refreshFreighter, 4000);
    return () => window.clearInterval(id);
  }, [refreshFreighter, freighterConnected]);

  const writeUrlMode = (next: NetworkMode) => {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    url.searchParams.set('network', next);
    window.history.replaceState({}, '', url.toString());
  };

  const switchMetamaskChain = async (next: NetworkMode): Promise<{ ok: boolean; reason?: string }> => {
    if (typeof window === 'undefined' || !window.ethereum) {
      return { ok: true };
    }
    const target = expectedEthChainIdHex(next);
    try {
      await window.ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: target }],
      });
      return { ok: true };
    } catch (err: any) {
      if (err?.code === 4902) {
        try {
          if (next === 'mainnet') {
            const current = getNetworkConfigForMode(next);
            await window.ethereum.request({
              method: 'wallet_addEthereumChain',
              params: [
                {
                  chainId: target,
                  chainName: 'Ethereum Mainnet',
                  rpcUrls: [current.ethereum.rpcUrl],
                  blockExplorerUrls: [current.ethereum.explorerUrl],
                  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
                },
              ],
            });
          } else {
            const current = getNetworkConfigForMode(next);
            await window.ethereum.request({
              method: 'wallet_addEthereumChain',
              params: [
                {
                  chainId: target,
                  chainName: 'Sepolia Testnet',
                  rpcUrls: [current.ethereum.rpcUrl],
                  blockExplorerUrls: [current.ethereum.explorerUrl],
                  nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
                },
              ],
            });
          }
          return { ok: true };
        } catch {
          return { ok: false, reason: 'metamask-add-failed' };
        }
      }
      if (err?.code === 4001) {
        return { ok: false, reason: 'user-rejected' };
      }
      return { ok: false, reason: 'metamask-switch-failed' };
    }
  };

  const syncWalletsToAppMode = useCallback(async (): Promise<{ ok: boolean; reason?: string }> => {
    if (metamaskConnected) {
      const result = await switchMetamaskChain(mode);
      if (!result.ok) {
        return result;
      }
    }
    await refreshMetamask();
    await refreshFreighter();
    return { ok: true };
  }, [mode, metamaskConnected, refreshMetamask, refreshFreighter]);

  const setMode = useCallback(
    async (next: NetworkMode): Promise<{ ok: boolean; reason?: string }> => {
      if (next === 'mainnet' && !isMainnetEnabled()) {
        return { ok: false, reason: 'mainnet-disabled' };
      }

      if (next === mode) {
        return { ok: true };
      }

      if (metamaskConnected) {
        const result = await switchMetamaskChain(next);
        if (!result.ok) {
          return result;
        }
      }

      writeUrlMode(next);
      setLocalMode(next);
      await refreshMetamask();
      await refreshFreighter();
      return { ok: true };
    },
    [mode, metamaskConnected, refreshMetamask, refreshFreighter],
  );

  const refreshWalletNetworks = useCallback(() => {
    refreshMetamask();
    refreshFreighter();
  }, [refreshMetamask, refreshFreighter]);

  const expectedChain = expectedEthChainIdHex(mode);
  const expectedPassphrase = expectedStellarPassphrase(mode);

  const metamaskMatches = metamaskConnected
    ? eqHexChainId(metamaskChainId, expectedChain)
    : true;
  const freighterMatches = freighterConnected
    ? freighterNetworkPassphrase === expectedPassphrase
    : true;

  return {
    mode,
    expectedEthChainIdHex: expectedChain,
    expectedStellarPassphrase: expectedPassphrase,
    metamaskChainId,
    metamaskConnected,
    metamaskMatches,
    freighterNetworkPassphrase,
    freighterConnected,
    freighterMatches,
    hasAnyMismatch: !metamaskMatches || !freighterMatches,
    setMode,
    syncWalletsToAppMode,
    refreshWalletNetworks,
  };
}
