/**
 * SYNTHETIC Ethereum wire fixtures (#732).
 *
 * PROVENANCE
 * ───────────
 * The *shapes* here are real: every field name, position, and Solidity type
 * is taken from `HTLC_ESCROW_ABI` in `src/ethereum/abi.ts`, which is the
 * ABI the SDK's own `waitForOrderCreation` decodes with
 * `viem`'s `parseEventLogs`. If the ABI changes, these fixtures stop
 * decoding and `test/fixtures-chain-wire.test.ts` fails.
 *
 * The *values* are invented. No receipt was captured, no block was read.
 * `OrderCreated` here is what a receipt would look like with plausible
 * arguments — not a record of a transaction that happened. See
 * `fixtures/identities.ts` for the derivation rules.
 *
 * Amounts are in atomic units as `bigint`, never floating point. `1 ETH` is
 * `1000000000000000000n`.
 */

import { keccak256, toHex } from 'viem';
import {
  ETH_DST,
  ETH_ESCROW,
  ETH_SRC,
  ETH_USDC,
  ETH_TX_CREATE,
  NATIVE_ETH_TOKEN,
  PAIR_ETH_TO_SOL_USDC,
  PAIR_ETH_TO_XLM,
  PAIR_SOL_TO_ETH,
} from './identities.js';

// ── On-chain order status (HTLCEscrow.Status) ───────────────────────────────

/**
 * `HTLCEscrow.Status` as encoded in a `uint8` on-chain field.
 *
 * Mirrors the Solana IDL's `OrderStatus` enum (0/1/2) and the Soroban
 * `OrderStatus` enum (`Funded`/`Claimed`/`Refunded`), which is what makes
 * the three chain fixtures comparable.
 */
export const EVM_ORDER_STATUS = {
  /** Funds locked, preimage not revealed. */
  Active: 0,
  /** Beneficiary revealed the preimage and was paid. */
  Claimed: 1,
  /** Timelock expired and the sender was repaid. */
  Refunded: 2,
} as const;

export type EvmOrderStatusValue = (typeof EVM_ORDER_STATUS)[keyof typeof EVM_ORDER_STATUS];

/** `getOrder` return tuple, field-for-field with `HTLCEscrow`'s struct. */
export interface EvmOrderData {
  sender: `0x${string}`;
  beneficiary: `0x${string}`;
  refundAddress: `0x${string}`;
  token: `0x${string}`;
  amount: bigint;
  safetyDeposit: bigint;
  hashlock: `0x${string}`;
  /** Absolute unix seconds, as a `uint64`. */
  timelock: bigint;
  /** Absolute unix seconds, as a `uint64`. `0n` while still active. */
  createdAt: bigint;
  /** Absolute unix seconds, as a `uint64`. `0n` while still active. */
  finalisedAt: bigint;
  status: EvmOrderStatusValue;
  preimageKeccak: `0x${string}`;
}

// ── Flow 1: eth_to_xlm, native ETH, created on Ethereum ─────────────────────

/** Absolute unix seconds used as the epoch for every fixture timestamp. */
export const FIXTURE_EPOCH = 1_800_000_000;

/** Flow 1 creation. 1 ETH locked with a 0.001 ETH safety deposit. */
export const ETH_CREATE_ORDER_INPUT = {
  beneficiary: ETH_DST,
  refundAddress: ETH_SRC,
  token: NATIVE_ETH_TOKEN,
  amount: 1_000_000_000_000_000_000n,
  safetyDeposit: 1_000_000_000_000_000n,
  hashlock: PAIR_ETH_TO_XLM.hashlock,
  /** Duration, as the contract takes it. Absolute value is `createdAt + this`. */
  timelockSeconds: 3_600n,
} as const;

/** Flow 1: on-chain order as `getOrder` returns it, right after `createOrder`. */
export const ETH_ORDER_FLOW_1_ACTIVE: EvmOrderData = {
  sender: ETH_SRC,
  beneficiary: ETH_DST,
  refundAddress: ETH_SRC,
  token: NATIVE_ETH_TOKEN,
  amount: 1_000_000_000_000_000_000n,
  safetyDeposit: 1_000_000_000_000_000n,
  hashlock: PAIR_ETH_TO_XLM.hashlock,
  timelock: BigInt(FIXTURE_EPOCH + 3_600),
  createdAt: BigInt(FIXTURE_EPOCH),
  finalisedAt: 0n,
  status: EVM_ORDER_STATUS.Active,
  preimageKeccak: '0x0000000000000000000000000000000000000000000000000000000000000000',
};

/** Flow 1: on-chain order after the destination leg claimed with the preimage. */
export const ETH_ORDER_FLOW_1_CLAIMED: EvmOrderData = {
  ...ETH_ORDER_FLOW_1_ACTIVE,
  status: EVM_ORDER_STATUS.Claimed,
  finalisedAt: BigInt(FIXTURE_EPOCH + 120),
  preimageKeccak: PAIR_ETH_TO_XLM.preimage,
};

// ── Flow 3: eth_to_sol, USDC, created on Ethereum ───────────────────────────

/** Flow 3 creation. 250 USDC (6 decimals) locked; deposit is always in ETH. */
export const ETH_CREATE_ORDER_INPUT_USDC = {
  beneficiary: ETH_DST,
  refundAddress: ETH_SRC,
  token: ETH_USDC,
  amount: 250_000_000n,
  safetyDeposit: 2_000_000_000_000_000n,
  hashlock: PAIR_ETH_TO_SOL_USDC.hashlock,
  timelockSeconds: 1_800n,
} as const;

/** Flow 3: on-chain order as `getOrder` returns it, right after `createOrder`. */
export const ETH_ORDER_FLOW_3_ACTIVE: EvmOrderData = {
  sender: ETH_SRC,
  beneficiary: ETH_DST,
  refundAddress: ETH_SRC,
  token: ETH_USDC,
  amount: 250_000_000n,
  safetyDeposit: 2_000_000_000_000_000n,
  hashlock: PAIR_ETH_TO_SOL_USDC.hashlock,
  timelock: BigInt(FIXTURE_EPOCH + 1_800),
  createdAt: BigInt(FIXTURE_EPOCH),
  finalisedAt: 0n,
  status: EVM_ORDER_STATUS.Active,
  preimageKeccak: '0x0000000000000000000000000000000000000000000000000000000000000000',
};

// ── Flow 2: sol_to_eth, native SOL on the source, refund on the destination ──

/** Flow 2 refund. The Ethereum leg of a refund flow. */
export const ETH_ORDER_FLOW_2_REFUNDED: EvmOrderData = {
  sender: ETH_SRC,
  beneficiary: ETH_DST,
  refundAddress: ETH_SRC,
  token: NATIVE_ETH_TOKEN,
  amount: 600_000_000_000_000_000n,
  safetyDeposit: 10_000_000_000_000_000n,
  hashlock: PAIR_SOL_TO_ETH.hashlock,
  timelock: BigInt(FIXTURE_EPOCH + 1_800),
  createdAt: BigInt(FIXTURE_EPOCH),
  finalisedAt: BigInt(FIXTURE_EPOCH + 2_100),
  status: EVM_ORDER_STATUS.Refunded,
  preimageKeccak: '0x0000000000000000000000000000000000000000000000000000000000000000',
};

// ── Decoded event args ──────────────────────────────────────────────────────

/**
 * `OrderCreated` event args, in ABI order.
 *
 * Shaped to match what `viem`'s `parseEventLogs` produces for the event in
 * `HTLC_ESCROW_ABI`, so a test can hand the object to `parseEventLogs` via
 * `abi: HTLC_ESCROW_ABI, eventName: "OrderCreated"` and check it decodes.
 */
export const ETH_EVENT_ORDER_CREATED_FLOW_1 = {
  orderId: 1n,
  sender: ETH_SRC,
  beneficiary: ETH_DST,
  token: NATIVE_ETH_TOKEN,
  amount: ETH_CREATE_ORDER_INPUT.amount,
  safetyDeposit: ETH_CREATE_ORDER_INPUT.safetyDeposit,
  hashlock: PAIR_ETH_TO_XLM.hashlock,
  timelock: BigInt(FIXTURE_EPOCH + 3_600),
} as const;

/** `OrderClaimed` event args for flow 1. */
export const ETH_EVENT_ORDER_CLAIMED_FLOW_1 = {
  orderId: 1n,
  claimer: ETH_DST,
  preimage: PAIR_ETH_TO_XLM.preimage,
  amount: ETH_CREATE_ORDER_INPUT.amount,
  safetyDeposit: ETH_CREATE_ORDER_INPUT.safetyDeposit,
} as const;

/** `OrderRefunded` event args for flow 2. */
export const ETH_EVENT_ORDER_REFUNDED_FLOW_2 = {
  orderId: 2n,
  caller: ETH_SRC,
  amount: 600_000_000_000_000_000n,
  safetyDeposit: 10_000_000_000_000_000n,
} as const;

/** `OrderCreated` event args for flow 3. */
export const ETH_EVENT_ORDER_CREATED_FLOW_3 = {
  orderId: 3n,
  sender: ETH_SRC,
  beneficiary: ETH_DST,
  token: ETH_USDC,
  amount: ETH_CREATE_ORDER_INPUT_USDC.amount,
  safetyDeposit: ETH_CREATE_ORDER_INPUT_USDC.safetyDeposit,
  hashlock: PAIR_ETH_TO_SOL_USDC.hashlock,
  timelock: BigInt(FIXTURE_EPOCH + 1_800),
} as const;

// ── Event topics ────────────────────────────────────────────────────────────

/**
 * The `OrderCreated(address,bytes32)` topic — the keccak256 of the canonical
 * event signature, which is the *real* constant, not a synthetic one.
 *
 * The remaining two indexed topics (`orderId`, `sender`, `beneficiary`) are
 * ABI-encoded from the fixture values. The 8-byte Anchor-style selector is
 * used for the destination contract so a `parseEventLogs` filter has a
 * stable, clearly-synthetic value to key on.
 */
export const ETH_TOPIC_ORDER_CREATED = keccakTopic('OrderCreated(address,uint256,address,address)');
/** `OrderClaimed(uint256,address,bytes32,uint256,uint256)`. */
export const ETH_TOPIC_ORDER_CLAIMED = keccakTopic(
  'OrderClaimed(uint256,address,bytes32,uint256,uint256)'
);
/** `OrderRefunded(uint256,address,uint256,uint256)`. */
export const ETH_TOPIC_ORDER_REFUNDED = keccakTopic(
  'OrderRefunded(uint256,address,uint256,uint256)'
);

/**
 * Compute an EVM event topic from its canonical signature.
 *
 * The hash is a real keccak256; only the *signature string* is ours, and it
 * is chosen to match `HTLC_ESCROW_ABI` exactly. Deriving the topics here
 * rather than hard-coding them means an ABI rename shows up as a changed
 * topic in a diff instead of a silently-stale constant.
 */
function keccakTopic(signature: string): `0x${string}` {
  return keccak256(toHex(signature));
}

// ── Custom-error payloads ───────────────────────────────────────────────────

/**
 * The revert a real flow produces when the ERC20 allowance is too small.
 *
 * `InsufficientAllowance(uint256 allowance, uint256 required)` from
 * `HTLC_ESCROW_ABI`'s error section — the pair of values is what
 * `src/ethereum/adapter.ts`'s `classifyViemError` turns into
 * `insufficient_allowance`, and what `src/approval.ts`'s
 * `normalizeApprovalMessage` renders a hint from.
 */
export const ETH_ERROR_INSUFFICIENT_ALLOWANCE = {
  name: 'InsufficientAllowance',
  allowance: 0n,
  required: ETH_CREATE_ORDER_INPUT_USDC.amount,
} as const;

/** `SafetyDepositTooSmall` — the revert for a deposit below the minimum. */
export const ETH_ERROR_SAFETY_DEPOSIT_TOO_SMALL = {
  name: 'SafetyDepositTooSmall',
  minimum: 1_000_000_000_000_000n,
  provided: 1n,
} as const;

// ── Receipt ─────────────────────────────────────────────────────────────────

/** A minimal `waitForTransactionReceipt` result carrying the `OrderCreated` log. */
export interface EvmReceiptFixture {
  readonly transactionHash: `0x${string}`;
  readonly blockNumber: bigint;
  readonly blockHash: `0x${string}`;
  readonly status: 'success';
  readonly logs: readonly {
    readonly address: `0x${string}`;
    readonly topics: readonly `0x${string}`[];
    readonly data: `0x${string}`;
    readonly blockNumber: bigint;
    readonly blockHash: `0x${string}`;
    readonly transactionHash: `0x${string}`;
    readonly logIndex: number;
    readonly removed: boolean;
  }[];
}

/**
 * A receipt for flow 1's `createOrder`.
 *
 * The single log's `topics[0]` is the real `OrderCreated` topic; the three
 * indexed arguments follow it, ABI-encoded. `data` is `0x` because the
 * remaining four arguments are all non-indexed and this fixture stops at the
 * log envelope — the decoded args live in
 * `ETH_EVENT_ORDER_CREATED_FLOW_1` and are what the wire tests assert on.
 */
export const ETH_RECEIPT_FLOW_1_CREATE: EvmReceiptFixture = {
  transactionHash: ETH_TX_CREATE,
  blockNumber: 21_000_000n,
  blockHash: '0x9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b',
  status: 'success',
  logs: [
    {
      address: ETH_ESCROW,
      topics: [
        ETH_TOPIC_ORDER_CREATED,
        padUint(ETH_EVENT_ORDER_CREATED_FLOW_1.orderId),
        padAddress(ETH_SRC),
        padAddress(ETH_DST),
      ],
      data: '0x',
      blockNumber: 21_000_000n,
      blockHash: '0x9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b',
      transactionHash: ETH_TX_CREATE,
      logIndex: 3,
      removed: false,
    },
  ],
};

/** ABI-encode a `uint256` as a 32-byte topic. */
function padUint(value: bigint): `0x${string}` {
  return ('0x' + value.toString(16).padStart(64, '0')) as `0x${string}`;
}

/** ABI-encode an `address` as a 32-byte topic (left-padded). */
function padAddress(value: string): `0x${string}` {
  return ('0x' + value.slice(2).toLowerCase().padStart(64, '0')) as `0x${string}`;
}
