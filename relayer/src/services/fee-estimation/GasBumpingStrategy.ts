/**
 * @fileoverview Gas Bumping Strategy
 * @description Handles underpriced transaction recovery with gas bumping
 */

import type { ChainType, GasPrice, GasBumpingConfig } from './IFeeEstimatorService.js';
import { getLogger } from '../logger.js';

const logger = getLogger().child({ component: 'gas-bumping-strategy' });

// ============================================================================
// Gas Bumping Strategy
// ============================================================================

export class GasBumpingStrategy {
  private bumpCount: Map<string, number> = new Map();
  private lastBumpTime: Map<string, number> = new Map();
  private readonly config: GasBumpingConfig;

  constructor(config?: Partial<GasBumpingConfig>) {
    this.config = {
      maxBumpAttempts: 5,
      bumpPercentage: 1.1, // 10% increase
      minBumpAmount: BigInt(1000000000), // 1 gwei
      maxGasPrice: BigInt(100 * 10 ** 9), // 100 gwei
      bumpBackoffMs: 5000,
      ...config,
    };
  }

  /**
   * Check if a transaction needs gas bumping
   */
  needsBumping(
    chain: ChainType,
    transactionHash: string,
    gasPrice: bigint,
    estimatedGasPrice: bigint
  ): boolean {
    // If gas price is at least 80% of estimated, no bump needed
    const threshold = estimatedGasPrice * BigInt(80) / BigInt(100);
    return gasPrice < threshold;
  }

  /**
   * Calculate bumped gas price
   */
  calculateBumpedGasPrice(
    currentGasPrice: bigint,
    bumpCount: number
  ): bigint {
    // Calculate bump amount
    const bumpPercentage = BigInt(
      Math.floor(this.config.bumpPercentage * 1000)
    );
    const bumpAmount = (currentGasPrice * bumpPercentage) / BigInt(1000);

    // Apply minimum bump amount
    const bumpedPrice = bumpAmount > this.config.minBumpAmount
      ? bumpAmount
      : this.config.minBumpAmount;

    // Cap at max gas price
    return bumpedPrice > this.config.maxGasPrice
      ? this.config.maxGasPrice
      : bumpedPrice;
  }

  /**
   * Check if we can bump gas for a transaction
   */
  canBump(chain: string, transactionHash: string): boolean {
    const bumpCount = this.bumpCount.get(transactionHash) || 0;
    const lastBump = this.lastBumpTime.get(transactionHash) || 0;
    const elapsed = Date.now() - lastBump;

    if (bumpCount >= this.config.maxBumpAttempts) {
      logger.warn(
        { transactionHash, chain, bumpCount },
        'Max bump attempts reached'
      );
      return false;
    }

    if (elapsed < this.config.bumpBackoffMs) {
      logger.debug(
        { transactionHash, chain, elapsed },
        'Bump backoff not yet expired'
      );
      return false;
    }

    return true;
  }

  /**
   * Record a bump attempt
   */
  recordBump(transactionHash: string): number {
    const current = this.bumpCount.get(transactionHash) || 0;
    const newCount = current + 1;
    this.bumpCount.set(transactionHash, newCount);
    this.lastBumpTime.set(transactionHash, Date.now());
    logger.info(
      { transactionHash, bumpCount: newCount },
      'Gas bump recorded'
    );
    return newCount;
  }

  /**
   * Get current bump count for a transaction
   */
  getBumpCount(transactionHash: string): number {
    return this.bumpCount.get(transactionHash) || 0;
  }

  /**
   * Reset bump count for a transaction
   */
  resetBump(transactionHash: string): void {
    this.bumpCount.delete(transactionHash);
    this.lastBumpTime.delete(transactionHash);
  }

  /**
   * Check if we should retry after bumping
   */
  shouldRetry(chain: string, transactionHash: string): boolean {
    return this.canBump(chain, transactionHash);
  }

  /**
   * Get bumped gas price for a transaction
   */
  getBumpedGasPrice(
    currentGasPrice: bigint,
    transactionHash: string
  ): bigint | null {
    if (!this.canBump(transactionHash, transactionHash)) {
      return null;
    }

    const bumpCount = this.bumpCount.get(transactionHash) || 0;
    const bumped = this.calculateBumpedGasPrice(
      currentGasPrice,
      bumpCount
    );

    logger.info(
      {
        transactionHash,
        current: currentGasPrice.toString(),
        bumped: bumped.toString(),
        bumpCount: bumpCount + 1,
        maxGasPrice: this.config.maxGasPrice.toString(),
      },
      'Gas bump calculated'
    );

    return bumped;
  }

  /**
   * Record a successful bump
   */
  recordSuccessfulBump(transactionHash: string, newHash: string): void {
    logger.info(
      {
        oldHash: transactionHash,
        newHash,
        bumpCount: this.bumpCount.get(transactionHash) || 0,
      },
      'Gas bump succeeded, transaction replaced'
    );
    this.resetBump(transactionHash);
  }

  /**
   * Record bump failure
   */
  recordBumpFailure(transactionHash: string, error: string): void {
    logger.warn(
      { transactionHash, error, bumpCount: this.bumpCount.get(transactionHash) || 0 },
      'Gas bump failed'
    );
  }

  /**
   * Get bump statistics
   */
  getStats(): {
    totalBumps: number;
    successfulBumps: number;
    failedBumps: number;
    maxReached: number;
  } {
    // In production, this would track actual statistics
    return {
      totalBumps: 0,
      successfulBumps: 0,
      failedBumps: 0,
      maxReached: 0,
    };
  }
}

// ============================================================================
// Default Bumping Configuration
// ============================================================================

export const DEFAULT_BUMPING_CONFIG: GasBumpingConfig = {
  maxBumpAttempts: 5,
  bumpPercentage: 1.1, // 10% increase per bump
  minBumpAmount: BigInt(1000000000), // 1 gwei
  maxGasPrice: BigInt(100 * 10 ** 9), // 100 gwei
  bumpBackoffMs: 5000, // 5 seconds between bumps
};

// ============================================================================
// Bumping Strategy Factory
// ============================================================================

/**
 * Create a gas bumping strategy for a chain
 */
export function createGasBumpingStrategy(chain: ChainType): GasBumpingStrategy {
  // Different chains may have different bumping requirements
  switch (chain) {
    case 'ethereum':
      return new GasBumpingStrategy({
        ...DEFAULT_BUMPING_CONFIG,
        maxGasPrice: BigInt(150 * 10 ** 9), // Higher max for Ethereum
      });
    case 'polygon':
      return new GasBumpingStrategy({
        ...DEFAULT_BUMPING_CONFIG,
        maxGasPrice: BigInt(50 * 10 ** 9), // Lower max for Polygon
        bumpPercentage: 1.15, // Higher bump percentage
      });
    default:
      return new GasBumpingStrategy(DEFAULT_BUMPING_CONFIG);
  }
}
