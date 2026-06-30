import type { OrderStatus } from "../types/index.js";

/** 0x-prefixed 32-byte hex string. */
type Hex32 = `0x${string}`;

/**
 * Convert a 0x-prefixed hex string to a Buffer. Shared across all chain clients.
 */
export function hexToBuffer(hex: string): Buffer {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) {
    throw new Error("hex string must contain an even number of hex characters");
  }
  return Buffer.from(clean, "hex");
}

/**
 * Convert a Buffer to a 0x-prefixed hex string. Shared across all chain clients.
 */
export function bufferToHex(buf: Buffer | Uint8Array): Hex32 {
  return ("0x" + Buffer.from(buf).toString("hex")) as Hex32;
}

/**
 * Validate and decode a 0x-prefixed 32-byte hex value.
 */
export function hex32ToBuffer(hex: string, label = "hex value"): Buffer {
  if (!validateHashlock(hex)) {
    throw new Error(`${label} must be 0x + 64 hex chars (32 bytes)`);
  }
  return hexToBuffer(hex);
}

/**
 * Compute the ETH value required by HTLC create-order transactions.
 */
export function escrowNativeValue(input: {
  token: string;
  nativeToken: string;
  amount: bigint;
  safetyDeposit: bigint;
}): bigint {
  return input.token.toLowerCase() === input.nativeToken.toLowerCase()
    ? input.amount + input.safetyDeposit
    : input.safetyDeposit;
}

/**
 * Write a u64 bigint as 8 little-endian bytes into a Buffer at `offset`.
 * Useful for serialising amounts in transaction instruction builders.
 */
export function writeU64LE(buf: Buffer, value: bigint, offset: number): void {
  const lo = Number(value & BigInt(0xffffffff));
  const hi = Number(value >> BigInt(32));
  buf.writeUInt32LE(lo, offset);
  buf.writeUInt32LE(hi, offset + 4);
}

/**
 * Read a u64 from 8 little-endian bytes. Useful for deserialising
 * on-chain order data.
 */
export function readU64LE(buf: Buffer, offset: number): bigint {
  const lo = BigInt(buf.readUInt32LE(offset));
  const hi = BigInt(buf.readUInt32LE(offset + 4));
  return (hi << BigInt(32)) | lo;
}

/**
 * Read a i64 from 8 little-endian bytes. Useful for deserialising
 * signed timestamps or durations.
 */
export function readI64LE(buf: Buffer, offset: number): bigint {
  const lo = BigInt(buf.readUInt32LE(offset));
  const hi = BigInt(buf.readInt32LE(offset + 4));
  return (hi << BigInt(32)) | lo;
}

/**
 * Canonical order ID format: a `wf_` prefix plus a 32-byte hashlock.
 *
 * Format: `wf_0x<64-hex-chars>`
 * Example: `wf_0x0000000000000000000000000000000000000000000000000000000000000001`
 *
 * This ID:
 * - Is unique across all orders platform-wide
 * - Is deterministic for a given hashlock (can be derived without on-chain call)
 * - Is URL-safe for API endpoints
 * - Contains no sensitive information
 */
export const ORDER_ID_PREFIX = "wf_";

/**
 * Validate that an order ID follows the canonical format.
 * Returns null if valid, or an error message string if invalid.
 */
export function validateOrderId(id: string): string | null {
  if (typeof id !== "string") {
    return "Order ID must be a string";
  }
  if (!id.startsWith(ORDER_ID_PREFIX)) {
    return `Order ID must start with "${ORDER_ID_PREFIX}"`;
  }
  const withoutPrefix = id.slice(ORDER_ID_PREFIX.length);
  if (!/^0x[0-9a-fA-F]{64}$/.test(withoutPrefix)) {
    return "Order ID must contain 0x-prefixed 64 hex characters (32 bytes)";
  }
  return null;
}

/**
 * Generate a canonical order ID from a hashlock.
 * The order ID is derived deterministically from the hashlock, making it
 * consistent across all services without coordination.
 */
export function orderIdFromHashlock(hashlock: Hex32): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hashlock)) {
    throw new Error("Hashlock must be 0x + 64 hex chars (32 bytes)");
  }
  return ORDER_ID_PREFIX + hashlock.toLowerCase();
}

/**
 * Extract the hashlock from a canonical order ID.
 */
export function hashlockFromOrderId(id: string): Hex32 {
  const err = validateOrderId(id);
  if (err) {
    throw new Error(err);
  }
  return id.slice(ORDER_ID_PREFIX.length) as Hex32;
}

/**
 * Validate that a string is a valid 0x-prefixed 32-byte hashlock.
 */
export function validateHashlock(hashlock: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(hashlock);
}

/**
 * Check if a status transition represents a timeout-related state change.
 * Used for operational metrics and alerting.
 */
export function isTimeoutTransition(from: OrderStatus, to: OrderStatus): boolean {
  return (
    to === "expired" ||
    (to === "refunded" && from === "expired") ||
    (to === "failed" && from === "expired")
  );
}

/**
 * Check if a status transition represents a failure state.
 */
export function isFailureTransition(to: OrderStatus): boolean {
  return to === "failed";
}

/**
 * Estimate remaining time until an order's timelock expires.
 * Returns null if the order is not in a timelocked state.
 */
export function estimateTimelockRemaining(
  status: OrderStatus,
  timelock: number | null | undefined,
  now: number = Math.floor(Date.now() / 1000)
): number | null {
  if (!timelock || timelock <= now) return null;
  if (status !== "src_locked" && status !== "dst_locked") return null;
  return timelock - now;
}
