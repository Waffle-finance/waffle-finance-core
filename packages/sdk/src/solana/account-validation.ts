/**
 * Pre-submission account metadata validation for Solana HTLC operations (#715).
 *
 * Validates that Solana program accounts are correctly configured before a
 * transaction is submitted, preventing on-chain failures caused by:
 *  - Wrong PDA derivation (hashlock mismatch, wrong seed prefix, wrong program)
 *  - Account owned by a different program
 *  - Escrow account in an unexpected state (already claimed / refunded)
 *  - Program ID mismatch between the SDK and the deployed program
 *  - Stale / zero-lamport accounts
 *
 * Design principles
 * ─────────────────
 * 1. Fail before the transaction is built or sent — earlier = cheaper.
 * 2. Each check produces a structured `AccountValidationError` with a machine-
 *    readable `code` so callers can handle specific cases (e.g. "already claimed"
 *    → attempt recovery; "wrong owner" → operator alert).
 * 3. Validation is best-effort: a check that cannot run (e.g. no RPC) returns
 *    a warning, not a hard error, unless the caller opts into strict mode.
 */

import { Connection, PublicKey } from "@solana/web3.js";
import {
  HTLC_ORDER_DISCRIMINATOR,
  HTLC_ORDER_ACCOUNT_SIZE,
  IDL_VERSION,
  FIELD_OFFSET,
  ORDER_SEED,
  assertIdlCompatibility,
} from "./idl/htlc.js";
import { OrderStatus } from "./idl/htlc.js";

// ── Error types ────────────────────────────────────────────────────────────

export type AccountValidationCode =
  | "pda_mismatch"          // derived PDA does not match the provided orderId
  | "wrong_owner"           // account owned by a different program
  | "discriminator_mismatch" // account data prefix does not match HtlcOrder
  | "already_claimed"       // order status is Claimed — claim would double-spend
  | "already_refunded"      // order status is Refunded — refund would fail
  | "wrong_status"          // generic unexpected status for an operation
  | "idl_version_too_new"   // on-chain account version newer than SDK
  | "account_not_found"     // PDA account does not exist on-chain
  | "insufficient_lamports" // escrow account has fewer lamports than expected
  | "stale_account"         // account data is suspiciously zeroed / stale
  | "program_mismatch"      // programId in order does not match the client's programId
  | "invalid_address"       // address failed Solana public-key validation
  | "hashlock_mismatch";    // on-chain hashlock does not match the provided value

export class AccountValidationError extends Error {
  constructor(
    public readonly code: AccountValidationCode,
    message: string,
    public readonly context?: Record<string, unknown>
  ) {
    super(message);
    this.name = "AccountValidationError";
  }
}

// ── Validation result type ─────────────────────────────────────────────────

export interface AccountValidationResult {
  valid: boolean;
  errors: AccountValidationError[];
  /** Non-fatal issues that should be logged but do not block submission. */
  warnings: string[];
}

// ── Low-level helpers ──────────────────────────────────────────────────────

/**
 * Validate that `address` is a well-formed Solana base-58 public key.
 * Throws `AccountValidationError` with code `invalid_address` on failure.
 */
export function validateSolanaAddress(address: string, label = "address"): PublicKey {
  try {
    return new PublicKey(address);
  } catch {
    throw new AccountValidationError(
      "invalid_address",
      `${label} "${address}" is not a valid Solana public key (base-58)`,
      { address, label }
    );
  }
}

/**
 * Derive the expected PDA for an HTLC order and assert it matches `orderId`.
 *
 * Throws `AccountValidationError` with code `pda_mismatch` when derivation
 * produces a different address, which indicates a hashlock or programId error.
 */
export function validateOrderPda(
  orderId: string,
  hashlockBytes: Buffer,
  programId: PublicKey
): void {
  const [derived] = PublicKey.findProgramAddressSync(
    [ORDER_SEED, hashlockBytes],
    programId
  );
  if (derived.toBase58() !== orderId) {
    throw new AccountValidationError(
      "pda_mismatch",
      `PDA derivation mismatch: expected ${orderId}, derived ${derived.toBase58()}. ` +
      "The hashlock or programId may be wrong.",
      { orderId, derived: derived.toBase58(), programId: programId.toBase58() }
    );
  }
}

// ── On-chain account validation ────────────────────────────────────────────

export interface OnChainValidationOptions {
  /**
   * For `claimOrder`: minimum expected lamport balance on the escrow PDA.
   * Default: 0 (skips the check).
   */
  minLamports?: bigint;
  /**
   * When true, throw on the first error rather than collecting all of them.
   * Default: false (collect all).
   */
  strict?: boolean;
}

/**
 * Fetch the on-chain PDA account and validate its metadata.
 *
 * Checks (in order):
 *  1. Account exists (not null / rent-exempt)
 *  2. Owned by the expected HTLC program
 *  3. Anchor discriminator matches HtlcOrder
 *  4. Account size is at least HTLC_ORDER_ACCOUNT_SIZE
 *  5. IDL version compatibility
 *  6. Hashlock matches (when `hashlockBytes` is provided)
 *  7. Status is appropriate for the operation (`expectedStatus`)
 *  8. Lamport balance is above `minLamports`
 *
 * Returns `AccountValidationResult`. Does NOT throw — errors are collected
 * in `result.errors` so callers can batch-validate and report all issues.
 */
export async function validateOrderAccountOnChain(
  connection: Connection,
  orderId: string,
  programId: PublicKey,
  options: {
    /** The operation about to be performed — used to validate status constraints. */
    operation: "claim" | "refund" | "read";
    /** When provided, validates the on-chain hashlock matches this value. */
    hashlockBytes?: Buffer;
  } & OnChainValidationOptions
): Promise<AccountValidationResult> {
  const errors: AccountValidationError[] = [];
  const warnings: string[] = [];

  let orderPdaPk: PublicKey;
  try {
    orderPdaPk = new PublicKey(orderId);
  } catch {
    errors.push(
      new AccountValidationError(
        "invalid_address",
        `orderId "${orderId}" is not a valid Solana public key`,
        { orderId }
      )
    );
    return { valid: false, errors, warnings };
  }

  // ── Fetch account info ──────────────────────────────────────────────────
  let accountInfo: Awaited<ReturnType<Connection["getAccountInfo"]>>;
  try {
    accountInfo = await connection.getAccountInfo(orderPdaPk);
  } catch (err) {
    errors.push(
      new AccountValidationError(
        "account_not_found",
        `Failed to fetch account info for ${orderId}: ${err instanceof Error ? err.message : String(err)}`,
        { orderId }
      )
    );
    return { valid: false, errors, warnings };
  }

  // ── Account existence ───────────────────────────────────────────────────
  if (!accountInfo) {
    errors.push(
      new AccountValidationError(
        "account_not_found",
        `HTLCOrder account ${orderId} does not exist on-chain`,
        { orderId, programId: programId.toBase58() }
      )
    );
    return { valid: false, errors, warnings };
  }

  const data = Buffer.from(accountInfo.data);

  // ── Program ownership ────────────────────────────────────────────────────
  if (!accountInfo.owner.equals(programId)) {
    errors.push(
      new AccountValidationError(
        "wrong_owner",
        `HTLCOrder account ${orderId} is owned by ${accountInfo.owner.toBase58()} ` +
        `but expected program ${programId.toBase58()}. ` +
        "This may indicate a program upgrade mismatch or the wrong program ID in config.",
        {
          orderId,
          expectedOwner: programId.toBase58(),
          actualOwner: accountInfo.owner.toBase58(),
        }
      )
    );
    if (options.strict) return { valid: false, errors, warnings };
  }

  // ── Discriminator ────────────────────────────────────────────────────────
  if (data.length < 8) {
    errors.push(
      new AccountValidationError(
        "discriminator_mismatch",
        `Account data too short to contain an Anchor discriminator (${data.length} bytes)`,
        { orderId, dataLength: data.length }
      )
    );
    return { valid: false, errors, warnings };
  }

  const disc = data.subarray(0, 8);
  if (!disc.equals(HTLC_ORDER_DISCRIMINATOR)) {
    errors.push(
      new AccountValidationError(
        "discriminator_mismatch",
        `Anchor discriminator mismatch on ${orderId}: ` +
        `expected ${HTLC_ORDER_DISCRIMINATOR.toString("hex")}, ` +
        `got ${disc.toString("hex")}. ` +
        "The account may belong to a different program or has been corrupted.",
        {
          orderId,
          expected: HTLC_ORDER_DISCRIMINATOR.toString("hex"),
          actual: disc.toString("hex"),
        }
      )
    );
    if (options.strict) return { valid: false, errors, warnings };
  }

  // ── Account size ─────────────────────────────────────────────────────────
  if (data.length < HTLC_ORDER_ACCOUNT_SIZE) {
    errors.push(
      new AccountValidationError(
        "stale_account",
        `HTLCOrder account ${orderId} is too small ` +
        `(${data.length} bytes, expected >= ${HTLC_ORDER_ACCOUNT_SIZE})`,
        { orderId, dataLength: data.length, minSize: HTLC_ORDER_ACCOUNT_SIZE }
      )
    );
    return { valid: false, errors, warnings };
  }

  const fields = data.subarray(8);

  // ── IDL version compatibility ────────────────────────────────────────────
  const onChainVersion = fields.readUInt8(FIELD_OFFSET.version);
  const compatResult = assertIdlCompatibility(onChainVersion);
  if (!compatResult.compatible) {
    errors.push(
      new AccountValidationError(
        "idl_version_too_new",
        compatResult.errors[0],
        { orderId, onChainVersion, sdkVersion: IDL_VERSION }
      )
    );
    if (options.strict) return { valid: false, errors, warnings };
  }
  for (const w of compatResult.warnings) {
    warnings.push(w);
  }

  // ── Hashlock match ───────────────────────────────────────────────────────
  if (options.hashlockBytes) {
    const onChainHashlock = fields.subarray(
      FIELD_OFFSET.hashlock,
      FIELD_OFFSET.hashlock + 32
    );
    if (!onChainHashlock.equals(options.hashlockBytes)) {
      errors.push(
        new AccountValidationError(
          "hashlock_mismatch",
          `On-chain hashlock for order ${orderId} does not match the provided value. ` +
          "The order PDA may have been derived with a different hashlock.",
          {
            orderId,
            onChainHashlock: onChainHashlock.toString("hex"),
            providedHashlock: options.hashlockBytes.toString("hex"),
          }
        )
      );
      if (options.strict) return { valid: false, errors, warnings };
    }
  }

  // ── Status validation ────────────────────────────────────────────────────
  const statusByte = fields.readUInt8(FIELD_OFFSET.status);
  const statusValid = statusByte === 0 || statusByte === 1 || statusByte === 2;

  if (!statusValid) {
    warnings.push(
      `Unknown status byte ${statusByte} on order ${orderId} — account may be malformed`
    );
  } else if (options.operation === "claim") {
    if (statusByte === OrderStatus.Claimed) {
      errors.push(
        new AccountValidationError(
          "already_claimed",
          `Cannot claim order ${orderId}: it has already been claimed (status=Claimed). ` +
          "The preimage has already been revealed on-chain.",
          { orderId, status: statusByte }
        )
      );
    } else if (statusByte === OrderStatus.Refunded) {
      errors.push(
        new AccountValidationError(
          "already_refunded",
          `Cannot claim order ${orderId}: it has already been refunded (status=Refunded).`,
          { orderId, status: statusByte }
        )
      );
    }
  } else if (options.operation === "refund") {
    if (statusByte === OrderStatus.Refunded) {
      errors.push(
        new AccountValidationError(
          "already_refunded",
          `Cannot refund order ${orderId}: it has already been refunded (status=Refunded).`,
          { orderId, status: statusByte }
        )
      );
    } else if (statusByte === OrderStatus.Claimed) {
      errors.push(
        new AccountValidationError(
          "already_claimed",
          `Cannot refund order ${orderId}: it was claimed (status=Claimed). ` +
          "Funds have already been transferred to the beneficiary.",
          { orderId, status: statusByte }
        )
      );
    }
  }

  // ── Lamport balance ──────────────────────────────────────────────────────
  if (options.minLamports && options.minLamports > 0n) {
    const lamports = BigInt(accountInfo.lamports);
    if (lamports < options.minLamports) {
      errors.push(
        new AccountValidationError(
          "insufficient_lamports",
          `HTLCOrder account ${orderId} has insufficient lamports ` +
          `(${lamports}, expected >= ${options.minLamports})`,
          { orderId, lamports: lamports.toString(), minLamports: options.minLamports.toString() }
        )
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Pre-submission validation for `create_order`.
 *
 * Validates:
 *  - All public-key addresses parse correctly
 *  - The derived PDA matches the expected orderId (if provided)
 *  - The PDA account does NOT yet exist (would indicate a duplicate order)
 */
export async function validateCreateOrderParams(
  connection: Connection,
  programId: PublicKey,
  params: {
    sender: string;
    beneficiary: string;
    refundAddress: string;
    mint: string;
    hashlockBytes: Buffer;
    /** If provided, verify the expected orderId matches PDA derivation. */
    expectedOrderId?: string;
  }
): Promise<AccountValidationResult> {
  const errors: AccountValidationError[] = [];
  const warnings: string[] = [];

  // Validate all addresses.
  const addressFields: Array<[string, string]> = [
    ["sender", params.sender],
    ["beneficiary", params.beneficiary],
    ["refundAddress", params.refundAddress],
    ["mint", params.mint],
  ];
  for (const [label, addr] of addressFields) {
    try {
      validateSolanaAddress(addr, label);
    } catch (e) {
      errors.push(e as AccountValidationError);
    }
  }

  if (errors.length > 0) return { valid: false, errors, warnings };

  // Derive and validate the PDA.
  const [expectedPda] = PublicKey.findProgramAddressSync(
    [ORDER_SEED, params.hashlockBytes],
    programId
  );

  if (params.expectedOrderId && params.expectedOrderId !== expectedPda.toBase58()) {
    errors.push(
      new AccountValidationError(
        "pda_mismatch",
        `Expected orderId ${params.expectedOrderId} does not match derived PDA ${expectedPda.toBase58()}`,
        {
          expectedOrderId: params.expectedOrderId,
          derivedPda: expectedPda.toBase58(),
          programId: programId.toBase58(),
        }
      )
    );
  }

  // Check for duplicate order (PDA already exists).
  try {
    const existing = await connection.getAccountInfo(expectedPda);
    if (existing !== null) {
      warnings.push(
        `HTLCOrder PDA ${expectedPda.toBase58()} already exists on-chain. ` +
        "This create_order will likely fail as the account is already initialised."
      );
    }
  } catch {
    // Best-effort check — RPC failure is non-fatal here.
    warnings.push("Could not check for duplicate PDA — RPC unavailable");
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Pre-submission validation for `claim_order`.
 *
 * Validates:
 *  - orderId is a valid public key
 *  - On-chain account exists, is owned by the HTLC program, and has
 *    status=Active (not already claimed or refunded)
 *  - Hashlock matches the provided value
 */
export async function validateClaimOrderParams(
  connection: Connection,
  programId: PublicKey,
  params: {
    orderId: string;
    hashlockBytes?: Buffer;
    minLamports?: bigint;
  }
): Promise<AccountValidationResult> {
  return validateOrderAccountOnChain(connection, params.orderId, programId, {
    operation: "claim",
    hashlockBytes: params.hashlockBytes,
    minLamports: params.minLamports,
  });
}

/**
 * Pre-submission validation for `refund_order`.
 *
 * Validates:
 *  - orderId is a valid public key
 *  - On-chain account exists and has status=Active (not already refunded)
 */
export async function validateRefundOrderParams(
  connection: Connection,
  programId: PublicKey,
  params: {
    orderId: string;
  }
): Promise<AccountValidationResult> {
  return validateOrderAccountOnChain(connection, params.orderId, programId, {
    operation: "refund",
  });
}
