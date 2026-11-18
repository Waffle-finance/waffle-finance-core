/**
 * @fileoverview Fee Validator
 * @description Validates fees before transaction submission
 */

import type { ChainType, GasPrice, FeeValidationResult } from './IFeeEstimatorService.js';
import { getLogger } from '../logger.js';

const logger = getLogger().child({ component: 'fee-validator' });

// ============================================================================
// Fee Validator
// ============================================================================

export class FeeValidator {
  /**
   * Validate fee before transaction submission
   */
  validateFee(
    chain: ChainType,
    actualFee: bigint,
    estimatedFee: bigint
  ): FeeValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Calculate fee difference percentage
    const diff = estimatedFee - actualFee;
    const diffPercentage = estimatedFee > 0
      ? (Number(diff) / Number(estimatedFee)) * 100
      : 0;

    // Check if fee is too low (< 80% of estimated)
    if (diffPercentage > 20) {
      errors.push(
        `Fee too low: ${diffPercentage.toFixed(1)}% below estimate. ` +
        `Actual: ${this.formatFee(actualFee)}, Estimated: ${this.formatFee(estimatedFee)}`
      );
    }

    // Check if fee is suspiciously low (< 50% of estimated)
    if (diffPercentage > 50) {
      errors.push(
        `Fee dangerously low: ${diffPercentage.toFixed(1)}% below estimate. ` +
        `This transaction will likely fail or get stuck.`
      );
    }

    // Check if fee is way too high (> 150% of estimated)
    if (diffPercentage < -50) {
      warnings.push(
        `Fee much higher than estimate: ${Math.abs(diffPercentage).toFixed(1)}% above estimate. ` +
        `Actual: ${this.formatFee(actualFee)}, Estimated: ${this.formatFee(estimatedFee)}. ` +
        `You may be overpaying.`
      );
    }

    // Check for zero fee
    if (actualFee === 0n) {
      errors.push('Fee is zero - transaction will be rejected by network');
    }

    // Check for negative fee
    if (actualFee < 0n) {
      errors.push('Fee is negative - invalid value');
    }

    const isValid = errors.length === 0;

    // Suggested fee if adjustment needed
    let suggestedFee: bigint | undefined;
    if (!isValid && diffPercentage > 20 && diffPercentage <= 50) {
      suggestedFee = estimatedFee;
    } else if (diffPercentage > 50) {
      suggestedFee = estimatedFee * BigInt(120) / BigInt(100); // 20% buffer
    }

    if (!isValid) {
      logger.warn(
        {
          chain,
          actualFee: actualFee.toString(),
          estimatedFee: estimatedFee.toString(),
          diffPercentage,
          errors,
        },
        'Fee validation failed'
      );
    } else if (warnings.length > 0) {
      logger.warn(
        {
          chain,
          actualFee: actualFee.toString(),
          estimatedFee: estimatedFee.toString(),
          warnings,
        },
        'Fee validation warnings'
      );
    } else {
      logger.debug(
        {
          chain,
          actualFee: actualFee.toString(),
          estimatedFee: estimatedFee.toString(),
        },
        'Fee validation passed'
      );
    }

    return {
      isValid,
      errors,
      warnings,
      suggestedFee,
    };
  }

  /**
   * Validate gas price
   */
  validateGasPrice(
    chain: ChainType,
    actualGasPrice: bigint,
    estimatedGasPrice: GasPrice
  ): FeeValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Get the relevant gas price based on chain type
    // For EVM chains, we use standard or fast price
    const relevantPrice = this.getRelevantGasPrice(chain, estimatedGasPrice);
    const diffPercentage = relevantPrice > 0
      ? ((Number(relevantPrice) - Number(actualGasPrice)) / Number(relevantPrice)) * 100
      : 0;

    // Check if gas price is too low
    if (diffPercentage > 20) {
      errors.push(
        `Gas price too low: ${diffPercentage.toFixed(1)}% below estimate. ` +
        `Actual: ${this.formatGasPrice(actualGasPrice)}, Expected: ${this.formatGasPrice(relevantPrice)}`
      );
    }

    const isValid = errors.length === 0;

    if (!isValid) {
      logger.warn(
        {
          chain,
          actualGasPrice: actualGasPrice.toString(),
          estimatedGasPrice: relevantPrice.toString(),
          diffPercentage,
          errors,
        },
        'Gas price validation failed'
      );
    }

    return {
      isValid,
      errors,
      warnings,
    };
  }

  /**
   * Get relevant gas price for a chain
   */
  private getRelevantGasPrice(
    chain: ChainType,
    gasPrice: GasPrice
  ): bigint {
    // Different chains may use different gas price tiers
    switch (chain) {
      case 'ethereum':
      case 'optimism':
      case 'arbitrum':
        return gasPrice.standard;
      case 'polygon':
        return gasPrice.fast; // Polygon uses faster prices
      default:
        return gasPrice.standard;
    }
  }

  /**
   * Format fee for logging
   */
  private formatFee(fee: bigint): string {
    if (fee >= BigInt(10 ** 18)) {
      return `${(Number(fee) / 10 ** 18).toFixed(4)} ETH`;
    }
    if (fee >= BigInt(10 ** 9)) {
      return `${(Number(fee) / 10 ** 9).toFixed(2)} gwei`;
    }
    return `${fee.toString()} wei`;
  }

  /**
   * Format gas price for logging
   */
  private formatGasPrice(gasPrice: bigint): string {
    if (gasPrice >= BigInt(10 ** 9)) {
      return `${(Number(gasPrice) / 10 ** 9).toFixed(2)} gwei`;
    }
    return `${gasPrice.toString()} wei`;
  }

  /**
   * Get validation thresholds
   */
  getThresholds(): {
    minAcceptablePercentage: number;
    warningThresholdPercentage: number;
    maxAcceptablePercentage: number;
  } {
    return {
      minAcceptablePercentage: 80, // Minimum 80% of estimate
      warningThresholdPercentage: 150, // Warning if > 150% of estimate
      maxAcceptablePercentage: 1000, // Absolute max (10x estimate)
    };
  }

  /**
   * Set custom thresholds
   */
  setThresholds(thresholds: {
    minAcceptablePercentage?: number;
    warningThresholdPercentage?: number;
    maxAcceptablePercentage?: number;
  }): void {
    // Store custom thresholds if needed
  }
}

// ============================================================================
// Default Validator
// ============================================================================

export const DEFAULT_VALIDATOR = new FeeValidator();
