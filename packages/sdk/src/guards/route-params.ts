/**
 * Runtime guards for deep-link and URL query data (#733).
 *
 * The boundary
 * ────────────
 * A `RouteId` is a template-literal type:
 *
 * ```ts
 * export type RouteId = `${Direction}:${TokenGroup}:${BridgeMode}`;
 * ```
 *
 * which is a genuine win for *producers* — `routes/index.ts` gets a compile
 * error if `formatRouteId` is called with a bad combination. It is no help
 * at all for data arriving as a `string`, which is exactly what a deep link
 * is:
 *
 * ```
 * https://app.example/swap?route=eth_to_xlm:native:wafflefinance-htlc&order=wf_0x…
 * ```
 *
 * Nothing in the SDK reads that today, which is the problem: every consumer
 * that implements deep links writes its own `searchParams.get("route")` and
 * then either casts or lets a malformed value fall through to
 * `getRoute`, which throws a bare `UnknownRouteError` with no indication of
 * *which* parameter was wrong. The same is true of an `order` param and a
 * wallet `address` param.
 *
 * `routes/index.ts` already has the right primitives — `parseRouteId`
 * returns `RouteIdParts | null`, and `isRouteId` is a type guard — but they
 * are not composed into a boundary that reports all problems at once, and
 * `parseRouteId` deliberately does not check that the route *exists* or is
 * *live*. This module does all three, which is the difference between
 * "deep link rejected: `route` names a declared-but-planned route" and
 * "user clicked a link and nothing happened".
 *
 * Error model
 * ───────────
 * `GuardResult`, not exceptions. A deep link is user input: the right
 * behaviour is to collect every problem, show them, and offer a fallback
 * route — not to throw from a click handler. `assert*` forms exist for the
 * server-side case where a bad param is a hard failure.
 */

import {
  formatRouteId,
  getRoute,
  isRouteId,
  parseRouteId,
  type RouteDefinition,
  type RouteId,
} from '../routes/index.js';
import { SUPPORTED_CHAINS } from '../routes/index.js';
import type { Chain } from '../types/index.js';
import { assertGuard, GuardIssueCollector, type GuardResult } from './result.js';
import { parseChainAddress, parsePublicOrderId, type PublicOrderId } from './branded.js';

// ── Query-string reader ─────────────────────────────────────────────────────

/**
 * Minimal read-only view of `URLSearchParams`, so the guards are testable
 * without constructing a `URL` and so a caller can adapt `location.search`,
 * a `Map`, or a test double.
 */
export interface RouteParamSource {
  get(name: string): string | null;
}

/** Adapt the global `URLSearchParams`. */
export function fromSearchParams(params: URLSearchParams): RouteParamSource {
  return { get: name => params.get(name) };
}

/** Read `route` / `order` / `address` / `chain` out of a query string. */
export function fromQueryString(search: string): RouteParamSource {
  return fromSearchParams(new URLSearchParams(search.startsWith('?') ? search.slice(1) : search));
}

// ── Route param ─────────────────────────────────────────────────────────────

/**
 * Validate a `route` deep-link parameter.
 *
 * Three layers, all reported together:
 *   1. well-formed for the three declared slugs (`parseRouteId`)
 *   2. names a route that exists in the registry
 *   3. that route is `live` and enabled on the requested network
 *
 * Layer 3 is the one that catches real user-visible breakage: a share link
 * minted while `eth_to_xlm:usdc:…` was live, opened after the route was
 * pulled, currently throws a bare error from `getRoute`.
 */
export function validateRouteParam(
  input: unknown,
  options: { network?: 'testnet' | 'mainnet' } = {}
): GuardResult<RouteDefinition> {
  const issues = new GuardIssueCollector();

  if (typeof input !== 'string' || input.length === 0) {
    return issues
      .add('route', 'route parameter is required')
      .finish(undefined as unknown as RouteDefinition);
  }

  const parts = parseRouteId(input);
  if (parts === null) {
    return issues
      .add(
        'route',
        `"${input}" is not a well-formed route id; expected "<direction>:<tokenGroup>:<bridgeMode>", ` +
          'e.g. "eth_to_xlm:native:wafflefinance-htlc"'
      )
      .finish(undefined as unknown as RouteDefinition);
  }

  const route = getRoute(formatRouteId(parts));
  if (route === undefined) {
    return issues
      .add('route', `"${input}" is not a declared route in the route registry`)
      .finish(undefined as unknown as RouteDefinition);
  }

  if (route.status !== 'live') {
    issues.add('route', `route "${route.id}" is declared but not live yet`);
  }
  if (options.network !== undefined && !route.networks.includes(options.network)) {
    issues.add(
      'route',
      `route "${route.id}" is not enabled on ${options.network} ` +
        `(enabled: ${route.networks.length === 0 ? 'none' : route.networks.join(', ')})`
    );
  }

  if (issues.length > 0) return { ok: false, issues: issues.list() };
  return { ok: true, value: route };
}

export function assertRouteParam(
  input: unknown,
  options: { network?: 'testnet' | 'mainnet' } = {}
): RouteDefinition {
  return assertGuard(validateRouteParam(input, options), 'route parameter');
}

// ── Order param ─────────────────────────────────────────────────────────────

/**
 * Validate an `order` deep-link parameter.
 *
 * Returns a branded {@link PublicOrderId} rather than `string`, so a
 * validated deep-linked id cannot be passed to `claimOrder` where a preimage
 * is expected.
 */
export function validateOrderParam(input: unknown): GuardResult<PublicOrderId> {
  const issues = new GuardIssueCollector();
  if (input === null || input === undefined) {
    return issues
      .add('order', 'order parameter is missing')
      .finish(undefined as unknown as PublicOrderId);
  }
  const parsed = parsePublicOrderId(input, 'order');
  if (!parsed.ok) {
    for (const issue of parsed.issues) issues.add(issue.field, issue.message);
    return { ok: false, issues: issues.list() };
  }
  return { ok: true, value: parsed.value };
}

export function assertOrderParam(input: unknown): PublicOrderId {
  return assertGuard(validateOrderParam(input), 'order parameter');
}

// ── Address param ───────────────────────────────────────────────────────────

/**
 * Validate a wallet `address` deep-link parameter.
 *
 * The `chain` parameter is optional but load-bearing: without it the
 * address format cannot be checked, because an EVM address and a base-58
 * Solana address are indistinguishable as raw strings. When `chain` is
 * absent the value is only trimmed and checked for emptiness, and the
 * result says so via `chain: null` — the caller must then resolve the chain
 * from the connected wallet before using the address.
 */
export function validateAddressParam(
  input: unknown,
  chain?: unknown
): GuardResult<{ address: string; chain: Chain | null }> {
  const issues = new GuardIssueCollector();

  if (typeof input !== 'string' || input.trim() === '') {
    return issues
      .add('address', 'address parameter is required')
      .finish(undefined as unknown as { address: string; chain: Chain | null });
  }
  const address = input.trim();

  if (chain === undefined || chain === null || chain === '') {
    return { ok: true, value: { address, chain: null } };
  }

  if (typeof chain !== 'string' || !SUPPORTED_CHAINS.includes(chain as Chain)) {
    issues.add('chain', `must be one of: ${SUPPORTED_CHAINS.join(', ')}`);
    return { ok: false, issues: issues.list() };
  }

  const parsed = parseChainAddress(chain as Chain, address, 'address');
  if (!parsed.ok) {
    for (const issue of parsed.issues) issues.add(issue.field, issue.message);
    return { ok: false, issues: issues.list() };
  }
  return { ok: true, value: { address: parsed.value, chain: chain as Chain } };
}

// ── Whole-link guard ────────────────────────────────────────────────────────

/** What a validated deep link resolved to. */
export interface ParsedRouteLink {
  /** The route, when the link carried a `route` parameter. */
  readonly route: RouteDefinition | null;
  /** The order, when the link carried a valid `order` parameter. */
  readonly order: PublicOrderId | null;
  /** The wallet address, when the link carried an `address` parameter. */
  readonly address: { readonly address: string; readonly chain: Chain | null } | null;
}

/**
 * Validate every parameter a swap deep link is allowed to carry, and report
 * all problems at once.
 *
 * Absent optional parameters are *not* errors — a link with only `route` is
 * a perfectly good "start this swap" link. Only a parameter that is present
 * and wrong produces an issue.
 */
export function validateRouteLink(
  source: RouteParamSource,
  options: { network?: 'testnet' | 'mainnet' } = {}
): GuardResult<ParsedRouteLink> {
  const issues = new GuardIssueCollector();

  const rawRoute = source.get('route');
  let route: RouteDefinition | null = null;
  if (rawRoute !== null) {
    const parsed = validateRouteParam(rawRoute, options);
    if (parsed.ok) {
      route = parsed.value;
    } else {
      for (const issue of parsed.issues) issues.add(issue.field, issue.message);
    }
  }

  const rawOrder = source.get('order');
  let order: PublicOrderId | null = null;
  if (rawOrder !== null) {
    const parsed = validateOrderParam(rawOrder);
    if (parsed.ok) {
      order = parsed.value;
    } else {
      for (const issue of parsed.issues) issues.add(issue.field, issue.message);
    }
  }

  const rawAddress = source.get('address');
  let address: ParsedRouteLink['address'] = null;
  if (rawAddress !== null) {
    const parsed = validateAddressParam(rawAddress, source.get('chain'));
    if (parsed.ok) {
      address = parsed.value;
    } else {
      for (const issue of parsed.issues) issues.add(issue.field, issue.message);
    }
  }

  // A link that names both a route and an order is asking the consumer to
  // cross-check the two. The SDK cannot do that without a network call, so
  // it is deliberately *not* an error here — the order is returned
  // alongside the route and the consumer decides whether to verify with
  // `getOrder`. Documented so nobody "fixes" the gap by guessing.

  if (issues.length > 0) return { ok: false, issues: issues.list() };
  return { ok: true, value: { route, order, address } };
}

export function assertRouteLink(
  source: RouteParamSource,
  options: { network?: 'testnet' | 'mainnet' } = {}
): ParsedRouteLink {
  return assertGuard(validateRouteLink(source, options), 'route link');
}

export { isRouteId, type RouteId };
