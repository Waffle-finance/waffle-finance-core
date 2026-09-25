/**
 * @fileoverview Network configuration and ABI definitions for the relayer.
 *
 * Extracts all static network/contract data that was previously inlined in
 * relayer/src/index.ts. A single source of truth for:
 *   - Chain IDs and contract addresses (testnet + mainnet)
 *   - Stellar network passphrases and Horizon URLs
 *   - Contract ABIs (HTLC Bridge, Mainnet EscrowFactory, Testnet EscrowFactory)
 *   - Helper functions for address and ABI resolution
 */

// ---------------------------------------------------------------------------
// Network configuration
// ---------------------------------------------------------------------------

export type NetworkMode = 'testnet' | 'mainnet';

export interface EthereumNetworkConfig {
  chainId: number;
  escrowFactory: string;
  htlcBridge: string;
}

export interface StellarNetworkConfig {
  networkPassphrase: string;
  horizonUrl: string;
}

export interface NetworkConfig {
  ethereum: EthereumNetworkConfig;
  stellar: StellarNetworkConfig;
}

export const NETWORK_CONFIG: Record<NetworkMode, NetworkConfig> = {
  testnet: {
    ethereum: {
      chainId: 11155111, // Sepolia
      escrowFactory: '0x0ABa862Da2F004bCa6ce2990EbC0f77184B6d3a8',
      htlcBridge: '0x3f42E2F5D4C896a9CB62D0128175180a288de38A',
    },
    stellar: {
      networkPassphrase: 'Test SDF Network ; September 2015',
      horizonUrl: 'https://horizon-testnet.stellar.org',
    },
  },
  mainnet: {
    ethereum: {
      chainId: 1,
      escrowFactory: '0xa7bcb4eac8964306f9e3764f67db6a7af6ddf99a', // 1inch Factory
      htlcBridge: '0x87372d4bba85acf7c2374b4719a1020e507ab73e',
    },
    stellar: {
      networkPassphrase: 'Public Global Stellar Network ; September 2015',
      horizonUrl: 'https://horizon.stellar.org',
    },
  },
};

// ---------------------------------------------------------------------------
// ABI definitions
// ---------------------------------------------------------------------------

/**
 * Minimal HTLC Bridge ABI used for the legacy createOrder path.
 */
export const HTLC_BRIDGE_ABI = [
  'function createOrder(address token, uint256 amount, bytes32 hashLock, uint256 timelock, uint256 feeRate, address beneficiary, address refundAddress, uint256 destinationChainId, bytes32 stellarTxHash, bool partialFillEnabled) external payable returns (uint256 orderId)',
] as const;

/**
 * 1inch EscrowFactory ABI for mainnet (createDstEscrow pattern).
 */
export const MAINNET_ESCROW_FACTORY_ABI = [
  `function createDstEscrow(
    (bytes32 orderHash, bytes32 hashlock, uint256 maker, uint256 taker, uint256 token, uint256 amount, uint256 safetyDeposit, uint256 timelocks) dstImmutables,
    uint256 srcCancellationTimestamp
  ) external payable`,
  'function addressOfEscrowSrc((bytes32 orderHash, bytes32 hashlock, uint256 maker, uint256 taker, uint256 token, uint256 amount, uint256 safetyDeposit, uint256 timelocks) immutables) external view returns (address)',
  'function addressOfEscrowDst((bytes32 orderHash, bytes32 hashlock, uint256 maker, uint256 taker, uint256 token, uint256 amount, uint256 safetyDeposit, uint256 timelocks) immutables) external view returns (address)',
  'function ESCROW_SRC_IMPLEMENTATION() external view returns (address)',
  'function ESCROW_DST_IMPLEMENTATION() external view returns (address)',
  'function availableCredit(address account) external view returns (uint256)',
  'function increaseAvailableCredit(address account, uint256 amount) external returns (uint256 allowance)',
  'function decreaseAvailableCredit(address account, uint256 amount) external returns (uint256 allowance)',
  // Events
  'event DstEscrowCreated(address escrow, bytes32 hashlock, uint256 taker)',
  'event SrcEscrowCreated((bytes32 orderHash, bytes32 hashlock, uint256 maker, uint256 taker, uint256 token, uint256 amount, uint256 safetyDeposit, uint256 timelocks) srcImmutables, (uint256 maker, uint256 amount, uint256 token, uint256 safetyDeposit, uint256 chainId) dstImmutablesComplement)',
] as const;

/**
 * Custom EscrowFactory ABI for testnet (createEscrow pattern).
 */
export const TESTNET_ESCROW_FACTORY_ABI = [
  'function createEscrow((address token, uint256 amount, bytes32 hashLock, uint256 timelock, address beneficiary, address refundAddress, uint256 safetyDeposit, uint256 chainId, bytes32 stellarTxHash, bool isPartialFillEnabled) config) external payable returns (uint256 escrowId)',
  'function fundEscrow(uint256 escrowId) external',
  'function claimEscrow(uint256 escrowId, bytes32 preimage) external',
  'function refundEscrow(uint256 escrowId) external',
  'function getEscrow(uint256 escrowId) external view returns (tuple(address escrowAddress, tuple(address token, uint256 amount, bytes32 hashLock, uint256 timelock, address beneficiary, address refundAddress, uint256 safetyDeposit, uint256 chainId, bytes32 stellarTxHash, bool isPartialFillEnabled) config, uint8 status, uint256 createdAt, uint256 filledAmount, uint256 safetyDepositPaid, address resolver, bool isActive))',
  'function authorizeResolver(address resolver) external',
  'function authorizedResolvers(address resolver) external view returns (bool)',
  'function totalEscrows() external view returns (uint256)',
  'function MIN_SAFETY_DEPOSIT() external view returns (uint256)',
  'function MAX_SAFETY_DEPOSIT() external view returns (uint256)',
  // Events
  'event EscrowCreated(uint256 indexed escrowId, address indexed escrowAddress, address indexed resolver, address token, uint256 amount, bytes32 hashLock, uint256 timelock, uint256 safetyDeposit, uint256 chainId)',
  'event EscrowFunded(uint256 indexed escrowId, address indexed funder, uint256 amount, uint256 safetyDeposit)',
  'event EscrowClaimed(uint256 indexed escrowId, address indexed claimer, uint256 amount, bytes32 preimage)',
  'event EscrowRefunded(uint256 indexed escrowId, address indexed refundee, uint256 amount, uint256 safetyDeposit)',
] as const;

/**
 * Resolver registry ABI for authorization checks and updates.
 */
export const RESOLVER_REGISTRY_ABI = [
  'function authorizeResolver(address resolver) external',
  'function authorizedResolvers(address resolver) external view returns (bool)',
  'function isResolverAuthorized(address resolver) external view returns (bool)',
] as const;

// ---------------------------------------------------------------------------
// Network Adapter Interface
// ---------------------------------------------------------------------------

export interface NetworkAdapter {
  getMode(): NetworkMode;
  getChainId(): number;
  getEscrowFactoryAddress(): string;
  getHtlcBridgeAddress(): string;
  getStellarPassphrase(): string;
  getStellarHorizonUrl(): string;
  getEscrowFactoryABI(): typeof MAINNET_ESCROW_FACTORY_ABI | typeof TESTNET_ESCROW_FACTORY_ABI;
}

export function createNetworkAdapter(mode: NetworkMode = 'testnet'): NetworkAdapter {
  const config = NETWORK_CONFIG[mode];
  return {
    getMode: () => mode,
    getChainId: () => config.ethereum.chainId,
    getEscrowFactoryAddress: () => config.ethereum.escrowFactory,
    getHtlcBridgeAddress: () => config.ethereum.htlcBridge,
    getStellarPassphrase: () => config.stellar.networkPassphrase,
    getStellarHorizonUrl: () => config.stellar.horizonUrl,
    getEscrowFactoryABI: () => getEscrowFactoryABI(mode === 'mainnet'),
  };
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/**
 * Return the full network configuration for the given mode.
 * Throws when `networkMode` is explicitly provided but not a known value.
 * Falls back to `defaultMode` only when `networkMode` is omitted.
 */
export function getNetworkConfig(
  networkMode?: string,
  defaultMode: NetworkMode = 'testnet'
): NetworkConfig {
  if (networkMode !== undefined) {
    if (networkMode !== 'testnet' && networkMode !== 'mainnet') {
      throw new Error(
        `Unknown network mode "${networkMode}". Valid values are "testnet" or "mainnet".`
      );
    }
    return NETWORK_CONFIG[networkMode];
  }
  return NETWORK_CONFIG[defaultMode];
}

/**
 * Return the EscrowFactory contract address for the given network.
 */
export function getEscrowFactoryAddress(
  networkMode?: string,
  defaultMode: NetworkMode = 'testnet'
): string {
  return getNetworkConfig(networkMode, defaultMode).ethereum.escrowFactory;
}

/**
 * Return the HTLC Bridge contract address for the given network.
 */
export function getHtlcBridgeAddress(
  networkMode?: string,
  defaultMode: NetworkMode = 'testnet'
): string {
  return getNetworkConfig(networkMode, defaultMode).ethereum.htlcBridge;
}

/**
 * Select the correct EscrowFactory ABI based on whether the target chain is
 * mainnet (1inch pattern) or testnet (custom pattern).
 */
export function getEscrowFactoryABI(
  isMainnet: boolean
): typeof MAINNET_ESCROW_FACTORY_ABI | typeof TESTNET_ESCROW_FACTORY_ABI {
  return isMainnet ? MAINNET_ESCROW_FACTORY_ABI : TESTNET_ESCROW_FACTORY_ABI;
}

/**
 * Returns `false` always: both mainnet and testnet use EscrowFactory for
 * ETH→XLM orders. HTLC is only used on the Stellar side and for XLM→ETH.
 */
export function shouldUseHTLCContract(_networkMode?: string): boolean {
  return false;
}
