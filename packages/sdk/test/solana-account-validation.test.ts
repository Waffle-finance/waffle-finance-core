/**
 * Tests for Solana program account metadata validation (#715).
 *
 * Validates:
 *  - validateSolanaAddress rejects invalid addresses and accepts valid ones
 *  - validateOrderPda throws on PDA mismatch
 *  - validateOrderAccountOnChain detects wrong_owner, discriminator_mismatch,
 *    already_claimed, already_refunded, hashlock_mismatch, account_not_found,
 *    idl_version_too_new, insufficient_lamports, and stale_account
 *  - validateCreateOrderParams validates all address fields
 *  - validateClaimOrderParams delegates to on-chain check
 *  - validateRefundOrderParams delegates to on-chain check
 *  - AccountValidationError carries correct code and context
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Connection, PublicKey } from "@solana/web3.js";

import {
  validateSolanaAddress,
  validateOrderPda,
  validateOrderAccountOnChain,
  validateCreateOrderParams,
  validateClaimOrderParams,
  validateRefundOrderParams,
  AccountValidationError,
} from "../src/solana/account-validation.js";

import {
  HTLC_ORDER_DISCRIMINATOR,
  HTLC_ORDER_ACCOUNT_SIZE,
  IDL_VERSION,
  FIELD_OFFSET,
  ORDER_SEED,
  OrderStatus,
} from "../src/solana/idl/htlc.js";

import { NATIVE_SOL_MINT } from "../src/solana/index.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const PROGRAM_ID_STR = "11111111111111111111111111111111";
const PROGRAM_PK = new PublicKey(PROGRAM_ID_STR);
const HASHLOCK_BYTES = Buffer.from("ab".repeat(32), "hex");

function writeU64LE(buf: Buffer, value: bigint, offset: number): void {
  const lo = Number(value & BigInt(0xffffffff));
  const hi = Number(value >> BigInt(32));
  buf.writeUInt32LE(lo, offset);
  buf.writeUInt32LE(hi, offset + 4);
}

/** Build a valid account data buffer that passes all checks. */
function buildValidAccountData(overrides: {
  discriminator?: Buffer;
  version?: number;
  status?: number;
  hashlock?: Buffer;
  lamports?: number;
  truncate?: boolean;
} = {}): Buffer {
  const buf = Buffer.alloc(HTLC_ORDER_ACCOUNT_SIZE, 0);

  const disc = overrides.discriminator ?? HTLC_ORDER_DISCRIMINATOR;
  disc.copy(buf, 0);

  const f = buf.subarray(8);
  f.writeUInt8(overrides.version ?? IDL_VERSION, FIELD_OFFSET.version);

  const senderPk = new PublicKey("11111111111111111111111111111111");
  const beneficiaryPk = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf8Ny8suSzwAh");
  const refundPk = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bJ9");
  const mintPk = new PublicKey(NATIVE_SOL_MINT);

  senderPk.toBuffer().copy(f, FIELD_OFFSET.sender);
  beneficiaryPk.toBuffer().copy(f, FIELD_OFFSET.beneficiary);
  refundPk.toBuffer().copy(f, FIELD_OFFSET.refundAddress);
  mintPk.toBuffer().copy(f, FIELD_OFFSET.mint);

  writeU64LE(f, BigInt(1_000_000_000), FIELD_OFFSET.amount);
  writeU64LE(f, BigInt(1_000_000), FIELD_OFFSET.safetyDeposit);

  const hashlock = overrides.hashlock ?? HASHLOCK_BYTES;
  hashlock.copy(f, FIELD_OFFSET.hashlock);

  writeU64LE(f, BigInt(1_700_000_000), FIELD_OFFSET.timelock);
  f.writeUInt8(overrides.status ?? OrderStatus.Active, FIELD_OFFSET.status);
  f.writeUInt8(0, FIELD_OFFSET.preimage); // None

  if (overrides.truncate) {
    return buf.subarray(0, 50);
  }
  return buf;
}

function makeConnectionWith(
  accountInfo: Partial<{
    data: Buffer;
    owner: PublicKey;
    lamports: number;
    executable: boolean;
    rentEpoch: number;
  }> | null = {}
) {
  const getAccountInfoMock = vi.fn().mockResolvedValue(
    accountInfo === null
      ? null
      : {
          data: accountInfo.data ?? buildValidAccountData(),
          owner: accountInfo.owner ?? PROGRAM_PK,
          lamports: accountInfo.lamports ?? 2_000_000,
          executable: accountInfo.executable ?? false,
          rentEpoch: accountInfo.rentEpoch ?? 0,
        }
  );
  return {
    getAccountInfo: getAccountInfoMock,
  } as unknown as Connection;
}

// ── Derive a real PDA for tests ───────────────────────────────────────────────

const [VALID_ORDER_PDA] = PublicKey.findProgramAddressSync(
  [ORDER_SEED, HASHLOCK_BYTES],
  PROGRAM_PK
);
const VALID_ORDER_ID = VALID_ORDER_PDA.toBase58();

// ── validateSolanaAddress ─────────────────────────────────────────────────────

describe("validateSolanaAddress", () => {
  it("accepts a valid system program address", () => {
    const pk = validateSolanaAddress("11111111111111111111111111111111");
    expect(pk.toBase58()).toBe("11111111111111111111111111111111");
  });

  it("accepts a realistic program address", () => {
    const pk = validateSolanaAddress("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
    expect(pk.toBase58()).toBe("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
  });

  it("throws AccountValidationError with code invalid_address for garbage input", () => {
    expect(() => validateSolanaAddress("not-a-valid-key", "testField")).toThrow(
      AccountValidationError
    );
    try {
      validateSolanaAddress("not-a-valid-key", "myLabel");
    } catch (e) {
      const err = e as AccountValidationError;
      expect(err.code).toBe("invalid_address");
      expect(err.message).toContain("myLabel");
    }
  });

  it("throws for an empty string", () => {
    expect(() => validateSolanaAddress("")).toThrow(AccountValidationError);
  });
});

// ── validateOrderPda ──────────────────────────────────────────────────────────

describe("validateOrderPda", () => {
  it("passes when orderId matches the derived PDA", () => {
    expect(() =>
      validateOrderPda(VALID_ORDER_ID, HASHLOCK_BYTES, PROGRAM_PK)
    ).not.toThrow();
  });

  it("throws pda_mismatch when orderId does not match derived PDA", () => {
    try {
      validateOrderPda("11111111111111111111111111111111", HASHLOCK_BYTES, PROGRAM_PK);
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(AccountValidationError);
      expect((e as AccountValidationError).code).toBe("pda_mismatch");
    }
  });

  it("throws pda_mismatch when hashlockBytes are different", () => {
    const differentHashlock = Buffer.from("cc".repeat(32), "hex");
    expect(() =>
      validateOrderPda(VALID_ORDER_ID, differentHashlock, PROGRAM_PK)
    ).toThrow(AccountValidationError);
  });
});

// ── validateOrderAccountOnChain ────────────────────────────────────────────────

describe("validateOrderAccountOnChain — account_not_found", () => {
  it("returns error when account does not exist", async () => {
    const conn = makeConnectionWith(null);
    const result = await validateOrderAccountOnChain(
      conn,
      VALID_ORDER_ID,
      PROGRAM_PK,
      { operation: "read" }
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0].code).toBe("account_not_found");
  });
});

describe("validateOrderAccountOnChain — wrong_owner", () => {
  it("detects wrong program ownership", async () => {
    const wrongOwner = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf8Ny8suSzwAh");
    const conn = makeConnectionWith({ owner: wrongOwner });
    const result = await validateOrderAccountOnChain(
      conn,
      VALID_ORDER_ID,
      PROGRAM_PK,
      { operation: "read" }
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === "wrong_owner")).toBe(true);
    const err = result.errors.find((e) => e.code === "wrong_owner")!;
    expect(err.message).toContain(wrongOwner.toBase58());
    expect(err.context?.expectedOwner).toBe(PROGRAM_PK.toBase58());
  });
});

describe("validateOrderAccountOnChain — discriminator_mismatch", () => {
  it("detects wrong Anchor discriminator", async () => {
    const badDisc = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    const data = buildValidAccountData({ discriminator: badDisc });
    const conn = makeConnectionWith({ data });
    const result = await validateOrderAccountOnChain(
      conn,
      VALID_ORDER_ID,
      PROGRAM_PK,
      { operation: "read" }
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === "discriminator_mismatch")).toBe(true);
  });
});

describe("validateOrderAccountOnChain — idl_version_too_new", () => {
  it("detects on-chain version newer than SDK IDL_VERSION", async () => {
    const data = buildValidAccountData({ version: IDL_VERSION + 1 });
    const conn = makeConnectionWith({ data });
    const result = await validateOrderAccountOnChain(
      conn,
      VALID_ORDER_ID,
      PROGRAM_PK,
      { operation: "read" }
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === "idl_version_too_new")).toBe(true);
  });
});

describe("validateOrderAccountOnChain — hashlock_mismatch", () => {
  it("detects on-chain hashlock mismatch", async () => {
    const differentHashlock = Buffer.from("cc".repeat(32), "hex");
    const conn = makeConnectionWith(); // data uses HASHLOCK_BYTES
    const result = await validateOrderAccountOnChain(
      conn,
      VALID_ORDER_ID,
      PROGRAM_PK,
      { operation: "read", hashlockBytes: differentHashlock }
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === "hashlock_mismatch")).toBe(true);
  });

  it("passes when hashlockBytes match the on-chain value", async () => {
    const conn = makeConnectionWith(); // data uses HASHLOCK_BYTES
    const result = await validateOrderAccountOnChain(
      conn,
      VALID_ORDER_ID,
      PROGRAM_PK,
      { operation: "read", hashlockBytes: HASHLOCK_BYTES }
    );
    // No hashlock error.
    expect(result.errors.every((e) => e.code !== "hashlock_mismatch")).toBe(true);
  });
});

describe("validateOrderAccountOnChain — claim operation status checks", () => {
  it("returns already_claimed error when status=Claimed on claim operation", async () => {
    const data = buildValidAccountData({ status: OrderStatus.Claimed });
    const conn = makeConnectionWith({ data });
    const result = await validateOrderAccountOnChain(
      conn,
      VALID_ORDER_ID,
      PROGRAM_PK,
      { operation: "claim" }
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === "already_claimed")).toBe(true);
  });

  it("returns already_refunded error when status=Refunded on claim operation", async () => {
    const data = buildValidAccountData({ status: OrderStatus.Refunded });
    const conn = makeConnectionWith({ data });
    const result = await validateOrderAccountOnChain(
      conn,
      VALID_ORDER_ID,
      PROGRAM_PK,
      { operation: "claim" }
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === "already_refunded")).toBe(true);
  });

  it("passes validation for status=Active on claim operation", async () => {
    const conn = makeConnectionWith(); // Active by default
    const result = await validateOrderAccountOnChain(
      conn,
      VALID_ORDER_ID,
      PROGRAM_PK,
      { operation: "claim" }
    );
    expect(result.valid).toBe(true);
  });
});

describe("validateOrderAccountOnChain — refund operation status checks", () => {
  it("returns already_refunded error when status=Refunded on refund operation", async () => {
    const data = buildValidAccountData({ status: OrderStatus.Refunded });
    const conn = makeConnectionWith({ data });
    const result = await validateOrderAccountOnChain(
      conn,
      VALID_ORDER_ID,
      PROGRAM_PK,
      { operation: "refund" }
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === "already_refunded")).toBe(true);
  });

  it("returns already_claimed error when status=Claimed on refund operation", async () => {
    const data = buildValidAccountData({ status: OrderStatus.Claimed });
    const conn = makeConnectionWith({ data });
    const result = await validateOrderAccountOnChain(
      conn,
      VALID_ORDER_ID,
      PROGRAM_PK,
      { operation: "refund" }
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === "already_claimed")).toBe(true);
  });

  it("passes for status=Active on refund operation", async () => {
    const conn = makeConnectionWith();
    const result = await validateOrderAccountOnChain(
      conn,
      VALID_ORDER_ID,
      PROGRAM_PK,
      { operation: "refund" }
    );
    expect(result.valid).toBe(true);
  });
});

describe("validateOrderAccountOnChain — insufficient_lamports", () => {
  it("reports error when lamports are below minimum", async () => {
    const conn = makeConnectionWith({ lamports: 1_000 });
    const result = await validateOrderAccountOnChain(
      conn,
      VALID_ORDER_ID,
      PROGRAM_PK,
      { operation: "claim", minLamports: 1_000_000n }
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === "insufficient_lamports")).toBe(true);
  });

  it("passes when lamports meet minimum", async () => {
    const conn = makeConnectionWith({ lamports: 5_000_000 });
    const result = await validateOrderAccountOnChain(
      conn,
      VALID_ORDER_ID,
      PROGRAM_PK,
      { operation: "claim", minLamports: 1_000_000n }
    );
    expect(result.errors.every((e) => e.code !== "insufficient_lamports")).toBe(true);
  });
});

describe("validateOrderAccountOnChain — stale_account", () => {
  it("detects truncated account data", async () => {
    const data = buildValidAccountData({ truncate: true });
    const conn = makeConnectionWith({ data });
    const result = await validateOrderAccountOnChain(
      conn,
      VALID_ORDER_ID,
      PROGRAM_PK,
      { operation: "read" }
    );
    expect(result.valid).toBe(false);
    expect(
      result.errors.some(
        (e) => e.code === "stale_account" || e.code === "discriminator_mismatch"
      )
    ).toBe(true);
  });
});

describe("validateOrderAccountOnChain — invalid orderId", () => {
  it("returns invalid_address error for a non-base58 orderId", async () => {
    const conn = makeConnectionWith();
    const result = await validateOrderAccountOnChain(
      conn,
      "not-a-valid-solana-address!!!",
      PROGRAM_PK,
      { operation: "read" }
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0].code).toBe("invalid_address");
  });
});

// ── validateCreateOrderParams ─────────────────────────────────────────────────

describe("validateCreateOrderParams", () => {
  it("passes for valid addresses", async () => {
    const conn = makeConnectionWith(null); // no existing PDA
    const result = await validateCreateOrderParams(conn, PROGRAM_PK, {
      sender:        "11111111111111111111111111111111",
      beneficiary:   "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf8Ny8suSzwAh",
      refundAddress: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bJ9",
      mint:          NATIVE_SOL_MINT,
      hashlockBytes: HASHLOCK_BYTES,
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("fails for invalid beneficiary address", async () => {
    const conn = makeConnectionWith(null);
    const result = await validateCreateOrderParams(conn, PROGRAM_PK, {
      sender:        "11111111111111111111111111111111",
      beneficiary:   "INVALID_ADDRESS",
      refundAddress: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bJ9",
      mint:          NATIVE_SOL_MINT,
      hashlockBytes: HASHLOCK_BYTES,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === "invalid_address")).toBe(true);
  });

  it("fails when expectedOrderId does not match derived PDA", async () => {
    const conn = makeConnectionWith(null);
    const result = await validateCreateOrderParams(conn, PROGRAM_PK, {
      sender:          "11111111111111111111111111111111",
      beneficiary:     "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf8Ny8suSzwAh",
      refundAddress:   "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bJ9",
      mint:            NATIVE_SOL_MINT,
      hashlockBytes:   HASHLOCK_BYTES,
      expectedOrderId: "11111111111111111111111111111111", // wrong PDA
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === "pda_mismatch")).toBe(true);
  });

  it("includes a warning when the PDA already exists", async () => {
    // Connection returns an existing account at the PDA.
    const conn = makeConnectionWith({});
    const result = await validateCreateOrderParams(conn, PROGRAM_PK, {
      sender:        "11111111111111111111111111111111",
      beneficiary:   "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf8Ny8suSzwAh",
      refundAddress: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bJ9",
      mint:          NATIVE_SOL_MINT,
      hashlockBytes: HASHLOCK_BYTES,
    });
    // No hard error, but a warning about the existing account.
    expect(result.warnings.some((w) => w.includes("already exists"))).toBe(true);
  });
});

// ── validateClaimOrderParams / validateRefundOrderParams ──────────────────────

describe("validateClaimOrderParams", () => {
  it("returns valid for an Active order", async () => {
    const conn = makeConnectionWith();
    const result = await validateClaimOrderParams(conn, PROGRAM_PK, { orderId: VALID_ORDER_ID });
    expect(result.valid).toBe(true);
  });

  it("returns already_claimed for a Claimed order", async () => {
    const data = buildValidAccountData({ status: OrderStatus.Claimed });
    const conn = makeConnectionWith({ data });
    const result = await validateClaimOrderParams(conn, PROGRAM_PK, { orderId: VALID_ORDER_ID });
    expect(result.valid).toBe(false);
    expect(result.errors[0].code).toBe("already_claimed");
  });
});

describe("validateRefundOrderParams", () => {
  it("returns valid for an Active order", async () => {
    const conn = makeConnectionWith();
    const result = await validateRefundOrderParams(conn, PROGRAM_PK, { orderId: VALID_ORDER_ID });
    expect(result.valid).toBe(true);
  });

  it("returns already_refunded for a Refunded order", async () => {
    const data = buildValidAccountData({ status: OrderStatus.Refunded });
    const conn = makeConnectionWith({ data });
    const result = await validateRefundOrderParams(conn, PROGRAM_PK, { orderId: VALID_ORDER_ID });
    expect(result.valid).toBe(false);
    expect(result.errors[0].code).toBe("already_refunded");
  });
});

// ── AccountValidationError ────────────────────────────────────────────────────

describe("AccountValidationError", () => {
  it("has the correct name and code", () => {
    const err = new AccountValidationError("pda_mismatch", "test message", { orderId: "abc" });
    expect(err.name).toBe("AccountValidationError");
    expect(err.code).toBe("pda_mismatch");
    expect(err.message).toBe("test message");
    expect(err.context?.orderId).toBe("abc");
  });

  it("is an instance of Error", () => {
    const err = new AccountValidationError("wrong_owner", "bad owner");
    expect(err).toBeInstanceOf(Error);
  });
});
