import { sha256, keccak256, toHex } from "viem";

const BYTES32_LENGTH = 32;
const HEX_BYTES32_LENGTH = BYTES32_LENGTH * 2;
const HEX_BYTES32_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/**
 * A secret + its two-digest commitments.
 *
 * Hashlock scheme boundary (see issue #1022):
 * - `sha256` is the CANONICAL hashlock scheme. It is the only scheme
 *   accepted by the Stellar/Soroban HTLC and the scheme new orders must
 *   use across every chain.
 * - `keccak256` is a RETAINED EVM COMPATIBILITY scheme. The Ethereum
 *   HTLCEscrow still accepts it so pre-existing orders and vanilla EVM
 *   HTLC integrations keep working. It is not used by Soroban and must
 *   not be selected for new orders.
 *
 * Migration policy for new orders: always commit to `sha256`. The
 * keccak256 branch is frozen - it may be removed only after all live
 * orders using it have settled, and never broadened to new orders.
 * Storing both digests lets cross-chain code pick whichever matches its
 * target chain while the compatibility window is open.
 */
export interface Secret {
  /** 32-byte preimage, hex-encoded with 0x prefix. */
  preimage: `0x${string}`;
  /** sha256(preimage) - canonical scheme, used by Soroban + EVM. */
  sha256: `0x${string}`;
  /**
   * keccak256(preimage) - retained EVM compatibility scheme for legacy
   * orders only. Do not use for new orders; prefer `sha256`.
   */
  keccak256: `0x${string}`;
}

function isCryptoEnvAvailable(): boolean {
  return typeof globalThis.crypto !== "undefined" && typeof globalThis.crypto.getRandomValues === "function";
}

function randomBytes32(): Uint8Array {
  if (isCryptoEnvAvailable()) {
    const buf = new Uint8Array(32);
    globalThis.crypto.getRandomValues(buf);
    return buf;
  }
  // Fallback: throw rather than ship insecure randomness silently.
  throw new Error(
    "Secure random source not available. Run on Node 19+ or in a modern browser, or inject one via the crypto polyfill."
  );
}

function uint8ToHex(buf: Uint8Array): `0x${string}` {
  return ("0x" + Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("")) as `0x${string}`;
}

function assertBytes32(bytes: Uint8Array, label: string): void {
  if (bytes.length !== BYTES32_LENGTH) {
    throw new Error(`${label} must be exactly ${BYTES32_LENGTH} bytes`);
  }
}

function normalizeHexBytes32(hex: string, label: string): `0x${string}` {
  if (!hex.startsWith("0x")) {
    throw new Error(`${label} must use a 0x-prefixed hex string`);
  }

  const clean = hex.slice(2);
  if (clean.length !== HEX_BYTES32_LENGTH) {
    throw new Error(`${label} must be exactly ${BYTES32_LENGTH} bytes`);
  }

  if (!HEX_BYTES32_PATTERN.test(hex)) {
    throw new Error(`${label} must contain only hexadecimal characters`);
  }

  return `0x${clean.toLowerCase()}` as `0x${string}`;
}

function hexToUint8(hex: `0x${string}`): Uint8Array {
  const clean = hex.slice(2);
  const buf = new Uint8Array(clean.length / 2);
  for (let i = 0; i < buf.length; i++) {
    buf[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return buf;
}

/** Generate a fresh 32-byte secret + its digests. */
export function generateSecret(): Secret {
  const preimage = uint8ToHex(randomBytes32());
  return hashSecret(preimage);
}

/** Compute the digests for an existing preimage. */
export function hashSecret(preimage: `0x${string}` | Uint8Array): Secret {
  let bytes: Uint8Array;
  let hex: `0x${string}`;

  if (typeof preimage === "string") {
    hex = normalizeHexBytes32(preimage, "preimage");
    bytes = hexToUint8(hex);
  } else {
    assertBytes32(preimage, "preimage");
    bytes = preimage;
    hex = uint8ToHex(preimage);
  }

  return {
    preimage: hex,
    sha256: sha256(toHex(bytes)),
    keccak256: keccak256(toHex(bytes))
  };
}

/**
 * Decide whether `preimage` matches one of the digests in `expected`.
 * Returns the matched digest type, or null if neither matches.
 *
 * Scheme semantics (issue #1022):
 * - `"sha256"` is the canonical match and the only result new orders
 *   should rely on.
 * - `"keccak256"` is a retained EVM compatibility match for legacy
 *   orders; it is checked only after sha256 so the canonical scheme
 *   always wins if both somehow collide.
 *
 * Input validation mirrors the Solidity escrow: `preimage` must be a
 * 0x-prefixed, exactly 32-byte hex string and `expected` must be a
 * 0x-prefixed, exactly 32-byte hex digest. Wrong-length or non-hex
 * inputs throw (they are never silently truncated or padded), so the
 * shared differential vectors for valid, wrong-length, wrong-preimage
 * and cross-scheme cases behave identically on-chain and in the SDK.
 */
export function verifyPreimage(
  preimage: `0x${string}`,
  expected: `0x${string}`
): "sha256" | "keccak256" | null {
  const expectedDigest = normalizeHexBytes32(expected, "expected digest");
  const s = hashSecret(preimage);
  if (s.sha256 === expectedDigest) return "sha256";
  if (s.keccak256 === expectedDigest) return "keccak256";
  return null;
}
