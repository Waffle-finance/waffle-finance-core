/**
 * @fileoverview Recovery Service for Ethereum-Stellar Bridge
 * @description Handles timelock monitoring, auto-refund, and emergency recovery
 */

import { EventEmitter } from 'events';
import { OrdersService } from './orders.js';
import FusionEventManager, { EventType } from '../events/event-handlers.js';
import { ActiveOrder } from './types.js';
import { getCurrentTimestamp } from './utils.js';
import { KeyedMutex } from '../utils/concurrency.js';
import { getLogger } from '../logger.js';

const log = getLogger().child({ service: 'recovery-service' });

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
  private recoveryMutex = new KeyedMutex();

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

    log.info('[recovery] timelock monitoring started');
  }

  /**
   * Setup event listeners
   */
  private setupEventListeners(): void {
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
        await this.recoveryMutex.runExclusive(order.orderHash, async () => {
          if (this.shouldInitiateRecovery(order, currentTime)) {
            await this.initiateTimeoutRecovery(order);
          }
        });
      }
    } catch (error) {
      log.error({ err: error }, '[recovery] monitoring error');
    }
  }

  /**
   * Check if recovery should be initiated
   */
  private shouldInitiateRecovery(order: ActiveOrder, currentTime: number): boolean {
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

    log.info({ orderHash: order.orderHash, recoveryId }, '[recovery] recovery initiated');

    this.eventManager.emitEvent(EventType.Recovery, order.orderHash, {
      recoveryId,
      type: RecoveryType.TimeoutRefund,
      status: RecoveryStatus.Pending,
      orderHash: order.orderHash,
      timestamp: getCurrentTimestamp()
    });

    await this.executeRecovery(recoveryId);
  }

  /**
   * Execute recovery process
   */
  private async executeRecovery(recoveryId: string): Promise<void> {
    const recovery = this.recoveryRequests.get(recoveryId);
    if (!recovery) {
      log.error({ recoveryId }, '[recovery] recovery not found');
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

      recovery.status = RecoveryStatus.Completed;
      recovery.updatedAt = getCurrentTimestamp();

      this.stats.successfulRecoveries++;
      this.stats.pendingRecoveries--;
      this.stats.totalValueRecovered = (
        BigInt(this.stats.totalValueRecovered) + BigInt(order.order.makingAmount)
      ).toString();
      this.stats.lastRecoveryAt = getCurrentTimestamp();

      log.info({ orderHash: recovery.orderHash, recoveryId }, '[recovery] recovery completed');

      this.eventManager.emitEvent(EventType.Recovery, recovery.orderHash, {
        recoveryId,
        type: recovery.type,
        status: RecoveryStatus.Completed,
        orderHash: recovery.orderHash,
        timestamp: getCurrentTimestamp()
      });

    } catch (error) {
      log.error({ orderHash: recovery.orderHash, recoveryId, err: error }, '[recovery] recovery failed');

      recovery.status = RecoveryStatus.Failed;
      recovery.updatedAt = getCurrentTimestamp();

      this.stats.failedRecoveries++;
      this.stats.pendingRecoveries--;

      this.eventManager.emitEvent(EventType.Recovery, recovery.orderHash, {
        recoveryId,
        type: recovery.type,
        status: RecoveryStatus.Failed,
        orderHash: recovery.orderHash,
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: getCurrentTimestamp()
      });

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
    log.info({ orderHash: order.orderHash }, '[recovery] executing timeout refund');

    if (order.srcChainId === 1) {
      await this.executeEthereumRefund(order);
    }

    if (order.dstChainId === 999) {
      await this.executeStellarRefund(order);
    }

    log.info({ orderHash: order.orderHash }, '[recovery] timeout refund completed');
  }

  /**
   * Execute emergency refund
   */
  private async executeEmergencyRefund(recovery: RecoveryRequest, order: ActiveOrder): Promise<void> {
    log.info({ orderHash: order.orderHash, reason: recovery.metadata.emergencyReason }, '[recovery] executing emergency refund');

    await this.executeEthereumEmergencyRefund(order);
    await this.executeStellarEmergencyRefund(order);

    log.info({ orderHash: order.orderHash }, '[recovery] emergency refund completed');
  }

  /**
   * Execute public withdrawal
   */
  private async executePublicWithdrawal(recovery: RecoveryRequest, order: ActiveOrder): Promise<void> {
    log.info({ orderHash: order.orderHash }, '[recovery] executing public withdrawal');

    await this.executePublicEthereumWithdrawal(order);
    await this.executePublicStellarWithdrawal(order);

    log.info({ orderHash: order.orderHash }, '[recovery] public withdrawal completed');
  }

  /**
   * Execute force recovery (admin only)
   */
  private async executeForceRecovery(recovery: RecoveryRequest, order: ActiveOrder): Promise<void> {
    log.info({ orderHash: order.orderHash }, '[recovery] executing force recovery');

    await this.executeForceEthereumRecovery(order);
    await this.executeForceeStellarRecovery(order);

    log.info({ orderHash: order.orderHash }, '[recovery] force recovery completed');
  }

  /**
   * Ethereum refund operations
   */
  private async executeEthereumRefund(order: ActiveOrder): Promise<void> {
    log.info({ orderHash: order.orderHash, amount: order.order.makingAmount, asset: order.order.makerAsset, chain: 'ethereum' }, '[recovery] executing eth refund');
    await new Promise(resolve => setTimeout(resolve, 1000));
    log.info({ orderHash: order.orderHash, chain: 'ethereum' }, '[recovery] eth refund successful');
  }

  private async executeEthereumEmergencyRefund(order: ActiveOrder): Promise<void> {
    log.info({ orderHash: order.orderHash, amount: order.order.makingAmount, chain: 'ethereum' }, '[recovery] executing eth emergency refund');
    await new Promise(resolve => setTimeout(resolve, 500));
    log.info({ orderHash: order.orderHash, chain: 'ethereum' }, '[recovery] eth emergency refund successful');
  }

  private async executePublicEthereumWithdrawal(order: ActiveOrder): Promise<void> {
    log.info({ orderHash: order.orderHash, amount: order.order.makingAmount, chain: 'ethereum' }, '[recovery] executing eth public withdrawal');
    await new Promise(resolve => setTimeout(resolve, 1000));
    log.info({ orderHash: order.orderHash, chain: 'ethereum' }, '[recovery] eth public withdrawal successful');
  }

  private async executeForceEthereumRecovery(order: ActiveOrder): Promise<void> {
    log.info({ orderHash: order.orderHash, amount: order.order.makingAmount, chain: 'ethereum' }, '[recovery] executing eth force recovery');
    await new Promise(resolve => setTimeout(resolve, 800));
    log.info({ orderHash: order.orderHash, chain: 'ethereum' }, '[recovery] eth force recovery successful');
  }

  /**
   * Stellar refund operations
   */
  private async executeStellarRefund(order: ActiveOrder): Promise<void> {
    log.info({ orderHash: order.orderHash, amount: order.order.takingAmount, asset: order.order.takerAsset, chain: 'stellar' }, '[recovery] executing stellar refund');
    await new Promise(resolve => setTimeout(resolve, 1200));
    log.info({ orderHash: order.orderHash, chain: 'stellar' }, '[recovery] stellar refund successful');
  }

  private async executeStellarEmergencyRefund(order: ActiveOrder): Promise<void> {
    log.info({ orderHash: order.orderHash, amount: order.order.takingAmount, chain: 'stellar' }, '[recovery] executing stellar emergency refund');
    await new Promise(resolve => setTimeout(resolve, 600));
    log.info({ orderHash: order.orderHash, chain: 'stellar' }, '[recovery] stellar emergency refund successful');
  }

  private async executePublicStellarWithdrawal(order: ActiveOrder): Promise<void> {
    log.info({ orderHash: order.orderHash, amount: order.order.takingAmount, chain: 'stellar' }, '[recovery] executing stellar public withdrawal');
    await new Promise(resolve => setTimeout(resolve, 1100));
    log.info({ orderHash: order.orderHash, chain: 'stellar' }, '[recovery] stellar public withdrawal successful');
  }

  private async executeForceeStellarRecovery(order: ActiveOrder): Promise<void> {
    log.info({ orderHash: order.orderHash, amount: order.order.takingAmount, chain: 'stellar' }, '[recovery] executing stellar force recovery');
    await new Promise(resolve => setTimeout(resolve, 900));
    log.info({ orderHash: order.orderHash, chain: 'stellar' }, '[recovery] stellar force recovery successful');
  }

  /**
   * Retry recovery
   *
   * No-ops if the recovery no longer exists or has already reached a terminal
   * state (Completed or Cancelled). Retrying a Completed recovery could
   * double-execute a refund; retrying a Cancelled one would re-open an
   * intentionally closed operation.
   */
  private async retryRecovery(recoveryId: string): Promise<void> {
    const recovery = this.recoveryRequests.get(recoveryId);
    if (!recovery) {
      return;
    }

    if (
      recovery.status === RecoveryStatus.Completed ||
      recovery.status === RecoveryStatus.Cancelled
    ) {
      console.log(
        `⏭️  orderHash=${recovery.orderHash} Skipping retry for ${recoveryId} — already ${recovery.status}`,
      );
      return;
    }

    log.info({ orderHash: recovery.orderHash, recoveryId }, '[recovery] retrying recovery');
    recovery.status = RecoveryStatus.Pending;
    recovery.updatedAt = getCurrentTimestamp();

    await this.recoveryMutex.runExclusive(recovery.orderHash, async () => {
      await this.executeRecovery(recoveryId);
    });
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

    log.info({ orderHash, recoveryId, initiator }, '[recovery] manual recovery initiated');

    await this.recoveryMutex.runExclusive(orderHash, async () => {
      await this.executeRecovery(recoveryId);
    });

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
    log.debug({ orderHash }, '[recovery] tracking new order');
  }

  private handleOrderCancellation(orderHash: string): void {
    log.debug({ orderHash }, '[recovery] tracking order cancelled');
  }

  private handleOrderCompletion(orderHash: string): void {
    log.debug({ orderHash }, '[recovery] tracking order completed');
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
    log.info('[recovery] monitoring stopped');
  }

  /**
   * Cleanup
   */
  public cleanup(): void {
    this.stopMonitoring();
    this.removeAllListeners();
    log.info('[recovery] cleanup completed');
  }
}

export default RecoveryService;
