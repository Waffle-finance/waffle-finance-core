/**
 * Tests for the coordinator freshness policy contract.
 *
 * Time-sensitive assertions use `FakeClock` from the shared test-utils package
 * so no real wall-clock sleeps occur and boundary conditions are deterministic.
 *
 * Covers:
 *  - classify() returns 'missing' for null fetchedAt.
 *  - classify() returns 'fresh' within freshTtlMs.
 *  - classify() returns 'stale' between freshTtlMs and staleTtlMs.
 *  - classify() returns 'expired' beyond staleTtlMs.
 *  - invalidate() forces the next classify() call to return 'expired'.
 *  - After the invalidated read, the key is no longer marked.
 *  - invalidatePrefix() invalidates all matching keys.
 *  - wrap() bundles data with correct freshness metadata.
 *  - Constructor throws when staleTtlMs < freshTtlMs.
 *  - Concurrent independent FreshnessPolicy instances do not share state.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { FakeClock } from '../../packages/test-utils/src/fake-clock.js';
import { FreshnessPolicy } from '../src/services/freshness-policy.js';

// One shared clock instance for the whole file.  Every test that needs time
// control calls `clock.install()` and the afterEach restores real timers.
const clock = new FakeClock({ scope: 'date' });

afterEach(() => clock.restore());

// ── classify ─────────────────────────────────────────────────────────────────

describe('FreshnessPolicy.classify', () => {
  it('returns missing for null fetchedAt', () => {
    const policy = new FreshnessPolicy();
    const meta = policy.classify(null);
    expect(meta.freshness).toBe('missing');
    expect(meta.fetchedAt).toBeNull();
    expect(meta.ageMs).toBeNull();
    expect(meta.eventInvalidated).toBe(false);
  });

  it('returns fresh when data is within freshTtlMs', () => {
    clock.install();
    const fetchedAt = clock.now();
    const policy = new FreshnessPolicy({ freshTtlMs: 30_000, staleTtlMs: 120_000 });

    clock.advance(10_000); // 10 s — still fresh

    const meta = policy.classify(fetchedAt);
    expect(meta.freshness).toBe('fresh');
    expect(meta.fetchedAt).toBe(fetchedAt);
    expect(meta.ageMs).toBeGreaterThanOrEqual(10_000);
    expect(meta.ageMs).toBeLessThan(11_000);
  });

  it('returns stale when data age is between freshTtlMs and staleTtlMs', () => {
    clock.install();
    const fetchedAt = clock.now();
    const policy = new FreshnessPolicy({ freshTtlMs: 30_000, staleTtlMs: 120_000 });

    clock.advance(60_000); // 60 s — past fresh, before stale

    const meta = policy.classify(fetchedAt);
    expect(meta.freshness).toBe('stale');
  });

  it('returns expired when data age exceeds staleTtlMs', () => {
    clock.install();
    const fetchedAt = clock.now();
    const policy = new FreshnessPolicy({ freshTtlMs: 30_000, staleTtlMs: 120_000 });

    clock.advance(200_000); // 200 s — well past stale

    const meta = policy.classify(fetchedAt);
    expect(meta.freshness).toBe('expired');
  });

  it('returns fresh at exactly 1 ms before freshTtlMs boundary', () => {
    clock.install();
    const fetchedAt = clock.now();
    const policy = new FreshnessPolicy({ freshTtlMs: 30_000, staleTtlMs: 120_000 });

    clock.advance(29_999); // 1 ms before the fresh → stale boundary

    expect(policy.classify(fetchedAt).freshness).toBe('fresh');
  });

  it('returns stale at exactly freshTtlMs', () => {
    clock.install();
    const fetchedAt = clock.now();
    const policy = new FreshnessPolicy({ freshTtlMs: 30_000, staleTtlMs: 120_000 });

    clock.advance(30_000); // exactly at boundary

    expect(policy.classify(fetchedAt).freshness).toBe('stale');
  });

  it('returns stale at exactly 1 ms before staleTtlMs', () => {
    clock.install();
    const fetchedAt = clock.now();
    const policy = new FreshnessPolicy({ freshTtlMs: 30_000, staleTtlMs: 120_000 });

    clock.advance(119_999);

    expect(policy.classify(fetchedAt).freshness).toBe('stale');
  });

  it('returns expired at exactly staleTtlMs', () => {
    clock.install();
    const fetchedAt = clock.now();
    const policy = new FreshnessPolicy({ freshTtlMs: 30_000, staleTtlMs: 120_000 });

    clock.advance(120_000);

    expect(policy.classify(fetchedAt).freshness).toBe('expired');
  });

  it('attaches correct ageMs to the metadata', () => {
    clock.install();
    const fetchedAt = clock.now();
    const policy = new FreshnessPolicy({ freshTtlMs: 30_000, staleTtlMs: 120_000 });

    clock.advance(5_000);

    const meta = policy.classify(fetchedAt);
    expect(meta.ageMs).toBe(5_000);
  });
});

// ── invalidate ────────────────────────────────────────────────────────────────

describe('FreshnessPolicy.invalidate', () => {
  it('forces the next classify() to return expired regardless of age', () => {
    const fetchedAt = Date.now();
    const policy = new FreshnessPolicy({ freshTtlMs: 30_000, staleTtlMs: 120_000 });

    policy.invalidate('key:addr1');
    // Data is brand new (age ≈ 0) but the key was invalidated.
    const meta = policy.classify(fetchedAt, 'key:addr1');

    expect(meta.freshness).toBe('expired');
    expect(meta.eventInvalidated).toBe(true);
  });

  it('clears the invalidation flag after it is consumed', () => {
    const fetchedAt = Date.now();
    const policy = new FreshnessPolicy({ freshTtlMs: 30_000, staleTtlMs: 120_000 });

    policy.invalidate('key:addr1');
    policy.classify(fetchedAt, 'key:addr1'); // consumes the flag

    const second = policy.classify(fetchedAt, 'key:addr1');
    expect(second.freshness).toBe('fresh');
    expect(second.eventInvalidated).toBe(false);
  });

  it('does not affect a different key', () => {
    const fetchedAt = Date.now();
    const policy = new FreshnessPolicy({ freshTtlMs: 30_000, staleTtlMs: 120_000 });

    policy.invalidate('key:addr1');
    const meta = policy.classify(fetchedAt, 'key:addr2');

    expect(meta.freshness).toBe('fresh');
    expect(meta.eventInvalidated).toBe(false);
  });
});

// ── invalidatePrefix ──────────────────────────────────────────────────────────

describe('FreshnessPolicy.invalidatePrefix', () => {
  it('marks all keys with the given prefix as invalidated', () => {
    const policy = new FreshnessPolicy({ freshTtlMs: 30_000, staleTtlMs: 120_000 });

    policy.invalidatePrefix('0xAddr1:');

    expect(policy.isInvalidated('0xAddr1:50:first')).toBe(true);
    expect(policy.isInvalidated('0xAddr1:100:cursor1')).toBe(true);
    expect(policy.isInvalidated('0xAddr2:50:first')).toBe(false);
  });
});

// ── wrap ──────────────────────────────────────────────────────────────────────

describe('FreshnessPolicy.wrap', () => {
  it('bundles data with its freshness metadata', () => {
    const fetchedAt = Date.now();
    const policy = new FreshnessPolicy({ freshTtlMs: 30_000, staleTtlMs: 120_000 });

    const result = policy.wrap({ value: 42 }, fetchedAt, 'my-key');

    expect(result.data).toEqual({ value: 42 });
    expect(result.meta.freshness).toBe('fresh');
    expect(result.meta.fetchedAt).toBe(fetchedAt);
  });

  it('wraps null data as a missing result', () => {
    const policy = new FreshnessPolicy();
    const result = policy.wrap<string>(null, null);

    expect(result.data).toBeNull();
    expect(result.meta.freshness).toBe('missing');
  });

  it('marks wrapped result as expired when key is invalidated', () => {
    const fetchedAt = Date.now();
    const policy = new FreshnessPolicy({ freshTtlMs: 30_000, staleTtlMs: 120_000 });

    policy.invalidate('my-key');
    const result = policy.wrap({ value: 1 }, fetchedAt, 'my-key');

    expect(result.meta.freshness).toBe('expired');
    expect(result.meta.eventInvalidated).toBe(true);
  });

  it('wraps fresh data with correct ageMs via fake clock', () => {
    clock.install();
    const fetchedAt = clock.now();
    const policy = new FreshnessPolicy({ freshTtlMs: 30_000, staleTtlMs: 120_000 });

    clock.advance(7_500);

    const result = policy.wrap('hello', fetchedAt, 'greet');
    expect(result.meta.ageMs).toBe(7_500);
    expect(result.meta.freshness).toBe('fresh');
  });
});

// ── constructor validation ────────────────────────────────────────────────────

describe('FreshnessPolicy constructor validation', () => {
  it('throws when staleTtlMs < freshTtlMs', () => {
    expect(
      () => new FreshnessPolicy({ freshTtlMs: 60_000, staleTtlMs: 30_000 })
    ).toThrow(RangeError);
  });

  it('accepts equal freshTtlMs and staleTtlMs', () => {
    expect(
      () => new FreshnessPolicy({ freshTtlMs: 30_000, staleTtlMs: 30_000 })
    ).not.toThrow();
  });
});

// ── independent instances ─────────────────────────────────────────────────────

describe('independent policy instances', () => {
  it('do not share invalidation state', () => {
    const fetchedAt = Date.now();
    const policyA = new FreshnessPolicy();
    const policyB = new FreshnessPolicy();

    policyA.invalidate('shared-key');

    expect(policyA.classify(fetchedAt, 'shared-key').freshness).toBe('expired');
    expect(policyB.classify(fetchedAt, 'shared-key').freshness).toBe('fresh');
  });
});

// ── stale-then-refresh scenario ───────────────────────────────────────────────

describe('stale query re-query stability', () => {
  it('returns stale on first read then expired-on-invalidation then fresh after cache refresh', () => {
    clock.install();
    const fetchedAt = clock.now();
    const policy = new FreshnessPolicy({ freshTtlMs: 10_000, staleTtlMs: 60_000 });

    // Advance to stale territory.
    clock.advance(20_000);
    expect(policy.classify(fetchedAt, 'order:history:addr1').freshness).toBe('stale');

    // A chain event invalidates the key.
    policy.invalidate('order:history:addr1');

    // First classify after invalidation → expired (flag consumed).
    const refreshedAt = clock.now();
    const second = policy.classify(refreshedAt, 'order:history:addr1');
    expect(second.freshness).toBe('expired');
    expect(second.eventInvalidated).toBe(true);

    // Subsequent classify with the refreshed timestamp → fresh.
    const third = policy.classify(refreshedAt, 'order:history:addr1');
    expect(third.freshness).toBe('fresh');
    expect(third.eventInvalidated).toBe(false);
  });
});

// ── retention-window boundary (matches stale-cleanup test pattern) ────────────
//
// This group directly maps the freshness-policy classification onto the same
// time-advance pattern used by stale-cleanup.test.ts, so both suites exercise
// the same fake-clock mechanics and can be compared side-by-side.

describe('FreshnessPolicy — retention-window boundary (fake clock)', () => {
  it('classifies data as fresh up to but not including freshTtlMs', () => {
    clock.install();
    const policy = new FreshnessPolicy({ freshTtlMs: 30_000, staleTtlMs: 90_000 });
    const t0 = clock.now();

    for (const advanceMs of [0, 1, 15_000, 29_999]) {
      clock.setTime(t0 + advanceMs);
      expect(policy.classify(t0).freshness).toBe('fresh');
    }
  });

  it('classifies data as stale from freshTtlMs up to staleTtlMs', () => {
    clock.install();
    const policy = new FreshnessPolicy({ freshTtlMs: 30_000, staleTtlMs: 90_000 });
    const t0 = clock.now();

    for (const advanceMs of [30_000, 45_000, 89_999]) {
      clock.setTime(t0 + advanceMs);
      expect(policy.classify(t0).freshness).toBe('stale');
    }
  });

  it('classifies data as expired from staleTtlMs onward', () => {
    clock.install();
    const policy = new FreshnessPolicy({ freshTtlMs: 30_000, staleTtlMs: 90_000 });
    const t0 = clock.now();

    for (const advanceMs of [90_000, 120_000, 300_000]) {
      clock.setTime(t0 + advanceMs);
      expect(policy.classify(t0).freshness).toBe('expired');
    }
  });
});
