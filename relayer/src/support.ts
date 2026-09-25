/**
 * Relayer-side adapter for the shared support-policy contract.
 *
 * The typed contract itself lives in `@wafflefinance/config` so the relayer and
 * resolver answer capability questions the same way.  This module holds only
 * what is relayer-specific: building the policy from the loaded config, and
 * translating the wire shape of `POST /api/orders/create` (a `direction` string,
 * chain names, token symbols) into policy queries.
 */

import {
  buildRelayerSupportPolicy,
  describeSupportPolicy,
  formatSupportPolicy,
  normaliseChain,
  supportsRoute,
  validateSupportPolicy,
  type NetworkMode,
  type SupportDenial,
  type SupportedChain,
  type SupportPolicy,
  type SupportVerdict,
  type TokenClass,
} from '@wafflefinance/config';
import { getLogger } from './logger.js';

/** The config fields the relayer policy is derived from. */
export interface RelayerPolicyConfig {
  network: NetworkMode;
  ethereum: {
    rpcUrl: string;
    privateKey: string;
    escrowFactoryAddress?: string | null;
  };
  stellar: {
    horizonUrl: string;
    secretKey: string;
  };
}

/** Build the relayer's support policy from its loaded configuration. */
export function buildSupportPolicy(
  cfg: RelayerPolicyConfig,
  solanaProgramId?: string
): SupportPolicy {
  return buildRelayerSupportPolicy({
    network: cfg.network,
    ethereum: {
      rpcUrl: cfg.ethereum.rpcUrl,
      privateKey: cfg.ethereum.privateKey,
      escrowFactoryAddress: cfg.ethereum.escrowFactoryAddress ?? null,
    },
    stellar: {
      horizonUrl: cfg.stellar.horizonUrl,
      secretKey: cfg.stellar.secretKey,
    },
    solana: { programId: solanaProgramId ?? null },
  });
}

/**
 * Log the support policy's warnings and full capability description.
 *
 * Warnings indicate misconfiguration (missing keys, placeholder values, etc.)
 * and are logged at warn level. The full capability description is logged at
 * info level so operators can confirm exactly which routes are available.
 */
export function logSupportPolicy(policy: SupportPolicy): void {
  const log = getLogger().child({ service: 'support-policy' });
  const validation = validateSupportPolicy(policy);
  for (const warning of validation.warnings) {
    log.warn({ code: warning.code }, warning.message);
  }
  log.info({ capabilities: formatSupportPolicy(policy) }, '[support] policy loaded');
}

/**
 * The chain pair each `direction` value on the orders API corresponds to.
 *
 * `direction` was previously the *only* field the order handler branched on,
 * while `fromChain` / `toChain` were required to be present and then ignored.
 * Mapping direction onto canonical chains here lets both be checked against one
 * policy, and lets a mismatch between them be rejected rather than resolved by
 * whichever field the code happened to read.
 */
export const DIRECTION_ROUTES: Readonly<
  Record<string, { from: SupportedChain; to: SupportedChain }>
> = {
  eth_to_xlm: { from: 'ethereum', to: 'stellar' },
  xlm_to_eth: { from: 'stellar', to: 'ethereum' },
};

/** Native asset symbol for each chain. */
const NATIVE_SYMBOLS: Readonly<Record<SupportedChain, string>> = {
  ethereum: 'ETH',
  stellar: 'XLM',
  solana: 'SOL',
};

/**
 * Classify a token symbol into the asset class the policy reasons about.
 *
 * Anything that is not the chain's native unit is a contract-issued asset of
 * that chain's token standard.  The relayer only implements native transfers
 * today, so this is what causes a USDC request to be refused instead of being
 * silently escrowed as native ETH.
 */
export function classifyToken(chain: SupportedChain, symbol: string): TokenClass {
  const upper = symbol.trim().toUpperCase();
  if (upper === NATIVE_SYMBOLS[chain]) return 'native';
  switch (chain) {
    case 'ethereum':
      return 'erc20';
    case 'stellar':
      return 'stellar-asset';
    case 'solana':
      return 'spl';
  }
}

/** The order fields relevant to a route capability decision. */
export interface OrderRouteRequest {
  direction?: unknown;
  fromChain?: unknown;
  toChain?: unknown;
  fromToken?: unknown;
}

/**
 * The outcome of a route capability decision.
 *
 * Deliberately a flat shape with optional fields rather than a discriminated
 * union: the relayer compiles with `"strict": false`, where TypeScript cannot
 * narrow a union by a boolean discriminant, so a union would force every call
 * site into casts.  `code` / `reason` are populated on refusal, `from` / `to` /
 * `tokenClass` on acceptance.
 */
export interface OrderRouteDecision {
  supported: boolean;
  /** Machine-readable denial identifier. Set only when `supported` is false. */
  code?: string;
  /** Human-readable denial reason. Set only when `supported` is false. */
  reason?: string;
  /** Canonical source chain. Set only when `supported` is true. */
  from?: SupportedChain;
  /** Canonical destination chain. Set only when `supported` is true. */
  to?: SupportedChain;
  /** Resolved source asset class. Set only when `supported` is true. */
  tokenClass?: TokenClass;
}

function reject(code: string, reason: string): OrderRouteDecision {
  return { supported: false, code, reason };
}

/**
 * Decide whether an incoming order request names a route this relayer supports.
 *
 * Checks, in order:
 *  1. `direction` is a direction the relayer has a code path for.
 *  2. `fromChain` / `toChain`, when supplied, agree with that direction — a
 *     request claiming `solana → ethereum` while asking for `eth_to_xlm` is
 *     contradictory and is refused rather than silently resolved.
 *  3. The resulting route and asset class are supported by the policy.
 *
 * Returning a decision object rather than throwing keeps the HTTP handler in
 * control of the status code and response shape.
 */
export function decideOrderRoute(
  policy: SupportPolicy,
  request: OrderRouteRequest
): OrderRouteDecision {
  const direction = typeof request.direction === 'string' ? request.direction.trim() : '';
  const route = DIRECTION_ROUTES[direction];
  if (!route) {
    return reject(
      'DIRECTION_UNSUPPORTED',
      `direction "${direction}" is not supported (expected one of: ` +
        `${Object.keys(DIRECTION_ROUTES).join(', ')})`
    );
  }

  // When the client also names the chains, they must agree with the direction.
  if (request.fromChain !== undefined && request.fromChain !== null) {
    const declared = normaliseChain(String(request.fromChain));
    if (!declared) {
      return reject(
        'CHAIN_UNKNOWN',
        `fromChain "${String(request.fromChain)}" is not a known chain`
      );
    }
    if (declared !== route.from) {
      return reject(
        'ROUTE_INCONSISTENT',
        `fromChain "${declared}" contradicts direction "${direction}", ` +
          `which starts on ${route.from}`
      );
    }
  }
  if (request.toChain !== undefined && request.toChain !== null) {
    const declared = normaliseChain(String(request.toChain));
    if (!declared) {
      return reject(
        'CHAIN_UNKNOWN',
        `toChain "${String(request.toChain)}" is not a known chain`
      );
    }
    if (declared !== route.to) {
      return reject(
        'ROUTE_INCONSISTENT',
        `toChain "${declared}" contradicts direction "${direction}", ` +
          `which ends on ${route.to}`
      );
    }
  }

  const tokenClass =
    typeof request.fromToken === 'string' && request.fromToken.trim() !== ''
      ? classifyToken(route.from, request.fromToken)
      : 'native';

  const verdict: SupportVerdict = supportsRoute(policy, {
    from: route.from,
    to: route.to,
    tokenClass,
  });
  if (!verdict.supported) {
    // Explicit cast because this package compiles without strictNullChecks,
    // where the union above does not narrow on `supported`.
    const denial = verdict as SupportDenial;
    return reject(denial.code, denial.reason);
  }

  return { supported: true, from: route.from, to: route.to, tokenClass };
}

/** JSON-serialisable capability description, for `GET /api/support`. */
export function supportSummary(policy: SupportPolicy) {
  return describeSupportPolicy(policy);
}
