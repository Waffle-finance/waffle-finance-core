/**
 * @file soroban-events.ts
 *
 * Canonical event contract for the WaffleFinance Soroban HTLC contract.
 *
 * ## Purpose
 *
 * This module is the single source of truth for decoding raw Soroban RPC
 * events into typed, normalized shapes.  Both the live {@link SorobanListener}
 * and the periodic {@link Reconciler} import from here so the two consumers
 * cannot drift apart.
 *
 * ## Versioning
 *
 * Every decoded event carries a `schemaVersion` field.  The current version is
 * `1`.  Future breaking changes to the contract's event payload must bump this
 * version and add a compatibility path in {@link decodeHtlcEvent}.
 *
 * ## Error handling
 *
 * {@link decodeHtlcEvent} never throws.  It returns:
 *   - A typed {@link DecodedHtlcEvent} on success.
 *   - A {@link MalformedEventError} describing *why* decoding failed when the
 *     payload is structurally invalid.
 *   - `null` for events whose topic is simply not one of the known HTLC
 *     lifecycle symbols (i.e. governance / config events that the coordinator
 *     does not need to process).
 *
 * Callers must check the return type before mutating order state.  A
 * {@link MalformedEventError} must be surfaced as an operational failure
 * (logged, metered) rather than silently ignored.
 *
 * ## Contract wire format (v1)
 *
 * `created`
 *   topics: (symbol "created", sender: Address, beneficiary: Address, hashlock: BytesN<32>)
 *   data:   (order_id: u64, asset: Address, amount: i128, safety_deposit: i128, timelock: u64)
 *
 * `claimed`
 *   topics: (symbol "claimed", beneficiary: Address, hashlock: BytesN<32>)
 *   data:   (order_id: u64, caller: Address, preimage: Bytes, amount: i128, safety_deposit: i128)
 *
 * `refunded`
 *   topics: (symbol "refunded", refund_address: Address, hashlock: BytesN<32>)
 *   data:   (order_id: u64, caller: Address, amount: i128, safety_deposit: i128)
 */

import { scValToNative } from "@stellar/stellar-sdk";
import type { xdr } from "@stellar/stellar-sdk";

// ─── Schema version ───────────────────────────────────────────────────────────

/** Current schema version. Bump on any breaking wire-format change. */
export const HTLC_EVENT_SCHEMA_VERSION = 1 as const;
export type HtlcEventSchemaVersion = typeof HTLC_EVENT_SCHEMA_VERSION;

// ─── Typed event shapes ───────────────────────────────────────────────────────

/** Normalized `created` event emitted when a new HTLC order is funded. */
export interface CreatedEvent {
  readonly schemaVersion: HtlcEventSchemaVersion;
  readonly kind: "created";
  /** Soroban numeric order id (u64 decoded as bigint). */
  readonly orderId: bigint;
  /** 0x-prefixed 32-byte hex hashlock (sha256 of preimage). */
  readonly hashlock: `0x${string}`;
  /** Absolute unix-second timelock. */
  readonly timelock: number;
  /** Stellar G-address of the order creator (resolver). */
  readonly sender: string;
  /** Stellar G-address of the beneficiary. */
  readonly beneficiary: string;
  /** Locked amount in atomic asset units, as a decimal string. */
  readonly amount: string;
  /** Safety deposit in atomic asset units, as a decimal string. */
  readonly safetyDeposit: string;
}

/** Normalized `claimed` event emitted when the preimage is revealed. */
export interface ClaimedEvent {
  readonly schemaVersion: HtlcEventSchemaVersion;
  readonly kind: "claimed";
  /** Soroban numeric order id. */
  readonly orderId: bigint;
  /** 0x-prefixed 32-byte hex hashlock (from topics). */
  readonly hashlock: `0x${string}`;
  /** 0x-prefixed hex preimage (from data). */
  readonly preimage: `0x${string}`;
  /** Stellar G-address of the beneficiary (from topics). */
  readonly beneficiary: string;
}

/** Normalized `refunded` event emitted when an expired order is refunded. */
export interface RefundedEvent {
  readonly schemaVersion: HtlcEventSchemaVersion;
  readonly kind: "refunded";
  /** Soroban numeric order id. */
  readonly orderId: bigint;
  /** 0x-prefixed 32-byte hex hashlock (from topics). */
  readonly hashlock: `0x${string}`;
  /** Stellar G-address that received the refunded funds. */
  readonly refundAddress: string;
}

/** Union of all known decoded HTLC lifecycle events. */
export type DecodedHtlcEvent = CreatedEvent | ClaimedEvent | RefundedEvent;

// ─── Malformed-event error ────────────────────────────────────────────────────

/**
 * Returned (not thrown) when the topics/data arrays claim to be a known HTLC
 * event type but fail structural validation.
 *
 * The `reason` field carries a machine-readable tag for metrics; `detail`
 * carries a human-readable description for structured logs.
 */
export interface MalformedEventError {
  readonly isMalformed: true;
  readonly kind: string;           // topic symbol, or "xdr_decode_error"
  readonly reason: MalformedReason;
  readonly detail: string;
}

export type MalformedReason =
  | "xdr_decode_error"         // scValToNative threw
  | "topic_count_mismatch"     // wrong number of topics for the event kind
  | "topic_type_mismatch"      // a topic decoded to the wrong JS type
  | "data_not_array"           // data ScVal did not decode to an Array
  | "data_count_mismatch"      // data array has fewer elements than expected
  | "data_type_mismatch";      // a data element decoded to the wrong JS type

function malformed(
  kind: string,
  reason: MalformedReason,
  detail: string,
): MalformedEventError {
  return { isMalformed: true, kind, reason, detail };
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function bytesToHex(bytes: Uint8Array | Buffer): `0x${string}` {
  return ("0x" + Buffer.from(bytes).toString("hex")) as `0x${string}`;
}

function isBytes(v: unknown): v is Uint8Array | Buffer {
  return v instanceof Uint8Array || Buffer.isBuffer(v);
}

// ─── Core decoder ─────────────────────────────────────────────────────────────

/**
 * Decode a single Soroban contract event into a typed HTLC event.
 *
 * Returns:
 *   - `DecodedHtlcEvent`    — successfully decoded lifecycle event.
 *   - `MalformedEventError` — known topic, structurally invalid payload.
 *   - `null`                — unknown or irrelevant topic (not an error).
 */
export function decodeHtlcEvent(
  topicScVals: xdr.ScVal[],
  dataScVal: xdr.ScVal,
): DecodedHtlcEvent | MalformedEventError | null {
  // ── XDR decode (safe) ───────────────────────────────────────────────────────
  let topics: unknown[];
  let data: unknown;
  try {
    topics = topicScVals.map((t) => scValToNative(t));
    data = scValToNative(dataScVal);
  } catch (err) {
    return malformed(
      "xdr_decode_error",
      "xdr_decode_error",
      `scValToNative threw: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (topics.length === 0) return null;

  const eventKind = topics[0];
  if (typeof eventKind !== "string") return null;

  // Only handle the three lifecycle events — governance/config events return null.
  if (eventKind !== "created" && eventKind !== "claimed" && eventKind !== "refunded") {
    return null;
  }

  // data must be an array (Soroban Vec / tuple).
  if (!Array.isArray(data)) {
    return malformed(eventKind, "data_not_array", "data ScVal did not decode to an Array");
  }

  // ── created ─────────────────────────────────────────────────────────────────
  if (eventKind === "created") {
    // topics: [symbol, sender, beneficiary, hashlock]
    if (topics.length < 4) {
      return malformed(eventKind, "topic_count_mismatch",
        `expected ≥4 topics, got ${topics.length}`);
    }
    const [, sender, beneficiary, hashlockRaw] = topics as unknown[];
    if (typeof sender !== "string") {
      return malformed(eventKind, "topic_type_mismatch", "topics[1] (sender) is not a string");
    }
    if (typeof beneficiary !== "string") {
      return malformed(eventKind, "topic_type_mismatch", "topics[2] (beneficiary) is not a string");
    }
    if (!isBytes(hashlockRaw)) {
      return malformed(eventKind, "topic_type_mismatch", "topics[3] (hashlock) is not Bytes");
    }
    // data: [order_id, asset, amount, safety_deposit, timelock]
    if (data.length < 5) {
      return malformed(eventKind, "data_count_mismatch",
        `expected ≥5 data elements, got ${data.length}`);
    }
    const [orderId, , amount, safetyDeposit, timelock] = data as unknown[];
    if (typeof orderId !== "bigint") {
      return malformed(eventKind, "data_type_mismatch", "data[0] (order_id) is not bigint");
    }
    if (typeof amount !== "bigint") {
      return malformed(eventKind, "data_type_mismatch", "data[2] (amount) is not bigint");
    }
    if (typeof safetyDeposit !== "bigint") {
      return malformed(eventKind, "data_type_mismatch", "data[3] (safety_deposit) is not bigint");
    }
    if (typeof timelock !== "bigint") {
      return malformed(eventKind, "data_type_mismatch", "data[4] (timelock) is not bigint");
    }
    return {
      schemaVersion: HTLC_EVENT_SCHEMA_VERSION,
      kind: "created",
      orderId,
      hashlock: bytesToHex(hashlockRaw as Uint8Array),
      timelock: Number(timelock),
      sender,
      beneficiary,
      amount: amount.toString(),
      safetyDeposit: safetyDeposit.toString(),
    };
  }

  // ── claimed ──────────────────────────────────────────────────────────────────
  if (eventKind === "claimed") {
    // topics: [symbol, beneficiary, hashlock]
    if (topics.length < 3) {
      return malformed(eventKind, "topic_count_mismatch",
        `expected ≥3 topics, got ${topics.length}`);
    }
    const [, beneficiary, hashlockRaw] = topics as unknown[];
    if (typeof beneficiary !== "string") {
      return malformed(eventKind, "topic_type_mismatch", "topics[1] (beneficiary) is not a string");
    }
    if (!isBytes(hashlockRaw)) {
      return malformed(eventKind, "topic_type_mismatch", "topics[2] (hashlock) is not Bytes");
    }
    // data: [order_id, caller, preimage, amount, safety_deposit]
    if (data.length < 3) {
      return malformed(eventKind, "data_count_mismatch",
        `expected ≥3 data elements, got ${data.length}`);
    }
    const [orderId, , preimageRaw] = data as unknown[];
    if (typeof orderId !== "bigint") {
      return malformed(eventKind, "data_type_mismatch", "data[0] (order_id) is not bigint");
    }
    if (!isBytes(preimageRaw)) {
      return malformed(eventKind, "data_type_mismatch", "data[2] (preimage) is not Bytes");
    }
    return {
      schemaVersion: HTLC_EVENT_SCHEMA_VERSION,
      kind: "claimed",
      orderId,
      hashlock: bytesToHex(hashlockRaw as Uint8Array),
      preimage: bytesToHex(preimageRaw as Uint8Array),
      beneficiary,
    };
  }

  // ── refunded ─────────────────────────────────────────────────────────────────
  // topics: [symbol, refund_address, hashlock]
  if (topics.length < 3) {
    return malformed(eventKind, "topic_count_mismatch",
      `expected ≥3 topics, got ${topics.length}`);
  }
  const [, refundAddress, hashlockRaw] = topics as unknown[];
  if (typeof refundAddress !== "string") {
    return malformed(eventKind, "topic_type_mismatch", "topics[1] (refund_address) is not a string");
  }
  if (!isBytes(hashlockRaw)) {
    return malformed(eventKind, "topic_type_mismatch", "topics[2] (hashlock) is not Bytes");
  }
  // data: [order_id, caller, amount, safety_deposit]
  if (data.length < 1) {
    return malformed(eventKind, "data_count_mismatch",
      `expected ≥1 data element, got ${data.length}`);
  }
  const [orderId] = data as unknown[];
  if (typeof orderId !== "bigint") {
    return malformed(eventKind, "data_type_mismatch", "data[0] (order_id) is not bigint");
  }
  return {
    schemaVersion: HTLC_EVENT_SCHEMA_VERSION,
    kind: "refunded",
    orderId,
    hashlock: bytesToHex(hashlockRaw as Uint8Array),
    refundAddress,
  };
}

// ─── Type guard ───────────────────────────────────────────────────────────────

/** Returns true when the decode result is a {@link MalformedEventError}. */
export function isMalformedEvent(
  result: DecodedHtlcEvent | MalformedEventError | null,
): result is MalformedEventError {
  return result !== null && (result as MalformedEventError).isMalformed === true;
}
