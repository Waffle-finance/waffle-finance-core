/**
 * @fileoverview Watchdog Service
 * @description Unified watchdog with explicit timing, escalation, and recovery
 */

import type { OrderRow } from '../orders-repo.js';
import type { RecoveryService, RecoveryOrchestrator } from '../recovery/index.js';
import type { 
  IWatchdogService, 
  StuckOrderStatus, 
  WatchdogStats, 
  RecoveryResult,
  NormalizedWatchdogConfig,
  EscalationNotification,
  IEscalationService,
  IBackoffManager,
} from './IWatchdogService.js';
import { 
  normalizeWatchdogConfig, 
  calculateExpectedSettlementWindowEnd 
} from './watchdog.js';
import { isStuckOrder } from './StuckOrderDetection.js';
import { EscalationService } from './EscalationService.js';
import { getLogger } from '../logger.js';

const log = getLogger().child({ service: 'watchdog-service' });

// ============================================================================
// Watchdog Service
// ============================================================================

export class WatchdogService implements IWatchdogService {
  private config: NormalizedWatchdogConfig;
  private recoveryService: RecoveryService;
  private escalationService: IEscalationService;
  private backoffManager: Map<string, number> = new Map();
  private monitoringInterval: NodeJS.Timeout | null = null;
  private stats: WatchdogStats = {
    totalChecks: 0,
    ordersChecked: 0,
    ordersStuck: 0,
    ordersStuckWithEscalation: 0,
    totalRefunds: 0,
    successfulRefunds: 0,
    failedRefunds: 0,
    lastRunTimestamp: 0,
    pendingOrders: 0,
    maxStuckAgeMs: 0,
  };

  constructor(
    config: NormalizedWatchdogConfig,
    recoveryService?: RecoveryService,
    escalationService?: IEscalationService
  ) {
    this.config = normalizeWatchdogConfig(config);
    this.recoveryService = recoveryService || ({} as RecoveryService);
    this.escalationService = escalationService || new EscalationService();
  }

  /**
   * Start the watchdog service
   */
  start(): void {
    if (this.monitoringInterval) {
      this.stop();
    }

    this.monitoringInterval = setInterval(() => {
      this.processWatchdogTick();
    }, this.config.intervalMs);

    log.info(
      {
        intervalSecs: Math.round(this.config.intervalMs / 1000),
        stuckAfterSecs: Math.round(this.config.stuckAfterMs / 1000),
        graceSecs: this.config.timelockGraceSeconds,
        safetySecs: this.config.watchdogSafetySeconds,
      },
      '[watchdog] service started'
    );
  }

  /**
   * Stop the watchdog service
   */
  stop(): void {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }

    log.info('[watchdog] service stopped');
  }

  /**
   * Get the current configuration
   */
  getConfig(): NormalizedWatchdogConfig {
    return { ...this.config };
  }

  /**
   * Process all active orders for stuck status
   */
  async processActiveOrders(activeOrders: Map<string, OrderRow>): Promise<void> {
    const now = Date.now();
    let maxStuckAgeMs = 0;

    this.stats.ordersChecked = activeOrders.size;
    this.stats.pendingOrders = 0;

    for (const [orderId, order] of activeOrders.entries()) {
      try {
        this.stats.totalChecks++;

        // Check if order is stuck
        const stuckStatus = isStuckOrder(order, this.config, now / 1000);

        if (!stuckStatus?.isStuck) {
          continue;
        }

        // Check if backoff is active
        if (this.isBackoffActive(orderId, this.config.backoffAfterMs)) {
          log.debug(
            { orderId, reason: 'backoff_active' },
            '[watchdog] skipping due to backoff'
          );
          continue;
        }

        // Update stuck age tracking
        const stuckAge = now - stuckStatus.stuckSince;
        maxStuckAgeMs = Math.max(maxStuckAgeMs, stuckAge);
        this.stats.ordersStuck++;

        // Check for escalation
        if (stuckStatus.escalationLevel !== 'none') {
          this.stats.ordersStuckWithEscalation++;
        }

        // Determine recovery type
        const recoveryType = this.determineRecoveryType(order, stuckStatus);

        // Execute recovery
        const result = await this.triggerRecovery(order, recoveryType);

        if (result.success) {
          log.info(
            {
              orderId,
              recoveryType,
              txHash: result.txHash,
              amount: result.amount,
            },
            '[watchdog] recovery successful'
          );

          this.stats.successfulRefunds++;
          this.clearBackoff(orderId);
        } else {
          this.stats.failedRefunds++;
          this.setBackoff(orderId, this.config.backoffAfterMs);

          log.warn(
            {
              orderId,
              recoveryType,
              error: result.error,
              errorType: result.errorType,
            },
            '[watchdog] recovery failed'
          );
        }

        // Notify escalation
        if (stuckStatus.escalationLevel !== 'none') {
          const notification: EscalationNotification = {
            orderId,
            level: stuckStatus.escalationLevel,
            reason: stuckStatus.reason,
            stuckSince: stuckStatus.stuckSince,
            expectedSettlementWindowEnd: stuckStatus.expectedSettlementWindowEnd,
            recoveryType,
            recoveryResult: result,
            order,
          };

          await this.notifyEscalation(notification);
        }

        this.stats.pendingOrders++;
      } catch (error) {
        log.error(
          { orderId: order.publicId, err: error },
          '[watchdog] unexpected error processing order'
        );
      }
    }

    // Update stats
    this.stats.maxStuckAgeMs = maxStuckAgeMs;
    this.stats.lastRunTimestamp = Math.floor(now / 1000);
  }

  /**
   * Process a single watchdog tick
   */
  private async processWatchdogTick(): Promise<void> {
    // In production, this would get active orders from the relayer
    // For now, we expect orders to be passed in via processActiveOrders
    log.debug('[watchdog] tick completed');
  }

  /**
   * Check if a specific order is stuck
   */
  isOrderStuck(order: OrderRow, currentTime: number): StuckOrderStatus | null {
    return isStuckOrder(order, this.config, currentTime);
  }

  /**
   * Trigger recovery for a stuck order
   */
  async triggerRecovery(
    order: OrderRow,
    recoveryType: RecoveryType
  ): Promise<RecoveryResult> {
    try {
      const result = await this.recoveryService.executeRecovery(order, recoveryType);
      this.stats.totalRefunds++;
      return result;
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        errorType: 'terminal',
        timestamp: Date.now(),
        chain: order.srcChain,
      };
    }
  }

  /**
   * Notify escalation service
   */
  async notifyEscalation(notification: EscalationNotification): Promise<void> {
    await this.escalationService.notify(notification);
  }

  /**
   * Get stuck order statistics
   */
  getStats(): WatchdogStats {
    return { ...this.stats };
  }

  /**
   * Resolve ambiguous refund state
   */
  async resolveAmbiguousRefund(order: OrderRow): Promise<RecoveryResult> {
    return this.triggerRecovery(order, 'ambiguous_refund_resolution');
  }

  /**
   * Determine recovery type based on order state and stuck status
   */
  private determineRecoveryType(
    order: OrderRow,
    stuckStatus: StuckOrderStatus
  ): RecoveryType {
    switch (order.status) {
      case 'src_locked':
        if (order.direction === 'xlm_to_eth') {
          return 'stuck_order_refund';
        }
        return 'force_recovery';

      case 'dst_locked':
        return 'force_recovery';

      case 'secret_revealed':
        return 'force_recovery';

      case 'expired':
        return 'timeout_refund';

      default:
        return 'force_recovery';
    }
  }

  // ============================================================================
  // Backoff Management
  // ============================================================================

  private isBackoffActive(orderId: string, backoffAfterMs: number): boolean {
    const failedAt = this.backoffManager.get(orderId);
    if (!failedAt) return false;

    const elapsed = Date.now() - failedAt;
    return elapsed < backoffAfterMs;
  }

  private setBackoff(orderId: string, backoffAfterMs: number): void {
    this.backoffManager.set(orderId, Date.now());
  }

  private clearBackoff(orderId: string): void {
    this.backoffManager.delete(orderId);
  }
}

// ============================================================================
// Recovery Type Type
// ============================================================================

export type RecoveryType =
  | 'timeout_refund'
  | 'emergency_refund'
  | 'public_withdrawal'
  | 'force_recovery'
  | 'stuck_order_refund'
  | 'ambiguous_refund_resolution';
