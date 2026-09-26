/**
 * useRouteValidator
 *
 * Issue #770 — Improve bridge form validation for route-specific requirements.
 *
 * A single, authoritative hook that enforces all route-specific validation
 * rules before a user can submit a bridge transaction. It is the bridge
 * form's gatekeeper: if it returns `canSubmit: false`, the submit button is
 * disabled and the user sees a clear, actionable message explaining exactly
 * what is wrong.
 *
 * Design goals
 * ────────────
 * 1. Single source of truth — replaces ad-hoc validation scattered across
 *    `handleSubmit`, `useNetworkRouteValidator`, and `useRouteDerivedValues`.
 * 2. SDK-aligned — route and asset checks delegate to `@wafflefinance/sdk`
 *    so the UI never diverges from the backend pair matrix.
 * 3. Fast — every check is synchronous; no network calls.
 * 4. Actionable — each error carries a human-readable `message` the UI can
 *    render directly without extra mapping.
 *
 * Validation layers (applied in order; first failure wins)
 * ─────────────────────────────────────────────────────────
 * 1. Route declared     — direction exists in the SDK route registry.
 * 2. Route live         — direction is live (not "planned") on the current network.
 * 3. Wallet readiness   — wallets required by the direction are connected.
 * 4. Address format     — each connected address passes the chain-specific regex.
 * 5. Asset pair         — from/to token symbols are a supported pair.
 * 6. Minimum amount     — amount ≥ per-route minimum (0 disables the check).
 * 7. Decimal precision  — amount has at most `fromToken.decimals` decimal places.
 * 8. Balance            — amount ≤ wallet balance for the source chain.
 * 9. Quote available    — a live quote is present for the current input.
 * 10. Quote not expired — quote is within its validity window.
 * 11. Quote chain match — quote was produced for the current direction/assets.
 */

import { useMemo } from 'react';
import {
  resolveRoute,
  isLiveDirection,
  type LiveRouteDirection,
} from '@wafflefinance/sdk/routes';
import { isTestnet } from '../config/networks';
import {
  validateAmount,
  validateAssetPair,
  validateBalance,
  validateDestinationChain,
  validateEthereumAddress,
  validateSolanaAddress,
  validateStellarAddress,
  validateRouteWallets,
} from '../utils/validation';
import type { BridgeDirection } from './useRouteDerivedValues';
import type { BridgeQuote } from '../lib/bridgeQuote';

// ── Per-route minimum amounts ─────────────────────────────────────────────────
// These match the coordinator's announced minimum check. A value of 0 disables
// the check (no minimum enforced). Kept here rather than in the SDK because the
// minimum is a business rule that can change independently of the route matrix.

const ROUTE_MINIMUMS: Record<BridgeDirection, number> = {
  eth_to_xlm: 0.001,    // 0.001 ETH
  xlm_to_eth: 1,        // 1 XLM
  eth_to_sol: 0.001,    // 0.001 ETH
  sol_to_eth: 0.01,     // 0.01 SOL
  xlm_to_sol: 0,        // planned — no minimum enforced yet
  sol_to_xlm: 0,        // planned — no minimum enforced yet
};

// ── Error codes ───────────────────────────────────────────────────────────────

/**
 * Stable code for each validation failure. Safe to branch on in tests and in
 * the UI to render route-specific guidance.
 */
export type RouteValidationErrorCode =
  | 'route_not_declared'
  | 'route_not_live'
  | 'route_not_on_network'
  | 'wallet_missing'
  | 'address_invalid_eth'
  | 'address_invalid_stellar'
  | 'address_invalid_solana'
  | 'asset_pair_unsupported'
  | 'amount_missing'
  | 'amount_below_minimum'
  | 'amount_too_many_decimals'
  | 'amount_exceeds_balance'
  | 'quote_missing'
  | 'quote_expired'
  | 'quote_chain_mismatch'
  | 'destination_chain_mismatch';

export interface RouteValidationError {
  code: RouteValidationErrorCode;
  /** User-facing message. Render this directly in the form. */
  message: string;
  /** Field the error should be attached to in the form. */
  field: 'route' | 'amount' | 'balance' | 'quote' | 'destination';
}

// ── Quote validation helper ───────────────────────────────────────────────────

const QUOTE_VALIDITY_SECONDS = 60; // quotes are valid for 60 s from fetchedAt

function validateQuoteForRoute(
  quote: BridgeQuote | null,
  direction: BridgeDirection,
  amount: string,
): RouteValidationError | null {
  if (!quote) {
    return {
      code: 'quote_missing',
      message: 'Waiting for a price quote. This updates automatically — try again in a moment.',
      field: 'quote',
    };
  }

  const ageSeconds = (Date.now() - quote.fetchedAt) / 1000;
  if (ageSeconds > QUOTE_VALIDITY_SECONDS) {
    return {
      code: 'quote_expired',
      message: 'Your price quote expired. The page will refresh it automatically — wait a moment.',
      field: 'quote',
    };
  }

  if (quote.direction !== direction) {
    return {
      code: 'quote_chain_mismatch',
      message: 'Route changed since the last quote. A fresh quote is loading — try again shortly.',
      field: 'quote',
    };
  }

  return null;
}

// ── Input type ────────────────────────────────────────────────────────────────

export interface UseRouteValidatorParams {
  direction: BridgeDirection;
  ethAddress: string;
  stellarAddress: string;
  solanaAddress: string;
  fromTokenSymbol: string;
  toTokenSymbol: string;
  fromTokenDecimals: number;
  amount: string;
  balance: string;
  /** Active quote from the price feed — null when not yet loaded. */
  quote: BridgeQuote | null;
  /** Skip quote validation (e.g. form not yet interacted with). */
  skipQuoteCheck?: boolean;
}

// ── Output type ───────────────────────────────────────────────────────────────

export interface UseRouteValidatorResult {
  /** True when all checks pass and the form can be submitted. */
  canSubmit: boolean;
  /** First validation error in priority order, or null when valid. */
  error: RouteValidationError | null;
  /** All current errors, for forms that surface multiple issues at once. */
  errors: RouteValidationError[];
  /** Per-route disable reason for the route selector (from wallet readiness). */
  unsupportedReasonsByRoute: Partial<Record<BridgeDirection, string>>;
  /** True when the current direction is both declared and live. */
  isRouteSupported: boolean;
  /** True when all required wallets for this direction are connected. */
  walletsReady: boolean;
}

// ── Live route directions that can be shown in the form ───────────────────────

const FORM_ROUTE_OPTIONS: BridgeDirection[] = [
  'eth_to_xlm',
  'xlm_to_eth',
  'eth_to_sol',
  'sol_to_eth',
];

// ── The hook ──────────────────────────────────────────────────────────────────

export function useRouteValidator({
  direction,
  ethAddress,
  stellarAddress,
  solanaAddress,
  fromTokenSymbol,
  toTokenSymbol,
  fromTokenDecimals,
  amount,
  balance,
  quote,
  skipQuoteCheck = false,
}: UseRouteValidatorParams): UseRouteValidatorResult {
  const network = isTestnet() ? 'testnet' : 'mainnet';

  // ── Per-route disabled reasons (used by the route selector buttons) ─────────
  const unsupportedReasonsByRoute = useMemo<Partial<Record<BridgeDirection, string>>>(() => {
    const out: Partial<Record<BridgeDirection, string>> = {};
    for (const route of FORM_ROUTE_OPTIONS) {
      // 1. Is the route live on this network?
      const sdkResult = resolveRoute({ direction: route, network });
      if (!sdkResult.ok) {
        out[route] =
          sdkResult.reason === 'route_not_live'
            ? 'This route is not yet available.'
            : sdkResult.reason === 'route_not_on_network'
            ? `This route is not available on ${network}.`
            : 'Unsupported route.';
        continue;
      }
      // 2. Are the required wallets connected?
      const walletResult = validateRouteWallets(route, ethAddress, stellarAddress, solanaAddress);
      if (!walletResult.isValid) {
        out[route] = walletResult.message;
      }
    }
    return out;
  }, [direction, ethAddress, stellarAddress, solanaAddress, network]);

  // ── Full ordered error list ──────────────────────────────────────────────────
  const { errors, isRouteSupported, walletsReady } = useMemo(() => {
    const errs: RouteValidationError[] = [];

    // ── Layer 1: Route declared ────────────────────────────────────────────────
    const sdkResult = resolveRoute({ direction, network });
    if (!sdkResult.ok) {
      const isLive = sdkResult.reason !== 'route_not_live';
      errs.push({
        code: sdkResult.reason === 'malformed_route_id'
          ? 'route_not_declared'
          : sdkResult.reason === 'route_not_on_network'
          ? 'route_not_on_network'
          : 'route_not_live',
        message: sdkResult.reason === 'route_not_live'
          ? 'This route is coming soon and is not yet available.'
          : sdkResult.reason === 'route_not_on_network'
          ? `This route is not available on ${network}. Switch networks to use it.`
          : 'Unrecognised route. Please select a valid route above.',
        field: 'route',
      });
      return { errors: errs, isRouteSupported: false, walletsReady: false };
    }

    // ── Layer 2: Wallet readiness ──────────────────────────────────────────────
    const walletResult = validateRouteWallets(direction, ethAddress, stellarAddress, solanaAddress);
    const ready = walletResult.isValid;
    if (!ready) {
      errs.push({
        code: 'wallet_missing',
        message: walletResult.message,
        field: 'route',
      });
      // Don't return early — still collect address format errors for wallets
      // that ARE connected but have an invalid format.
    }

    // ── Layer 3: Address format ────────────────────────────────────────────────
    if (ethAddress) {
      const r = validateEthereumAddress(ethAddress);
      if (!r.isValid) errs.push({ code: 'address_invalid_eth', message: r.message, field: 'route' });
    }
    const needsStellar =
      direction === 'eth_to_xlm' || direction === 'xlm_to_eth' ||
      direction === 'xlm_to_sol' || direction === 'sol_to_xlm';
    const needsSolana =
      direction === 'eth_to_sol' || direction === 'sol_to_eth' ||
      direction === 'xlm_to_sol' || direction === 'sol_to_xlm';

    if (needsStellar && stellarAddress) {
      const r = validateStellarAddress(stellarAddress);
      if (!r.isValid) errs.push({ code: 'address_invalid_stellar', message: r.message, field: 'route' });
    }
    if (needsSolana && solanaAddress) {
      const r = validateSolanaAddress(solanaAddress);
      if (!r.isValid) errs.push({ code: 'address_invalid_solana', message: r.message, field: 'route' });
    }

    // ── Layer 4: Asset pair ────────────────────────────────────────────────────
    const assetResult = validateAssetPair(fromTokenSymbol, toTokenSymbol);
    if (!assetResult.isValid) {
      errs.push({ code: 'asset_pair_unsupported', message: assetResult.message, field: 'route' });
    }

    // ── Layer 5–7: Amount ──────────────────────────────────────────────────────
    const minimum = ROUTE_MINIMUMS[direction] ?? 0;
    const amountResult = validateAmount(amount, fromTokenDecimals, minimum > 0 ? String(minimum) : '0');
    if (!amountResult.isValid) {
      const num = parseFloat(amount);
      const code: RouteValidationErrorCode =
        !amount ? 'amount_missing'
        : num < minimum ? 'amount_below_minimum'
        : 'amount_too_many_decimals';
      errs.push({ code, message: amountResult.message, field: 'amount' });
    }

    // ── Layer 8: Balance ───────────────────────────────────────────────────────
    const balResult = validateBalance(amount, balance, fromTokenSymbol);
    if (!balResult.isValid) {
      errs.push({ code: 'amount_exceeds_balance', message: balResult.message, field: 'balance' });
    }

    // ── Layer 9: Destination address vs route ──────────────────────────────────
    // Derive destination address from the currently connected wallets.
    const dstAddress =
      direction.endsWith('_eth') ? ethAddress
      : direction.endsWith('_xlm') ? stellarAddress
      : solanaAddress;
    const dstResult = validateDestinationChain(direction, dstAddress);
    if (!dstResult.isValid) {
      errs.push({ code: 'destination_chain_mismatch', message: dstResult.message, field: 'destination' });
    }

    // ── Layers 10–12: Quote ────────────────────────────────────────────────────
    if (!skipQuoteCheck && amount && parseFloat(amount) > 0) {
      const quoteErr = validateQuoteForRoute(quote, direction, amount);
      if (quoteErr) errs.push(quoteErr);
    }

    return { errors: errs, isRouteSupported: true, walletsReady: ready };
  }, [
    direction,
    ethAddress,
    stellarAddress,
    solanaAddress,
    fromTokenSymbol,
    toTokenSymbol,
    fromTokenDecimals,
    amount,
    balance,
    quote,
    skipQuoteCheck,
    network,
  ]);

  return {
    canSubmit: errors.length === 0,
    error: errors[0] ?? null,
    errors,
    unsupportedReasonsByRoute,
    isRouteSupported,
    walletsReady,
  };
}
