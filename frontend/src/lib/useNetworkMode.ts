import { useCallback, useEffect, useState } from 'react';
import freighterApi from '@stellar/freighter-api';
import { useChainId, useSwitchChain } from 'wagmi';
import { isMainnetEnabled, isTestnet, resolveNetworkMode } from '../config/networks';

export type NetworkMode = 'testnet' | 'mainnet';

const ETH_MAINNET_CHAIN_ID_HEX = '0x1';
const ETH_SEPOLIA_CHAIN_ID_HEX = '0xaa36a7';

const STELLAR_MAINNET_PASSPHRASE = 'Public Global Stellar Network ; September 2015';
const STELLAR_TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015';

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
  return mode === 'mainnet' ? ETH_MAINNET_CHAIN_ID_HEX : ETH_SEPOLIA_CHAIN_ID_HEX;
}

function expectedStellarPassphrase(mode: NetworkMode): string {
  return mode === 'mainnet' ? STELLAR_MAINNET_PASSPHRASE : STELLAR_TESTNET_PASSPHRASE;
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
}

/**
 * Single source of truth for "is the app in testnet or mainnet mode?".
 *
 * - Reads the chosen mode from the `?network=` URL param (falls back to env).
 * - Uses wagmi's active chain state and switch API for Ethereum.
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
  const activeChainId = useChainId();
  const { switchChainAsync } = useSwitchChain();
  const [mode, setLocalMode] = useState<NetworkMode>(() => readModeFromUrl());
  const [freighterNetworkPassphrase, setFreighterNetworkPassphrase] = useState<string | null>(null);

  const metamaskConnected = Boolean(opts.ethAddress);
  const freighterConnected = Boolean(opts.stellarAddress);
  const metamaskChainId = metamaskConnected
    ? normalizeChainId(`0x${activeChainId.toString(16)}`)
    : null;

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

  const switchMetamaskChain = useCallback(async (
    next: NetworkMode,
  ): Promise<{ ok: boolean; reason?: string }> => {
    const chainId = next === 'mainnet' ? 1 : 11155111;
    try {
      await switchChainAsync({ chainId });
      return { ok: true };
    } catch (err: unknown) {
      if (getProviderErrorCode(err) === 4001 || errorMessage(err).toLowerCase().includes('rejected')) {
        return { ok: false, reason: 'user-rejected' };
      }
      if (getProviderErrorCode(err) === 4902) {
        return { ok: false, reason: 'metamask-add-failed' };
      }
      return { ok: false, reason: 'metamask-switch-failed' };
    }
  }, [switchChainAsync]);

  const syncWalletsToAppMode = useCallback(async (): Promise<{ ok: boolean; reason?: string }> => {
    if (metamaskConnected) {
      const result = await switchMetamaskChain(mode);
      if (!result.ok) {
        return result;
      }
    }
    await refreshFreighter();
    return { ok: true };
  }, [mode, metamaskConnected, refreshFreighter, switchMetamaskChain]);

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
      await refreshFreighter();
      return { ok: true };
    },
    [mode, metamaskConnected, refreshFreighter, switchMetamaskChain],
  );

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
  };
}

function getProviderErrorCode(error: unknown): number | undefined {
  const seen = new Set<object>();
  let current = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const value = current as { code?: unknown; cause?: unknown };
    if (typeof value.code === 'number') return value.code;
    current = value.cause;
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
