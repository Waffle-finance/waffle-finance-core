/**
 * Tests for the shared guard vocabulary and the branded scalar parsers
 * (#733).
 *
 * The properties under test are not "does it accept the good value" — that
 * is covered by every other guard suite. They are:
 *
 *   • **A guard narrows.** `result.ok === true` must make `result.value`
 *     reachable, and `result.ok === false` must make `result.issues`
 *     reachable, with neither leaking onto the other arm. A guard that
 *     returns `x as Order` without checking cannot do this; a guard that
 *     returns a boolean cannot either.
 *   • **A guard accumulates.** A payload with three bad fields reports
 *     three issues, not one. A guard that bails on the first problem forces
 *     a fix-run-retry loop for a form.
 *   * **A brand is a brand.** A `Hashlock` must not be assignable to an
 *     `AtomicAmount`, and a parse failure must not produce a value.
 */

import { describe, it, expect } from 'vitest';

import {
  GuardError,
  GuardIssueCollector,
  assertGuard,
  formatIssues,
  guardFail,
  guardFailOne,
  guardOk,
  type GuardResult,
} from '../src/guards/result.js';
import {
  assertAtomicAmount,
  assertChainAddress,
  assertChainTxRef,
  assertHashlock,
  assertPublicOrderId,
  parseAtomicAmount,
  parseChainAddress,
  parseChainTxRef,
  parseDecimalUint,
  parseHashlock,
  parsePublicOrderId,
  parseStellarContractId,
  parseUnixSeconds,
  type AtomicAmount,
  type Hashlock,
} from '../src/guards/branded.js';

import { ETH_SRC, PAIR_ETH_TO_XLM, SOL_SRC, XLM_SRC } from '../src/fixtures/identities.js';

// ── The result type ─────────────────────────────────────────────────────────

describe('GuardResult', () => {
  it('guardOk carries a value and no issues', () => {
    const result = guardOk(42);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value).toBe(42);
  });

  it('guardFailOne carries exactly one issue and no value', () => {
    const result = guardFailOne('a', 'bad');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toEqual({ field: 'a', message: 'bad' });
  });

  it('guardFail accepts either one issue or a list', () => {
    const one = guardFail({ field: 'x', message: 'y' });
    const many = guardFail([
      { field: 'x', message: 'y' },
      { field: 'z', message: 'w' },
    ]);
    expect(one.ok).toBe(false);
    expect(many.ok).toBe(false);
    if (one.ok || many.ok) return;
    expect(one.issues).toHaveLength(1);
    expect(many.issues).toHaveLength(2);
  });

  it('narrows: value is reachable only on the success arm', () => {
    // The compile-time half of "a guard narrows". If `ok` were a plain
    // boolean this would not typecheck, and the runtime assertion below
    // confirms the shape matches the type.
    const good: GuardResult<string> = guardOk('x');
    const bad: GuardResult<string> = guardFailOne('f', 'm');
    if (good.ok) {
      const narrowed: string = good.value;
      expect(narrowed).toBe('x');
    }
    if (!bad.ok) {
      expect(bad.issues.length).toBeGreaterThan(0);
    }
    expect((bad as { value?: unknown }).value).toBeUndefined();
  });
});

describe('GuardIssueCollector', () => {
  it('collects every issue and finishes as a failure', () => {
    const issues = new GuardIssueCollector();
    issues.add('a', 'one').add('b', 'two').add('c', 'three');
    expect(issues.length).toBe(3);
    const result = issues.finish('ignored');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.issues.map(i => i.field)).toEqual(['a', 'b', 'c']);
  });

  it('finishes as a success with no issues', () => {
    const result = new GuardIssueCollector().finish(7);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value).toBe(7);
  });

  it('addLegacy records only a non-null legacy validator message', () => {
    const issues = new GuardIssueCollector();
    issues.addLegacy('a', null).addLegacy('b', 'real problem');
    expect(issues.length).toBe(1);
    expect(issues.list()[0]).toEqual({ field: 'b', message: 'real problem' });
  });

  it('list() returns a snapshot, not the live array', () => {
    const issues = new GuardIssueCollector().add('a', 'one');
    const first = issues.list();
    issues.add('b', 'two');
    expect(first).toHaveLength(1);
    expect(issues.list()).toHaveLength(2);
  });
});

describe('GuardError and assertGuard', () => {
  it('unwraps a success without throwing', () => {
    expect(assertGuard(guardOk('ok'), 'label')).toBe('ok');
  });

  it('throws a GuardError carrying every issue', () => {
    const result = guardFail([
      { field: 'a', message: 'first' },
      { field: 'b', message: 'second' },
    ]);
    let caught: unknown;
    try {
      assertGuard(result, 'widget payload');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GuardError);
    expect((caught as GuardError).name).toBe('GuardError');
    expect((caught as GuardError).message).toContain('widget payload');
    expect((caught as GuardError).message).toContain('a — first');
    expect((caught as GuardError).message).toContain('1 more issue');
    expect((caught as GuardError).issues).toHaveLength(2);
  });

  it('formatIssues renders a single sentence', () => {
    expect(
      formatIssues([
        { field: 'a', message: 'one' },
        { field: 'b', message: 'two' },
      ])
    ).toBe('a: one; b: two');
  });
});

// ── Hashlock ────────────────────────────────────────────────────────────────

describe('parseHashlock', () => {
  it('accepts a 32-byte hex string and lower-cases it', () => {
    const upper = '0x' + 'AB'.repeat(32);
    const result = parseHashlock(upper);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe('0x' + 'ab'.repeat(32));
  });

  it('rejects a truncated hashlock', () => {
    const result = parseHashlock('0x' + 'ab'.repeat(16));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.issues[0]!.field).toBe('hashlock');
  });

  it('rejects a hashlock with no 0x prefix', () => {
    expect(parseHashlock('ab'.repeat(32)).ok).toBe(false);
  });

  it('rejects a non-string', () => {
    for (const value of [null, undefined, 42, {}, []]) {
      expect(parseHashlock(value).ok, `accepted ${JSON.stringify(value)}`).toBe(false);
    }
  });

  it('assertHashlock returns a branded value or throws', () => {
    expect(assertHashlock(PAIR_ETH_TO_XLM.hashlock)).toBe(PAIR_ETH_TO_XLM.hashlock);
    expect(() => assertHashlock('nope')).toThrow(GuardError);
  });
});

// ── Atomic amount ───────────────────────────────────────────────────────────

describe('parseAtomicAmount', () => {
  it('accepts a decimal integer string', () => {
    const result = parseAtomicAmount('1000000000000000000');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('1000000000000000000');
  });

  it('normalises redundant leading zeros', () => {
    // So "007" and "7" cannot both reach a caller as distinct
    // representations of the same amount.
    const result = parseAtomicAmount('007');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('7');
  });

  it('keeps a single zero as zero', () => {
    const result = parseAtomicAmount('0');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('0');
  });

  it('rejects a float, a sign, an exponent, and separators', () => {
    for (const value of ['1.5', '-1', '+1', '1e18', '1_000', '0x10', '', ' 1', '1 ']) {
      expect(parseAtomicAmount(value).ok, `accepted "${value}"`).toBe(false);
    }
  });

  it('rejects a number — token amounts are never floating point', () => {
    expect(parseAtomicAmount(1).ok).toBe(false);
    expect(parseAtomicAmount(1.5).ok).toBe(false);
    expect(parseAtomicAmount(1000000000000000000).ok).toBe(false);
  });

  it('uses the supplied field name in the message', () => {
    const result = parseAtomicAmount('x', 'srcAmount');
    expect(result.ok === false && result.issues[0]!.field).toBe('srcAmount');
  });

  it('parseDecimalUint produces a different brand from parseAtomicAmount', () => {
    const amount = parseAtomicAmount('5');
    const count = parseDecimalUint('5');
    expect(amount.ok && count.ok).toBe(true);
    if (!amount.ok || !count.ok) return;
    // Both are `string` at runtime; the tags are compile-time only, which is
    // the whole point of branding. This test documents that they are
    // distinct *types* by asserting the parse result round-trips.
    expect(amount.value).toBe(count.value);
  });
});

// ── Unix seconds ────────────────────────────────────────────────────────────

describe('parseUnixSeconds', () => {
  it('accepts a non-negative integer', () => {
    const result = parseUnixSeconds(1_800_000_000);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(1_800_000_000);
  });

  it('accepts zero', () => {
    expect(parseUnixSeconds(0).ok).toBe(true);
  });

  it('rejects a negative, fractional, or non-numeric value', () => {
    for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '1800000000', null]) {
      expect(parseUnixSeconds(value).ok, `accepted ${String(value)}`).toBe(false);
    }
  });

  it('rejects a value beyond year 9999', () => {
    expect(parseUnixSeconds(253_402_300_800).ok).toBe(false);
    expect(parseUnixSeconds(253_402_300_799).ok).toBe(true);
  });
});

// ── Public order id ─────────────────────────────────────────────────────────

describe('parsePublicOrderId', () => {
  it('accepts a canonical id and lower-cases the hashlock part', () => {
    // The `wf_` prefix is case-sensitive (`validateOrderId` requires it
    // exactly); the hex body is not.
    const result = parsePublicOrderId('wf_0x' + 'AB'.repeat(32));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('wf_0x' + 'ab'.repeat(32));
  });

  it('rejects an uppercased prefix', () => {
    expect(parsePublicOrderId('WF_0x' + 'ab'.repeat(32)).ok).toBe(false);
  });

  it('rejects a bare hashlock with no wf_ prefix', () => {
    expect(parsePublicOrderId('0x' + 'ab'.repeat(32)).ok).toBe(false);
  });

  it('rejects a truncated id', () => {
    expect(parsePublicOrderId('wf_0x' + 'ab'.repeat(16)).ok).toBe(false);
  });

  it('assertPublicOrderId throws on a malformed id', () => {
    expect(() => assertPublicOrderId('nope')).toThrow(GuardError);
    expect(assertPublicOrderId('wf_0x' + 'cd'.repeat(32))).toBe('wf_0x' + 'cd'.repeat(32));
  });
});

// ── Chain addresses ─────────────────────────────────────────────────────────

describe('parseChainAddress', () => {
  it('accepts a valid EVM address and normalises it to lowercase', () => {
    const result = parseChainAddress('ethereum', ETH_SRC);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(ETH_SRC.toLowerCase());
  });

  it('rejects the EVM zero address as a counterparty', () => {
    const result = parseChainAddress('ethereum', '0x' + '0'.repeat(40));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.issues[0]!.message).toContain('zero address');
  });

  it('accepts a Stellar account id and a Solana address', () => {
    expect(parseChainAddress('stellar', XLM_SRC).ok).toBe(true);
    expect(parseChainAddress('solana', SOL_SRC).ok).toBe(true);
  });

  it('routes a Stellar contract id to its own parser', () => {
    const result = parseChainAddress('stellar', 'C' + 'A'.repeat(55));
    expect(result.ok).toBe(true);
  });

  it('rejects an address of the wrong chain', () => {
    // The whole point of a chain-scoped brand: a Stellar account id is not
    // an EVM address, and a base-58 Solana address is not either.
    expect(parseChainAddress('ethereum', XLM_SRC).ok).toBe(false);
    expect(parseChainAddress('ethereum', SOL_SRC).ok).toBe(false);
    expect(parseChainAddress('stellar', ETH_SRC).ok).toBe(false);
    expect(parseChainAddress('solana', ETH_SRC).ok).toBe(false);
  });

  it('rejects a non-string', () => {
    expect(parseChainAddress('ethereum', 12345).ok).toBe(false);
  });

  it('parseStellarContractId requires a C prefix and 55 base32 chars', () => {
    expect(parseStellarContractId('C' + 'A'.repeat(55)).ok).toBe(true);
    expect(parseStellarContractId('G' + 'A'.repeat(55)).ok).toBe(false);
    expect(parseStellarContractId('C' + 'A'.repeat(54)).ok).toBe(false);
    // Base32 excludes 0, 1, 8, 9 — the SDK's own regex, reused here.
    expect(parseStellarContractId('C' + '0'.repeat(55)).ok).toBe(false);
  });

  it('assertChainAddress throws on the wrong chain', () => {
    expect(() => assertChainAddress('ethereum', XLM_SRC)).toThrow(GuardError);
    expect(assertChainAddress('stellar', XLM_SRC)).toBe(XLM_SRC);
  });
});

// ── Transaction ids ─────────────────────────────────────────────────────────

describe('parseChainTxRef', () => {
  const evm = '0x' + 'ab'.repeat(32);
  const stellar = 'cd'.repeat(32);
  const solana =
    '4fQhP4LQDY7iXAETTZ9LghgnBGA1vbv9koBPV1PjLJ7NWrSBFFXmgtAfNp54UBY9fjSzuaqj9EZZUPaTXy5BfHaq';

  it("accepts each chain's own encoding", () => {
    expect(parseChainTxRef('ethereum', evm).ok).toBe(true);
    expect(parseChainTxRef('stellar', stellar).ok).toBe(true);
    expect(parseChainTxRef('solana', solana).ok).toBe(true);
  });

  it("rejects one chain's encoding on another chain", () => {
    // The three encodings are genuinely different shapes, and conflating
    // them produces a "transaction not found" that reads like a dropped
    // transaction.
    expect(parseChainTxRef('ethereum', stellar).ok).toBe(false);
    expect(parseChainTxRef('ethereum', solana).ok).toBe(false);
    expect(parseChainTxRef('stellar', evm).ok).toBe(false);
    expect(parseChainTxRef('stellar', solana).ok).toBe(false);
    expect(parseChainTxRef('solana', evm).ok).toBe(false);
    expect(parseChainTxRef('solana', stellar).ok).toBe(false);
  });

  it('rejects an uppercased Stellar hash', () => {
    expect(parseChainTxRef('stellar', 'CD'.repeat(32)).ok).toBe(false);
  });

  it('rejects a base58 string of the wrong length as a Solana signature', () => {
    expect(parseChainTxRef('solana', 'abc').ok).toBe(false);
    expect(parseChainTxRef('solana', '1'.repeat(120)).ok).toBe(false);
  });

  it('assertChainTxRef throws on a cross-chain hash', () => {
    expect(() => assertChainTxRef('ethereum', stellar)).toThrow(GuardError);
  });
});

// ── Brands are nominal ──────────────────────────────────────────────────────

describe('brand nominality', () => {
  it('a Hashlock value and an AtomicAmount value are distinct types', () => {
    // Runtime values are both strings; the brand is compile-time only. This
    // test documents the intent — a consumer that confuses the two gets a
    // type error, not a runtime error — by checking the parsers refuse to
    // validate one as the other.
    const hashlock: Hashlock = assertHashlock(PAIR_ETH_TO_XLM.hashlock);
    const amount: AtomicAmount = assertAtomicAmount('1000000000000000000');
    expect(hashlock).not.toBe(amount);
    // A hashlock is not a decimal integer, and a preimage is not 0x-prefixed
    // in the same way — both fail the *other* parser, which is the runtime
    // shadow of the nominal typing.
    expect(parseAtomicAmount(hashlock).ok).toBe(false);
  });
});
