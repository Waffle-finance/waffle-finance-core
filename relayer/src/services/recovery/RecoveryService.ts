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
  RecoveryStats,
  RecoverySafetyCheck 
} from './IRecoveryService.js';
import { RecoveryOrchestrator } from './RecoveryOrchestrator.js';
import type { RecoveryOrder as OrderRow, IRecoveryOrchestrator } from './IRecoveryService.js';
import { getLogger } from '../../logger.js';

import { calculateBackoff } from '../../utils/retry-engine.js';

const log = getLogger().child({ service: 'recovery' });

const MAX_RECOVERY_ATTEMPTS = 5;
const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_MAX_DELAY_MS = 30_000;

// In-memory store for recovery requests
interface RecoveryRequestRecord extends RecoveryRequest {
  attempts: number;
  lastAttemptAt: number | null;
  order: OrderRow;
}

export class RecoveryService implements IRecoveryService, RecoverySafetyCheck {
  private orchestrator: IRecoveryOrchestrator;
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
  
  constructor(orchestrator?: IRecoveryOrchestrator) {
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
    
    log.info({ action: 'monitor', status: 'started' }, '[recovery] service started');
  }
  
  /**
   * Stop the monitoring service
   */
  stop(): void {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }
    
    log.info({ action: 'monitor', status: 'stopped' }, '[recovery] service stopped');
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
      .map(r => this.publicRequest(r));
  }
  
  /**
   * Get specific recovery request
   */
  getRecoveryRequest(requestId: string): RecoveryRequest | undefined {
    const record = this.recoveryRequests.get(requestId);
    return record ? this.publicRequest(record) : undefined;
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
      { orderId: order.publicId, action: type, status: order.status },
      '[recovery] executing recovery'
    );
    
    // Check if already in a terminal state
    if (this.isOrderTerminal(order)) {
      log.warn(
        { orderId: order.publicId, action: type, status: order.status },
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
        { orderId: order.publicId, requestId: existingRequest.id, action: type, status: existingRequest.status, attempts: existingRequest.attempts },
        '[recovery] existing recovery request prevents duplicate submission'
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
      status: 'pending',
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
      nextAttemptAt: Date.now(),
      order,
    };
    
    this.recoveryRequests.set(requestId, request);
    this.stats.pendingRecoveries++;
    
    this.stats.totalRecoveries++;
    return this.attemptRecovery(request);
  }

  private publicRequest(record: RecoveryRequestRecord): RecoveryRequest {
    const { order: _order, ...request } = record;
    return { ...request, metadata: { ...request.metadata } };
  }

  /** One submission per tick. Retry timestamps use epoch milliseconds. */
  private async attemptRecovery(request: RecoveryRequestRecord): Promise<RecoveryResult> {
    request.status = 'in_progress';
    request.attempts++;
    request.lastAttemptAt = Date.now();
    request.nextAttemptAt = null;
    this.logRequest(request, 'attempt_started');
    let result: RecoveryResult;
    try {
      result = await this.orchestrator.executeRecovery(request.order, request.type);
    } catch {
      // Submission may have succeeded before throwing. Inspect chain state
      // rather than automatically submitting a second refund.
      result = { success: false, errorType: 'ambiguous', chain: request.chain,
        timestamp: Date.now(), error: 'Recovery threw; inspect chain state before resubmission' };
    }
    request.updatedAt = Date.now();
    request.chain = result.chain;
    if (result.success) {
      request.status = 'completed';
      this.stats.successfulRecoveries++;
      this.stats.totalValueRecovered = this.calculateTotalRecovered(this.stats.totalValueRecovered, result.amount);
    } else if (result.errorType === 'transient' && request.attempts < MAX_RECOVERY_ATTEMPTS) {
      request.status = 'pending';
      request.nextAttemptAt = Date.now() + calculateBackoff(
        request.attempts, RETRY_BASE_DELAY_MS, RETRY_MAX_DELAY_MS,
      );
    } else {
      request.status = result.errorType === 'terminal' || result.errorType === 'transient'
        ? 'failed' : 'requires_review';
      this.stats.failedRecoveries++;
    }
    this.stats.lastRecoveryAt = Date.now();
    this.stats.pendingRecoveries = Array.from(this.recoveryRequests.values())
      .filter(r => r.status === 'pending' || r.status === 'in_progress').length;
    this.logRequest(request, result.success ? 'completed' : request.nextAttemptAt !== null ? 'retry_scheduled' : 'stopped');
    return result;
  }

  private logRequest(request: RecoveryRequestRecord, event: string): void {
    log.info({ orderId: request.orderId, orderHash: request.orderHash,
      requestId: request.id, action: request.type, status: request.status,
      attempts: request.attempts, nextAttemptAt: request.nextAttemptAt, event },
    '[recovery] request status');
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
    for (const request of this.recoveryRequests.values()) {
      if ((request.status !== 'pending' && request.status !== 'failed') ||
          request.nextAttemptAt == null || request.nextAttemptAt > Date.now() ||
          request.attempts >= MAX_RECOVERY_ATTEMPTS) continue;
      if (this.isOrderTerminal(request.order)) {
        request.status = 'cancelled';
        request.nextAttemptAt = null;
        request.updatedAt = Date.now();
        this.stats.pendingRecoveries = Math.max(0, this.stats.pendingRecoveries - 1);
        this.logRequest(request, 'order_terminal');
        continue;
      }
      await this.attemptRecovery(request);
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
    const existing = this.findActiveRecovery(order);
    if (existing && existing.status === 'completed') {
      log.info(
        { orderId: order.publicId, chain, requestId: existing.id,
          action: existing.type, status: existing.status, attempts: existing.attempts },
        '[safety] refund already completed'
      );
      return true;
    }
    
    if (existing && (existing.status === 'pending' || existing.status === 'in_progress')) {
      log.warn(
        { orderId: order.publicId, chain, requestId: existing.id,
          action: existing.type, status: existing.status, attempts: existing.attempts },
        '[safety] refund already in progress'
      );
      return true;
    }
    
    // Check order status
    if (order.status === 'refunded') {
      log.info(
        { orderId: order.publicId, chain, action: 'check_duplicate_refund',
          status: order.status, txHash: order.refundTxHash },
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
    const existing = this.findActiveRecovery(order);
    if (existing && existing.status === 'completed') {
      return true;
    }
    
    return order.status === 'refunded';
  }
  
  /**
   * Get all pending recoveries for an order
   */
  async getPendingRecoveries(order: OrderRow): Promise<RecoveryRequest[]> {
    return Array.from(this.recoveryRequests.values())
      .filter(r => r.orderId === order.publicId && (r.status === 'pending' || r.status === 'in_progress'))
      .map(r => this.publicRequest(r));
  }
  
  /**
   * Get all completed recoveries for an order
   */
  async getCompletedRecoveries(order: OrderRow): Promise<RecoveryRequest[]> {
    return Array.from(this.recoveryRequests.values())
      .filter(r => r.orderId === order.publicId && r.status === 'completed')
      .map(r => this.publicRequest(r));
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
    return Array.from(this.recoveryRequests.values()).find(r => r.orderId === order.publicId);
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
