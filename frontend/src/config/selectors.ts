/**
 * Typed config selectors for the frontend.
 *
 * Selectors expose only the subset of configuration a component needs,
 * preventing accidental coupling to the full config object. Each selector
 * is a pure function that derives its value from the layered config modules.
 */

import { envConfig } from './env';
import { featureFlags } from './feature-flags';
import {
  getCurrentNetwork,
  getContractAddresses,
  getFaucets,
  isTestnet,
  isMainnetEnabled,
  resolveNetworkMode,
  type NetworkConfig,
  type StellarNetworkConfig,
} from './networks';
import { getRoute, isRouteSupported, type BridgeDirection, type RouteToken } from './routes';

// ── Environment selectors ──────────────────────────────────────────────────────

export function selectApiBaseUrl(): string {
  return envConfig.apiBaseUrl;
}

export function selectIsMockDataEnabled(): boolean {
  return envConfig.enableMockData;
}

// ── Feature flag selectors ─────────────────────────────────────────────────────

export function selectFaucetEnabled(): boolean {
  return featureFlags.faucetEnabled;
}

export function selectHistoryStreamEnabled(): boolean {
  return featureFlags.historyStreamEnabled;
}

export function selectRefundFlowEnabled(): boolean {
  return featureFlags.refundFlowEnabled;
}

export function selectSolanaRoutesEnabled(): boolean {
  return featureFlags.solanaRoutesEnabled;
}

export function selectIntroAnimationEnabled(): boolean {
  return featureFlags.introAnimationEnabled;
}

export function selectDarkVeilEnabled(): boolean {
  return featureFlags.darkVeilEnabled;
}

export function selectClaimFallbackEnabled(): boolean {
  return featureFlags.claimFallbackEnabled;
}

// ── Network selectors ─────────────────────────────────────────────────────────

export function selectIsMainnetEnabled(): boolean {
  return isMainnetEnabled();
}

export function selectIsTestnet(): boolean {
  return isTestnet();
}

export function selectResolvedNetworkMode(mode: 'mainnet' | 'testnet'): 'mainnet' | 'testnet' {
  return resolveNetworkMode(mode);
}

export function selectCurrentEthereumNetwork(): NetworkConfig {
  return getCurrentNetwork().ethereum;
}

export function selectCurrentStellarNetwork(): StellarNetworkConfig {
  return getCurrentNetwork().stellar;
}

export function selectEthereumContractAddresses() {
  return getContractAddresses().ethereum;
}

export function selectStellarContractAddresses() {
  return getContractAddresses().stellar;
}

export function selectFaucets() {
  return getFaucets();
}

// ── Route selectors ────────────────────────────────────────────────────────────

export function selectRoute(direction: BridgeDirection) {
  return getRoute(direction);
}

export function selectIsRouteSupported(direction: BridgeDirection): boolean {
  return isRouteSupported(direction);
}

export function selectRouteToken(symbol: string): RouteToken | undefined {
  const map: Record<string, RouteToken> = {
    ETH: { symbol: 'ETH', name: 'Ether', chain: 'ethereum', decimals: 18, logo: '/images/eth.png' },
    XLM: { symbol: 'XLM', name: 'Lumens', chain: 'stellar', decimals: 7, logo: '/images/xlm.png' },
    SOL: { symbol: 'SOL', name: 'Solana', chain: 'solana', decimals: 9, logo: '/images/sol.svg' },
  };
  return map[symbol];
}
