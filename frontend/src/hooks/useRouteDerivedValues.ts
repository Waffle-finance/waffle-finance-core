/**
 * Stable memoization of route-level derived values for the bridge form.
 *
 * Separates the fast, synchronous derivations (token pair, wallet readiness,
 * estimated output, per-route disabled reasons) from the async price-fetching
 * so that rapid user input — typing an amount, switching direction — never
 * triggers redundant network round-trips or excessive re-renders.
 *
 * Invalidation is tied only to the actual underlying state that each value
 * depends on:
 *  - fromToken / toToken         → re-derives only when `direction` changes
 *  - walletsReady                → re-derives only when an address changes
 *  - unsupportedReasonsByRoute   → re-derives only when addresses change
 *  - estimatedAmount             → re-derives when amount, direction, or prices change
 *
 * The hook does NOT fetch prices itself. Callers own that async concern and
 * pass in the latest prices, keeping the hook pure and testable.
 */

import { useMemo } from 'react';
import { validateRouteWallets } from '../utils/validation';

export type BridgeDirection =
  | 'eth_to_xlm'
  | 'xlm_to_eth'
  | 'eth_to_sol'
  | 'sol_to_eth'
  | 'xlm_to_sol'
  | 'sol_to_xlm';

export interface BridgeToken {
  symbol: string;
  name: string;
  logo: string;
  chain: string;
  decimals: number;
}

const ETH_TOKEN: BridgeToken = { symbol: 'ETH', name: 'Ethereum',      logo: '/images/eth.png', chain: 'Ethereum', decimals: 18 };
const XLM_TOKEN: BridgeToken = { symbol: 'XLM', name: 'Stellar Lumens', logo: '/images/xlm.png', chain: 'Stellar',  decimals: 7  };
const SOL_TOKEN: BridgeToken = { symbol: 'SOL', name: 'Solana',         logo: '/images/sol.svg', chain: 'Solana',   decimals: 9  };

export const BRIDGE_DIRECTION_MAP: Record<BridgeDirection, { from: BridgeToken; to: BridgeToken }> = {
  eth_to_xlm: { from: ETH_TOKEN, to: XLM_TOKEN },
  xlm_to_eth: { from: XLM_TOKEN, to: ETH_TOKEN },
  eth_to_sol:  { from: ETH_TOKEN, to: SOL_TOKEN },
  sol_to_eth:  { from: SOL_TOKEN,  to: ETH_TOKEN },
  xlm_to_sol:  { from: XLM_TOKEN, to: SOL_TOKEN  },
  sol_to_xlm:  { from: SOL_TOKEN,  to: XLM_TOKEN },
};

export const BRIDGE_ROUTE_OPTIONS: BridgeDirection[] = [
  'eth_to_xlm', 'xlm_to_eth', 'eth_to_sol', 'sol_to_eth',
];

export interface RoutePrices {
  ethUsd: number | null;
  xlmUsd: number | null;
  solUsd: number | null;
}

export interface UseRouteDerivedValuesParams {
  direction: BridgeDirection;
  amount: string;
  ethAddress: string;
  stellarAddress: string;
  solanaAddress: string;
  prices: RoutePrices;
}

export interface UseRouteDerivedValuesResult {
  fromToken: BridgeToken;
  toToken: BridgeToken;
  /** Synchronously computed from stored prices — no network call. Empty string while prices are not yet available. */
  estimatedAmount: string;
  walletsReady: boolean;
  /** Maps each route option to the human-readable reason it is unavailable, if any. */
  unsupportedReasonsByRoute: Partial<Record<BridgeDirection, string>>;
}

function deriveEstimatedAmount(
  amount: string,
  direction: BridgeDirection,
  prices: RoutePrices,
): string {
  const num = parseFloat(amount);
  if (!amount || !Number.isFinite(num) || num <= 0) return '';
  const { ethUsd, xlmUsd, solUsd } = prices;
  if (!ethUsd || !xlmUsd || !solUsd) return '';

  const from = BRIDGE_DIRECTION_MAP[direction].from.symbol;
  const to   = BRIDGE_DIRECTION_MAP[direction].to.symbol;

  const usdOf = (sym: string): number =>
    sym === 'ETH' ? ethUsd : sym === 'XLM' ? xlmUsd : solUsd;

  const fromUsd = usdOf(from);
  const toUsd   = usdOf(to);
  if (!fromUsd || !toUsd) return '';

  const output   = (num * fromUsd) / toUsd;
  // Prefer UI-friendly formatting using shared util
  const { formatAmount } = await import('../lib/formatAmount');
  const asset = to === 'ETH' ? (await import('../lib/assetNormalization')).getNativeAsset('ethereum') : to === 'SOL' ? (await import('../lib/assetNormalization')).getNativeAsset('solana') : (await import('../lib/assetNormalization')).getNativeAsset('stellar');
  return formatAmount(output, asset, { showSymbol: false });
}

export function useRouteDerivedValues({
  direction,
  amount,
  ethAddress,
  stellarAddress,
  solanaAddress,
  prices,
}: UseRouteDerivedValuesParams): UseRouteDerivedValuesResult {
  const { from: fromToken, to: toToken } = useMemo(
    () => BRIDGE_DIRECTION_MAP[direction],
    [direction],
  );

  const walletsReady = useMemo(
    () => validateRouteWallets(direction, ethAddress, stellarAddress, solanaAddress).isValid,
    [direction, ethAddress, stellarAddress, solanaAddress],
  );

  const unsupportedReasonsByRoute = useMemo(() => {
    const out: Partial<Record<BridgeDirection, string>> = {};
    for (const route of BRIDGE_ROUTE_OPTIONS) {
      const r = validateRouteWallets(route, ethAddress, stellarAddress, solanaAddress);
      if (!r.isValid) out[route] = r.message;
    }
    return out;
  }, [ethAddress, stellarAddress, solanaAddress]);

  const estimatedAmount = useMemo(
    () => deriveEstimatedAmount(amount, direction, prices),
    [amount, direction, prices],
  );

  return { fromToken, toToken, estimatedAmount, walletsReady, unsupportedReasonsByRoute };
}
