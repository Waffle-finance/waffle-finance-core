/**
 * SDK built-dist consumer fixture.
 *
 * This file is type-checked against the compiled dist/ output of
 * @wafflefinance/sdk — the same artefact that coordinator, relayer, and
 * resolver import at runtime.  It exercises every documented public subpath
 * so that a type regression in any export surface fails here before it can
 * reach a service.
 *
 * HOW TO RUN
 * ----------
 * After building the SDK:
 *
 *   pnpm --filter @wafflefinance/sdk build
 *   pnpm --filter @wafflefinance/sdk exec tsc --noEmit -p tsconfig.consumer-dist.json
 *
 * The tsconfig.consumer-dist.json file uses paths that resolve all
 * @wafflefinance/sdk/* imports to dist/.  A failure here indicates a type
 * regression in the built package, not in the source.
 *
 * ACCEPTANCE CRITERIA (from task spec)
 * --------------------------------------
 * ✓  Every supported consumption mode type-checks against the documented
 *    public subpaths.
 * ✓  Deep internal imports (not in package.json#exports) fail the fixture —
 *    see consumer-fixtures/deep-import.consumer.ts.
 */

// ── Root subpath ─────────────────────────────────────────────────────────────
import {
  ORDER_STATUSES,
  TERMINAL_ORDER_STATUSES,
  isOrderStatus,
  canTransition,
  requireTransition,
  isTerminal,
  nextStatesOf,
  ORDER_STATUS_TRANSITIONS,
  generateSecret,
  hashSecret,
  verifyPreimage,
  InvalidTransitionError,
} from "@wafflefinance/sdk";
import type {
  Chain,
  Direction,
  OrderStatus,
  TerminalOrderStatus,
  Order,
  ChainLeg,
  ResolverInfo,
} from "@wafflefinance/sdk";

// ── ./types ──────────────────────────────────────────────────────────────────
import {
  ORDER_STATUSES as STATUSES_T,
  TERMINAL_ORDER_STATUSES as TERMINAL_T,
  isOrderStatus as isOrderStatus_T,
} from "@wafflefinance/sdk/types";
import type {
  Chain as Chain_T,
  Direction as Direction_T,
  OrderStatus as OrderStatus_T,
} from "@wafflefinance/sdk/types";

// ── ./state-machine ───────────────────────────────────────────────────────────
import {
  canTransition as canTransition_SM,
  isTerminal as isTerminal_SM,
  ORDER_STATUS_TRANSITIONS as TRANSITIONS_SM,
} from "@wafflefinance/sdk/state-machine";

// ── ./secrets ────────────────────────────────────────────────────────────────
import {
  generateSecret as gen,
  hashSecret as hash,
  verifyPreimage as verify,
} from "@wafflefinance/sdk/secrets";
import type { Secret } from "@wafflefinance/sdk/secrets";

// ── ./htlc-client ────────────────────────────────────────────────────────────
import { HTLCError } from "@wafflefinance/sdk/htlc-client";
import type {
  IHTLCClient,
  HTLCCreateResult,
  HTLCTxResult,
  HTLCErrorCode,
} from "@wafflefinance/sdk/htlc-client";

// ── ./coordinator ─────────────────────────────────────────────────────────────
import {
  CoordinatorClient,
  HistoryClient,
  OrderSubscriber,
  validateAnnounceRequest,
  CoordinatorError,
  CoordinatorApiError,
  toOrder,
} from "@wafflefinance/sdk/coordinator";
import type {
  CoordinatorOrder,
  CoordinatorAnnounceRequest,
  CoordinatorClientOptions,
  HistoryRecord,
} from "@wafflefinance/sdk/coordinator";

// ── ./assets ──────────────────────────────────────────────────────────────────
import {
  NATIVE_ETH_ADDRESS,
  NATIVE_STELLAR_ASSET,
  resolveEthereumToken,
  resolveStellarAsset,
  UnsupportedAssetError,
} from "@wafflefinance/sdk/assets";

// ── ./routes ──────────────────────────────────────────────────────────────────
import {
  ROUTE_DIRECTIONS,
  LIVE_ROUTE_DIRECTIONS,
  isSupportedRoute,
  listRoutes,
} from "@wafflefinance/sdk/routes";
import type { RouteId } from "@wafflefinance/sdk/routes";

// ── ./routes/fee-policy ───────────────────────────────────────────────────────
import {
  estimateRouteFee,
  ROUTE_FEE_POLICIES,
} from "@wafflefinance/sdk/routes/fee-policy";

// ── ./config-validation ───────────────────────────────────────────────────────
import {
  SdkConfigurationError,
  validateRpcUrl,
} from "@wafflefinance/sdk/config-validation";

// ─────────────────────────────────────────────────────────────────────────────
// Runtime type assertions — these confirm that the imported values have the
// expected shapes at the TypeScript level, not just that they imported.
// ─────────────────────────────────────────────────────────────────────────────

// ORDER_STATUSES is a readonly tuple of string literals.
const _status: OrderStatus = ORDER_STATUSES[0];
const _terminal: TerminalOrderStatus = TERMINAL_ORDER_STATUSES[0];

// isOrderStatus is a type guard.
const _raw: unknown = "announced";
if (isOrderStatus(_raw)) {
  const _typed: OrderStatus = _raw;
  void _typed;
}

// canTransition / isTerminal accept OrderStatus.
const _can: boolean = canTransition("announced", "src_locked");
const _term: boolean = isTerminal("completed");
const _next: OrderStatus[] = nextStatesOf("announced");
void _can; void _term; void _next;

// requireTransition throws InvalidTransitionError on bad transitions.
try {
  requireTransition("completed", "announced");
} catch (e) {
  if (e instanceof InvalidTransitionError) {
    const _from: OrderStatus = e.from;
    const _to: OrderStatus = e.to;
    void _from; void _to;
  }
}

// Secret helpers return correctly shaped objects.
const _secret: Secret = generateSecret();
const _hashed: Secret = hashSecret(_secret.preimage);
const _verified = verifyPreimage(_secret.preimage, _secret.sha256);
void _secret; void _hashed; void _verified;

// CoordinatorClient constructor accepts options.
const _clientOpts: CoordinatorClientOptions = { baseUrl: "http://localhost:3001" };
const _client = new CoordinatorClient(_clientOpts);
void _client;

// Asset helpers return string values.
const _eth: string = NATIVE_ETH_ADDRESS;
const _xlm: string = NATIVE_STELLAR_ASSET;
void _eth; void _xlm;

// Route helpers return typed values.
const _routes = listRoutes();
const _isSupported: boolean = isSupportedRoute("eth_to_xlm" as RouteId);
void _routes; void _isSupported;

// Config validation.
const _url = validateRpcUrl("https://rpc.example.com");
void _url;

// Confirm the cross-subpath imports are consistent types.
const _sm: typeof ORDER_STATUS_TRANSITIONS = TRANSITIONS_SM;
void _sm;

export {};
