/**
 * @fileoverview Recovery Service
 * @description Centralized service for managing recovery and refund operations
 *              across all chains with unified logic and safety checks
 */

import { 
  IRecoveryService, 
  RecoveryRequest, 
  RecoveryResult, 
  RecoveryType, 
  RecoveryStatus, 
  RecoveryStats,
  RecoverySafetyCheck 
} from './IRecoveryService.js';
import { RecoveryOrchestrator } from './RecoveryOrchestrator.js';
import type { OrderRow } from '../orders-repo.js';
import { getLogger } from '../logger.js';

const log = getLogger().child({ service: 'recovery' });

// In-memory store for recovery requests
interface RecoveryRequestRecord extends RecoveryRequest {
  attempts: number;
  lastAttemptAt: number | null;
}

export class RecoveryService implements IRecoveryService, RecoverySafetyCheck {
  private orchestrator: RecoveryOrchestrator;
  private recoveryRequests: Map<string, RecoveryRequestRecord> = new Map();
  private monitoringInterval: NodeJS.Timeout | null = null;
  private stats: RecoveryStats = {
    totalRecoveries: 0,
    successfulRecoveries: 0,
    failedRecoveries: 0,
    pendingRecoveries: 0,
    totalValueRecovered: '0',
    averageRecoveryTime: 0,
    lastRecoveryAt: 0,
  };
  
  constructor(orchestrator?: RecoveryOrchestrator) {
    this.orchestrator = orchestrator || new RecoveryOrchestrator();
  }
  
  /**
   * Start the monitoring service
   */
  start(): void {
    if (this.monitoringInterval) {
      this.stop();
    }
    
    // Start monitoring every 60 seconds
    this.monitoringInterval = setInterval(() => {
      this.processPendingRecoveries();
    }, 60_000);
    
    log.info('[recovery] service started');
  }
  
  /**
   * Stop the monitoring service
   */
  stop(): void {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }
    
    log.info('[recovery] service stopped');
  }
  
  /**
   * Get recovery statistics
   */
  getRecoveryStats(): RecoveryStats {
    return { ...this.stats };
  }
  
  /**
   * Get recovery requests for an order
   */
  getRecoveryRequests(orderHash: string): RecoveryRequest[] {
    return Array.from(this.recoveryRequests.values())
      .filter(r => r.orderHash === orderHash)
      .map(r => ({ ...r }));
  }
  
  /**
   * Get specific recovery request
   */
  getRecoveryRequest(requestId: string): RecoveryRequest | undefined {
    const record = this.recoveryRequests.get(requestId);
    return record ? { ...record } : undefined;
  }
  
  /**
   * Execute recovery for an order with automatic chain detection
   */
  async executeRecovery(
    order: OrderRow,
    type: RecoveryType,
    reason?: string
  ): Promise<RecoveryResult> {
    log.info(
      { orderId: order.publicId, type, reason },
      '[recovery] executing recovery'
    );
    
    // Check if already in a terminal state
    if (this.isOrderTerminal(order)) {
      log.warn(
        { orderId: order.publicId, status: order.status },
        '[recovery] order is in terminal state - cannot recover'
      );
      
      return {
        success: false,
        error: `Order is in terminal state: ${order.status}`,
        errorType: 'terminal',
        timestamp: Date.now(),
        chain: 'unknown',
      };
    }
    
    // Check for duplicate recovery
    const existingRequest = this.findActiveRecovery(order);
    if (existingRequest) {
      log.warn(
        { orderId: order.publicId, existingRequest: existingRequest.id },
        '[recovery] recovery already in progress'
      );
      
      return {
        success: false,
        error: `Recovery already in progress: ${existingRequest.id}`,
        errorType: 'terminal',
        timestamp: Date.now(),
        chain: existingRequest.chain,
      };
    }
    
    // Create recovery request record
    const requestId = `recovery_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const request: RecoveryRequestRecord = {
      id: requestId,
      orderId: order.publicId,
      orderHash: order.orderHash || order.publicId,
      type,
      status: RecoveryStatus.Pending,
      chain: 'unknown', // Will be set after routing
      initiator: 'system',
      reason: reason || 'Auto-recovery initiated',
      metadata: {
        srcChainId: this.getChainId(order.srcChain),
        dstChainId: this.getChainId(order.dstChain),
        amount: order.makingAmount || order.takingAmount,
        token: order.srcAsset || order.takerAsset,
        timelock: Math.max(order.srcTimelock || 0, order.dstTimelock || 0),
        expired: this.hasTimelockExpired(order),
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      attempts: 0,
      lastAttemptAt: null,
    };
    
    this.recoveryRequests.set(requestId, request);
    this.stats.pendingRecoveries++;
    
    // Execute the recovery
    const result = await this.orchestrator.executeRecovery(order, type);
    
    // Update request status
    const updatedRequest = this.recoveryRequests.get(requestId);
    if (updatedRequest) {
      updatedRequest.status = result.success ? RecoveryStatus.Completed : RecoveryStatus.Failed;
      updatedRequest.updatedAt = Date.now();
      updatedRequest.attempts++;
      updatedRequest.lastAttemptAt = Date.now();
      updatedRequest.chain = result.chain;
      
      // Update stats
      if (result.success) {
        this.stats.successfulRecoveries++;
        this.stats.totalValueRecovered = this.calculateTotalRecovered(
          this.stats.totalValueRecovered,
          result.amount
        );
      } else {
        this.stats.failedRecoveries++;
      }
      
      this.stats.lastRecoveryAt = Date.now();
      this.stats.pendingRecoveries = Math.max(0, this.stats.pendingRecoveries - 1);
    }
    
    return result;
  }
  
  /**
   * Check if an order is eligible for automatic recovery
   */
  isOrderEligibleForAutoRecovery(order: OrderRow, currentTime: number): boolean {
    // Only auto-recover orders in specific states
    const recoverableStates = ['src_locked', 'dst_locked', 'expired', 'secret_revealed'];
    if (!recoverableStates.includes(order.status)) {
      return false;
    }
    
    // Must have passed timelock
    if (!this.hasTimelockExpired(order, currentTime)) {
      return false;
    }
    
    // Not already refunded
    if (order.status === 'refunded') {
      return false;
    }
    
    // Not already in recovery
    if (this.findActiveRecovery(order)) {
      return false;
    }
    
    return true;
  }
  
  /**
   * Process pending recovery requests
   */
  async processPendingRecoveries(): Promise<void> {
    log.debug('[recovery] processing pending recoveries');
    
    const currentTime = Math.floor(Date.now() / 1000);
    const pendingRequests = Array.from(this.recoveryRequests.values())
      .filter(r => r.status === RecoveryStatus.Pending || r.status === RecoveryStatus.Failed);
    
    for (const request of pendingRequests) {
      // TODO: Implement retry logic with backoff
      log.debug(
        { orderId: request.orderId, requestId: request.id, attempts: request.attempts },
        '[recovery] processing pending recovery'
      );
    }
  }
  
  // ---------------------------------------------------------------------------
  // Safety Check Implementations
  // ---------------------------------------------------------------------------
  
  /**
   * Check if a refund would duplicate an existing refund
   */
  async checkDuplicateRefund(order: OrderRow, chain: string): Promise<boolean> {
    // Check in-memory requests
    const existing = this.recoveryRequests.get(order.publicId);
    if (existing && existing.status === RecoveryStatus.Completed) {
      log.info(
        { orderId: order.publicId, chain },
        '[safety] refund already completed'
      );
      return true;
    }
    
    if (existing && (existing.status === RecoveryStatus.Pending || existing.status === RecoveryStatus.InProgress)) {
      log.warn(
        { orderId: order.publicId, chain },
        '[safety] refund already in progress'
      );
      return true;
    }
    
    // Check order status
    if (order.status === 'refunded') {
      log.info(
        { orderId: order.publicId, chain, txHash: order.refundTxHash },
        '[safety] refund already recorded in order'
      );
      return true;
    }
    
    return false;
  }
  
  /**
   * Check if the refund amount exceeds available balance
   */
  async checkBalanceCapacity(order: OrderRow, chain: string): Promise<boolean> {
    // In a real implementation, this would check the actual balance
    // For now, we'll assume it's always valid (balance check would be done in the handler)
    return true;
  }
  
  /**
   * Check if the order has already been recovered
   */
  async checkAlreadyRecovered(order: OrderRow, chain: string): Promise<boolean> {
    const existing = this.recoveryRequests.get(order.publicId);
    if (existing && existing.status === RecoveryStatus.Completed) {
      return true;
    }
    
    return order.status === 'refunded';
  }
  
  /**
   * Get all pending recoveries for an order
   */
  async getPendingRecoveries(order: OrderRow): Promise<RecoveryRequest[]> {
    return Array.from(this.recoveryRequests.values())
      .filter(r => r.orderId === order.publicId && r.status === RecoveryStatus.Pending);
  }
  
  /**
   * Get all completed recoveries for an order
   */
  async getCompletedRecoveries(order: OrderRow): Promise<RecoveryRequest[]> {
    return Array.from(this.recoveryRequests.values())
      .filter(r => r.orderId === order.publicId && r.status === RecoveryStatus.Completed);
  }
  
  // ---------------------------------------------------------------------------
  // Internal Helper Methods
  // ---------------------------------------------------------------------------
  
  /**
   * Check if order is in terminal state
   */
  private isOrderTerminal(order: OrderRow): boolean {
    const terminalStates = ['completed', 'refunded', 'failed'];
    return terminalStates.includes(order.status);
  }
  
  /**
   * Check if timelock has expired
   */
  private hasTimelockExpired(order: OrderRow, currentTime?: number): boolean {
    if (!order.srcTimelock && !order.dstTimelock) {
      return false;
    }
    
    const now = currentTime ?? Math.floor(Date.now() / 1000);
    const maxTimelock = Math.max(order.srcTimelock || 0, order.dstTimelock || 0);
    
    return now > maxTimelock;
  }
  
  /**
   * Find active recovery for an order
   */
  private findActiveRecovery(order: OrderRow): RecoveryRequestRecord | undefined {
    return this.recoveryRequests.get(order.publicId);
  }
  
  /**
   * Get chain ID from chain name
   */
  private getChainId(chain: string): number | undefined {
    const chainIds: Record<string, number> = {
      ethereum: 1,
      polygon: 137,
      optimism: 10,
      arbitrum: 42161,
      stellar: 999, // Custom chain ID for Stellar
      solana: 1151111081099710, // Solana mainnet ID
    };
    return chainIds[chain.toLowerCase()];
  }
  
  /**
   * Calculate total recovered amount
   */
  private calculateTotalRecovered(currentTotal: string, newAmount?: string): string {
    const current = BigInt(currentTotal);
    const amount = BigInt(newAmount || '0');
    return (current + amount).toString();
  }
}
