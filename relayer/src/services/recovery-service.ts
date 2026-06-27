/**
 * @fileoverview Recovery Service for Ethereum-Stellar Bridge
 * @description Handles timelock monitoring, auto-refund, and emergency recovery
 */

import { EventEmitter } from 'events';
import { OrdersService } from './orders.js';
import { ethereumListener } from './ethereum-listener.js';
import FusionEventManager, { EventType } from '../events/event-handlers.js';
import { ActiveOrder } from './types.js';
import { getCurrentTimestamp } from './utils.js';

// Recovery status types
export enum RecoveryStatus {
  Pending = 'pending',
  InProgress = 'in_progress',
  Completed = 'completed',
  Failed = 'failed',
  Cancelled = 'cancelled'
}

export enum RecoveryType {
  TimeoutRefund = 'timeout_refund',
  EmergencyRefund = 'emergency_refund',
  PublicWithdrawal = 'public_withdrawal',
  ForceRecovery = 'force_recovery'
}

// Recovery request interface
export interface RecoveryRequest {
  id: string;
  orderHash: string;
  type: RecoveryType;
  status: RecoveryStatus;
  initiator: string;
  reason: string;
  createdAt: number;
  updatedAt: number;
  metadata: {
    srcChainId?: number;
    dstChainId?: number;
    amount?: string;
    token?: string;
    timelock?: number;
    expired?: boolean;
    emergencyReason?: string;
    test?: boolean;
  };
}

// Recovery statistics
export interface RecoveryStats {
  totalRecoveries: number;
  successfulRecoveries: number;
  failedRecoveries: number;
  pendingRecoveries: number;
  totalValueRecovered: string;
  averageRecoveryTime: number;
  lastRecoveryAt: number;
}

// Recovery configuration
export interface RecoveryConfig {
  monitoringInterval: number; // ms
  autoRefundEnabled: boolean;
  emergencyEnabled: boolean;
  maxRetries: number;
  retryDelay: number;
  gracePeriod: number; // seconds after timelock
}

export class RecoveryService extends EventEmitter {
  private ordersService: OrdersService;
  private eventManager: FusionEventManager;
  private config: RecoveryConfig;
  private recoveryRequests: Map<string, RecoveryRequest> = new Map();
  private monitoringInterval: NodeJS.Timeout | null = null;
  private stats: RecoveryStats;

  constructor(
    ordersService: OrdersService,
    eventManager: FusionEventManager,
    config: RecoveryConfig
  ) {
    super();
    this.ordersService = ordersService;
    this.eventManager = eventManager;
    this.config = config;
    this.stats = {
      totalRecoveries: 0,
      successfulRecoveries: 0,
      failedRecoveries: 0,
      pendingRecoveries: 0,
      totalValueRecovered: '0',
      averageRecoveryTime: 0,
      lastRecoveryAt: 0
    };

    this.startMonitoring();
    this.setupEventListeners();
  }

  /**
   * Start timelock monitoring
   */
  private startMonitoring(): void {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
    }

    this.monitoringInterval = setInterval(() => {
      this.monitorTimelocksAndRecover();
    }, this.config.monitoringInterval);

    console.log('✅ Recovery Service: Timelock monitoring started');
  }

  /**
   * Setup event listeners
   */
  private setupEventListeners(): void {
    // Listen to order events
    this.eventManager.on('order_created', (data) => {
      this.trackNewOrder(data.orderHash);
    });

    this.eventManager.on('order_cancelled', (data) => {
      this.handleOrderCancellation(data.orderHash);
    });

    this.eventManager.on('order_filled', (data) => {
      this.handleOrderCompletion(data.orderHash);
    });
  }

  /**
   * Monitor timelocks and initiate recovery
   */
  private async monitorTimelocksAndRecover(): Promise<void> {
    try {
      const activeOrders = this.ordersService.getActiveOrders();
      const currentTime = getCurrentTimestamp();

      for (const order of activeOrders.items) {
        if (this.shouldInitiateRecovery(order, currentTime)) {
          await this.initiateTimeoutRecovery(order);
        }
      }
    } catch (error) {
      console.error('❌ Recovery monitoring error:', error);
    }
  }

  /**
   * Check if recovery should be initiated
   */
  private shouldInitiateRecovery(order: ActiveOrder, currentTime: number): boolean {
    // Check if timelock has expired
    const timelock = order.deadline;
    const gracePeriod = this.config.gracePeriod;
    
    return (
      currentTime > timelock + gracePeriod &&
      !this.isRecoveryInProgress(order.orderHash) &&
      this.config.autoRefundEnabled
    );
  }

  /**
   * Initiate timeout recovery
   */
  private async initiateTimeoutRecovery(order: ActiveOrder): Promise<void> {
    const recoveryId = `recovery_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    const recoveryRequest: RecoveryRequest = {
      id: recoveryId,
      orderHash: order.orderHash,
      type: RecoveryType.TimeoutRefund,
      status: RecoveryStatus.Pending,
      initiator: 'system',
      reason: 'Timelock expired',
      createdAt: getCurrentTimestamp(),
      updatedAt: getCurrentTimestamp(),
      metadata: {
        srcChainId: order.srcChainId,
        dstChainId: order.dstChainId,
        amount: order.order.makingAmount,
        token: order.order.makerAsset,
        timelock: order.deadline,
        expired: true
      }
    };

    this.recoveryRequests.set(recoveryId, recoveryRequest);
    this.stats.pendingRecoveries++;

    console.log(`🔄 orderHash=${order.orderHash} Recovery initiated for order ${order.orderHash} (${recoveryId})`);
    
    // Emit recovery event
    this.eventManager.emitEvent(EventType.Recovery, order.orderHash, {
      recoveryId,
      type: RecoveryType.TimeoutRefund,
      status: RecoveryStatus.Pending,
      orderHash: order.orderHash,
      timestamp: getCurrentTimestamp()
    });

    // Execute recovery
    await this.executeRecovery(recoveryId);
  }

  /**
   * Execute recovery process
   */
  private async executeRecovery(recoveryId: string): Promise<void> {
    const recovery = this.recoveryRequests.get(recoveryId);
    if (!recovery) {
      console.error(`❌ Recovery ${recoveryId} not found`);
      return;
    }

    recovery.status = RecoveryStatus.InProgress;
    recovery.updatedAt = getCurrentTimestamp();

    try {
      const order = this.ordersService.getActiveOrders().items.find(
        o => o.orderHash === recovery.orderHash
      );

      if (!order) {
        throw new Error('Order not found');
      }

      // Execute recovery based on type
      switch (recovery.type) {
        case RecoveryType.TimeoutRefund:
          await this.executeTimeoutRefund(recovery, order);
          break;
        case RecoveryType.EmergencyRefund:
          await this.executeEmergencyRefund(recovery, order);
          break;
        case RecoveryType.PublicWithdrawal:
          await this.executePublicWithdrawal(recovery, order);
          break;
        case RecoveryType.ForceRecovery:
          await this.executeForceRecovery(recovery, order);
          break;
      }

      // Mark as completed
      recovery.status = RecoveryStatus.Completed;
      recovery.updatedAt = getCurrentTimestamp();
      
      this.stats.successfulRecoveries++;
      this.stats.pendingRecoveries--;
      this.stats.totalValueRecovered = (
        BigInt(this.stats.totalValueRecovered) + BigInt(order.order.makingAmount)
      ).toString();
      this.stats.lastRecoveryAt = getCurrentTimestamp();

      console.log(`✅ orderHash=${recovery.orderHash} Recovery completed: ${recoveryId}`);
      
      // Emit success event
      this.eventManager.emitEvent(EventType.Recovery, recovery.orderHash, {
        recoveryId,
        type: recovery.type,
        status: RecoveryStatus.Completed,
        orderHash: recovery.orderHash,
        timestamp: getCurrentTimestamp()
      });

    } catch (error) {
      console.error(`❌ orderHash=${recovery.orderHash} Recovery failed: ${recoveryId}`, error);
      
      recovery.status = RecoveryStatus.Failed;
      recovery.updatedAt = getCurrentTimestamp();
      
      this.stats.failedRecoveries++;
      this.stats.pendingRecoveries--;

      // Emit failure event
      this.eventManager.emitEvent(EventType.Recovery, recovery.orderHash, {
        recoveryId,
        type: recovery.type,
        status: RecoveryStatus.Failed,
        orderHash: recovery.orderHash,
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: getCurrentTimestamp()
      });

      // Retry if configured
      if (this.config.maxRetries > 0) {
        setTimeout(() => {
          this.retryRecovery(recoveryId);
        }, this.config.retryDelay);
      }
    }
  }

  /**
   * Execute timeout refund
   */
  private async executeTimeoutRefund(recovery: RecoveryRequest, order: ActiveOrder): Promise<void> {
    console.log(`🔄 orderHash=${order.orderHash} Executing timeout refund for order ${order.orderHash}`);
    
    // 1. Ethereum refund
    if (order.srcChainId === 1) { // Ethereum
      await this.executeEthereumRefund(order);
    }

    // 2. Stellar refund
    if (order.dstChainId === 999) { // Stellar
      await this.executeStellarRefund(order);
    }

    // 3. Update order status
    // This would normally update the order in the database
    console.log(`✅ orderHash=${order.orderHash} Timeout refund completed for order ${order.orderHash}`);
  }

  /**
   * Execute emergency refund
   */
  private async executeEmergencyRefund(recovery: RecoveryRequest, order: ActiveOrder): Promise<void> {
    console.log(`🚨 orderHash=${order.orderHash} Executing emergency refund for order ${order.orderHash}`);
    console.log(`orderHash=${order.orderHash} Emergency reason: ${recovery.metadata.emergencyReason}`);
    
    // Emergency refund logic - more aggressive, bypasses normal checks
    await this.executeEthereumEmergencyRefund(order);
    await this.executeStellarEmergencyRefund(order);
    
    console.log(`✅ orderHash=${order.orderHash} Emergency refund completed for order ${order.orderHash}`);
  }

  /**
   * Execute public withdrawal
   */
  private async executePublicWithdrawal(recovery: RecoveryRequest, order: ActiveOrder): Promise<void> {
    console.log(`🔓 orderHash=${order.orderHash} Executing public withdrawal for order ${order.orderHash}`);
    
    // Public withdrawal - anyone can trigger after timelock + grace period
    await this.executePublicEthereumWithdrawal(order);
    await this.executePublicStellarWithdrawal(order);
    
    console.log(`✅ orderHash=${order.orderHash} Public withdrawal completed for order ${order.orderHash}`);
  }

  /**
   * Execute force recovery (admin only)
   */
  private async executeForceRecovery(recovery: RecoveryRequest, order: ActiveOrder): Promise<void> {
    console.log(`⚡ orderHash=${order.orderHash} Executing force recovery for order ${order.orderHash}`);
    
    // Force recovery - admin override
    await this.executeForceEthereumRecovery(order);
    await this.executeForceeStellarRecovery(order);
    
    console.log(`✅ orderHash=${order.orderHash} Force recovery completed for order ${order.orderHash}`);
  }

  /**
   * Ethereum refund operations
   */
  private async executeEthereumRefund(order: ActiveOrder): Promise<void> {
    // Mock implementation - would call actual Ethereum contract
    console.log(`🔄 orderHash=${order.orderHash} Ethereum refund: ${order.order.makingAmount} ${order.order.makerAsset}`);
    
    // Simulate contract call
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    console.log(`✅ orderHash=${order.orderHash} Ethereum refund successful`);
  }

  private async executeEthereumEmergencyRefund(order: ActiveOrder): Promise<void> {
    console.log(`🚨 orderHash=${order.orderHash} Ethereum emergency refund: ${order.order.makingAmount} ${order.order.makerAsset}`);
    await new Promise(resolve => setTimeout(resolve, 500));
    console.log(`✅ orderHash=${order.orderHash} Ethereum emergency refund successful`);
  }

  private async executePublicEthereumWithdrawal(order: ActiveOrder): Promise<void> {
    console.log(`🔓 orderHash=${order.orderHash} Ethereum public withdrawal: ${order.order.makingAmount} ${order.order.makerAsset}`);
    await new Promise(resolve => setTimeout(resolve, 1000));
    console.log(`✅ orderHash=${order.orderHash} Ethereum public withdrawal successful`);
  }

  private async executeForceEthereumRecovery(order: ActiveOrder): Promise<void> {
    console.log(`⚡ orderHash=${order.orderHash} Ethereum force recovery: ${order.order.makingAmount} ${order.order.makerAsset}`);
    await new Promise(resolve => setTimeout(resolve, 800));
    console.log(`✅ orderHash=${order.orderHash} Ethereum force recovery successful`);
  }

  /**
   * Stellar refund operations
   */
  private async executeStellarRefund(order: ActiveOrder): Promise<void> {
    console.log(`🔄 orderHash=${order.orderHash} Stellar refund: ${order.order.takingAmount} ${order.order.takerAsset}`);
    await new Promise(resolve => setTimeout(resolve, 1200));
    console.log(`✅ orderHash=${order.orderHash} Stellar refund successful`);
  }

  private async executeStellarEmergencyRefund(order: ActiveOrder): Promise<void> {
    console.log(`🚨 orderHash=${order.orderHash} Stellar emergency refund: ${order.order.takingAmount} ${order.order.takerAsset}`);
    await new Promise(resolve => setTimeout(resolve, 600));
    console.log(`✅ orderHash=${order.orderHash} Stellar emergency refund successful`);
  }

  private async executePublicStellarWithdrawal(order: ActiveOrder): Promise<void> {
    console.log(`🔓 orderHash=${order.orderHash} Stellar public withdrawal: ${order.order.takingAmount} ${order.order.takerAsset}`);
    await new Promise(resolve => setTimeout(resolve, 1100));
    console.log(`✅ orderHash=${order.orderHash} Stellar public withdrawal successful`);
  }

  private async executeForceeStellarRecovery(order: ActiveOrder): Promise<void> {
    console.log(`⚡ orderHash=${order.orderHash} Stellar force recovery: ${order.order.takingAmount} ${order.order.takerAsset}`);
    await new Promise(resolve => setTimeout(resolve, 900));
    console.log(`✅ orderHash=${order.orderHash} Stellar force recovery successful`);
  }

  /**
   * Retry recovery
   */
  private async retryRecovery(recoveryId: string): Promise<void> {
    const recovery = this.recoveryRequests.get(recoveryId);
    if (!recovery || recovery.status === RecoveryStatus.Completed) {
      return;
    }

    console.log(`🔄 orderHash=${recovery.orderHash} Retrying recovery: ${recoveryId}`);
    recovery.status = RecoveryStatus.Pending;
    recovery.updatedAt = getCurrentTimestamp();

    await this.executeRecovery(recoveryId);
  }

  /**
   * Manual recovery initiation
   */
  public async initiateManualRecovery(
    orderHash: string,
    type: RecoveryType,
    initiator: string,
    reason: string,
    metadata: Partial<RecoveryRequest['metadata']> = {}
  ): Promise<string> {
    const recoveryId = `manual_recovery_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    const recoveryRequest: RecoveryRequest = {
      id: recoveryId,
      orderHash,
      type,
      status: RecoveryStatus.Pending,
      initiator,
      reason,
      createdAt: getCurrentTimestamp(),
      updatedAt: getCurrentTimestamp(),
      metadata
    };

    this.recoveryRequests.set(recoveryId, recoveryRequest);
    this.stats.pendingRecoveries++;

    console.log(`🔄 orderHash=${orderHash} Manual recovery initiated: ${recoveryId} by ${initiator}`);
    
    // Execute recovery
    await this.executeRecovery(recoveryId);
    
    return recoveryId;
  }

  /**
   * Emergency recovery
   */
  public async emergencyRecovery(
    orderHash: string,
    reason: string,
    initiator: string
  ): Promise<string> {
    return this.initiateManualRecovery(
      orderHash,
      RecoveryType.EmergencyRefund,
      initiator,
      reason,
      { emergencyReason: reason }
    );
  }

  /**
   * Utility methods
   */
  private isRecoveryInProgress(orderHash: string): boolean {
    return Array.from(this.recoveryRequests.values()).some(
      recovery => recovery.orderHash === orderHash && 
      recovery.status === RecoveryStatus.InProgress
    );
  }

  private trackNewOrder(orderHash: string): void {
    console.log(`📊 orderHash=${orderHash} Recovery tracking: New order ${orderHash}`);
  }

  private handleOrderCancellation(orderHash: string): void {
    console.log(`📊 orderHash=${orderHash} Recovery tracking: Order cancelled ${orderHash}`);
  }

  private handleOrderCompletion(orderHash: string): void {
    console.log(`📊 orderHash=${orderHash} Recovery tracking: Order completed ${orderHash}`);
  }

  /**
   * Get recovery statistics
   */
  public getRecoveryStats(): RecoveryStats {
    return { ...this.stats };
  }

  /**
   * Get recovery requests
   */
  public getRecoveryRequests(): RecoveryRequest[] {
    return Array.from(this.recoveryRequests.values());
  }

  /**
   * Get specific recovery request
   */
  public getRecoveryRequest(recoveryId: string): RecoveryRequest | undefined {
    return this.recoveryRequests.get(recoveryId);
  }

  /**
   * Stop monitoring
   */
  public stopMonitoring(): void {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }
    console.log('🛑 Recovery Service: Monitoring stopped');
  }

  /**
   * Cleanup
   */
  public cleanup(): void {
    this.stopMonitoring();
    this.removeAllListeners();
    console.log('🧹 Recovery Service: Cleanup completed');
  }
}

export default RecoveryService; 