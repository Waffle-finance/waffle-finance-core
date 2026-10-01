// Types
export {
  ORDER_STATUSES,
  TERMINAL_ORDER_STATUSES,
  isOrderStatus,
} from "./types/index.js";
export type {
  Chain,
  Direction,
  OrderStatus,
  TerminalOrderStatus,
  Order,
  ChainLeg,
  ResolverInfo,
  ExternalBridgeKind,
  ExternalBridgeRoute,
  ExternalBridgeAdapter,
} from "./types/index.js";

// SDK runtime configuration validation
export {
  SdkConfigurationError,
  validateRpcUrl,
  validateChainId,
  validateEthereumAddress,
  validateSolanaAddress as validateSolanaConfigAddress,
  validateSorobanAddress,
  validateNetworkPassphrase,
  validateChainPair,
} from "./config-validation.js";
export type {
  SdkConfigIssue,
  SdkConfigIssueCode,
  ChainPairValidationInput,
} from "./config-validation.js";

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
  ORDER_STATUS_TRANSITIONS,
  InvalidTransitionError,
  canTransition,
  requireTransition,
  isTerminal,
  nextStatesOf,
} from "./state-machine/index.js";

// Status display — canonical order-status → user-facing mapping
export {
  displayStatusFor,
  statusDisplay,
  describeOrderStatus,
  isDisplayStatus,
  ALL_DISPLAY_STATUSES,
  ORDER_STATUS_TO_DISPLAY,
} from "./status-display/index.js";
export type { DisplayStatus, StatusDisplay } from "./status-display/index.js";

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
  assertCanonicalEthereumAddress,
  normalizeStellarAssetKey,
  assertCanonicalStellarAssetKey,
  normalizeSolanaMint,
  assertCanonicalSolanaMint,
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
  InvalidAssetIdentifierError,
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

// Solana wallet lifecycle and Phantom provider (#720)
export {
  getPhantomProvider,
  formatSolanaAddress,
  createPhantomSigner,
  SolanaWalletLifecycleManager,
  INITIAL_SOLANA_WALLET_STATE,
  type PhantomSolanaProvider,
  type SolanaConnectionPhase,
  type SolanaWalletState,
  type SolanaWalletErrorCode,
  type SolanaWalletLifecycleOptions,
} from "./solana/wallet.js";

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

// Solana — production readiness audit, gating checks, and operations checklist (#718)
export {
  assessSolanaProductionReadiness,
  assertSolanaProductionReady,
  SolanaProductionGatingError,
  DEVNET_TOKEN_MINTS,
  MAINNET_TOKEN_MINTS,
  PUBLIC_DEVNET_RPC_ENDPOINTS,
  SOLANA_SETTLEMENT_OPERATIONS_CHECKLIST,
  type SolanaEnvironment,
  type ReadinessCheckStatus,
  type ReadinessCheckCategory,
  type SolanaReadinessCheck,
  type SolanaProductionReadinessReport,
  type SolanaReadinessOptions,
} from "./solana/production-readiness.js";

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
  classifyRpcError,
  retryAsync,
} from "./shared-utils/index.js";
export type { RetryPolicy } from "./shared-utils/index.js";

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
