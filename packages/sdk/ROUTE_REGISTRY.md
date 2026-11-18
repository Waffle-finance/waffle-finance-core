# Route Identity Registry

## Overview

`@wafflefinance/sdk/routes` is the single source of truth for which bridge
routes exist, how a route is named, and how a route identity is serialised.
Route validation, quoting, and network switching in the SDK all resolve through
it, so the answer to "is this route supported?" does not depend on which helper
a caller reaches for.

Before the registry, route identity was spread across four encodings: the
`Direction` union in `src/types/`, a `DIRECTION_CHAINS` table inside coordinator
validation, inline `["ethereum", "stellar", "solana"]` chain lists, and
per-direction asset guards in `src/assets/`. Nothing tied them together, and
there was no stable identifier for comparing a request payload against a stored
history entry.

## The four axes of a route

A route identity is the product of four axes. Every axis is a closed union — an
unrecognised value on any of them is rejected, never guessed.

| Axis | Type | Values today |
| --- | --- | --- |
| **Chain direction** | `Direction` | `eth_to_xlm`, `xlm_to_eth`, `eth_to_sol`, `sol_to_eth`, plus the declared-but-planned `xlm_to_sol`, `sol_to_xlm` |
| **Token group** | `TokenGroup` | `native`, `usdc` |
| **Bridge mode** | `BridgeMode` | `wafflefinance-htlc` (live); `cctp-v2`, `axelar-its` reserved for v2.1 adapters |
| **Quote model** | `QuoteModel` | `atomic-htlc` (live); `attested-burn-mint`, `wrapped-mint` reserved |

The bridge mode is the engine that moves the value; the quote model is how a
quote for it is produced. They are separate axes because two engines can share a
pricing model, and one engine can gain a second model (say a fast path) without
becoming a different engine.

Chain direction decomposes into chains in exactly one place,
`ROUTE_CHAIN_DIRECTIONS`. Nothing parses a direction slug to work out which
chain a swap starts on — call `chainsForDirection(direction)` instead, or
`directionForChains(src, dst)` for the reverse.

When a consumer starts from source/destination chains, use
`validateChainPair` from `@wafflefinance/sdk/config-validation`. It delegates to
`directionForChains` and `assertSupportedRoute`, so frontend checkout,
coordinator validation, relayer processing, and resolver routing all reject the
same unsupported pairs with the same reasons.

## Serialised route identity

A route identity serialises to a `RouteId`:

```
<direction>:<tokenGroup>:<bridgeMode>

eth_to_xlm:native:wafflefinance-htlc
sol_to_eth:usdc:wafflefinance-htlc
```

All three components are fixed slugs that never contain `:`, so the form is
unambiguous, round-trips through `parseRouteId`, and two identities are equal
exactly when their ids are `===`. Safe to put in a request payload, a stored
history record, or a cache key.

```typescript
import { formatRouteId, parseRouteId, isRouteId } from '@wafflefinance/sdk/routes';

const id = formatRouteId({
  direction: 'eth_to_xlm',
  tokenGroup: 'usdc',
  bridgeMode: 'wafflefinance-htlc',
});                                  // "eth_to_xlm:usdc:wafflefinance-htlc"

parseRouteId(id);                    // { direction, tokenGroup, bridgeMode }
parseRouteId('eth_to_btc:native:wafflefinance-htlc');  // null — undeclared slug
isRouteId('eth_to_xlm:native');      // false — malformed
```

Parsing is a syntax check, not a support check: `parseRouteId` accepts any
combination of declared slugs, including combinations that have no registry
entry. Use `resolveRoute` / `getRoute` to ask whether a route actually exists.

## Validating a route

`resolveRoute` is the function every other route check is built on. A route
resolves only when it is declared, `live`, and — if a network was given —
enabled on that network.

```typescript
import { resolveRoute, isSupportedRoute, assertSupportedRoute } from '@wafflefinance/sdk/routes';

// Structured result — use when an unsupported route is user input.
const result = resolveRoute({ direction: 'eth_to_xlm', tokenGroup: 'usdc', network: 'mainnet' });
if (!result.ok) {
  console.log(result.reason);        // "route_not_on_network"
}

// Boolean guard.
isSupportedRoute({ direction: 'eth_to_xlm' });          // true (defaults below)

// Throwing form — use when an unsupported route is a programming error.
const route = assertSupportedRoute({ direction: 'sol_to_eth', tokenGroup: 'native' });
route.quoteModel;                                        // "atomic-htlc"
```

`tokenGroup` defaults to `"native"` and `bridgeMode` to `DEFAULT_BRIDGE_MODE`
(`"wafflefinance-htlc"`), so a direction alone names a real route.

### Rejection reasons

`UnknownRouteError.reason` (and `resolveRoute`'s `reason`) distinguishes "never
heard of it" from "known but not enabled here", which callers need in order to
show a useful message:

| Reason | Meaning |
| --- | --- |
| `malformed_route_id` | A slug on some axis is not declared at all (e.g. `eth_to_btc`, `wbtc`, `hop-protocol`). |
| `unknown_route` | Every slug is declared, but no registry entry combines them (e.g. `cctp-v2` on a direction with no adapter). |
| `route_not_live` | Declared with `status: "planned"` — no contracts or asset mappings yet. |
| `route_not_on_network` | Live, but not enabled on the requested network (e.g. USDC routes on mainnet). |

## Network switching

Route availability is declared per network rather than inferred, which is what
makes network switching deterministic. Native-asset routes are enabled on
`testnet` and `mainnet`; USDC routes on `testnet` only, mirroring the mapping
tables in [ASSET_MAPPING_CONTRACT.md](./ASSET_MAPPING_CONTRACT.md).

```typescript
import { listRoutesForNetwork, networksForRoute, isRouteOnNetwork } from '@wafflefinance/sdk/routes';

listRoutesForNetwork('mainnet');                                    // live mainnet routes only
networksForRoute('eth_to_xlm:usdc:wafflefinance-htlc');             // ["testnet"]
isRouteOnNetwork('eth_to_xlm:usdc:wafflefinance-htlc', 'mainnet');  // false
```

Each `RouteDefinition` also carries `src` and `dst` chains, so a UI can tell the
user which chains a wallet must be connected to before the route is usable.

## Comparing orders and history entries

`routeIdForOrder` derives the serialised identity of anything shaped like an
order — the SDK `Order`, the wire `CoordinatorOrder`, and `HistoryRecord` all
satisfy it structurally, so records from different layers can be compared
directly.

```typescript
import { routeIdForOrder, sameRoute } from '@wafflefinance/sdk/routes';

routeIdForOrder(order);              // "eth_to_xlm:usdc:wafflefinance-htlc" | null
sameRoute(requestPayload, storedHistoryRecord);   // true when the routes match
```

Both return `null` / `false` when a record's legs contradict its direction or
its source asset is not routable on that direction. An unresolvable route is
never treated as equal to anything, including itself — not being able to
identify a route is not evidence that two records share one.

Amounts, addresses, and address casing are not part of route identity, so they
do not affect the comparison.

## Adding a new supported route

Routes are added in this order, so that no step leaves the registry claiming
support the layers underneath cannot deliver:

1. **Add the asset mapping first** (if the route introduces a new asset). Extend
   the tables in `src/assets/index.ts` and follow the steps in
   [ASSET_MAPPING_CONTRACT.md](./ASSET_MAPPING_CONTRACT.md#adding-new-asset-mappings).
   The registry delegates all concrete address, issuer, and mint questions to
   that module and must not restate them.
2. **Add the chain direction** if it is new: one entry in
   `ROUTE_CHAIN_DIRECTIONS`. If the direction is also live end-to-end, add it to
   `LIVE_ROUTE_DIRECTIONS` — that widens `LiveRouteDirection`, and therefore
   `CoordinatorDirection`, in the same commit.
3. **Add the token group / bridge mode / quote model** to their unions and
   `TOKEN_GROUPS` / `BRIDGE_MODES` / `QUOTE_MODELS` arrays if the route needs a
   value that does not exist yet.
4. **Add the registry entry** to `ROUTE_REGISTRY` via `define(...)`, naming the
   networks it is enabled on. Use `status: "planned"` with no networks until
   contracts are deployed and the coordinator accepts the direction — planned
   routes are rejected by every validation helper but remain discoverable
   through `listRoutes`.
5. **Update the tests** in `test/routes.test.ts`. The declared id set is pinned
   in the "declares exactly the expected route ids" case, so any route change
   fails until it is acknowledged there.
6. **Update the docs**: this file's axis table, and the bridge-path table in
   [README.md](./README.md).

### Adding a second non-native token group

`tokenGroupForAsset` currently returns `"usdc"` for any mapped non-native asset,
because USDC is the only non-native asset in the mapping tables. A second
non-native group means that shortcut has to become a symbol lookup. The
invariant is asserted in `test/routes.test.ts` ("only ever groups mapped
non-native assets as usdc"), so the omission cannot pass silently.

### Wiring an external bridge mode

`cctp-v2` and `axelar-its` are declared in `BRIDGE_MODES` but have no registry
entries, so every selector naming them is rejected with `unknown_route`. When an
`ExternalBridgeAdapter` ships for one of them (see the external-bridge section
of `src/types/index.ts`), add registry entries for the routes it serves with the
quote model it uses — the adapter's `kind` and the route's `bridgeMode` are
deliberately the same vocabulary.

## Testing

```bash
cd packages/sdk
pnpm test
```

`test/routes.test.ts` covers registry invariants, route-map change detection,
serialisation round-trips, per-network availability, every unknown-route
rejection reason across all three entry points, token-group resolution, and
order/history route identity.
