/**
 * @fileoverview Watchdog Configuration and Constants
 * @description Centralized configuration for watchdog behavior with explicit timing
 */

import type { ChainType } from '../recovery/IRecoveryService.js';

// ============================================================================
// Default Configuration Values
// ============================================================================

/**
 * Default scanning interval (1 minute)
 */
export const DEFAULT_INTERVAL_MS = 60_000;

/**
 * Default time before considering an order stuck (5 minutes)
 * This is the minimum time to wait after XLM receipt before triggering refund
 */
export const DEFAULT_STUCK_AFTER_MS = 5 * 60_000;

/**
 * Maximum age for an order before forcing escalation (24 hours)
 */
export const DEFAULT_MAX_STUCK_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Default timelock grace period (5 minutes)
 * Buffer for chain finality before considering order stuck
 */
export const DEFAULT_TIMELOCK_GRACE_SECONDS = 300;

/**
 * Default watchdog safety margin (2 minutes)
 * Additional buffer for watchdog scheduling and processing time
 */
export const DEFAULT_WATCHDOG_SAFETY_SECONDS = 120;

/**
 * Alert escalation threshold (1 hour after timelock)
 */
export const DEFAULT_ALERT_AFTER_TIMELOCK_SECONDS = 3600;

/**
 * Critical escalation threshold (24 hours after timelock)
 */
export const DEFAULT_ESCALATE_AFTER_TIMELOCK_SECONDS = 86400;

/**
 * Backoff period after failure (10 minutes)
 */
export const DEFAULT_BACKOFF_AFTER_MS = 10 * 60_000;

/**
 * Maximum retry attempts before escalating
 */
export const DEFAULT_MAX_RETRIES = 3;

/**
 * Delay between retries (1 minute)
 */
export const DEFAULT_RETRY_DELAY_MS = 60_000;

/**
 * Default monitored chains
 */
export const DEFAULT_MONITORED_CHAINS: ChainType[] = ['ethereum', 'stellar', 'solana'];

/**
 * Maximum transaction scan depth for ambiguous refund resolution
 */
export const DEFAULT_TX_SCAN_DEPTH = 50;

/**
 * Default expected settlement window multiplier
 * The watchdog will wait for: maxTimelock + (grace * multiplier)
 */
export const DEFAULT_SETTLEMENT_WINDOW_MULTIPLIER = 2;

// ============================================================================
// Configuration Interface
// ============================================================================

/**
 * Watchdog service configuration
 */
export interface WatchdogConfig {
  /**
   * How often to scan orders, in milliseconds
   * @default DEFAULT_INTERVAL_MS (60_000)
   */
  intervalMs?: number;

  /**
   * How long an order can sit without settlement before considering it stuck
   * @default DEFAULT_STUCK_AFTER_MS (5 minutes)
   */
  stuckAfterMs?: number;

  /**
   * Maximum age for an order before forcing escalation
   * @default DEFAULT_MAX_STUCK_AGE_MS (24 hours)
   */
  maxStuckAgeMs?: number;

  /**
   * Buffer for chain finality before considering order stuck
   * @default DEFAULT_TIMELOCK_GRACE_SECONDS (5 minutes)
   */
  timelockGraceSeconds?: number;

  /**
   * Additional buffer for watchdog scheduling and processing time
   * @default DEFAULT_WATCHDOG_SAFETY_SECONDS (2 minutes)
   */
  watchdogSafetySeconds?: number;

  /**
   * Alert escalation threshold (seconds after timelock)
   * @default DEFAULT_ALERT_AFTER_TIMELOCK_SECONDS (1 hour)
   */
  alertAfterTimelockSeconds?: number;

  /**
   * Critical escalation threshold (seconds after timelock)
   * @default DEFAULT_ESCALATE_AFTER_TIMELOCK_SECONDS (24 hours)
   */
  escalateAfterTimelockSeconds?: number;

  /**
   * Backoff period after failure
   * @default DEFAULT_BACKOFF_AFTER_MS (10 minutes)
   */
  backoffAfterMs?: number;

  /**
   * Maximum retry attempts
   * @default DEFAULT_MAX_RETRIES (3)
   */
  maxRetries?: number;

  /**
   * Delay between retries
   * @default DEFAULT_RETRY_DELAY_MS (1 minute)
   */
  retryDelayMs?: number;

  /**
   * Chains to monitor
   * @default DEFAULT_MONITORED_CHAINS
   */
  monitoredChains?: ChainType[];

  /**
   * Maximum transaction scan depth for ambiguous resolution
   * @default DEFAULT_TX_SCAN_DEPTH (50)
   */
  txScanDepth?: number;

  /**
   * Expected settlement window multiplier
   * @default DEFAULT_SETTLEMENT_WINDOW_MULTIPLIER (2)
   */
  settlementWindowMultiplier?: number;
}

/**
 * Normalized watchdog configuration with defaults applied
 */
export interface NormalizedWatchdogConfig extends WatchdogConfig {
  intervalMs: number;
  stuckAfterMs: number;
  maxStuckAgeMs: number;
  timelockGraceSeconds: number;
  watchdogSafetySeconds: number;
  alertAfterTimelockSeconds: number;
  escalateAfterTimelockSeconds: number;
  backoffAfterMs: number;
  maxRetries: number;
  retryDelayMs: number;
  monitoredChains: ChainType[];
  txScanDepth: number;
  settlementWindowMultiplier: number;
}

// ============================================================================
// Configuration Functions
// ============================================================================

/**
 * Normalize configuration with defaults
 */
export function normalizeWatchdogConfig(
  config: WatchdogConfig = {}
): NormalizedWatchdogConfig {
  return {
    intervalMs: config.intervalMs ?? DEFAULT_INTERVAL_MS,
    stuckAfterMs: config.stuckAfterMs ?? DEFAULT_STUCK_AFTER_MS,
    maxStuckAgeMs: config.maxStuckAgeMs ?? DEFAULT_MAX_STUCK_AGE_MS,
    timelockGraceSeconds: config.timelockGraceSeconds ?? DEFAULT_TIMELOCK_GRACE_SECONDS,
    watchdogSafetySeconds: config.watchdogSafetySeconds ?? DEFAULT_WATCHDOG_SAFETY_SECONDS,
    alertAfterTimelockSeconds: config.alertAfterTimelockSeconds ?? DEFAULT_ALERT_AFTER_TIMELOCK_SECONDS,
    escalateAfterTimelockSeconds: config.escalateAfterTimelockSeconds ?? DEFAULT_ESCALATE_AFTER_TIMELOCK_SECONDS,
    backoffAfterMs: config.backoffAfterMs ?? DEFAULT_BACKOFF_AFTER_MS,
    maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
    retryDelayMs: config.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
    monitoredChains: config.monitoredChains ?? DEFAULT_MONITORED_CHAINS,
    txScanDepth: config.txScanDepth ?? DEFAULT_TX_SCAN_DEPTH,
    settlementWindowMultiplier: config.settlementWindowMultiplier ?? DEFAULT_SETTLEMENT_WINDOW_MULTIPLIER,
  };
}

/**
 * Calculate expected settlement window end time
 */
export function calculateExpectedSettlementWindowEnd(
  order: {
    srcTimelock?: number;
    dstTimelock?: number;
  },
  graceSeconds: number,
  safetySeconds: number,
  multiplier: number
): number {
  const maxTimelock = Math.max(
    order.srcTimelock ?? 0,
    order.dstTimelock ?? 0
  );
  
  if (maxTimelock === 0) {
    return 0; // No timelock set
  }
  
  const totalGrace = graceSeconds * multiplier;
  return maxTimelock + totalGrace + safetySeconds;
}

/**
 * Check if an order is within the valid settlement window
 */
export function isWithinSettlementWindow(
  order: {
    srcTimelock?: number;
    dstTimelock?: number;
  },
  currentTime: number,
  config: NormalizedWatchdogConfig
): boolean {
  const expectedEnd = calculateExpectedSettlementWindowEnd(
    order,
    config.timelockGraceSeconds,
    config.watchdogSafetySeconds,
    config.settlementWindowMultiplier
  );
  
  return currentTime < expectedEnd;
}

/**
 * Get escalation level based on time past timelock
 */
export function getEscalationLevel(
  timePastTimelockSeconds: number,
  alertThreshold: number,
  escalateThreshold: number
): 'none' | 'info' | 'warning' | 'critical' {
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
