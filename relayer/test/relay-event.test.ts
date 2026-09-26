/**
 * Tests for the normalized relayer event routing contract.
 *
 * Covers:
 *  - createRelayEvent fills observedAt and routingMeta defaults.
 *  - Chain-specific factory helpers produce correct sourceChain and eventKind.
 *  - txHash is coerced to null when not supplied.
 *  - isNormalizedRelayEvent validates the contract correctly.
 *  - isValidRelayEventKind and isValidRelaySourceChain type guards.
 *  - All events are JSON-serialisable (no bigint/Date).
 *  - Events from Ethereum, Stellar/Soroban, and Solana follow the same schema.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createRelayEvent,
  createEthOrderCreatedEvent,
  createEthOrderClaimedEvent,
  createEthOrderRefundedEvent,
  createStellarSettlementEvent,
  createSolanaOrderEvent,
  isNormalizedRelayEvent,
  isValidRelayEventKind,
  isValidRelaySourceChain,
  parseLegacyRelayEvent,
  RELAY_EVENT_SCHEMA_VERSION,
  LEGACY_RELAY_EVENT_SCHEMA_VERSION,
  type NormalizedRelayEvent,
} from '../src/events/relay-event.js';

afterEach(() => {
  vi.useRealTimers();
});

// ── createRelayEvent ──────────────────────────────────────────────────────────

describe('createRelayEvent', () => {
  it('fills observedAt with Date.now() when not supplied', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const ev = createRelayEvent({
      sourceChain: 'ethereum',
      eventKind: 'order_created',
      orderId: 'order-1',
      txHash: '0xabc',
    });
    expect(ev.observedAt).toBe(1_700_000_000_000);
  });

  it('preserves a supplied observedAt', () => {
    const ev = createRelayEvent({
      sourceChain: 'ethereum',
      eventKind: 'order_created',
      orderId: 'order-1',
      txHash: '0xabc',
      observedAt: 12345,
    });
    expect(ev.observedAt).toBe(12345);
  });

  it('defaults routingMeta to an empty object', () => {
    const ev = createRelayEvent({
      sourceChain: 'solana',
      eventKind: 'order_claimed',
      orderId: 'order-2',
      txHash: null,
    });
    expect(ev.routingMeta).toEqual({});
  });

  it('coerces absent txHash to null', () => {
    const ev = createRelayEvent({
      sourceChain: 'ethereum',
      eventKind: 'order_created',
      orderId: 'order-1',
      txHash: null,
    });
    expect(ev.txHash).toBeNull();
  });
});

// ── Ethereum factories ────────────────────────────────────────────────────────

describe('createEthOrderCreatedEvent', () => {
  it('produces sourceChain=ethereum and eventKind=order_created', () => {
    const ev = createEthOrderCreatedEvent({
      orderId: '42',
      txHash: '0xdeadbeef',
      blockNumber: 18_000_000,
      hashlock: '0x' + 'ab'.repeat(32),
      timelock: 1_700_000_000,
      amount: '1000000000000000000',
      tokenAddress: '0x0',
      feeRateBps: 30,
      partialFillEnabled: false,
    });

    expect(ev.sourceChain).toBe('ethereum');
    expect(ev.eventKind).toBe('order_created');
    expect(ev.orderId).toBe('42');
    expect(ev.txHash).toBe('0xdeadbeef');
    expect(ev.routingMeta.blockNumber).toBe(18_000_000);
    expect(ev.routingMeta.hashlock).toBe('0x' + 'ab'.repeat(32));
    expect(ev.routingMeta.timelock).toBe(1_700_000_000);
    expect(ev.routingMeta.amount).toBe('1000000000000000000');
    expect(ev.routingMeta.feeRateBps).toBe(30);
    expect(ev.routingMeta.partialFillEnabled).toBe(false);
  });

  it('is JSON-serialisable (no bigint or Date)', () => {
    const ev = createEthOrderCreatedEvent({
      orderId: '1',
      txHash: '0xabc',
      blockNumber: 1,
      hashlock: '0x00',
      timelock: 0,
      amount: '0',
      tokenAddress: '0x0',
      feeRateBps: 0,
      partialFillEnabled: true,
    });
    expect(() => JSON.stringify(ev)).not.toThrow();
    const parsed = JSON.parse(JSON.stringify(ev)) as NormalizedRelayEvent;
    expect(parsed.orderId).toBe('1');
  });
});

describe('createEthOrderClaimedEvent', () => {
  it('produces eventKind=order_claimed with resolver address', () => {
    const ev = createEthOrderClaimedEvent({
      orderId: '99',
      txHash: '0xclaim',
      blockNumber: 999,
      amount: '500000000000000000',
      resolverAddress: '0xresolver',
    });

    expect(ev.eventKind).toBe('order_claimed');
    expect(ev.sourceChain).toBe('ethereum');
    expect(ev.routingMeta.resolverAddress).toBe('0xresolver');
  });
});

describe('createEthOrderRefundedEvent', () => {
  it('produces eventKind=order_refunded', () => {
    const ev = createEthOrderRefundedEvent({
      orderId: '77',
      txHash: '0xrefund',
      blockNumber: 777,
      amount: '1000',
    });

    expect(ev.eventKind).toBe('order_refunded');
    expect(ev.sourceChain).toBe('ethereum');
    expect(ev.routingMeta.blockNumber).toBe(777);
  });
});

// ── Stellar/Soroban factory ───────────────────────────────────────────────────

describe('createStellarSettlementEvent', () => {
  it('produces sourceChain=soroban and eventKind=settlement_confirmed', () => {
    const ev = createStellarSettlementEvent({
      orderId: 'wf_0xabc',
      txHash: 'stellar_tx_abc',
      ledgerSequence: 50_000_000,
    });

    expect(ev.sourceChain).toBe('soroban');
    expect(ev.eventKind).toBe('settlement_confirmed');
    expect(ev.orderId).toBe('wf_0xabc');
    expect(ev.routingMeta.ledgerSequence).toBe(50_000_000);
  });

  it('coerces absent hashlock to null', () => {
    const ev = createStellarSettlementEvent({
      orderId: 'wf_0xabc',
      txHash: 'tx',
      ledgerSequence: 1,
    });
    expect(ev.routingMeta.hashlock).toBeNull();
  });
});

// ── Solana factory ────────────────────────────────────────────────────────────

describe('createSolanaOrderEvent', () => {
  it('produces sourceChain=solana with the given eventKind', () => {
    const ev = createSolanaOrderEvent({
      orderId: 'sol_order_123',
      txHash: 'sol_tx_abc',
      slot: 250_000_000,
      eventKind: 'funds_locked',
      hashlock: '0xhash',
    });

    expect(ev.sourceChain).toBe('solana');
    expect(ev.eventKind).toBe('funds_locked');
    expect(ev.routingMeta.slot).toBe(250_000_000);
    expect(ev.routingMeta.hashlock).toBe('0xhash');
  });
});

// ── Type guards ───────────────────────────────────────────────────────────────

describe('isNormalizedRelayEvent', () => {
  it('returns true for a valid event', () => {
    const ev = createEthOrderCreatedEvent({
      orderId: '1',
      txHash: '0x',
      blockNumber: 1,
      hashlock: '0x',
      timelock: 0,
      amount: '0',
      tokenAddress: '0x',
      feeRateBps: 0,
      partialFillEnabled: false,
    });
    expect(isNormalizedRelayEvent(ev)).toBe(true);
  });

  it('returns false for null', () => {
    expect(isNormalizedRelayEvent(null)).toBe(false);
  });

  it('returns false for missing orderId', () => {
    expect(isNormalizedRelayEvent({
      sourceChain: 'ethereum',
      eventKind: 'order_created',
      orderId: '',
      txHash: null,
      observedAt: Date.now(),
      routingMeta: {},
    })).toBe(false);
  });

  it('returns false for unknown sourceChain', () => {
    expect(isNormalizedRelayEvent({
      sourceChain: 'bitcoin',
      eventKind: 'order_created',
      orderId: 'x',
      txHash: null,
      observedAt: Date.now(),
      routingMeta: {},
    })).toBe(false);
  });

  it('returns false for unknown eventKind', () => {
    expect(isNormalizedRelayEvent({
      sourceChain: 'ethereum',
      eventKind: 'unknown_kind',
      orderId: 'x',
      txHash: null,
      observedAt: Date.now(),
      routingMeta: {},
    })).toBe(false);
  });
});

describe('isValidRelayEventKind', () => {
  it('returns true for all valid kinds', () => {
    const kinds = [
      'order_created', 'funds_locked', 'secret_revealed',
      'order_claimed', 'order_expired', 'order_refunded', 'settlement_confirmed',
    ];
    for (const k of kinds) {
      expect(isValidRelayEventKind(k)).toBe(true);
    }
  });

  it('returns false for unknown kinds', () => {
    expect(isValidRelayEventKind('order_spam')).toBe(false);
    expect(isValidRelayEventKind(42)).toBe(false);
    expect(isValidRelayEventKind(null)).toBe(false);
  });
});

describe('isValidRelaySourceChain', () => {
  it('returns true for all valid chains', () => {
    for (const chain of ['ethereum', 'solana', 'stellar', 'soroban']) {
      expect(isValidRelaySourceChain(chain)).toBe(true);
    }
  });

  it('returns false for unknown chains', () => {
    expect(isValidRelaySourceChain('bitcoin')).toBe(false);
    expect(isValidRelaySourceChain('')).toBe(false);
  });
});

// ── Schema versioning ─────────────────────────────────────────────────────────

describe('event schema versioning', () => {
  it('createRelayEvent stamps schemaVersion on every event', () => {
    const ev = createRelayEvent({
      sourceChain: 'ethereum',
      eventKind: 'order_created',
      orderId: 'order-v',
      txHash: '0xabc',
    });
    expect(ev.schemaVersion).toBe(RELAY_EVENT_SCHEMA_VERSION);
    expect(ev.schemaVersion).toBe(1);
  });

  it('all chain-specific factories inherit the current schemaVersion', () => {
    const events = [
      createEthOrderCreatedEvent({ orderId: '1', txHash: '0x', blockNumber: 1, hashlock: '0x', timelock: 0, amount: '0', tokenAddress: '0x', feeRateBps: 0, partialFillEnabled: false }),
      createEthOrderClaimedEvent({ orderId: '2', txHash: '0x', blockNumber: 1, amount: '0', resolverAddress: '0x' }),
      createEthOrderRefundedEvent({ orderId: '3', txHash: '0x', blockNumber: 1, amount: '0' }),
      createStellarSettlementEvent({ orderId: '4', txHash: 'tx', ledgerSequence: 1 }),
      createSolanaOrderEvent({ orderId: '5', txHash: 'tx', slot: 1, eventKind: 'funds_locked' }),
    ];
    for (const ev of events) {
      expect(ev.schemaVersion).toBe(RELAY_EVENT_SCHEMA_VERSION);
    }
  });

  it('LEGACY_RELAY_EVENT_SCHEMA_VERSION is 0', () => {
    expect(LEGACY_RELAY_EVENT_SCHEMA_VERSION).toBe(0);
  });

  it('parseLegacyRelayEvent upgrades a v0 event to the current schema version', () => {
    const legacy = {
      sourceChain: 'ethereum' as const,
      eventKind: 'order_created' as const,
      orderId: 'wf_0xlegacy',
      txHash: '0xold',
      observedAt: 1_000_000,
      routingMeta: { blockNumber: 5 },
    };

    const upgraded = parseLegacyRelayEvent(legacy);

    expect(upgraded.schemaVersion).toBe(RELAY_EVENT_SCHEMA_VERSION);
    expect(upgraded.sourceChain).toBe('ethereum');
    expect(upgraded.eventKind).toBe('order_created');
    expect(upgraded.orderId).toBe('wf_0xlegacy');
    expect(upgraded.txHash).toBe('0xold');
    expect(upgraded.observedAt).toBe(1_000_000);
    expect(upgraded.routingMeta.blockNumber).toBe(5);
  });

  it('parseLegacyRelayEvent passes through events that already carry schemaVersion', () => {
    const modern = createEthOrderCreatedEvent({
      orderId: 'w', txHash: '0x', blockNumber: 1, hashlock: '0x',
      timelock: 0, amount: '0', tokenAddress: '0x', feeRateBps: 0, partialFillEnabled: false,
    });
    const result = parseLegacyRelayEvent(modern);
    expect(result.schemaVersion).toBe(RELAY_EVENT_SCHEMA_VERSION);
    expect(result.orderId).toBe('w');
  });

  it('isNormalizedRelayEvent accepts a legacy event missing schemaVersion', () => {
    const legacy = {
      sourceChain: 'solana',
      eventKind: 'order_claimed',
      orderId: 'legacy-id',
      txHash: null,
      observedAt: Date.now(),
      routingMeta: {},
    };
    expect(isNormalizedRelayEvent(legacy)).toBe(true);
  });

  it('isNormalizedRelayEvent accepts a versioned event with schemaVersion=1', () => {
    const ev = createEthOrderCreatedEvent({
      orderId: '1', txHash: '0x', blockNumber: 1, hashlock: '0x',
      timelock: 0, amount: '0', tokenAddress: '0x', feeRateBps: 0, partialFillEnabled: false,
    });
    expect(isNormalizedRelayEvent(ev)).toBe(true);
  });

  it('isNormalizedRelayEvent rejects an event with a non-number schemaVersion', () => {
    const bad = {
      schemaVersion: 'v1',
      sourceChain: 'ethereum',
      eventKind: 'order_created',
      orderId: 'x',
      txHash: null,
      observedAt: Date.now(),
      routingMeta: {},
    };
    expect(isNormalizedRelayEvent(bad)).toBe(false);
  });
});

// ── Cross-chain schema parity ─────────────────────────────────────────────────

describe('events from all chains follow the same schema', () => {
  it('ETH, Stellar, and Solana events all satisfy isNormalizedRelayEvent', () => {
    const eth = createEthOrderCreatedEvent({
      orderId: '1', txHash: '0xeth', blockNumber: 1,
      hashlock: '0x', timelock: 0, amount: '0',
      tokenAddress: '0x', feeRateBps: 0, partialFillEnabled: false,
    });
    const stellar = createStellarSettlementEvent({
      orderId: '2', txHash: 'stellar', ledgerSequence: 1,
    });
    const solana = createSolanaOrderEvent({
      orderId: '3', txHash: 'sol_tx', slot: 1, eventKind: 'order_created',
    });

    expect(isNormalizedRelayEvent(eth)).toBe(true);
    expect(isNormalizedRelayEvent(stellar)).toBe(true);
    expect(isNormalizedRelayEvent(solana)).toBe(true);
  });

  it('all events have the same required top-level fields', () => {
    const events = [
      createEthOrderCreatedEvent({ orderId: '1', txHash: '0x', blockNumber: 1, hashlock: '0x', timelock: 0, amount: '0', tokenAddress: '0x', feeRateBps: 0, partialFillEnabled: false }),
      createStellarSettlementEvent({ orderId: '2', txHash: 'tx', ledgerSequence: 1 }),
      createSolanaOrderEvent({ orderId: '3', txHash: 'tx', slot: 1, eventKind: 'funds_locked' }),
    ];

    for (const ev of events) {
      expect(typeof ev.sourceChain).toBe('string');
      expect(typeof ev.eventKind).toBe('string');
      expect(typeof ev.orderId).toBe('string');
      expect(typeof ev.observedAt).toBe('number');
      expect(ev.routingMeta).toBeDefined();
      expect('txHash' in ev).toBe(true);
    }
  });
});
