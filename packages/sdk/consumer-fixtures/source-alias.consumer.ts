/**
 * SDK source-alias consumer fixture.
 *
 * This file is type-checked against the TypeScript *source* of
 * @wafflefinance/sdk — the same path the frontend (via Vite) and E2E suite
 * (via Vitest) resolve at build/test time through their alias configs.
 *
 * HOW TO RUN
 * ----------
 *   pnpm --filter @wafflefinance/sdk exec tsc --noEmit -p tsconfig.consumer-src.json
 *
 * The tsconfig.consumer-src.json file uses paths that resolve all
 * @wafflefinance/sdk/* imports to src/ — matching frontend/vite.config.ts
 * and e2e/vitest.config.ts aliases.
 *
 * ACCEPTANCE CRITERIA (from task spec)
 * --------------------------------------
 * ✓  Every supported consumption mode type-checks against the documented
 *    public subpaths via source alias.
 * ✓  Deep internal imports (not in package.json#exports) fail the fixture —
 *    see consumer-fixtures/deep-import.consumer.ts.
 */

// All imports are identical to built-dist.consumer.ts.  The difference is
// entirely in the tsconfig paths — these resolve to src/ not dist/.

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
} from "@wafflefinance/sdk";

import {
  ORDER_STATUSES as STATUSES_T,
  isOrderStatus as isOrderStatus_T,
} from "@wafflefinance/sdk/types";
import type { OrderStatus as OrderStatus_T } from "@wafflefinance/sdk/types";

import {
  canTransition as canTransition_SM,
  isTerminal as isTerminal_SM,
  ORDER_STATUS_TRANSITIONS as TRANSITIONS_SM,
} from "@wafflefinance/sdk/state-machine";

import {
  generateSecret as gen,
  hashSecret as hash,
  verifyPreimage as verify,
} from "@wafflefinance/sdk/secrets";
import type { Secret } from "@wafflefinance/sdk/secrets";

import { HTLCError } from "@wafflefinance/sdk/htlc-client";
import type { IHTLCClient, HTLCCreateResult } from "@wafflefinance/sdk/htlc-client";

import {
  CoordinatorClient,
  validateAnnounceRequest,
  CoordinatorError,
  toOrder,
} from "@wafflefinance/sdk/coordinator";
import type {
  CoordinatorOrder,
  CoordinatorClientOptions,
} from "@wafflefinance/sdk/coordinator";

import {
  NATIVE_ETH_ADDRESS,
  NATIVE_STELLAR_ASSET,
  UnsupportedAssetError,
} from "@wafflefinance/sdk/assets";

import {
  ROUTE_DIRECTIONS,
  isSupportedRoute,
  listRoutes,
} from "@wafflefinance/sdk/routes";
import type { RouteId } from "@wafflefinance/sdk/routes";

import { estimateRouteFee } from "@wafflefinance/sdk/routes/fee-policy";

import {
  SdkConfigurationError,
  validateRpcUrl,
} from "@wafflefinance/sdk/config-validation";

// ── Minimal runtime assertions (same as built-dist fixture) ──────────────────

const _status: OrderStatus = ORDER_STATUSES[0];
const _terminal: TerminalOrderStatus = TERMINAL_ORDER_STATUSES[0];

const _raw: unknown = "announced";
if (isOrderStatus(_raw)) {
  const _typed: OrderStatus = _raw;
  void _typed;
}

const _can: boolean = canTransition("announced", "src_locked");
const _term: boolean = isTerminal("completed");
const _next: OrderStatus[] = nextStatesOf("announced");
void _can; void _term; void _next;

try {
  requireTransition("completed", "announced");
} catch (e) {
  if (e instanceof InvalidTransitionError) {
    const _from: OrderStatus = e.from;
    const _to: OrderStatus = e.to;
    void _from; void _to;
  }
}

const _secret: Secret = generateSecret();
const _hashed: Secret = hashSecret(_secret.preimage);
void _secret; void _hashed;

const _clientOpts: CoordinatorClientOptions = { baseUrl: "http://localhost:3001" };
const _client = new CoordinatorClient(_clientOpts);
void _client;

const _eth: string = NATIVE_ETH_ADDRESS;
void _eth;

const _routes = listRoutes();
void _routes;

const _url = validateRpcUrl("https://rpc.example.com");
void _url;

const _sm: typeof ORDER_STATUS_TRANSITIONS = TRANSITIONS_SM;
void _sm;

export {};
