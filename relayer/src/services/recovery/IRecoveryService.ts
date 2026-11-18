/**
 * @fileoverview Recovery Service Interface for Cross-Chain Operations
 * @description Centralized interface for recovery and refund operations
 *              across Ethereum, Solana, and Stellar chains.
 */

import type { OrderRow } from '../../persistence/orders-repo.js';

// ---------------------------------------------------------------------------
// Recovery Request Types
// ---------------------------------------------------------------------------

export type RecoveryType = 
  | 'timeout_refund'
  | 'emergency_refund'
  | 'public_withdrawal'
  | 'force_recovery'
  | 'stuck_order_refund'
  | 'ambiguous_refund_resolution';

export type RecoveryStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'requires_review';

export type ChainType = 'ethereum' | 'solana' | 'stellar';

export interface RecoveryRequest {
  id: string;
  orderId: string;
  orderHash: string;
  type: RecoveryType;
  status: RecoveryStatus;
  chain: ChainType;
  initiator: string;
  reason: string;
  metadata: {
    srcChainId?: number;
    dstChainId?: number;
    amount?: string;
    token?: string;
    timelock?: number;
    expired?: boolean;
    emergencyReason?: string;
    chainSpecificData?: Record<string, unknown>;
  };
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Chain-Specific Recovery Handler Interface
// ---------------------------------------------------------------------------

export interface IRecoveryHandler {
  readonly chain: ChainType;
  
  /**
   * Check if the handler can process recovery requests for this order
   */
  canHandle(order: OrderRow): boolean;
  
  /**
   * Execute a timeout refund for an expired order
   */
  executeTimeoutRefund(order: OrderRow): Promise<RecoveryResult>;
  
  /**
   * Execute an emergency refund
   */
  executeEmergencyRefund(order: OrderRow, reason: string): Promise<RecoveryResult>;
  
  /**
   * Execute a public withdrawal
   */
  executePublicWithdrawal(order: OrderRow): Promise<RecoveryResult>;
  
  /**
   * Resolve an ambiguous refund (Stellar-specific)
   */
  resolveAmbiguousRefund(order: OrderRow): Promise<RecoveryResult>;
  
  /**
   * Check order eligibility for recovery
   */
  isEligibleForRecovery(order: OrderRow, currentTime: number): boolean;
  
  /**
   * Get recovery stats for a specific order
   */
  getOrderRecoveryStats(order: OrderRow): RecoveryStats;
  
  /**
   * Validate safety constraints before executing recovery
   */
  validateSafetyConstraints(order: OrderRow): RecoveryValidation;
}

// ---------------------------------------------------------------------------
// Recovery Result Types
// ---------------------------------------------------------------------------

export interface RecoveryResult {
  success: boolean;
  txHash?: string;
  amount?: string;
  ledger?: number;
  timestamp: number;
  chain: ChainType;
  error?: string;
  errorType?: 'transient' | 'terminal' | 'ambiguous';
}

export interface RecoveryStats {
  totalRecoveries: number;
  successfulRecoveries: number;
  failedRecoveries: number;
  pendingRecoveries: number;
  totalValueRecovered: string;
  averageRecoveryTime: number;
  lastRecoveryAt: number;
}

export interface RecoveryValidation {
  isValid: boolean;
  reasons: string[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Shared Recovery Service Interface
// ---------------------------------------------------------------------------

export interface IRecoveryService {
  /**
   * Start the monitoring service
   */
  start(): void;
  
  /**
   * Stop the monitoring service
   */
  stop(): void;
  
  /**
   * Get recovery statistics
   */
  getRecoveryStats(): RecoveryStats;
  
  /**
   * Get recovery requests for an order
   */
  getRecoveryRequests(orderHash: string): RecoveryRequest[];
  
  /**
   * Get specific recovery request
   */
  getRecoveryRequest(requestId: string): RecoveryRequest | undefined;
  
  /**
   * Execute recovery for an order
   */
  executeRecovery(
    order: OrderRow,
    type: RecoveryType,
    reason?: string
  ): Promise<RecoveryResult>;
  
  /**
   * Check if an order is eligible for automatic recovery
   */
  isOrderEligibleForAutoRecovery(order: OrderRow, currentTime: number): boolean;
  
  /**
   * Process pending recovery requests
   */
  processPendingRecoveries(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Safety Check Interfaces
// ---------------------------------------------------------------------------

export interface RecoverySafetyCheck {
  /**
   * Check if a refund would duplicate an existing refund
   */
  checkDuplicateRefund(order: OrderRow, chain: ChainType): Promise<boolean>;
  
  /**
   * Check if the refund amount exceeds available balance
   */
  checkBalanceCapacity(order: OrderRow, chain: ChainType): Promise<boolean>;
  
  /**
   * Check if the order has already been recovered
   */
  checkAlreadyRecovered(order: OrderRow, chain: ChainType): Promise<boolean>;
  
  /**
   * Get all pending recoveries for an order
   */
  getPendingRecoveries(order: OrderRow): Promise<RecoveryRequest[]>;
  
  /**
   * Get all completed recoveries for an order
   */
  getCompletedRecoveries(order: OrderRow): Promise<RecoveryRequest[]>;
}

// ---------------------------------------------------------------------------
// Recovery Orchestrator Interface
// ---------------------------------------------------------------------------

export interface IRecoveryOrchestrator {
  /**
   * Route recovery request to the appropriate handler
   */
  routeToHandler(order: OrderRow, type: RecoveryType): IRecoveryHandler | null;
  
  /**
   * Execute recovery with route-based routing
   */
  executeRecovery(order: OrderRow, type: RecoveryType): Promise<RecoveryResult>;
  
  /**
   * Execute recovery by chain
   */
  executeRecoveryByChain(
    chain: ChainType,
    order: OrderRow,
    type: RecoveryType
  ): Promise<RecoveryResult>;
  
  /**
   * Register a recovery handler
   */
  registerHandler(handler: IRecoveryHandler): void;
  
  /**
   * Get all registered handlers
   */
  getHandlers(): IRecoveryHandler[];
  
  /**
   * Get handler by chain
   */
  getHandlerByChain(chain: ChainType): IRecoveryHandler | null;
}
