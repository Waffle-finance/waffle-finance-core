/**
 * Shared identifier fixtures for cross-service compatibility (#1127).
 *
 * Every value is deliberately distinct so substituting one identifier for
 * another is impossible to miss in an assertion.
 */
import {
  orderIdFromHashlock,
  validateOrderId,
} from "../packages/sdk/src/shared-utils/index.js";

export const FIXTURE_HASHLOCK = "0x" + "a1".repeat(32);
export const FIXTURE_PUBLIC_ID = orderIdFromHashlock(FIXTURE_HASHLOCK);
export const FIXTURE_CHAIN_ORDER_ID = "4721";
export const FIXTURE_TX_SIGNATURE = "0x" + "de".repeat(32);
export const FIXTURE_REQUEST_ID = "req-1127-identifier-compat";
export const FIXTURE_RESOLVER = "0x" + "bc".repeat(20);
export const FIXTURE_DST_ADDRESS = "G" + "A".repeat(55);

/** Fail loudly if a transaction signature/hash is used as a public order ID. */
export function assertPublicOrderId(value: string, hashlock: string): void {
  const invalid = validateOrderId(value);
  if (invalid) throw new Error(`invalid public order id: ${invalid}`);
  if (value !== orderIdFromHashlock(hashlock)) {
    throw new Error(
      `public order id does not derive from hashlock: got ${value}, expected ${FIXTURE_PUBLIC_ID}`,
    );
  }
}

export function identifierFixtureSet() {
  return {
    publicId: FIXTURE_PUBLIC_ID,
    hashlock: FIXTURE_HASHLOCK,
    chainOrderId: FIXTURE_CHAIN_ORDER_ID,
    txSignature: FIXTURE_TX_SIGNATURE,
    requestId: FIXTURE_REQUEST_ID,
  } as const;
}
