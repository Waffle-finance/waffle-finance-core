/**
 * Branded scalar types for the chain identifiers and money values that cross
 * the SDK's trust boundaries (#733).
 *
 * The problem
 * ───────────
 * `Order.hashlock` is `` `0x${string}` ``, `ChainLeg.address` is `string`,
 * and `ChainLeg.amount` is `string`. All three are "validated somewhere" —
 * the coordinator request path checks them in
 * `coordinator/validation.ts` — but the *types* say nothing. A plain
 * `string` carrying a Stellar account id compiles fine against a field that
 * expects an EVM address, and a decimal string carrying a float compiles
 * fine against an atomic-amount field. The only signal is a runtime throw
 * several frames away from the mistake.
 *
 * Why branded types, and why only as new names
 * ─────────────────────────────────────────────
 * Replacing `ChainLeg.address: string` with `EvmAddress` would be a breaking
 * change to a published package: every existing consumer that builds a
 * `ChainLeg` from a `string` stops compiling, and `strictNullChecks`-style
 * inference does not save them. This package is at version 1.0.0 with a
 * hand-maintained `exports` map, so a source-compatible widening is worth
 * more than a stricter-but-breaking one.
 *
 * So the brands here are **additive**: new names, new parsers, no edits to
 * `types/index.ts` or `coordinator/contract.ts`. A consumer opts in by
 * running a value through a parser and keeping the branded type. Nothing
 * that compiles today stops compiling.
 *
 * Where the rules come from
 * ─────────────────────────
 * The address / hashlock / amount rules are **not re-implemented here**. Each
 * parser delegates to the SDK's own validators so a brand and a request-path
 * check can never disagree:
 *   • addresses → `coordinator/validation.ts` `validateChainAddress`
 *   • hashlocks  → `coordinator/validation.ts` `validateHashlockField`
 *   • amounts    → `coordinator/validation.ts` `validateDecimalIntField`
 *   • order ids  → `shared-utils/index.ts` `validateOrderId`
 *
 * That reuse is deliberate: a second copy of the Stellar regex would be a
 * second thing to keep in sync with the coordinator.
 *
 * Money
 * ─────
 * `AtomicAmount` is a decimal *string*, never a `number`. A `number` cannot
 * hold a u256 token amount exactly, and the SDK does not use floating point
 * for token amounts (see the house rule in WF-SPEC §2).
 */

import {
  validateChainAddress,
  validateDecimalIntField,
  validateHashlockField,
} from '../coordinator/validation.js';
import { validateOrderId } from '../shared-utils/index.js';
import type { Chain } from '../types/index.js';
import { guardFailOne, assertGuard, type GuardResult } from './result.js';

// ── The brand ───────────────────────────────────────────────────────────────

declare const BRAND: unique symbol;

/**
 * Attach a compile-time-only tag to a base type. The tag has no runtime
 * representation, so a brand costs nothing at runtime and disappears in the
 * emitted `.d.ts` as an opaque nominal type.
 */
export type Brand<TBase, TTag extends string> = TBase & {
  readonly [BRAND]: TTag;
};

// ── Branded identities ──────────────────────────────────────────────────────

/** `0x` + 64 hex chars — a 32-byte hashlock (sha256 or keccak256 digest). */
export type Hashlock = Brand<string, 'Hashlock'>;

/** `0x` + 40 hex chars, non-zero — an EVM account or contract address. */
export type EvmAddress = Brand<string, 'EvmAddress'>;

/** `G` + 55 base32 chars — a Stellar ed25519 account id. */
export type StellarAccountId = Brand<string, 'StellarAccountId'>;

/** `C` + 55 base32 chars — a Stellar contract id (e.g. a SAC address). */
export type StellarContractId = Brand<string, 'StellarContractId'>;

/** base58, 32–44 chars — a Solana pubkey (wallet, mint, or PDA). */
export type SolanaAddress = Brand<string, 'SolanaAddress'>;

/** Any chain address, discriminated by the chain it belongs to. */
export type ChainAddress = EvmAddress | StellarAccountId | StellarContractId | SolanaAddress;

/** `wf_0x<64 hex>` — the coordinator's canonical public order id. */
export type PublicOrderId = Brand<string, 'PublicOrderId'>;

/**
 * `0x` + 64 hex chars — an EVM transaction hash.
 *
 * Distinct from {@link Hashlock} even though both are 32 bytes, because a
 * caller that swaps a preimage-derived digest for a chain tx hash is exactly
 * the class of bug #733 is about.
 */
export type EvmTxHash = Brand<string, 'EvmTxHash'>;

/** 64 lowercase hex chars — a Stellar transaction hash (no `0x` prefix). */
export type StellarTxHash = Brand<string, 'StellarTxHash'>;

/** base58, ~86–88 chars — a Solana transaction signature (64 raw bytes). */
export type SolanaSignature = Brand<string, 'SolanaSignature'>;

/** Any chain's transaction identifier, discriminated by chain. */
export type ChainTxRef = EvmTxHash | StellarTxHash | SolanaSignature;

// ── Branded values ──────────────────────────────────────────────────────────

/** A non-negative integer in the asset's atomic units, as a decimal string. */
export type AtomicAmount = Brand<string, 'AtomicAmount'>;

/** A non-negative integer count, as a decimal string (order ids, nonces). */
export type DecimalUint = Brand<string, 'DecimalUint'>;

/** An absolute unix timestamp in whole seconds. */
export type UnixSeconds = Brand<number, 'UnixSeconds'>;

/**
 * `number` of seconds, or `null` for "not locked yet".
 *
 * `ChainLeg.timelock` is `number | null | undefined` today; this brand makes
 * the "0 means unset" confusion impossible by refusing a negative or
 * non-integer value outright.
 */
export type OptionalUnixSeconds = UnixSeconds | null;

// ── Parsers ─────────────────────────────────────────────────────────────────

/** Parse a 32-byte hex hashlock. */
export function parseHashlock(input: unknown): GuardResult<Hashlock> {
  if (typeof input !== 'string') {
    return guardFailOne('hashlock', 'must be a string');
  }
  const message = validateHashlockField(input);
  if (message !== null) return guardFailOne('hashlock', message);
  return { ok: true, value: input.toLowerCase() as Hashlock };
}

/** Parse an atomic amount (non-negative decimal integer string). */
export function parseAtomicAmount(input: unknown, field = 'amount'): GuardResult<AtomicAmount> {
  if (typeof input !== 'string') {
    return guardFailOne(field, `${field} must be a string`);
  }
  const message = validateDecimalIntField(input, field);
  if (message !== null) return guardFailOne(field, message);
  // `validateDecimalIntField` uses /^\d+$/, so the value is already known to
  // be a non-empty run of digits with no leading sign or separator. Strip
  // redundant leading zeros so "007" and "7" cannot both reach a caller as
  // distinct representations of the same amount.
  return { ok: true, value: input.replace(/^0+(?=\d)/, '') as AtomicAmount };
}

/**
 * Parse a non-negative decimal integer string that is not money.
 *
 * Shares the decimal-integer rule with {@link parseAtomicAmount} — the two
 * differ only in what the brand means, not in what is accepted — but gets
 * its own brand so an order id cannot be passed where an amount is
 * expected.
 */
export function parseDecimalUint(input: unknown, field = 'value'): GuardResult<DecimalUint> {
  const result = parseAtomicAmount(input, field);
  if (!result.ok) return result;
  return { ok: true, value: result.value as unknown as DecimalUint };
}

/** Parse an absolute unix timestamp in seconds. */
export function parseUnixSeconds(input: unknown, field = 'timelock'): GuardResult<UnixSeconds> {
  if (typeof input !== 'number' || !Number.isInteger(input)) {
    return guardFailOne(field, `${field} must be an integer number of seconds`);
  }
  if (input < 0) {
    return guardFailOne(field, `${field} must not be negative`);
  }
  if (input > 253_402_300_799) {
    return guardFailOne(field, `${field} must be a real unix timestamp (max 9999-12-31T23:59:59Z)`);
  }
  return { ok: true, value: input as UnixSeconds };
}

/** Parse a canonical `wf_0x<64 hex>` coordinator public order id. */
export function parsePublicOrderId(input: unknown, field = 'publicId'): GuardResult<PublicOrderId> {
  if (typeof input !== 'string') {
    return guardFailOne(field, 'order id must be a string');
  }
  const message = validateOrderId(input);
  if (message !== null) return guardFailOne(field, message);
  return { ok: true, value: input.toLowerCase() as PublicOrderId };
}

// ── Chain address parsers ───────────────────────────────────────────────────

const STELLAR_CONTRACT_ID = /^C[A-Z2-7]{55}$/;

/** Parse a Stellar contract id (`C…`). */
export function parseStellarContractId(
  input: unknown,
  field = 'address'
): GuardResult<StellarContractId> {
  if (typeof input !== 'string') {
    return guardFailOne(field, 'contract id must be a string');
  }
  if (!STELLAR_CONTRACT_ID.test(input)) {
    return guardFailOne(field, `${input} is not a valid Stellar contract id (C + 55 base32 chars)`);
  }
  return { ok: true, value: input as StellarContractId };
}

/**
 * Parse an address for a specific chain.
 *
 * Delegates to `coordinator/validation.ts` `validateChainAddress` so the
 * brand can never disagree with the announce-request preflight — including
 * the Ethereum zero-address rejection, which a bare regex would miss.
 */
export function parseChainAddress(
  chain: Chain,
  input: unknown,
  field = 'address'
): GuardResult<ChainAddress> {
  if (typeof input !== 'string') {
    return guardFailOne(field, `${field} must be a string`);
  }
  // A Stellar contract id is a legal `asset` value on the Stellar leg but is
  // not a legal *account* address, so it is rejected by
  // `validateChainAddress`. Route it through its own parser when the caller
  // explicitly asked for the generic chain-address brand and the value looks
  // like a contract id.
  if (chain === 'stellar' && STELLAR_CONTRACT_ID.test(input)) {
    return parseStellarContractId(input, field);
  }
  const message = validateChainAddress(chain, input);
  if (message !== null) return guardFailOne(field, message);

  switch (chain) {
    case 'ethereum':
      // Normalise to lowercase so the same account never compares unequal
      // because one producer checksummed and another did not.
      return { ok: true, value: input.toLowerCase() as EvmAddress };
    case 'stellar':
      return { ok: true, value: input as StellarAccountId };
    case 'solana':
      return { ok: true, value: input as SolanaAddress };
  }
}

// ── Chain tx-id parsers ─────────────────────────────────────────────────────

const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const HEX64_NO_PREFIX = /^[0-9a-f]{64}$/;
const SOLANA_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{86,90}$/;

/**
 * Parse a chain transaction identifier for a specific chain.
 *
 * `orderId` on Ethereum is a uint256 and is deliberately *not* handled here —
 * use {@link parseDecimalUint} for it. The three tx-id encodings are
 * genuinely different shapes and conflating them is a bug the brand
 * prevents.
 */
export function parseChainTxRef(
  chain: Chain,
  input: unknown,
  field = 'lockTx'
): GuardResult<ChainTxRef> {
  if (typeof input !== 'string') {
    return guardFailOne(field, `${field} must be a string`);
  }
  if (chain === 'ethereum') {
    if (!HEX32.test(input)) {
      return guardFailOne(field, `${field} is not a 32-byte EVM tx hash (0x + 64 hex chars)`);
    }
    return { ok: true, value: input.toLowerCase() as EvmTxHash };
  }
  if (chain === 'stellar') {
    if (!HEX64_NO_PREFIX.test(input)) {
      return guardFailOne(field, `${field} is not a Stellar tx hash (64 lowercase hex chars)`);
    }
    return { ok: true, value: input as StellarTxHash };
  }
  if (!SOLANA_SIGNATURE.test(input)) {
    return guardFailOne(
      field,
      `${field} is not a base-58 Solana signature (86–90 chars from a 64-byte signature)`
    );
  }
  return { ok: true, value: input as SolanaSignature };
}

// ── Assertion forms ─────────────────────────────────────────────────────────

export function assertHashlock(input: unknown): Hashlock {
  return assertGuard(parseHashlock(input), 'hashlock');
}

export function assertAtomicAmount(input: unknown, field = 'amount'): AtomicAmount {
  return assertGuard(parseAtomicAmount(input, field), field);
}

export function assertPublicOrderId(input: unknown, field = 'publicId'): PublicOrderId {
  return assertGuard(parsePublicOrderId(input, field), 'public order id');
}

export function assertChainAddress(chain: Chain, input: unknown, field = 'address'): ChainAddress {
  return assertGuard(parseChainAddress(chain, input, field), `${chain} address`);
}

export function assertChainTxRef(chain: Chain, input: unknown, field = 'lockTx'): ChainTxRef {
  return assertGuard(parseChainTxRef(chain, input, field), `${chain} transaction id`);
}
