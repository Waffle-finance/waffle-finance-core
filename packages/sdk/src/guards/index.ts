/**
 * Runtime guards added in #733.
 *
 * What belongs here
 * ─────────────────
 * The SDK is a library, so it never itself calls `localStorage`, reads
 * `process.env`, or parses a deep link. But every one of those is a place
 * where `unknown` becomes a value the SDK's public types claim is
 * trustworthy, and today the transition is a bare `as`. These modules are
 * the SDK's half of that contract: the component that *defines* the shape
 * also defines the check.
 *
 * The five boundaries, and where they came from
 * ─────────────────────────────────────────────
 * | Module                    | Boundary                                    |
 * | ------------------------- | ------------------------------------------- |
 * | `coordinator-response.ts` | coordinator HTTP responses (`client.ts` returns `parsed as T`) |
 * | `order-payload.ts`        | the canonical `Order` produced by `toOrder` (two `as \`0x${string}\`` casts) |
 * | `asset-metadata.ts`       | asset descriptors from a caller or a deep link |
 * | `rpc-payload.ts`          | Ethereum / Solana / Soroban RPC replies      |
 * | `persisted.ts`            | `localStorage` caches and env configuration  |
 * | `route-params.ts`         | deep-link / query-string route data          |
 *
 * `branded.ts` and `result.ts` are the shared vocabulary.
 *
 * Two rules every module in this directory follows
 * ────────────────────────────────────────────────
 * 1. **Type-narrowing, not assertion.** A guard that returns `x as Order`
 *    without checking anything launders the problem into the type system and
 *    is strictly worse than no guard: it removes the compiler's ability to
 *    help while adding no runtime protection. Every entry point here takes
 *    `unknown` and returns either a genuinely narrowed value or a list of
 *    issues. There is exactly one `as` in each validator, on the final line,
 *    and it is only reachable after every field has been individually
 *    proven to have the right primitive kind.
 * 2. **Both forms.** `validateX` never throws and accumulates every issue;
 *    `assertX` throws `GuardError` and returns the narrowed value. The
 *    choice per call site is: can the caller do something useful with a
 *    partial result? If yes, `validateX`. If not, `assertX`.
 *
 * Compatibility
 * ─────────────
 * Nothing in this directory edits an existing type. `Order`, `ChainLeg`,
 * `CanonicalStellarAsset`, `CanonicalSolanaAsset` and `RouteId` are all
 * untouched, because narrowing them is a breaking change to a published
 * package. The strict variants (`StrictOrder`, `AssetMetadata`, the branded
 * scalars) are new names with parsers; a consumer opts in, and nothing that
 * compiles today stops compiling. See `order-payload.ts` and
 * `asset-metadata.ts` for the per-type reasoning.
 */

export {
  GuardError,
  GuardIssueCollector,
  assertGuard,
  formatIssues,
  guardFail,
  guardFailOne,
  guardOk,
  type GuardIssue,
  type GuardResult,
} from './result.js';

export {
  assertAtomicAmount,
  assertChainAddress,
  assertChainTxRef,
  assertHashlock,
  assertPublicOrderId,
  parseAtomicAmount,
  parseChainAddress,
  parseChainTxRef,
  parseDecimalUint,
  parseHashlock,
  parsePublicOrderId,
  parseStellarContractId,
  parseUnixSeconds,
  type AtomicAmount,
  type Brand,
  type ChainAddress,
  type ChainTxRef,
  type DecimalUint,
  type EvmAddress,
  type EvmTxHash,
  type Hashlock,
  type OptionalUnixSeconds,
  type PublicOrderId,
  type SolanaAddress,
  type SolanaSignature,
  type StellarAccountId,
  type StellarContractId,
  type StellarTxHash,
  type UnixSeconds,
} from './branded.js';

export {
  KNOWN_COORDINATOR_CHAINS,
  KNOWN_COORDINATOR_DIRECTIONS,
  KNOWN_ORDER_STATUSES,
  assertCoordinatorHealthResponse,
  assertCoordinatorHistoryResponse,
  assertCoordinatorOrder,
  assertCoordinatorReadinessResponse,
  assertCoordinatorSecretResponse,
  validateCoordinatorHealthResponse,
  validateCoordinatorHistoryResponse,
  validateCoordinatorOrder,
  validateCoordinatorReadinessResponse,
  validateCoordinatorSecretResponse,
  type CoordinatorHealthResponseLike,
} from './coordinator-response.js';

export {
  asStrictOrder,
  assertOrder,
  validateOrder,
  type StrictChainLeg,
  type StrictOrder,
} from './order-payload.js';

export {
  NATIVE_ASSET_DECIMALS,
  NATIVE_ASSET_SYMBOLS,
  assertAssetMetadata,
  nativeAssetMetadata,
  nativePlaceholderFor,
  solanaAssetMetadata,
  stellarAssetMetadata,
  validateAssetMetadata,
  validateCanonicalId,
  type AssetKind,
  type AssetMetadata,
} from './asset-metadata.js';

export {
  assertEvmLog,
  assertJsonRpcReply,
  assertSolanaAccountInfo,
  assertSorobanSimulation,
  decodeSorobanRetval,
  validateEvmLog,
  validateJsonRpcReply,
  validateSolanaAccountInfo,
  validateSolanaAccountInfoList,
  validateSorobanSimulation,
  type EvmLog,
  type JsonRpcFailure,
  type JsonRpcReply,
  type JsonRpcSuccess,
  type SolanaAccountInfo,
  type SorobanSimulationCost,
  type SorobanSimulationFailure,
  type SorobanSimulationSuccess,
} from './rpc-payload.js';

export {
  assertCoordinatorEnvConfig,
  assertPersistedHistoryPage,
  validateCoordinatorBaseUrl,
  validateCoordinatorEnvConfig,
  validatePersistedHistoryPage,
  type CoordinatorEnvConfig,
  type EnvSource,
  type PersistedHistoryLeg,
  type PersistedHistoryPage,
  type PersistedHistoryRecord,
} from './persisted.js';

export {
  assertOrderParam,
  assertRouteLink,
  assertRouteParam,
  fromQueryString,
  fromSearchParams,
  validateAddressParam,
  validateOrderParam,
  validateRouteLink,
  validateRouteParam,
  type ParsedRouteLink,
  type RouteParamSource,
} from './route-params.js';
