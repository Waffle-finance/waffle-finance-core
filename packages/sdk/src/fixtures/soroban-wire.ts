/**
 * SYNTHETIC Soroban / Stellar wire fixtures (#732).
 *
 * PROVENANCE
 * ───────────
 * The `retval` values in this file are **byte-exact base64 XDR** — but they
 * are *encoded here*, at module load, by `encodeSorobanOrder`, from a
 * JavaScript object that mirrors the real `Order` struct declared in
 * `soroban/contracts/htlc/src/lib.rs`:
 *
 * ```rust
 * pub struct Order {
 *   pub id: u64, pub version: u32,
 *   pub sender: Address, pub beneficiary: Address, pub refund_address: Address,
 *   pub asset: Address, pub asset_class: AssetClass,
 *   pub amount: i128, pub safety_deposit: i128,
 *   pub hashlock: BytesN<32>, pub timelock: u64,
 *   pub status: OrderStatus, pub preimage: Bytes,
 *   pub created_at: u64, pub finalised_at: u64,
 * }
 * ```
 *
 * Every field name, position and ScVal type above is read off that struct,
 * and the `AssetClass` / `OrderStatus` discriminants (`Native = 0` /
 * `Token = 1`; `Funded = 0` / `Claimed = 1` / `Refunded = 2`) come from the
 * same file. Because Soroban encodes a `#[contracttype]` struct as an
 * `ScMap` with `ScVal::Symbol` keys, `scValToNative` returns a **plain JS
 * object with string keys** — which is what `SorobanHTLCClient.getOrder`
 * would hand a consumer, and what `decodeSorobanOrder` below reproduces.
 *
 * Encoding rather than pasting is deliberate. A hand-transcribed 800-character
 * base64 blob is a transcription risk with no upside: the byte sequence is
 * reproducible from the struct, so the fixture derives it and the test
 * suite decodes it back. A typo cannot survive, because there is nothing to
 * typo.
 *
 * The *values* inside are synthetic (see `fixtures/identities.ts`). The
 * `asset` field is a `C…` contract id, so `asset_class` is `Token` (1),
 * matching how the contract infers it.
 *
 * Why this file also carries the JSON-RPC envelopes
 * ─────────────────────────────────────────────────
 * `src/soroban/index.ts` reads `(sim as any).result` and then `result.retval`,
 * passing `retval` straight to `scValToNative`. On a real Soroban RPC node
 * `retval` is a **base64 XDR string**, not an `ScVal`, so that call cannot
 * work as written. `soroban/index.ts` is outside this agent's file boundary,
 * so it is reported rather than fixed. What these fixtures do is pin the
 * correct shape: `SOROBAN_SIM_RESPONSE_FUNDED` is what a real
 * `simulateTransaction` reply looks like, and the tests decode it with
 * `xdr.ScVal.fromXDR(retval, "base64")` + `scValToNative`, which is the
 * sequence `soroban/index.ts` needs.
 */

import { Address, nativeToScVal, scValToNative, xdr } from '@stellar/stellar-sdk';
import { FIXTURE_EPOCH } from './ethereum-wire.js';
import {
  PAIR_SOL_TO_ETH,
  XLM_DST,
  XLM_SAC,
  XLM_SRC,
  XLM_TX_CLAIM,
  XLM_TX_CREATE,
} from './identities.js';

// ── On-chain enums (soroban/contracts/htlc/src/lib.rs) ─────────────────────

/** `soroban::OrderStatus` discriminants. */
export const SOROBAN_ORDER_STATUS = {
  /** Funds locked, preimage not revealed. */
  Funded: 0,
  /** Beneficiary revealed the preimage and was paid. */
  Claimed: 1,
  /** Timelock expired and the refund address was repaid. */
  Refunded: 2,
} as const;

export type SorobanOrderStatusValue =
  (typeof SOROBAN_ORDER_STATUS)[keyof typeof SOROBAN_ORDER_STATUS];

/** `soroban::AssetClass` discriminants. */
export const SOROBAN_ASSET_CLASS = {
  Native: 0,
  Token: 1,
} as const;

// ── The decoded native shape ────────────────────────────────────────────────

/**
 * The result of `scValToNative` on the `get_order` retval.
 *
 * `Address` fields come back as base-35 strings, `u64` / `i128` as `bigint`,
 * `u32` as `number`, and `Bytes` as a `Uint8Array`. The last of those is the
 * one that bites: a consumer that assumes `hashlock` is a `0x…` string gets
 * `[object Object]` in a log, and the SDK's own `hex32ToBuffer` throws.
 * Recording the real shape is the whole point of this fixture.
 */
export interface SorobanOrderNative {
  id: bigint;
  version: number;
  sender: string;
  beneficiary: string;
  refund_address: string;
  asset: string;
  asset_class: number;
  amount: bigint;
  safety_deposit: bigint;
  hashlock: Uint8Array;
  timelock: bigint;
  status: number;
  preimage: Uint8Array;
  created_at: bigint;
  finalised_at: bigint;
}

// ── Encoding ────────────────────────────────────────────────────────────────

/** JavaScript-shaped input to {@link encodeSorobanOrder}. */
export interface SorobanOrderInput {
  id: bigint;
  version: number;
  sender: string;
  beneficiary: string;
  refundAddress: string;
  asset: string;
  assetClass: number;
  amount: bigint;
  safetyDeposit: bigint;
  /** 32 raw bytes. */
  hashlock: Uint8Array;
  timelock: bigint;
  status: number;
  preimage: Uint8Array;
  createdAt: bigint;
  finalisedAt: bigint;
}

/**
 * Encode a `SorobanHTLCClient.getOrder` value as the base64 XDR a
 * `simulateTransaction` reply carries in `result.retval`.
 *
 * Each entry becomes an `ScMapEntry` with an `ScVal::Symbol` key, which is
 * exactly how `soroban-macro` emits a `#[contracttype]` struct. ScVal types
 * match the Rust field types: `u64` → `scvU64`, `u32` → `scvU32`,
 * `i128` → `scvI128`, `Address` → `scvAddress`, `BytesN<32>` / `Bytes` →
 * `scvBytes`.
 */
export function encodeSorobanOrder(order: SorobanOrderInput): string {
  const entry = (key: string, val: xdr.ScVal): xdr.ScMapEntry =>
    new xdr.ScMapEntry({ key: nativeToScVal(key, { type: 'symbol' }), val });

  const map = xdr.ScVal.scvMap([
    entry('id', nativeToScVal(order.id, { type: 'u64' })),
    entry('version', nativeToScVal(order.version, { type: 'u32' })),
    entry('sender', new Address(order.sender).toScVal()),
    entry('beneficiary', new Address(order.beneficiary).toScVal()),
    entry('refund_address', new Address(order.refundAddress).toScVal()),
    entry('asset', new Address(order.asset).toScVal()),
    entry('asset_class', nativeToScVal(order.assetClass, { type: 'u32' })),
    entry('amount', nativeToScVal(order.amount, { type: 'i128' })),
    entry('safety_deposit', nativeToScVal(order.safetyDeposit, { type: 'i128' })),
    entry('hashlock', nativeToScVal(order.hashlock, { type: 'bytes' })),
    entry('timelock', nativeToScVal(order.timelock, { type: 'u64' })),
    entry('status', nativeToScVal(order.status, { type: 'u32' })),
    entry('preimage', nativeToScVal(order.preimage, { type: 'bytes' })),
    entry('created_at', nativeToScVal(order.createdAt, { type: 'u64' })),
    entry('finalised_at', nativeToScVal(order.finalisedAt, { type: 'u64' })),
  ]);

  return map.toXDR('base64');
}

/**
 * Decode a base64 XDR `retval` into its native JS form.
 *
 * This is the three-line sequence `soroban/index.ts` should be using:
 * `xdr.ScVal.fromXDR(retval, "base64")` then `scValToNative`. The current
 * code calls `scValToNative` on the base64 *string*, which cannot work.
 */
export function decodeSorobanOrder(retval: string): SorobanOrderNative {
  return scValToNative(xdr.ScVal.fromXDR(retval, 'base64')) as unknown as SorobanOrderNative;
}

// ── Flow 2: sol_to_eth, Stellar side, funded → claimed / refunded ───────────

/** Flow 2's Stellar order while funded. */
export const SOROBAN_ORDER_FUNDED_FLOW_2: SorobanOrderInput = {
  id: 7n,
  version: 1,
  sender: XLM_SRC,
  beneficiary: XLM_DST,
  refundAddress: XLM_SRC,
  asset: XLM_SAC,
  assetClass: SOROBAN_ASSET_CLASS.Token,
  amount: 100_000_000n,
  safetyDeposit: 1_000_000n,
  hashlock: Uint8Array.from(Buffer.from(PAIR_SOL_TO_ETH.hashlock.slice(2), 'hex')),
  timelock: BigInt(FIXTURE_EPOCH + 3_600),
  status: SOROBAN_ORDER_STATUS.Funded,
  preimage: new Uint8Array(0),
  createdAt: BigInt(FIXTURE_EPOCH),
  finalisedAt: 0n,
};

/** Flow 2's Stellar order after the destination chain claimed. */
export const SOROBAN_ORDER_CLAIMED_FLOW_2: SorobanOrderInput = {
  ...SOROBAN_ORDER_FUNDED_FLOW_2,
  status: SOROBAN_ORDER_STATUS.Claimed,
  preimage: Uint8Array.from(Buffer.from(PAIR_SOL_TO_ETH.preimage.slice(2), 'hex')),
  finalisedAt: BigInt(FIXTURE_EPOCH + 120),
};

/** Flow 2's Stellar order after the timelock expired and it refunded. */
export const SOROBAN_ORDER_REFUNDED_FLOW_2: SorobanOrderInput = {
  ...SOROBAN_ORDER_FUNDED_FLOW_2,
  status: SOROBAN_ORDER_STATUS.Refunded,
  finalisedAt: BigInt(FIXTURE_EPOCH + 4_200),
};

/**
 * `retval` for flow 2's `get_order` while `Funded`.
 *
 * Produced by {@link encodeSorobanOrder}, not transcribed. A real `SCVal`
 * for a `#[contracttype]` struct, base64-encoded, as a Soroban RPC node
 * returns it.
 */
export const SOROBAN_RETVAL_FUNDED_FLOW_2 = encodeSorobanOrder(SOROBAN_ORDER_FUNDED_FLOW_2);

/** `retval` for flow 2's `get_order` after the claim. */
export const SOROBAN_RETVAL_CLAIMED_FLOW_2 = encodeSorobanOrder(SOROBAN_ORDER_CLAIMED_FLOW_2);

/** `retval` for flow 2's `get_order` after the refund. */
export const SOROBAN_RETVAL_REFUNDED_FLOW_2 = encodeSorobanOrder(SOROBAN_ORDER_REFUNDED_FLOW_2);

/** Every `retval` for flow 2, in lifecycle order. */
export const SOROBAN_RETVALS_FLOW_2 = {
  funded: SOROBAN_RETVAL_FUNDED_FLOW_2,
  claimed: SOROBAN_RETVAL_CLAIMED_FLOW_2,
  refunded: SOROBAN_RETVAL_REFUNDED_FLOW_2,
} as const;

// ── JSON-RPC envelopes ──────────────────────────────────────────────────────

/**
 * A successful `simulateTransaction` reply carrying flow 2's funded order.
 *
 * The field set and the JS types are those of
 * `rpc.Api.SimulateTransactionSuccessResponse` in `@stellar/stellar-sdk`:
 * the three ledger numbers are plain numbers, and `cost.cpuInsns` /
 * `cost.memBytes` are decimal strings. Getting either wrong would make the
 * fixture validate a shape no node produces.
 */
export const SOROBAN_SIM_RESPONSE_FUNDED = {
  jsonrpc: '2.0',
  id: 1,
  result: {
    status: 'SUCCESS',
    retval: SOROBAN_RETVAL_FUNDED_FLOW_2,
    cost: { cpuInsns: '284517', memBytes: '83968' },
    events: [],
    latestLedger: 51_884_221,
    oldestLedger: 51_782_221,
    latestLedgerCloseTime: 1_800_000_000,
  },
} as const;

/** A failed simulation — the error arm a consumer must not mistake for success. */
export const SOROBAN_SIM_RESPONSE_ERROR = {
  jsonrpc: '2.0',
  id: 1,
  result: {
    status: 'ERROR',
    error: 'HostError: Error(Contract, #1, OrderNotFound)',
    events: [],
    cost: { cpuInsns: '18204', memBytes: '11392' },
    latestLedger: 51_884_221,
    oldestLedger: 51_782_221,
    latestLedgerCloseTime: 1_800_000_000,
  },
} as const;

/** A transport-level JSON-RPC error, for `rpcCallWithFallback`'s error path. */
export const SOROBAN_RPC_ERROR_RATE_LIMITED = {
  jsonrpc: '2.0',
  id: 1,
  error: { code: -32097, message: 'rate limit exceeded, please retry later' },
} as const;

// ── Stellar transaction envelope ────────────────────────────────────────────

/**
 * A `sendTransaction` reply, the shape the orchestration layer polls for.
 *
 * `hash` is a real Stellar tx-hash format: 64 lowercase hex characters, no
 * `0x`. The `envelope` is a real (if minimal) transaction XDR prefix; the
 * orchestration layer only ever treats it as an opaque string to hand to the
 * signer, so a short placeholder is enough and is labelled as such.
 */
export const SOROBAN_TX_ENVELOPE_CREATE_FLOW_2 = {
  status: 'SUCCESS',
  statusCode: 0,
  hash: XLM_TX_CREATE,
  ledger: 51_884_220,
  latestLedger: 51_884_220,
  latestLedgerCloseTime: FIXTURE_EPOCH,
  envelope: 'AAAAAQAAAAAQAAAAB',
  result: { txHash: XLM_TX_CREATE, ledger: 51_884_220 },
} as const;

/** A `sendTransaction` reply for the claim leg. */
export const SOROBAN_TX_ENVELOPE_CLAIM_FLOW_2 = {
  status: 'SUCCESS',
  statusCode: 0,
  hash: XLM_TX_CLAIM,
  ledger: 51_884_222,
  latestLedger: 51_884_222,
  latestLedgerCloseTime: FIXTURE_EPOCH + 120,
  envelope: 'AAAAAQAAAAAQAAAAB',
  result: { txHash: XLM_TX_CLAIM, ledger: 51_884_222 },
} as const;

/** A `sendTransaction` reply that failed — `tx_failed`, a real Soroban status. */
export const SOROBAN_TX_ENVELOPE_FAILED = {
  status: 'FAILED',
  statusCode: 0,
  hash: 'b64a7c9bcd7d4ef4708b6fd2e3de195239b23a6f111efe12c70f5de4de753b25',
  ledger: 51_884_223,
  latestLedger: 51_884_223,
  latestLedgerCloseTime: FIXTURE_EPOCH + 300,
  envelope: 'AAAAAQAAAAAQAAAAB',
  result: { txHash: 'b64a7c9bcd7d4ef4708b6fd2e3de195239b23a6f111efe12c70f5de4de753b25' },
} as const;
