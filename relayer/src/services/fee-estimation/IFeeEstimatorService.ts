/**
 * @fileoverview Fee Estimator Service Interface
 * @description Unified interface for fee estimation across EVM and non-EVM chains
 */

// ============================================================================
// Fee Types
// ============================================================================

export type ChainType = 'ethereum' | 'polygon' | 'optimism' | 'arbitrum' | 'stellar' | 'solana';

/**
 * Gas price information for EVM chains
 */
export interface GasPrice {
  /**
   * Slow gas price (wei)
   */
  slow: bigint;
  /**
   * Standard gas price (wei)
   */
  standard: bigint;
  /**
   * Fast gas price (wei)
   */
  fast: bigint;
  /**
   * Instant gas price (wei)
   */
  instant: bigint;
  /**
   * Base fee (wei)
   */
  baseFee: bigint;
  /**
   * Priority fee (wei)
   */
  priorityFee: bigint;
  /**
   * Timestamp of estimation
   */
  timestamp: number;
  /**
   * Source of the estimation (rpc, cache, fallback)
   */
  source: 'rpc' | 'cache' | 'fallback';
  /**
   * Block number at time of estimation
   */
  blockNumber?: number;
}

/**
 * Network congestion information
 */
export interface NetworkCongestion {
  /**
   * Congestion level
   */
  level: 'low' | 'medium' | 'high' | 'extreme';
  /**
   * Congestion score (0-1)
   */
  score: number;
  /**
   * Pending transactions
   */
  pendingTransactions: number;
  /**
   * Block utilization percentage
   */
  blockUtilization: number;
  /**
   * Average wait time in seconds
   */
  averageWaitTime: number;
  /**
   * Last updated timestamp
   */
  lastUpdated: number;
}

/**
 * Fee estimate result
 */
export interface FeeEstimate {
  /**
   * Estimated gas limit
   */
  gasLimit: bigint;
  /**
   * Estimated fee (gasLimit * gasPrice)
   */
  totalFee: bigint;
  /**
   * Gas price used for estimation
   */
  gasPrice: bigint;
  /**
   * Network congestion at time of estimation
   */
  congestion: NetworkCongestion;
  /**
   * Timestamp of estimation
   */
  timestamp: number;
  /**
   * Chain type
   */
  chain: ChainType;
}

/**
 * Fee validation result
 */
export interface FeeValidationResult {
  /**
   * True if fee is valid
   */
  isValid: boolean;
  /**
   * List of validation errors
   */
  errors: string[];
  /**
   * List of validation warnings
   */
  warnings: string[];
  /**
   * Suggested fee if adjustments needed
   */
  suggestedFee?: bigint;
}

// ============================================================================
// Fee Estimator Service Interface
// ============================================================================

export interface IFeeEstimatorService {
  /**
   * Start the fee estimation service
   */
  start(): void;

  /**
   * Stop the fee estimation service
   */
  stop(): void;

  /**
   * Estimate gas price for a specific chain
   */
  estimateGasPrice(chain: ChainType): Promise<GasPrice>;

  /**
   * Estimate fee for a transaction
   */
  estimateFee(
    chain: ChainType,
    gasLimit: bigint,
    gasPriceMultiplier?: number
  ): Promise<FeeEstimate>;

  /**
   * Validate fee before submission
   */
  validateFee(
    chain: ChainType,
    actualFee: bigint,
    estimatedFee: bigint
  ): FeeValidationResult;

  /**
   * Get congestion information for a chain
   */
  getCongestion(chain: ChainType): NetworkCongestion | null;

  /**
   * Get gas price history for a chain
   */
  getGasPriceHistory(chain: ChainType, limit?: number): GasPrice[];

  /**
   * Get fee estimation statistics
   */
  getStats(): FeeEstimatorStats;
}

// ============================================================================
// Fee Estimator Statistics
// ============================================================================

export interface FeeEstimatorStats {
  /**
   * Total fee estimation requests
   */
  totalEstimates: number;
  /**
   * Successful fee estimates
   */
  successfulEstimates: number;
  /**
   * Failed fee estimates
   */
  failedEstimates: number;
  /**
   * Total validations
   */
  totalValidations: number;
  /**
   * Valid fees
   */
  validFees: number;
  /**
   * Invalid fees
   */
  invalidFees: number;
  /**
   * Gas bumping events
   */
  gasBumpingEvents: number;
  /**
   * RPC fallback events
   */
  rpcFallbackEvents: number;
  /**
   * Last estimation timestamp
   */
  lastEstimationTimestamp: number;
}

// ============================================================================
// RPC Configuration
// ============================================================================

export interface RpcEndpoint {
  /**
   * URL of the RPC endpoint
   */
  url: string;
  /**
   * Weight for load balancing (higher = more requests)
   */
  weight: number;
  /**
   * Whether this endpoint is currently healthy
   */
  healthy: boolean;
  /**
   * Last failure timestamp
   */
  lastFailure?: number;
  /**
   * Failure count
   */
  failureCount: number;
}

export interface RpcConfig {
  /**
   * List of RPC endpoints
   */
  endpoints: RpcEndpoint[];
  /**
   * Maximum failures before marking endpoint unhealthy
   */
  maxFailures: number;
  /**
   * Timeout in ms for RPC calls
   */
  timeout: number;
  /**
   * Fallback delay in ms
   */
  fallbackDelay: number;
}

// ============================================================================
// Gas Bumping Configuration
// ============================================================================

export interface GasBumpingConfig {
  /**
   * Maximum number of bump attempts
   */
  maxBumpAttempts: number;
  /**
   * Bump percentage per attempt (e.g., 1.1 = 10% increase)
   */
  bumpPercentage: number;
  /**
   * Minimum bump amount in wei
   */
  minBumpAmount: bigint;
  /**
   * Maximum gas price allowed (in wei)
   */
  maxGasPrice: bigint;
  /**
   * Backoff between bump attempts (ms)
   */
  bumpBackoffMs: number;
}

// ============================================================================
// Error Types
// ============================================================================

export class FeeEstimationError extends Error {
  constructor(
    message: string,
    public readonly chain: ChainType,
    public readonly code: string
  ) {
    super(message);
    this.name = 'FeeEstimationError';
  }
}

export class GasEstimationError extends FeeEstimationError {
  constructor(message: string, chain: ChainType) {
    super(message, chain, 'GAS_ESTIMATION_FAILED');
  }
}

export class RpcError extends FeeEstimationError {
  constructor(message: string, chain: ChainType, public readonly endpoint?: string) {
    super(message, chain, 'RPC_ERROR');
  }
}

export class FeeValidationError extends FeeEstimationError {
  constructor(message: string, chain: ChainType) {
    super(message, chain, 'FEE_VALIDATION_FAILED');
  }
}
