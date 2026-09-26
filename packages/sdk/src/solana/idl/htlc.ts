/**
 * Anchor IDL for the WaffleFinance Solana HTLC program.
 *
 * This IDL describes the on-chain account layout and the three mutating
 * instructions exposed by the program:
 *
 *   create_order  — lock tokens and create an HTLCOrder PDA
 *   claim_order   — reveal the preimage and transfer tokens to beneficiary
 *   refund_order  — return tokens to sender after the timelock expires
 *
 * Account layout
 * ───────────────
 * Each order is stored in a PDA derived from [b"order", hashlock_bytes].
 * This makes the PDA deterministic from the hashlock alone, which lets the
 * coordinator and SDK compute the orderId (= PDA address) without a
 * network call.
 *
 * Versioning
 * ──────────
 * The `version` field in the IDL is a monotonically incrementing u8 stored
 * in the account discriminator padding. The SDK reads it and rejects
 * accounts whose version is newer than IDL_VERSION to fail loudly rather
 * than silently misparse fields.
 *
 * To upgrade: bump IDL_VERSION, extend `HtlcOrderFields`, and update
 * `deserialiseOrderAccount`. Old accounts are never mutated on-chain so
 * the deserialiser can continue to support v0 layouts by branching on the
 * `version` byte.
 */

// ── Discriminator ──────────────────────────────────────────────────────────
//
// Anchor prepends an 8-byte SHA-256 discriminator to every account.
// Precomputed as: sha256("account:HtlcOrder")[0..8]
// You can regenerate it with: anchor idl parse …
export const HTLC_ORDER_DISCRIMINATOR = Buffer.from([
  0x17, 0x4c, 0x3d, 0x91, 0x5f, 0xa8, 0x2b, 0xe1
]);

/** Bump this when the account layout changes. */
export const IDL_VERSION = 0;

// ── On-chain account layout ────────────────────────────────────────────────
//
// Byte offsets after the 8-byte discriminator:
//
// Offset  Size  Type        Field
// ──────  ────  ──────────  ───────────────────────────────────
//      0     1  u8          version
//      1    32  Pubkey      sender
//     33    32  Pubkey      beneficiary
//     65    32  Pubkey      refund_address
//     97    32  Pubkey      mint
//    129     8  u64         amount  (little-endian)
//    137     8  u64         safety_deposit  (little-endian)
//    145    32  [u8;32]     hashlock
//    177     8  i64         timelock  (Unix seconds, little-endian)
//    185     1  u8          status   (0=Active 1=Claimed 2=Refunded)
//    186    33  Option<[u8;32]>  preimage  (1-byte Some/None tag + 32 bytes)
//
// Total: 8 (discriminator) + 219 (fields) = 227 bytes

export const HTLC_ORDER_ACCOUNT_SIZE = 227;

// ── Status enum ────────────────────────────────────────────────────────────

export const OrderStatus = {
  Active: 0,
  Claimed: 1,
  Refunded: 2,
} as const;
export type OrderStatusValue = (typeof OrderStatus)[keyof typeof OrderStatus];

// ── Field offsets (relative to account data, after the 8-byte discriminator) ─

export const FIELD_OFFSET = {
  version: 0,
  sender: 1,
  beneficiary: 33,
  refundAddress: 65,
  mint: 97,
  amount: 129,
  safetyDeposit: 137,
  hashlock: 145,
  timelock: 177,
  status: 185,
  preimage: 186,  // 1-byte tag + 32-byte value
} as const;

// ── Instruction discriminators ─────────────────────────────────────────────
//
// Anchor instruction discriminators are sha256("global:<method_name>")[0..8].
// Precomputed values below; regenerate with: anchor idl parse …

/** sha256("global:create_order")[0..8] */
export const IX_CREATE_ORDER = Buffer.from([
  0x9f, 0x04, 0x18, 0xd1, 0x6a, 0x7e, 0x59, 0x3c
]);

/** sha256("global:claim_order")[0..8] */
export const IX_CLAIM_ORDER = Buffer.from([
  0x3c, 0xa0, 0x5f, 0xd2, 0x11, 0x8b, 0x4a, 0xef
]);

/** sha256("global:refund_order")[0..8] */
export const IX_REFUND_ORDER = Buffer.from([
  0x5e, 0x2d, 0x87, 0x3f, 0x44, 0xc1, 0x7b, 0x22
]);

// ── PDA seed constants ─────────────────────────────────────────────────────

/** Seed prefix for HTLCOrder PDAs: [b"order", hashlock_bytes]. */
export const ORDER_SEED = Buffer.from("order");

// ── IDL compatibility guard ────────────────────────────────────────────────

/**
 * Canonical account ordering for the three HTLC instructions.
 *
 * This table is the authoritative reference for the on-chain account list
 * order.  Any SDK change that alters the account order or roles MUST be
 * accompanied by a bump of IDL_VERSION and an entry in the table below.
 *
 * Index 0 = first account passed to the instruction.
 *
 * create_order:
 *   0  payer            signer, writable   (fee payer / sender)
 *   1  order_pda        writable           (HTLCOrder PDA)
 *   2  mint             readonly           (SPL mint or native SOL)
 *   3  beneficiary      readonly
 *   4  refund_address   readonly
 *   5  system_program   readonly
 *   6  clock            readonly           (SYSVAR_CLOCK_PUBKEY)
 *
 * claim_order:
 *   0  claimer                   signer, writable
 *   1  order_pda                 writable
 *   2  beneficiary_token_account writable
 *   3  system_program            readonly
 *
 * refund_order:
 *   0  refunder        signer, writable
 *   1  order_pda       writable
 *   2  refund_account  writable
 *   3  system_program  readonly
 *   4  clock           readonly
 */
export const CANONICAL_ACCOUNT_ORDERING = {
  /** IDL version this table was generated from. */
  idlVersion: IDL_VERSION,
  createOrder: [
    { name: "payer",           signer: true,  writable: true  },
    { name: "order_pda",       signer: false, writable: true  },
    { name: "mint",            signer: false, writable: false },
    { name: "beneficiary",     signer: false, writable: false },
    { name: "refund_address",  signer: false, writable: false },
    { name: "system_program",  signer: false, writable: false },
    { name: "clock",           signer: false, writable: false },
  ],
  claimOrder: [
    { name: "claimer",                    signer: true,  writable: true  },
    { name: "order_pda",                  signer: false, writable: true  },
    { name: "beneficiary_token_account",  signer: false, writable: true  },
    { name: "system_program",             signer: false, writable: false },
  ],
  refundOrder: [
    { name: "refunder",       signer: true,  writable: true  },
    { name: "order_pda",      signer: false, writable: true  },
    { name: "refund_account", signer: false, writable: true  },
    { name: "system_program", signer: false, writable: false },
    { name: "clock",          signer: false, writable: false },
  ],
} as const;

/**
 * Instruction data sizes (bytes) including the 8-byte Anchor discriminator.
 *
 * create_order:  8 discriminator + 8 amount + 8 safety_deposit + 32 hashlock + 8 timelock = 64
 * claim_order:   8 discriminator + 32 preimage = 40
 * refund_order:  8 discriminator only = 8
 */
export const INSTRUCTION_DATA_SIZES = {
  createOrder: 64,
  claimOrder: 40,
  refundOrder: 8,
} as const;

export interface IdlCompatibilityResult {
  compatible: boolean;
  /** Detected on-chain version (from account data), or null if unknown. */
  onChainVersion: number | null;
  /** SDK IDL version. */
  sdkVersion: number;
  errors: string[];
  warnings: string[];
}

/**
 * Assert that an on-chain account version is compatible with this SDK.
 *
 * Call this whenever you obtain an account version from on-chain data
 * before deserialising fields.  Throws `Error` when the on-chain layout
 * is newer than this SDK supports, which prevents silent field misparse.
 *
 * Upgrade path:
 *  1. Deploy new Anchor program (bumps the `version` byte in every new account)
 *  2. Bump IDL_VERSION in this file
 *  3. Update FIELD_OFFSET and CANONICAL_ACCOUNT_ORDERING as needed
 *  4. Update deserialiseOrderAccount to handle both old and new layouts
 */
export function assertIdlCompatibility(onChainVersion: number): IdlCompatibilityResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (onChainVersion > IDL_VERSION) {
    errors.push(
      `On-chain account version ${onChainVersion} is newer than SDK IDL version ${IDL_VERSION}. ` +
      `Update @wafflefinance/sdk to read this account.`
    );
  }

  if (onChainVersion < IDL_VERSION) {
    // Older accounts are still readable — we keep backward compatibility.
    warnings.push(
      `On-chain account version ${onChainVersion} is older than SDK IDL version ${IDL_VERSION}. ` +
      `The account was created with an older program version; all known fields remain readable.`
    );
  }

  return {
    compatible: errors.length === 0,
    onChainVersion,
    sdkVersion: IDL_VERSION,
    errors,
    warnings,
  };
}

/**
 * Verify that a generated instruction's data and account list match the
 * canonical schema defined in this IDL.  Returns an array of validation
 * errors; an empty array means the instruction is schema-conformant.
 *
 * Callers (tests, CI gates) should assert `errors.length === 0` to prevent
 * instruction-layout drift from silently breaking the Anchor program.
 */
export function validateInstructionSchema(
  instruction: "createOrder" | "claimOrder" | "refundOrder",
  data: Uint8Array,
  keys: Array<{ isSigner: boolean; isWritable: boolean }>
): string[] {
  const errors: string[] = [];

  // ── Check data size ────────────────────────────────────────────────────
  const expectedSize = INSTRUCTION_DATA_SIZES[instruction];
  if (data.length !== expectedSize) {
    errors.push(
      `${instruction}: instruction data size mismatch — expected ${expectedSize} bytes, got ${data.length}`
    );
  }

  // ── Check discriminator ────────────────────────────────────────────────
  const DISCRIMINATORS: Record<string, Buffer> = {
    createOrder: IX_CREATE_ORDER,
    claimOrder: IX_CLAIM_ORDER,
    refundOrder: IX_REFUND_ORDER,
  };
  const expectedDisc = DISCRIMINATORS[instruction];
  const actualDisc = Buffer.from(data.subarray(0, 8));
  if (!actualDisc.equals(expectedDisc)) {
    errors.push(
      `${instruction}: discriminator mismatch — expected ${expectedDisc.toString("hex")}, ` +
      `got ${actualDisc.toString("hex")}`
    );
  }

  // ── Check account ordering ─────────────────────────────────────────────
  const expectedAccounts = CANONICAL_ACCOUNT_ORDERING[instruction];
  if (keys.length !== expectedAccounts.length) {
    errors.push(
      `${instruction}: account count mismatch — expected ${expectedAccounts.length}, got ${keys.length}`
    );
  } else {
    for (let i = 0; i < expectedAccounts.length; i++) {
      const exp = expectedAccounts[i];
      const act = keys[i];
      if (exp.signer !== act.isSigner) {
        errors.push(
          `${instruction}: account[${i}] (${exp.name}) signer mismatch — ` +
          `expected ${exp.signer}, got ${act.isSigner}`
        );
      }
      if (exp.writable !== act.isWritable) {
        errors.push(
          `${instruction}: account[${i}] (${exp.name}) writable mismatch — ` +
          `expected ${exp.writable}, got ${act.isWritable}`
        );
      }
    }
  }

  return errors;
}
