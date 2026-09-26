// Types
export type {
  Chain,
  Direction,
  OrderStatus,
  Order,
  ChainLeg,
  ResolverInfo,
  ExternalBridgeKind,
  ExternalBridgeRoute,
  ExternalBridgeAdapter,
} from "./types/index.js";

// Route-identity registry — single source of truth for supported routes
export {
  // axes
  ROUTE_CHAIN_DIRECTIONS,
  ROUTE_DIRECTIONS,
  LIVE_ROUTE_DIRECTIONS,
  LIVE_DIRECTION_CHAINS,
  SUPPORTED_CHAINS,
  TOKEN_GROUPS,
  BRIDGE_MODES,
  DEFAULT_BRIDGE_MODE,
  QUOTE_MODELS,
  // registry
  ROUTE_REGISTRY,
  ROUTE_IDS,
  // serialisation
  formatRouteId,
  parseRouteId,
  isRouteId,
  // lookup + validation
  getRoute,
  resolveRoute,
  isSupportedRoute,
  assertSupportedRoute,
  UnknownRouteError,
  // discovery
  listRoutes,
  listRoutesForNetwork,
  chainsForDirection,
  directionForChains,
  isLiveDirection,
  networksForRoute,
  isRouteOnNetwork,
  // asset + order identity
  tokenGroupForAsset,
  routeIdForOrder,
  sameRoute,
  estimateRouteFee,
  getRouteFeePolicy,
  ROUTE_FEE_POLICIES,
} from "./routes/index.js";
export type {
  LiveRouteDirection,
  TokenGroup,
  BridgeMode,
  QuoteModel,
  RouteId,
  RouteIdParts,
  RouteStatus,
  RouteDefinition,
  RouteSelector,
  RouteFilter,
  RouteIdentitySource,
  UnknownRouteReason,
  RouteFeeEstimate,
  RouteFeeFixture,
  RouteFeePolicy,
} from "./routes/index.js";

// Shared HTLC interface + error types
export {
  HTLCError,
  type IHTLCClient,
  type HTLCCreateResult,
  type HTLCTxResult,
  type HTLCErrorCode,
} from "./htlc-client.js";

// Secrets
export {
  generateSecret,
  hashSecret,
  verifyPreimage,
  type Secret,
} from "./secrets/index.js";

// State Machine
export {
  InvalidTransitionError,
  canTransition,
  requireTransition,
  isTerminal,
  nextStatesOf,
} from "./state-machine/index.js";

// Assets
export {
  NATIVE_ETH_ADDRESS,
  NATIVE_STELLAR_ASSET,
  NATIVE_SOL_MINT,
  NATIVE_SOL_ASSET,
  resolveStellarAsset,
  resolveEthereumToken,
  resolveSolanaAsset,
  resolveEthereumTokenFromSolana,
  normalizeEthereumAddress,
  normalizeStellarAssetKey,
  normalizeSolanaMint,
  isSupportedEthToStellar,
  isSupportedStellarToEth,
  isSupportedEthToSolana,
  isSupportedSolanaToEth,
  isSupportedStellarToSolana,
  isSupportedSolanaToStellar,
  assertSupportedEthToStellar,
  assertSupportedStellarToEth,
  assertSupportedEthToSolana,
  assertSupportedSolanaToEth,
  assertSupportedStellarToSolana,
  assertSupportedSolanaToStellar,
  resolveSolanaAssetFromStellar,
  resolveStellarAssetFromSolana,
  getSupportedEthereumAddresses,
  getSupportedStellarAssets,
  getSupportedSolanaMints,
  getSupportedStellarToSolana,
  getSupportedSolanaToStellar,
  toCanonicalId,
  UnsupportedAssetError,
  type AssetMappingNetwork,
  type CanonicalStellarAsset,
  type CanonicalSolanaAsset,
} from "./assets/index.js";

// Ethereum
export {
  EthereumHTLCClient,
  HTLC_ESCROW_ABI,
  type CreateOrderInput,
  type EthereumHTLCClientOptions,
  type OrderData,
} from "./ethereum/index.js";

// Ethereum — normalised adapter
export { EthereumHTLCAdapter } from "./ethereum/adapter.js";

// Soroban
export {
  SorobanHTLCClient,
  makeKeypairSigner,
  type SorobanHTLCClientOptions,
  type SorobanCreateOrderInput,
  type SorobanSigner,
} from "./soroban/index.js";

// Soroban — normalised adapter
export {
  SorobanHTLCAdapter,
  encodeSorobanOrderRef,
  decodeSorobanOrderRef,
  type SorobanAdapterCreateInput,
} from "./soroban/adapter.js";

// Solana
export {
  SolanaHTLCClient,
  type SolanaHTLCClientOptions,
  type SolanaCreateOrderInput,
  type SolanaOrderData,
  type SolanaSigner,
} from "./solana/index.js";

// Solana — multi-endpoint RPC provider with automatic failover (#713)
export {
  SolanaRpcProvider,
  SolanaRpcFallbackExhaustedError,
  createSolanaRpcProvider,
  type SolanaRpcProviderOptions,
  type SolanaProviderHealth,
  type EndpointHealth,
} from "./solana/rpc-provider.js";

// Solana — IDL schema compatibility helpers (#712)
export {
  assertIdlCompatibility,
  validateInstructionSchema,
  CANONICAL_ACCOUNT_ORDERING,
  INSTRUCTION_DATA_SIZES,
  type IdlCompatibilityResult,
} from "./solana/idl/htlc.js";

// Solana — account metadata validation (#715)
export {
  AccountValidationError,
  validateSolanaAddress,
  validateOrderPda,
  validateOrderAccountOnChain,
  validateCreateOrderParams,
  validateClaimOrderParams,
  validateRefundOrderParams,
  type AccountValidationCode,
  type AccountValidationResult,
} from "./solana/account-validation.js";

// Shared utilities for hex conversion, order ID handling, and serialisation
export {
  hexToBuffer,
  bufferToHex,
  writeU64LE,
  readU64LE,
  readI64LE,
  hex32ToBuffer,
  escrowNativeValue,
  orderIdFromHashlock,
  hashlockFromOrderId,
  validateOrderId,
  validateHashlock,
  ORDER_ID_PREFIX,
  isTimeoutTransition,
  isFailureTransition,
  estimateTimelockRemaining,
} from "./shared-utils/index.js";

// Solana — normalised adapter
export { SolanaHTLCAdapter } from "./solana/adapter.js";

// Coordinator — typed HTTP client, contract types, history client,
// event subscription, and local request validation (Issues #355–#360)
export {
  // client
  CoordinatorClient,
  // history
  HistoryClient,
  toHistoryRecord,
  // subscription
  OrderSubscriber,
  // validation
  validateAnnounceRequest,
  assertValidAnnounceRequest,
  validateHashlockField,
  validateChainAddress,
  validateDecimalIntField,
  DIRECTION_CHAINS,
  SUPPORTED_DIRECTIONS,
  // transforms
  toOrder,
  toOrders,
  // type guards
  isCursorPagination,
  isCoordinatorError,
  // errors
  CoordinatorError,
  CoordinatorApiError,
  CoordinatorParseError,
  CoordinatorNetworkError,
  CoordinatorValidationError,
} from "./coordinator/index.js";
export type {
  // contract types
  CoordinatorDirection,
  CoordinatorChainLeg,
  CoordinatorSecretBlock,
  CoordinatorOrder,
  CoordinatorHistoryResponse,
  CoordinatorOffsetPagination,
  CoordinatorCursorPagination,
  CoordinatorSecretResponse,
  CoordinatorRevealResponse,
  CoordinatorRevealRequest,
  CoordinatorAnnounceRequest,
  CoordinatorErrorResponse,
  CoordinatorHealthResponse,
  CoordinatorReadinessResponse,
  // client options
  CoordinatorClientOptions,
  GetHistoryOptions,
  // history
  HistoryRecord,
  HistoryPagination,
  HistoryPage,
  HistoryClientOptions,
  // subscription
  OrderSubscriberOptions,
  OrderSubscriptionEvents,
  OrderSubscriptionEventName,
  StatusChangedEvent,
  SecretRevealedEvent,
  OrderSettledEvent,
  SubscriptionErrorEvent,
  SubscriptionStartedEvent,
  SubscriptionStoppedEvent,
  // validation
  ValidationIssue,
  ValidationResult,
} from "./coordinator/index.js";
