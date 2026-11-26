/**
 * @fileoverview Restart-resumption integration tests for the recovery service (#1083).
 *
 * Acceptance criteria covered:
 *   - Restarting the relayer resumes eligible unfinished recovery work
 *     without duplicate settlement.
 *   - Recovery state can be reconstructed or inspected without storing
 *     private credentials.
 *
 * Strategy: drive a RecoveryService against a stub orchestrator and a
 * disk-backed RecoveryJobStore, then simulate a restart by constructing a
 * fresh RecoveryService on the same store and asserting that eligible jobs
 * resume (and completed jobs do not).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { RecoveryService } from '../src/services/recovery/RecoveryService.js';
import { RecoveryJobStore } from '../src/services/recovery/RecoveryJobStore.js';
import type { IRecoveryOrchestrator, RecoveryOrder, RecoveryResult } from '../src/services/recovery/IRecoveryService.js';

const logs = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }));
vi.mock('../src/logger.js', () => ({
  getLogger: () => ({ child: () => logs }),
}));

const transient = (): RecoveryResult => ({
  success: false,
  errorType: 'transient',
  chain: 'ethereum',
  timestamp: 0,
});
const success = (amount = '10'): RecoveryResult => ({
  success: true,
  amount,
  chain: 'ethereum',
  timestamp: 0,
});
const terminal = (): RecoveryResult => ({
  success: false,
  errorType: 'terminal',
  chain: 'ethereum',
  timestamp: 0,
});

function makeOrder(overrides: Partial<RecoveryOrder> = {}): RecoveryOrder {
  return {
    publicId: 'wf_1',
    orderHash: 'hash-1',
    status: 'expired',
    srcChain: 'ethereum',
    dstChain: 'stellar',
    srcTimelock: 1,
    dstTimelock: 1,
    makingAmount: '10',
    srcAsset: 'ETH',
    takerAsset: 'XLM',
    metadata: {
      preimage: '0xORDER_PREIMAGE_SECRET',
      signingKey: '0xSIGNER_SECRET',
      refundAddress: '0xrefund',
      hashlock: '0xkeep',
    },
    ...overrides,
  };
}

describe('RecoveryService — restart resumption (#1083)', () => {
  let dir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    vi.clearAllMocks();
    dir = mkdtempSync(join(tmpdir(), 'recovery-restart-'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it('resumes a pending (unfinished) recovery job after a restart without duplicate settlement', async () => {
    const execute = vi.fn().mockResolvedValue(transient());
    const store = new RecoveryJobStore({ storageDir: dir });

    // First instance: start a recovery that stays pending (transient failure).
    const before = new RecoveryService({ executeRecovery: execute } as unknown as IRecoveryOrchestrator, store);
    const order = makeOrder();
    await before.executeRecovery(order, 'timeout_refund');
    // Job is pending after a single transient attempt.
    const req = before.getRecoveryRequests('hash-1')[0];
    expect(req.status).toBe('pending');
    expect(execute).toHaveBeenCalledTimes(1);
    before.stop();

    // Simulate a restart: new service on the same durable store.
    const after = new RecoveryService({ executeRecovery: execute } as unknown as IRecoveryOrchestrator, store);
    // The unfinished job was restored.
    const restored = after.getRecoveryRequests('hash-1')[0];
    expect(restored).toBeDefined();
    expect(restored.status).toBe('pending');

    // Advance time past the retry backoff and run the monitoring sweep to resume.
    await vi.advanceTimersByTimeAsync(1_000);
    await after.processPendingRecoveries();
    // The restored job was retried exactly once more (resume), not duplicated.
    expect(execute).toHaveBeenCalledTimes(2);
    after.stop();
  });

  it('does not re-execute a completed job after a restart', async () => {
    const execute = vi.fn().mockResolvedValueOnce(success());
    const store = new RecoveryJobStore({ storageDir: dir });

    const before = new RecoveryService({ executeRecovery: execute } as unknown as IRecoveryOrchestrator, store);
    await before.executeRecovery(makeOrder(), 'timeout_refund');
    expect(before.getRecoveryRequests('hash-1')[0].status).toBe('completed');
    expect(execute).toHaveBeenCalledTimes(1);
    before.stop();

    // Restart.
    const after = new RecoveryService({ executeRecovery: execute } as unknown as IRecoveryOrchestrator, store);
    // Completed jobs are NOT eligible to resume, so they are not re-executed.
    await vi.advanceTimersByTimeAsync(60_000);
    await after.processPendingRecoveries();
    expect(execute).toHaveBeenCalledTimes(1); // still once — no duplicate settlement
    after.stop();
  });

  it('resets an interrupted in_progress job to pending on restart (no double settlement)', async () => {
    const execute = vi.fn().mockResolvedValue(success());
    const store = new RecoveryJobStore({ storageDir: dir });

    const before = new RecoveryService({ executeRecovery: execute } as unknown as IRecoveryOrchestrator, store);
    // Manually create an in_progress record and persist it, simulating a
    // process that was killed mid-submission.
    const order = makeOrder();
    await before.executeRecovery(order, 'timeout_refund'); // completes -> not useful here
    // Force an in_progress persisted state for a new id.
    const storeInternal = store;
    storeInternal.save({
      id: 'recovery_inprogress',
      orderId: 'wf_2',
      orderHash: 'hash-2',
      type: 'timeout_refund',
      status: 'in_progress',
      chain: 'ethereum',
      initiator: 'system',
      reason: 'Auto-recovery initiated',
      metadata: { expired: true, timelock: 1 },
      createdAt: 50,
      updatedAt: 90,
      attempts: 1,
      lastAttemptAt: 90,
      nextAttemptAt: null,
      order: makeOrder({ publicId: 'wf_2', orderHash: 'hash-2' }),
      savedAt: 0,
    });
    before.stop();

    // Restart: in_progress must be reset to pending and resumed once.
    execute.mockClear();
    const after = new RecoveryService({ executeRecovery: execute } as unknown as IRecoveryOrchestrator, store);
    const restored = after.getRecoveryRequests('hash-2')[0];
    expect(restored).toBeDefined();
    expect(restored.status).toBe('pending');
    await vi.advanceTimersByTimeAsync(1_000);
    await after.processPendingRecoveries();
    expect(execute).toHaveBeenCalledTimes(1);
    after.stop();
  });

  it('does not persist preimage or signing-key material across the restart boundary', async () => {
    const execute = vi.fn().mockResolvedValue(transient());
    const store = new RecoveryJobStore({ storageDir: dir });

    const before = new RecoveryService({ executeRecovery: execute } as unknown as IRecoveryOrchestrator, store);
    await before.executeRecovery(makeOrder(), 'timeout_refund');
    before.stop();

    // Inspect the persisted files directly.
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThan(0);
    const stored = files.map((f) => readFileSync(join(dir, f), 'utf-8')).join('\n');
    expect(stored).not.toContain('ORDER_PREIMAGE_SECRET');
    expect(stored).not.toContain('SIGNER_SECRET');
    expect(stored).toContain('0xrefund'); // non-secret fields preserved
    expect(stored).toContain('0xkeep');
  });

  it('does not retry a permanently failed (exhausted) job after a restart', async () => {
    const execute = vi.fn().mockResolvedValue(terminal());
    const store = new RecoveryJobStore({ storageDir: dir });

    const before = new RecoveryService({ executeRecovery: execute } as unknown as IRecoveryOrchestrator, store);
    await before.executeRecovery(makeOrder(), 'timeout_refund');
    expect(before.getRecoveryRequests('hash-1')[0].status).toBe('failed');
    expect(execute).toHaveBeenCalledTimes(1);
    before.stop();

    const after = new RecoveryService({ executeRecovery: execute } as unknown as IRecoveryOrchestrator, store);
    // failed + nextAttemptAt == null is NOT eligible to resume, so it is not
    // restored into the in-memory map.
    expect(after.getRecoveryRequests('hash-1')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(60_000);
    await after.processPendingRecoveries();
    expect(execute).toHaveBeenCalledTimes(1);
    after.stop();
  });
});
