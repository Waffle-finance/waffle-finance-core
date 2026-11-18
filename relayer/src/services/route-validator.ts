/**
 * @fileoverview Route validator — pre-transaction chain/asset pair validation.
 *
 * Issue #755: Harden relayer path selection for chain pair and asset pairing.
 *
 * Problem
 * -------
 * The relayer's settlement dispatch builds and submits on-chain transactions
 * based on `direction`, `fromChain`, `toChain`, and asset symbol fields.
 * A mismatch — e.g. an `eth_to_xlm` direction with a Solana source chain, or
 * a USDC asset on a route that only supports native ETH — could cause the
 * relayer to either silently fail after wasting gas or execute an incorrect
 * settlement action.
 *
 * Solution
 * --------
 * `validateSettlementRoute` is called immediately before any transaction is
 * submitted.  It:
 *
 *  1. Checks the direction against the canonical SUPPORTED_SETTLEMENT_ROUTES
 *     table (source chain, destination chain, supported asset classes).
 *  2. Validates that fromChain / toChain (when present) agree with the direction.
 *  3. Validates that the asset symbol is supported on the source chain.
 *  4. Returns a typed `RouteValidationResult` — never throws.  Callers decide
 *     the HTTP status code and log the structured denial reason.
 *
 * This complements the entry-point check in `routes/orders.ts`
 * (`decideOrderRoute`) which runs at order ingestion.  The settlement-time
 * check here guards against orders that were ingested before a route was
 * disabled, or orders routed through non-HTTP paths.
 *
 * Usage
 * -----
 * ```ts
 * const check = validateSettlementRoute({ direction, fromChain, toChain, fromToken });
 * if (!check.valid) {
 *   logger.warn({ code: check.code, reason: check.reason }, 'Route rejected at settlement');
 *   return res.status(400).json({ error: 'invalid_route', code: check.code, details: check.reason });
 * }
 * // safe to proceed
 * ```
 */

import { getLogger } from '../logger.js';

const log = getLogger().child({ service: 'route-validator' });

// ---------------------------------------------------------------------------
// Canonical supported routes
// ---------------------------------------------------------------------------

/** Asset classes the relayer's settlement path actually supports. */
export type SupportedAssetClass = 'native';

/**
 * Every route the relayer can execute.  Any direction/chain/asset combination
 * not listed here is rejected before a transaction is built.
 *
 * Extend this table when new chains or assets are onboarded.
 */
export interface SettlementRoute {
  /** Canonical direction identifier used in order records. */
  direction: string;
  /** Chain from which the source HTLC is locked. */
  fromChain: string;
  /** Chain on which the relayer pays out. */
  toChain: string;
  /** Native asset symbols accepted on the fromChain for this route. */
  supportedFromAssets: readonly string[];
  /** Native asset symbols the relayer sends on the toChain. */
  supportedToAssets: readonly string[];
}

export const SUPPORTED_SETTLEMENT_ROUTES: readonly SettlementRoute[] = [
  {
    direction: 'eth_to_xlm',
    fromChain: 'ethereum',
    toChain: 'stellar',
    supportedFromAssets: ['ETH'],
    supportedToAssets: ['XLM'],
  },
  {
    direction: 'xlm_to_eth',
    fromChain: 'stellar',
    toChain: 'ethereum',
    supportedFromAssets: ['XLM'],
    supportedToAssets: ['ETH'],
  },
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RouteValidationRequest {
  direction?: unknown;
  fromChain?: unknown;
  toChain?: unknown;
  /** Source asset symbol (e.g. 'ETH', 'XLM', 'USDC'). */
  fromToken?: unknown;
}

export type RouteValidationResult =
  | { valid: true; route: SettlementRoute }
  | { valid: false; code: string; reason: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalise(v: unknown): string {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

function normaliseAsset(v: unknown): string {
  return typeof v === 'string' ? v.trim().toUpperCase() : '';
}

// ---------------------------------------------------------------------------
// validateSettlementRoute
// ---------------------------------------------------------------------------

/**
 * Validate that a pending settlement is for a supported route before any
 * on-chain transaction is built or submitted.
 *
 * Validation steps (in order):
 *   1. `direction` must map to a declared route.
 *   2. `fromChain` (when present) must match the route's source chain.
 *   3. `toChain` (when present) must match the route's destination chain.
 *   4. `fromToken` (when present) must be in the route's supported asset list.
 *
 * Returns `{ valid: true, route }` on success.
 * Returns `{ valid: false, code, reason }` on any failure — never throws.
 */
export function validateSettlementRoute(
  request: RouteValidationRequest,
): RouteValidationResult {
  const direction = normalise(request.direction);

  const route = SUPPORTED_SETTLEMENT_ROUTES.find((r) => r.direction === direction);
  if (!route) {
    const supported = SUPPORTED_SETTLEMENT_ROUTES.map((r) => r.direction).join(', ');
    const reason =
      `direction "${direction}" is not a supported settlement route ` +
      `(supported: ${supported})`;
    log.warn({ code: 'DIRECTION_UNSUPPORTED', direction }, `[route-validator] ${reason}`);
    return { valid: false, code: 'DIRECTION_UNSUPPORTED', reason };
  }

  // fromChain consistency check
  if (request.fromChain !== undefined && request.fromChain !== null) {
    const declaredFrom = normalise(request.fromChain);
    if (declaredFrom && declaredFrom !== route.fromChain) {
      const reason =
        `fromChain "${declaredFrom}" contradicts direction "${direction}" ` +
        `(expected source chain: ${route.fromChain})`;
      log.warn(
        { code: 'CHAIN_MISMATCH', direction, fromChain: declaredFrom, expected: route.fromChain },
        `[route-validator] ${reason}`,
      );
      return { valid: false, code: 'CHAIN_MISMATCH', reason };
    }
  }

  // toChain consistency check
  if (request.toChain !== undefined && request.toChain !== null) {
    const declaredTo = normalise(request.toChain);
    if (declaredTo && declaredTo !== route.toChain) {
      const reason =
        `toChain "${declaredTo}" contradicts direction "${direction}" ` +
        `(expected destination chain: ${route.toChain})`;
      log.warn(
        { code: 'CHAIN_MISMATCH', direction, toChain: declaredTo, expected: route.toChain },
        `[route-validator] ${reason}`,
      );
      return { valid: false, code: 'CHAIN_MISMATCH', reason };
    }
  }

  // Asset support check
  if (request.fromToken !== undefined && request.fromToken !== null) {
    const asset = normaliseAsset(request.fromToken);
    if (asset && !(route.supportedFromAssets as readonly string[]).includes(asset)) {
      const reason =
        `asset "${asset}" is not supported on ${route.fromChain} for direction "${direction}" ` +
        `(supported: ${route.supportedFromAssets.join(', ')})`;
      log.warn(
        { code: 'ASSET_UNSUPPORTED', direction, asset, supported: route.supportedFromAssets },
        `[route-validator] ${reason}`,
      );
      return { valid: false, code: 'ASSET_UNSUPPORTED', reason };
    }
  }

  return { valid: true, route };
}

/**
 * Assert that a settlement route is valid.  Logs a structured diagnostic and
 * returns the denial object when the route is unsupported, so callers can
 * immediately return an HTTP error without additional log calls.
 */
export function assertSettlementRoute(
  request: RouteValidationRequest,
): RouteValidationResult {
  const result = validateSettlementRoute(request);
  if (!result.valid) {
    // Already logged inside validateSettlementRoute — emit one more at error
    // level so the structured denial is easy to find in operator dashboards.
    log.error(
      { code: result.code, reason: result.reason },
      '[route-validator] settlement blocked: route validation failed',
    );
  }
  return result;
}
