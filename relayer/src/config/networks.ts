/**
 * @fileoverview Network configuration and ABI definitions for the relayer.
 *
 * Extracts all static network/contract data that was previously inlined in
 * relayer/src/index.ts. A single source of truth for:
 *   - Chain IDs and contract addresses (testnet + mainnet)
 *   - Stellar network passphrases and Horizon URLs
 *   - Contract ABIs (HTLC Bridge, Mainnet EscrowFactory, Testnet EscrowFactory)
 *   - Helper functions for address and ABI resolution
 *
 * This module is intentionally free of relayer runtime dependencies (no
 * ethers provider, no logger, no process-level side effects) so that it can be
 * imported directly by fork integration tests such as
 * `contracts/test/mainnet-fork/escrow-factory.test.ts`.
 *
 * ---------------------------------------------------------------------------
 * Mainnet fork test configuration source
 * ---------------------------------------------------------------------------
 * The opt-in mainnet fork integration test resolves its inputs as follows:
 *
 *   - Factory address: `resolveMainnetEscrowFactoryAddress()`. This returns the
 *     configured, validated (checksummed, non-zero) mainnet EscrowFactory
 *     address from `NETWORK_CONFIG.mainnet.ethereum.escrowFactory`, or an
 *     explicit unavailability reason. The test MUST skip with that reason when
 *     the address is unavailable rather than asserting success.
 *
 *   - Fork block: `MAINNET_FORK_CONFIG.pinnedBlockNumber`. The fork is pinned to
 *     a fixed block so that deployed bytecode and event layouts are stable
 *     across runs. Override with the `MAINNET_FORK_BLOCK` environment variable
 *     only when intentionally re-pinning.
 *
 *   - RPC endpoint: `MAINNET_FORK_CONFIG.rpcUrlEnvVar` (default
 *     `MAINNET_FORK_RPC_URL`). When unset, the fork test skips with an explicit
 *     reason.
 *
 *   - ABI: `getEscrowFactoryABI(true)` returns `MAINNET_ESCROW_FACTORY_ABI`,
 *     the deployed 1inch interface used for event decoding.
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
// Mainnet fork test configuration
// ---------------------------------------------------------------------------

/**
 * Configuration consumed by the opt-in mainnet fork integration test.
 *
 * `pinnedBlockNumber` pins the fork so deployed bytecode and event layouts are
 * deterministic. `rpcUrlEnvVar` names the environment variable holding the
 * archive-node RPC URL; when it is unset the fork test must skip with an
 * explicit reason.
 */
export const MAINNET_FORK_CONFIG = {
  /** Chain ID expected from the fork RPC. */
  chainId: 1,
  /** Pinned fork block for deterministic deployed state. */
  pinnedBlockNumber: 21_500_000,
  /** Environment variable holding the mainnet RPC URL. */
  rpcUrlEnvVar: 'MAINNET_FORK_RPC_URL',
  /** Environment variable that may override the pinned block. */
  blockEnvVar: 'MAINNET_FORK_BLOCK',
} as const;

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
 *
 * This is the deployed interface used by the fork integration test for both
 * invocation and event decoding.
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

// ---------------------------------------------------------------------------
// Mainnet EscrowFactory address resolution (fork-test friendly)
// ---------------------------------------------------------------------------

/**
 * Result of resolving the configured mainnet EscrowFactory address.
 *
 * Exactly one of `address` / `reason` is populated:
 *   - `available: true`  → `address` holds the validated, checksummed address.
 *   - `available: false` → `reason` explains why it is unavailable.
 */
export type MainnetEscrowFactoryResolution =
  | { available: true; address: string; reason?: undefined }
  | { available: false; address?: undefined; reason: string };

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

/**
 * Compute the EIP-55 mixed-case checksum encoding of a 20-byte hex address.
 *
 * Implemented with a small, self-contained keccak-256 so this module stays
 * free of runtime dependencies. Only used for validation of the configured
 * mainnet factory address.
 */
function keccak256Hex(input: string): string {
  // Keccak-256 (original padding, not SHA3-256).
  const RC: bigint[] = [
    0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an,
    0x8000000080008000n, 0x000000000000808bn, 0x0000000080000001n,
    0x8000000080008081n, 0x8000000000008009n, 0x000000000000008an,
    0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
    0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n,
    0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n,
    0x000000000000800an, 0x800000008000000an, 0x8000000080008081n,
    0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
  ];
  const ROT: number[] = [
    0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8,
    18, 2, 61, 56, 14,
  ];
  const MASK = (1n << 64n) - 1n;

  const rotl = (x: bigint, n: number): bigint => {
    if (n === 0) return x & MASK;
    const s = BigInt(n);
    return ((x << s) | (x >> (64n - s))) & MASK;
  };

  // State: 5x5 lanes of 64 bits.
  const state: bigint[] = new Array(25).fill(0n);

  // Absorb: rate = 136 bytes for keccak-256.
  const rate = 136;
  const bytes: number[] = [];
  for (let i = 0; i < input.length; i++) {
    bytes.push(input.charCodeAt(i) & 0xff);
  }
  // Padding: 0x01 ... 0x80 (keccak original padding).
  bytes.push(0x01);
  while (bytes.length % rate !== 0) bytes.push(0x00);
  bytes[bytes.length - 1] |= 0x80;

  const permute = (): void => {
    for (let round = 0; round < 24; round++) {
      // Theta
      const c: bigint[] = new Array(5);
      for (let x = 0; x < 5; x++) {
        c[x] =
          state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20];
      }
      for (let x = 0; x < 5; x++) {
        const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1);
        for (let y = 0; y < 25; y += 5) {
          state[y + x] = (state[y + x] ^ d) & MASK;
        }
      }
      // Rho and Pi
      let current = state[1];
      for (let t = 0; t < 24; t++) {
        const j = ((t + 1) * (t + 2) / 2) % 24;
        // index mapping for pi: (x,y) -> (y, 2x+3y)
        // We use the standard lane ordering x + 5y.
        const x = j % 5;
        const y = Math.floor(j / 5);
        const nx = y;
        const ny = (2 * x + 3 * y) % 5;
        const idx = nx + 5 * ny;
        const tmp = state[idx];
        state[idx] = rotl(current, ROT[(t + 1) % 24]);
        current = tmp;
      }
      // Chi
      for (let y = 0; y < 25; y += 5) {
        const row: bigint[] = new Array(5);
        for (let x = 0; x < 5; x++) row[x] = state[y + x];
        for (let x = 0; x < 5; x++) {
          state[y + x] =
            (row[x] ^ (~row[(x + 1) % 5] & MASK & row[(x + 2) % 5])) & MASK;
        }
      }
      // Iota
      state[0] = (state[0] ^ RC[round]) & MASK;
    }
  };

  for (let offset = 0; offset < bytes.length; offset += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let b = 0; b < 8; b++) {
        lane |= BigInt(bytes[offset + i * 8 + b]) << BigInt(8 * b);
      }
      state[i] = (state[i] ^ lane) & MASK;
    }
    permute();
  }

  // Squeeze 32 bytes.
  let out = '';
  for (let i = 0; i < 4; i++) {
    let lane = state[i];
    for (let b = 0; b < 8; b++) {
      out += ((lane >> BigInt(8 * b)) & 0xffn).toString(16).padStart(2, '0');
    }
  }
  return out;
}

/**
 * Return the EIP-55 checksummed form of a lowercase 20-byte hex address.
 */
function toChecksumAddress(address: string): string {
  const lower = address.toLowerCase().replace(/^0x/, '');
  const hash = keccak256Hex(lower);
  let result = '0x';
  for (let i = 0; i < lower.length; i++) {
    const nibble = parseInt(hash[i], 16);
    result += nibble >= 8 ? lower[i].toUpperCase() : lower[i];
  }
  return result;
}

/**
 * Resolve the configured mainnet EscrowFactory address for the fork test.
 *
 * Returns the validated, EIP-55 checksummed address when the configuration is
 * usable, or an explicit `reason` when it is not. The fork integration test
 * MUST skip with the returned reason rather than asserting success.
 *
 * Validation performed:
 *   - The configured value is a 20-byte hex string (`0x` + 40 hex chars).
 *   - The address is not the zero address.
 *   - The address is normalized to its EIP-55 checksummed form.
 *
 * @param configured Optional override of the configured address. Defaults to
 *   `NETWORK_CONFIG.mainnet.ethereum.escrowFactory`.
 */
export function resolveMainnetEscrowFactoryAddress(
  configured: string = NETWORK_CONFIG.mainnet.ethereum.escrowFactory
): MainnetEscrowFactoryResolution {
  if (typeof configured !== 'string' || configured.trim() === '') {
    return {
      available: false,
      reason:
        'Mainnet EscrowFactory address is not configured (NETWORK_CONFIG.mainnet.ethereum.escrowFactory is empty).',
    };
  }

  const trimmed = configured.trim();
  if (!ADDRESS_PATTERN.test(trimmed)) {
    return {
      available: false,
      reason: `Mainnet EscrowFactory address "${trimmed}" is not a valid 20-byte hex address.`,
    };
  }

  if (trimmed.toLowerCase() === ZERO_ADDRESS) {
    return {
      available: false,
      reason:
        'Mainnet EscrowFactory address is the zero address; refusing to run the fork test against it.',
    };
  }

  return { available: true, address: toChecksumAddress(trimmed) };
}