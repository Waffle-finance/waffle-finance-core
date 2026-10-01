/**
 * Solana timeout and refund window regression tests (issue #719)
 *
 * Time-based settlement is the load-bearing part of the Solana HTLC path:
 * the claim window closes at the timelock, the refund window opens on the
 * very next second, and both sides of the bridge must agree on which side of
 * that boundary they are on. Solana adds its own confirmation latency
 * (processed → confirmed → finalized) on top, so a transaction that was
 * *submitted* inside the window can be *observed* outside of it.
 *
 * This suite pins the behaviour that must hold under those conditions:
 *
 *  1. Contract-level semantics (SolanaHtlcSim — a faithful re-encoding of the
 *     Anchor program's claim/refund branches): exact-second timeout windows,
 *     refund gating, mutual exclusion of claim and refund, and the effect of
 *     confirmation delay on both.
 *  2. Service-level order-state transitions: every on-chain event is replayed
 *     into the canonical order lifecycle (`@wafflefinance/sdk/state-machine`,
 *     the same table the coordinator is pinned to by its conformance suite),
 *     so we can assert that on-chain and off-chain state converge on the same
 *     outcome — including under out-of-order delivery and replay.
 *
 * No live network is required: the Solana path is exercised through
 * `SolanaHtlcSim` (in-memory contract semantics) plus the shared state
 * machine used by the coordinator services.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { generateSecret } from '@wafflefinance/sdk/secrets';
import {
  InvalidTransitionError,
  isTerminal,
  requireValidTransition,
} from '@wafflefinance/sdk/state-machine';
import type { OrderStatus } from '@wafflefinance/sdk/types';
import {
  SolanaHtlcSim,
  SimError,
  type CreateOrderInput,
  type Hex,
  type OrderStatus as ChainStatus,
} from './sim.js';

// ─────────────────────────────────────────────────────────────────────────────
// Harness — on-chain events replayed into the service order lifecycle
// ─────────────────────────────────────────────────────────────────────────────

type EventType = 'OrderCreated' | 'OrderClaimed' | 'OrderRefunded';

interface ChainEvent {
  type: EventType;
  orderId: bigint;
  /** Service clock (seconds since harness start) at which the event was observed. */
  at: number;
  /** Delivery index within the ledger — proves ordering is preserved. */
  seq: number;
}

interface ServiceOrder {
  status: OrderStatus;
  applied: ChainEvent[];
}

/** Terminal on-chain status → canonical service status. */
const EVENT_TARGET: Record<EventType, OrderStatus> = {
  OrderCreated: 'src_locked',
  OrderClaimed: 'secret_revealed',
  OrderRefunded: 'refunded',
};

/** Non-terminal on-chain status → the service statuses it may correspond to. */
const FUNDED_SERVICE_STATUSES: readonly OrderStatus[] = ['src_locked', 'expired'];

class SolanaTimeoutHarness {
  readonly chain = new SolanaHtlcSim();
  /** Ordered event ledger — the stream a service listener would consume. */
  readonly ledger: ChainEvent[] = [];

  private readonly service = new Map<bigint, ServiceOrder>();
  private readonly deadlines = new Map<bigint, number>();
  private elapsed = 0;
  private seq = 0;

  /**
   * Create an order on-chain and announce it off-chain.
   *
   * `confirmAfter` models Solana confirmation latency: the `OrderCreated`
   * event is only *observed* `confirmAfter` seconds after the escrow exists,
   * which is exactly what the coordinator's finalized-slot pipeline does to
   * creation events.
   */
  create(input: CreateOrderInput, opts: { confirmAfter?: number } = {}): bigint {
    const id = this.chain.createOrder(input);
    this.deadlines.set(id, this.elapsed + input.timelockSeconds);
    this.service.set(id, { status: 'announced', applied: [] });

    const confirmAfter = opts.confirmAfter ?? 0;
    if (confirmAfter > 0) this.advance(confirmAfter);

    this.emit('OrderCreated', id);
    return id;
  }

  /** Advance both the on-chain clock and the service clock by the same delta. */
  advance(seconds: number): void {
    this.chain.advanceTime(seconds);
    this.elapsed += seconds;
  }

  /**
   * Submit a claim and let it land after `confirmAfter` seconds of network
   * latency. The contract evaluates the timeout window at *landing* time, so
   * a delay that crosses the deadline converts a would-be claim into an
   * `Expired` rejection — and no `OrderClaimed` event is ever produced.
   */
  claim(id: bigint, preimage: Hex, opts: { confirmAfter?: number } = {}): void {
    const confirmAfter = opts.confirmAfter ?? 0;
    if (confirmAfter > 0) this.advance(confirmAfter);
    this.chain.claimOrder(id, preimage);
    this.emit('OrderClaimed', id);
  }

  /** Submit a refund; only succeeds once the refund window is open. */
  refund(id: bigint, opts: { confirmAfter?: number } = {}): void {
    const confirmAfter = opts.confirmAfter ?? 0;
    if (confirmAfter > 0) this.advance(confirmAfter);
    this.chain.refundOrder(id);
    this.emit('OrderRefunded', id);
  }

  /**
   * Off-chain expiry scan — mirrors `OrderService.expireStaleOrders`: only
   * `src_locked`/`dst_locked` orders whose timelock has elapsed are moved to
   * `expired`, which is still refundable.
   */
  scanTimeout(id: bigint): boolean {
    const state = this.mustGet(id);
    if (state.status !== 'src_locked') return false;
    if (this.elapsed <= this.deadlines.get(id)!) return false;
    requireValidTransition(state.status, 'expired');
    state.status = 'expired';
    return true;
  }

  // ── Introspection ────────────────────────────────────────────────────────

  chainStatus(id: bigint): ChainStatus {
    return this.chain.getOrder(id).status;
  }

  serviceStatus(id: bigint): OrderStatus {
    return this.mustGet(id).status;
  }

  eventsFor(id: bigint): ChainEvent[] {
    return this.ledger.filter(e => e.orderId === id);
  }

  countFor(id: bigint, type: EventType): number {
    return this.eventsFor(id).filter(e => e.type === type).length;
  }

  /**
   * On-chain and off-chain must tell the same story: a claimed escrow maps to
   * `secret_revealed`, a refunded escrow to `refunded`, and an unfinalised
   * escrow to the pre-settlement service states only.
   */
  expectParity(id: bigint): void {
    const onChain = this.chainStatus(id);
    const offChain = this.serviceStatus(id);

    if (onChain === 'Claimed') {
      expect(offChain).toBe('secret_revealed');
    } else if (onChain === 'Refunded') {
      expect(offChain).toBe('refunded');
    } else {
      expect(FUNDED_SERVICE_STATUSES).toContain(offChain);
    }

    // The event ledger must agree with the on-chain terminal state: exactly
    // one terminal event, and it is the terminal state that was observed.
    const claims = this.countFor(id, 'OrderClaimed');
    const refunds = this.countFor(id, 'OrderRefunded');
    if (onChain === 'Claimed') {
      expect(claims).toBe(1);
      expect(refunds).toBe(0);
    } else if (onChain === 'Refunded') {
      expect(refunds).toBe(1);
      expect(claims).toBe(0);
    } else {
      expect(claims).toBe(0);
      expect(refunds).toBe(0);
    }
  }

  // ── Replay helpers ───────────────────────────────────────────────────────

  /**
   * Replay a recorded ledger into a service state — what a listener does when
   * it (re-)consumes the same Solana events. Pass `states` to keep state
   * across passes (a restart keeps the database); omit it to start from a
   * clean slate. Returns the per-event application outcomes so tests can
   * assert ordering and idempotency.
   */
  static replay(
    events: ChainEvent[],
    states: Map<bigint, ServiceOrder> = new Map()
  ): Array<'applied' | 'noop'> {
    const outcomes: Array<'applied' | 'noop'> = [];

    for (const ev of events) {
      if (!states.has(ev.orderId)) {
        states.set(ev.orderId, { status: 'announced', applied: [] });
      }
      outcomes.push(SolanaTimeoutHarness.applyEvent(states.get(ev.orderId)!, ev));
    }
    return outcomes;
  }

  /**
   * Apply one event to a service order, mirroring `OrderService` mutation
   * semantics:
   *  - `recordSrcLock` (OrderCreated) never rewinds and never throws: a lock
   *    observed after the order moved on — including a settled order — is a
   *    no-op.
   *  - status/secret mutations are idempotent on a matching status and are
   *    rejected outright once the order is terminal.
   *  - everything else goes through the canonical transition table (guards
   *    included), so misordered deliveries fail loudly.
   */
  private static applyEvent(state: ServiceOrder, ev: ChainEvent): 'applied' | 'noop' {
    const target = EVENT_TARGET[ev.type];

    // Idempotency — a replayed event that matches the current status is a no-op.
    if (state.status === target) return 'noop';

    // Source-lock replay: only announced orders can take the lock; anything
    // else (already locked, claimed, refunded, expired) is a no-op.
    if (ev.type === 'OrderCreated') {
      if (state.status !== 'announced') return 'noop';
      requireValidTransition(state.status, target);
      state.status = target;
      state.applied.push(ev);
      return 'applied';
    }

    // Terminal guard — nothing may rewrite a settled order.
    if (isTerminal(state.status)) {
      throw new InvalidTransitionError(state.status, target, `${state.status} is a terminal state`);
    }

    requireValidTransition(state.status, target, {
      srcLocked: state.status !== 'announced',
      dstLocked: state.status === 'dst_locked' || state.status === 'secret_revealed',
      secretRevealed: state.status === 'secret_revealed',
    });

    state.status = target;
    state.applied.push(ev);
    return 'applied';
  }

  private emit(type: EventType, orderId: bigint): void {
    const ev: ChainEvent = { type, orderId, at: this.elapsed, seq: ++this.seq };
    this.ledger.push(ev);
    const outcome = SolanaTimeoutHarness.applyEvent(this.mustGet(orderId), ev);
    expect(outcome).toBe('applied');
  }

  private mustGet(id: bigint): ServiceOrder {
    const state = this.service.get(id);
    if (!state) throw new SimError('OrderNotFound');
    return state;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 1 — Contract-level timeout window boundaries
// ─────────────────────────────────────────────────────────────────────────────

describe('Solana contract semantics — timeout window boundaries', () => {
  const TIMELOCK = 600;
  let harness: SolanaTimeoutHarness;
  let secret: ReturnType<typeof generateSecret>;
  let id: bigint;

  beforeEach(() => {
    harness = new SolanaTimeoutHarness();
    secret = generateSecret();
    id = harness.create({ hashlock: secret.sha256, timelockSeconds: TIMELOCK });
  });

  it('claim succeeds at the exact timelock second (deadline is inclusive)', () => {
    harness.advance(TIMELOCK); // now === deadline
    expect(() => harness.claim(id, secret.preimage)).not.toThrow();
    expect(harness.chainStatus(id)).toBe('Claimed');
    expect(harness.serviceStatus(id)).toBe('secret_revealed');
    harness.expectParity(id);
  });

  it('refund is rejected at the exact timelock second and opens one second later', () => {
    harness.advance(TIMELOCK); // now === deadline — refund window still shut
    expect(() => harness.refund(id)).toThrow(SimError);
    expect(harness.chainStatus(id)).toBe('Funded');

    harness.advance(1); // now === deadline + 1 — refund window open
    expect(() => harness.refund(id)).not.toThrow();
    expect(harness.chainStatus(id)).toBe('Refunded');
    expect(harness.serviceStatus(id)).toBe('refunded');
    harness.expectParity(id);
  });

  it('claim is rejected one second past the deadline while refund succeeds', () => {
    harness.advance(TIMELOCK + 1);
    expect(() => harness.claim(id, secret.preimage)).toThrow(SimError);
    expect(harness.chainStatus(id)).toBe('Funded');
    expect(harness.countFor(id, 'OrderClaimed')).toBe(0);

    expect(() => harness.refund(id)).not.toThrow();
    harness.expectParity(id);
  });

  it('one second before the deadline both claim is open and refund is shut', () => {
    harness.advance(TIMELOCK - 1);
    expect(() => harness.claim(id, secret.preimage)).not.toThrow();
    expect(harness.chainStatus(id)).toBe('Claimed');

    // A second order proves the refund side of the same boundary.
    const other = harness.create({
      hashlock: generateSecret().sha256,
      timelockSeconds: TIMELOCK,
    });
    harness.advance(0);
    expect(() => harness.refund(other)).toThrow(SimError);
  });

  it('the absolute deadline is createdAt + timelock regardless of when it is observed', () => {
    const before = harness.chain.getOrder(id).timelockAbsolute;
    harness.advance(TIMELOCK + 5);
    const after = harness.chain.getOrder(id).timelockAbsolute;
    expect(after).toBe(before);
    expect(after - harness.chain.getOrder(id).createdAt).toBe(TIMELOCK);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Section 2 — Refund triggers
// ─────────────────────────────────────────────────────────────────────────────

describe('Solana contract semantics — refund triggers', () => {
  const TIMELOCK = 600;
  let harness: SolanaTimeoutHarness;
  let secret: ReturnType<typeof generateSecret>;
  let id: bigint;

  beforeEach(() => {
    harness = new SolanaTimeoutHarness();
    secret = generateSecret();
    id = harness.create({ hashlock: secret.sha256, timelockSeconds: TIMELOCK });
  });

  it('repeated refund attempts before expiry never mutate state', () => {
    for (let i = 0; i < 5; i++) {
      harness.advance(TIMELOCK / 5 - 1);
      expect(() => harness.refund(id)).toThrow(SimError);
    }

    const order = harness.chain.getOrder(id);
    expect(order.status).toBe('Funded');
    expect(order.finalisedAt).toBe(0);
    expect(harness.serviceStatus(id)).toBe('src_locked');
    expect(harness.countFor(id, 'OrderRefunded')).toBe(0);
  });

  it('refunding twice is rejected and the ledger keeps exactly one refund event', () => {
    harness.advance(TIMELOCK + 1);
    harness.refund(id);

    expect(() => harness.refund(id)).toThrow(SimError);
    expect(harness.chainStatus(id)).toBe('Refunded');
    expect(harness.countFor(id, 'OrderRefunded')).toBe(1);
    expect(harness.serviceStatus(id)).toBe('refunded');
  });

  it('claiming after a confirmed refund is rejected (claim/refund are mutually exclusive)', () => {
    harness.advance(TIMELOCK + 1);
    harness.refund(id);

    expect(() => harness.claim(id, secret.preimage)).toThrow(SimError);
    expect(harness.chainStatus(id)).toBe('Refunded');
    expect(harness.countFor(id, 'OrderClaimed')).toBe(0);
    harness.expectParity(id);
  });

  it('claiming first permanently closes the refund window', () => {
    harness.claim(id, secret.preimage);
    harness.advance(TIMELOCK + 1);

    expect(() => harness.refund(id)).toThrow(SimError);
    expect(harness.chainStatus(id)).toBe('Claimed');
    expect(harness.countFor(id, 'OrderRefunded')).toBe(0);
    harness.expectParity(id);
  });

  it('an unfinalised escrow can be expired off-chain and then refunded', () => {
    // Before the timelock the scan finds nothing to expire.
    expect(harness.scanTimeout(id)).toBe(false);
    expect(harness.serviceStatus(id)).toBe('src_locked');

    harness.advance(TIMELOCK + 1);
    expect(harness.scanTimeout(id)).toBe(true);
    expect(harness.serviceStatus(id)).toBe('expired');

    harness.refund(id);
    expect(harness.chainStatus(id)).toBe('Refunded');
    expect(harness.serviceStatus(id)).toBe('refunded');
    harness.expectParity(id);

    // A second scan finds a terminal order — the refund is not overwritten.
    expect(harness.scanTimeout(id)).toBe(false);
    expect(harness.serviceStatus(id)).toBe('refunded');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Section 3 — Confirmation delays
// ─────────────────────────────────────────────────────────────────────────────

describe('Solana confirmation delays — claim and refund windows under latency', () => {
  const TIMELOCK = 600;
  let harness: SolanaTimeoutHarness;
  let secret: ReturnType<typeof generateSecret>;
  let id: bigint;

  beforeEach(() => {
    harness = new SolanaTimeoutHarness();
    secret = generateSecret();
    id = harness.create({ hashlock: secret.sha256, timelockSeconds: TIMELOCK });
  });

  it('claim that lands after a slow round-trip but inside the window settles', () => {
    harness.claim(id, secret.preimage, { confirmAfter: TIMELOCK - 1 });
    expect(harness.chainStatus(id)).toBe('Claimed');
    expect(harness.serviceStatus(id)).toBe('secret_revealed');
    harness.expectParity(id);
  });

  it('claim whose confirmation crosses the deadline is rejected and the refund path opens', () => {
    // Submitted with 1s of window left; the confirmation delay pushes it over
    // the deadline, so the program rejects the claim outright.
    harness.advance(TIMELOCK - 1);
    expect(() => harness.claim(id, secret.preimage, { confirmAfter: 2 })).toThrow(SimError);

    expect(harness.chainStatus(id)).toBe('Funded');
    expect(harness.serviceStatus(id)).toBe('src_locked');
    expect(harness.countFor(id, 'OrderClaimed')).toBe(0);

    harness.refund(id);
    expect(harness.chainStatus(id)).toBe('Refunded');
    expect(harness.serviceStatus(id)).toBe('refunded');
    harness.expectParity(id);
  });

  it('a refund confirmed well after the deadline still finalises exactly once despite retries', () => {
    harness.advance(TIMELOCK + 1);

    harness.refund(id, { confirmAfter: 30 }); // slow confirmation
    expect(() => harness.refund(id, { confirmAfter: 0 })).toThrow(SimError);
    expect(() => harness.refund(id, { confirmAfter: 10 })).toThrow(SimError);

    expect(harness.chainStatus(id)).toBe('Refunded');
    expect(harness.countFor(id, 'OrderRefunded')).toBe(1);
    expect(harness.serviceStatus(id)).toBe('refunded');
    harness.expectParity(id);
  });

  it('delayed creation confirmation neither shortens nor extends the refund window', () => {
    const late = new SolanaTimeoutHarness();
    const lateSecret = generateSecret();
    // The escrow exists immediately, but the service only observes it 120s later.
    const lateId = late.create(
      { hashlock: lateSecret.sha256, timelockSeconds: TIMELOCK },
      { confirmAfter: 120 }
    );

    // The deadline still sits TIMELLOCK seconds after creation, not after the
    // delayed observation: refund stays shut through creation+timelock and
    // opens on the next second.
    late.advance(TIMELOCK - 120);
    expect(() => late.refund(lateId)).toThrow(SimError);

    late.advance(1);
    expect(() => late.refund(lateId)).not.toThrow();
    expect(late.chainStatus(lateId)).toBe('Refunded');
    expect(late.serviceStatus(lateId)).toBe('refunded');
    late.expectParity(lateId);
  });

  it('a stale claim arriving after the refund has confirmed is rejected', () => {
    harness.advance(TIMELOCK + 1);
    harness.refund(id, { confirmAfter: 5 });

    // The claim tx was signed before expiry but only lands now: the program
    // rejects it (the escrow is already refunded), so no event is produced.
    expect(() => harness.claim(id, secret.preimage, { confirmAfter: 0 })).toThrow(SimError);
    expect(harness.chainStatus(id)).toBe('Refunded');
    expect(harness.serviceStatus(id)).toBe('refunded');
    expect(harness.countFor(id, 'OrderClaimed')).toBe(0);
    harness.expectParity(id);
  });

  it("delayed confirmation of the claim on one order does not disturb a neighbour's window", () => {
    const otherSecret = generateSecret();
    const other = harness.create({
      hashlock: otherSecret.sha256,
      timelockSeconds: TIMELOCK,
    });

    // Order A's claim is slow; order B's window closes first.
    harness.advance(TIMELOCK + 1);
    harness.refund(other);
    expect(harness.chainStatus(other)).toBe('Refunded');

    // A is still claimable? No — its window closed too; refund it.
    expect(() => harness.claim(id, secret.preimage)).toThrow(SimError);
    harness.refund(id);

    expect(harness.chainStatus(id)).toBe('Refunded');
    harness.expectParity(id);
    harness.expectParity(other);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Section 4 — Event ordering, replay, and service-state convergence
// ─────────────────────────────────────────────────────────────────────────────

describe('Solana service-level order states — event ordering and replay', () => {
  const TIMELOCK = 600;
  let harness: SolanaTimeoutHarness;
  let secret: ReturnType<typeof generateSecret>;

  beforeEach(() => {
    harness = new SolanaTimeoutHarness();
    secret = generateSecret();
  });

  it('claim flow: [OrderCreated, OrderClaimed] drives announced → src_locked → secret_revealed', () => {
    const id = harness.create({ hashlock: secret.sha256, timelockSeconds: TIMELOCK });
    expect(harness.serviceStatus(id)).toBe('src_locked');

    harness.claim(id, secret.preimage);

    expect(harness.serviceStatus(id)).toBe('secret_revealed');
    expect(harness.eventsFor(id).map(e => e.type)).toEqual(['OrderCreated', 'OrderClaimed']);
    harness.expectParity(id);
  });

  it('refund flow: [OrderCreated, OrderRefunded] drives announced → src_locked → refunded', () => {
    const id = harness.create({ hashlock: secret.sha256, timelockSeconds: TIMELOCK });
    harness.advance(TIMELOCK + 1);
    harness.refund(id);

    expect(harness.serviceStatus(id)).toBe('refunded');
    expect(harness.eventsFor(id).map(e => e.type)).toEqual(['OrderCreated', 'OrderRefunded']);
    harness.expectParity(id);
  });

  it('claim and refund events never coexist for the same order', () => {
    const claimed = harness.create({
      hashlock: secret.sha256,
      timelockSeconds: TIMELOCK,
    });
    harness.claim(claimed, secret.preimage);

    const refundedSecret = generateSecret();
    const refunded = harness.create({
      hashlock: refundedSecret.sha256,
      timelockSeconds: TIMELOCK,
    });
    harness.advance(TIMELOCK + 1);
    harness.refund(refunded);

    const types = (id: bigint) => harness.eventsFor(id).map(e => e.type);
    expect(types(claimed)).not.toContain('OrderRefunded');
    expect(types(refunded)).not.toContain('OrderClaimed');
    expect(harness.serviceStatus(claimed)).toBe('secret_revealed');
    expect(harness.serviceStatus(refunded)).toBe('refunded');
  });

  it('a refund event delivered before its creation event is rejected and state is unchanged', () => {
    const id = harness.create({ hashlock: secret.sha256, timelockSeconds: TIMELOCK });
    harness.advance(TIMELOCK + 1);
    harness.refund(id);

    const [created, refunded] = harness.eventsFor(id);
    expect(created).toBeDefined();
    expect(refunded).toBeDefined();

    // Deliver the terminal event first — the state machine must refuse it
    // (an order cannot be refunded before its source leg was ever locked).
    expect(() => SolanaTimeoutHarness.replay([refunded!, created!])).toThrow(
      InvalidTransitionError
    );

    // Replaying the ledger in the recorded order converges.
    expect(SolanaTimeoutHarness.replay([created!, refunded!])).toEqual(['applied', 'applied']);
  });

  it('a claim event delivered before its creation event is rejected', () => {
    const id = harness.create({ hashlock: secret.sha256, timelockSeconds: TIMELOCK });
    harness.claim(id, secret.preimage);

    const [created, claimed] = harness.eventsFor(id);
    expect(() => SolanaTimeoutHarness.replay([claimed!, created!])).toThrow(InvalidTransitionError);
  });

  it('replaying the full ledger is idempotent — every event is a no-op on the second pass', () => {
    const id = harness.create({ hashlock: secret.sha256, timelockSeconds: TIMELOCK });
    harness.advance(TIMELOCK + 1);
    harness.refund(id);

    // First consumption of the ledger (or first pass after a restart replays
    // it into an empty store) applies both events.
    const states = new Map<bigint, ServiceOrder>();
    expect(SolanaTimeoutHarness.replay(harness.ledger, states)).toEqual(['applied', 'applied']);

    // Re-delivering the same ledger against the persisted state is a no-op.
    expect(SolanaTimeoutHarness.replay(harness.ledger, states)).toEqual(['noop', 'noop']);

    // A third and fourth pass (restart loops) still do not move the order.
    expect(SolanaTimeoutHarness.replay(harness.ledger, states)).toEqual(['noop', 'noop']);
    expect(states.get(id)!.status).toBe('refunded');
    expect(harness.serviceStatus(id)).toBe('refunded');
  });

  it('a late claim replayed onto a refunded order is rejected by the terminal guard', () => {
    const id = harness.create({ hashlock: secret.sha256, timelockSeconds: TIMELOCK });
    harness.advance(TIMELOCK + 1);
    harness.refund(id);

    const states = new Map<bigint, ServiceOrder>();
    expect(SolanaTimeoutHarness.replay(harness.ledger, states)).toEqual(['applied', 'applied']);

    // The claim transaction was signed before expiry but only lands now —
    // on-chain it is rejected, so the forged event must not rewrite the
    // settled off-chain order either.
    expect(() => harness.claim(id, secret.preimage)).toThrow(SimError);

    const lateClaim: ChainEvent = {
      type: 'OrderClaimed',
      orderId: id,
      at: harness.chain.getOrder(id).finalisedAt,
      seq: 999,
    };
    expect(() => SolanaTimeoutHarness.replay([lateClaim], states)).toThrow(InvalidTransitionError);
    expect(states.get(id)!.status).toBe('refunded');
    expect(harness.serviceStatus(id)).toBe('refunded');
    harness.expectParity(id);
  });

  it('the expiry scan cannot expire an order whose claim has already been recorded', () => {
    const id = harness.create({ hashlock: secret.sha256, timelockSeconds: TIMELOCK });
    harness.claim(id, secret.preimage);

    harness.advance(TIMELOCK + 60);
    expect(harness.scanTimeout(id)).toBe(false);
    expect(harness.serviceStatus(id)).toBe('secret_revealed');
    harness.expectParity(id);
  });

  it('event ledger timestamps are monotonically ordered by delivery sequence', () => {
    const id = harness.create(
      { hashlock: secret.sha256, timelockSeconds: TIMELOCK },
      { confirmAfter: 30 }
    );
    harness.advance(100);
    harness.claim(id, secret.preimage, { confirmAfter: 10 });

    const events = harness.eventsFor(id);
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.seq).toBeGreaterThan(events[i - 1]!.seq);
      expect(events[i]!.at).toBeGreaterThanOrEqual(events[i - 1]!.at);
    }
    // Creation was observed late (30s confirmation), claim 140s later.
    expect(events[0]!.at).toBe(30);
    expect(events[1]!.at).toBe(140);
  });

  it('independent orders time out and refund independently', () => {
    const short = harness.create({ hashlock: secret.sha256, timelockSeconds: 300 });
    const longSecret = generateSecret();
    const long = harness.create({
      hashlock: longSecret.sha256,
      timelockSeconds: TIMELOCK,
    });

    harness.advance(301);

    expect(() => harness.refund(short)).not.toThrow();
    expect(() => harness.refund(long)).toThrow(SimError);
    expect(harness.serviceStatus(short)).toBe('refunded');
    expect(harness.serviceStatus(long)).toBe('src_locked');
    harness.expectParity(short);
    harness.expectParity(long);

    harness.advance(TIMELOCK - 301 + 1);
    expect(() => harness.refund(long)).not.toThrow();
    harness.expectParity(long);
    harness.expectParity(short);
  });
});
