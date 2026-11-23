/**
 * Provenance and integrity verification for recovered secret material (#1137).
 *
 * Every recovery must carry an explicit record identity that is bound to one
 * order, one transaction and one preimage. Verification never returns or logs
 * the rejected preimage — only a reason code and safe correlation fields.
 */

export interface RecoveryRecord {
  /** Explicit, stable identity of the recovery record (e.g. `txHash:logIndex`). */
  recordId: string;
  /** On-chain source order id the claim event refers to. */
  srcOrderId: string;
  preimage: string;
  txHash: string;
  source: "ethereum_log" | "operator";
  claimer?: string | null;
  /** Optional public id, when the recovery source also carries it. */
  orderPublicId?: string;
}

export interface RecoveryOrderSnapshot {
  publicId: string;
  srcOrderId: string | null;
  hashlock: string;
  preimage: string | null;
  status: string;
}

export type RecoveryRejection =
  | "missing_record_identity"
  | "wrong_order"
  | "mismatched_record"
  | "invalid_preimage";

export type RecoveryVerification =
  | { ok: true; algorithm: "sha256" | "keccak256" }
  | { ok: false; reason: RecoveryRejection };

export type PreimageValidator = (
  preimage: string,
  hashlock: string,
) => "sha256" | "keccak256" | null;

/**
 * Verify that a recovered secret belongs to the order it claims and matches
 * the order's committed hashlock before any persistence or relay.
 */
export function verifyRecoveryRecord(
  record: RecoveryRecord,
  order: RecoveryOrderSnapshot,
  validate: PreimageValidator,
): RecoveryVerification {
  if (!record || !record.recordId || !record.txHash || !record.preimage) {
    return { ok: false, reason: "missing_record_identity" };
  }
  // The record must be associated with exactly this order — a valid secret
  // recovered for a different order is not authorised for this one.
  if (order.srcOrderId === null || record.srcOrderId !== order.srcOrderId) {
    return { ok: false, reason: "wrong_order" };
  }
  if (record.orderPublicId !== undefined && record.orderPublicId !== order.publicId) {
    return { ok: false, reason: "wrong_order" };
  }
  const algorithm = validate(record.preimage, order.hashlock);
  if (!algorithm) return { ok: false, reason: "invalid_preimage" };
  return { ok: true, algorithm };
}

/** Safe fields only: never include the preimage or raw request data. */
export function redactedRecoveryContext(record: RecoveryRecord, order: RecoveryOrderSnapshot) {
  return {
    recordId: record.recordId,
    publicId: order.publicId,
    srcOrderId: order.srcOrderId,
    txHash: record.txHash,
    source: record.source,
    claimer: record.claimer ?? null,
    status: order.status,
  };
}
