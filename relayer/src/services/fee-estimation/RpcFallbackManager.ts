/**
 * @fileoverview RPC Fallback Manager
 * @description Manages RPC endpoint rotation and fallback for robust fee estimation
 */

import type { RpcConfig, RpcEndpoint } from './IFeeEstimatorService.js';
import { getLogger } from '../logger.js';

const logger = getLogger().child({ component: 'rpc-fallback-manager' });

// ============================================================================
// RPC Fallback Manager
// ============================================================================

export class RpcFallbackManager {
  private endpoints: RpcEndpoint[];
  private currentEndpointIndex = 0;
  private readonly config: RpcConfig;

  constructor(config: RpcConfig) {
    this.config = {
      ...config,
      endpoints: config.endpoints.map(e => ({ ...e })),
    };
    this.endpoints = this.config.endpoints;
    this.currentEndpointIndex = 0;
  }

  /**
   * Get the current RPC endpoint
   */
  getCurrentEndpoint(): RpcEndpoint {
    return this.endpoints[this.currentEndpointIndex];
  }

  /**
   * Get the next available endpoint (with fallback)
   */
  getNextEndpoint(): RpcEndpoint {
    // Find next healthy endpoint
    for (let i = 1; i <= this.endpoints.length; i++) {
      const index = (this.currentEndpointIndex + i) % this.endpoints.length;
      if (this.endpoints[index].healthy) {
        this.currentEndpointIndex = index;
        return this.endpoints[index];
      }
    }

    // If no healthy endpoints, use the current one (may fail)
    logger.warn('No healthy RPC endpoints available');
    return this.getCurrentEndpoint();
  }

  /**
   * Mark an endpoint as failed
   */
  markFailed(endpoint: RpcEndpoint): void {
    endpoint.failureCount++;
    endpoint.lastFailure = Date.now();

    if (endpoint.failureCount >= this.config.maxFailures) {
      endpoint.healthy = false;
      logger.warn(
        { endpoint: endpoint.url, failures: endpoint.failureCount },
        'RPC endpoint marked unhealthy'
      );
    }

    // Automatically switch to next healthy endpoint
    this.getNextEndpoint();
  }

  /**
   * Mark an endpoint as healthy
   */
  markHealthy(endpoint: RpcEndpoint): void {
    endpoint.failureCount = 0;
    endpoint.healthy = true;
    logger.info({ endpoint: endpoint.url }, 'RPC endpoint marked healthy');
  }

  /**
   * Get all healthy endpoints
   */
  getHealthyEndpoints(): RpcEndpoint[] {
    return this.endpoints.filter(e => e.healthy);
  }

  /**
   * Get all endpoints with their status
   */
  getEndpointsStatus(): RpcEndpoint[] {
    return [...this.endpoints];
  }

  /**
   * Reset endpoint status
   */
  resetEndpoint(url: string): void {
    const endpoint = this.endpoints.find(e => e.url === url);
    if (endpoint) {
      endpoint.failureCount = 0;
      endpoint.healthy = true;
      endpoint.lastFailure = undefined;
      logger.info({ endpoint: url }, 'RPC endpoint reset');
    }
  }

  /**
   * Get endpoint by URL
   */
  getEndpoint(url: string): RpcEndpoint | undefined {
    return this.endpoints.find(e => e.url === url);
  }

  /**
   * Check if any endpoints are healthy
   */
  hasHealthyEndpoints(): boolean {
    return this.getHealthyEndpoints().length > 0;
  }

  /**
   * Attempt to use an endpoint and handle result
   */
  async withEndpoint<T>(
    endpoint: RpcEndpoint,
    operation: (url: string) => Promise<T>
  ): Promise<T> {
    try {
      const result = await operation(endpoint.url);
      this.markHealthy(endpoint);
      return result;
    } catch (error) {
      this.markFailed(endpoint);
      throw error;
    }
  }

  /**
   * Execute operation with automatic fallback
   */
  async executeWithFallback<T>(
    operation: (url: string) => Promise<T>
  ): Promise<T> {
    let lastError: Error | undefined;

    // Try current endpoint first
    const current = this.getCurrentEndpoint();
    try {
      return await this.withEndpoint(current, operation);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }

    // Try other healthy endpoints
    const healthyEndpoints = this.getHealthyEndpoints();
    for (const endpoint of healthyEndpoints) {
      if (endpoint === current) continue; // Already tried
      try {
        return await this.withEndpoint(endpoint, operation);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }

    // All endpoints failed
    throw new Error(
      `All RPC endpoints failed: ${lastError?.message || 'Unknown error'}`
    );
  }
}

// ============================================================================
// Default RPC Configurations
// ============================================================================

export const DEFAULT_RPC_CONFIG: RpcConfig = {
  endpoints: [
    {
      url: 'https://eth.llamarpc.com',
      weight: 10,
      healthy: true,
      failureCount: 0,
    },
    {
      url: 'https://cloudflare-eth.com',
      weight: 5,
      healthy: true,
      failureCount: 0,
    },
    {
      url: 'https://rpc.ankr.com/eth',
      weight: 3,
      healthy: true,
      failureCount: 0,
    },
  ],
  maxFailures: 3,
  timeout: 10_000,
  fallbackDelay: 1000,
};

export const DEFAULT_POLYGON_RPC_CONFIG: RpcConfig = {
  endpoints: [
    {
      url: 'https://polygon.llamarpc.com',
      weight: 10,
      healthy: true,
      failureCount: 0,
    },
    {
      url: 'https://rpc.ankr.com/polygon',
      weight: 5,
      healthy: true,
      failureCount: 0,
    },
    {
      url: 'https://polygon-rpc.com',
      weight: 3,
      healthy: true,
      failureCount: 0,
    },
  ],
  maxFailures: 3,
  timeout: 10_000,
  fallbackDelay: 1000,
};

export const DEFAULT_OPTIMISM_RPC_CONFIG: RpcConfig = {
  endpoints: [
    {
      url: 'https://optimism.llamarpc.com',
      weight: 10,
      healthy: true,
      failureCount: 0,
    },
    {
      url: 'https://rpc.ankr.com/optimism',
      weight: 5,
      healthy: true,
      failureCount: 0,
    },
  ],
  maxFailures: 3,
  timeout: 10_000,
  fallbackDelay: 1000,
};

export const DEFAULT_ARBITRUM_RPC_CONFIG: RpcConfig = {
  endpoints: [
    {
      url: 'https://arbitrum.llamarpc.com',
      weight: 10,
      healthy: true,
      failureCount: 0,
    },
    {
      url: 'https://rpc.ankr.com/arbitrum',
      weight: 5,
      healthy: true,
      failureCount: 0,
    },
  ],
  maxFailures: 3,
  timeout: 10_000,
  fallbackDelay: 1000,
};

// ============================================================================
// RPC Config Factory
// ============================================================================

/**
 * Get RPC configuration for a specific chain
 */
export function getRpcConfig(chain: ChainType): RpcConfig {
  switch (chain) {
    case 'ethereum':
      return DEFAULT_RPC_CONFIG;
    case 'polygon':
      return DEFAULT_POLYGON_RPC_CONFIG;
    case 'optimism':
      return DEFAULT_OPTIMISM_RPC_CONFIG;
    case 'arbitrum':
      return DEFAULT_ARBITRUM_RPC_CONFIG;
    default:
      return DEFAULT_RPC_CONFIG;
  }
}

/**
 * Create a new RPC fallback manager for a chain
 */
export function createRpcFallbackManager(chain: ChainType): RpcFallbackManager {
  const config = getRpcConfig(chain);
  return new RpcFallbackManager(config);
}
