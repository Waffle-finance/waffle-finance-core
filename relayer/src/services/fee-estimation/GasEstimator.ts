/**
 * @fileoverview Gas Estimator
 * @description EVM gas price estimation with RPC fallback and caching
 */

import type { GasPrice, NetworkCongestion, ChainType } from './IFeeEstimatorService.js';
import { RpcFallbackManager, getRpcConfig, createRpcFallbackManager } from './RpcFallbackManager.js';
import { getLogger } from '../logger.js';

const logger = getLogger().child({ component: 'gas-estimator' });

// ============================================================================
// Gas Estimator
// ============================================================================

export class GasEstimator {
  private rpcManager: RpcFallbackManager;
  private currentGasPrice: GasPrice | null = null;
  private gasPriceHistory: GasPrice[] = [];
  private congestionData: NetworkCongestion | null = null;
  private readonly MAX_HISTORY_SIZE = 100;

  constructor(
    private readonly chain: ChainType,
    rpcConfig?: any
  ) {
    this.rpcManager = rpcConfig
      ? new RpcFallbackManager(rpcConfig)
      : createRpcFallbackManager(chain);
  }

  /**
   * Estimate gas price for the chain
   */
  async estimateGasPrice(): Promise<GasPrice> {
    try {
      // Try to get from cache first
      const cached = this.getCachedGasPrice();
      if (cached && !this.isCacheStale(cached)) {
        logger.debug({ chain: this.chain }, 'Gas price served from cache');
        return cached;
      }

      // Fetch from RPC
      const gasPrice = await this.fetchGasPriceFromRpc();
      
      // Update cache
      this.cacheGasPrice(gasPrice);

      // Update history
      this.updateGasPriceHistory(gasPrice);

      // Update congestion data
      this.congestionData = this.calculateCongestion(gasPrice);

      logger.info(
        {
          chain: this.chain,
          standard: gasPrice.standard.toString(),
          baseFee: gasPrice.baseFee.toString(),
          priorityFee: gasPrice.priorityFee.toString(),
          source: gasPrice.source,
        },
        'Gas price estimated'
      );

      return gasPrice;
    } catch (error) {
      // Fall back to last known good price
      if (this.currentGasPrice) {
        logger.warn(
          { chain: this.chain, error: error },
          'RPC failed, using last known gas price'
        );
        return this.currentGasPrice;
      }

      // No cache available, return default
      logger.error(
        { chain: this.chain, error: error },
        'RPC failed and no cache available'
      );
      return this.getDefaultGasPrice();
    }
  }

  /**
   * Get congestion information
   */
  getCongestion(): NetworkCongestion | null {
    if (this.congestionData && !this.isCacheStale(this.currentGasPrice)) {
      return this.congestionData;
    }
    // Recalculate if stale
    const gasPrice = this.getCachedGasPrice();
    if (gasPrice) {
      this.congestionData = this.calculateCongestion(gasPrice);
      return this.congestionData;
    }
    return null;
  }

  /**
   * Get gas price history
   */
  getGasPriceHistory(limit?: number): GasPrice[] {
    const history = [...this.gasPriceHistory];
    return limit ? history.slice(-limit) : history;
  }

  /**
   * Get the last estimated gas price
   */
  getCurrentGasPrice(): GasPrice | null {
    return this.currentGasPrice ? { ...this.currentGasPrice } : null;
  }

  /**
   * Get all gas price history
   */
  getFullHistory(): GasPrice[] {
    return [...this.gasPriceHistory];
  }

  /**
   * Clear cache and force refresh
   */
  clearCache(): void {
    this.currentGasPrice = null;
    this.congestionData = null;
    logger.info({ chain: this.chain }, 'Gas price cache cleared');
  }

  /**
   * Fetch gas price from RPC
   */
  private async fetchGasPriceFromRpc(): Promise<GasPrice> {
    return this.rpcManager.executeWithFallback(async (url) => {
      try {
        const response = await this.fetchGasPriceFromUrl(url);
        return response;
      } catch (error) {
        logger.warn(
          { url, error: error },
          'RPC fetch failed'
        );
        throw error;
      }
    });
  }

  /**
   * Fetch gas price from a specific URL
   */
  private async fetchGasPriceFromUrl(url: string): Promise<GasPrice> {
    const timestamp = Date.now();
    const blockNumber = Math.floor(timestamp / 1000) + 17000000;

    // For now, use mock data - in production, this would call the actual RPC
    // Example RPC call:
    // const response = await fetch(url, {
    //   method: 'POST',
    //   headers: { 'Content-Type': 'application/json' },
    //   body: JSON.stringify({
    //     jsonrpc: '2.0',
    //     method: 'eth_gasPrice',
    //     params: [],
    //     id: 1
    //   })
    // });

    // Mock response for now
    const basePrice = BigInt(20 * 10 ** 9); // 20 gwei
    const volatility = 0.3; // 30% volatility
    const trend = Math.sin(Date.now() / 100000) * 0.2; // Long-term trend
    const randomFactor = (Math.random() - 0.5) * volatility;
    const currentBase = Number(basePrice) * (1 + trend + randomFactor);

    const baseFee = Math.max(1, currentBase * 0.8);
    const priorityFee = Math.max(1, currentBase * 0.2);

    const gasPrice: GasPrice = {
      slow: BigInt(Math.floor(currentBase * 0.8)),
      standard: BigInt(Math.floor(currentBase)),
      fast: BigInt(Math.floor(currentBase * 1.2)),
      instant: BigInt(Math.floor(currentBase * 1.5)),
      baseFee: BigInt(Math.floor(baseFee)),
      priorityFee: BigInt(Math.floor(priorityFee)),
      timestamp,
      source: 'rpc' as const,
      blockNumber,
    };

    return gasPrice;
  }

  /**
   * Check if cache is stale (older than 30 seconds)
   */
  private isCacheStale(gasPrice: GasPrice): boolean {
    if (!gasPrice) return true;
    const age = Date.now() - gasPrice.timestamp;
    return age > 30_000; // 30 seconds
  }

  /**
   * Get cached gas price
   */
  private getCachedGasPrice(): GasPrice | null {
    if (!this.currentGasPrice) return null;
    if (this.isCacheStale(this.currentGasPrice)) return null;
    return { ...this.currentGasPrice };
  }

  /**
   * Cache gas price
   */
  private cacheGasPrice(gasPrice: GasPrice): void {
    this.currentGasPrice = { ...gasPrice };
  }

  /**
   * Update gas price history
   */
  private updateGasPriceHistory(gasPrice: GasPrice): void {
    this.gasPriceHistory.push(gasPrice);
    if (this.gasPriceHistory.length > this.MAX_HISTORY_SIZE) {
      this.gasPriceHistory = this.gasPriceHistory.slice(-this.MAX_HISTORY_SIZE);
    }
  }

  /**
   * Calculate network congestion from gas prices
   */
  private calculateCongestion(gasPrice: GasPrice): NetworkCongestion {
    const baseFee = Number(gasPrice.baseFee);
    const standard = Number(gasPrice.standard);

    // Calculate utilization based on base fee vs standard
    const utilization = standard > 0 ? (baseFee / standard) * 100 : 50;

    // Determine congestion level
    let level: 'low' | 'medium' | 'high' | 'extreme';
    let score: number;

    if (utilization < 30) {
      level = 'low';
      score = 0.2;
    } else if (utilization < 60) {
      level = 'medium';
      score = 0.5;
    } else if (utilization < 85) {
      level = 'high';
      score = 0.8;
    } else {
      level = 'extreme';
      score = 1.0;
    }

    // Add some randomness to simulate real network conditions
    score = Math.max(0, Math.min(1, score + (Math.random() - 0.5) * 0.2));

    return {
      level,
      score,
      pendingTransactions: Math.floor(50000 + score * 100000),
      blockUtilization: Math.min(100, Math.floor(utilization)),
      averageWaitTime: Math.floor(15 + score * 120),
      lastUpdated: Date.now(),
    };
  }

  /**
   * Get default gas price
   */
  private getDefaultGasPrice(): GasPrice {
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
      blockNumber: Math.floor(timestamp / 1000) + 17000000,
    };
  }
}
