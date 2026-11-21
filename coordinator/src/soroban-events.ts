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
import { Address, Contract, TransactionBuilder, Networks, rpc } from "@stellar/stellar-sdk";

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
  /** 32-byte hex hashlock (sha256 of preimage). */
  readonly hashlock: string;
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
  /** 32-byte hex hashlock (from topics). */
  readonly hashlock: string;
  /** hex preimage (from data). */
  readonly preimage: string;
  /** Stellar G-address of the beneficiary (from topics). */
  readonly beneficiary: string;
}

/** Normalized `refunded` event emitted when an expired order is refunded. */
export interface RefundedEvent {
  readonly schemaVersion: HtlcEventSchemaVersion;
  readonly kind: "refunded";
  /** Soroban numeric order id. */
  readonly orderId: bigint;
  /** 32-byte hex hashlock (from topics). */
  readonly hashlock: string;
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

/**
 * Normalise a raw bytes or hex-string value to a lowercase hex string without
 * a `0x` prefix.  Exported so callers (tests, tools) can reuse the same
 * normalisation the decoder applies to hashlock and preimage fields.
 */
export function toHex(value: Uint8Array | Buffer | string): string {
  if (typeof value === "string") {
    const hex = value.replace(/^0x/i, "");
    if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) {
      throw new Error("Invalid hex string");
    }
    return hex.toLowerCase();
  }
  return Buffer.from(value).toString("hex");
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
    const [orderId, asset, amount, safetyDeposit, timelock] = data as unknown[];
    if (typeof orderId !== "bigint") {
      return malformed(eventKind, "data_type_mismatch", "data[0] (order_id) is not bigint");
    }
    if (typeof asset !== "string") {
      return malformed(eventKind, "data_type_mismatch", "data[1] (asset) is not a string");
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
      hashlock: toHex(hashlockRaw as Uint8Array),
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
    if (data.length < 5) {
      return malformed(eventKind, "data_count_mismatch",
        `expected ≥5 data elements, got ${data.length}`);
    }
    const [orderId, caller, preimageRaw, amount, safetyDeposit] = data as unknown[];
    if (typeof orderId !== "bigint") {
      return malformed(eventKind, "data_type_mismatch", "data[0] (order_id) is not bigint");
    }
    if (typeof caller !== "string") {
      return malformed(eventKind, "data_type_mismatch", "data[1] (caller) is not a string");
    }
    if (!isBytes(preimageRaw)) {
      return malformed(eventKind, "data_type_mismatch", "data[2] (preimage) is not Bytes");
    }
    if ((preimageRaw as Uint8Array).length === 0) {
      return malformed(eventKind, "data_type_mismatch", "data[2] (preimage) is zero-length; a valid HTLC preimage must be non-empty");
    }
    if (typeof amount !== "bigint") {
      return malformed(eventKind, "data_type_mismatch", "data[3] (amount) is not bigint");
    }
    if (typeof safetyDeposit !== "bigint") {
      return malformed(eventKind, "data_type_mismatch", "data[4] (safety_deposit) is not bigint");
    }
    return {
      schemaVersion: HTLC_EVENT_SCHEMA_VERSION,
      kind: "claimed",
      orderId,
      hashlock: toHex(hashlockRaw as Uint8Array),
      preimage: toHex(preimageRaw as Uint8Array),
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
  if (data.length < 4) {
      return malformed(eventKind, "data_count_mismatch",
        `expected ≥4 data elements, got ${data.length}`);
  }
  const [orderId, caller, amount, safetyDeposit] = data as unknown[];
  if (typeof orderId !== "bigint") {
      return malformed(eventKind, "data_type_mismatch", "data[0] (order_id) is not bigint");
  }
  if (typeof caller !== "string") {
      return malformed(eventKind, "data_type_mismatch", "data[1] (caller) is not a string");
  }
  if (typeof amount !== "bigint") {
      return malformed(eventKind, "data_type_mismatch", "data[2] (amount) is not bigint");
  }
  if (typeof safetyDeposit !== "bigint") {
      return malformed(eventKind, "data_type_mismatch", "data[3] (safety_deposit) is not bigint");
  }
  return {
    schemaVersion: HTLC_EVENT_SCHEMA_VERSION,
    kind: "refunded",
    orderId,
    hashlock: toHex(hashlockRaw as Uint8Array),
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

// ─── Soroban TTL diagnostics ──────────────────────────────────────────────────
//
// Soroban contract instances and persistent entries (e.g. per-order data) have
// ledger-based TTLs.  Unlike permanent EVM storage, an entry that is not
// extended before its TTL lapses is archived and must be restored before it can
// be used again.  This section defines observable TTL thresholds and a
// read-only diagnostic that reports which contract/order state needs renewal.
//
// The diagnostic NEVER mutates state: it only reads ledger entries via
// `getLedgerEntries` and reports.  Renewal (the `extendFootprintTtl` /
// `restoreFootprint` operations) is an explicit operator action documented
// alongside this module.

/**
 * Minimum safe remaining TTL, in ledgers, for any monitored entry.
 *
 * At ~5s per ledger this is roughly 7 days of runway.  Operators should renew
 * whenever an entry drops below this threshold; the diagnostic classifies such
 * entries as `"below_threshold"`.
 */
export const SOROBAN_TTL_MIN_SAFE_LEDGERS = 120_960;

/**
 * Entries at or above this remaining-TTL value are considered healthy.
 * Between {@link SOROBAN_TTL_MIN_SAFE_LEDGERS} and this value the entry is
 * reported as `"warning"` so operators have time to act before it crosses the
 * hard minimum.
 */
export const SOROBAN_TTL_WARN_LEDGERS = 241_920;

/** Classification of a single monitored entry's remaining TTL. */
export type TtlStatus = "ok" | "warning" | "below_threshold" | "unavailable";

/** What kind of Soroban state an entry represents. */
export type TtlEntryKind = "contract_instance" | "order_persistent";

/** A single entry the diagnostic should monitor. */
export interface TtlTarget {
  /** Human-readable, non-secret label (e.g. "contract-instance", "order:42"). */
  readonly label: string;
  readonly kind: TtlEntryKind;
  /** Ledger key to query. */
  readonly key: xdr.LedgerKey;
}

/** Result for a single monitored entry. */
export interface TtlEntryReport {
  readonly label: string;
  readonly kind: TtlEntryKind;
  readonly status: TtlStatus;
  /** Remaining TTL in ledgers, or `null` when unavailable. */
  readonly remainingLedgers: number | null;
  /** Live-until ledger sequence, or `null` when unavailable. */
  readonly liveUntilLedger: number | null;
  /** Non-secret, actionable guidance for the operator. */
  readonly action: string;
}

/** Aggregate diagnostic report. */
export interface TtlDiagnosticReport {
  /** True when every monitored entry is `"ok"`. */
  readonly healthy: boolean;
  /** True when at least one entry is `"below_threshold"` or `"unavailable"`. */
  readonly requiresAction: boolean;
  /** Ledger sequence the report was computed against, when known. */
  readonly latestLedger: number | null;
  readonly entries: readonly TtlEntryReport[];
  /** Non-secret summary suitable for logs / alerting. */
  readonly summary: string;
}

/** Minimal read-only RPC surface the diagnostic depends on. */
export interface TtlRpcClient {
  getLatestLedger(): Promise<{ sequence: number }>;
  getLedgerEntries(
    ...keys: xdr.LedgerKey[]
  ): Promise<{ entries: Array<{ key: xdr.LedgerKey; liveUntilLedgerSeq?: number }> }>;
}

/** Classify a remaining-TTL value against the defined thresholds. */
export function classifyTtl(remainingLedgers: number): TtlStatus {
  if (remainingLedgers < SOROBAN_TTL_MIN_SAFE_LEDGERS) return "below_threshold";
  if (remainingLedgers < SOROBAN_TTL_WARN_LEDGERS) return "warning";
  return "ok";
}

function actionForStatus(status: TtlStatus, kind: TtlEntryKind): string {
  const subject = kind === "contract_instance" ? "contract instance" : "order persistent entry";
  switch (status) {
    case "ok":
      return `${subject} TTL is healthy; no action required.`;
    case "warning":
      return `${subject} TTL is approaching the minimum safe threshold; schedule an extension (extendFootprintTtl) before it crosses ${SOROBAN_TTL_MIN_SAFE_LEDGERS} ledgers.`;
    case "below_threshold":
      return `${subject} TTL is below the minimum safe threshold; extend it immediately (extendFootprintTtl) or restore it (restoreFootprint) if already archived.`;
    case "unavailable":
      return `${subject} TTL could not be read from RPC; retry the diagnostic and escalate if the RPC remains unavailable.`;
  }
}

/**
 * Build the ledger key for a contract instance entry.
 */
export function contractInstanceKey(contractId: string): xdr.LedgerKey {
  return new Contract(contractId).getFootprint() as unknown as xdr.LedgerKey;
}

/**
 * Build the ledger key for a persistent contract-data entry keyed by a symbol
 * or string (e.g. an order id encoded as a string key).
 */
export function persistentEntryKey(
  contractId: string,
  entryKey: xdr.ScVal,
): xdr.LedgerKey {
  const contract = new Contract(contractId);
  // ContractData ledger key for a persistent entry.
  return contract.getFootprint() && buildContractDataKey(contract.address(), entryKey);
}

function buildContractDataKey(
  contractAddress: Address,
  entryKey: xdr.ScVal,
): xdr.LedgerKey {
  // Delegate to the SDK's ledger-key builder via a throwaway footprint is not
  // available, so construct the ContractData key directly.
  const { xdr: xdrNs } = require("@stellar/stellar-sdk") as typeof import("@stellar/stellar-sdk");
  return xdrNs.LedgerKey.contractData(
    new xdrNs.LedgerKeyContractData({
      contract: contractAddress.toScAddress(),
      key: entryKey,
      durability: xdrNs.ContractDataDurability.persistent(),
    }),
  );
}

/**
 * Run the read-only TTL diagnostic against the supplied RPC client.
 *
 * This function performs no state mutation.  It queries the latest ledger and
 * the live-until sequence for each target, classifies each entry against the
 * defined thresholds, and returns a non-secret actionable report.
 *
 * RPC failures are captured per-entry as `"unavailable"` rather than thrown, so
 * a single flaky query cannot mask the rest of the report.
 */
export async function runTtlDiagnostic(
  client: TtlRpcClient,
  targets: readonly TtlTarget[],
): Promise<TtlDiagnosticReport> {
  let latestLedger: number | null = null;
  try {
    const latest = await client.getLatestLedger();
    latestLedger = latest.sequence;
  } catch {
    latestLedger = null;
  }

  const entries: TtlEntryReport[] = [];

  for (const target of targets) {
    let remainingLedgers: number | null = null;
    let liveUntilLedger: number | null = null;

    try {
      const response = await client.getLedgerEntries(target.key);
      const entry = response.entries.find((e) => e.key !== undefined);
      if (entry && typeof entry.liveUntilLedgerSeq === "number") {
        liveUntilLedger = entry.liveUntilLedgerSeq;
        if (latestLedger !== null) {
          remainingLedgers = liveUntilLedger - latestLedger;
        }
      }
    } catch {
      remainingLedgers = null;
      liveUntilLedger = null;
    }

    const status: TtlStatus =
      remainingLedgers === null ? "unavailable" : classifyTtl(remainingLedgers);

    entries.push({
      label: target.label,
      kind: target.kind,
      status,
      remainingLedgers,
      liveUntilLedger,
      action: actionForStatus(status, target.kind),
    });
  }

  const requiresAction = entries.some(
    (e) => e.status === "below_threshold" || e.status === "unavailable",
  );
  const healthy = entries.every((e) => e.status === "ok");

  const counts = entries.reduce<Record<TtlStatus, number>>(
    (acc, e) => {
      acc[e.status] += 1;
      return acc;
    },
    { ok: 0, warning: 0, below_threshold: 0, unavailable: 0 },
  );

  const summary =
    `Soroban TTL diagnostic: ${entries.length} entries ` +
    `(ok=${counts.ok}, warning=${counts.warning}, ` +
    `below_threshold=${counts.below_threshold}, unavailable=${counts.unavailable})` +
    (latestLedger !== null ? ` at ledger ${latestLedger}` : " (latest ledger unavailable)");

  return { healthy, requiresAction, latestLedger, entries, summary };
}

/**
 * Convenience wrapper that builds a read-only RPC client from a Soroban RPC URL
 * and runs the diagnostic.  The client is only used for read calls.
 */
export async function runTtlDiagnosticAgainstRpc(
  rpcUrl: string,
  targets: readonly TtlTarget[],
): Promise<TtlDiagnosticReport> {
  const server = new rpc.Server(rpcUrl);
  const client: TtlRpcClient = {
    getLatestLedger: () => server.getLatestLedger(),
    getLedgerEntries: (...keys) => server.getLedgerEntries(...keys),
  };
  return runTtlDiagnostic(client, targets);
}
