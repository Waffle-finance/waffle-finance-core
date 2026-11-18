import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RecoveryService } from '../src/services/recovery/RecoveryService.js';
import type { IRecoveryOrchestrator, RecoveryOrder } from '../src/services/recovery/IRecoveryService.js';

const logs = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }));
vi.mock('../src/logger.js', () => ({
  getLogger: () => ({ child: () => logs }),
}));

describe('recovery request retries and structured logs', () => {
  let service: RecoveryService;
  let execute: ReturnType<typeof vi.fn>;
  let order: RecoveryOrder;
  const failure = { success: false, errorType: 'transient', chain: 'ethereum', timestamp: 0 };
  const success = { success: true, amount: '10', chain: 'ethereum', timestamp: 0 };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    vi.clearAllMocks();
    execute = vi.fn().mockResolvedValue(failure);
    service = new RecoveryService({ executeRecovery: execute } as unknown as IRecoveryOrchestrator);
    order = { publicId: 'order-1', orderHash: 'hash-1', status: 'expired',
      srcChain: 'ethereum', dstChain: 'stellar', makingAmount: '10' };
  });

  afterEach(() => {
    service.stop();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('delays a transient retry, succeeds, and never resubmits a completed request', async () => {
    execute.mockResolvedValueOnce(failure).mockResolvedValueOnce(success);
    await service.executeRecovery(order, 'timeout_refund');
    const request = service.getRecoveryRequests('hash-1')[0];
    expect(request).toMatchObject({ attempts: 1, status: 'pending', nextAttemptAt: 101_000 });
    expect(request).not.toHaveProperty('order');
    await vi.advanceTimersByTimeAsync(999);
    await service.processPendingRecoveries();
    expect(execute).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await service.processPendingRecoveries();
    expect(service.getRecoveryRequest(request.id)).toMatchObject({
      attempts: 2, status: 'completed', nextAttemptAt: null,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    await service.processPendingRecoveries();
    await service.executeRecovery(order, 'timeout_refund');
    expect(execute).toHaveBeenCalledTimes(2);
    expect(await service.checkDuplicateRefund(order, 'ethereum')).toBe(true);
    expect(service.getRecoveryStats()).toMatchObject({ totalRecoveries: 1,
      successfulRecoveries: 1, failedRecoveries: 0, pendingRecoveries: 0, totalValueRecovered: '10' });
  });

  it('grows delays and terminates after five total attempts', async () => {
    await service.executeRecovery(order, 'timeout_refund');
    const { id } = service.getRecoveryRequests('hash-1')[0];
    for (const delay of [1000, 2000, 4000, 8000]) {
      expect(service.getRecoveryRequest(id)?.nextAttemptAt).toBe(Date.now() + delay);
      await vi.advanceTimersByTimeAsync(delay);
      await service.processPendingRecoveries();
    }
    expect(service.getRecoveryRequest(id)).toMatchObject({ attempts: 5, status: 'failed', nextAttemptAt: null });
    await vi.advanceTimersByTimeAsync(1_000_000);
    await service.processPendingRecoveries();
    expect(execute).toHaveBeenCalledTimes(5);
    expect(service.getRecoveryStats()).toMatchObject({ failedRecoveries: 1, pendingRecoveries: 0 });
  });

  it.each(['terminal', 'ambiguous'] as const)('does not retry a %s result', async errorType => {
    execute.mockResolvedValue({ ...failure, errorType });
    await service.executeRecovery(order, 'timeout_refund');
    await vi.advanceTimersByTimeAsync(60_000);
    await service.processPendingRecoveries();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(service.getRecoveryRequests('hash-1')[0]).toMatchObject({
      status: errorType === 'terminal' ? 'failed' : 'requires_review', nextAttemptAt: null,
    });
  });

  it('requires review after an exception without logging its possibly sensitive text', async () => {
    execute.mockRejectedValue(new Error('https://rpc.invalid/private-key'));
    await service.executeRecovery(order, 'timeout_refund');
    expect(service.getRecoveryRequests('hash-1')[0].status).toBe('requires_review');
    expect(JSON.stringify(logs.info.mock.calls)).not.toContain('private-key');
  });

  it('does not submit twice when processing ticks overlap', async () => {
    await service.executeRecovery(order, 'timeout_refund');
    let finish!: (result: typeof success) => void;
    execute.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await vi.advanceTimersByTimeAsync(1000);
    const first = service.processPendingRecoveries();
    await service.processPendingRecoveries();
    expect(execute).toHaveBeenCalledTimes(2);
    finish(success);
    await first;
  });

  it('retries an eligible failed request using its existing schedule', async () => {
    await service.executeRecovery(order, 'timeout_refund');
    const { id } = service.getRecoveryRequests('hash-1')[0];
    // Simulate a stored failed request retaining its retry eligibility.
    const stored = (service as any).recoveryRequests.get(id);
    stored.status = 'failed';
    await service.processPendingRecoveries();
    expect(execute).toHaveBeenCalledTimes(1);
    execute.mockResolvedValue(success);
    await vi.advanceTimersByTimeAsync(1000);
    await service.processPendingRecoveries();
    expect(service.getRecoveryRequest(id)?.status).toBe('completed');
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('processes eligible retries through the monitoring timer', async () => {
    execute.mockResolvedValueOnce(failure).mockResolvedValueOnce(success);
    service.start();
    await service.executeRecovery(order, 'timeout_refund');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(service.getRecoveryRequests('hash-1')[0].status).toBe('completed');
  });

  it('cancels retries when the order becomes terminal', async () => {
    await service.executeRecovery(order, 'timeout_refund');
    order.status = 'refunded';
    await vi.advanceTimersByTimeAsync(1000);
    await service.processPendingRecoveries();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(service.getRecoveryRequests('hash-1')[0].status).toBe('cancelled');
  });

  it('logs identifiers, action, attempts, and status as fields', async () => {
    await service.executeRecovery(order, 'timeout_refund', 'https://rpc.invalid/secret');
    const { id } = service.getRecoveryRequests('hash-1')[0];
    expect(logs.info).toHaveBeenCalledWith(expect.objectContaining({
      requestId: id, orderId: 'order-1', orderHash: 'hash-1', action: 'timeout_refund',
      status: 'pending', attempts: 1, event: 'retry_scheduled', nextAttemptAt: 101_000,
    }), '[recovery] request status');
    expect(JSON.stringify(logs.info.mock.calls)).not.toContain('https://rpc.invalid/secret');
  });
});
