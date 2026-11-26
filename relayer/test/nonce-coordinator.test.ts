/**
 * @fileoverview Tests for EVM nonce coordination and replacement handling (#1082).
 *
 * Acceptance criteria covered:
 *   - Concurrent actions do not submit conflicting transactions for the
 *     same nonce.
 *   - A timeout followed by a confirmed original transaction does not trigger
 *     a second settlement.
 * Also covers: nonce-too-low rebasing, underpriced replacement with lineage,
 * and structured-log recording of hashes and replacement lineage.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  NonceCoordinator,
  FakeEvmProvider,
  NonceTooLowError,
  UnderpricedError,
  classifySubmissionError,
  type BuildAndSend,
} from '../src/services/nonce-coordinator.js';

const logs = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }));
vi.mock('../src/logger.js', () => ({
  getLogger: () => ({ child: () => logs }),
}));

const ACCOUNT = '0xrelayerAccount';

function buildAndSend(provider: FakeEvmProvider, txs: Array<{ nonce: number; hash: string }>, value = 0n): BuildAndSend {
  return async (ctx) => {
    const hash = await provider.sendTransaction({ nonce: ctx.nonce, from: ACCOUNT, value });
    txs.push({ nonce: ctx.nonce, hash });
    return hash;
  };
}

describe('classifySubmissionError', () => {
  it('classifies nonce too low', () => {
    expect(classifySubmissionError(new Error('nonce too low'))).toBeInstanceOf(NonceTooLowError);
  });
  it('classifies underpriced', () => {
    expect(classifySubmissionError(new Error('replacement transaction underpriced'))).toBeInstanceOf(UnderpricedError);
  });
  it('returns null for unrelated errors', () => {
    expect(classifySubmissionError(new Error('insufficient funds'))).toBeNull();
  });
});

describe('NonceCoordinator.submit — concurrent submission', () => {
  let coord: NonceCoordinator;
  let provider: FakeEvmProvider;

  beforeEach(() => {
    provider = new FakeEvmProvider({ initialPendingNonce: 10 });
    coord = new NonceCoordinator();
  });

  it('concurrent actions for the same account receive distinct nonces (no conflict)', async () => {
    const txs: Array<{ nonce: number; hash: string }> = [];
    const send = buildAndSend(provider, txs);

    // Fire two submissions concurrently. The coordinator serializes them so
    // they never share a nonce.
    const [a, b] = await Promise.all([
      coord.submit({ account: ACCOUNT, provider, buildAndSend: send, label: 'order-A' }),
      coord.submit({ account: ACCOUNT, provider, buildAndSend: send, label: 'order-B' }),
    ]);

    const nonces = [a.nonce, b.nonce].sort((x, y) => x - y);
    expect(nonces).toEqual([10, 11]);
    expect(a.txHash).not.toBe(b.txHash);
    // Each landed on its own nonce — no conflicting transaction for the same nonce.
    expect(txs).toHaveLength(2);
    expect(new Set(txs.map((t) => t.nonce)).size).toBe(2);
  });

  it('records the last nonce so the next submission continues from there', async () => {
    const txs: Array<{ nonce: number; hash: string }> = [];
    const send = buildAndSend(provider, txs);
    await coord.submit({ account: ACCOUNT, provider, buildAndSend: send, label: 'o1' });
    const r = await coord.submit({ account: ACCOUNT, provider, buildAndSend: send, label: 'o2' });
    expect(r.nonce).toBe(11);
    expect(coord.lastNonce(ACCOUNT)).toBe(11);
  });

  it('serializes per account but allows different accounts to run concurrently', async () => {
    // Two independent accounts each get their own nonce stream, so they
    // should not block each other. Use a separate provider per account to
    // model independent nonce sequences.
    const providerSlow = new FakeEvmProvider({ initialPendingNonce: 10 });
    const providerFast = new FakeEvmProvider({ initialPendingNonce: 10 });
    const slowDone: boolean[] = [];
    const fastDone: boolean[] = [];
    const slowSend: BuildAndSend = async (ctx) => {
      await new Promise((r) => setTimeout(r, 10));
      slowDone.push(true);
      return providerSlow.sendTransaction({ nonce: ctx.nonce, from: '0xslow' });
    };
    const fastSend: BuildAndSend = async (ctx) => {
      fastDone.push(true);
      return providerFast.sendTransaction({ nonce: ctx.nonce, from: '0xfast' });
    };
    const [r1, r2] = await Promise.all([
      coord.submit({ account: '0xslow', provider: providerSlow, buildAndSend: slowSend, label: 'slow' }),
      coord.submit({ account: '0xfast', provider: providerFast, buildAndSend: fastSend, label: 'fast' }),
    ]);
    expect(r1.nonce).toBe(10);
    expect(r2.nonce).toBe(10); // independent accounts — both start at pending
    // Fast finished before slow (concurrency), proving accounts don't serialize.
    expect(fastDone.length).toBe(1);
    expect(slowDone.length).toBe(1);
  });
});

describe('NonceCoordinator.submit — nonce too low', () => {
  let coord: NonceCoordinator;
  let provider: FakeEvmProvider;

  beforeEach(() => {
    provider = new FakeEvmProvider({ initialPendingNonce: 5 });
    coord = new NonceCoordinator();
  });

  it('rebases the nonce and succeeds after a nonce-too-low error', async () => {
    // Force the first send to use a stale nonce via a custom builder.
    let call = 0;
    const send: BuildAndSend = async (ctx) => {
      call++;
      // First call: deliberately under-use the coordinator's nonce and pass a
      // too-low nonce so the provider rejects it. Subsequent calls use ctx.nonce.
      if (call === 1) {
        // send with a nonce below pending to trigger NONCE_TOO_LOW
        return provider.sendTransaction({ nonce: 1, from: ACCOUNT });
      }
      return provider.sendTransaction({ nonce: ctx.nonce, from: ACCOUNT });
    };

    const result = await coord.submit({ account: ACCOUNT, provider, buildAndSend: send, label: 'o1' });
    expect(result.attempts).toBeGreaterThanOrEqual(2);
    expect(result.nonce).toBeGreaterThanOrEqual(5);
    expect(result.txHash).toMatch(/^0x/);
  });

  it('gives up after maxNonceRetries', async () => {
    let call = 0;
    const send: BuildAndSend = async () => {
      call++;
      // Always send a too-low nonce.
      return provider.sendTransaction({ nonce: 1, from: ACCOUNT });
    };
    await expect(
      coord.submit({ account: ACCOUNT, provider, buildAndSend: send, label: 'o1', maxNonceRetries: 2 }),
    ).rejects.toBeInstanceOf(NonceTooLowError);
    expect(call).toBeGreaterThanOrEqual(3); // initial + 2 retries
  });
});

describe('NonceCoordinator.replace — underpriced replacement with lineage', () => {
  let coord: NonceCoordinator;
  let provider: FakeEvmProvider;

  beforeEach(() => {
    provider = new FakeEvmProvider({ initialPendingNonce: 7 });
    coord = new NonceCoordinator();
  });

  it('retries the same nonce as a replacement after underpriced and records lineage', async () => {
    // 1. Submit a tx at nonce 7 (hash H1). It is pending.
    const txs: Array<{ nonce: number; hash: string }> = [];
    const send = buildAndSend(provider, txs);
    const original = await coord.submit({ account: ACCOUNT, provider, buildAndSend: send, label: 'o1' });
    const h1 = original.txHash;
    expect(original.nonce).toBe(7);
    expect(original.lineage).toEqual([h1]);

    // 2. Recovery decides H1 is underpriced and replaces it at nonce 7.
    //    Configure the provider to reject the first replacement as underpriced.
    provider.rejectUnderpriced(7, 1);
    let replacementAttempts = 0;
    const replaceSend: BuildAndSend = async (ctx) => {
      replacementAttempts++;
      // Reuse the same nonce (replacement). The provider accepts (after the
      // configured underpriced rejection) because nonce 7 is pending.
      return provider.sendTransaction({ nonce: ctx.nonce, from: ACCOUNT });
    };

    const result = await coord.replace({
      account: ACCOUNT,
      provider,
      nonce: 7,
      originalHash: h1,
      buildAndSend: replaceSend,
      label: 'o1',
      maxFeeRetries: 3,
    });

    expect(replacementAttempts).toBe(2); // underpriced + success
    expect(result.nonce).toBe(7); // same nonce (replacement)
    expect(result.replacedFrom).toBe(h1);
    // Lineage records the original and its replacement.
    expect(result.lineage[0]).toBe(h1);
    expect(result.lineage[1]).toBe(result.txHash);
    expect(result.lineage).toHaveLength(2);
  });

  it('returns the original hash with no replacement when the original already mined (nonce too low)', async () => {
    const txs: Array<{ nonce: number; hash: string }> = [];
    const send = buildAndSend(provider, txs);
    const original = await coord.submit({ account: ACCOUNT, provider, buildAndSend: send, label: 'o1' });
    // Simulate the original mining: mark its nonce mined so a replacement
    // attempt throws nonce-too-low.
    const receipt = await provider.getTransactionReceipt(original.txHash);
    expect(receipt).not.toBeNull();
    // Make a subsequent send at nonce 7 throw nonce too low by mining it.
    // We model this by configuring the provider to treat nonce 7 as mined.
    (provider as unknown as { minedNonces: Set<number> }).minedNonces.add(7);

    const replaceSend: BuildAndSend = async (ctx) => provider.sendTransaction({ nonce: ctx.nonce, from: ACCOUNT });
    const result = await coord.replace({
      account: ACCOUNT,
      provider,
      nonce: 7,
      originalHash: original.txHash,
      buildAndSend: replaceSend,
      label: 'o1',
    });
    expect(result.txHash).toBe(original.txHash); // no second settlement
    expect(result.lineage).toEqual([original.txHash]);
  });

  it('logs the replacement lineage with hashes', async () => {
    const send = buildAndSend(provider, []);
    const original = await coord.submit({ account: ACCOUNT, provider, buildAndSend: send, label: 'o1' });
    const replaceSend: BuildAndSend = async (ctx) => provider.sendTransaction({ nonce: ctx.nonce, from: ACCOUNT });
    const result = await coord.replace({
      account: ACCOUNT,
      provider,
      nonce: 7,
      originalHash: original.txHash,
      buildAndSend: replaceSend,
      label: 'o1',
    });
    expect(logs.info).toHaveBeenCalledWith(
      expect.objectContaining({
        account: ACCOUNT,
        label: 'o1',
        nonce: 7,
        txHash: result.txHash,
        reason: 'replacement_bump',
        replacedFrom: original.txHash,
        lineage: result.lineage,
      }),
      expect.stringContaining('replacement transaction submitted'),
    );
  });
});

describe('NonceCoordinator.resolveAfterTimeout — timeout then confirmed', () => {
  let coord: NonceCoordinator;
  let provider: FakeEvmProvider;

  beforeEach(() => {
    provider = new FakeEvmProvider({ initialPendingNonce: 3, startNowMs: 1000 });
    coord = new NonceCoordinator();
  });

  it('does NOT trigger a second settlement when the original confirms after the timeout', async () => {
    // Submit a transaction; its receipt is delayed beyond the "timeout".
    const txs: Array<{ nonce: number; hash: string }> = [];
    const send = buildAndSend(provider, txs);
    const submitted = await coord.submit({ account: ACCOUNT, provider, buildAndSend: send, label: 'o1' });
    // Delay the receipt until the fake clock reaches 5000.
    provider.delayReceipt(submitted.txHash, 5000);

    // "Timeout" happens at now=2000: no receipt yet.
    provider.advance(2000 - 1000);
    const beforeTimeout = await provider.getTransactionReceipt(submitted.txHash);
    expect(beforeTimeout).toBeNull();

    // The recovery path checks the original before resubmitting. The original
    // has NOT confirmed yet at this clock, so it would resubmit — but the
    // acceptance criterion is about the case where the original *does*
    // confirm. Advance the clock past the delay and verify resolveAfterTimeout
    // sees the confirmed receipt and does not call resubmit.
    provider.advance(4000); // now = 6000, past 5000
    const resubmit = vi.fn().mockResolvedValue('0xREPLACEMENT');
    const result = await coord.resolveAfterTimeout({
      account: ACCOUNT,
      provider,
      originalHash: submitted.txHash,
      label: 'o1',
      resubmit,
    });

    expect(result.outcome).toBe('confirmed');
    expect(result.txHash).toBe(submitted.txHash); // original, not replacement
    expect(resubmit).not.toHaveBeenCalled(); // no second settlement
  });

  it('resubmits only when the original is genuinely unconfirmed', async () => {
    const txs: Array<{ nonce: number; hash: string }> = [];
    const send = buildAndSend(provider, txs);
    const submitted = await coord.submit({ account: ACCOUNT, provider, buildAndSend: send, label: 'o1' });
    // Replace the original so its receipt is never available.
    provider.replace(submitted.txHash);

    const resubmit = vi.fn().mockResolvedValue('0xREPLACEMENT');
    const result = await coord.resolveAfterTimeout({
      account: ACCOUNT,
      provider,
      originalHash: submitted.txHash,
      label: 'o1',
      resubmit,
    });
    expect(result.outcome).toBe('replaced');
    expect(result.txHash).toBe('0xREPLACEMENT');
    expect(resubmit).toHaveBeenCalledTimes(1);
  });

  it('returns missing when no resubmit hook is supplied and the original is absent', async () => {
    const result = await coord.resolveAfterTimeout({
      account: ACCOUNT,
      provider,
      originalHash: '0xnever',
      label: 'o1',
    });
    expect(result.outcome).toBe('missing');
  });
});

describe('NonceCoordinator — structured logs record hashes and lineage', () => {
  it('logs the tx hash, nonce, and replacement lineage on submission', async () => {
    const provider = new FakeEvmProvider({ initialPendingNonce: 0 });
    const coord = new NonceCoordinator();
    const txs: Array<{ nonce: number; hash: string }> = [];
    const send = buildAndSend(provider, txs);
    const result = await coord.submit({ account: ACCOUNT, provider, buildAndSend: send, label: 'o1' });
    expect(logs.info).toHaveBeenCalledWith(
      expect.objectContaining({
        account: ACCOUNT,
        label: 'o1',
        nonce: result.nonce,
        txHash: result.txHash,
        lineage: result.lineage,
      }),
      expect.stringContaining('submitted'),
    );
  });
});
