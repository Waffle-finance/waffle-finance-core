/**
 * Route-identity registry — the single source of truth for which bridge
 * routes exist, how they are named, and how a route identity is serialised.
 *
 * Why this module exists
 * ──────────────────────
 * Route identity used to be spread across several encodings: the `Direction`
 * string union in `types/`, a `DIRECTION_CHAINS` table inside coordinator
 * validation, inline `["ethereum", "stellar", "solana"]` chain lists, and
 * per-direction asset guards in `assets/`. Nothing tied those together, so
 * "is this route supported?" had a different answer depending on which helper
 * a caller happened to reach for, and there was no stable identifier to
 * compare a request payload against a history entry.
 *
 * A route identity is the product of four axes:
 *
 *   chain direction  — which chain the value leaves and which it arrives on
 *                      (`eth_to_xlm`, `sol_to_eth`, …)
 *   token group      — the asset class being moved (`native`, `usdc`)
 *   bridge mode      — the engine that moves it (`wafflefinance-htlc` today;
 *                      `cctp-v2` / `axelar-its` are reserved, see types/)
 *   quote model      — how a quote for that engine is produced
 *
 * Those four axes are declared here, every supported combination is listed in
 * {@link ROUTE_REGISTRY}, and a route identity serialises to a stable
 * {@link RouteId} string so payloads and stored history entries can be
 * compared with `===`.
 *
 * Adding a route
 * ──────────────
 * See `packages/sdk/ROUTE_REGISTRY.md` for the full lifecycle. In short: add
 * the asset mapping first (`assets/index.ts`), then add the registry entry
 * here, then extend the tests in `test/routes.test.ts`.
 */

import type { Chain, Direction, ExternalBridgeKind } from "../types/index.js";
import {
  estimateRouteFee,
  getRouteFeePolicy,
  ROUTE_FEE_POLICIES,
  type RouteFeeEstimate,
  type RouteFeeFixture,
  type RouteFeePolicy,
} from "./fee-policy.js";


import {
  NATIVE_ETH_ADDRESS,
  NATIVE_SOL_MINT,
  isSupportedEthToSolana,
  isSupportedEthToStellar,
  isSupportedSolanaToEth,
  isSupportedStellarToEth,
  normalizeEthereumAddress,
  normalizeSolanaMint,
  normalizeStellarAssetKey,
  type AssetMappingNetwork,
} from "../assets/index.js";

// #731: the fee policy is part of the route registry's public surface — the
// root barrel (`src/index.ts`) and the `./routes` subpath both re-export these
// names from here. Without this pass-through `dist/index.js` imports symbols
// `dist/routes/index.js` does not export, which is an ESM link error for every
// consumer of `@wafflefinance/sdk` and not merely a type error.
export {
  estimateRouteFee,
  getRouteFeePolicy,
  ROUTE_FEE_POLICIES,
  type RouteFeeEstimate,
  type RouteFeeFixture,
  type RouteFeePolicy,
} from "./fee-policy.js";

// ── Axis 1: chain direction ──────────────────────────────────────────────────

/**
 * The src/dst chains of every direction the SDK knows about, live or not.
 *
 * This is the only place a direction is decomposed into chains. Callers that
 * need "which chain does this direction start on" must read it from here (or
 * via {@link chainsForDirection}) rather than parsing the direction slug.
 */
export const ROUTE_CHAIN_DIRECTIONS: Readonly<Record<Direction, { src: Chain; dst: Chain }>> = {
  eth_to_xlm: { src: "ethereum", dst: "stellar" },
  xlm_to_eth: { src: "stellar", dst: "ethereum" },
  eth_to_sol: { src: "ethereum", dst: "solana" },
  sol_to_eth: { src: "solana", dst: "ethereum" },
  xlm_to_sol: { src: "stellar", dst: "solana" },
  sol_to_xlm: { src: "solana", dst: "stellar" },
};

/** Every direction in {@link ROUTE_CHAIN_DIRECTIONS}, including planned ones. */
export const ROUTE_DIRECTIONS: ReadonlyArray<Direction> = Object.keys(
  ROUTE_CHAIN_DIRECTIONS,
) as Direction[];

/**
 * The directions that are actually live end-to-end (contracts deployed,
 * coordinator accepting announces). `CoordinatorDirection` is an alias of this
 * union — the coordinator wire contract deliberately tracks the registry.
 */
export type LiveRouteDirection = "eth_to_xlm" | "xlm_to_eth" | "eth_to_sol" | "sol_to_eth";

/** The live directions, in a stable declaration order. */
export const LIVE_ROUTE_DIRECTIONS: ReadonlyArray<LiveRouteDirection> = [
  "eth_to_xlm",
  "xlm_to_eth",
  "eth_to_sol",
  "sol_to_eth",
];

/**
 * src/dst chains for the live directions only. Shape-compatible with
 * `Record<CoordinatorDirection, { src, dst }>`, which is how coordinator
 * validation consumes it.
 */
export const LIVE_DIRECTION_CHAINS: Readonly<
  Record<LiveRouteDirection, { src: Chain; dst: Chain }>
> = {
  eth_to_xlm: ROUTE_CHAIN_DIRECTIONS.eth_to_xlm,
  xlm_to_eth: ROUTE_CHAIN_DIRECTIONS.xlm_to_eth,
  eth_to_sol: ROUTE_CHAIN_DIRECTIONS.eth_to_sol,
  sol_to_eth: ROUTE_CHAIN_DIRECTIONS.sol_to_eth,
};

/** Every chain that appears on at least one declared route. */
export const SUPPORTED_CHAINS: ReadonlyArray<Chain> = Array.from(
  new Set(Object.values(ROUTE_CHAIN_DIRECTIONS).flatMap((d) => [d.src, d.dst])),
);

// ── Axis 2: token group ──────────────────────────────────────────────────────

/**
 * The asset classes the bridge routes. A token group is chain-agnostic: the
 * concrete per-chain identifiers for each group live in `assets/index.ts` and
 * that module stays the source of truth for them.
 */
export type TokenGroup = "native" | "usdc";

/** All declared token groups. */
export const TOKEN_GROUPS: ReadonlyArray<TokenGroup> = ["native", "usdc"];

// ── Axis 3: bridge mode ──────────────────────────────────────────────────────

/**
 * The engine that performs the transfer. Same union as `ExternalBridgeKind`
 * so an adapter's `kind` and a route's `bridgeMode` are the same vocabulary.
 */
export type BridgeMode = ExternalBridgeKind;

/** All declared bridge modes, including the ones with no adapter yet. */
export const BRIDGE_MODES: ReadonlyArray<BridgeMode> = [
  "wafflefinance-htlc",
  "cctp-v2",
  "axelar-its",
];

/** The mode assumed when a caller does not name one. */
export const DEFAULT_BRIDGE_MODE: BridgeMode = "wafflefinance-htlc";

// ── Axis 4: quote model ──────────────────────────────────────────────────────

/**
 * How a quote for a route is produced. Distinct from the bridge mode because
 * two engines can share a pricing model, and one engine may gain a second
 * model (e.g. a fast path) without becoming a different engine.
 *
 *   atomic-htlc         — resolver fills the destination leg against a
 *                         hashlock; the rate is fixed at announce time and the
 *                         settlement window is bounded by the dst timelock.
 *   attested-burn-mint  — value is burned on the source chain and minted on
 *                         the destination against an attestation; the rate is
 *                         1:1 and latency is attester-bound.
 *   wrapped-mint        — value is locked on the source chain and a wrapped
 *                         representation is minted by a validator set.
 */
export type QuoteModel = "atomic-htlc" | "attested-burn-mint" | "wrapped-mint";

/** All declared quote models. */
export const QUOTE_MODELS: ReadonlyArray<QuoteModel> = [
  "atomic-htlc",
  "attested-burn-mint",
  "wrapped-mint",
];

// ── Route identity ───────────────────────────────────────────────────────────

/**
 * Serialised route identity: `<direction>:<tokenGroup>:<bridgeMode>`.
 *
 * The three components are fixed slugs that never contain `:`, so the string
 * round-trips through {@link parseRouteId} without ambiguity, and two route
 * identities are equal exactly when their ids are `===`. Safe to persist in a
 * request payload, a history record, or a cache key.
 */
export type RouteId = `${Direction}:${TokenGroup}:${BridgeMode}`;

/** The three components a {@link RouteId} encodes. */
export interface RouteIdParts {
  direction: Direction;
  tokenGroup: TokenGroup;
  bridgeMode: BridgeMode;
}

/** Whether a route can be used today, or is declared but not yet enabled. */
export type RouteStatus = "live" | "planned";

/** A single supported (or declared-but-planned) bridge route. */
export interface RouteDefinition extends RouteIdParts {
  /** Stable serialised identity — see {@link RouteId}. */
  readonly id: RouteId;
  readonly direction: Direction;
  /** Chain the value leaves. Always `ROUTE_CHAIN_DIRECTIONS[direction].src`. */
  readonly src: Chain;
  /** Chain the value arrives on. Always `ROUTE_CHAIN_DIRECTIONS[direction].dst`. */
  readonly dst: Chain;
  readonly tokenGroup: TokenGroup;
  readonly bridgeMode: BridgeMode;
  readonly quoteModel: QuoteModel;
  /**
   * Networks the route is enabled on. Empty for `planned` routes. A route that
   * exists on testnet but not mainnet lists only `"testnet"` — this is what
   * makes network switching deterministic rather than a guess.
   */
  readonly networks: ReadonlyArray<AssetMappingNetwork>;
  readonly status: RouteStatus;
  /** Human-readable label for UI presentation. */
  readonly label: string;
}

// ── Serialisation ────────────────────────────────────────────────────────────

/** Serialise route components into the canonical {@link RouteId} form. */
export function formatRouteId(parts: RouteIdParts): RouteId {
  return `${parts.direction}:${parts.tokenGroup}:${parts.bridgeMode}`;
}

/**
 * Parse a {@link RouteId} back into its components.
 *
 * Returns null when the string is malformed or names a slug that is not
 * declared on any axis. Parsing does NOT imply the route exists — use
 * {@link getRoute} for that.
 */
export function parseRouteId(id: string): RouteIdParts | null {
  const segments = id.split(":");
  if (segments.length !== 3) return null;

  const [direction, tokenGroup, bridgeMode] = segments as [string, string, string];
  if (!(ROUTE_DIRECTIONS as string[]).includes(direction)) return null;
  if (!(TOKEN_GROUPS as string[]).includes(tokenGroup)) return null;
  if (!(BRIDGE_MODES as string[]).includes(bridgeMode)) return null;

  return {
    direction: direction as Direction,
    tokenGroup: tokenGroup as TokenGroup,
    bridgeMode: bridgeMode as BridgeMode,
  };
}

/** True when `value` is a well-formed route id for declared slugs. */
export function isRouteId(value: unknown): value is RouteId {
  return typeof value === "string" && parseRouteId(value) !== null;
}

// ── The registry ─────────────────────────────────────────────────────────────

function define(
  direction: Direction,
  tokenGroup: TokenGroup,
  bridgeMode: BridgeMode,
  quoteModel: QuoteModel,
  networks: ReadonlyArray<AssetMappingNetwork>,
  status: RouteStatus,
  label: string,
): RouteDefinition {
  const { src, dst } = ROUTE_CHAIN_DIRECTIONS[direction];
  return {
    id: formatRouteId({ direction, tokenGroup, bridgeMode }),
    direction,
    src,
    dst,
    tokenGroup,
    bridgeMode,
    quoteModel,
    networks,
    status,
    label,
  };
}

const BOTH_NETWORKS: ReadonlyArray<AssetMappingNetwork> = ["testnet", "mainnet"];
const TESTNET_ONLY: ReadonlyArray<AssetMappingNetwork> = ["testnet"];
const NO_NETWORKS: ReadonlyArray<AssetMappingNetwork> = [];

/**
 * Every route the SDK recognises.
 *
 * Network availability mirrors the asset mapping tables in `assets/index.ts`:
 * native assets are mapped on both networks, USDC only on testnet. The two
 * Stellar↔Solana directions are declared because `Direction` includes them,
 * but they have no contracts or asset mappings yet, so they are `planned` and
 * every validation helper rejects them.
 */
export const ROUTE_REGISTRY: ReadonlyArray<RouteDefinition> = [
  // ── Ethereum ↔ Stellar ─────────────────────────────────────────────────
  define("eth_to_xlm", "native", "wafflefinance-htlc", "atomic-htlc", BOTH_NETWORKS, "live",
    "ETH → XLM (WaffleFinance HTLC)"),
  define("eth_to_xlm", "usdc", "wafflefinance-htlc", "atomic-htlc", TESTNET_ONLY, "live",
    "USDC Ethereum → Stellar (WaffleFinance HTLC)"),
  define("xlm_to_eth", "native", "wafflefinance-htlc", "atomic-htlc", BOTH_NETWORKS, "live",
    "XLM → ETH (WaffleFinance HTLC)"),
  define("xlm_to_eth", "usdc", "wafflefinance-htlc", "atomic-htlc", TESTNET_ONLY, "live",
    "USDC Stellar → Ethereum (WaffleFinance HTLC)"),

  // ── Ethereum ↔ Solana ──────────────────────────────────────────────────
  define("eth_to_sol", "native", "wafflefinance-htlc", "atomic-htlc", BOTH_NETWORKS, "live",
    "ETH → SOL (WaffleFinance HTLC)"),
  define("eth_to_sol", "usdc", "wafflefinance-htlc", "atomic-htlc", TESTNET_ONLY, "live",
    "USDC Ethereum → Solana (WaffleFinance HTLC)"),
  define("sol_to_eth", "native", "wafflefinance-htlc", "atomic-htlc", BOTH_NETWORKS, "live",
    "SOL → ETH (WaffleFinance HTLC)"),
  define("sol_to_eth", "usdc", "wafflefinance-htlc", "atomic-htlc", TESTNET_ONLY, "live",
    "USDC Solana → Ethereum (WaffleFinance HTLC)"),

  // ── Stellar ↔ Solana — declared, not enabled ───────────────────────────
  define("xlm_to_sol", "native", "wafflefinance-htlc", "atomic-htlc", NO_NETWORKS, "planned",
    "XLM → SOL (planned)"),
  define("sol_to_xlm", "native", "wafflefinance-htlc", "atomic-htlc", NO_NETWORKS, "planned",
    "SOL → XLM (planned)"),
];

const ROUTES_BY_ID: ReadonlyMap<string, RouteDefinition> = new Map(
  ROUTE_REGISTRY.map((route) => [route.id, route]),
);

/** Every declared route id, in registry order. */
export const ROUTE_IDS: ReadonlyArray<RouteId> = ROUTE_REGISTRY.map((r) => r.id);

// ── Errors ───────────────────────────────────────────────────────────────────

/** Why a route lookup failed. Stable codes — safe to branch on. */
export type UnknownRouteReason =
  /** The route id was malformed or named an undeclared slug. */
  | "malformed_route_id"
  /** No registry entry for this direction / token group / bridge mode combo. */
  | "unknown_route"
  /** The route is declared but not enabled yet. */
  | "route_not_live"
  /** The route is live, but not on the requested network. */
  | "route_not_on_network";

/**
 * Thrown by {@link assertSupportedRoute} when a route cannot be used.
 *
 * `reason` distinguishes "we have never heard of this" from "we know it but it
 * is not enabled here", which callers need in order to show a useful message
 * instead of a generic rejection.
 */
export class UnknownRouteError extends Error {
  constructor(
    /** The route id or selector description that failed to resolve. */
    public readonly route: string,
    public readonly reason: UnknownRouteReason,
    message?: string,
  ) {
    super(message ?? `Unsupported route "${route}" (${reason})`);
    this.name = "UnknownRouteError";
  }
}

// ── Lookup ───────────────────────────────────────────────────────────────────

/** A route named by its parts. Unnamed axes fall back to documented defaults. */
export interface RouteSelector {
  direction: string;
  /** Defaults to `"native"`. */
  tokenGroup?: string;
  /** Defaults to {@link DEFAULT_BRIDGE_MODE}. */
  bridgeMode?: string;
  /** When given, the route must be enabled on this network. */
  network?: AssetMappingNetwork;
}

/** Look a route up by its serialised id. Returns undefined if not declared. */
export function getRoute(id: string): RouteDefinition | undefined {
  return ROUTES_BY_ID.get(id);
}

/**
 * Resolve a selector to its registry entry, or explain why it cannot be used.
 *
 * A route resolves only when it is declared, `live`, and (if a network was
 * given) enabled on that network. This is the function every other route
 * check in the SDK is built on.
 */
export function resolveRoute(
  selector: RouteSelector,
): { ok: true; route: RouteDefinition } | { ok: false; reason: UnknownRouteReason; route: string } {
  const parts = parseRouteId(
    formatRouteId({
      direction: selector.direction as Direction,
      tokenGroup: (selector.tokenGroup ?? "native") as TokenGroup,
      bridgeMode: (selector.bridgeMode ?? DEFAULT_BRIDGE_MODE) as BridgeMode,
    }),
  );
  if (!parts) {
    const described = `${selector.direction}:${selector.tokenGroup ?? "native"}:${
      selector.bridgeMode ?? DEFAULT_BRIDGE_MODE
    }`;
    return { ok: false, reason: "malformed_route_id", route: described };
  }

  const id = formatRouteId(parts);
  const route = ROUTES_BY_ID.get(id);
  if (!route) return { ok: false, reason: "unknown_route", route: id };
  if (route.status !== "live") return { ok: false, reason: "route_not_live", route: id };
  if (selector.network && !route.networks.includes(selector.network)) {
    return { ok: false, reason: "route_not_on_network", route: id };
  }

  return { ok: true, route };
}

/** True when the selector names a route that can be used right now. */
export function isSupportedRoute(selector: RouteSelector): boolean {
  return resolveRoute(selector).ok;
}

/**
 * Resolve a selector or throw {@link UnknownRouteError}.
 * Use when an unsupported route is a programming error rather than user input.
 */
export function assertSupportedRoute(selector: RouteSelector): RouteDefinition {
  const result = resolveRoute(selector);
  if (!result.ok) {
    throw new UnknownRouteError(result.route, result.reason);
  }
  return result.route;
}

// ── Discovery ────────────────────────────────────────────────────────────────

/** Filter for {@link listRoutes}. Omitted fields match everything. */
export interface RouteFilter {
  direction?: Direction;
  tokenGroup?: TokenGroup;
  bridgeMode?: BridgeMode;
  quoteModel?: QuoteModel;
  status?: RouteStatus;
  /** Only routes enabled on this network. */
  network?: AssetMappingNetwork;
}

/**
 * List registry entries matching `filter`, in declaration order.
 * With no filter, returns every declared route including planned ones.
 */
export function listRoutes(filter: RouteFilter = {}): RouteDefinition[] {
  return ROUTE_REGISTRY.filter((route) => {
    if (filter.direction && route.direction !== filter.direction) return false;
    if (filter.tokenGroup && route.tokenGroup !== filter.tokenGroup) return false;
    if (filter.bridgeMode && route.bridgeMode !== filter.bridgeMode) return false;
    if (filter.quoteModel && route.quoteModel !== filter.quoteModel) return false;
    if (filter.status && route.status !== filter.status) return false;
    if (filter.network && !route.networks.includes(filter.network)) return false;
    return true;
  });
}

/** Every live route on `network` — the set a token/route picker should show. */
export function listRoutesForNetwork(network: AssetMappingNetwork): RouteDefinition[] {
  return listRoutes({ status: "live", network });
}

/** src/dst chains for a direction, or null if the direction is not declared. */
export function chainsForDirection(direction: string): { src: Chain; dst: Chain } | null {
  return ROUTE_CHAIN_DIRECTIONS[direction as Direction] ?? null;
}

/**
 * The direction that moves value from `src` to `dst`, or null if no declared
 * direction does. Replaces ad hoc chain-pair comparisons at call sites.
 */
export function directionForChains(src: string, dst: string): Direction | null {
  for (const direction of ROUTE_DIRECTIONS) {
    const chains = ROUTE_CHAIN_DIRECTIONS[direction];
    if (chains.src === src && chains.dst === dst) return direction;
  }
  return null;
}

/** True when `direction` is declared and live. */
export function isLiveDirection(direction: unknown): direction is LiveRouteDirection {
  return (
    typeof direction === "string" &&
    (LIVE_ROUTE_DIRECTIONS as string[]).includes(direction)
  );
}

/**
 * Networks a route is enabled on — what a wallet must be connected to before
 * the route can be used. Empty for planned or undeclared routes.
 */
export function networksForRoute(id: string): ReadonlyArray<AssetMappingNetwork> {
  return getRoute(id)?.networks ?? [];
}

/** True when the declared route is live on `network`. */
export function isRouteOnNetwork(id: string, network: AssetMappingNetwork): boolean {
  const route = getRoute(id);
  return route?.status === "live" && route.networks.includes(network);
}

// ── Token-group resolution ───────────────────────────────────────────────────

/**
 * Is `asset` a mapped (non-native) asset on the `leg`→`counterpart` pair?
 *
 * Delegates to the asset mapping guards so `assets/index.ts` stays the source
 * of truth for concrete addresses, issuers, and mints.
 */
function isMappedAsset(
  leg: Chain,
  counterpart: Chain,
  asset: string,
  network: AssetMappingNetwork,
): boolean {
  if (leg === "ethereum" && counterpart === "stellar") return isSupportedEthToStellar(asset, network);
  if (leg === "ethereum" && counterpart === "solana") return isSupportedEthToSolana(asset, network);
  if (leg === "stellar" && counterpart === "ethereum") return isSupportedStellarToEth(asset, network);
  if (leg === "solana" && counterpart === "ethereum") return isSupportedSolanaToEth(asset, network);
  // Stellar↔Solana has no mapping table yet; planned routes resolve to null.
  return false;
}

/** True when `asset` is the native asset of `chain`. */
function isNativeAsset(chain: Chain, asset: string): boolean {
  if (chain === "ethereum") return normalizeEthereumAddress(asset) === NATIVE_ETH_ADDRESS;
  if (chain === "stellar") return normalizeStellarAssetKey(asset) === "XLM";
  if (chain === "solana") return normalizeSolanaMint(asset) === NATIVE_SOL_MINT;
  return false;
}

/**
 * Which token group an asset on one leg of a direction belongs to, or null if
 * the asset is not routable there.
 *
 * INVARIANT: every non-native asset in the mapping tables is USDC (see
 * `ASSET_MAPPING_CONTRACT.md`). When a second non-native group is added, this
 * function must resolve the group from the asset's symbol instead of returning
 * `"usdc"` for anything mapped — the route tests assert the invariant so the
 * omission cannot pass silently.
 */
export function tokenGroupForAsset(
  direction: string,
  side: "src" | "dst",
  asset: string,
  network: AssetMappingNetwork = "testnet",
): TokenGroup | null {
  const chains = chainsForDirection(direction);
  if (!chains) return null;

  const leg = side === "src" ? chains.src : chains.dst;
  const counterpart = side === "src" ? chains.dst : chains.src;

  if (isNativeAsset(leg, asset)) return "native";
  if (isMappedAsset(leg, counterpart, asset, network)) return "usdc";
  return null;
}

// ── Route identity of an order ───────────────────────────────────────────────

/**
 * The minimum shape needed to derive a route identity. Structurally satisfied
 * by the SDK `Order`, the coordinator wire `CoordinatorOrder`, and
 * `HistoryRecord`, so all three can be compared against each other.
 */
export interface RouteIdentitySource {
  direction: string;
  src: { chain: string; asset: string };
  dst: { chain: string; asset: string };
}

/**
 * Derive the serialised route identity of an order or history entry.
 *
 * Returns null when the legs contradict the direction or the source asset is
 * not routable on it — i.e. when the record does not describe a route the
 * registry recognises. `bridgeMode` is {@link DEFAULT_BRIDGE_MODE}: orders
 * carry no mode field because every order the coordinator stores today is an
 * HTLC swap.
 */
export function routeIdForOrder(
  order: RouteIdentitySource,
  network: AssetMappingNetwork = "testnet",
): RouteId | null {
  const chains = chainsForDirection(order.direction);
  if (!chains) return null;
  if (order.src.chain !== chains.src || order.dst.chain !== chains.dst) return null;

  const tokenGroup = tokenGroupForAsset(order.direction, "src", order.src.asset, network);
  if (!tokenGroup) return null;

  return formatRouteId({
    direction: order.direction as Direction,
    tokenGroup,
    bridgeMode: DEFAULT_BRIDGE_MODE,
  });
}

/**
 * True when two orders/history entries travel the same route.
 *
 * Compares serialised identities, so a payload built by the SDK and a record
 * read back from the coordinator match without field-by-field comparison.
 * Records whose route cannot be derived are never equal — an unresolvable
 * route is not evidence of sameness.
 */
export function sameRoute(
  a: RouteIdentitySource,
  b: RouteIdentitySource,
  network: AssetMappingNetwork = "testnet",
): boolean {
  const left = routeIdForOrder(a, network);
  const right = routeIdForOrder(b, network);
  return left !== null && left === right;
}
