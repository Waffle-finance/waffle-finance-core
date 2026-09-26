/**
 * @fileoverview Recovery Service for Ethereum-Stellar Bridge
 * @description Handles timelock monitoring, auto-refund, and emergency recovery
 * Provides standardized cross-chain recovery messages and structured logs for operators.
 */

import { EventEmitter } from 'events';
import FusionEventManager, { EventType } from '../events/event-handlers.js';
import { getCurrentTimestamp } from './utils.js';
import { KeyedMutex } from '../utils/concurrency.js';
import { getLogger } from '../logger.js';

const log = getLogger().child({ service: 'recovery-service' });

export interface ActiveOrder {
  orderId?: string;
  orderHash: string;
  srcChainId?: number;
  dstChainId?: number;
  order: {
    makingAmount: string;
    makerAsset: string;
    takingAmount?: string;
    takerAsset?: string;
  };
  deadline: number;
  status?: string;
  [key: string]: unknown;
}

export interface OrdersService {
  getActiveOrders(): { items: ActiveOrder[] };
  [key: string]: unknown;
}

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

export enum RecoveryStage {
  Initiated = 'initiated',
  InProgress = 'in_progress',
  ChainActionStarted = 'chain_action_started',
  ChainActionCompleted = 'chain_action_completed',
  ChainActionFailed = 'chain_action_failed',
  Completed = 'completed',
  Failed = 'failed',
  Retrying = 'retrying',
  Skipped = 'skipped'
}

export interface RecoveryTimeWindow {
  timelock: number;
  gracePeriod: number;
  expiresAt: number;
  currentTime: number;
  secondsPastDeadline: number;
  elapsedMs?: number;
}

export interface StructuredRecoveryMessage {
  recoveryId: string;
  orderId: string;
  orderHash: string;
  stage: RecoveryStage;
  action: RecoveryType;
  chain?: 'ethereum' | 'stellar' | 'multi_chain';
  chainAction?: string;
  srcChainId?: number;
  dstChainId?: number;
  mutation: 'refund' | 'recovery';
  fromStatus?: string | null;
  toStatus?: string;
  initiator?: string;
  reason?: string;
  timeWindow?: RecoveryTimeWindow;
  durationMs?: number;
  amount?: string;
  asset?: string;
  txHash?: string;
  error?: string;
  diagnostics?: string;
  metadata?: Record<string, unknown>;
}

export interface RecoveryRequest {
  id: string;
  orderHash: string;
  orderId?: string;
  type: RecoveryType;
  status: RecoveryStatus;
  stage?: RecoveryStage;
  chain?: 'ethereum' | 'stellar' | 'multi_chain';
  chainAction?: string;
  mutation?: 'refund' | 'recovery';
  fromStatus?: string | null;
  toStatus?: string;
  initiator: string;
  reason: string;
  createdAt: number;
  updatedAt: number;
  durationMs?: number;
  timeWindow?: RecoveryTimeWindow;
  diagnostics?: string;
  metadata: {
    srcChainId?: number;
    dstChainId?: number;
    amount?: string;
    token?: string;
    timelock?: number;
    expired?: boolean;
    emergencyReason?: string;
    test?: boolean;
    orderId?: string;
    chainAction?: string;
    stage?: RecoveryStage;
    timeWindow?: RecoveryTimeWindow;
    mutation?: 'refund' | 'recovery';
    durationMs?: number;
    diagnostics?: string;
    [key: string]: unknown;
  };
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

export interface RecoveryConfig {
  monitoringInterval: number; // ms
  autoRefundEnabled: boolean;
  emergencyEnabled: boolean;
  maxRetries: number;
  retryDelay: number;
  gracePeriod: number; // seconds after timelock
}

/**
 * Cleanly diagnoses cross-chain RPC failures (Stellar Horizon and Ethereum)
 * avoiding large blocks of raw RPC responses and base64 XDR outputs.
 */
export function diagnoseRecoveryError(err: unknown, chain?: 'ethereum' | 'stellar'): string {
  if (!err) return 'Unknown error occurred during recovery';

  const errorObj = err as Record<string, any>;
  const horizonData = errorObj?.response?.data;
  const resultCodes =
    horizonData?.extras?.result_codes ||
    errorObj?.extras?.result_codes ||
    errorObj?.resultCodes ||
    errorObj?.result_codes;

  // Stellar Horizon error classification
  if (resultCodes) {
    const txCode = resultCodes.transaction;
    const opCodes = Array.isArray(resultCodes.operations) ? resultCodes.operations.join(', ') : '';
    let explanation = `Stellar transaction failed: transaction=${txCode}`;
    if (opCodes) {
      explanation += `, operations=[${opCodes}]`;
    }
    if (txCode === 'tx_bad_seq') {
      explanation += ' (Sequence out of sync. Source account sequence must be reloaded)';
    } else if (txCode === 'tx_insufficient_fee') {
      explanation += ' (Fee surge. Provided fee below ledger threshold)';
    } else if (txCode === 'tx_insufficient_balance') {
      explanation += ' (Fee would bring source account below minimum reserve balance)';
    } else if (txCode === 'tx_no_source_account') {
      explanation += ' (Relayer Stellar source account does not exist or has not been funded)';
    } else if (txCode === 'tx_too_early') {
      explanation += ' (Submitted before transaction valid time window)';
    } else if (txCode === 'tx_too_late') {
      explanation += ' (Transaction expired past maxTime window)';
    } else if (txCode === 'tx_bad_auth' || txCode === 'tx_bad_auth_extra') {
      explanation += ' (Invalid signature or unauthorized signer)';
    } else if (opCodes.includes('op_underfunded')) {
      explanation += ' (Source account has insufficient balance for refund and reserve)';
    } else if (opCodes.includes('op_no_destination')) {
      explanation += ' (Destination Stellar account does not exist)';
    } else if (opCodes.includes('op_no_trust')) {
      explanation += ' (Destination account lacks trustline for asset)';
    } else if (opCodes.includes('op_does_not_exist')) {
      explanation += ' (Claimable balance or contract entry does not exist or already claimed)';
    }
    return explanation;
  }

  // Horizon gateway timeout or timeout error instance
  const status = errorObj?.response?.status;
  if (status === 504 || status === 408 || errorObj?.isTimeout || errorObj?.name === 'HorizonTimeoutError') {
    return 'Horizon gateway timeout (504/408). Transaction may have landed on ledger; check status before retrying';
  }
  if (status === 429) {
    return 'Horizon rate limit reached. Backoff required before retry';
  }
  if (errorObj?.isUnknownAmount || errorObj?.name === 'RefundAmountUnknownError') {
    return 'Original payment amount could not be determined from on-chain lookup. Recovery deferred to next tick to prevent inaccurate refund';
  }
  if (horizonData?.title || horizonData?.detail) {
    const parts = [horizonData.title, horizonData.detail].filter(Boolean);
    return `Stellar Horizon error: ${parts.join(' - ')}`;
  }

  const code = errorObj?.code || errorObj?.error?.code;
  const message = errorObj?.message ? String(errorObj.message) : String(err);

  // Stellar Soroban RPC error classification
  const sorobanStatus = errorObj?.status;
  if (sorobanStatus === 'TRY_AGAIN_LATER' || message.includes('TRY_AGAIN_LATER')) {
    return 'Soroban RPC node overloaded (TRY_AGAIN_LATER). Backoff required before retry';
  }
  if (sorobanStatus === 'DUPLICATE' || message.includes('DUPLICATE')) {
    return 'Soroban transaction duplicate submission detected (transaction already submitted or in ledger)';
  }
  if (sorobanStatus === 'ERROR' || errorObj?.errorResultXdr || message.includes('errorResultXdr')) {
    return 'Soroban contract transaction rejected (ERROR). Pre-flight simulation or validation failed';
  }
  if (sorobanStatus === 'FAILED' && chain === 'stellar') {
    return 'Soroban transaction failed during ledger execution';
  }
  if (sorobanStatus === 'NOT_FOUND' && chain === 'stellar') {
    return 'Soroban transaction not found in ledger or recent transaction history';
  }

  // Ethereum RPC error classification
  if (code === 'NONCE_EXPIRED' || message.includes('nonce too low') || message.includes('replacement transaction underpriced')) {
    return 'Ethereum nonce conflict or underpriced replacement. Resync relayer nonce';
  }
  if (code === 'INSUFFICIENT_FUNDS' || message.includes('insufficient funds')) {
    return 'Ethereum relayer wallet has insufficient ETH to cover gas';
  }
  if (code === 'TRANSACTION_REPLACED') {
    return 'Ethereum transaction was replaced or repriced in mempool';
  }
  if (code === 'UNPREDICTABLE_GAS_LIMIT') {
    return 'Ethereum execution would revert during gas estimation (precondition check failed)';
  }
  if (message.includes('execution reverted') || errorObj?.reason) {
    const reason = errorObj?.reason || 'execution reverted';
    return `Ethereum transaction reverted by contract: ${reason}`;
  }
  if (code === 'TIMEOUT' || message.includes('ETIMEDOUT') || message.includes('timed out')) {
    return 'Ethereum RPC provider timeout. Connection stalled or RPC node degraded';
  }

  // General sanitized summary without raw base64 XDR or massive hex payloads
  let cleanMsg = errorObj instanceof Error ? errorObj.message : String(err);
  cleanMsg = cleanMsg.replace(/0x[a-fA-F0-9]{64,}/g, '[hex data suppressed]');
  cleanMsg = cleanMsg.replace(/[A-Za-z0-9+/=]{80,}/g, '[raw data suppressed]');
  return cleanMsg.length > 250 ? `${cleanMsg.slice(0, 247)}...` : cleanMsg;
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
   * Helper to format and log structured recovery messages for operators.
   */
  private logRecovery(
    level: 'info' | 'warn' | 'error' | 'debug',
    payload: StructuredRecoveryMessage,
    logDescription: string
  ): void {
    const logData: Record<string, unknown> = {
      recoveryId: payload.recoveryId,
      orderId: payload.orderId,
      orderHash: payload.orderHash,
      stage: payload.stage,
      action: payload.action,
      chain: payload.chain,
      chainAction: payload.chainAction,
      mutation: payload.mutation,
      fromStatus: payload.fromStatus,
      toStatus: payload.toStatus,
      srcChainId: payload.srcChainId,
      dstChainId: payload.dstChainId,
      initiator: payload.initiator,
      reason: payload.reason,
      timeWindow: payload.timeWindow,
      durationMs: payload.durationMs,
      amount: payload.amount,
      asset: payload.asset,
      txHash: payload.txHash,
      error: payload.error,
      diagnostics: payload.diagnostics
    };

    // Remove undefined values to keep log lines clean and concise
    for (const key of Object.keys(logData)) {
      if (logData[key] === undefined) {
        delete logData[key];
      }
    }

    log[level](logData, `[recovery] ${logDescription}`);
  }

  /**
   * Helper to emit structured recovery events to listeners.
   */
  private emitRecoveryEvent(
    stage: RecoveryStage,
    recovery: RecoveryRequest,
    extra: Partial<StructuredRecoveryMessage> = {}
  ): void {
    const orderId = recovery.orderId ?? recovery.orderHash;
    const structuredMessage: StructuredRecoveryMessage = {
      recoveryId: recovery.id,
      orderId,
      orderHash: recovery.orderHash,
      stage,
      action: recovery.type,
      chain: recovery.chain,
      chainAction: recovery.chainAction,
      srcChainId: recovery.metadata.srcChainId,
      dstChainId: recovery.metadata.dstChainId,
      mutation: recovery.mutation ?? 'refund',
      fromStatus: extra.fromStatus ?? recovery.fromStatus ?? null,
      toStatus: extra.toStatus ?? recovery.toStatus ?? recovery.status,
      initiator: recovery.initiator,
      reason: recovery.reason,
      timeWindow: extra.timeWindow ?? recovery.timeWindow,
      durationMs: extra.durationMs ?? recovery.durationMs,
      error: extra.error,
      diagnostics: extra.diagnostics ?? recovery.diagnostics,
      metadata: recovery.metadata
    };

    const eventMetadata = {
      recoveryId: recovery.id,
      orderHash: recovery.orderHash,
      orderId,
      stage,
      chainAction: recovery.chainAction,
      type: recovery.type,
      status: recovery.status,
      recoveryType: recovery.type,
      recoveryStatus: recovery.status,
      error: extra.error,
      timestamp: getCurrentTimestamp()
    };

    this.eventManager.emitEvent(EventType.Recovery, structuredMessage, eventMetadata as any);
  }

  /**
   * Resolve an order ID from order or fallback to orderHash.
   */
  private resolveOrderId(order?: ActiveOrder, fallbackHash?: string): string {
    return order?.orderId ?? fallbackHash ?? 'unknown';
  }

  /**
   * Find an active order by its hash.
   */
  private findOrder(orderHash: string): ActiveOrder | undefined {
    return this.ordersService.getActiveOrders()?.items?.find(o => o.orderHash === orderHash);
  }

  /**
   * Construct standard time window metadata for an order.
   */
  private buildTimeWindow(order: ActiveOrder, currentTime: number = getCurrentTimestamp()): RecoveryTimeWindow {
    const timelock = order.deadline;
    const gracePeriod = this.config.gracePeriod;
    const expiresAt = timelock + gracePeriod;
    return {
      timelock,
      gracePeriod,
      expiresAt,
      currentTime,
      secondsPastDeadline: currentTime - timelock
    };
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

    log.info({ stage: RecoveryStage.Initiated, intervalMs: this.config.monitoringInterval }, '[recovery] timelock monitoring started');
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
      const diagnostics = diagnoseRecoveryError(error);
      log.error({ stage: RecoveryStage.Failed, err: error, diagnostics }, '[recovery] monitoring error');
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
   * Initiate timeout recovery with structured logging and coordinator status alignment.
   */
  private async initiateTimeoutRecovery(order: ActiveOrder): Promise<void> {
    const recoveryId = `recovery_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const currentTime = getCurrentTimestamp();
    const orderId = this.resolveOrderId(order, order.orderHash);
    const timeWindow = this.buildTimeWindow(order, currentTime);

    const recoveryRequest: RecoveryRequest = {
      id: recoveryId,
      orderHash: order.orderHash,
      orderId,
      type: RecoveryType.TimeoutRefund,
      status: RecoveryStatus.Pending,
      stage: RecoveryStage.Initiated,
      chain: 'multi_chain',
      chainAction: 'timeout_refund',
      mutation: 'refund',
      fromStatus: order.status ?? 'expired',
      toStatus: RecoveryStatus.Pending,
      initiator: 'system',
      reason: 'Timelock expired',
      createdAt: currentTime,
      updatedAt: currentTime,
      timeWindow,
      metadata: {
        srcChainId: order.srcChainId,
        dstChainId: order.dstChainId,
        amount: order.order.makingAmount,
        token: order.order.makerAsset,
        timelock: order.deadline,
        expired: true,
        orderId,
        chainAction: 'timeout_refund',
        stage: RecoveryStage.Initiated,
        mutation: 'refund',
        timeWindow
      }
    };

    this.recoveryRequests.set(recoveryId, recoveryRequest);
    this.stats.pendingRecoveries++;

    this.logRecovery('info', {
      recoveryId,
      orderId,
      orderHash: order.orderHash,
      stage: RecoveryStage.Initiated,
      action: RecoveryType.TimeoutRefund,
      srcChainId: order.srcChainId,
      dstChainId: order.dstChainId,
      mutation: 'refund',
      fromStatus: order.status ?? 'expired',
      toStatus: RecoveryStatus.Pending,
      initiator: 'system',
      reason: 'Timelock expired',
      timeWindow,
      amount: order.order.makingAmount,
      asset: order.order.makerAsset
    }, 'recovery initiated');

    this.emitRecoveryEvent(RecoveryStage.Initiated, recoveryRequest, {
      fromStatus: order.status ?? 'expired',
      toStatus: RecoveryStatus.Pending,
      timeWindow
    });

    await this.executeRecovery(recoveryId);
  }

  /**
   * Execute recovery process with clear stage transitions and diagnostic capturing.
   */
  private async executeRecovery(recoveryId: string): Promise<void> {
    const recovery = this.recoveryRequests.get(recoveryId);
    if (!recovery) {
      this.logRecovery('error', {
        recoveryId,
        orderId: recoveryId,
        orderHash: 'unknown',
        stage: RecoveryStage.Failed,
        action: RecoveryType.TimeoutRefund,
        mutation: 'refund',
        error: 'Recovery request not found',
        diagnostics: 'Recovery request ID is missing from active memory store'
      }, 'recovery not found');
      return;
    }

    const startTime = Date.now();
    recovery.status = RecoveryStatus.InProgress;
    recovery.stage = RecoveryStage.InProgress;
    recovery.toStatus = RecoveryStatus.InProgress;
    recovery.updatedAt = getCurrentTimestamp();

    const orderId = recovery.orderId ?? recovery.orderHash;

    this.logRecovery('info', {
      recoveryId,
      orderId,
      orderHash: recovery.orderHash,
      stage: RecoveryStage.InProgress,
      action: recovery.type,
      chain: recovery.chain,
      chainAction: recovery.chainAction,
      srcChainId: recovery.metadata.srcChainId,
      dstChainId: recovery.metadata.dstChainId,
      mutation: recovery.mutation ?? 'refund',
      fromStatus: recovery.fromStatus ?? RecoveryStatus.Pending,
      toStatus: RecoveryStatus.InProgress,
      initiator: recovery.initiator,
      reason: recovery.reason,
      timeWindow: recovery.timeWindow
    }, 'recovery execution started');

    this.emitRecoveryEvent(RecoveryStage.InProgress, recovery, {
      fromStatus: recovery.fromStatus ?? RecoveryStatus.Pending,
      toStatus: RecoveryStatus.InProgress
    });

    try {
      const order = this.findOrder(recovery.orderHash);
      if (!order) {
        throw new Error(`Order ${recovery.orderHash} not found in active order registry`);
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

      const durationMs = Date.now() - startTime;
      recovery.status = RecoveryStatus.Completed;
      recovery.stage = RecoveryStage.Completed;
      recovery.toStatus = 'refunded';
      recovery.durationMs = durationMs;
      recovery.updatedAt = getCurrentTimestamp();

      this.stats.successfulRecoveries++;
      this.stats.pendingRecoveries--;
      this.stats.totalValueRecovered = (
        BigInt(this.stats.totalValueRecovered) + BigInt(order.order.makingAmount)
      ).toString();
      this.stats.lastRecoveryAt = getCurrentTimestamp();

      this.logRecovery('info', {
        recoveryId,
        orderId,
        orderHash: recovery.orderHash,
        stage: RecoveryStage.Completed,
        action: recovery.type,
        chain: recovery.chain,
        chainAction: recovery.chainAction,
        srcChainId: recovery.metadata.srcChainId,
        dstChainId: recovery.metadata.dstChainId,
        mutation: recovery.mutation ?? 'refund',
        fromStatus: RecoveryStatus.InProgress,
        toStatus: 'refunded',
        initiator: recovery.initiator,
        reason: recovery.reason,
        timeWindow: recovery.timeWindow,
        durationMs,
        amount: order.order.makingAmount,
        asset: order.order.makerAsset
      }, 'recovery completed');

      this.emitRecoveryEvent(RecoveryStage.Completed, recovery, {
        fromStatus: RecoveryStatus.InProgress,
        toStatus: 'refunded',
        durationMs
      });

    } catch (error) {
      const durationMs = Date.now() - startTime;
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      const diagnostics = diagnoseRecoveryError(error, recovery.chain === 'stellar' ? 'stellar' : 'ethereum');

      recovery.status = RecoveryStatus.Failed;
      recovery.stage = RecoveryStage.Failed;
      recovery.toStatus = RecoveryStatus.Failed;
      recovery.durationMs = durationMs;
      recovery.diagnostics = diagnostics;
      recovery.updatedAt = getCurrentTimestamp();

      this.stats.failedRecoveries++;
      this.stats.pendingRecoveries--;

      this.logRecovery('error', {
        recoveryId,
        orderId,
        orderHash: recovery.orderHash,
        stage: RecoveryStage.Failed,
        action: recovery.type,
        chain: recovery.chain,
        chainAction: recovery.chainAction,
        srcChainId: recovery.metadata.srcChainId,
        dstChainId: recovery.metadata.dstChainId,
        mutation: recovery.mutation ?? 'refund',
        fromStatus: RecoveryStatus.InProgress,
        toStatus: RecoveryStatus.Failed,
        initiator: recovery.initiator,
        reason: recovery.reason,
        timeWindow: recovery.timeWindow,
        durationMs,
        error: errorMsg,
        diagnostics
      }, 'recovery failed');

      this.emitRecoveryEvent(RecoveryStage.Failed, recovery, {
        fromStatus: RecoveryStatus.InProgress,
        toStatus: RecoveryStatus.Failed,
        durationMs,
        error: errorMsg,
        diagnostics
      });

      if (this.config.maxRetries > 0) {
        setTimeout(() => {
          this.retryRecovery(recoveryId);
        }, this.config.retryDelay);
      }
    }
  }

  /**
   * Execute timeout refund across relevant chains
   */
  private async executeTimeoutRefund(recovery: RecoveryRequest, order: ActiveOrder): Promise<void> {
    const orderId = recovery.orderId ?? order.orderId ?? order.orderHash;

    this.logRecovery('info', {
      recoveryId: recovery.id,
      orderId,
      orderHash: order.orderHash,
      stage: RecoveryStage.InProgress,
      action: RecoveryType.TimeoutRefund,
      chainAction: 'cross_chain_timeout_refund',
      mutation: 'refund',
      timeWindow: recovery.timeWindow
    }, 'executing timeout refund');

    if (order.srcChainId === 1) {
      await this.executeEthereumRefund(order, recovery);
    }

    if (order.dstChainId === 999) {
      await this.executeStellarRefund(order, recovery);
    }

    this.logRecovery('info', {
      recoveryId: recovery.id,
      orderId,
      orderHash: order.orderHash,
      stage: RecoveryStage.InProgress,
      action: RecoveryType.TimeoutRefund,
      chainAction: 'cross_chain_timeout_refund',
      mutation: 'refund'
    }, 'timeout refund completed');
  }

  /**
   * Execute emergency refund
   */
  private async executeEmergencyRefund(recovery: RecoveryRequest, order: ActiveOrder): Promise<void> {
    const orderId = recovery.orderId ?? order.orderId ?? order.orderHash;

    this.logRecovery('info', {
      recoveryId: recovery.id,
      orderId,
      orderHash: order.orderHash,
      stage: RecoveryStage.InProgress,
      action: RecoveryType.EmergencyRefund,
      chainAction: 'cross_chain_emergency_refund',
      mutation: 'refund',
      reason: recovery.metadata.emergencyReason
    }, 'executing emergency refund');

    await this.executeEthereumEmergencyRefund(order, recovery);
    await this.executeStellarEmergencyRefund(order, recovery);

    this.logRecovery('info', {
      recoveryId: recovery.id,
      orderId,
      orderHash: order.orderHash,
      stage: RecoveryStage.InProgress,
      action: RecoveryType.EmergencyRefund,
      chainAction: 'cross_chain_emergency_refund',
      mutation: 'refund'
    }, 'emergency refund completed');
  }

  /**
   * Execute public withdrawal
   */
  private async executePublicWithdrawal(recovery: RecoveryRequest, order: ActiveOrder): Promise<void> {
    const orderId = recovery.orderId ?? order.orderId ?? order.orderHash;

    this.logRecovery('info', {
      recoveryId: recovery.id,
      orderId,
      orderHash: order.orderHash,
      stage: RecoveryStage.InProgress,
      action: RecoveryType.PublicWithdrawal,
      chainAction: 'cross_chain_public_withdrawal',
      mutation: 'refund'
    }, 'executing public withdrawal');

    await this.executePublicEthereumWithdrawal(order, recovery);
    await this.executePublicStellarWithdrawal(order, recovery);

    this.logRecovery('info', {
      recoveryId: recovery.id,
      orderId,
      orderHash: order.orderHash,
      stage: RecoveryStage.InProgress,
      action: RecoveryType.PublicWithdrawal,
      chainAction: 'cross_chain_public_withdrawal',
      mutation: 'refund'
    }, 'public withdrawal completed');
  }

  /**
   * Execute force recovery (admin only)
   */
  private async executeForceRecovery(recovery: RecoveryRequest, order: ActiveOrder): Promise<void> {
    const orderId = recovery.orderId ?? order.orderId ?? order.orderHash;

    this.logRecovery('info', {
      recoveryId: recovery.id,
      orderId,
      orderHash: order.orderHash,
      stage: RecoveryStage.InProgress,
      action: RecoveryType.ForceRecovery,
      chainAction: 'cross_chain_force_recovery',
      mutation: 'refund'
    }, 'executing force recovery');

    await this.executeForceEthereumRecovery(order, recovery);
    await this.executeForceeStellarRecovery(order, recovery);

    this.logRecovery('info', {
      recoveryId: recovery.id,
      orderId,
      orderHash: order.orderHash,
      stage: RecoveryStage.InProgress,
      action: RecoveryType.ForceRecovery,
      chainAction: 'cross_chain_force_recovery',
      mutation: 'refund'
    }, 'force recovery completed');
  }

  /**
   * Helper to execute and log chain-specific recovery action with started/completed stages.
   */
  private async runChainAction(
    chain: 'ethereum' | 'stellar',
    chainAction: string,
    actionType: RecoveryType,
    order: ActiveOrder,
    recovery: RecoveryRequest | undefined,
    delayMs: number
  ): Promise<void> {
    const actionStartTime = Date.now();
    const orderId = this.resolveOrderId(order, order.orderHash);
    const recoveryId = recovery?.id ?? 'in_flight';
    const amount = chain === 'ethereum' ? order.order.makingAmount : (order.order.takingAmount ?? order.order.makingAmount);
    const asset = chain === 'ethereum' ? order.order.makerAsset : (order.order.takerAsset ?? 'XLM');

    this.logRecovery('info', {
      recoveryId,
      orderId,
      orderHash: order.orderHash,
      stage: RecoveryStage.ChainActionStarted,
      action: actionType,
      chain,
      chainAction,
      mutation: 'refund',
      amount,
      asset,
      timeWindow: recovery?.timeWindow
    }, `${chain} action started: ${chainAction}`);

    try {
      await new Promise(resolve => setTimeout(resolve, delayMs));

      const durationMs = Date.now() - actionStartTime;
      this.logRecovery('info', {
        recoveryId,
        orderId,
        orderHash: order.orderHash,
        stage: RecoveryStage.ChainActionCompleted,
        action: actionType,
        chain,
        chainAction,
        mutation: 'refund',
        amount,
        asset,
        durationMs
      }, `${chain} action successful: ${chainAction}`);
    } catch (err) {
      const durationMs = Date.now() - actionStartTime;
      const diagnostics = diagnoseRecoveryError(err, chain);
      this.logRecovery('error', {
        recoveryId,
        orderId,
        orderHash: order.orderHash,
        stage: RecoveryStage.ChainActionFailed,
        action: actionType,
        chain,
        chainAction,
        mutation: 'refund',
        amount,
        asset,
        durationMs,
        error: err instanceof Error ? err.message : String(err),
        diagnostics
      }, `${chain} action failed: ${chainAction}`);
      throw err;
    }
  }

  /**
   * Ethereum refund operations with standardized stages and error diagnostics.
   */
  private async executeEthereumRefund(order: ActiveOrder, recovery?: RecoveryRequest): Promise<void> {
    await this.runChainAction('ethereum', 'ethereum_refund', RecoveryType.TimeoutRefund, order, recovery, 1000);
  }

  private async executeEthereumEmergencyRefund(order: ActiveOrder, recovery?: RecoveryRequest): Promise<void> {
    await this.runChainAction('ethereum', 'ethereum_emergency_refund', RecoveryType.EmergencyRefund, order, recovery, 500);
  }

  private async executePublicEthereumWithdrawal(order: ActiveOrder, recovery?: RecoveryRequest): Promise<void> {
    await this.runChainAction('ethereum', 'ethereum_public_withdrawal', RecoveryType.PublicWithdrawal, order, recovery, 1000);
  }

  private async executeForceEthereumRecovery(order: ActiveOrder, recovery?: RecoveryRequest): Promise<void> {
    await this.runChainAction('ethereum', 'ethereum_force_recovery', RecoveryType.ForceRecovery, order, recovery, 800);
  }

  /**
   * Stellar refund operations with standardized stages and error diagnostics.
   */
  private async executeStellarRefund(order: ActiveOrder, recovery?: RecoveryRequest): Promise<void> {
    await this.runChainAction('stellar', 'stellar_refund', RecoveryType.TimeoutRefund, order, recovery, 1200);
  }

  private async executeStellarEmergencyRefund(order: ActiveOrder, recovery?: RecoveryRequest): Promise<void> {
    await this.runChainAction('stellar', 'stellar_emergency_refund', RecoveryType.EmergencyRefund, order, recovery, 600);
  }

  private async executePublicStellarWithdrawal(order: ActiveOrder, recovery?: RecoveryRequest): Promise<void> {
    await this.runChainAction('stellar', 'stellar_public_withdrawal', RecoveryType.PublicWithdrawal, order, recovery, 1100);
  }

  private async executeForceeStellarRecovery(order: ActiveOrder, recovery?: RecoveryRequest): Promise<void> {
    await this.runChainAction('stellar', 'stellar_force_recovery', RecoveryType.ForceRecovery, order, recovery, 900);
  }

  /**
   * Retry recovery
   *
   * Guards against completed or cancelled recoveries, emitting structured
   * operator logs for skipped retries instead of raw console output.
   */
  private async retryRecovery(recoveryId: string): Promise<void> {
    const recovery = this.recoveryRequests.get(recoveryId);
    if (!recovery) {
      return;
    }

    const orderId = recovery.orderId ?? recovery.orderHash;

    if (
      recovery.status === RecoveryStatus.Completed ||
      recovery.status === RecoveryStatus.Cancelled
    ) {
      this.logRecovery('info', {
        recoveryId,
        orderId,
        orderHash: recovery.orderHash,
        stage: RecoveryStage.Skipped,
        action: recovery.type,
        mutation: 'refund',
        fromStatus: recovery.status,
        toStatus: recovery.status,
        reason: `Skipping retry for ${recoveryId} — already ${recovery.status}`
      }, `skipping retry for ${recoveryId} — already ${recovery.status}`);
      return;
    }

    this.logRecovery('info', {
      recoveryId,
      orderId,
      orderHash: recovery.orderHash,
      stage: RecoveryStage.Retrying,
      action: recovery.type,
      mutation: 'refund',
      fromStatus: RecoveryStatus.Failed,
      toStatus: RecoveryStatus.Pending,
      reason: 'Scheduled retry execution'
    }, 'retrying recovery');

    recovery.status = RecoveryStatus.Pending;
    recovery.stage = RecoveryStage.Retrying;
    recovery.toStatus = RecoveryStatus.Pending;
    recovery.updatedAt = getCurrentTimestamp();

    await this.recoveryMutex.runExclusive(recovery.orderHash, async () => {
      await this.executeRecovery(recoveryId);
    });
  }

  /**
   * Manual recovery initiation by operator
   */
  public async initiateManualRecovery(
    orderHash: string,
    type: RecoveryType,
    initiator: string,
    reason: string,
    metadata: Partial<RecoveryRequest['metadata']> = {}
  ): Promise<string> {
    const recoveryId = `manual_recovery_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const currentTime = getCurrentTimestamp();
    const order = this.findOrder(orderHash);
    const orderId = this.resolveOrderId(order, orderHash);
    const timeWindow = order ? this.buildTimeWindow(order, currentTime) : undefined;

    const recoveryRequest: RecoveryRequest = {
      id: recoveryId,
      orderHash,
      orderId,
      type,
      status: RecoveryStatus.Pending,
      stage: RecoveryStage.Initiated,
      chain: 'multi_chain',
      chainAction: `manual_${type}`,
      mutation: 'refund',
      fromStatus: order?.status ?? RecoveryStatus.Pending,
      toStatus: RecoveryStatus.Pending,
      initiator,
      reason,
      createdAt: currentTime,
      updatedAt: currentTime,
      timeWindow,
      metadata: {
        ...metadata,
        orderId,
        stage: RecoveryStage.Initiated,
        chainAction: `manual_${type}`,
        mutation: 'refund',
        timeWindow
      }
    };

    this.recoveryRequests.set(recoveryId, recoveryRequest);
    this.stats.pendingRecoveries++;

    this.logRecovery('info', {
      recoveryId,
      orderId,
      orderHash,
      stage: RecoveryStage.Initiated,
      action: type,
      srcChainId: order?.srcChainId,
      dstChainId: order?.dstChainId,
      mutation: 'refund',
      fromStatus: order?.status ?? RecoveryStatus.Pending,
      toStatus: RecoveryStatus.Pending,
      initiator,
      reason,
      timeWindow
    }, 'manual recovery initiated');

    this.emitRecoveryEvent(RecoveryStage.Initiated, recoveryRequest, {
      fromStatus: order?.status ?? RecoveryStatus.Pending,
      toStatus: RecoveryStatus.Pending,
      timeWindow
    });

    await this.recoveryMutex.runExclusive(orderHash, async () => {
      await this.executeRecovery(recoveryId);
    });

    return recoveryId;
  }

  /**
   * Emergency recovery initiated by operator
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
    const order = this.findOrder(orderHash);
    const orderId = this.resolveOrderId(order, orderHash);
    log.debug({ orderId, orderHash, stage: 'tracking' }, '[recovery] tracking new order');
  }

  private handleOrderCancellation(orderHash: string): void {
    const order = this.findOrder(orderHash);
    const orderId = this.resolveOrderId(order, orderHash);
    log.debug({ orderId, orderHash, stage: 'cancelled' }, '[recovery] tracking order cancelled');
  }

  private handleOrderCompletion(orderHash: string): void {
    const order = this.findOrder(orderHash);
    const orderId = this.resolveOrderId(order, orderHash);
    log.debug({ orderId, orderHash, stage: 'completed' }, '[recovery] tracking order completed');
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
    log.info({ stage: 'stopped' }, '[recovery] monitoring stopped');
  }

  /**
   * Cleanup
   */
  public cleanup(): void {
    this.stopMonitoring();
    this.removeAllListeners();
    log.info({ stage: 'cleaned_up' }, '[recovery] cleanup completed');
  }
}

export default RecoveryService;
