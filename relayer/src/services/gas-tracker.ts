/**
 * @fileoverview Gas Price Tracker for WaffleFinance API
 * @description Real-time gas price monitoring and network congestion tracking
 */

import { getCurrentTimestamp } from './utils.js';
import { getLogger } from '../logger.js';

const logger = getLogger().child({ component: 'gas-tracker' });

/**
 * Gas price information
 */
export interface GasPrice {
  slow: string;
  standard: string;
  fast: string;
  instant: string;
  baseFee: string;
  priorityFee: string;
  timestamp: number;
}

/**
 * Network congestion information
 */
export interface NetworkCongestion {
  level: 'low' | 'medium' | 'high' | 'extreme';
  score: number; // 0-1 scale
  pendingTransactions: number;
  blockUtilization: number;
  averageWaitTime: number;
}

/**
 * Gas price history entry
 */
export interface GasPriceHistory {
  timestamp: number;
  price: string;
  baseFee: string;
  priorityFee: string;
  blockNumber: number;
}

/**
 * Gas Price Tracker Class
 */
export class GasPriceTracker {
  private currentGasPrice: GasPrice;
  private priceHistory: GasPriceHistory[] = [];
  private congestionData: NetworkCongestion;
  private updateInterval: NodeJS.Timeout | null = null;
  private readonly MAX_HISTORY_SIZE = 100;

  constructor() {
    this.currentGasPrice = this.getDefaultGasPrice();
    this.congestionData = this.getDefaultCongestion();
  }

  /**
   * Start monitoring gas prices
   */
  startMonitoring(intervalMs: number = 30000): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
    }

    this.updateInterval = setInterval(() => {
      this.updateGasPrices();
    }, intervalMs);

    this.updateGasPrices();
    logger.info('Gas price monitoring started');
  }

  /**
   * Stop monitoring gas prices
   */
  stopMonitoring(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
    logger.info('Gas price monitoring stopped');
  }

  /**
   * Get current gas prices
   */
  getCurrentGasPrice(): GasPrice {
    return { ...this.currentGasPrice };
  }

  /**
   * Get network congestion data
   */
  getNetworkCongestion(): NetworkCongestion {
    return { ...this.congestionData };
  }

  /**
   * Get gas price history
   */
  getGasPriceHistory(limit?: number): GasPriceHistory[] {
    const history = [...this.priceHistory];
    return limit ? history.slice(-limit) : history;
  }

  /**
   * Get optimal gas price for transaction type
   */
  getOptimalGasPrice(transactionType: 'fast' | 'standard' | 'slow' = 'standard'): string {
    const gasPrice = this.currentGasPrice;
    
    // Apply congestion adjustments
    const congestionMultiplier = this.getCongestionMultiplier();
    // Use default 'standard' price if the requested type is missing (legacy response)
    const priceStr = gasPrice[transactionType] ?? gasPrice.standard;
    const basePrice = BigInt(priceStr);
    const adjustedPrice = (basePrice * BigInt(Math.floor(congestionMultiplier * 1000))) / BigInt(1000);
    
    return adjustedPrice.toString();
  }

  /**
   * Predict gas price trend
   */
  predictGasPriceTrend(): 'increasing' | 'decreasing' | 'stable' {
    if (this.priceHistory.length < 5) {
      return 'stable';
    }

    const recent = this.priceHistory.slice(-5);
    const oldAvg = recent.slice(0, 3).reduce((sum, entry) => sum + BigInt(entry.price), BigInt(0)) / BigInt(3);
    const newAvg = recent.slice(2, 5).reduce((sum, entry) => sum + BigInt(entry.price), BigInt(0)) / BigInt(3);
    
    const changeThreshold = oldAvg / BigInt(20); // 5% threshold
    
    if (newAvg > oldAvg + changeThreshold) {
      return 'increasing';
    } else if (newAvg < oldAvg - changeThreshold) {
      return 'decreasing';
    } else {
      return 'stable';
    }
  }

  /**
   * Get gas price recommendation for auction
   */
  getAuctionGasRecommendation(auctionDuration: number): {
    startGasPrice: string;
    endGasPrice: string;
    averageGasPrice: string;
  } {
    const trend = this.predictGasPriceTrend();
    const currentPrice = BigInt(this.currentGasPrice.standard);
    
    let startMultiplier = 1.0;
    let endMultiplier = 1.0;
    
    switch (trend) {
      case 'increasing':
        startMultiplier = 1.1;
        endMultiplier = 1.2;
        break;
      case 'decreasing':
        startMultiplier = 0.9;
        endMultiplier = 0.8;
        break;
      case 'stable':
        startMultiplier = 1.0;
        endMultiplier = 1.0;
        break;
    }

    const startGasPrice = (currentPrice * BigInt(Math.floor(startMultiplier * 1000))) / BigInt(1000);
    const endGasPrice = (currentPrice * BigInt(Math.floor(endMultiplier * 1000))) / BigInt(1000);
    const averageGasPrice = (startGasPrice + endGasPrice) / BigInt(2);

    return {
      startGasPrice: startGasPrice.toString(),
      endGasPrice: endGasPrice.toString(),
      averageGasPrice: averageGasPrice.toString()
    };
  }

  /**
   * Check if gas price is within acceptable range
   */
  isGasPriceAcceptable(gasPrice: string, maxAcceptablePrice: string): boolean {
    return BigInt(gasPrice) <= BigInt(maxAcceptablePrice);
  }

  /**
   * Update gas prices (mock implementation)
   */
  private async updateGasPrices(): Promise<void> {
    try {
      // In production, this would call actual gas price APIs
      // For now, simulate realistic gas price fluctuations
      const mockGasPrice = await this.fetchMockGasPrice();
      const mockCongestion = await this.fetchMockCongestion();

      this.currentGasPrice = mockGasPrice;
      this.congestionData = mockCongestion;

      this.priceHistory.push({
        timestamp: getCurrentTimestamp(),
        price: mockGasPrice.standard,
        baseFee: mockGasPrice.baseFee,
        priorityFee: mockGasPrice.priorityFee,
        blockNumber: Math.floor(Math.random() * 1000000) + 17000000
      });

      if (this.priceHistory.length > this.MAX_HISTORY_SIZE) {
        this.priceHistory = this.priceHistory.slice(-this.MAX_HISTORY_SIZE);
      }

      logger.debug({ gasPrice: mockGasPrice.standard }, 'Gas price updated');
    } catch (error) {
      logger.error({ err: error }, 'Failed to update gas prices');
    }
  }

  /**
   * Fetch mock gas price data
   */
  private async fetchMockGasPrice(): Promise<GasPrice> {
    // Simulate realistic gas price fluctuations
    const basePrice = 20; // 20 gwei base
    const volatility = 0.3; // 30% volatility
    const trend = Math.sin(Date.now() / 100000) * 0.2; // Long-term trend
    
    const randomFactor = (Math.random() - 0.5) * volatility;
    const currentBase = basePrice * (1 + trend + randomFactor);
    
    const baseFee = Math.max(1, currentBase * 0.8);
    const priorityFee = Math.max(1, currentBase * 0.2);
    
    return {
      slow: Math.floor(currentBase * 0.8).toString(),
      standard: Math.floor(currentBase).toString(),
      fast: Math.floor(currentBase * 1.2).toString(),
      instant: Math.floor(currentBase * 1.5).toString(),
      baseFee: Math.floor(baseFee).toString(),
      priorityFee: Math.floor(priorityFee).toString(),
      timestamp: getCurrentTimestamp()
    };
  }

  /**
   * Fetch mock network congestion data
   */
  private async fetchMockCongestion(): Promise<NetworkCongestion> {
    // Simulate network congestion based on time of day
    const hour = new Date().getHours();
    let baseScore = 0.3; // Base congestion
    
    // Higher congestion during peak hours (9-11 AM, 2-4 PM, 7-9 PM UTC)
    if ((hour >= 9 && hour <= 11) || (hour >= 14 && hour <= 16) || (hour >= 19 && hour <= 21)) {
      baseScore = 0.7;
    }
    
    // Add random fluctuation
    const randomFactor = (Math.random() - 0.5) * 0.4;
    const score = Math.max(0, Math.min(1, baseScore + randomFactor));
    
    let level: 'low' | 'medium' | 'high' | 'extreme';
    if (score < 0.3) {
      level = 'low';
    } else if (score < 0.6) {
      level = 'medium';
    } else if (score < 0.8) {
      level = 'high';
    } else {
      level = 'extreme';
    }
    
    return {
      level,
      score,
      pendingTransactions: Math.floor(50000 + (score * 100000)),
      blockUtilization: Math.min(100, 60 + (score * 35)),
      averageWaitTime: Math.floor(15 + (score * 120)) // seconds
    };
  }

  /**
   * Get congestion multiplier for gas price adjustment.
   *
   * Validates the congestion level before applying it. An unrecognised level
   * (e.g. produced by a future API change or a stale cache) logs a warning
   * and falls back to the neutral multiplier (1.0) rather than silently
   * under- or over-pricing gas.
   */
  private getCongestionMultiplier(): number {
    const congestion = this.congestionData;

    switch (congestion.level) {
      case 'low':
        return 0.9;
      case 'medium':
        return 1.0;
      case 'high':
        return 1.2;
      case 'extreme':
        return 1.5;
      default: {
        // Unrecognised level — log and refuse to apply an unknown multiplier.
        process.stderr.write(
          JSON.stringify({
            level: 'warn',
            msg: '[gas-tracker] Unrecognised congestion level — falling back to neutral multiplier (1.0)',
            congestionLevel: (congestion as { level: unknown }).level,
            ts: new Date().toISOString(),
          }) + '\n'
        );
        return 1.0;
      }
    }
  }

  /**
   * Get default gas price
   */
  private getDefaultGasPrice(): GasPrice {
    return {
      slow: "15",
      standard: "20",
      fast: "25",
      instant: "30",
      baseFee: "16",
      priorityFee: "4",
      timestamp: getCurrentTimestamp()
    };
  }

  /**
   * Get default congestion data
   */
  private getDefaultCongestion(): NetworkCongestion {
    return {
      level: 'medium',
      score: 0.5,
      pendingTransactions: 75000,
      blockUtilization: 70,
      averageWaitTime: 45
    };
  }

  /**
   * Get gas price statistics
   */
  getGasPriceStatistics(): {
    average: string;
    median: string;
    min: string;
    max: string;
    volatility: number;
  } {
    if (this.priceHistory.length === 0) {
      const current = this.currentGasPrice.standard;
      return {
        average: current,
        median: current,
        min: current,
        max: current,
        volatility: 0
      };
    }

    const prices = this.priceHistory.map(h => BigInt(h.price));
    const sum = prices.reduce((a, b) => a + b, BigInt(0));
    const average = sum / BigInt(prices.length);
    
    const sorted = [...prices].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    const median = sorted[Math.floor(sorted.length / 2)];
    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    
    // Calculate volatility (standard deviation)
    const avgNum = Number(average);
    const variance = prices.reduce((acc, price) => {
      const diff = Number(price) - avgNum;
      return acc + (diff * diff);
    }, 0) / prices.length;
    const volatility = Math.sqrt(variance) / avgNum;

    return {
      average: average.toString(),
      median: median.toString(),
      min: min.toString(),
      max: max.toString(),
      volatility
    };
  }
}

// Singleton instance
export const gasPriceTracker = new GasPriceTracker();

export default GasPriceTracker; 