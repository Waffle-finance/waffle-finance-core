/**
 * @fileoverview Fee Estimation Services Module
 * @description Unified fee estimation with RPC fallback and gas bumping
 */

// Export interfaces
export * from './IFeeEstimatorService.js';

// Export core services
export { FeeEstimatorService, defaultFeeEstimatorService } from './FeeEstimatorService.js';
export { GasEstimator } from './GasEstimator.js';
export { RpcFallbackManager, getRpcConfig, createRpcFallbackManager } from './RpcFallbackManager.js';
export { GasBumpingStrategy, createGasBumpingStrategy, DEFAULT_BUMPING_CONFIG } from './GasBumpingStrategy.js';
export { FeeValidator, DEFAULT_VALIDATOR } from './FeeValidator.js';
