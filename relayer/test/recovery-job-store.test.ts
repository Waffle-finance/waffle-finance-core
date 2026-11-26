/**
 * @fileoverview Unit tests for durable recovery-job persistence (#1083).
 *
 * Covers redaction of secrets, eligibility classification, and disk
 * round-trip. The integration test for restart resumption lives in
 * `recovery-persistence.test.ts`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  RecoveryJobStore,
  redactRecoveryOrder,
  redactSecrets,
  isJobEligibleToResume,
  type PersistedRecoveryJob,
} from '../src/services/recovery/RecoveryJobStore.js';
import type { RecoveryOrder } from '../src/services/recovery/IRecoveryService.js';

describe('redactSecrets', () => {
  it('strips keys that look like secrets, keeps everything else', () => {
    const input = {
      orderId: 'wf_1',
      preimage: '0xSECRET_PREIMAGE',
      secret: 's',
      privateKey: '0xKEY',
      signingKey: '0xSIGNER',
      seed: 'seedval',
      metadata: {
        hashlock: '0xabc',
        preimage: '0xNESTED_PREIMAGE',
        secretKey: '0xNESTED_SECRET',
        amount: '10',
      },
    };
    const out = redactSecrets(input) as Record<string, unknown>;
    expect(out.orderId).toBe('wf_1');
    expect(out.preimage).toBeUndefined();
    expect(out.secret).toBeUndefined();
    expect(out.privateKey).toBeUndefined();
    expect(out.signingKey).toBeUndefined();
    expect(out.seed).toBeUndefined();
    expect((out.metadata as Record<string, unknown>).hashlock).toBe('0xabc');
    expect((out.metadata as Record<string, unknown>).amount).toBe('10');
    expect((out.metadata as Record<string, unknown>).preimage).toBeUndefined();
    expect((out.metadata as Record<string, unknown>).secretKey).toBeUndefined();
  });

  it('preserves hashlock-like keys (hashes are not secrets)', () => {
    const out = redactSecrets({ hashlock: '0xhash', preimageHash: '0xph' }) as Record<string, unknown>;
    expect(out.hashlock).toBe('0xhash');
    expect(out.preimageHash).toBe('0xph');
  });

  it('recurses through arrays', () => {
    const out = redactSecrets([{ preimage: 'x', ok: 1 }, { ok: 2 }]) as Array<Record<string, unknown>>;
    expect(out[0].preimage).toBeUndefined();
    expect(out[0].ok).toBe(1);
    expect(out[1].ok).toBe(2);
  });
});

describe('redactRecoveryOrder', () => {
  it('redacts order.metadata but preserves identifier/on-chain fields', () => {
    const order: RecoveryOrder = {
      publicId: 'wf_1',
      orderHash: '0xorderhash',
      status: 'expired',
      srcChain: 'ethereum',
      dstChain: 'stellar',
      srcTimelock: 1000,
      dstTimelock: 800,
      makingAmount: '10',
      takingAmount: '20',
      srcAsset: 'ETH',
      takerAsset: 'XLM',
      metadata: {
        preimage: '0xLEAKED_PREIMAGE',
        refundAddress: '0xrefund',
        anything: 'kept',
      },
    };
    const out = redactRecoveryOrder(order);
    expect(out.publicId).toBe('wf_1');
    expect(out.orderHash).toBe('0xorderhash');
    expect(out.srcTimelock).toBe(1000);
    expect(out.metadata?.preimage).toBeUndefined();
    expect(out.metadata?.refundAddress).toBe('0xrefund');
    expect(out.metadata?.anything).toBe('kept');
    // Original is not mutated.
    expect(order.metadata?.preimage).toBe('0xLEAKED_PREIMAGE');
  });

  it('handles an order with no metadata', () => {
    const out = redactRecoveryOrder({ publicId: 'wf_1', status: 'expired', srcChain: 'ethereum', dstChain: 'stellar' });
    expect(out.publicId).toBe('wf_1');
    expect(out.metadata).toBeUndefined();
  });
});

describe('isJobEligibleToResume', () => {
  it('pending and in_progress are eligible', () => {
    expect(isJobEligibleToResume('pending', 123)).toBe(true);
    expect(isJobEligibleToResume('in_progress', null)).toBe(true);
  });

  it('completed, cancelled, requires_review are NOT eligible', () => {
    expect(isJobEligibleToResume('completed', null)).toBe(false);
    expect(isJobEligibleToResume('cancelled', null)).toBe(false);
    expect(isJobEligibleToResume('requires_review', null)).toBe(false);
  });

  it('failed is eligible only when a retry is still scheduled', () => {
    expect(isJobEligibleToResume('failed', 999)).toBe(true);
    expect(isJobEligibleToResume('failed', null)).toBe(false);
  });
});

describe('RecoveryJobStore — disk round-trip', () => {
  let dir: string;
  let store: RecoveryJobStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'recovery-job-store-'));
    store = new RecoveryJobStore({ storageDir: dir });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeJob(overrides: Partial<PersistedRecoveryJob> = {}): PersistedRecoveryJob {
    return {
      id: 'recovery_1',
      orderId: 'wf_1',
      orderHash: '0xhash',
      type: 'timeout_refund',
      status: 'pending',
      chain: 'ethereum',
      initiator: 'system',
      reason: 'Auto-recovery initiated',
      metadata: { expired: true, timelock: 1000 },
      createdAt: 100,
      updatedAt: 100,
      attempts: 0,
      lastAttemptAt: null,
      nextAttemptAt: 100,
      order: {
        publicId: 'wf_1',
        orderHash: '0xhash',
        status: 'expired',
        srcChain: 'ethereum',
        dstChain: 'stellar',
        metadata: { preimage: '0xSECRET', refundAddress: '0xrefund' },
      },
      savedAt: 0,
      ...overrides,
    };
  }

  it('persists and reloads jobs across a new store instance (restart)', () => {
    store.save(makeJob({ id: 'recovery_1', status: 'pending', nextAttemptAt: 100 }));
    store.save(makeJob({ id: 'recovery_2', status: 'completed', nextAttemptAt: null }));

    // Simulate a restart by constructing a new store on the same dir.
    const after = new RecoveryJobStore({ storageDir: dir });
    const all = after.loadAll();
    expect(all).toHaveLength(2);
    const eligible = after.loadEligible();
    expect(eligible).toHaveLength(1);
    expect(eligible[0].id).toBe('recovery_1');
  });

  it('updates a job in place when saved again with the same id', () => {
    store.save(makeJob({ id: 'recovery_1', status: 'pending', attempts: 0 }));
    store.save(makeJob({ id: 'recovery_1', status: 'in_progress', attempts: 1 }));
    const after = new RecoveryJobStore({ storageDir: dir });
    const job = after.loadAll().find((j) => j.id === 'recovery_1');
    expect(job?.status).toBe('in_progress');
    expect(job?.attempts).toBe(1);
  });

  it('never persists preimage or signing-key material', () => {
    store.save(
      makeJob({
        order: {
          publicId: 'wf_1',
          status: 'expired',
          srcChain: 'ethereum',
          dstChain: 'stellar',
          metadata: {
            preimage: '0xLEAKED_PREIMAGE_VALUE',
            secret: '0xLEAKED_SECRET',
            signingKey: '0xLEAKED_SIGNER',
            hashlock: '0xkeep',
            refundAddress: '0xkeep_refund',
          },
        },
      }),
    );
    const files = readdirSync(dir);
    expect(files.length).toBeGreaterThan(0);
    const stored = files.map((f) => readFileSync(join(dir, f), 'utf-8')).join('\n');
    expect(stored).not.toContain('LEAKED_PREIMAGE_VALUE');
    expect(stored).not.toContain('LEAKED_SECRET');
    expect(stored).not.toContain('LEAKED_SIGNER');
    expect(stored).toContain('0xkeep');
    expect(stored).toContain('0xkeep_refund');
  });

  it('remove deletes a job from both memory and disk', () => {
    store.save(makeJob({ id: 'recovery_1' }));
    store.remove('recovery_1');
    expect(store.size()).toBe(0);
    const after = new RecoveryJobStore({ storageDir: dir });
    expect(after.loadAll()).toHaveLength(0);
  });

  it('in-memory-only store (storageDir: null) never touches disk', () => {
    const mem = new RecoveryJobStore({ storageDir: null });
    mem.save(makeJob({ id: 'recovery_1' }));
    expect(mem.loadAll()).toHaveLength(1);
    expect(mem.size()).toBe(1);
    // No disk operations; clear is a safe no-op.
    mem.clear();
    expect(mem.size()).toBe(0);
  });
});
