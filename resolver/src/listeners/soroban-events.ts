/**
 * Typed Soroban HTLC event decoding.
 *
 * The Soroban HTLC contract emits three event kinds.  Topics are a
 * tuple prefixed with the event name symbol; the value is a separate
 * tuple.  Both arrive as raw `xdr.ScVal` objects from the RPC.
 *
 * Contract event shapes (from soroban/contracts/htlc/src/lib.rs):
 *
 *  created
 *    topics : (Symbol("created"), Address sender, Address beneficiary, BytesN<32> hashlock)
 *    value  : (u64 order_id, Address asset, i128 amount, i128 safety_deposit, u64 timelock)
 *
 *  claimed
 *    topics : (Symbol("claimed"), Address beneficiary, BytesN<32> hashlock)
 *    value  : (u64 order_id, Address caller, Bytes preimage, i128 amount, i128 safety_deposit)
 *
 *  refunded
 *    topics : (Symbol("refunded"), Address refund_address, BytesN<32> hashlock)
 *    value  : (u64 order_id, Address caller, i128 amount, i128 safety_deposit)
 *
 * `scValToNative` from @stellar/stellar-sdk converts ScVal trees to
 * plain JS values:
 *   Symbol  → string
 *   Address → string (strkey)
 *   u64     → BigInt
 *   i128    → BigInt
 *   Bytes / BytesN → Buffer / Uint8Array
 *   Vec/tuple → Array
 */

import { scValToNative, xdr } from "@stellar/stellar-sdk";

// ---------------------------------------------------------------------------
// Typed event interfaces
// ---------------------------------------------------------------------------

/** Emitted when a new HTLC order is funded on Soroban. */
export interface SorobanOrderCreatedEvent {
  /** Discriminant for exhaustive handler switches. */
  type: "created";
  ledger: number;
  txHash: string;
  contractId: string;
  /** Order identifier (u64 — fits in BigInt). */
  orderId: bigint;
  /** Address that locked the funds (Stellar strkey). */
  sender: string;
  /** Address entitled to claim by revealing the preimage. */
  beneficiary: string;
  /** The locked token contract address. */
  asset: string;
  /** Locked amount in the token's smallest unit (i128). */
  amount: bigint;
  /** Safety deposit in the token's smallest unit (i128). */
  safetyDeposit: bigint;
  /** sha256(preimage) as a hex string. */
  hashlock: string;
  /** Unix-second timestamp after which refund becomes valid (u64). */
  timelock: bigint;
}

/** Emitted when the beneficiary (or a relay) reveals the preimage. */
export interface SorobanOrderClaimedEvent {
  type: "claimed";
  ledger: number;
  txHash: string;
  contractId: string;
  orderId: bigint;
  /** Address that receives the locked amount. */
  beneficiary: string;
  /** Address that submitted the claim transaction. */
  caller: string;
  /** The revealed preimage as a hex string. */
  preimage: string;
  amount: bigint;
  safetyDeposit: bigint;
  /** sha256(preimage) as a hex string — matches the stored hashlock. */
  hashlock: string;
}

/** Emitted when the timelock expires and funds are returned. */
export interface SorobanOrderRefundedEvent {
  type: "refunded";
  ledger: number;
  txHash: string;
  contractId: string;
  orderId: bigint;
  /** Address that receives the refunded amount. */
  refundAddress: string;
  /** Address that submitted the refund transaction. */
  caller: string;
  amount: bigint;
  safetyDeposit: bigint;
  hashlock: string;
}

/** Union of all typed Soroban HTLC events. */
export type SorobanHtlcEvent =
  | SorobanOrderCreatedEvent
  | SorobanOrderClaimedEvent
  | SorobanOrderRefundedEvent;

// ---------------------------------------------------------------------------
// Decoding error — thrown on structural mismatches so callers can
// distinguish "unknown event kind" (soft skip) from "known event with
// wrong shape" (likely a contract version bump that needs attention).
// ---------------------------------------------------------------------------

export class SorobanEventDecodeError extends Error {
  constructor(
    public readonly eventName: string,
    public readonly reason: string,
    public readonly raw?: unknown,
  ) {
    super(`[soroban-events] failed to decode "${eventName}" event: ${reason}`);
    this.name = "SorobanEventDecodeError";
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Deserialise a base64-encoded XDR ScVal and convert it to a native
 * JS value via `scValToNative`.
 */
function decodeScVal(base64: string): unknown {
  const val = xdr.ScVal.fromXDR(base64, "base64");
  return scValToNative(val);
}

/**
 * Convert a raw value (Buffer, Uint8Array, or already a string) to a
 * lower-case hex string.  Used for hashlock and preimage bytes.
 */
function toHex(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw instanceof Uint8Array || Buffer.isBuffer(raw)) {
    return Buffer.from(raw).toString("hex");
  }
  throw new TypeError(`expected bytes, got ${typeof raw}`);
}

/**
 * Ensure a native value is BigInt; coerce from number for robustness.
 * Soroban u64 / i128 both decode to BigInt with scValToNative.
 */
function toBigInt(v: unknown, field: string): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(v);
  throw new TypeError(`${field}: expected bigint, got ${typeof v}`);
}

/** Assert the value is a non-empty string (Address / Symbol). */
function toStr(v: unknown, field: string): string {
  if (typeof v !== "string" || v === "") {
    throw new TypeError(`${field}: expected non-empty string, got ${typeof v}`);
  }
  return v;
}

/** Assert the value is an array of a given minimum length. */
function toArray(v: unknown, minLen: number, ctx: string): unknown[] {
  if (!Array.isArray(v) || v.length < minLen) {
    throw new TypeError(
      `${ctx}: expected array[>=${minLen}], got ${Array.isArray(v) ? `array[${v.length}]` : typeof v}`,
    );
  }
  return v as unknown[];
}

// ---------------------------------------------------------------------------
// Per-event decoders
// ---------------------------------------------------------------------------

/**
 * Decode a raw "created" event.
 *
 * topics[0] = Symbol("created")  (consumed by the caller's dispatch)
 * topics[1] = Address sender
 * topics[2] = Address beneficiary
 * topics[3] = BytesN<32> hashlock
 *
 * value = Vec(u64 order_id, Address asset, i128 amount, i128 safety_deposit, u64 timelock)
 */
function decodeCreated(
  topics: string[],
  valueB64: string,
  meta: { ledger: number; txHash: string; contractId: string },
): SorobanOrderCreatedEvent {
  if (topics.length < 4) {
    throw new SorobanEventDecodeError(
      "created",
      `expected ≥4 topic ScVals, got ${topics.length}`,
    );
  }

  let sender: string;
  let beneficiary: string;
  let hashlock: string;
  try {
    sender = toStr(decodeScVal(topics[1]!), "sender");
    beneficiary = toStr(decodeScVal(topics[2]!), "beneficiary");
    hashlock = toHex(decodeScVal(topics[3]!));
  } catch (e: unknown) {
    throw new SorobanEventDecodeError(
      "created",
      `topic decode failed: ${(e as Error).message}`,
      topics,
    );
  }

  let val: unknown[];
  try {
    val = toArray(decodeScVal(valueB64), 5, "value");
  } catch (e: unknown) {
    throw new SorobanEventDecodeError(
      "created",
      `value decode failed: ${(e as Error).message}`,
      valueB64,
    );
  }

  try {
    return {
      type: "created",
      ...meta,
      orderId: toBigInt(val[0], "order_id"),
      asset: toStr(val[1], "asset"),
      amount: toBigInt(val[2], "amount"),
      safetyDeposit: toBigInt(val[3], "safety_deposit"),
      timelock: toBigInt(val[4], "timelock"),
      sender,
      beneficiary,
      hashlock,
    };
  } catch (e: unknown) {
    throw new SorobanEventDecodeError(
      "created",
      `value field decode failed: ${(e as Error).message}`,
      val,
    );
  }
}

/**
 * Decode a raw "claimed" event.
 *
 * topics[0] = Symbol("claimed")
 * topics[1] = Address beneficiary
 * topics[2] = BytesN<32> hashlock
 *
 * value = Vec(u64 order_id, Address caller, Bytes preimage, i128 amount, i128 safety_deposit)
 */
function decodeClaimed(
  topics: string[],
  valueB64: string,
  meta: { ledger: number; txHash: string; contractId: string },
): SorobanOrderClaimedEvent {
  if (topics.length < 3) {
    throw new SorobanEventDecodeError(
      "claimed",
      `expected ≥3 topic ScVals, got ${topics.length}`,
    );
  }

  let beneficiary: string;
  let hashlock: string;
  try {
    beneficiary = toStr(decodeScVal(topics[1]!), "beneficiary");
    hashlock = toHex(decodeScVal(topics[2]!));
  } catch (e: unknown) {
    throw new SorobanEventDecodeError(
      "claimed",
      `topic decode failed: ${(e as Error).message}`,
      topics,
    );
  }

  let val: unknown[];
  try {
    val = toArray(decodeScVal(valueB64), 5, "value");
  } catch (e: unknown) {
    throw new SorobanEventDecodeError(
      "claimed",
      `value decode failed: ${(e as Error).message}`,
      valueB64,
    );
  }

  try {
    return {
      type: "claimed",
      ...meta,
      orderId: toBigInt(val[0], "order_id"),
      caller: toStr(val[1], "caller"),
      preimage: toHex(val[2]),
      amount: toBigInt(val[3], "amount"),
      safetyDeposit: toBigInt(val[4], "safety_deposit"),
      beneficiary,
      hashlock,
    };
  } catch (e: unknown) {
    throw new SorobanEventDecodeError(
      "claimed",
      `value field decode failed: ${(e as Error).message}`,
      val,
    );
  }
}

/**
 * Decode a raw "refunded" event.
 *
 * topics[0] = Symbol("refunded")
 * topics[1] = Address refund_address
 * topics[2] = BytesN<32> hashlock
 *
 * value = Vec(u64 order_id, Address caller, i128 amount, i128 safety_deposit)
 */
function decodeRefunded(
  topics: string[],
  valueB64: string,
  meta: { ledger: number; txHash: string; contractId: string },
): SorobanOrderRefundedEvent {
  if (topics.length < 3) {
    throw new SorobanEventDecodeError(
      "refunded",
      `expected ≥3 topic ScVals, got ${topics.length}`,
    );
  }

  let refundAddress: string;
  let hashlock: string;
  try {
    refundAddress = toStr(decodeScVal(topics[1]!), "refund_address");
    hashlock = toHex(decodeScVal(topics[2]!));
  } catch (e: unknown) {
    throw new SorobanEventDecodeError(
      "refunded",
      `topic decode failed: ${(e as Error).message}`,
      topics,
    );
  }

  let val: unknown[];
  try {
    val = toArray(decodeScVal(valueB64), 4, "value");
  } catch (e: unknown) {
    throw new SorobanEventDecodeError(
      "refunded",
      `value decode failed: ${(e as Error).message}`,
      valueB64,
    );
  }

  try {
    return {
      type: "refunded",
      ...meta,
      orderId: toBigInt(val[0], "order_id"),
      caller: toStr(val[1], "caller"),
      amount: toBigInt(val[2], "amount"),
      safetyDeposit: toBigInt(val[3], "safety_deposit"),
      refundAddress,
      hashlock,
    };
  } catch (e: unknown) {
    throw new SorobanEventDecodeError(
      "refunded",
      `value field decode failed: ${(e as Error).message}`,
      val,
    );
  }
}

// ---------------------------------------------------------------------------
// Public dispatcher
// ---------------------------------------------------------------------------

/**
 * Decode a raw Soroban contract event into a typed `SorobanHtlcEvent`.
 *
 * @param topics  Array of base64-encoded XDR ScVal strings — as
 *                returned by `ev.topic.map(t => t.toXDR("base64"))`.
 * @param value   Base64-encoded XDR ScVal for the event value.
 * @param meta    Ledger, tx hash and contract id for the event.
 *
 * @returns The typed event, or `null` when the first topic is a
 *          symbol that does not belong to the HTLC contract (e.g.
 *          admin / config events that the resolver doesn't handle).
 *
 * @throws  `SorobanEventDecodeError` when the event name is known
 *          (created / claimed / refunded) but the payload doesn't
 *          match the expected shape — so callers can distinguish a
 *          "skip unknown" case from a "schema mismatch" alert.
 */
export function decodeSorobanHtlcEvent(
  topics: string[],
  value: string,
  meta: { ledger: number; txHash: string; contractId: string },
): SorobanHtlcEvent | null {
  if (topics.length === 0) return null;

  // The first topic is always the event name symbol.
  let eventName: unknown;
  try {
    eventName = decodeScVal(topics[0]!);
  } catch {
    return null; // unparseable topic — skip silently
  }

  if (typeof eventName !== "string") return null;

  switch (eventName) {
    case "created":
      return decodeCreated(topics, value, meta);
    case "claimed":
      return decodeClaimed(topics, value, meta);
    case "refunded":
      return decodeRefunded(topics, value, meta);
    default:
      // e.g. "adm_xfer" or "cfg" — not HTLC order events, skip.
      return null;
  }
}
