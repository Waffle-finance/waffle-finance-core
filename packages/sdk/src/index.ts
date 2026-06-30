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
  assertSupportedEthToStellar,
  assertSupportedStellarToEth,
  assertSupportedEthToSolana,
  assertSupportedSolanaToEth,
  getSupportedEthereumAddresses,
  getSupportedStellarAssets,
  getSupportedSolanaMints,
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
