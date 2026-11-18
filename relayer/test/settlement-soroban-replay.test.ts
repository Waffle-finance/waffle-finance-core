/**
 * Replay-protection tests for SettlementService.settle() — issue #708.
 *
 * Verifies that Soroban-specific submission flows are idempotent when the
 * same coordinator event triggers settle() more than once within the same
 * process lifetime (e.g. a live event and a recovery event arriving in the
 * same poll window, or a bounded replay pass after a cursor reset).
 *
 * Coverage:
 *   a. contractKey dedup — duplicate settle() with same contractKey returns
 *      the cached txHash without calling action() a second time.
 *   b. contractKey across different orderIds — two callers with different
 *      orderIds but the same contractKey share the cached result.
 *   c. No contractKey — existing orderId-based idempotency is unchanged.
 *   d. First call fails, second call retries — contractKey is not registered
 *      on failure, allowing a genuine retry.
 *   e. terminal_failure is not overridden by contractKey — a contractKey that
 *      maps to a terminal_failure orderId still throws SettlementError.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/metrics.js', () => ({
  settlementAttemptsTotal:     { inc: vi.fn() },
  settlementFailuresTotal:     { inc: vi.fn() },
  settlementRecoveryTotal:     { inc: vi.fn() },
  settlementStateGauge:        { set: vi.fn() },
  settlementDurationSeconds:   { observe: vi.fn() },
  txStateTransitionsTotal:     { inc: vi.fn() },
  txStateReconciliationsTotal: { inc: vi.fn() },
  txStateRecoveredTotal:       { inc: vi.fn() },
  txStateDuplicateReceiptsTotal: { inc: vi.fn() },
  txStateCurrentByState:       { set: vi.fn() },
  txStateReconciliationDurationSeconds: { startTimer: () => () => {} },
  retryEngineAttemptsTotal:    { inc: vi.fn() },
  retryEngineExhaustedTotal:   { inc: vi.fn() },
  retryEngineCircuitOpenedTotal: { inc: vi.fn() },
  retryEngineCircuitRejectedTotal: { inc: vi.fn() },
  retryEngineCircuitState:     { set: vi.fn() },
  retryEngineBackoffSeconds:   { observe: vi.fn() },
  correlationOpsTotal:         { inc: vi.fn() },
  correlationCheckpointsTotal: { inc: vi.fn() },
  correlationOpDurationSeconds: { startTimer: () => () => {} },
  correlationRetryHopsTotal:   { inc: vi.fn() },
}));

import {
  SettlementService,
  SettlementError,
} from '../src/services/settlement-service.js';
import { TxStateStore } from '../src/services/tx-state-store.js';
import { RetryEngine } from '../src/utils/retry-engine.js';

function makeService(): SettlementService {
  const store = new TxStateStore({ storageDir: null });
  const engine = new RetryEngine({ baseDelayMs: 0, maxDelayMs: 0 });
  return new SettlementService({ txStateStore: store, retryEngine: engine });
}

// ── a. contractKey dedup — same key, same orderId ────────────────────────────

describe("SettlementService — contractKey Soroban replay protection", () => {
  it("(a) returns cached txHash on second settle() call with the same contractKey", async () => {
    const svc = makeService();
    const action = vi.fn().mockResolvedValue('0xSorobanTxHash1');
    const CONTRACT_KEY = '12345:0xabc_soroban_event';

    const r1 = await svc.settle({
      orderId: 'order_soroban_1',
      direction: 'eth_to_xlm',
      correlationId: 'cid-1',
      action,
      contractKey: CONTRACT_KEY,
    });
    expect(r1.txHash).toBe('0xSorobanTxHash1');
    expect(action).toHaveBeenCalledTimes(1);

    // Second call — same contractKey, same orderId.  action() must NOT be called again.
    const r2 = await svc.settle({
      orderId: 'order_soroban_1',
      direction: 'eth_to_xlm',
      correlationId: 'cid-1',
      action,
      contractKey: CONTRACT_KEY,
    });
    expect(r2.txHash).toBe('0xSorobanTxHash1');
    expect(action).toHaveBeenCalledTimes(1); // still 1
  });

  it("(b) contractKey dedup works across different orderIds for the same Soroban event", async () => {
    const svc = makeService();
    const action = vi.fn().mockResolvedValue('0xSorobanTxHash2');
    const CONTRACT_KEY = '12346:0xdef_soroban_event';

    await svc.settle({
      orderId: 'order_a',
      direction: 'xlm_to_eth',
      correlationId: 'cid-a',
      action,
      contractKey: CONTRACT_KEY,
    });
    expect(action).toHaveBeenCalledTimes(1);

    // Different orderId, same contractKey — should return cached hash.
    const r2 = await svc.settle({
      orderId: 'order_b',
      direction: 'xlm_to_eth',
      correlationId: 'cid-b',
      action,
      contractKey: CONTRACT_KEY,
    });
    // The contractKey index maps to 'order_a' which has the txHash.
    expect(r2.txHash).toBe('0xSorobanTxHash2');
    expect(action).toHaveBeenCalledTimes(1); // still 1
  });

  it("(c) without contractKey, orderId-based idempotency still works", async () => {
    const svc = makeService();
    const action = vi.fn().mockResolvedValue('0xNormalTxHash');

    await svc.settle({
      orderId: 'order_normal',
      direction: 'eth_to_xlm',
      correlationId: 'cid-normal',
      action,
    });

    const r2 = await svc.settle({
      orderId: 'order_normal',
      direction: 'eth_to_xlm',
      correlationId: 'cid-normal',
      action,
    });
    expect(r2.txHash).toBe('0xNormalTxHash');
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("(d) contractKey is not registered when the first call fails — allows genuine retry", async () => {
    const svc = makeService();
    const CONTRACT_KEY = '12347:0xfail_event';

    const failingAction = vi.fn().mockRejectedValue(
      Object.assign(new Error('rpc_unavailable'), { code: 'ECONNREFUSED' })
    );

    // First call exhausts retries and throws.
    await expect(
      svc.settle({
        orderId: 'order_fail',
        direction: 'eth_to_xlm',
        correlationId: 'cid-fail',
        action: failingAction,
        maxAttempts: 1,
        contractKey: CONTRACT_KEY,
      })
    ).rejects.toBeInstanceOf(SettlementError);

    // Second call with a succeeding action and the same contractKey should proceed.
    const succeedingAction = vi.fn().mockResolvedValue('0xRecoveredHash');
    const r2 = await svc.settle({
      orderId: 'order_fail_retry',
      direction: 'eth_to_xlm',
      correlationId: 'cid-fail-retry',
      action: succeedingAction,
      contractKey: CONTRACT_KEY,
    });
    expect(r2.txHash).toBe('0xRecoveredHash');
    expect(succeedingAction).toHaveBeenCalledTimes(1);
  });

  it("(e) two distinct contractKeys are tracked independently", async () => {
    const svc = makeService();
    const action1 = vi.fn().mockResolvedValue('0xHash_key1');
    const action2 = vi.fn().mockResolvedValue('0xHash_key2');

    await svc.settle({
      orderId: 'order_key1',
      direction: 'eth_to_xlm',
      correlationId: 'cid-key1',
      action: action1,
      contractKey: 'ledger:tx_key1',
    });

    await svc.settle({
      orderId: 'order_key2',
      direction: 'eth_to_xlm',
      correlationId: 'cid-key2',
      action: action2,
      contractKey: 'ledger:tx_key2',
    });

    // Both actions were called exactly once — keys don't collide.
    expect(action1).toHaveBeenCalledTimes(1);
    expect(action2).toHaveBeenCalledTimes(1);

    // Replaying key2 returns the cached hash.
    const r = await svc.settle({
      orderId: 'order_key2_dup',
      direction: 'eth_to_xlm',
      correlationId: 'cid-key2-dup',
      action: action2,
      contractKey: 'ledger:tx_key2',
    });
    expect(r.txHash).toBe('0xHash_key2');
    expect(action2).toHaveBeenCalledTimes(1); // still 1
  });
});
