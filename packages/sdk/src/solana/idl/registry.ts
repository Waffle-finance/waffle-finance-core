/**
 * IDL for the HTLC program's global order registry (`State`).
 *
 * Why this exists
 * ───────────────
 * The program's global `state` account was previously described only by bare
 * magic numbers in `e2e/devnet-sim.ts` — the seed literal `"state"`, the
 * counter offset `8`, and no stated account size at all. That account is the
 * only one the program allocates by *counter* rather than by content hash, so
 * it is the one most likely to be mis-sized or left un-funded, and it had no
 * way to be verified after creation.
 *
 * Layout
 * ───────
 * The 8-byte Anchor discriminator is followed by a single `u64` counter:
 *
 * Offset  Size  Type    Field
 * ──────  ────  ──────  ────────────────────────────
 *      0     8  u64 LE  order_count  (monotonic, starts at 1)
 *
 * Total: 8 (discriminator) + 8 (counter) = 16 bytes
 *
 * The counter is what the devnet client reads to pre-compute the PDA of the
 * order it is about to create. It is written once at initialisation and
 * incremented by the program thereafter.
 *
 * On-chain counterpart
 * ────────────────────
 * This layout is checked by `packages/sdk/src/solana/account-sizing.ts`, which
 * derives `ORDER_REGISTRY_ACCOUNT_SIZE` from the field table rather than
 * trusting a literal, and computes the rent-exempt minimum from the cluster.
 * If the deployed program's `space = ...` disagrees, the drift gate in
 * `test/solana-account-sizing.test.ts` fails before anything reaches a
 * transaction.
 */

import { createHash } from "node:crypto";

import { ANCHOR_DISCRIMINATOR_SIZE, SOLANA_TYPE_SIZES, accountSizeFor, SOLANA_ANCHOR_ACCOUNT_LAYOUTS } from "../account-sizing.js";

/** Bump this if the registry layout changes. */
export const REGISTRY_IDL_VERSION = 0;

/**
 * Anchor account discriminator: `sha256("account:State")[0..8]`.
 *
 * The account is declared as `State` in the program, not `OrderRegistry` — the
 * `State` name is what the discriminator is derived from, so it must not be
 * "corrected" to match this module's filename.
 */
export const ORDER_REGISTRY_DISCRIMINATOR: Buffer = createHash("sha256")
  .update("account:State")
  .digest()
  .subarray(0, ANCHOR_DISCRIMINATOR_SIZE);

/** Seed prefix for the registry PDA: `[b"state"]`. */
export const ORDER_REGISTRY_SEED = Buffer.from("state");

/** Field offsets, relative to account data (after the 8-byte discriminator). */
export const REGISTRY_FIELD_OFFSET = {
  orderCount: 0,
} as const;

/**
 * Total on-chain size of the registry account, derived from the shared field
 * table: 8 discriminator + 8 counter = 16 bytes.
 */
export const ORDER_REGISTRY_ACCOUNT_SIZE = accountSizeFor(
  SOLANA_ANCHOR_ACCOUNT_LAYOUTS.orderRegistry
);

/**
 * Read the order counter from raw registry account data.
 *
 * Throws `RangeError` when the buffer is shorter than the layout requires,
 * rather than reading past the end. A short read previously yielded `0n`
 * silently, which would have made the client re-use order #0 forever.
 */
export function readOrderCount(data: Buffer | Uint8Array): bigint {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buf.length < ORDER_REGISTRY_ACCOUNT_SIZE) {
    throw new RangeError(
      `OrderRegistry account data too small: expected at least ` +
      `${ORDER_REGISTRY_ACCOUNT_SIZE} bytes ` +
      `(${ANCHOR_DISCRIMINATOR_SIZE} discriminator + ${SOLANA_TYPE_SIZES.u64} counter), ` +
      `got ${buf.length}. The account is truncated or was created by a different ` +
      `program version.`
    );
  }
  if (!buf.subarray(0, ANCHOR_DISCRIMINATOR_SIZE).equals(ORDER_REGISTRY_DISCRIMINATOR)) {
    throw new Error(
      `Invalid OrderRegistry discriminator: ` +
      `${buf.subarray(0, ANCHOR_DISCRIMINATOR_SIZE).toString("hex")}, ` +
      `expected ${ORDER_REGISTRY_DISCRIMINATOR.toString("hex")}`
    );
  }
  return buf.readBigUInt64LE(ANCHOR_DISCRIMINATOR_SIZE + REGISTRY_FIELD_OFFSET.orderCount);
}
