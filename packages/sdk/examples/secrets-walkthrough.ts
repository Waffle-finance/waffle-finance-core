/**
 * Example: generating, encoding, hashing, and passing a preimage through
 * the SDK's byte-oriented secret helpers (@wafflefinance/sdk/secrets).
 *
 * The hashlock helpers operate on `0x`-prefixed 32-byte hex strings (or raw
 * `Uint8Array`s) — never on a plain-text passphrase. If you have a string
 * from a user or a password manager, hash it into 32 bytes yourself first;
 * `hashSecret`/`generateSecret` do not do that for you.
 *
 * SECURITY: `preimage` is the secret. Never log it, send it to analytics,
 * put it in an error message, or persist it anywhere other than the
 * caller's own secure storage until the swap resolves. Only the digests
 * (`sha256`, `keccak256`) are safe to post publicly (they go on-chain as
 * the hashlock); the preimage itself must stay with the party claiming
 * funds until they reveal it on-chain to do so.
 */

import { generateSecret, hashSecret, verifyPreimage, type Secret } from "../src/secrets/index.js";

/**
 * Step 1: generate a fresh secret for a new swap.
 *
 * `secret.preimage` must never be logged or transmitted to the
 * coordinator/relayer — only `secret.sha256` / `secret.keccak256` (the
 * hashlock) are shared when announcing the order.
 */
export function createSwapSecret(): Secret {
  return generateSecret();
}

/**
 * Step 2: a caller that already has a 32-byte preimage as hex (e.g. loaded
 * from their own secure storage, or a deterministic test vector) derives
 * the same digests without generating new randomness.
 *
 * Deterministic test vector — DO NOT reuse this exact preimage for a real
 * swap; it is public because it appears in this example and in tests.
 */
export const TEST_VECTOR_PREIMAGE =
  "0x0000000000000000000000000000000000000000000000000000000000002a" as const;

export function hashKnownPreimage(preimageHex: `0x${string}` = TEST_VECTOR_PREIMAGE): Secret {
  return hashSecret(preimageHex);
}

/**
 * Step 2b: the same preimage can also be supplied as raw bytes (e.g. read
 * from a buffer) rather than a hex string — `hashSecret` accepts either.
 */
export function hashKnownPreimageBytes(preimageBytes: Uint8Array): Secret {
  return hashSecret(preimageBytes);
}

/**
 * Step 3: on the claiming side, verify a preimage revealed on-chain against
 * the hashlock the order was announced with, without trusting which digest
 * algorithm the counterparty's chain uses.
 *
 * Returns which digest matched ("sha256" for Soroban, "keccak256" for a
 * vanilla EVM HTLC convention), or null if neither matches — never throws,
 * so a caller can safely use it to validate untrusted on-chain data.
 */
export function verifyRevealedPreimage(
  revealedPreimage: `0x${string}`,
  expectedHashlock: `0x${string}`
): "sha256" | "keccak256" | null {
  return verifyPreimage(revealedPreimage, expectedHashlock);
}

/**
 * Step 4: safely passing the preimage through application code.
 *
 * Only ever carry `secret.preimage` in memory on the claiming party's own
 * process. When building a UI or a log line around a `Secret`, redact the
 * preimage explicitly — do not rely on default object/JSON stringification,
 * which will include it.
 */
export function redactSecretForLogging(secret: Secret): Omit<Secret, "preimage"> & { preimage: "[REDACTED]" } {
  const { preimage: _unusedPreimage, ...digestsOnly } = secret;
  return { ...digestsOnly, preimage: "[REDACTED]" };
}
