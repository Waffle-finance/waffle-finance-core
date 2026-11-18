/**
 * @fileoverview Watchdog Service Interface
 * @description Centralized interface for watchdog operations with explicit timing
 */

import type { OrderRow } from '../orders-repo.js';
import type { NormalizedWatchdogConfig } from './watchdog.js';

// ============================================================================
// Watchdog Types
// ============================================================================

export type StuckReason =
  | 'src_locked_no_dst'
  | 'src_locked_stuck'
  | 'dst_locked_no_secret'
  | 'dst_locked_stuck'
  | 'secret_revealed_not_completed'
  | 'timelock_expired_not_refunded'
  | 'unknown';

export type EscalationLevel = 'none' | 'info' | 'warning' | 'critical';

export type RecoveryType =
  | 'timeout_refund'
  | 'emergency_refund'
  | 'public_withdrawal'
  | 'force_recovery'
  | 'stuck_order_refund'
  | 'ambiguous_refund_resolution';

export interface RecoveryResult {
  success: boolean;
  txHash?: string;
  amount?: string;
  ledger?: number;
  timestamp: number;
  chain: string;
  error?: string;
  errorType?: 'transient' | 'terminal' | 'ambiguous';
}

// ============================================================================
// Escalation Notification
// ============================================================================

export interface EscalationNotification {
  orderId: string;
  level: EscalationLevel;
  reason: StuckReason;
  stuckSince: number;
  expectedSettlementWindowEnd: number;
  recoveryType: RecoveryType;
  recoveryResult: RecoveryResult;
  order: OrderRow;
}

// ============================================================================
// Watchdog Service Interface
// ============================================================================

export interface IWatchdogService {
  /**
   * Start the watchdog service
   */
  start(): void;

  /**
   * Stop the watchdog service
   */
  stop(): void;

  /**
   * Get the current configuration
   */
  getConfig(): NormalizedWatchdogConfig;

  /**
   * Process all active orders for stuck status
   */
  processActiveOrders(activeOrders: Map<string, OrderRow>): Promise<void>;

  /**
   * Check if a specific order is stuck
   */
  isOrderStuck(order: OrderRow, currentTime: number): StuckOrderStatus | null;

  /**
   * Trigger recovery for a stuck order
   */
  triggerRecovery(
    order: OrderRow,
    recoveryType: RecoveryType
  ): Promise<RecoveryResult>;

  /**
   * Notify escalation service
   */
  notifyEscalation(notification: EscalationNotification): Promise<void>;

  /**
   * Get stuck order statistics
   */
  getStats(): WatchdogStats;

  /**
   * Resolve ambiguous refund state
   */
  resolveAmbiguousRefund(order: OrderRow): Promise<RecoveryResult>;
}

// ============================================================================
// Stuck Order Status
// ============================================================================

export interface StuckOrderStatus {
  isStuck: boolean;
  reason: StuckReason;
  stuckSince: number;
  expectedSettlementWindowEnd: number;
  timePastExpectedWindow: number;
  timePastTimelock: number;
  escalationLevel: EscalationLevel;
}

// ============================================================================
// Watchdog Statistics
// ============================================================================

export interface WatchdogStats {
  totalChecks: number;
  ordersChecked: number;
  ordersStuck: number;
  ordersStuckWithEscalation: number;
  totalRefunds: number;
  successfulRefunds: number;
  failedRefunds: number;
  lastRunTimestamp: number;
  pendingOrders: number;
  maxStuckAgeMs: number;
}

// ============================================================================
// Escalation Service Interface
// ============================================================================

export interface IEscalationService {
  /**
   * Notify about an escalation
   */
  notify(notification: EscalationNotification): Promise<void>;

  /**
   * Get active escalations for an order
   */
  getActiveEscalations(orderId: string): EscalationNotification[];

  /**
   * Clear escalation for an order
   */
  clearEscalation(orderId: string): void;

  /**
   * Get all active escalations
   */
  getAllActiveEscalations(): EscalationNotification[];
}

// ============================================================================
// Backoff Manager Interface
// ============================================================================

export interface IBackoffManager {
  /**
   * Check if backoff is active for an order
   */
  isBackoffActive(orderId: string, backoffAfterMs: number): boolean;

  /**
   * Set backoff for an order
   */
  setBackoff(orderId: string, backoffAfterMs: number): void;

  /**
   * Clear backoff for an order
   */
  clearBackoff(orderId: string): void;
}

// ============================================================================
// Watchdog Order Extension
// ============================================================================

export interface WatchdogOrder extends OrderRow {
  /**
   * Timestamp of last watchdog failure
   */
  watchdogFailedAt?: number;

  /**
   * Reason for last watchdog failure
   */
  watchdogFailureReason?: string;

  /**
   * Number of watchdog retry attempts
   */
  watchdogRetryCount?: number;
}
