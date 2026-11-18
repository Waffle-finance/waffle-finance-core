/**
 * @fileoverview Fee Estimator Service
 * @description Unified fee estimation service for all chains
 */

import type {
  ChainType,
  GasPrice,
  NetworkCongestion,
  FeeEstimate,
  FeeValidationResult,
  IFeeEstimatorService,
  FeeEstimatorStats,
} from './IFeeEstimatorService.js';
import { GasEstimator } from './GasEstimator.js';
import { FeeValidator, DEFAULT_VALIDATOR } from './FeeValidator.js';
import { GasBumpingStrategy, createGasBumpingStrategy } from './GasBumpingStrategy.js';
import { getLogger } from '../logger.js';

const logger = getLogger().child({ component: 'fee-estimator-service' });

// ============================================================================
// Fee Estimator Service
// ============================================================================

export class FeeEstimatorService implements IFeeEstimatorService {
  private gasEstimators: Map<ChainType, GasEstimator> = new Map();
  private bumpingStrategies: Map<string, GasBumpingStrategy> = new Map();
  private validator: FeeValidator = DEFAULT_VALIDATOR;
  private stats: FeeEstimatorStats = {
    totalEstimates: 0,
    successfulEstimates: 0,
    failedEstimates: 0,
    totalValidations: 0,
    validFees: 0,
    invalidFees: 0,
    gasBumpingEvents: 0,
    rpcFallbackEvents: 0,
    lastEstimationTimestamp: 0,
  };

  constructor() {
    // Initialize gas estimators for all supported chains
    this.initializeGasEstimators();
  }

  /**
   * Initialize gas estimators for all chains
   */
  private initializeGasEstimators(): void {
    const chains: ChainType[] = [
      'ethereum',
      'polygon',
      'optimism',
      'arbitrum',
    ];

    for (const chain of chains) {
      const estimator = new GasEstimator(chain);
      this.gasEstimators.set(chain, estimator);
    }
  }

  /**
   * Start the fee estimation service
   */
  start(): void {
    logger.info('Fee estimator service started');
  }

  /**
   * Stop the fee estimation service
   */
  stop(): void {
    logger.info('Fee estimator service stopped');
  }

  /**
   * Estimate gas price for a specific chain
   */
  async estimateGasPrice(chain: ChainType): Promise<GasPrice> {
    this.stats.totalEstimates++;
    this.stats.lastEstimationTimestamp = Date.now();

    try {
      const estimator = this.gasEstimators.get(chain);
      if (!estimator) {
        throw new Error(`No gas estimator available for chain: ${chain}`);
      }

      const gasPrice = await estimator.estimateGasPrice();
      this.stats.successfulEstimates++;

      return gasPrice;
    } catch (error) {
      this.stats.failedEstimates++;

      // Return fallback gas price
      logger.warn(
        { chain, error },
        'Gas estimation failed, returning fallback'
      );
      return this.getFallbackGasPrice(chain);
    }
  }

  /**
   * Estimate fee for a transaction
   */
  async estimateFee(
    chain: ChainType,
    gasLimit: bigint,
    gasPriceMultiplier: number = 1.0
  ): Promise<FeeEstimate> {
    try {
      const gasPrice = await this.estimateGasPrice(chain);
      const adjustedPrice = gasPrice.standard * BigInt(
        Math.floor(gasPriceMultiplier * 1000)
      ) / BigInt(1000);

      const totalFee = gasLimit * adjustedPrice;
      const congestion = this.getCongestion(chain) || this.getDefaultCongestion();

      return {
        gasLimit,
        totalFee,
        gasPrice: adjustedPrice,
        congestion,
        timestamp: Date.now(),
        chain,
      };
    } catch (error) {
      logger.error(
        { chain, error },
        'Fee estimation failed'
      );

      return {
        gasLimit,
        totalFee: gasLimit * BigInt(20 * 10 ** 9), // Use default 20 gwei
        gasPrice: BigInt(20 * 10 ** 9),
        congestion: this.getDefaultCongestion(),
        timestamp: Date.now(),
        chain,
      };
    }
  }

  /**
   * Validate fee before submission
   */
  validateFee(
    chain: ChainType,
    actualFee: bigint,
    estimatedFee: bigint
  ): FeeValidationResult {
    this.stats.totalValidations++;

    const result = this.validator.validateFee(chain, actualFee, estimatedFee);

    if (result.isValid) {
      this.stats.validFees++;
    } else {
      this.stats.invalidFees++;
    }

    return result;
  }

  /**
   * Get congestion information for a chain
   */
  getCongestion(chain: ChainType): NetworkCongestion | null {
    const estimator = this.gasEstimators.get(chain);
    if (estimator) {
      return estimator.getCongestion();
    }
    return this.getDefaultCongestion();
  }

  /**
   * Get gas price history for a chain
   */
  getGasPriceHistory(chain: ChainType, limit?: number): GasPrice[] {
    const estimator = this.gasEstimators.get(chain);
    if (estimator) {
      return estimator.getGasPriceHistory(limit);
    }
    return [];
  }

  /**
   * Get fee estimation statistics
   */
  getStats(): FeeEstimatorStats {
    return { ...this.stats };
  }

  /**
   * Clear cache for a specific chain
   */
  clearCache(chain: ChainType): void {
    const estimator = this.gasEstimators.get(chain);
    if (estimator) {
      estimator.clearCache();
    }
  }

  /**
   * Clear all caches
   */
  clearAllCaches(): void {
    for (const estimator of this.gasEstimators.values()) {
      estimator.clearCache();
    }
  }

  /**
   * Get fallback gas price
   */
  private getFallbackGasPrice(chain: ChainType): GasPrice {
    const timestamp = Date.now();
    return {
      slow: BigInt(15 * 10 ** 9),
      standard: BigInt(20 * 10 ** 9),
      fast: BigInt(25 * 10 ** 9),
      instant: BigInt(30 * 10 ** 9),
      baseFee: BigInt(16 * 10 ** 9),
      priorityFee: BigInt(4 * 10 ** 9),
      timestamp,
      source: 'fallback',
    };
  }

  /**
   * Get default congestion
   */
  private getDefaultCongestion(): NetworkCongestion {
    return {
      level: 'medium',
      score: 0.5,
      pendingTransactions: 75000,
      blockUtilization: 70,
      averageWaitTime: 45,
      lastUpdated: Date.now(),
    };
  }

  /**
   * Get gas bumping strategy for a chain
   */
  getGasBumpingStrategy(chain: string): GasBumpingStrategy {
    const key = `${chain}:default`;
    if (!this.bumpingStrategies.has(key)) {
      this.bumpingStrategies.set(
        key,
        createGasBumpingStrategy(chain as ChainType)
      );
    }
    return this.bumpingStrategies.get(key)!;
  }
}

// ============================================================================
// Default Instance
// ============================================================================

export const defaultFeeEstimatorService = new FeeEstimatorService();
