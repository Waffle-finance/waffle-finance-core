/**
 * @fileoverview Recovery Orchestrator
 * @description Centralized routing and coordination for cross-chain recovery operations
 *              Ensures consistent behavior across Ethereum, Solana, and Stellar
 */

import { IRecoveryHandler, RecoveryResult, RecoveryType, ChainType, IRecoveryOrchestrator } from './IRecoveryService.js';
import type { OrderRow } from '../orders-repo.js';
import { getLogger } from '../logger.js';
import { EthereumRecoveryHandler } from './ethereum/EthereumRecoveryHandler.js';
import { StellarRecoveryHandler } from './stellar/StellarRecoveryHandler.js';

const log = getLogger().child({ orchestrator: 'recovery' });

export class RecoveryOrchestrator implements IRecoveryOrchestrator {
  private handlers: Map<ChainType, IRecoveryHandler> = new Map();
  private readonly defaultHandler: IRecoveryHandler;
  
  constructor() {
    // Register default handlers
    this.registerHandler(new EthereumRecoveryHandler());
    this.registerHandler(new StellarRecoveryHandler());
    
    // Default to Ethereum handler for unknown chains
    this.defaultHandler = this.handlers.get('ethereum') || new EthereumRecoveryHandler();
  }
  
  /**
   * Route recovery request to the appropriate handler based on order
   */
  routeToHandler(order: OrderRow, type: RecoveryType): IRecoveryHandler | null {
    // First, try to find a handler that specifically matches the order's chain
    for (const [chain, handler] of this.handlers.entries()) {
      if (handler.canHandle(order)) {
        log.debug(
          { orderId: order.publicId, chain, type },
          '[orchestrator] routing to chain-specific handler'
        );
        return handler;
      }
    }
    
    // If no chain-specific handler found, use default
    log.warn(
      { orderId: order.publicId, type },
      '[orchestrator] no chain-specific handler found, using default'
    );
    return this.defaultHandler;
  }
  
  /**
   * Execute recovery with automatic route selection
   */
  async executeRecovery(order: OrderRow, type: RecoveryType): Promise<RecoveryResult> {
    const handler = this.routeToHandler(order, type);
    
    if (!handler) {
      const error = `No recovery handler available for order ${order.publicId}`;
      log.error({ orderId: order.publicId, type }, error);
      
      return {
        success: false,
        error,
        errorType: 'terminal',
        timestamp: Date.now(),
        chain: 'unknown',
      };
    }
    
    return this.executeRecoveryByHandler(handler, order, type);
  }
  
  /**
   * Execute recovery for a specific chain
   */
  async executeRecoveryByChain(
    chain: ChainType,
    order: OrderRow,
    type: RecoveryType
  ): Promise<RecoveryResult> {
    const handler = this.handlers.get(chain);
    
    if (!handler) {
      const error = `No recovery handler found for chain: ${chain}`;
      log.error({ orderId: order.publicId, chain, type }, error);
      
      return {
        success: false,
        error,
        errorType: 'terminal',
        timestamp: Date.now(),
        chain,
      };
    }
    
    return this.executeRecoveryByHandler(handler, order, type);
  }
  
  /**
   * Execute recovery using a specific handler
   */
  private async executeRecoveryByHandler(
    handler: IRecoveryHandler,
    order: OrderRow,
    type: RecoveryType
  ): Promise<RecoveryResult> {
    log.info(
      { orderId: order.publicId, chain: handler.chain, type },
      '[orchestrator] executing recovery'
    );
    
    // Validate safety constraints before execution
    const validation = handler.validateSafetyConstraints(order);
    
    if (!validation.isValid) {
      log.error(
        { 
          orderId: order.publicId, 
          chain: handler.chain, 
          reasons: validation.reasons 
        },
        '[orchestrator] recovery validation failed - safety constraints not met'
      );
      
      return {
        success: false,
        error: validation.reasons.join('; '),
        errorType: 'terminal',
        timestamp: Date.now(),
        chain: handler.chain,
      };
    }
    
    // Log any warnings
    if (validation.warnings.length > 0) {
      log.warn(
        { 
          orderId: order.publicId, 
          chain: handler.chain, 
          warnings: validation.warnings 
        },
        '[orchestrator] recovery validation warnings'
      );
    }
    
    // Execute the recovery based on type
    let result: RecoveryResult;
    
    switch (type) {
      case 'timeout_refund':
      case 'stuck_order_refund':
        result = await handler.executeTimeoutRefund(order);
        break;
        
      case 'emergency_refund':
        // Extract emergency reason from metadata if available
        const reason = (order.metadata as Record<string, string> | undefined)?.emergencyReason || 'Emergency recovery';
        result = await handler.executeEmergencyRefund(order, reason);
        break;
        
      case 'public_withdrawal':
        result = await handler.executePublicWithdrawal(order);
        break;
        
      case 'force_recovery':
        // Force recovery uses the same logic as timeout refund but with special handling
        result = await handler.executeTimeoutRefund(order);
        break;
        
      case 'ambiguous_refund_resolution':
        result = await handler.resolveAmbiguousRefund(order);
        break;
        
      default:
        const unsupportedError = `Unsupported recovery type: ${type}`;
        log.error({ orderId: order.publicId, type }, unsupportedError);
        result = {
          success: false,
          error: unsupportedError,
          errorType: 'terminal',
          timestamp: Date.now(),
          chain: handler.chain,
        };
    }
    
    if (result.success) {
      log.info(
        { 
          orderId: order.publicId, 
          chain: handler.chain, 
          txHash: result.txHash,
          amount: result.amount 
        },
        '[orchestrator] recovery completed successfully'
      );
    } else {
      log.error(
        { 
          orderId: order.publicId, 
          chain: handler.chain, 
          error: result.error,
          errorType: result.errorType 
        },
        '[orchestrator] recovery failed'
      );
    }
    
    return result;
  }
  
  /**
   * Register a recovery handler
   */
  registerHandler(handler: IRecoveryHandler): void {
    const existing = this.handlers.get(handler.chain);
    if (existing) {
      log.warn(
        { chain: handler.chain },
        '[orchestrator] replacing existing handler for chain'
      );
    }
    
    this.handlers.set(handler.chain, handler);
    log.info({ chain: handler.chain }, '[orchestrator] handler registered');
  }
  
  /**
   * Get all registered handlers
   */
  getHandlers(): IRecoveryHandler[] {
    return Array.from(this.handlers.values());
  }
  
  /**
   * Get handler by chain
   */
  getHandlerByChain(chain: ChainType): IRecoveryHandler | null {
    return this.handlers.get(chain) || null;
  }
}
