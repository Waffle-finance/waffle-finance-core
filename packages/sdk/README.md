# @wafflefinance/sdk

TypeScript SDK for the WaffleFinance non-custodial cross-chain atomic swap
bridge. It provides:

- **Chain clients** for locking, claiming, and refunding HTLC swaps on
  **Ethereum**, **Stellar (Soroban)**, and **Solana**.
- A typed **Coordinator API client** (`CoordinatorClient`, `HistoryClient`,
  `OrderSubscriber`) for announcing orders, tracking their lifecycle, and
  revealing secrets.
- Shared **secret/hashlock utilities**, an SDK-local **order state machine**,
  and **asset mapping** helpers for resolving the equivalent asset across a
  bridge path.

This document is the single source of truth for what's public, what's
transport-specific, and what's still internal. If a type or function isn't
listed here or re-exported from `src/index.ts` / a documented subpath, treat
it as an implementation detail that may change without notice.

## Installation

```bash
npm install @wafflefinance/sdk
```

The package is ESM-only (`"type": "module"`) and ships per-domain subpath
exports so bundlers can tree-shake unused chains — see
[TREE_SHAKING.md](./TREE_SHAKING.md) for import guidance.

## Supported bridge paths

`Direction` (`@wafflefinance/sdk/types`) enumerates six chain pairings, but
**the coordinator currently only accepts four of them**. The route registry
(`@wafflefinance/sdk/routes`) is the single source of truth for what's actually
live — resolve a route through it before assuming it works end-to-end:

```typescript
import { isSupportedRoute, listRoutesForNetwork } from '@wafflefinance/sdk/routes';

isSupportedRoute({ direction: 'eth_to_xlm', tokenGroup: 'usdc', network: 'testnet' });
listRoutesForNetwork('mainnet');   // every route usable on mainnet
```

A route is more than a direction: it is a direction, a token group, a bridge
mode, and a quote model, serialised to a stable id like
`eth_to_xlm:usdc:wafflefinance-htlc`. See
[ROUTE_REGISTRY.md](./ROUTE_REGISTRY.md) for the full model, the rejection
reasons, and how to add a route. `SUPPORTED_DIRECTIONS`
(`@wafflefinance/sdk/coordinator`) still lists the live directions and is now
re-exported from the registry.

| Direction    | Live on coordinator? | Asset resolver (`@wafflefinance/sdk/assets`) |
| ------------ | :-------------------: | --------------------------------------------- |
| `eth_to_xlm` | ✅ | `resolveStellarAsset` |
| `xlm_to_eth` | ✅ | `resolveEthereumToken` |
| `eth_to_sol` | ✅ | `resolveSolanaAsset` |
| `sol_to_eth` | ✅ | `resolveEthereumTokenFromSolana` |
| `xlm_to_sol` | ❌ not yet | none — no direct Stellar↔Solana mapping exists |
| `sol_to_xlm` | ❌ not yet | none — no direct Stellar↔Solana mapping exists |

All asset resolution pivots through Ethereum today, which is why there's no
direct Stellar↔Solana resolver.

Use `validateChainPair` (`@wafflefinance/sdk/config-validation`) when a caller
starts from chain names instead of a direction. It derives the direction from
the same route matrix and rejects undeclared, planned, or wrong-network pairs
before checkout or order processing begins:

```typescript
import { validateChainPair } from '@wafflefinance/sdk/config-validation';

validateChainPair({ src: 'ethereum', dst: 'stellar', network: 'testnet' });
validateChainPair({ src: 'stellar', dst: 'solana', network: 'testnet' }); // throws: route_not_live
```

## Runtime configuration validation

The SDK validates required runtime configuration at client construction time so
frontend, coordinator, relayer, and resolver fail before the first RPC call when
an env var is missing or points at the wrong network.

```typescript
import {
  SdkConfigurationError,
  validateRpcUrl,
  validateEthereumAddress,
  validateChainId,
} from '@wafflefinance/sdk/config-validation';

try {
  validateRpcUrl(process.env.ETH_RPC_URL, 'ETH_RPC_URL');
  validateChainId(process.env.ETH_CHAIN_ID, 'ETH_CHAIN_ID');
  validateEthereumAddress(process.env.ETH_HTLC_ESCROW, 'ETH_HTLC_ESCROW');
} catch (err) {
  if (err instanceof SdkConfigurationError) {
    console.error(err.issues); // field, code, actionable message
  }
}
```

Constructors run the same checks:

- `EthereumHTLCClient` validates the escrow address and, when `chainId` is
  supplied, checks it against `publicClient.chain.id`.
- `SorobanHTLCClient` validates RPC URL, network passphrase, and contract id.
  Plain HTTP requires `allowHttp: true` and should only be used for local
  sandboxes.
- `SolanaHTLCClient` validates RPC URL and program id. Simulation mode is
  explicit: use `programId: "PLACEHOLDER"`. Empty program ids are rejected.

Required production inputs are RPC URL, chain/network id or passphrase, deployed
HTLC contract/program id, and any resolver-registry address used by the calling
service. Registry addresses should be validated with the same chain-local
address helper before service startup.

## Chain-specific constraints

| Chain | Timing | Wallet/account constraints | Settlement constraints |
| --- | --- | --- | --- |
| Ethereum | Source-side HTLCs use the longer refund window in the canonical flow. The contract stores an absolute `timelock` derived from `block.timestamp + timelockSeconds`. | Mutating calls require `walletClient.account`. ERC-20 orders require allowance for `amount` before `createOrder`; native ETH orders send `amount + safetyDeposit` as `msg.value`. | Native ETH uses `address(0)`. If a native payout push fails, funds move to pull-payment credit for the beneficiary/refund address. `claimOrder` accepts SDK sha256 hashlocks and the EVM dual-hash compatibility path. |
| Stellar/Soroban | Ledgers are final once accepted. The destination leg normally uses the shorter 12h-style window so the resolver can refund before the user's source refund opens. | Signers receive XDR and must return signed XDR. Source accounts must exist and have sequence numbers available through Soroban RPC. | Asset ids are Stellar/Soroban addresses. Contract state has TTL/rent behavior; operators must keep deployed contract state alive. |
| Solana | The SDK converts `timelockSeconds` to an absolute unix timestamp before building the Anchor instruction. | Signers expose a `PublicKey` and `signTransaction`. PDA derivation uses `[b"order", hashlock_bytes]`; duplicate hashlocks produce the same order PDA. | Mints are case-sensitive base58 public keys. `NATIVE_SOL_MINT` represents native SOL. `validateBeforeSubmit` can check account ownership and duplicate orders before sending. |

Common recovery workflows:

- Missing or malformed config: catch `SdkConfigurationError`, surface
  `.issues`, and stop startup. Do not retry with defaults.
- Unsupported source/destination pair: use `validateChainPair` or
  `assertSupportedRoute` before wallet prompts. Show the route rejection reason.
- Unsupported asset: use `assertSupported*` helpers before resolving assets.
  The lenient `resolve*` functions still fall back to native assets for older
  read paths and should not be used as the only validation before settlement.
- Timelock expiry: users can refund source funds directly from the HTLC after
  the source timelock; services are convenience layers, not custody points.

See [../../docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md#cross-chain-invariants)
for the protocol invariants behind timelock asymmetry, native payment fallback,
and coordinator-independent settlement.

## Stability tiers

| Tier | Surfaces | What it means |
| --- | --- | --- |
| **Stable** | `types`, `htlc-client`, `secrets`, `state-machine`, `assets`, `coordinator` (client, history, subscription, validation, errors) | Safe to build on. Breaking changes ship as a semver-major bump. |
| **Transport-specific** | `ethereum`, `ethereum/adapter`, `soroban`, `soroban/adapter`, `solana`, `solana/adapter` | Stable *within* their chain, but each client's constructor options and raw return shapes (e.g. Soroban's transaction-hash-as-orderId convention) reflect that chain's own SDK. Prefer the `IHTLCClient` interface (below) when you need chain-agnostic code. |
| **Internal** | Anything under `src/` not re-exported by `src/index.ts` or a subpath in `package.json#exports` | No stability guarantee. Node's `exports` map already blocks deep imports (e.g. `@wafflefinance/sdk/coordinator/client` fails) — this is enforced, not just a convention. |
| **Not yet wired up** | `ExternalBridgeKind`, `ExternalBridgeRoute`, `ExternalBridgeAdapter` (`@wafflefinance/sdk/types`) | Shape reserved for v2.1 external-bridge routing (CCTP v2, Axelar ITS). No adapter ships today; only `"wafflefinance-htlc"` is a real route. |

## Quickstart: chain-agnostic HTLC operations

Every chain client implements `IHTLCClient` (`@wafflefinance/sdk/htlc-client`),
so orchestration code that doesn't care which chain it's talking to can use
the adapters uniformly:

```ts
import { EthereumHTLCAdapter } from "@wafflefinance/sdk/ethereum/adapter";
import { HTLCError } from "@wafflefinance/sdk/htlc-client";

const client = new EthereumHTLCClient({ /* chain-specific options */ });
const adapter = new EthereumHTLCAdapter(client);

try {
  const { txId, orderId } = await adapter.createOrder({
    /* chain-specific create input */
  });
} catch (err) {
  if (err instanceof HTLCError) {
    // err.code: "wallet_unavailable" | "simulation_failed" | "tx_rejected" | ...
    // err.retryable: true if safe to retry (RPC timeout, nonce conflict, ...)
  }
}
```

The same `createOrder`/`claimOrder`/`refundOrder` shape (and the same
`HTLCError` on expected failures) applies to `SorobanHTLCAdapter` and
`SolanaHTLCAdapter`. Use the chain-specific client classes
(`EthereumHTLCClient`, `SorobanHTLCClient`, `SolanaHTLCClient`) directly when
you need their full, chain-specific API instead of the normalised interface.

## Quickstart: Coordinator client

```ts
import { CoordinatorClient, OrderSubscriber } from "@wafflefinance/sdk/coordinator";

const coordinator = new CoordinatorClient({ baseUrl: "https://coordinator.example" });

// Announce a new swap (local validation runs before the network call).
const order = await coordinator.announceOrder({
  direction: "eth_to_xlm",
  hashlock: "0x...",
  srcChain: "ethereum",
  srcAddress: "0x...",
  srcAsset: "native",
  srcAmount: "1000000000000000000",
  srcSafetyDeposit: "1000000000000000",
  dstChain: "stellar",
  dstAddress: "G...",
  dstAsset: "native",
  dstAmount: "100000000",
});

// Poll for status changes and terminal settlement.
const sub = new OrderSubscriber({ coordinatorClient: coordinator, orderId: order.id });
sub.on("statusChanged", (e) => console.log(e.from, "→", e.to));
sub.on("secretRevealed", (e) => console.log("preimage revealed:", e.revealedTx));
sub.on("settled", (e) => console.log("done:", e.finalStatus));
sub.start();
```

See [`examples/announce-and-track-order.ts`](./examples/announce-and-track-order.ts)
for a complete, tested version of this flow (announce → subscribe → resolve
on settlement), and `HistoryClient` for paginated wallet history instead of
single-order polling.

## The error/response model

Every network-touching surface throws a typed error instead of a raw string,
so callers can use `instanceof` instead of parsing messages:

| Error class | Thrown by | Meaning |
| --- | --- | --- |
| `SdkConfigurationError` | SDK config validators and chain-client constructors | Required runtime config is missing or malformed. Has `.issues[]` with `field`, `code`, and `message`. |
| `CoordinatorValidationError` | `CoordinatorClient`, `validateAnnounceRequest` | Request was invalid and **never sent** — fix the input. Has `.field` and `.details`. |
| `CoordinatorApiError` | `CoordinatorClient` | Coordinator responded with 4xx/5xx. Has `.status`, `.code` (stable machine-readable), and `.retryable`. |
| `CoordinatorNetworkError` | `CoordinatorClient` | No response received (DNS/timeout/connection reset). Always safe to retry. |
| `CoordinatorParseError` | `CoordinatorClient` | Response received but not valid JSON. |
| `HTLCError` | All chain clients/adapters | Expected on-chain failure. Has `.code` (`wallet_unavailable`, `simulation_failed`, `tx_rejected`, `order_not_found`, `timelock_not_expired`, `invalid_preimage`, `simulation_mode`, `chain_error`) and `.retryable`. |
| `UnsupportedAssetError` | `assertSupportedEthToStellar` and friends (`@wafflefinance/sdk/assets`) | No asset mapping exists for the given direction/network. Has `.asset`, `.network`, `.direction`. |
| `InvalidAssetIdentifierError` | `toCanonicalId`, `assertCanonical*` helpers (`@wafflefinance/sdk/assets`) | A chain-local identifier is malformed before mapping lookup or contract use. |

All coordinator errors extend `CoordinatorError`, so a single
`catch (err) { if (err instanceof CoordinatorError) ... }` catches any of
them. See [`examples/error-handling.ts`](./examples/error-handling.ts) for a
tested classifier that maps every error class above to a UI-facing category.

## Subpath exports

The intended package shape is one narrow subpath per concern, grouped so that a
consumer only ever loads the chain(s) it actually uses. `.` is the
convenience barrel over all of them and stays supported for compatibility; the
subpaths are what you should reach for in size- or start-up-sensitive code.
See [TREE_SHAKING.md](./TREE_SHAKING.md) for the measured cost of each entry
point and the reasoning behind the layout (#731).

| Subpath | Contents | Chain SDK loaded |
| --- | --- | --- |
| `@wafflefinance/sdk` | Everything below, re-exported from one entry point (largest graph — prefer subpaths in size-sensitive code). | all three |
| **Chain-neutral** | | |
| `@wafflefinance/sdk/types` | `Chain`, `Direction`, `OrderStatus`, `Order`, `ChainLeg`, `ResolverInfo`, external-bridge route types. Zero runtime cost (types only). | none |
| `@wafflefinance/sdk/htlc-client` | `IHTLCClient`, `HTLCError`, `HTLCErrorCode`, result types. | none |
| `@wafflefinance/sdk/secrets` | `generateSecret`, `hashSecret`, `verifyPreimage`. | viem¹ |
| `@wafflefinance/sdk/state-machine` | SDK-local order transition guards (`canTransition`, `requireTransition`, `isTerminal`, `nextStatesOf`). | none |
| `@wafflefinance/sdk/status-display` | `describeOrderStatus`, `displayStatusFor`, `statusDisplay`, `ALL_DISPLAY_STATUSES` — user-facing status copy. | none |
| `@wafflefinance/sdk/approval` | `APPROVAL_SEMANTICS`, `normalizeApprovalMessage`, `isApprovalError` — per-chain approval guidance. | none |
| `@wafflefinance/sdk/assets` | Asset resolution/normalisation/validation helpers — see [ASSET_MAPPING_CONTRACT.md](./ASSET_MAPPING_CONTRACT.md). | none |
| `@wafflefinance/sdk/routes` | Route-identity registry: route validation, serialised route ids, per-network availability — see [ROUTE_REGISTRY.md](./ROUTE_REGISTRY.md). | none |
| `@wafflefinance/sdk/routes/fee-policy` | `estimateRouteFee`, `getRouteFeePolicy`, `ROUTE_FEE_POLICIES` on their own, without the registry. | none |
| `@wafflefinance/sdk/coordinator` | `CoordinatorClient`, `HistoryClient`, `OrderSubscriber`, validation helpers, transforms, wire-contract types, error classes. | none |
| **Ethereum** | | |
| `@wafflefinance/sdk/ethereum` | `EthereumHTLCClient`, `HTLC_ESCROW_ABI`. | viem |
| `@wafflefinance/sdk/ethereum/adapter` | `EthereumHTLCAdapter` — normalised `IHTLCClient` implementation. | none² |
| **Soroban** | | |
| `@wafflefinance/sdk/soroban` | `SorobanHTLCClient`, `makeKeypairSigner`. | stellar-sdk |
| `@wafflefinance/sdk/soroban/adapter` | `SorobanHTLCAdapter`, order-ref encode/decode. | stellar-sdk |
| `@wafflefinance/sdk/soroban/orchestrator` | `orchestrateTransaction` and its config/result types. | stellar-sdk |
| **Solana** | | |
| `@wafflefinance/sdk/solana` | `SolanaHTLCClient`, instruction builders, account deserialisation. | web3.js |
| `@wafflefinance/sdk/solana/adapter` | `SolanaHTLCAdapter`. | none² |
| `@wafflefinance/sdk/solana/rpc-provider` | `SolanaRpcProvider`, `createSolanaRpcProvider` — multi-endpoint failover (#713). | none |
| `@wafflefinance/sdk/solana/account-validation` | Pre-submission account/PDA validation (#715). | web3.js |
| `@wafflefinance/sdk/solana/idl` | Anchor IDL constants and `assertIdlCompatibility` (#712). | none |

¹ `secrets` hashes via viem because viem is the SDK's only source of keccak256.
Tracked in `KNOWN_COUPLINGS` in `scripts/verify-subpath-isolation.mjs`.
² The `*/adapter` entries import their chain client only for types, so they
resolve without the chain SDK at runtime.

Deep imports outside this table (e.g. `@wafflefinance/sdk/coordinator/client`)
are not exposed by `package.json#exports` and will fail to resolve — that's
enforced by Node, not just documented convention. Every entry above is checked
against the build output by `npm run analyze`; the table cannot drift from
`package.json` without CI noticing.

## Soroban contract schema

When interacting with or extending bindings for the Stellar Soroban
`wafflefinance-htlc` contract, refer to the formal IDL and schema
documentation: [Soroban HTLC IDL Reference](../../soroban/docs/HTLC_IDL.md).
It covers account layouts, data types (`OrderStatus`, `Order`), and entrypoint
parameters needed for SDK development.

## Examples

Runnable, tested examples live under [`examples/`](./examples):

- [`announce-and-track-order.ts`](./examples/announce-and-track-order.ts) —
  the full announce → subscribe → settle lifecycle shared by every
  coordinator-supported bridge path.
- [`error-handling.ts`](./examples/error-handling.ts) — classifying and
  reacting to the error/response model above.
- [`asset-resolution.ts`](./examples/asset-resolution.ts) — resolving the
  destination asset for each live direction, and detecting directions that
  aren't coordinator-supported yet.

These are exercised by [`test/examples.test.ts`](./test/examples.test.ts) and
type-checked by `npm run typecheck` (see below), so a renamed or removed
export breaks CI here instead of silently going stale in this README.

## Development

```bash
npm run build       # tsc — compiles src/ to dist/
npm run typecheck   # tsc --noEmit — also checks test/ and examples/
npm test            # vitest run
npm run test:watch  # vitest, watch mode
npm run lint        # eslint src
npm run analyze     # every exports subpath resolves in dist/, nothing unreachable
npm run analyze:cost # per-entry module count, chain SDKs, real bundle bytes (#731)
npm run verify:subpaths # runtime proof that a subpath does not pull other chains
```

See also [TREE_SHAKING.md](./TREE_SHAKING.md) (bundle optimisation),
[ASSET_MAPPING_CONTRACT.md](./ASSET_MAPPING_CONTRACT.md) (canonical asset
identifiers and per-network mapping tables), and
[ROUTE_REGISTRY.md](./ROUTE_REGISTRY.md) (route identity, validation, and the
lifecycle for adding a route).
