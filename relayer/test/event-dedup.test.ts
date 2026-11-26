/**
 * @fileoverview Tests for replay-safe relay event deduplication (#1085).
 *
 * Acceptance criteria covered:
 *   - Reprocessing an identical event has no second transaction side effect.
 *   - A conflicting event is logged and surfaced for investigation rather
 *     than silently ignored.
 * Also covers: chain-qualified identity, overlapping replay windows,
 * bounded cache eviction, and durable restart.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  RelayEventDeduplicator,
  computeRelayEventIdentity,
  isTerminalRelayKind,
  isContradictoryTerminal,
  createDeduplicatingHandler,
} from '../src/events/event-dedup.js';
import {
  createEthHtlcEvent,
  createSolanaOrderEvent,
  createStellarSettlementEvent,
  type NormalizedRelayEvent,
} from '../src/events/relay-event.js';

function ethEvent(opts: Partial<NormalizedRelayEvent> & { orderId: string; eventKind?: NormalizedRelayEvent['eventKind']; txHash?: string; logIndex?: number; blockNumber?: number }): NormalizedRelayEvent {
  return createEthHtlcEvent({
    eventKind: opts.eventKind ?? 'order_created',
    orderId: opts.orderId,
    txHash: opts.txHash ?? '0xtx1',
    blockNumber: opts.blockNumber ?? 10,
    logIndex: opts.logIndex ?? 0,
  });
}

describe('computeRelayEventIdentity', () => {
  it('is chain-qualified and includes kind, tx, and log index', () => {
    const e = ethEvent({ orderId: 'o1', txHash: '0xabc', eventKind: 'order_claimed', logIndex: 3, blockNumber: 9 });
    expect(computeRelayEventIdentity(e)).toBe('ethereum:order_claimed:0xabc:log:3');
  });

  it('collapses two deliveries of the same event to one identity', () => {
    const a = ethEvent({ orderId: 'o1', txHash: '0xabc', logIndex: 1 });
    const b = ethEvent({ orderId: 'o1', txHash: '0xabc', logIndex: 1, blockNumber: 11 });
    expect(computeRelayEventIdentity(a)).toBe(computeRelayEventIdentity(b));
  });

  it('distinguishes two different events in the same transaction by log index', () => {
    const a = ethEvent({ orderId: 'o1', txHash: '0xabc', logIndex: 0 });
    const b = ethEvent({ orderId: 'o2', txHash: '0xabc', logIndex: 1 });
    expect(computeRelayEventIdentity(a)).not.toBe(computeRelayEventIdentity(b));
  });

  it('distinguishes the same txHash across chains', () => {
    const evm = ethEvent({ orderId: 'o1', txHash: '0xabc', logIndex: 0 });
    const sol = createSolanaOrderEvent({ orderId: 'o1', txHash: '0xabc', slot: 5, eventKind: 'order_claimed' });
    expect(computeRelayEventIdentity(evm)).not.toBe(computeRelayEventIdentity(sol));
  });

  it('falls back to block number when no log index is present', () => {
    const e = createStellarSettlementEvent({ orderId: 'o1', txHash: '0xabc', ledgerSequence: 99 });
    expect(computeRelayEventIdentity(e)).toBe('soroban:settlement_confirmed:0xabc:ledger:99');
  });
});

describe('terminal + contradiction helpers', () => {
  it('treats claim, refund, and settlement as terminal', () => {
    expect(isTerminalRelayKind('order_claimed')).toBe(true);
    expect(isTerminalRelayKind('order_refunded')).toBe(true);
    expect(isTerminalRelayKind('settlement_confirmed')).toBe(true);
    expect(isTerminalRelayKind('order_expired')).toBe(false);
    expect(isTerminalRelayKind('order_created')).toBe(false);
  });

  it('flags claim-then-refund and refund-then-claim as contradictory', () => {
    expect(isContradictoryTerminal('order_claimed', 'order_refunded')).toBe(true);
    expect(isContradictoryTerminal('order_refunded', 'order_claimed')).toBe(true);
  });

  it('does not flag the same kind as contradictory', () => {
    expect(isContradictoryTerminal('order_claimed', 'order_claimed')).toBe(false);
  });

  it('allows expired -> refund (normal progression, not a conflict)', () => {
    expect(isContradictoryTerminal('order_expired', 'order_refunded')).toBe(false);
  });
});

describe('RelayEventDeduplicator — exact duplicates', () => {
  let dedup: RelayEventDeduplicator;

  beforeEach(() => {
    dedup = new RelayEventDeduplicator();
  });

  it('applies a novel event and reports shouldApply=true', () => {
    const e = ethEvent({ orderId: 'o1', txHash: '0x1', eventKind: 'order_claimed', logIndex: 0 });
    const r = dedup.process(e);
    expect(r.duplicate).toBe(false);
    expect(r.conflict).toBeUndefined();
    expect(r.shouldApply).toBe(true);
  });

  it('reprocessing an identical event is a duplicate with no side effect', () => {
    const e = ethEvent({ orderId: 'o1', txHash: '0x1', eventKind: 'order_claimed', logIndex: 0 });
    dedup.process(e);
    const r = dedup.process(e);
    expect(r.duplicate).toBe(true);
    expect(r.shouldApply).toBe(false);
    expect(r.conflict).toBeUndefined();
  });

  it('a duplicate within an overlapping replay window is still a duplicate', () => {
    const e = ethEvent({ orderId: 'o1', txHash: '0x1', eventKind: 'order_claimed', logIndex: 0, blockNumber: 5 });
    dedup.process(e);
    // Same event observed again during a re-scan that overlaps the prior window.
    const replayed = ethEvent({ orderId: 'o1', txHash: '0x1', eventKind: 'order_claimed', logIndex: 0, blockNumber: 5 });
    const r = dedup.process(replayed);
    expect(r.duplicate).toBe(true);
    expect(r.shouldApply).toBe(false);
  });

  it('classify() does not record state, process() does', () => {
    const e = ethEvent({ orderId: 'o1', txHash: '0x1', eventKind: 'order_claimed', logIndex: 0 });
    const peek = dedup.classify(e);
    expect(peek.shouldApply).toBe(true);
    expect(dedup.size()).toBe(0); // classify did not persist
    dedup.process(e);
    expect(dedup.size()).toBe(1);
  });
});

describe('RelayEventDeduplicator — contradictory terminal events', () => {
  let dedup: RelayEventDeduplicator;

  beforeEach(() => {
    dedup = new RelayEventDeduplicator();
  });

  it('surfaces a conflict when a refund arrives after a claim for the same order', () => {
    const claim = ethEvent({ orderId: 'o1', txHash: '0xclaim', eventKind: 'order_claimed', logIndex: 0 });
    const refund = ethEvent({ orderId: 'o1', txHash: '0xrefund', eventKind: 'order_refunded', logIndex: 1 });

    const rClaim = dedup.process(claim);
    expect(rClaim.shouldApply).toBe(true);

    const rRefund = dedup.process(refund);
    expect(rRefund.shouldApply).toBe(false);
    expect(rRefund.conflict).toBeDefined();
    expect(rRefund.conflict!.orderId).toBe('o1');
    expect(rRefund.conflict!.existingTerminalKind).toBe('order_claimed');
    expect(rRefund.conflict!.newEventKind).toBe('order_refunded');
    expect(rRefund.conflict!.existingIdentity).toBe(computeRelayEventIdentity(claim));
    expect(rRefund.conflict!.newIdentity).toBe(computeRelayEventIdentity(refund));
  });

  it('surfaces a conflict in the reverse direction (claim after refund)', () => {
    const refund = ethEvent({ orderId: 'o1', txHash: '0xrefund', eventKind: 'order_refunded', logIndex: 0 });
    const claim = ethEvent({ orderId: 'o1', txHash: '0xclaim', eventKind: 'order_claimed', logIndex: 1 });
    dedup.process(refund);
    const r = dedup.process(claim);
    expect(r.conflict).toBeDefined();
    expect(r.conflict!.existingTerminalKind).toBe('order_refunded');
    expect(r.conflict!.newEventKind).toBe('order_claimed');
  });

  it('expired then refund is NOT a conflict (normal progression)', () => {
    const expired = ethEvent({ orderId: 'o1', txHash: '0xexp', eventKind: 'order_expired', logIndex: 0 });
    const refund = ethEvent({ orderId: 'o1', txHash: '0xrefund', eventKind: 'order_refunded', logIndex: 1 });
    dedup.process(expired);
    const r = dedup.process(refund);
    expect(r.conflict).toBeUndefined();
    expect(r.shouldApply).toBe(true);
  });

  it('a second claim for a different order is applied, not a conflict', () => {
    const claim1 = ethEvent({ orderId: 'o1', txHash: '0xc1', eventKind: 'order_claimed', logIndex: 0 });
    const claim2 = ethEvent({ orderId: 'o2', txHash: '0xc2', eventKind: 'order_claimed', logIndex: 0 });
    dedup.process(claim1);
    const r = dedup.process(claim2);
    expect(r.conflict).toBeUndefined();
    expect(r.shouldApply).toBe(true);
  });

  it('records the first terminal per order; a later contradictory one does not overwrite', () => {
    const claim = ethEvent({ orderId: 'o1', txHash: '0xc', eventKind: 'order_claimed', logIndex: 0 });
    dedup.process(claim);
    expect(dedup.terminalOrderCount()).toBe(1);
    const refund = ethEvent({ orderId: 'o1', txHash: '0xr', eventKind: 'order_refunded', logIndex: 1 });
    dedup.process(refund);
    expect(dedup.terminalOrderCount()).toBe(1); // not overwritten
  });
});

describe('RelayEventDeduplicator — bounded cache', () => {
  it('evicts the oldest applied entry once the cap is reached', () => {
    const dedup = new RelayEventDeduplicator({ maxApplied: 3 });
    for (let i = 0; i < 3; i++) {
      dedup.process(ethEvent({ orderId: `o${i}`, txHash: `0x${i}`, eventKind: 'order_created', logIndex: i }));
    }
    expect(dedup.size()).toBe(3);
    // A 4th distinct event evicts the oldest (o0).
    dedup.process(ethEvent({ orderId: 'o3', txHash: '0x3', eventKind: 'order_created', logIndex: 3 }));
    expect(dedup.size()).toBe(3);
    const firstIdentity = computeRelayEventIdentity(ethEvent({ orderId: 'o0', txHash: '0x0', eventKind: 'order_created', logIndex: 0 }));
    expect(dedup.getApplied(firstIdentity)).toBeUndefined();
  });
});

describe('RelayEventDeduplicator — durable restart', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'event-dedup-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('survives a restart: an event applied before restart is a duplicate after', () => {
    const claim = ethEvent({ orderId: 'o1', txHash: '0xc', eventKind: 'order_claimed', logIndex: 0 });
    const before = new RelayEventDeduplicator({ storageDir: dir });
    before.process(claim);

    // Simulate a restart by constructing a new deduplicator on the same dir.
    const after = new RelayEventDeduplicator({ storageDir: dir });
    const r = after.process(claim);
    expect(r.duplicate).toBe(true);
    expect(r.shouldApply).toBe(false);
  });

  it('persists the recorded terminal so a post-restart contradiction is still a conflict', () => {
    const claim = ethEvent({ orderId: 'o1', txHash: '0xc', eventKind: 'order_claimed', logIndex: 0 });
    new RelayEventDeduplicator({ storageDir: dir }).process(claim);

    const after = new RelayEventDeduplicator({ storageDir: dir });
    const refund = ethEvent({ orderId: 'o1', txHash: '0xr', eventKind: 'order_refunded', logIndex: 1 });
    const r = after.process(refund);
    expect(r.conflict).toBeDefined();
    expect(r.conflict!.existingTerminalKind).toBe('order_claimed');
  });

  it('does not persist sensitive material (no secrets in stored records)', () => {
    // Even if an event carried a preimage in routingMeta, the dedup record
    // stores only identity/orderId/kind/txHash — never routingMeta contents.
    const e = createEthHtlcEvent({
      eventKind: 'secret_revealed',
      orderId: 'o1',
      txHash: '0xtx',
      blockNumber: 5,
      logIndex: 2,
      preimage: '0xSUPERSECRETPREIMAGE1234567890ABCDEF',
    });
    const dedup = new RelayEventDeduplicator({ storageDir: dir });
    dedup.process(e);
    const files = readdirSync(dir);
    expect(files.length).toBeGreaterThan(0);
    const stored = files.map((f) => readFileSync(join(dir, f), 'utf-8')).join('\n');
    expect(stored).not.toContain('SUPERSECRETPREIMAGE');
    expect(stored).not.toContain('preimage');
  });
});

describe('createDeduplicatingHandler', () => {
  let dedup: RelayEventDeduplicator;

  beforeEach(() => {
    dedup = new RelayEventDeduplicator();
  });

  it('calls the inner handler exactly once for a novel event', async () => {
    const inner = { handle: async (_e: NormalizedRelayEvent) => {} };
    const spy = (inner.handle = (() => { /* assigned below */ }) as unknown);
    const calls: string[] = [];
    const innerHandler = async (e: NormalizedRelayEvent) => { calls.push(e.orderId); };
    const wrapped = createDeduplicatingHandler(innerHandler, dedup);
    const e = ethEvent({ orderId: 'o1', txHash: '0x1', eventKind: 'order_claimed', logIndex: 0 });
    void spy;
    await wrapped(e);
    expect(calls).toEqual(['o1']);
  });

  it('does not call the inner handler for an exact duplicate (no second side effect)', async () => {
    const calls: string[] = [];
    const innerHandler = async (e: NormalizedRelayEvent) => { calls.push(e.orderId); };
    const wrapped = createDeduplicatingHandler(innerHandler, dedup);
    const e = ethEvent({ orderId: 'o1', txHash: '0x1', eventKind: 'order_claimed', logIndex: 0 });
    await wrapped(e);
    await wrapped(e);
    expect(calls).toEqual(['o1']); // applied once, duplicate skipped
  });

  it('reports a conflict and does not call the inner handler for a contradiction', async () => {
    const calls: string[] = [];
    const innerHandler = async (e: NormalizedRelayEvent) => { calls.push(e.orderId); };
    const conflicts: string[] = [];
    const wrapped = createDeduplicatingHandler(innerHandler, dedup, (conflict) => {
      conflicts.push(conflict.orderId);
    });
    const claim = ethEvent({ orderId: 'o1', txHash: '0xc', eventKind: 'order_claimed', logIndex: 0 });
    const refund = ethEvent({ orderId: 'o1', txHash: '0xr', eventKind: 'order_refunded', logIndex: 1 });
    await wrapped(claim);
    await wrapped(refund);
    expect(calls).toEqual(['o1']); // claim applied, refund not
    expect(conflicts).toEqual(['o1']); // refund surfaced as conflict
  });
});
