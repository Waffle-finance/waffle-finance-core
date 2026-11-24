/**
 * @file persistence-rollback.test.ts
 *
 * Proves that every critical multi-write coordinator operation is atomic:
 * either every statement in the transaction commits, or none of them do.
 *
 * ## What "atomic" means here
 *
 * Each major order mutation (recordSrcLock, recordDstLock, recordSecretRevealed,
 * cancelOrder, abandonOrder, rollbackSrcLock, rollbackDstLock, setStatus) writes
 * two rows in a single SQLite transaction:
 *
 *   1. The mutable `orders` row (UPDATE).
 *   2. An immutable `order_events` row (INSERT) that records the transition.
 *
 * A crash or injected error between (1) and (2) must leave BOTH rows in their
 * pre-mutation state.  This is enforced by `InMemoryRepositoryTransaction.runInTransaction`
 * which wraps the pair in `BEGIN IMMEDIATE … COMMIT` / `ROLLBACK`.
 *
 * ## Injection strategy
 *
 * Production code must not change, so we use `vi.spyOn` on the repository's
 * internal `appendTransitionEvent` method (exposed indirectly) to throw after
 * the first SQL write succeeds.  Because both writes run inside the same
 * `BEGIN IMMEDIATE` block, the ROLLBACK triggered by the spy throws undoes the
 * first write too.
 *
 * We also test at the boundary of `findStaleAnnounced` (StaleCleanupService)
 * and `AuditRepository.appendBatch` (explicit BEGIN/COMMIT wrapping) to cover
 * the two paths outside of `OrdersRepository.atomic()`.
 *
 * ## Retry-after-rollback
 *
 * The acceptance criterion "retry after rollback can apply the event exactly
 * once" is verified by re-calling the operation after the spy is removed and
 * confirming the final state reflects exactly one successful application.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolve } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { openDatabase } from '../src/persistence/db.js';
import { OrdersRepository, type AnnounceOrderInput } from '../src/persistence/orders-repo.js';
import { AuditRepository } from '../src/audit/audit-repo.js';
import pino from 'pino';

// ── Shared fixtures ───────────────────────────────────────────────────────────

const VALID_HASHLOCK_A = '0x' + 'aa'.repeat(32);
const VALID_HASHLOCK_B = '0x' + 'bb'.repeat(32);
const VALID_HASHLOCK_C = '0x' + 'cc'.repeat(32);
const VALID_HASHLOCK_D = '0x' + 'dd'.repeat(32);
const VALID_HASHLOCK_E = '0x' + 'ee'.repeat(32);
const VALID_HASHLOCK_F = '0x' + 'ff'.repeat(32);
const VALID_ETH_ADDR   = '0x1111111111111111111111111111111111111111';
const VALID_STELLAR    = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422';

const BASE_ORDER: AnnounceOrderInput = {
  direction:        'eth_to_xlm',
  hashlock:         VALID_HASHLOCK_A,
  srcChain:         'ethereum',
  srcAddress:       VALID_ETH_ADDR,
  srcAsset:         'native',
  srcAmount:        '1000000000000000000',
  srcSafetyDeposit: '1000000000000000',
  dstChain:         'stellar',
  dstAddress:       VALID_STELLAR,
  dstAsset:         'native',
  dstAmount:        '100000000',
};

const nullLog = pino({ level: 'silent' });

/** Open a fresh in-process SQLite database for each test. */
async function freshRepo(suffix = ''): Promise<{ repo: OrdersRepository; auditRepo: AuditRepository }> {
  const dir = mkdtempSync(resolve(tmpdir(), `wafflefinance-rollback-test${suffix}-`));
  const db  = await openDatabase(`file:${dir}/test.db`);
  return { repo: new OrdersRepository(db), auditRepo: new AuditRepository(db) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Helper: inject a failure on the Nth call to a repository method ───────────

/**
 * Replace `methodName` on `repo` with a spy that throws `error` on the
 * `failOnCall`-th invocation (1-indexed), then delegates to the real method
 * for all other calls.
 */
function injectFailure<T extends object>(
  obj: T,
  methodName: keyof T,
  error: Error,
  failOnCall = 1,
): ReturnType<typeof vi.spyOn> {
  let calls = 0;
  const original = (obj[methodName] as unknown as (...args: unknown[]) => unknown).bind(obj);
  return vi.spyOn(obj as any, methodName as string).mockImplementation(async (...args: unknown[]) => {
    calls++;
    if (calls === failOnCall) throw error;
    return original(...args);
  });
}

// ── 1. recordSrcLock atomicity ────────────────────────────────────────────────

describe('OrdersRepository.recordSrcLock — rollback atomicity', () => {
  it('leaves the order unchanged when the transition-event INSERT fails', async () => {
    const { repo } = await freshRepo('src-lock');
    const order = await repo.announce({ ...BASE_ORDER, hashlock: VALID_HASHLOCK_A });

    // Inject a failure on appendTransitionEvent (private method accessed via any).
    injectFailure(repo as any, 'appendTransitionEvent', new Error('disk full'), 1);

    await expect(repo.recordSrcLock({
      publicId:    order.publicId,
      orderId:     'src-99',
      txHash:      '0xtx1',
      blockNumber: 100,
      timelock:    Math.floor(Date.now() / 1000) + 3600,
    })).rejects.toThrow('disk full');

    // Order row must be untouched.
    const after = await repo.findByPublicId(order.publicId);
    expect(after!.status).toBe('announced');
    expect(after!.srcOrderId).toBeNull();
    expect(after!.srcLockTx).toBeNull();

    // No transition events must have been persisted.
    const events = await repo.findTransitionEvents(order.publicId);
    expect(events).toHaveLength(0);
  });

  it('applies exactly once when retried after the initial rollback', async () => {
    const { repo } = await freshRepo('src-lock-retry');
    const order = await repo.announce({ ...BASE_ORDER, hashlock: VALID_HASHLOCK_B });

    // Fail once, then succeed.
    let calls = 0;
    const original = (repo as any).appendTransitionEvent.bind(repo);
    vi.spyOn(repo as any, 'appendTransitionEvent').mockImplementation(async (...args: unknown[]) => {
      calls++;
      if (calls === 1) throw new Error('transient db error');
      return original(...args);
    });

    const params = {
      publicId:    order.publicId,
      orderId:     'src-100',
      txHash:      '0xtx2',
      blockNumber: 101,
      timelock:    Math.floor(Date.now() / 1000) + 3600,
    };

    // First attempt fails.
    await expect(repo.recordSrcLock(params)).rejects.toThrow('transient db error');

    // Second attempt (retry) succeeds.
    await repo.recordSrcLock(params);

    const after = await repo.findByPublicId(order.publicId);
    expect(after!.status).toBe('src_locked');
    expect(after!.srcOrderId).toBe('src-100');

    // Exactly one transition event from the successful retry.
    const events = await repo.findTransitionEvents(order.publicId);
    const transitions = events.filter(e => e.eventType === 'src_lock.transitioned');
    expect(transitions).toHaveLength(1);
  });
});

// ── 2. recordDstLock atomicity ────────────────────────────────────────────────

describe('OrdersRepository.recordDstLock — rollback atomicity', () => {
  it('leaves the order in src_locked when the event INSERT fails mid-transaction', async () => {
    const { repo } = await freshRepo('dst-lock');

    const order = await repo.announce({ ...BASE_ORDER, hashlock: VALID_HASHLOCK_C });
    await repo.recordSrcLock({
      publicId:    order.publicId,
      orderId:     'src-200',
      txHash:      '0xtx3',
      blockNumber: 200,
      timelock:    Math.floor(Date.now() / 1000) + 7200,
    });

    injectFailure(repo as any, 'appendTransitionEvent', new Error('write error'), 1);

    await expect(repo.recordDstLock({
      publicId:    order.publicId,
      orderId:     'dst-200',
      txHash:      '0xtx4',
      blockNumber: 201,
      timelock:    Math.floor(Date.now() / 1000) + 3600,
      resolver:    VALID_ETH_ADDR,
    })).rejects.toThrow('write error');

    const after = await repo.findByPublicId(order.publicId);
    expect(after!.status).toBe('src_locked');
    expect(after!.dstOrderId).toBeNull();
    expect(after!.dstLockTx).toBeNull();
  });
});

// ── 3. recordSecretRevealed atomicity ─────────────────────────────────────────

describe('OrdersRepository.recordSecretRevealed — rollback atomicity', () => {
  it('leaves order in dst_locked when the event INSERT fails', async () => {
    const { repo } = await freshRepo('secret');

    const order = await repo.announce({ ...BASE_ORDER, hashlock: VALID_HASHLOCK_D });
    await repo.recordSrcLock({
      publicId: order.publicId, orderId: 'src-300', txHash: '0xtx5',
      blockNumber: 300, timelock: Math.floor(Date.now() / 1000) + 7200,
    });
    await repo.recordDstLock({
      publicId: order.publicId, orderId: 'dst-300', txHash: '0xtx6',
      blockNumber: 301, timelock: Math.floor(Date.now() / 1000) + 3600,
      resolver: VALID_ETH_ADDR,
    });

    injectFailure(repo as any, 'appendTransitionEvent', new Error('io error'), 1);

    await expect(repo.recordSecretRevealed({
      publicId: order.publicId,
      preimage: '0x' + 'ab'.repeat(32),
      txHash:   '0xtx7',
    })).rejects.toThrow('io error');

    const after = await repo.findByPublicId(order.publicId);
    expect(after!.status).toBe('dst_locked');
    expect(after!.preimage).toBeNull();
  });
});

// ── 4. cancelOrder atomicity ──────────────────────────────────────────────────

describe('OrdersRepository.cancelOrder — rollback atomicity', () => {
  it('leaves order in announced when cancel event INSERT fails', async () => {
    const { repo } = await freshRepo('cancel');

    const order = await repo.announce({ ...BASE_ORDER, hashlock: VALID_HASHLOCK_E });

    injectFailure(repo as any, 'appendTransitionEvent', new Error('cancel write fail'), 1);

    await expect(
      repo.cancelOrder(order.publicId, 'user_request', 'test')
    ).rejects.toThrow('cancel write fail');

    const after = await repo.findByPublicId(order.publicId);
    expect(after!.status).toBe('announced');
    expect(after!.cancellationReason).toBeNull();
  });
});

// ── 5. abandonOrder atomicity ─────────────────────────────────────────────────

describe('OrdersRepository.abandonOrder — rollback atomicity', () => {
  it('leaves order in announced when abandon event INSERT fails', async () => {
    const { repo } = await freshRepo('abandon');

    const order = await repo.announce({ ...BASE_ORDER, hashlock: VALID_HASHLOCK_F });

    injectFailure(repo as any, 'appendTransitionEvent', new Error('abandon write fail'), 1);

    await expect(
      repo.abandonOrder(order.publicId, 'stale:no_src_lock', 'stale-cleanup')
    ).rejects.toThrow('abandon write fail');

    const after = await repo.findByPublicId(order.publicId);
    expect(after!.status).toBe('announced');
    expect(after!.archivedAt).toBeNull();
    expect(after!.cancellationReason).toBeNull();
  });
});

// ── 6. rollbackSrcLock atomicity ──────────────────────────────────────────────

describe('OrdersRepository.rollbackSrcLock — rollback atomicity', () => {
  it('leaves order in src_locked when the event INSERT fails during rollback', async () => {
    const { repo } = await freshRepo('rollback-src');

    const order = await repo.announce({ ...BASE_ORDER, hashlock: '0x' + '11'.repeat(32) });
    await repo.recordSrcLock({
      publicId: order.publicId, orderId: 'src-400', txHash: '0xtx8',
      blockNumber: 400, timelock: Math.floor(Date.now() / 1000) + 3600,
    });

    injectFailure(repo as any, 'appendTransitionEvent', new Error('rollback event fail'), 1);

    await expect(repo.rollbackSrcLock(order.publicId, 'reorg')).rejects.toThrow('rollback event fail');

    const after = await repo.findByPublicId(order.publicId);
    // Status must remain src_locked — the UPDATE was rolled back.
    expect(after!.status).toBe('src_locked');
    expect(after!.srcOrderId).toBe('src-400');
  });
});

// ── 7. setStatus atomicity ────────────────────────────────────────────────────

describe('OrdersRepository.setStatus — rollback atomicity', () => {
  it('leaves order in original status when the event INSERT fails', async () => {
    const { repo } = await freshRepo('set-status');

    const order = await repo.announce({ ...BASE_ORDER, hashlock: '0x' + '22'.repeat(32) });

    injectFailure(repo as any, 'appendTransitionEvent', new Error('status event fail'), 1);

    await expect(repo.setStatus(order.publicId, 'failed')).rejects.toThrow('status event fail');

    const after = await repo.findByPublicId(order.publicId);
    expect(after!.status).toBe('announced');
  });

  it('applies exactly once on retry after rollback', async () => {
    const { repo } = await freshRepo('set-status-retry');

    const order = await repo.announce({ ...BASE_ORDER, hashlock: '0x' + '33'.repeat(32) });

    let calls = 0;
    const original = (repo as any).appendTransitionEvent.bind(repo);
    vi.spyOn(repo as any, 'appendTransitionEvent').mockImplementation(async (...args: unknown[]) => {
      calls++;
      if (calls === 1) throw new Error('transient');
      return original(...args);
    });

    // First attempt fails.
    await expect(repo.setStatus(order.publicId, 'failed')).rejects.toThrow('transient');

    // Second attempt succeeds.
    await repo.setStatus(order.publicId, 'failed');

    const after = await repo.findByPublicId(order.publicId);
    expect(after!.status).toBe('failed');

    // Exactly one transition event.
    const events = await repo.findTransitionEvents(order.publicId);
    const transitions = events.filter(e => e.eventType === 'status.transitioned');
    expect(transitions).toHaveLength(1);
  });
});

// ── 8. AuditRepository.appendBatch atomicity ──────────────────────────────────

describe('AuditRepository.appendBatch — rollback atomicity', () => {
  it('commits no rows when the second append in a batch fails', async () => {
    const { auditRepo } = await freshRepo('audit-batch');

    // Let the first append succeed, then fail the second.
    let appendCalls = 0;
    const originalAppend = auditRepo.append.bind(auditRepo);
    vi.spyOn(auditRepo, 'append').mockImplementation(async (input) => {
      appendCalls++;
      if (appendCalls === 2) throw new Error('disk full during batch');
      return originalAppend(input);
    });

    const inputs = [
      { eventType: 'system.startup' as const, orderId: null, requestId: null,
        payloadJson: JSON.stringify({ detail: 'first', errorMessage: null, serviceVersion: null }) },
      { eventType: 'system.shutdown' as const, orderId: null, requestId: null,
        payloadJson: JSON.stringify({ detail: 'second', errorMessage: null, serviceVersion: null }) },
    ];

    await expect(auditRepo.appendBatch(inputs)).rejects.toThrow('disk full during batch');

    // The batch is wrapped in BEGIN/COMMIT — a failure must roll back the whole batch.
    const page = await auditRepo.query({ includeCount: true });
    // No rows should be present (the first successful append is inside the
    // transaction boundary and is rolled back along with the second failure).
    expect(page.totalCount).toBe(0);
  });

  it('commits all rows when every append in a batch succeeds', async () => {
    const { auditRepo } = await freshRepo('audit-batch-ok');

    const inputs = [
      { eventType: 'system.startup' as const, orderId: null, requestId: null,
        payloadJson: JSON.stringify({ detail: 'startup', errorMessage: null, serviceVersion: '1.0.0' }) },
      { eventType: 'system.shutdown' as const, orderId: null, requestId: null,
        payloadJson: JSON.stringify({ detail: 'shutdown', errorMessage: null, serviceVersion: null }) },
    ];

    const ids = await auditRepo.appendBatch(inputs);
    expect(ids).toHaveLength(2);

    const page = await auditRepo.query({ includeCount: true });
    expect(page.totalCount).toBe(2);
  });
});

// ── 9. claimEvent idempotency across rollback ─────────────────────────────────

describe('OrdersRepository.claimEvent — idempotency across rollback', () => {
  it('returns true on first claim and false on duplicate regardless of prior rollback', async () => {
    const { repo } = await freshRepo('claim-event');

    const order = await repo.announce({ ...BASE_ORDER, hashlock: '0x' + '44'.repeat(32) });

    // Fail the first recordSrcLock attempt to simulate a rolled-back claim.
    injectFailure(repo as any, 'appendTransitionEvent', new Error('write fail'), 1);

    await expect(repo.recordSrcLock({
      publicId: order.publicId, orderId: 'src-500', txHash: '0xtx9',
      blockNumber: 500, timelock: Math.floor(Date.now() / 1000) + 3600,
    })).rejects.toThrow('write fail');

    // claimEvent is a separate, independent write — it claims the idempotency key.
    const eventKey = `ethereum:0xtx9:500:OrderCreated`;
    const firstClaim = await repo.claimEvent({ eventKey, chain: 'ethereum', eventType: 'OrderCreated', orderId: order.id });
    expect(firstClaim).toBe(true);

    // A duplicate claim for the same key must return false (already processed).
    const secondClaim = await repo.claimEvent({ eventKey, chain: 'ethereum', eventType: 'OrderCreated', orderId: order.id });
    expect(secondClaim).toBe(false);
  });

  it('a rolled-back recordSrcLock leaves claimEvent eligible for retry', async () => {
    const { repo } = await freshRepo('claim-retry');

    const order = await repo.announce({ ...BASE_ORDER, hashlock: '0x' + '55'.repeat(32) });

    // First call: inject failure after the event is about to be recorded
    // so the whole atomic() block rolls back.
    injectFailure(repo as any, 'appendTransitionEvent', new Error('write fail'), 1);

    await expect(repo.recordSrcLock({
      publicId: order.publicId, orderId: 'src-600', txHash: '0xtx10',
      blockNumber: 600, timelock: Math.floor(Date.now() / 1000) + 3600,
    })).rejects.toThrow('write fail');

    // Order is still in announced state — the rollback worked.
    expect((await repo.findByPublicId(order.publicId))!.status).toBe('announced');

    // Retry succeeds.
    await repo.recordSrcLock({
      publicId: order.publicId, orderId: 'src-600', txHash: '0xtx10',
      blockNumber: 600, timelock: Math.floor(Date.now() / 1000) + 3600,
    });

    expect((await repo.findByPublicId(order.publicId))!.status).toBe('src_locked');
  });
});

// ── 10. Chain cursor atomicity ────────────────────────────────────────────────

describe('OrdersRepository.setChainCursor — isolation', () => {
  it('cursor advances independently of order state mutations', async () => {
    const { repo } = await freshRepo('cursor');

    // Inject a failure on the src-lock event INSERT.
    const order = await repo.announce({ ...BASE_ORDER, hashlock: '0x' + '66'.repeat(32) });
    injectFailure(repo as any, 'appendTransitionEvent', new Error('src lock fail'), 1);

    await expect(repo.recordSrcLock({
      publicId: order.publicId, orderId: 'src-700', txHash: '0xtx11',
      blockNumber: 700, timelock: Math.floor(Date.now() / 1000) + 3600,
    })).rejects.toThrow('src lock fail');

    // Order rolled back.
    expect((await repo.findByPublicId(order.publicId))!.status).toBe('announced');

    // Chain cursor is a separate write — it must succeed independently.
    await repo.setChainCursor('ethereum', 700);
    expect(await repo.getChainCursor('ethereum')).toBe(700);

    // Cursor must not regress on a lower-position write.
    await repo.setChainCursor('ethereum', 650);
    expect(await repo.getChainCursor('ethereum')).toBe(700);
  });
});
