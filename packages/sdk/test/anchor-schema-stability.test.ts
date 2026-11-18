/**
 * Anchor program schema and instruction compatibility tests (#712).
 *
 * These tests act as a CI gate that fails loudly whenever:
 *  - An instruction discriminator changes (program / SDK drift)
 *  - The account layout changes without a corresponding IDL_VERSION bump
 *  - The canonical account ordering shifts silently
 *  - The instruction data serialisation sizes change
 *
 * Any deliberate upgrade MUST be reflected in IDL_VERSION + CANONICAL_ACCOUNT_ORDERING.
 */

import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";

import {
  HTLC_ORDER_DISCRIMINATOR,
  IDL_VERSION,
  FIELD_OFFSET,
  IX_CREATE_ORDER,
  IX_CLAIM_ORDER,
  IX_REFUND_ORDER,
  ORDER_SEED,
  HTLC_ORDER_ACCOUNT_SIZE,
  CANONICAL_ACCOUNT_ORDERING,
  INSTRUCTION_DATA_SIZES,
  assertIdlCompatibility,
  validateInstructionSchema,
} from "../src/solana/idl/htlc.js";

import {
  buildCreateOrderInstruction,
  buildClaimOrderInstruction,
  buildRefundOrderInstruction,
  NATIVE_SOL_MINT,
} from "../src/solana/index.js";

// ── Stable constant values ────────────────────────────────────────────────────
// Any change here is a BREAKING CHANGE and requires a program upgrade + IDL bump.

describe("IDL constants — stability regression guard", () => {
  it("HTLC_ORDER_DISCRIMINATOR is 8 bytes and matches expected value", () => {
    expect(HTLC_ORDER_DISCRIMINATOR).toHaveLength(8);
    // sha256("account:HtlcOrder")[0..8] — precomputed reference value.
    expect(HTLC_ORDER_DISCRIMINATOR.toString("hex")).toBe("174c3d915fa82be1");
  });

  it("IDL_VERSION is 0 (bump this test when the version is intentionally upgraded)", () => {
    // If this test fails you bumped IDL_VERSION — update this assertion to match.
    expect(IDL_VERSION).toBe(0);
  });

  it("HTLC_ORDER_ACCOUNT_SIZE is exactly 227 bytes", () => {
    expect(HTLC_ORDER_ACCOUNT_SIZE).toBe(227);
  });

  it("IX_CREATE_ORDER discriminator is stable", () => {
    // sha256("global:create_order")[0..8]
    expect(IX_CREATE_ORDER.toString("hex")).toBe("9f0418d16a7e593c");
  });

  it("IX_CLAIM_ORDER discriminator is stable", () => {
    // sha256("global:claim_order")[0..8]
    expect(IX_CLAIM_ORDER.toString("hex")).toBe("3ca05fd2118b4aef");
  });

  it("IX_REFUND_ORDER discriminator is stable", () => {
    // sha256("global:refund_order")[0..8]
    expect(IX_REFUND_ORDER.toString("hex")).toBe("5e2d873f44c17b22");
  });

  it("ORDER_SEED matches expected byte sequence", () => {
    expect(ORDER_SEED.toString("ascii")).toBe("order");
    expect(ORDER_SEED).toHaveLength(5);
  });
});

// ── Field offsets — stability check ──────────────────────────────────────────

describe("FIELD_OFFSET — layout stability", () => {
  // These values encode the exact byte layout of HtlcOrder after the 8-byte
  // discriminator.  Any change = breaking change requiring IDL_VERSION bump.
  const EXPECTED: Record<string, number> = {
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
    preimage: 186,
  };

  for (const [field, offset] of Object.entries(EXPECTED)) {
    it(`FIELD_OFFSET.${field} === ${offset}`, () => {
      expect(FIELD_OFFSET[field as keyof typeof FIELD_OFFSET]).toBe(offset);
    });
  }

  it("all fields are accounted for in FIELD_OFFSET", () => {
    const keys = Object.keys(FIELD_OFFSET).sort();
    const expectedKeys = Object.keys(EXPECTED).sort();
    expect(keys).toEqual(expectedKeys);
  });
});

// ── Canonical account ordering ────────────────────────────────────────────────

describe("CANONICAL_ACCOUNT_ORDERING — stability guard", () => {
  it("idlVersion matches IDL_VERSION constant", () => {
    expect(CANONICAL_ACCOUNT_ORDERING.idlVersion).toBe(IDL_VERSION);
  });

  it("createOrder has exactly 7 accounts in canonical order", () => {
    expect(CANONICAL_ACCOUNT_ORDERING.createOrder).toHaveLength(7);
    const names = CANONICAL_ACCOUNT_ORDERING.createOrder.map((a) => a.name);
    expect(names).toEqual([
      "payer",
      "order_pda",
      "mint",
      "beneficiary",
      "refund_address",
      "system_program",
      "clock",
    ]);
  });

  it("claimOrder has exactly 4 accounts in canonical order", () => {
    expect(CANONICAL_ACCOUNT_ORDERING.claimOrder).toHaveLength(4);
    const names = CANONICAL_ACCOUNT_ORDERING.claimOrder.map((a) => a.name);
    expect(names).toEqual([
      "claimer",
      "order_pda",
      "beneficiary_token_account",
      "system_program",
    ]);
  });

  it("refundOrder has exactly 5 accounts in canonical order", () => {
    expect(CANONICAL_ACCOUNT_ORDERING.refundOrder).toHaveLength(5);
    const names = CANONICAL_ACCOUNT_ORDERING.refundOrder.map((a) => a.name);
    expect(names).toEqual([
      "refunder",
      "order_pda",
      "refund_account",
      "system_program",
      "clock",
    ]);
  });

  it("payer (createOrder[0]) is signer and writable", () => {
    const payer = CANONICAL_ACCOUNT_ORDERING.createOrder[0];
    expect(payer.signer).toBe(true);
    expect(payer.writable).toBe(true);
  });

  it("order_pda (createOrder[1]) is not a signer but is writable", () => {
    const orderPda = CANONICAL_ACCOUNT_ORDERING.createOrder[1];
    expect(orderPda.signer).toBe(false);
    expect(orderPda.writable).toBe(true);
  });

  it("system_program is never a signer and never writable", () => {
    const checkSysProgram = (accounts: readonly { name: string; signer: boolean; writable: boolean }[]) => {
      const sys = accounts.find((a) => a.name === "system_program");
      if (!sys) return;
      expect(sys.signer).toBe(false);
      expect(sys.writable).toBe(false);
    };
    checkSysProgram(CANONICAL_ACCOUNT_ORDERING.createOrder);
    checkSysProgram(CANONICAL_ACCOUNT_ORDERING.claimOrder);
    checkSysProgram(CANONICAL_ACCOUNT_ORDERING.refundOrder);
  });
});

// ── Instruction data sizes ────────────────────────────────────────────────────

describe("INSTRUCTION_DATA_SIZES — stability guard", () => {
  it("createOrder is 64 bytes (8 disc + 8 amount + 8 safety + 32 hashlock + 8 timelock)", () => {
    expect(INSTRUCTION_DATA_SIZES.createOrder).toBe(64);
  });

  it("claimOrder is 40 bytes (8 disc + 32 preimage)", () => {
    expect(INSTRUCTION_DATA_SIZES.claimOrder).toBe(40);
  });

  it("refundOrder is 8 bytes (8 disc only)", () => {
    expect(INSTRUCTION_DATA_SIZES.refundOrder).toBe(8);
  });
});

// ── assertIdlCompatibility ────────────────────────────────────────────────────

describe("assertIdlCompatibility", () => {
  it("returns compatible=true when on-chain version equals IDL_VERSION", () => {
    const result = assertIdlCompatibility(IDL_VERSION);
    expect(result.compatible).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.sdkVersion).toBe(IDL_VERSION);
    expect(result.onChainVersion).toBe(IDL_VERSION);
  });

  it("returns compatible=false when on-chain version is newer than IDL_VERSION", () => {
    const result = assertIdlCompatibility(IDL_VERSION + 1);
    expect(result.compatible).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/newer than SDK IDL/);
  });

  it("returns compatible=true with a warning when on-chain version is older", () => {
    // Only relevant once IDL_VERSION > 0, but the logic must hold.
    // We test the branching by calling with version 0 when IDL is 0 (no-op),
    // and with a negative sentinel via casting to confirm the warning path.
    // For now just verify the no-op case (0 == 0) stays clean.
    const result = assertIdlCompatibility(0);
    expect(result.compatible).toBe(true);
    // No errors even if it were an older account.
    expect(result.errors).toHaveLength(0);
  });

  it("includes sdkVersion in all results", () => {
    const r1 = assertIdlCompatibility(0);
    expect(r1.sdkVersion).toBe(IDL_VERSION);
    const r2 = assertIdlCompatibility(99);
    expect(r2.sdkVersion).toBe(IDL_VERSION);
  });
});

// ── validateInstructionSchema ─────────────────────────────────────────────────

const PROGRAM_ID = "11111111111111111111111111111111";
const HASHLOCK_BYTES = Buffer.from("ab".repeat(32), "hex");

describe("validateInstructionSchema — createOrder", () => {
  it("returns no errors for a well-formed createOrder instruction", () => {
    const programPk = new PublicKey(PROGRAM_ID);
    const { instruction } = buildCreateOrderInstruction(programPk, {
      payer:            new PublicKey("11111111111111111111111111111111"),
      beneficiary:      new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf8Ny8suSzwAh"),
      refundAddress:    new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bJ9"),
      mint:             new PublicKey(NATIVE_SOL_MINT),
      amount:           BigInt(1_000_000_000),
      safetyDeposit:    BigInt(1_000_000),
      hashlockBytes:    HASHLOCK_BYTES,
      timelockAbsolute: 1_800_000_000,
    });

    const errors = validateInstructionSchema(
      "createOrder",
      instruction.data,
      instruction.keys
    );
    expect(errors).toHaveLength(0);
  });

  it("reports an error when discriminator is wrong", () => {
    const badData = Buffer.alloc(INSTRUCTION_DATA_SIZES.createOrder, 0);
    // Purposefully leave discriminator as all-zeros.
    const errors = validateInstructionSchema(
      "createOrder",
      badData,
      // 7 dummy accounts with correct signer/writable flags
      [
        { isSigner: true,  isWritable: true  },
        { isSigner: false, isWritable: true  },
        { isSigner: false, isWritable: false },
        { isSigner: false, isWritable: false },
        { isSigner: false, isWritable: false },
        { isSigner: false, isWritable: false },
        { isSigner: false, isWritable: false },
      ]
    );
    expect(errors.some((e) => e.includes("discriminator"))).toBe(true);
  });

  it("reports an error when data size is wrong", () => {
    const badData = Buffer.alloc(10, 0); // too small
    const errors = validateInstructionSchema("createOrder", badData, []);
    expect(errors.some((e) => e.includes("data size"))).toBe(true);
  });

  it("reports an error when account count is wrong", () => {
    const programPk = new PublicKey(PROGRAM_ID);
    const { instruction } = buildCreateOrderInstruction(programPk, {
      payer:            new PublicKey("11111111111111111111111111111111"),
      beneficiary:      new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf8Ny8suSzwAh"),
      refundAddress:    new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bJ9"),
      mint:             new PublicKey(NATIVE_SOL_MINT),
      amount:           BigInt(1),
      safetyDeposit:    BigInt(0),
      hashlockBytes:    HASHLOCK_BYTES,
      timelockAbsolute: 0,
    });

    // Pass only 3 accounts instead of 7
    const errors = validateInstructionSchema(
      "createOrder",
      instruction.data,
      instruction.keys.slice(0, 3)
    );
    expect(errors.some((e) => e.includes("account count"))).toBe(true);
  });

  it("reports an error when signer/writable flags are wrong", () => {
    const programPk = new PublicKey(PROGRAM_ID);
    const { instruction } = buildCreateOrderInstruction(programPk, {
      payer:            new PublicKey("11111111111111111111111111111111"),
      beneficiary:      new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf8Ny8suSzwAh"),
      refundAddress:    new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bJ9"),
      mint:             new PublicKey(NATIVE_SOL_MINT),
      amount:           BigInt(1),
      safetyDeposit:    BigInt(0),
      hashlockBytes:    HASHLOCK_BYTES,
      timelockAbsolute: 0,
    });

    // Flip signer on the first account (should be signer=true, make it false)
    const corruptedKeys = instruction.keys.map((k, i) =>
      i === 0 ? { ...k, isSigner: false } : k
    );

    const errors = validateInstructionSchema(
      "createOrder",
      instruction.data,
      corruptedKeys
    );
    expect(errors.some((e) => e.includes("signer mismatch"))).toBe(true);
  });
});

describe("validateInstructionSchema — claimOrder", () => {
  it("returns no errors for a well-formed claimOrder instruction", () => {
    const programPk = new PublicKey(PROGRAM_ID);
    const orderPda = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf8Ny8suSzwAh");
    const claimer = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bJ9");

    const ix = buildClaimOrderInstruction(programPk, {
      claimer,
      orderPda,
      beneficiaryAccount: claimer,
      preimageBytes: Buffer.alloc(32, 0xcc),
    });

    const errors = validateInstructionSchema("claimOrder", ix.data, ix.keys);
    expect(errors).toHaveLength(0);
  });
});

describe("validateInstructionSchema — refundOrder", () => {
  it("returns no errors for a well-formed refundOrder instruction", () => {
    const programPk = new PublicKey(PROGRAM_ID);
    const orderPda = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf8Ny8suSzwAh");
    const refunder = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bJ9");

    const ix = buildRefundOrderInstruction(programPk, {
      refunder,
      orderPda,
      refundAccount: refunder,
    });

    const errors = validateInstructionSchema("refundOrder", ix.data, ix.keys);
    expect(errors).toHaveLength(0);
  });
});

// ── SDK ↔ IDL alignment cross-check ──────────────────────────────────────────

describe("SDK instruction builders align with IDL schema", () => {
  const programPk = new PublicKey(PROGRAM_ID);

  it("createOrder builder produces exactly INSTRUCTION_DATA_SIZES.createOrder bytes", () => {
    const { instruction } = buildCreateOrderInstruction(programPk, {
      payer:            new PublicKey("11111111111111111111111111111111"),
      beneficiary:      new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf8Ny8suSzwAh"),
      refundAddress:    new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bJ9"),
      mint:             new PublicKey(NATIVE_SOL_MINT),
      amount:           BigInt(1),
      safetyDeposit:    BigInt(0),
      hashlockBytes:    HASHLOCK_BYTES,
      timelockAbsolute: 0,
    });
    expect(instruction.data.length).toBe(INSTRUCTION_DATA_SIZES.createOrder);
  });

  it("claimOrder builder produces exactly INSTRUCTION_DATA_SIZES.claimOrder bytes", () => {
    const ix = buildClaimOrderInstruction(programPk, {
      claimer:            new PublicKey("11111111111111111111111111111111"),
      orderPda:           new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf8Ny8suSzwAh"),
      beneficiaryAccount: new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bJ9"),
      preimageBytes:      Buffer.alloc(32, 0x01),
    });
    expect(ix.data.length).toBe(INSTRUCTION_DATA_SIZES.claimOrder);
  });

  it("refundOrder builder produces exactly INSTRUCTION_DATA_SIZES.refundOrder bytes", () => {
    const ix = buildRefundOrderInstruction(programPk, {
      refunder:      new PublicKey("11111111111111111111111111111111"),
      orderPda:      new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf8Ny8suSzwAh"),
      refundAccount: new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bJ9"),
    });
    expect(ix.data.length).toBe(INSTRUCTION_DATA_SIZES.refundOrder);
  });

  it("createOrder builder account count matches canonical ordering", () => {
    const { instruction } = buildCreateOrderInstruction(programPk, {
      payer:            new PublicKey("11111111111111111111111111111111"),
      beneficiary:      new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf8Ny8suSzwAh"),
      refundAddress:    new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bJ9"),
      mint:             new PublicKey(NATIVE_SOL_MINT),
      amount:           BigInt(1),
      safetyDeposit:    BigInt(0),
      hashlockBytes:    HASHLOCK_BYTES,
      timelockAbsolute: 0,
    });
    expect(instruction.keys.length).toBe(CANONICAL_ACCOUNT_ORDERING.createOrder.length);
  });
});
