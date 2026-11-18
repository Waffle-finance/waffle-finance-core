/**
 * SYNTHETIC Solana wire fixtures (#732).
 *
 * PROVENANCE — this is the best-grounded fixture set in the suite
 * ───────────────────────────────────────────────────────────────
 * The *bytes* here are produced by the SDK's own serialisers, not
 * hand-written:
 *
 * • Account buffers are built by a local `buildOrderAccount` that writes at
 *   exactly the offsets declared in `src/solana/idl/htlc.ts`
 *   (`FIELD_OFFSET`, little-endian u64/i64, the same 1-byte `Option` tag for
 *   the preimage). They are then decoded in the test suite by
 *   `deserialiseOrderAccount`, the function production uses. So if the IDL
 *   offsets move, the fixtures stop round-tripping and the tests fail.
 * • The 8-byte Anchor discriminator (`HTLC_ORDER_DISCRIMINATOR`) and the
 *   total account size (227 bytes) are the real constants from the IDL, not
 *   invented.
 * • Instruction data buffers are produced by the real builders
 *   (`buildCreateOrderInstruction`, `buildClaimOrderInstruction`,
 *   `buildRefundOrderInstruction`) and checked with the real
 *   `validateInstructionSchema`, which compares size, discriminator, and the
 *   canonical account ordering.
 *
 * The *values* are synthetic — see `fixtures/identities.ts`. In particular
 * `SOL_HTLC_PROGRAM_ID` is not a deployed program, so the order PDAs are the
 * PDAs that program id would produce, derived with the real
 * `findProgramAddressSync`.
 *
 * One thing that is NOT modelled: the buffers are raw account data only. A
 * real `getAccountInfo` reply wraps them in an envelope, and that envelope is
 * a separate trust boundary with its own guard
 * (`guards/rpc-payload.ts` `validateSolanaAccountInfo`). The envelope
 * fixtures live in `coordinator-flows.ts` under `SOLANA_ACCOUNT_INFO_*`.
 */

import { PublicKey } from '@solana/web3.js';
import {
  buildClaimOrderInstruction,
  buildCreateOrderInstruction,
  buildRefundOrderInstruction,
  NATIVE_SOL_MINT,
} from '../solana/index.js';
import {
  FIELD_OFFSET,
  HTLC_ORDER_ACCOUNT_SIZE,
  HTLC_ORDER_DISCRIMINATOR,
  IDL_VERSION,
} from '../solana/idl/htlc.js';
import { readU64LE, hex32ToBuffer, writeU64LE } from '../shared-utils/index.js';
import { FIXTURE_EPOCH } from './ethereum-wire.js';
import {
  PAIR_ETH_TO_SOL_USDC,
  PAIR_SOL_TO_ETH,
  SOL_DST,
  SOL_HTLC_PROGRAM_ID,
  SOL_ORDER_PDA_FLOW_2,
  SOL_ORDER_PDA_FLOW_3,
  SOL_REFUND,
  SOL_SRC,
  SOL_USDC,
} from './identities.js';

// ── Account status (Anchor `OrderStatus` enum) ──────────────────────────────

/** `0 = Active`, `1 = Claimed`, `2 = Refunded` — the IDL's u8 enum. */
export const SOLANA_ORDER_STATUS = {
  Active: 0,
  Claimed: 1,
  Refunded: 2,
} as const;

export type SolanaFixtureStatus = (typeof SOLANA_ORDER_STATUS)[keyof typeof SOLANA_ORDER_STATUS];

/** Fields of an `HTLCOrder` account, before serialisation. */
export interface SolanaOrderAccountFields {
  version: number;
  sender: string;
  beneficiary: string;
  refundAddress: string;
  mint: string;
  /** Lamports / SPL atomic units. */
  amount: bigint;
  safetyDeposit: bigint;
  /** `0x` + 64 hex chars. */
  hashlock: `0x${string}`;
  /** Absolute unix seconds. */
  timelock: number;
  status: SolanaFixtureStatus;
  /** `null` until claimed. */
  preimage: `0x${string}` | null;
}

/**
 * Serialise an `HTLCOrder` account exactly as the Anchor program would.
 *
 * This is the *ground truth* builder for the fixtures. It is deliberately
 * written against the IDL's documented byte map rather than by calling any
 * SDK serialiser, because the SDK has no account serialiser — it only has a
 * deserialiser (`deserialiseOrderAccount`). Writing the encoder here from
 * the same table the deserialiser reads is what makes the round-trip test
 * meaningful: two independent implementations of one spec.
 */
export function buildOrderAccount(fields: SolanaOrderAccountFields): Buffer {
  const buf = Buffer.alloc(HTLC_ORDER_ACCOUNT_SIZE);
  HTLC_ORDER_DISCRIMINATOR.copy(buf, 0);

  const body = buf.subarray(8);
  body.writeUInt8(fields.version, FIELD_OFFSET.version);
  new PublicKey(fields.sender).toBuffer().copy(body, FIELD_OFFSET.sender);
  new PublicKey(fields.beneficiary).toBuffer().copy(body, FIELD_OFFSET.beneficiary);
  new PublicKey(fields.refundAddress).toBuffer().copy(body, FIELD_OFFSET.refundAddress);
  new PublicKey(fields.mint).toBuffer().copy(body, FIELD_OFFSET.mint);
  writeU64LE(body, fields.amount, FIELD_OFFSET.amount);
  writeU64LE(body, fields.safetyDeposit, FIELD_OFFSET.safetyDeposit);
  hex32ToBuffer(fields.hashlock, 'hashlock').copy(body, FIELD_OFFSET.hashlock);

  // `timelock` is an i64, so it goes through the same two u32 halves as the
  // u64 fields. All fixture timestamps are far below 2^63, so the sign bit
  // is clear and a plain two-halves write is exact.
  writeU64LE(body, BigInt(fields.timelock), FIELD_OFFSET.timelock);

  body.writeUInt8(fields.status, FIELD_OFFSET.status);

  if (fields.preimage === null) {
    body.writeUInt8(0, FIELD_OFFSET.preimage);
  } else {
    body.writeUInt8(1, FIELD_OFFSET.preimage);
    hex32ToBuffer(fields.preimage, 'preimage').copy(body, FIELD_OFFSET.preimage + 1);
  }

  return buf;
}

// ── Flow 2: sol_to_eth, native SOL, refunded ────────────────────────────────

/** Flow 2: 2 SOL locked, refunded after the timelock expired. */
export const SOLANA_ORDER_FLOW_2_REFUNDED: SolanaOrderAccountFields = {
  version: IDL_VERSION,
  sender: SOL_SRC,
  beneficiary: SOL_DST,
  refundAddress: SOL_REFUND,
  mint: NATIVE_SOL_MINT,
  amount: 2_000_000_000n,
  safetyDeposit: 10_000_000n,
  hashlock: PAIR_SOL_TO_ETH.hashlock,
  timelock: FIXTURE_EPOCH + 1_800,
  status: SOLANA_ORDER_STATUS.Refunded,
  preimage: null,
};

/** Flow 2: the same account at the moment it was funded. */
export const SOLANA_ORDER_FLOW_2_ACTIVE: SolanaOrderAccountFields = {
  ...SOLANA_ORDER_FLOW_2_REFUNDED,
  status: SOLANA_ORDER_STATUS.Active,
};

/** Flow 2: the same account after the destination chain revealed the preimage. */
export const SOLANA_ORDER_FLOW_2_CLAIMED: SolanaOrderAccountFields = {
  ...SOLANA_ORDER_FLOW_2_REFUNDED,
  status: SOLANA_ORDER_STATUS.Claimed,
  preimage: PAIR_SOL_TO_ETH.preimage,
};

/** Flow 2: the raw 227-byte account buffer, refunded state. */
export const SOLANA_ACCOUNT_BUFFER_FLOW_2_REFUNDED = buildOrderAccount(
  SOLANA_ORDER_FLOW_2_REFUNDED
);
/** Flow 2: the raw 227-byte account buffer, active state. */
export const SOLANA_ACCOUNT_BUFFER_FLOW_2_ACTIVE = buildOrderAccount(SOLANA_ORDER_FLOW_2_ACTIVE);
/** Flow 2: the raw 227-byte account buffer, claimed state. */
export const SOLANA_ACCOUNT_BUFFER_FLOW_2_CLAIMED = buildOrderAccount(SOLANA_ORDER_FLOW_2_CLAIMED);

// ── Flow 3: eth_to_sol, USDC, claimed ───────────────────────────────────────

/** Flow 3: 250 USDC locked in an SPL-mint-backed order, then claimed. */
export const SOLANA_ORDER_FLOW_3_ACTIVE: SolanaOrderAccountFields = {
  version: IDL_VERSION,
  sender: SOL_DST,
  beneficiary: SOL_DST,
  refundAddress: SOL_REFUND,
  mint: SOL_USDC,
  amount: 250_000_000n,
  safetyDeposit: 5_000_000n,
  hashlock: PAIR_ETH_TO_SOL_USDC.hashlock,
  timelock: FIXTURE_EPOCH + 1_800,
  status: SOLANA_ORDER_STATUS.Active,
  preimage: null,
};

/** Flow 3: after the claim. */
export const SOLANA_ORDER_FLOW_3_CLAIMED: SolanaOrderAccountFields = {
  ...SOLANA_ORDER_FLOW_3_ACTIVE,
  status: SOLANA_ORDER_STATUS.Claimed,
  preimage: PAIR_ETH_TO_SOL_USDC.preimage,
};

/** Flow 3: the raw 227-byte account buffer, active state. */
export const SOLANA_ACCOUNT_BUFFER_FLOW_3_ACTIVE = buildOrderAccount(SOLANA_ORDER_FLOW_3_ACTIVE);
/** Flow 3: the raw 227-byte account buffer, claimed state. */
export const SOLANA_ACCOUNT_BUFFER_FLOW_3_CLAIMED = buildOrderAccount(SOLANA_ORDER_FLOW_3_CLAIMED);

// ── Negative-path buffers ───────────────────────────────────────────────────

/**
 * An account whose `version` byte is newer than `IDL_VERSION`.
 *
 * `deserialiseOrderAccount` must reject this rather than misparse it. That
 * is the single most important negative fixture in the suite: silent field
 * misparse is how an SDK starts reporting the wrong amounts.
 */
export const SOLANA_ACCOUNT_BUFFER_FUTURE_VERSION = (() => {
  const buf = Buffer.from(SOLANA_ACCOUNT_BUFFER_FLOW_2_ACTIVE);
  buf.writeUInt8(IDL_VERSION + 1, 8 + FIELD_OFFSET.version);
  return buf;
})();

/** An account truncated to 100 bytes — shorter than the 227 the IDL requires. */
export const SOLANA_ACCOUNT_BUFFER_TRUNCATED = SOLANA_ACCOUNT_BUFFER_FLOW_2_ACTIVE.subarray(0, 100);

/** An account with a corrupted discriminator. */
export const SOLANA_ACCOUNT_BUFFER_BAD_DISCRIMINATOR = (() => {
  const buf = Buffer.from(SOLANA_ACCOUNT_BUFFER_FLOW_2_ACTIVE);
  buf.writeUInt8(0x00, 0);
  return buf;
})();

// ── Instruction data buffers, built by the SDK's own builders ───────────────

const PROGRAM_PK = new PublicKey(SOL_HTLC_PROGRAM_ID);

/** Flow 2's `create_order` instruction, built by the production builder. */
export const SOLANA_IX_CREATE_FLOW_2 = buildCreateOrderInstruction(PROGRAM_PK, {
  payer: new PublicKey(SOL_SRC),
  beneficiary: new PublicKey(SOL_DST),
  refundAddress: new PublicKey(SOL_REFUND),
  mint: new PublicKey(NATIVE_SOL_MINT),
  amount: 2_000_000_000n,
  safetyDeposit: 10_000_000n,
  hashlockBytes: hex32ToBuffer(PAIR_SOL_TO_ETH.hashlock, 'hashlock'),
  timelockAbsolute: FIXTURE_EPOCH + 1_800,
});

/** Flow 2's `claim_order` instruction. */
export const SOLANA_IX_CLAIM_FLOW_2 = buildClaimOrderInstruction(PROGRAM_PK, {
  claimer: new PublicKey(SOL_DST),
  orderPda: new PublicKey(SOL_ORDER_PDA_FLOW_2),
  beneficiaryAccount: new PublicKey(SOL_DST),
  preimageBytes: hex32ToBuffer(PAIR_SOL_TO_ETH.preimage, 'preimage'),
});

/** Flow 2's `refund_order` instruction. */
export const SOLANA_IX_REFUND_FLOW_2 = buildRefundOrderInstruction(PROGRAM_PK, {
  refunder: new PublicKey(SOL_REFUND),
  orderPda: new PublicKey(SOL_ORDER_PDA_FLOW_2),
  refundAccount: new PublicKey(SOL_REFUND),
});

/** Flow 3's `create_order` instruction. */
export const SOLANA_IX_CREATE_FLOW_3 = buildCreateOrderInstruction(PROGRAM_PK, {
  payer: new PublicKey(SOL_DST),
  beneficiary: new PublicKey(SOL_DST),
  refundAddress: new PublicKey(SOL_REFUND),
  mint: new PublicKey(SOL_USDC),
  amount: 250_000_000n,
  safetyDeposit: 5_000_000n,
  hashlockBytes: hex32ToBuffer(PAIR_ETH_TO_SOL_USDC.hashlock, 'hashlock'),
  timelockAbsolute: FIXTURE_EPOCH + 1_800,
});

/** Flow 3's `claim_order` instruction. */
export const SOLANA_IX_CLAIM_FLOW_3 = buildClaimOrderInstruction(PROGRAM_PK, {
  claimer: new PublicKey(SOL_DST),
  orderPda: new PublicKey(SOL_ORDER_PDA_FLOW_3),
  beneficiaryAccount: new PublicKey(SOL_DST),
  preimageBytes: hex32ToBuffer(PAIR_ETH_TO_SOL_USDC.preimage, 'preimage'),
});

// ── Re-read helpers, so a test can assert the round trip explicitly ─────────

/**
 * Read the `amount` field straight out of a fixture buffer using the shared
 * little-endian reader.
 *
 * Present so a test can prove the bytes mean what the fixture claims,
 * independently of `deserialiseOrderAccount`.
 */
export function readFixtureAmount(buffer: Uint8Array): bigint {
  return readU64LE(Buffer.from(buffer), 8 + FIELD_OFFSET.amount);
}
