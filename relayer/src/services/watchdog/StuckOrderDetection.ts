/**
 * @fileoverview Stuck Order Detection Logic
 * @description Precise identification of stuck orders with timelock awareness
 */

import type { OrderRow } from '../orders-repo.js';
import type { NormalizedWatchdogConfig } from './watchdog.js';
import type { StuckReason, EscalationLevel } from './IWatchdogService.js';

// ============================================================================
// Stuck Order Detection
// ============================================================================

/**
 * Check if an order is stuck and determine the reason
 */
export function isStuckOrder(
  order: OrderRow,
  config: NormalizedWatchdogConfig,
  currentTime: number
): StuckOrderStatus | null {
  // Skip orders in terminal states
  if (isTerminalState(order.status)) {
    return null;
  }

  // Skip orders not in monitored states
  if (!isEligibleForWatchdog(order)) {
    return null;
  }

  // Calculate expected settlement window
  const maxTimelock = Math.max(
    order.srcTimelock ?? 0,
    order.dstTimelock ?? 0
  );

  // If no timelock, use default stuck threshold
  if (maxTimelock === 0) {
    return calculateStuckStatusWithoutTimelock(order, config, currentTime);
  }

  // Calculate expected settlement window end
  const expectedSettlementWindowEnd = calculateExpectedSettlementWindowEnd(
    order,
    config.timelockGraceSeconds,
    config.watchdogSafetySeconds,
    config.settlementWindowMultiplier
  );

  // Check if we've passed the expected settlement window
  if (currentTime < expectedSettlementWindowEnd) {
    return null;
  }

  // Calculate how long it's been stuck
  const stuckSince = expectedSettlementWindowEnd;
  const timePastExpectedWindow = currentTime - expectedSettlementWindowEnd;
  const timePastTimelock = currentTime - maxTimelock;

  // Determine escalation level
  const escalationLevel = getEscalationLevel(
    timePastTimelock,
    config.alertAfterTimelockSeconds,
    config.escalateAfterTimelockSeconds
  );

  return {
    isStuck: true,
    reason: determineStuckReason(order, maxTimelock),
    stuckSince,
    expectedSettlementWindowEnd,
    timePastExpectedWindow,
    timePastTimelock,
    escalationLevel,
  };
}

/**
 * Calculate stuck status for orders without timelock
 */
function calculateStuckStatusWithoutTimelock(
  order: OrderRow,
  config: NormalizedWatchdogConfig,
  currentTime: number
): StuckOrderStatus | null {
  const expectedSettlementWindowEnd = order.createdAt
    ? order.createdAt * 1000 + config.stuckAfterMs
    : currentTime - 1; // Default to stuck

  if (currentTime < expectedSettlementWindowEnd) {
    return null;
  }

  return {
    isStuck: true,
    reason: 'unknown',
    stuckSince: expectedSettlementWindowEnd,
    expectedSettlementWindowEnd,
    timePastExpectedWindow: currentTime - expectedSettlementWindowEnd,
    timePastTimelock: 0,
    escalationLevel: 'info',
  };
}

/**
 * Determine the specific reason why an order is stuck
 */
function determineStuckReason(order: OrderRow, maxTimelock: number): StuckReason {
  // Check based on order state
  switch (order.status) {
    case 'src_locked':
      if (!order.dstOrderId) {
        return 'src_locked_no_dst';
      }
      return 'src_locked_stuck';

    case 'dst_locked':
      if (!order.preimage) {
        return 'dst_locked_no_secret';
      }
      return 'dst_locked_stuck';

    case 'secret_revealed':
      return 'secret_revealed_not_completed';

    case 'expired':
      return 'timelock_expired_not_refunded';

    default:
      return 'unknown';
  }
}

/**
 * Check if an order is eligible for watchdog monitoring
 */
export function isEligibleForWatchdog(order: OrderRow): boolean {
  const eligibleStates = [
    'src_locked',
    'dst_locked',
    'secret_revealed',
    'expired',
  ];
  return eligibleStates.includes(order.status);
}

/**
 * Check if an order is in a terminal state
 */
function isTerminalState(status: string): boolean {
  const terminalStates = ['completed', 'refunded', 'failed'];
  return terminalStates.includes(status);
}

/**
 * Calculate expected settlement window end time
 */
function calculateExpectedSettlementWindowEnd(
  order: { srcTimelock?: number; dstTimelock?: number },
  graceSeconds: number,
  safetySeconds: number,
  multiplier: number
): number {
  const maxTimelock = Math.max(
    order.srcTimelock ?? 0,
    order.dstTimelock ?? 0
  );

  if (maxTimelock === 0) {
    return 0;
  }

  const totalGrace = graceSeconds * multiplier;
  return maxTimelock + totalGrace + safetySeconds;
}

/**
 * Get escalation level based on time past timelock
 */
function getEscalationLevel(
  timePastTimelockSeconds: number,
  alertThreshold: number,
  escalateThreshold: number
): EscalationLevel {
  if (timePastTimelockSeconds >= escalateThreshold) {
    return 'critical';
  }
  if (timePastTimelockSeconds >= alertThreshold) {
    return 'warning';
  }
  if (timePastTimelockSeconds >= 0) {
    return 'info';
  }
  return 'none';
}

// ============================================================================
// Types
// ============================================================================

/**
 * Status of a stuck order
 */
export interface StuckOrderStatus {
  /** True if the order is stuck */
  isStuck: boolean;
  /** Reason for being stuck */
  reason: StuckReason;
  /** Timestamp when the order became stuck */
  stuckSince: number;
  /** Expected settlement window end timestamp */
  expectedSettlementWindowEnd: number;
  /** Time past expected window in milliseconds */
  timePastExpectedWindow: number;
  /** Time past timelock in seconds */
  timePastTimelock: number;
  /** Escalation level */
  escalationLevel: EscalationLevel;
}
