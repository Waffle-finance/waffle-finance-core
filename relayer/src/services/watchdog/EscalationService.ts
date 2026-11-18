/**
 * @fileoverview Escalation Service
 * @description Manages alert escalation based on stuck order severity
 */

import type { EscalationNotification, IEscalationService, EscalationLevel } from './IWatchdogService.js';
import type { OrderRow } from '../orders-repo.js';
import { getLogger } from '../logger.js';

const log = getLogger().child({ service: 'escalation-service' });

// ============================================================================
// Escalation Service
// ============================================================================

export class EscalationService implements IEscalationService {
  private activeEscalations: Map<string, EscalationNotification> = new Map();

  /**
   * Notify about an escalation
   */
  async notify(notification: EscalationNotification): Promise<void> {
    const existing = this.activeEscalations.get(notification.orderId);

    // Update existing escalation if more severe
    if (existing && this.isLessSevere(notification.level, existing.level)) {
      log.debug(
        { orderId: notification.orderId, existing: existing.level, new: notification.level },
        '[escalation] not escalating - existing level is more severe'
      );
      return;
    }

    // Update or add escalation
    this.activeEscalations.set(notification.orderId, notification);

    // Log the escalation
    log.log(
      this.getLogLevel(notification.level),
      {
        orderId: notification.orderId,
        level: notification.level,
        reason: notification.reason,
        stuckSince: new Date(notification.stuckSince).toISOString(),
        recoveryType: notification.recoveryType,
      },
      `[escalation] ${notification.level.toUpperCase()}: Order ${notification.orderId} is stuck`
    );

    // In production, this would send to:
    // - Monitoring system (Prometheus alerts)
    // - PagerDuty/Slack for critical
    // - Email for warning
    // - Logging for info

    // Example: Send to monitoring
    // metrics.escalationNotificationsTotal.inc({
    //   level: notification.level,
    //   reason: notification.reason,
    // });
  }

  /**
   * Get active escalations for an order
   */
  getActiveEscalations(orderId: string): EscalationNotification[] {
    const notification = this.activeEscalations.get(orderId);
    return notification ? [notification] : [];
  }

  /**
   * Clear escalation for an order
   */
  clearEscalation(orderId: string): void {
    this.activeEscalations.delete(orderId);
    log.debug({ orderId }, '[escalation] cleared');
  }

  /**
   * Get all active escalations
   */
  getAllActiveEscalations(): EscalationNotification[] {
    return Array.from(this.activeEscalations.values());
  }

  /**
   * Get active escalation count
   */
  getEscalationCount(): number {
    return this.activeEscalations.size;
  }

  /**
   * Get escalation count by level
   */
  getEscalationCounts(): Record<EscalationLevel, number> {
    const counts: Record<EscalationLevel, number> = {
      none: 0,
      info: 0,
      warning: 0,
      critical: 0,
    };

    for (const notification of this.activeEscalations.values()) {
      counts[notification.level]++;
    }

    return counts;
  }

  /**
   * Check if a level is less severe than another
   */
  private isLessSevere(level1: EscalationLevel, level2: EscalationLevel): boolean {
    const severity: Record<EscalationLevel, number> = {
      none: 0,
      info: 1,
      warning: 2,
      critical: 3,
    };

    return severity[level1] < severity[level2];
  }

  /**
   * Get log level for escalation
   */
  private getLogLevel(level: EscalationLevel): 'info' | 'warn' | 'error' {
    switch (level) {
      case 'critical':
        return 'error';
      case 'warning':
        return 'warn';
      case 'info':
        return 'info';
      default:
        return 'info';
    }
  }
}

// ============================================================================
// Escalation Notification Builder
// ============================================================================

/**
 * Build an escalation notification from order and recovery results
 */
export function buildEscalationNotification(
  order: OrderRow,
  level: EscalationLevel,
  reason: string,
  stuckSince: number,
  expectedSettlementWindowEnd: number,
  recoveryType: string,
  recoveryResult: { success: boolean; txHash?: string }
): EscalationNotification {
  return {
    orderId: order.publicId,
    level,
    reason: reason as any,
    stuckSince,
    expectedSettlementWindowEnd,
    recoveryType: recoveryType as any,
    recoveryResult: {
      success: recoveryResult.success,
      txHash: recoveryResult.txHash,
      timestamp: Date.now(),
      chain: order.srcChain,
    },
    order,
  };
}
