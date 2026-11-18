/**
 * Single source of truth for Solana account sizes and rent exemption.
 *
 * Why this module exists
 * ──────────────────────
 * The Solana HTLC program's account layout used to live as one hardcoded
 * literal (`HTLC_ORDER_ACCOUNT_SIZE = 227`) plus a byte-offset table that was
 * maintained by hand. Nothing tied the two together: adding a field to the
 * offset table without updating the size produced a constant that was
 * consistently wrong, and every test that asserted "227" still passed.
 *
 * Rent was worse. `getMinimumBalanceForRentExemption` was never called in
 * production code — the only calls in the repository were inside a test, where
 * the method was mocked to a hardcoded value. No service checked whether the
 * payer could actually cover the account's rent before submitting, so an
 * underfunded payer surfaced as an opaque runtime failure rather than an
 * actionable error.
 *
 * Everything size- or rent-related now flows through here:
 *
 *   • `SOLANA_ANCHOR_ACCOUNT_LAYOUTS` declares every account as a list of
 *     typed fields. Sizes are **derived**, never written down twice.
 *   • `getRentExemptMinimum` asks the cluster, so a rent-table change never
 *     requires a code change.
 *   • `assertPayerCanFund`, `assertAccountIsUninitialised`, and
 *     `verifyInitialisedAccount` are the safety rails: they run before and
 *     after a transaction and fail with diagnostics that name the account, the
 *     expected value, and the observed value.
 *
 * Boundary with the on-chain program
 * ───────────────────────────────────
 * This repository does not contain the Anchor program, so "client size matches
 * on-chain size" cannot be asserted against real accounts here. What *is*
 * assertable — and what the drift gate in `test/solana-account-sizing.test.ts`
 * checks — is that the exported sizes, the field tables, and the offsets the
 * deserialiser reads all agree with each other. When the program is added to
 * this repository, `assertAccountSize` is the hook that verifies the two.
 *
 * Reference values (mainnet, 128-byte accounts) are provided for documentation
 * and tests only. Production code must always call the cluster.
 */

import { PublicKey, type Commitment, type Connection, type AccountInfo } from "@solana/web3.js";

// This module is deliberately dependency-free within the Solana surface: it
// imports nothing from `./idl/*`. The IDL modules import *from here* to derive
// their sizes, so an import in the other direction would form a cycle and
// `HTLC_ORDER_ACCOUNT_SIZE` would read an uninitialised binding.

// ── Anchor framing ──────────────────────────────────────────────────────────

/**
 * Anchor prepends an 8-byte discriminator to every account it owns.
 *
 * Every `space = N` in an Anchor program is `N` = 8 + sum(field sizes); the
 * 8 is not optional. Omitting it yields an account the deserialiser rejects.
 */
export const ANCHOR_DISCRIMINATOR_SIZE = 8;

/** Solana's system account: 128 bytes of overhead, used for rent maths only. */
export const SYSTEM_ACCOUNT_OVERHEAD_BYTES = 128;

/** Bytes reserved for a transaction signature when budgeting fees. */
export const SIGNATURE_SIZE_BYTES = 64;

/** Base Solana transaction fee, lamports. */
export const BASE_TRANSACTION_FEE_LAMPORTS = 5_000n;

/** Solana's default signature verification cost, lamports per signature. */
export const DEFAULT_SIGNATURE_FEE_LAMPORTS = 5_000n;

// ── Borsh primitive widths ──────────────────────────────────────────────────

/**
 * Serialised width, in bytes, of each Rust type used by the HTLC program's
 * accounts. Mirrors borsh (and by extension Anchor's `#[derive(InitSpace)]`),
 * which is what generates `space = ...` on-chain.
 */
export const SOLANA_TYPE_SIZES = {
  /** `u8`, `bool`, and the tag byte of any `Option<T>`. */
  u8: 1,
  bool: 1,
  /** `u16` / `i16`. */
  u16: 2,
  /** `u32` / `i32`. */
  u32: 4,
  /** `u64` / `i64`. */
  u64: 8,
  /** `u128` / `i128`. */
  u128: 16,
  /** Solana `Pubkey`. */
  pubkey: 32,
  /** `[u8; 32]` — a raw hashlock or preimage. */
  bytes32: 32,
} as const;

/** Convenience alias for a 32-byte `Pubkey`. */
export const PUBKEY_SIZE = SOLANA_TYPE_SIZES.pubkey;

/**
 * Serialised width of `Option<T>`: a 1-byte discriminant plus the widest
 * variant. borsh encodes `None` as the tag alone but the *space* reservation
 * must cover `Some`, or the account is undersized the moment a value is
 * written.
 */
export function optionSize(inner: number): number {
  return SOLANA_TYPE_SIZES.u8 + inner;
}

/**
 * Serialised width of a fixed-size `[T; N]` array.
 *
 * `Vec<T>` and `String` are deliberately absent: their on-chain size is
 * `4 + N * size_of::<T>()` (borsh length prefix) and is chosen by the program
 * author, not derivable. Neither type appears in these accounts, and adding
 * one without recording a max length is exactly the "undocumented assumption"
 * this module exists to prevent — so the absence is asserted, not assumed.
 */
export function fixedArraySize(inner: number, length: number): number {
  if (!Number.isInteger(length) || length < 0) {
    throw new RangeError(
      `fixedArraySize: length must be a non-negative integer, got ${length}`
    );
  }
  return inner * length;
}

// ── Account layouts ─────────────────────────────────────────────────────────

/** One field in an account's serialised layout. */
export interface AccountFieldSpec {
  /** Rust field name, matching `FIELD_OFFSET` keys. */
  readonly name: string;
  /** Serialised width in bytes. */
  readonly size: number;
  /** Short human description used in error diagnostics. */
  readonly type: string;
}

/** A complete account layout, excluding the 8-byte discriminator. */
export interface AccountLayoutSpec {
  /** Human name used in error diagnostics. */
  readonly label: string;
  /** Anchor account name, i.e. the `account:<name>` discriminator input. */
  readonly anchorAccountName: string;
  /** PDA seed prefix, as the UTF-8 string. Named here so diagnostics do not
   *  have to import the IDL (which imports this module). */
  readonly seedLabel: string;
  /** Fields in declaration order, which is also serialisation order. */
  readonly fields: readonly AccountFieldSpec[];
}

/**
 * Where to fix a bad layout. Named in the self-check's error message so a
 * failed import says which file to open, instead of leaving the caller to
 * search for the one place account sizes are defined.
 */
export const ANCHOR_LAYOUT_TABLE_SOURCE =
  "packages/sdk/src/solana/account-sizing.ts (SOLANA_ANCHOR_ACCOUNT_LAYOUTS)";

/**
 * Every Solana account this SDK knows how to size.
 *
 * This table — not any exported constant — is the definition. Adding a field
 * here changes the derived size, which is what the drift gate asserts.
 */
export const SOLANA_ANCHOR_ACCOUNT_LAYOUTS = {
  /**
   * `HtlcOrder` — one per HTLC, derived from `[b"order", hashlock]`.
   *
   * Field order matches `FIELD_OFFSET` in `./idl/htlc.ts`; that pairing is
   * checked by the drift gate, so the two cannot drift apart.
   */
  htlcOrder: {
    label: "HtlcOrder",
    anchorAccountName: "HtlcOrder",
    seedLabel: "order",
    fields: [
      { name: "version",         size: SOLANA_TYPE_SIZES.u8,      type: "u8" },
      { name: "sender",          size: SOLANA_TYPE_SIZES.pubkey,  type: "Pubkey" },
      { name: "beneficiary",     size: SOLANA_TYPE_SIZES.pubkey,  type: "Pubkey" },
      { name: "refundAddress",   size: SOLANA_TYPE_SIZES.pubkey,  type: "Pubkey" },
      { name: "mint",            size: SOLANA_TYPE_SIZES.pubkey,  type: "Pubkey" },
      { name: "amount",          size: SOLANA_TYPE_SIZES.u64,     type: "u64" },
      { name: "safetyDeposit",   size: SOLANA_TYPE_SIZES.u64,     type: "u64" },
      { name: "hashlock",        size: SOLANA_TYPE_SIZES.bytes32, type: "[u8; 32]" },
      { name: "timelock",        size: SOLANA_TYPE_SIZES.u64,     type: "i64" },
      { name: "status",          size: SOLANA_TYPE_SIZES.u8,      type: "enum OrderStatus" },
      { name: "preimage",        size: optionSize(SOLANA_TYPE_SIZES.bytes32), type: "Option<[u8; 32]>" },
    ],
  },
  /**
   * `OrderRegistry` — the program's global `state` account: a monotonically
   * increasing order counter at `[b"state"]`.
   *
   * This is the only account the program allocates by counter rather than by
   * content hash, which is exactly why its size and rent were previously
   * unstated. It is created once, by the program's initialiser, and is not
   * re-initialised.
   */
  orderRegistry: {
    label: "OrderRegistry",
    anchorAccountName: "State",
    seedLabel: "state",
    fields: [
      { name: "orderCount", size: SOLANA_TYPE_SIZES.u64, type: "u64" },
    ],
  },
} as const satisfies Record<string, AccountLayoutSpec>;

export type SolanaAccountLayoutName = keyof typeof SOLANA_ANCHOR_ACCOUNT_LAYOUTS;

/**
 * Serialised size of an account's fields, excluding the 8-byte discriminator.
 *
 * Summed from the layout table rather than written down, so a field added to
 * the table cannot be forgotten in the total.
 */
export function fieldsSizeFor(layout: AccountLayoutSpec): number {
  return layout.fields.reduce((total, f) => total + f.size, 0);
}

/**
 * Total on-chain space for an account: the 8-byte Anchor discriminator plus
 * every declared field. This is the value that belongs in `space = ...` on
 * chain and the value rent must be computed from.
 */
export function accountSizeFor(
  layout: AccountLayoutSpec | SolanaAccountLayoutName
): number {
  const spec =
    typeof layout === "string" ? SOLANA_ANCHOR_ACCOUNT_LAYOUTS[layout] : layout;
  if (!spec) {
    throw new Error(
      `accountSizeFor: unknown account layout "${layout}". ` +
      `Known layouts: ${Object.keys(SOLANA_ANCHOR_ACCOUNT_LAYOUTS).join(", ")}`
    );
  }
  return ANCHOR_DISCRIMINATOR_SIZE + fieldsSizeFor(spec);
}

/** Structural check that every declared layout is self-consistent. */
export function validateAccountLayouts(): string[] {
  const problems: string[] = [];
  const entries = Object.entries(
    SOLANA_ANCHOR_ACCOUNT_LAYOUTS
  ) as Array<[string, AccountLayoutSpec]>;
  for (const [name, layout] of entries) {
    if (layout.fields.length === 0) {
      problems.push(`${name}: declares no fields`);
    }
    const seen = new Set<string>();
    for (const field of layout.fields) {
      if (!Number.isInteger(field.size) || field.size <= 0) {
        problems.push(
          `${name}.${field.name}: size must be a positive integer, got ${field.size}`
        );
      }
      if (seen.has(field.name)) {
        problems.push(`${name}: duplicate field name "${field.name}"`);
      }
      seen.add(field.name);
    }
    if (accountSizeFor(layout) <= ANCHOR_DISCRIMINATOR_SIZE) {
      problems.push(
        `${name}: total size ${accountSizeFor(layout)} is not greater than the ` +
        `${ANCHOR_DISCRIMINATOR_SIZE}-byte discriminator alone`
      );
    }
  }
  return problems;
}

/**
 * Run the layout self-check at import time.
 *
 * A malformed layout table is a *packaging* bug, not a runtime condition: the
 * table is a literal in this file, so nothing but a bad edit can break it. If
 * it ever is broken, every derived size — and therefore every rent figure and
 * every post-init length check — is wrong, and the failure would otherwise
 * surface as a confusing on-chain "already in use" or a truncated account
 * discovered by a user. Failing at import moves the diagnostic to the import
 * stack, naming the account and the field at fault.
 */
const LAYOUT_PROBLEMS = validateAccountLayouts();
if (LAYOUT_PROBLEMS.length > 0) {
  throw new Error(
    `Invalid Solana account layout table in ${ANCHOR_LAYOUT_TABLE_SOURCE}. ` +
    `Every account size in this SDK is derived from it, so this must be fixed ` +
    `before any transaction is built:\n  - ${LAYOUT_PROBLEMS.join("\n  - ")}`
  );
}

// ── Errors ──────────────────────────────────────────────────────────────────

/**
 * Machine-readable discriminants for every failure this module raises.
 *
 * These are the client-side equivalent of an Anchor program's `#[error_code]`
 * enum: one variant per check, so a caller can branch on *which* invariant
 * failed rather than pattern-matching a message string.
 */
export type SolanaAccountInitErrorCode =
  /** Declared size and observed size disagree. */
  | "InvalidAccountSize"
  /** Payer cannot cover amount + rent + fees. */
  | "InsufficientRent"
  /** The PDA already holds a program-owned, initialised account. */
  | "AccountAlreadyInitialized"
  /** Lamports present but no data, or data present but under rent, or vice versa. */
  | "UnexpectedAccountBalance"
  /** The account is owned by a program other than the expected one. */
  | "UnexpectedAccountOwner"
  /** The account holds fewer lamports than the rent-exempt minimum. */
  | "AccountNotRentExempt"
  /** Post-init verification found no account where one was required. */
  | "AccountInitVerificationFailed"
  /** `simulate()` reported a failure, or the simulation RPC call itself failed. */
  | "SimulationFailed";

/** Base class so callers can catch every init-robustness failure at once. */
export class SolanaAccountInitError extends Error {
  constructor(
    public readonly code: SolanaAccountInitErrorCode,
    message: string,
    /** Structured detail for logs and operator alerts. */
    public readonly context: Record<string, unknown> = {},
    /** Program logs from a failed simulation, when available. */
    public readonly simulationLogs?: string[]
  ) {
    super(message);
    this.name = "SolanaAccountInitError";
  }
}

/**
 * A size assumption is wrong: the account is smaller or larger than the layout
 * declares. Almost always means the SDK and the deployed program disagree, so
 * the message names both the account and the field table to reconcile.
 */
export class InvalidAccountSizeError extends SolanaAccountInitError {
  constructor(
    message: string,
    context: Record<string, unknown> = {},
    simulationLogs?: string[]
  ) {
    super("InvalidAccountSize", message, context, simulationLogs);
    this.name = "InvalidAccountSizeError";
  }
}

/**
 * The payer cannot fund the transaction. The message states the required
 * lamport total, the available balance, and the shortfall.
 */
export class InsufficientRentError extends SolanaAccountInitError {
  constructor(
    message: string,
    context: Record<string, unknown> = {},
    simulationLogs?: string[]
  ) {
    super("InsufficientRent", message, context, simulationLogs);
    this.name = "InsufficientRentError";
  }
}

/**
 * The account already exists and is initialised. Creating it again would
 * either revert (`init`) or, with `init_if_needed`, silently overwrite state —
 * so this is always an error, never a warning.
 */
export class AccountAlreadyInitializedError extends SolanaAccountInitError {
  constructor(
    message: string,
    context: Record<string, unknown> = {},
    simulationLogs?: string[]
  ) {
    super("AccountAlreadyInitialized", message, context, simulationLogs);
    this.name = "AccountAlreadyInitializedError";
  }
}

/**
 * An account exists in a state that initialisation cannot legally proceed
 * from: lamports but no data (a pre-funded PDA), data but under the
 * rent-exempt minimum, or owned by an unexpected program.
 */
export class UnexpectedAccountBalanceError extends SolanaAccountInitError {
  constructor(
    message: string,
    context: Record<string, unknown> = {},
    simulationLogs?: string[]
  ) {
    super("UnexpectedAccountBalance", message, context, simulationLogs);
    this.name = "UnexpectedAccountBalanceError";
  }
}

/**
 * An account at the expected address is owned by a different program.
 *
 * Distinct from `UnexpectedAccountBalance` because the remedy differs: a
 * pre-funded address needs draining, whereas a foreign owner means the program
 * id or the PDA seeds are wrong and *no* transaction against this program will
 * ever touch that account.
 */
export class UnexpectedAccountOwnerError extends SolanaAccountInitError {
  constructor(
    message: string,
    context: Record<string, unknown> = {},
    simulationLogs?: string[]
  ) {
    super("UnexpectedAccountOwner", message, context, simulationLogs);
    this.name = "UnexpectedAccountOwnerError";
  }
}

/**
 * An account holds fewer lamports than the rent-exempt minimum for its size.
 *
 * Solana's runtime does not reject such an account; it *purges* it. A
 * transaction can therefore confirm and still leave an account that silently
 * disappears, which is why this is checked explicitly rather than inferred
 * from a successful transaction.
 */
export class AccountNotRentExemptError extends SolanaAccountInitError {
  constructor(
    message: string,
    context: Record<string, unknown> = {},
    simulationLogs?: string[]
  ) {
    super("AccountNotRentExempt", message, context, simulationLogs);
    this.name = "AccountNotRentExemptError";
  }
}

/** Post-initialisation verification failed: the account is not what it must be. */
export class AccountInitVerificationError extends SolanaAccountInitError {
  constructor(
    message: string,
    context: Record<string, unknown> = {},
    simulationLogs?: string[]
  ) {
    super("AccountInitVerificationFailed", message, context, simulationLogs);
    this.name = "AccountInitVerificationError";
  }
}

/**
 * `simulateTransaction` rejected the transaction, or the RPC call to simulate
 * it failed outright.
 *
 * Distinct from {@link AccountInitVerificationError}: nothing has been created
 * yet, so this is a *pre-submission* rejection and the account is untouched.
 * The program logs are attached — they are the only thing that distinguishes an
 * under-funded payer from a re-used account from a timelock violation on-chain.
 */
export class SimulationFailedError extends SolanaAccountInitError {
  constructor(
    message: string,
    context: Record<string, unknown> = {},
    simulationLogs?: string[]
  ) {
    super("SimulationFailed", message, context, simulationLogs);
    this.name = "SimulationFailedError";
  }
}

// ── Size checks ─────────────────────────────────────────────────────────────

/**
 * Assert that an observed data length matches the declared layout.
 *
 * `mode: "exact"` is for a freshly created account, where the program must
 * have written every declared byte. `mode: "at-least"` is for reads, where a
 * later program version may legitimately have grown the account.
 *
 * Throws `InvalidAccountSizeError` naming the expected size, the found size,
 * and the account.
 */
export function assertAccountSize(
  layout: AccountLayoutSpec | SolanaAccountLayoutName,
  actualSize: number,
  options: {
    /** Which account is being checked, for the message. */
    account?: string;
    mode?: "exact" | "at-least";
  } = {}
): number {
  const spec =
    typeof layout === "string" ? SOLANA_ANCHOR_ACCOUNT_LAYOUTS[layout] : layout;
  const expected = accountSizeFor(spec);
  const label = spec.label;
  const account = options.account ?? label;
  const mode = options.mode ?? "exact";

  const mismatch =
    mode === "exact"
      ? actualSize !== expected
      : actualSize < expected;

  if (mismatch) {
    const relation = mode === "exact" ? "exactly" : "at least";
    throw new InvalidAccountSizeError(
      `${label} account size mismatch: expected ${relation} ${expected} bytes ` +
      `(${ANCHOR_DISCRIMINATOR_SIZE} discriminator + ${fieldsSizeFor(spec)} field bytes), ` +
      `found ${actualSize} bytes` +
      (actualSize < expected
        ? `. The account is ${expected - actualSize} bytes short — it was created with a smaller ` +
          `space than this SDK expects, so its fields cannot be read.`
        : `, ${actualSize - expected} bytes over — the deployed program has a larger layout than ` +
          `this SDK's IDL; upgrade @wafflefinance/sdk before reading this account.`) +
      ` Account: ${account}. Layout: ${spec.fields.map((f) => `${f.name}:${f.size}`).join("+")}.`,
      { account, expected, actual: actualSize, mode, layout: spec.label }
    );
  }

  return expected;
}

// ── Rent ────────────────────────────────────────────────────────────────────

/**
 * Rent-exempt minimum for an account of `size` bytes, asked of the cluster.
 *
 * Always call this rather than hardcoding a lamport figure: the value is
 * `ACCOUNT_STORAGE_OVERHEAD_RENT (128 B) + size * lamports_per_byte_year` and
 * both terms are cluster parameters that change at the runtime's discretion.
 *
 * Reference (mainnet-beta, 3480 lamports/byte-year, 2.0-year threshold,
 * 128-byte storage overhead) — computed with {@link referenceRentExemptMinimum}
 * and pinned by `test/solana-account-sizing.test.ts`:
 *
 *   • 0 bytes (the 128-byte overhead alone) →    890_880 lamports
 *   • 16 bytes (`OrderRegistry`, 8 + 8 u64)   →  1_002_240 lamports
 *   • 227 bytes (`HtlcOrder`, 8 + 219 fields)  →  2_470_800 lamports
 *
 * Those are documentation values; this function is the only supported source.
 */
export async function getRentExemptMinimum(
  connection: Pick<Connection, "getMinimumBalanceForRentExemption">,
  size: number
): Promise<bigint> {
  if (!Number.isInteger(size) || size < 0) {
    throw new RangeError(
      `getRentExemptMinimum: size must be a non-negative integer, got ${size}`
    );
  }
  const lamports = await connection.getMinimumBalanceForRentExemption(size);
  return BigInt(lamports);
}

/** Transaction fee budget for a transaction with `signatureCount` signers. */
export function transactionFee(
  signatureCount: number,
  perSignature: bigint = DEFAULT_SIGNATURE_FEE_LAMPORTS
): bigint {
  return BASE_TRANSACTION_FEE_LAMPORTS + perSignature * BigInt(signatureCount);
}

/** Rent-exempt minimum for a named account layout. */
export async function rentExemptMinimumFor(
  connection: Pick<Connection, "getMinimumBalanceForRentExemption">,
  layout: SolanaAccountLayoutName | AccountLayoutSpec
): Promise<bigint> {
  return getRentExemptMinimum(connection, accountSizeFor(layout));
}

// ── Pre-submission safety rails ─────────────────────────────────────────────

/** What a caller intends to move out of (or into) the payer's wallet. */
export interface PayerFundingRequest {
  /** The account paying rent and fees. */
  payer: PublicKey;
  /** Account being created; named in every diagnostic. */
  account: string;
  /** Rent-exempt minimum for the account being created, from the cluster. */
  rentLamports: bigint;
  /** Lamports of native SOL being locked, if any. */
  amountLamports?: bigint;
  /** Lamports of safety deposit, if any. */
  safetyDepositLamports?: bigint;
  /** Number of signatures the transaction will carry. */
  signatureCount?: number;
  /** Observed payer balance. */
  balanceLamports: bigint;
}

/**
 * Verify the payer can cover the account's rent, the locked funds, and the
 * transaction fee.
 *
 * This must run *before* submission. Without it an underfunded payer gets an
 * opaque runtime error whose only hint is a lamport count; with it the
 * operator gets the shortfall, the account being created, and the exact
 * amount to fund.
 *
 * Throws `InsufficientRentError`.
 */
export function assertPayerCanFund(request: PayerFundingRequest): {
  required: bigint;
  available: bigint;
  shortfall: bigint;
} {
  const amount = request.amountLamports ?? 0n;
  const deposit = request.safetyDepositLamports ?? 0n;
  const fee = transactionFee(request.signatureCount ?? 1);
  const required = request.rentLamports + amount + deposit + fee;
  const available = request.balanceLamports;

  if (available < required) {
    const shortfall = required - available;
    throw new InsufficientRentError(
      `Payer ${request.payer.toBase58()} cannot fund creation of ${request.account}: ` +
      `needs ${required} lamports (rent-exempt ${request.rentLamports} + ` +
      `amount ${amount} + safety deposit ${deposit} + fee ${fee}) ` +
      `but holds ${available}. Short by ${shortfall} lamports ` +
      `(${(Number(shortfall) / 1e9).toFixed(9)} SOL). ` +
      `Fund ${request.payer.toBase58()} with at least ${shortfall} more lamports, ` +
      `or reduce the amount being locked.`,
      {
        payer: request.payer.toBase58(),
        account: request.account,
        required: required.toString(),
        available: available.toString(),
        shortfall: shortfall.toString(),
        rentLamports: request.rentLamports.toString(),
        amountLamports: amount.toString(),
        safetyDepositLamports: deposit.toString(),
        feeLamports: fee.toString(),
      }
    );
  }

  return { required, available, shortfall: 0n };
}

/** Why an account cannot be initialised in its current state. */
export type UninitialisedState =
  | { kind: "absent" }
  | { kind: "initialised"; lamports: bigint; dataLength: number; owner: string }
  | { kind: "prefunded"; lamports: bigint; owner: string }
  | { kind: "foreign"; lamports: bigint; dataLength: number; owner: string };

/**
 * Classify an account that is about to be initialised.
 *
 * The interesting case is `prefunded`: a PDA address that already holds
 * lamports but no data. `getAccountInfo` returns `null` for it only when the
 * balance is zero, so a stray transfer to a future order address looks
 * identical to "does not exist" — and the program's `init` then reverts at
 * runtime with `already in use`. This classifies it explicitly instead.
 */
export function classifyUninitialisedAccount(
  accountInfo: AccountInfo<Buffer> | null,
  expectedOwner?: PublicKey
): UninitialisedState {
  if (accountInfo === null) return { kind: "absent" };
  const lamports = BigInt(accountInfo.lamports);
  const owner = accountInfo.owner.toBase58();
  const dataLength = accountInfo.data.length;

  // Zero data must be tested *before* the owner. An address that merely holds
  // lamports is created by the System Program, so checking the owner first
  // would report a pre-funded PDA as `foreign` and send the operator looking
  // for a program-id or seed problem that does not exist. The remedy for a
  // pre-funded address is to drain it, so that is what must be reported.
  if (dataLength === 0) {
    return { kind: "prefunded", lamports, owner };
  }
  if (expectedOwner && !accountInfo.owner.equals(expectedOwner)) {
    return { kind: "foreign", lamports, dataLength, owner };
  }
  return { kind: "initialised", lamports, dataLength, owner };
}

/**
 * Assert that an account is safe to initialise.
 *
 * - `initialised` → `AccountAlreadyInitializedError`. Re-initialising an
 *   Anchor account is either a revert or, under `init_if_needed`, an
 *   overwrite of live state. Both are failures; neither is a warning.
 * - `prefunded` → `UnexpectedAccountBalanceError`, naming the lamports found
 *   and the account, so an operator can drain the address and retry.
 * - `foreign` → `UnexpectedAccountOwnerError`, naming both owners.
 * - `absent` → passes.
 *
 * This function is the documented answer to "what if the target address already
 * holds lamports?". The behaviour is **deterministic and fail-closed**: a
 * pre-funded PDA is rejected outright, never topped up, because the program's
 * `init` cannot adopt an existing account anyway — Solana's `create_account`
 * requires a zero-lamport, unallocated account, so the transaction would revert
 * with `already in use` and burn the fee. Failing client-side names the cause
 * and the remedy (drain the address, then retry) instead of hiding it behind a
 * runtime error.
 */
export function assertAccountIsUninitialised(
  state: UninitialisedState,
  options: { account: string; programId?: string }
): void {
  const { account } = options;

  switch (state.kind) {
    case "absent":
      return;

    case "initialised":
      throw new AccountAlreadyInitializedError(
        `${account} already exists and is initialised ` +
        `(${state.dataLength} bytes, owner ${state.owner}, ${state.lamports} lamports). ` +
        `Refusing to re-initialise it. ` +
        (options.programId
          ? `If this is a different order, check that the hashlock used to derive the address differs. ` +
            `Program: ${options.programId}.`
          : "Check that the address was derived from a different hashlock."),
        { account, dataLength: state.dataLength, lamports: state.lamports.toString(), owner: state.owner }
      );

    case "prefunded":
      throw new UnexpectedAccountBalanceError(
        `${account} already holds ${state.lamports} lamports but no account data ` +
        `(owner ${state.owner}). This is a pre-funded address, so the program's ` +
        `init will fail with "already in use" once the transaction is submitted. ` +
        `Reclaim the lamports from ${account} and retry.`,
        { account, lamports: state.lamports.toString(), owner: state.owner }
      );

    case "foreign":
      throw new UnexpectedAccountOwnerError(
        `${account} is owned by ${state.owner}` +
        (options.programId ? `, not the expected program ${options.programId}` : "") +
        `, and holds ${state.dataLength} bytes / ${state.lamports} lamports. ` +
        `An account at this address cannot be initialised by the HTLC program. ` +
        `Check the program id and the PDA seeds.`,
        {
          account,
          owner: state.owner,
          dataLength: state.dataLength,
          lamports: state.lamports.toString(),
          expectedOwner: options.programId,
        }
      );
  }
}

// ── Post-initialisation verification ────────────────────────────────────────

/** Result of a successful post-initialisation check. */
export interface VerifiedAccount {
  address: string;
  owner: string;
  dataLength: number;
  lamports: bigint;
  rentExemptMinimum: bigint;
}

/**
 * Verify a freshly created account is exactly what the layout requires.
 *
 * Runs after confirmation, because a confirmed transaction is not proof of a
 * correct account: a program can exit successfully having written a truncated
 * account, and an account can fall below the rent-exempt minimum later. Four
 * invariants are checked, each with its own error variant so a caller can
 * branch on which one failed:
 *
 *   1. the account exists → `AccountInitVerificationError`
 *   2. it is owned by the expected program → `UnexpectedAccountOwnerError`
 *   3. its data length matches the layout → `InvalidAccountSizeError`
 *   4. its balance is at or above the rent-exempt minimum →
 *      `AccountNotRentExemptError`
 */
export async function verifyInitialisedAccount(
  connection: Pick<Connection, "getAccountInfo" | "getMinimumBalanceForRentExemption">,
  address: PublicKey,
  layout: SolanaAccountLayoutName | AccountLayoutSpec,
  options: {
    /** Owner the account must have; normally the HTLC program id. */
    expectedOwner: PublicKey;
    /** Commitment to read at. */
    commitment?: Commitment;
    /** Extra lamports the account is expected to hold beyond rent. */
    expectedExtraLamports?: bigint;
  }
): Promise<VerifiedAccount> {
  const spec =
    typeof layout === "string" ? SOLANA_ANCHOR_ACCOUNT_LAYOUTS[layout] : layout;
  const expectedSize = accountSizeFor(spec);
  const account = address.toBase58();

  const accountInfo = await connection.getAccountInfo(
    address,
    options.commitment ?? "confirmed"
  );

  if (accountInfo === null) {
    throw new AccountInitVerificationError(
      `${spec.label} ${account} was not found after the transaction confirmed. ` +
      `Expected the program to have created a ${expectedSize}-byte account owned by ` +
      `${options.expectedOwner.toBase58()}. Either the program did not run this ` +
      `instruction, or the read has not yet caught up — retry with a higher commitment.`,
      { account, expectedOwner: options.expectedOwner.toBase58(), expectedSize }
    );
  }

  const actualOwner = accountInfo.owner.toBase58();
  if (!accountInfo.owner.equals(options.expectedOwner)) {
    throw new UnexpectedAccountOwnerError(
      `${spec.label} ${account} is owned by ${actualOwner}, expected ` +
      `${options.expectedOwner.toBase58()}. The address is not an account of the ` +
      `HTLC program — check SOLANA_HTLC_PROGRAM and the PDA seeds ` +
      `(${spec.label}: [${JSON.stringify(spec.seedLabel)}, ...]).`,
      {
        account,
        actualOwner,
        expectedOwner: options.expectedOwner.toBase58(),
      }
    );
  }

  const dataLength = accountInfo.data.length;
  if (dataLength !== expectedSize) {
    throw new InvalidAccountSizeError(
      `${spec.label} account size mismatch on ${account}: expected exactly ` +
      `${expectedSize} bytes (${ANCHOR_DISCRIMINATOR_SIZE} discriminator + ` +
      `${fieldsSizeFor(spec)} field bytes), found ${dataLength}. ` +
      (dataLength < expectedSize
        ? `The program allocated ${expectedSize - dataLength} bytes too few, so the ` +
          `trailing fields cannot be read. This is an on-chain \`space = ...\` bug.`
        : `The deployed program has a larger layout than this SDK's IDL; upgrade ` +
          `@wafflefinance/sdk before reading this account.`) +
      ` Account: ${account}.`,
      { account, expectedSize, actualSize: dataLength, owner: actualOwner }
    );
  }

  const rentExemptMinimum = await getRentExemptMinimum(connection, expectedSize);
  const lamports = BigInt(accountInfo.lamports);
  const required = rentExemptMinimum + (options.expectedExtraLamports ?? 0n);
  if (lamports < required) {
    throw new AccountNotRentExemptError(
      `${spec.label} ${account} holds ${lamports} lamports, below the required ` +
      `${required} (rent-exempt minimum ${rentExemptMinimum} for ${expectedSize} bytes` +
      (options.expectedExtraLamports
        ? ` + expected funds ${options.expectedExtraLamports}`
        : "") +
      `). The account is not rent-exempt and will be purged by the runtime. ` +
      `The payer did not transfer enough.`,
      {
        account,
        lamports: lamports.toString(),
        rentExemptMinimum: rentExemptMinimum.toString(),
        required: required.toString(),
        expectedSize,
      }
    );
  }

  return {
    address: account,
    owner: actualOwner,
    dataLength,
    lamports,
    rentExemptMinimum,
  };
}

// ── Simulation ──────────────────────────────────────────────────────────────

/**
 * A transaction `simulateTransaction` accepts: either the legacy
 * `Transaction` or a versioned one.
 */
export type SimulatableTransaction =
  | Parameters<Connection["simulateTransaction"]>[0]
  | Parameters<Connection["simulateTransaction"]>[1];

/** The subset of `Connection` this module needs to simulate. */
export interface SimulationCapableConnection {
  simulateTransaction(transaction: SimulatableTransaction): Promise<unknown>;
}

function formatSimulationErr(err: unknown): string {
  if (err === null || err === undefined) return "unknown error";
  if (typeof err === "object") {
    const e = err as { InstructionError?: unknown; err?: unknown };
    if (e.InstructionError !== undefined) {
      return `InstructionError(${JSON.stringify(e.InstructionError)})`;
    }
    if (e.err !== undefined) return JSON.stringify(e.err);
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

/**
 * Simulate a transaction and surface the program logs on failure.
 *
 * `sendRawTransaction` runs the same simulation internally and throws on
 * failure, but the resulting error carries no logs — the "Custom program
 * error: 0x1" that identifies which of the program's error codes fired. This
 * simulates explicitly first so the logs reach the caller and the operator,
 * and never swallows a simulation failure.
 *
 * Throws `SimulationFailedError` with the logs attached when the simulation
 * reports an error or the RPC call to simulate fails.
 */
export async function simulateTransactionOrThrow(
  connection: SimulationCapableConnection,
  transaction: SimulatableTransaction,
  options: { account: string }
): Promise<string[]> {
  let raw: unknown;
  try {
    raw = await connection.simulateTransaction(transaction);
  } catch (err) {
    // An RPC-level failure is not a program failure, but it must not be
    // mistaken for success either — rethrow with the RPC message attached.
    throw new SimulationFailedError(
      `Failed to simulate the transaction for ${options.account}: ` +
      `${err instanceof Error ? err.message : String(err)}. ` +
      `The transaction was not submitted.`,
      { account: options.account, rpcError: err instanceof Error ? err.message : String(err) }
    );
  }

  // `simulateTransaction` has two response shapes: the legacy `Transaction`
  // overload resolves to the response directly, the versioned one wraps it in
  // `{ context, value }`. Normalise before reading.
  const value =
    raw !== null && typeof raw === "object" && "value" in (raw as Record<string, unknown>)
      ? ((raw as { value: { err: unknown; logs: string[] | null } }).value)
      : (raw as { err: unknown; logs: string[] | null });

  const logs = value?.logs ?? [];
  if (value?.err) {
    throw new SimulationFailedError(
      `Simulation failed for ${options.account}: ${formatSimulationErr(value.err)}` +
      (logs.length > 0
        ? `\nProgram logs:\n  ${logs.join("\n  ")}`
        : "\nProgram logs: (none returned)"),
      { account: options.account, simulationError: formatSimulationErr(value.err) },
      logs
    );
  }

  return logs;
}

// ── Reference rent table (documentation + tests only) ───────────────────────

/**
 * Mainnet-beta rent parameters, for tests and documentation.
 *
 * Production code must call `getRentExemptMinimum`. These exist so a test can
 * assert that a mocked cluster response is *plausible* rather than an
 * arbitrary number.
 */
export const MAINNET_RENT = {
  /** lamports per byte-year. */
  lamportsPerByteYear: 3480n,
  /** Rent-exempt threshold, 2.0 years. */
  exemptionThresholdYears: 2,
  /** Exemption lamports for a 0-byte account (the 128-byte overhead alone). */
  zeroByteExemption: 890_880n,
} as const;

/**
 * Reference rent-exempt minimum for `size` bytes under {@link MAINNET_RENT}.
 * Documentation and test-oracle only.
 *
 * This reproduces the runtime's own formula,
 * `(size + ACCOUNT_STORAGE_OVERHEAD) * lamports_per_byte_year * threshold`, in
 * two terms. Written the other way round — `size * rate + zeroByteExemption` —
 * it is arithmetically identical, which is why the totals below are exact and
 * not rounded.
 */
export function referenceRentExemptMinimum(size: number): bigint {
  if (!Number.isInteger(size) || size < 0) {
    throw new RangeError(
      `referenceRentExemptMinimum: size must be a non-negative integer, got ${size}`
    );
  }
  return (
    MAINNET_RENT.zeroByteExemption +
    BigInt(size) * MAINNET_RENT.lamportsPerByteYear * BigInt(MAINNET_RENT.exemptionThresholdYears)
  );
}

/** Anchor account names, for callers that need the discriminator source. */
export const ANCHOR_ACCOUNT_NAMES = {
  htlcOrder: SOLANA_ANCHOR_ACCOUNT_LAYOUTS.htlcOrder.anchorAccountName,
  orderRegistry: SOLANA_ANCHOR_ACCOUNT_LAYOUTS.orderRegistry.anchorAccountName,
} as const;
