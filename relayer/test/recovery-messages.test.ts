import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  RecoveryService,
  RecoveryStatus,
  RecoveryType,
  RecoveryStage,
  diagnoseRecoveryError,
  type RecoveryConfig,
  type StructuredRecoveryMessage
} from '../src/services/recovery-service.js';
import { EventType } from '../src/events/event-handlers.js';

describe('Cross-Chain Recovery Messages and Operator Clarity', () => {
  let ordersService: any;
  let eventManager: any;
  let config: RecoveryConfig;
  let emittedEvents: Array<{ eventType: EventType; data: any; metadata: any }>;

  beforeEach(() => {
    emittedEvents = [];
    ordersService = {
      getActiveOrders: vi.fn().mockReturnValue({ items: [] })
    };
    eventManager = {
      on: vi.fn(),
      emitEvent: vi.fn((eventType, data, metadata) => {
        emittedEvents.push({ eventType, data, metadata });
      })
    };
    config = {
      monitoringInterval: 60_000,
      autoRefundEnabled: true,
      emergencyEnabled: true,
      maxRetries: 0,
      retryDelay: 1000,
      gracePeriod: 30
    };
  });

  it('standardizes timeout recovery messages with orderId, stage, mutation, and time window', async () => {
    const orderHash = '0x1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff';
    const orderId = 'wf_order_eth_xlm_001';
    const timelock = Math.floor(Date.now() / 1000) - 100;

    ordersService.getActiveOrders.mockReturnValue({
      items: [{
        orderId,
        orderHash,
        srcChainId: 1,
        dstChainId: 999,
        order: { makingAmount: '1000000000000000000', makerAsset: 'ETH', takingAmount: '2500000000', takerAsset: 'XLM' },
        deadline: timelock,
        status: 'expired'
      }]
    });

    const service = new RecoveryService(ordersService, eventManager, config);

    const execSpy = vi.spyOn(service as any, 'executeTimeoutRefund').mockImplementation(async (recovery, order) => {
      // Simulate fast refund execution
      return Promise.resolve();
    });

    // Run timeout recovery via private method or active orders loop
    await (service as any).monitorTimelocksAndRecover();

    expect(execSpy).toHaveBeenCalledTimes(1);

    // Verify emitted recovery events
    const recoveryEvents = emittedEvents.filter(e => e.eventType === EventType.Recovery);
    expect(recoveryEvents.length).toBeGreaterThanOrEqual(2);

    // Initial event checks
    const initialEvent = recoveryEvents.find(e => e.metadata.stage === RecoveryStage.Initiated);
    expect(initialEvent).toBeDefined();
    expect(initialEvent?.metadata.orderId).toBe(orderId);
    expect(initialEvent?.metadata.orderHash).toBe(orderHash);
    expect(initialEvent?.metadata.type).toBe(RecoveryType.TimeoutRefund);
    expect(initialEvent?.metadata.status).toBe(RecoveryStatus.Pending);

    const initialData = initialEvent?.data as StructuredRecoveryMessage;
    expect(initialData.orderId).toBe(orderId);
    expect(initialData.mutation).toBe('refund');
    expect(initialData.stage).toBe(RecoveryStage.Initiated);
    expect(initialData.fromStatus).toBe('expired');
    expect(initialData.toStatus).toBe('pending');
    expect(initialData.timeWindow).toBeDefined();
    expect(initialData.timeWindow?.timelock).toBe(timelock);
    expect(initialData.timeWindow?.gracePeriod).toBe(config.gracePeriod);
    expect(initialData.timeWindow?.secondsPastDeadline).toBeGreaterThan(0);

    // Completion event checks
    const completedEvent = recoveryEvents.find(e => e.metadata.stage === RecoveryStage.Completed);
    expect(completedEvent).toBeDefined();
    expect(completedEvent?.metadata.orderId).toBe(orderId);
    expect(completedEvent?.metadata.status).toBe(RecoveryStatus.Completed);

    const completedData = completedEvent?.data as StructuredRecoveryMessage;
    expect(completedData.orderId).toBe(orderId);
    expect(completedData.mutation).toBe('refund');
    expect(completedData.toStatus).toBe('refunded');
    expect(completedData.durationMs).toBeGreaterThanOrEqual(0);

    execSpy.mockRestore();
    service.cleanup();
  });

  it('provides consistent structured messages across Ethereum and Stellar actions', async () => {
    const orderHash = '0xethstellar01';
    const orderId = 'wf_crosschain_test_02';

    ordersService.getActiveOrders.mockReturnValue({
      items: [{
        orderId,
        orderHash,
        srcChainId: 1,
        dstChainId: 999,
        order: { makingAmount: '500', makerAsset: 'ETH', takingAmount: '1200', takerAsset: 'XLM' },
        deadline: Math.floor(Date.now() / 1000) - 200,
        status: 'src_locked'
      }]
    });

    const service = new RecoveryService(ordersService, eventManager, config);

    // Spy on chain actions to verify standardized logging parameters
    const logSpy = vi.spyOn(service as any, 'logRecovery');

    await service.initiateManualRecovery(
      orderHash,
      RecoveryType.EmergencyRefund,
      'operator-alice',
      'Bridge halted due to chain reorg'
    );

    // Verify all logged stages follow identical schema
    const loggedCalls = logSpy.mock.calls.map(call => call[1] as StructuredRecoveryMessage);

    const initiatedLog = loggedCalls.find(l => l.stage === RecoveryStage.Initiated);
    expect(initiatedLog).toBeDefined();
    expect(initiatedLog?.orderId).toBe(orderId);
    expect(initiatedLog?.orderHash).toBe(orderHash);
    expect(initiatedLog?.initiator).toBe('operator-alice');
    expect(initiatedLog?.mutation).toBe('refund');
    expect(initiatedLog?.action).toBe(RecoveryType.EmergencyRefund);

    const ethActionStarted = loggedCalls.find(l => l.chainAction === 'ethereum_emergency_refund' && l.stage === RecoveryStage.ChainActionStarted);
    expect(ethActionStarted).toBeDefined();
    expect(ethActionStarted?.chain).toBe('ethereum');
    expect(ethActionStarted?.orderId).toBe(orderId);

    const stellarActionStarted = loggedCalls.find(l => l.chainAction === 'stellar_emergency_refund' && l.stage === RecoveryStage.ChainActionStarted);
    expect(stellarActionStarted).toBeDefined();
    expect(stellarActionStarted?.chain).toBe('stellar');
    expect(stellarActionStarted?.orderId).toBe(orderId);

    const completedLog = loggedCalls.find(l => l.stage === RecoveryStage.Completed);
    expect(completedLog).toBeDefined();
    expect(completedLog?.toStatus).toBe('refunded');
    expect(completedLog?.durationMs).toBeGreaterThanOrEqual(0);

    logSpy.mockRestore();
    service.cleanup();
  });

  it('falls back cleanly to orderHash when orderId is not available', async () => {
    const orderHash = '0xonlyhash999';

    // Order without explicit orderId
    ordersService.getActiveOrders.mockReturnValue({
      items: [{
        orderHash,
        srcChainId: 1,
        dstChainId: 999,
        order: { makingAmount: '10', makerAsset: 'ETH' },
        deadline: Math.floor(Date.now() / 1000) - 50
      }]
    });

    const service = new RecoveryService(ordersService, eventManager, config);
    vi.spyOn(service as any, 'executeTimeoutRefund').mockResolvedValue(undefined);

    const recoveryId = await service.initiateManualRecovery(
      orderHash,
      RecoveryType.TimeoutRefund,
      'system',
      'Manual timelock fallback test'
    );

    const req = service.getRecoveryRequest(recoveryId);
    expect(req?.orderId).toBe(orderHash);
    expect(req?.orderHash).toBe(orderHash);

    service.cleanup();
  });

  it('diagnoses Stellar Horizon errors cleanly without raw XDR and RPC dumps', () => {
    // Simulated Horizon tx_bad_seq error
    const badSeqError = {
      response: {
        status: 400,
        data: {
          title: 'Transaction Failed',
          extras: {
            result_codes: {
              transaction: 'tx_bad_seq',
              operations: []
            },
            envelope_xdr: 'AAAAAG2M...very_long_raw_base64_xdr...',
            result_xdr: 'AAAAAf////...very_long_raw_base64_result_xdr...'
          }
        }
      }
    };

    const diagnosis = diagnoseRecoveryError(badSeqError, 'stellar');
    expect(diagnosis).toContain('tx_bad_seq');
    expect(diagnosis).toContain('Sequence out of sync');
    expect(diagnosis).not.toContain('envelope_xdr');
    expect(diagnosis).not.toContain('AAAAAG2M');

    // Simulated Horizon op_underfunded error
    const underfundedError = {
      response: {
        status: 400,
        data: {
          extras: {
            result_codes: {
              transaction: 'tx_failed',
              operations: ['op_underfunded']
            }
          }
        }
      }
    };

    const underfundedDiagnosis = diagnoseRecoveryError(underfundedError, 'stellar');
    expect(underfundedDiagnosis).toContain('op_underfunded');
    expect(underfundedDiagnosis).toContain('insufficient balance');

    // Simulated Horizon 504 Gateway Timeout
    const timeoutError = {
      response: {
        status: 504,
        data: {
          title: 'Gateway Timeout'
        }
      }
    };

    const timeoutDiagnosis = diagnoseRecoveryError(timeoutError, 'stellar');
    expect(timeoutDiagnosis).toContain('504');
    expect(timeoutDiagnosis).toContain('Transaction may have landed on ledger');

    // Direct result codes on error without Axios wrapper
    const directResultCodes = {
      resultCodes: {
        transaction: 'tx_bad_auth',
        operations: []
      }
    };
    const authDiagnosis = diagnoseRecoveryError(directResultCodes, 'stellar');
    expect(authDiagnosis).toContain('tx_bad_auth');
    expect(authDiagnosis).toContain('Invalid signature');

    // Unknown amount deferral error
    const unknownAmountErr = {
      isUnknownAmount: true,
      message: 'Payment amount unknown'
    };
    const unknownAmountDiagnosis = diagnoseRecoveryError(unknownAmountErr, 'stellar');
    expect(unknownAmountDiagnosis).toContain('deferred');

    // Horizon tx_insufficient_balance and op_no_trust
    const trustError = {
      extras: {
        result_codes: {
          transaction: 'tx_failed',
          operations: ['op_no_trust']
        }
      }
    };
    expect(diagnoseRecoveryError(trustError, 'stellar')).toContain('lacks trustline');

    const insufficientBalanceError = {
      extras: {
        result_codes: {
          transaction: 'tx_insufficient_balance',
          operations: []
        }
      }
    };
    expect(diagnoseRecoveryError(insufficientBalanceError, 'stellar')).toContain('minimum reserve');

    // Soroban RPC statuses
    const sorobanTryAgain = { status: 'TRY_AGAIN_LATER' };
    expect(diagnoseRecoveryError(sorobanTryAgain, 'stellar')).toContain('overloaded (TRY_AGAIN_LATER)');

    const sorobanDuplicate = { status: 'DUPLICATE' };
    expect(diagnoseRecoveryError(sorobanDuplicate, 'stellar')).toContain('duplicate submission detected');

    const sorobanError = {
      status: 'ERROR',
      errorResultXdr: 'AAAAAQAAAAD.....raw_error_xdr.....'
    };
    expect(diagnoseRecoveryError(sorobanError, 'stellar')).toContain('Soroban contract transaction rejected (ERROR)');
    expect(diagnoseRecoveryError(sorobanError, 'stellar')).not.toContain('raw_error_xdr');

    const sorobanFailed = { status: 'FAILED' };
    expect(diagnoseRecoveryError(sorobanFailed, 'stellar')).toContain('failed during ledger execution');

    const sorobanNotFound = { status: 'NOT_FOUND' };
    expect(diagnoseRecoveryError(sorobanNotFound, 'stellar')).toContain('not found in ledger');
  });

  it('diagnoses Ethereum RPC errors cleanly without raw blocks', () => {
    // Nonce expired
    const nonceError = {
      code: 'NONCE_EXPIRED',
      message: 'nonce has already been used'
    };
    const nonceDiagnosis = diagnoseRecoveryError(nonceError, 'ethereum');
    expect(nonceDiagnosis).toContain('Ethereum nonce conflict');

    // Insufficient funds for gas
    const fundsError = {
      code: 'INSUFFICIENT_FUNDS',
      message: 'insufficient funds for intrinsic transaction cost'
    };
    const fundsDiagnosis = diagnoseRecoveryError(fundsError, 'ethereum');
    expect(fundsDiagnosis).toContain('insufficient ETH');

    // Revert reason
    const revertError = {
      reason: 'HTLC: timelock has not expired yet',
      message: 'execution reverted: HTLC: timelock has not expired yet'
    };
    const revertDiagnosis = diagnoseRecoveryError(revertError, 'ethereum');
    expect(revertDiagnosis).toContain('HTLC: timelock has not expired yet');

    // Transaction replaced
    const replacedError = {
      code: 'TRANSACTION_REPLACED',
      message: 'transaction was replaced'
    };
    expect(diagnoseRecoveryError(replacedError, 'ethereum')).toContain('replaced or repriced');

    // Suppressing raw hex and base64 strings
    const rawBlobError = new Error('Raw RPC dump: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA and 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef');
    const suppressed = diagnoseRecoveryError(rawBlobError);
    expect(suppressed).toContain('[raw data suppressed]');
    expect(suppressed).toContain('[hex data suppressed]');
    expect(suppressed).not.toContain('AAAAAAAAAAAAAAAAAAAAAAA');
  });

  it('records structured recovery request details for operator retrieval', async () => {
    const orderHash = '0xoperator_query_test';
    const orderId = 'wf_operator_007';

    ordersService.getActiveOrders.mockReturnValue({
      items: [{
        orderId,
        orderHash,
        srcChainId: 1,
        dstChainId: 999,
        order: { makingAmount: '100', makerAsset: 'ETH' },
        deadline: Math.floor(Date.now() / 1000) - 120
      }]
    });

    const service = new RecoveryService(ordersService, eventManager, config);
    vi.spyOn(service as any, 'executeTimeoutRefund').mockResolvedValue(undefined);

    const recoveryId = await service.initiateManualRecovery(
      orderHash,
      RecoveryType.TimeoutRefund,
      'admin-bob',
      'Operator initiated recovery'
    );

    const req = service.getRecoveryRequest(recoveryId);
    expect(req).toBeDefined();
    expect(req?.orderId).toBe(orderId);
    expect(req?.stage).toBe(RecoveryStage.Completed);
    expect(req?.mutation).toBe('refund');
    expect(req?.toStatus).toBe('refunded');
    expect(req?.timeWindow).toBeDefined();
    expect(req?.durationMs).toBeGreaterThanOrEqual(0);

    const allRequests = service.getRecoveryRequests();
    expect(allRequests.length).toBe(1);
    expect(allRequests[0].orderId).toBe(orderId);

    service.cleanup();
  });
});
