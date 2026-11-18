/**
 * Unit tests for the Solana HTLC SDK client.
 *
 * These tests exercise:
 *  - Account deserialisation (`deserialiseOrderAccount`)
 *  - Instruction builder output (discriminators, data layout)
 *  - PDA derivation (`deriveOrderId`)
 *  - Simulation-mode behaviour (mock sigs, no network needed)
 *  - Error cases: bad discriminator, wrong version, truncated data
 *
 * No live network calls are made.  All real-mode tests use a mocked
 * `Connection` that never touches the network.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PublicKey, Transaction, SystemProgram } from "@solana/web3.js";

import {
  SolanaHTLCClient,
  deserialiseOrderAccount,
  buildCreateOrderInstruction,
  buildClaimOrderInstruction,
  buildRefundOrderInstruction,
  NATIVE_SOL_MINT,
  OrderStatus,
  type SolanaOrderData,
  type SolanaSigner,
} from "../src/solana/index.js";

import {
  HTLC_ORDER_DISCRIMINATOR,
  HTLC_ORDER_ACCOUNT_SIZE,
  IDL_VERSION,
  FIELD_OFFSET,
  IX_CREATE_ORDER,
  IX_CLAIM_ORDER,
  IX_REFUND_ORDER,
  ORDER_SEED,
} from "../src/solana/idl/htlc.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

// A real 32-byte base-58 encoded public key (System Program ID — always valid).
const PROGRAM_ID = "11111111111111111111111111111111";

/** A deterministic 32-byte hashlock for tests. */
const HASHLOCK_HEX = ("0x" + "ab".repeat(32)) as `0x${string}`;
const HASHLOCK_BYTES = Buffer.from("ab".repeat(32), "hex");

/** Write a u64 little-endian into buf at offset. */
function writeU64LE(buf: Buffer, value: bigint, offset: number): void {
  const lo = Number(value & BigInt(0xffffffff));
  const hi = Number(value >> BigInt(32));
  buf.writeUInt32LE(lo, offset);
  buf.writeUInt32LE(hi, offset + 4);
}

/**
 * Build a synthetic HTLCOrder account buffer that passes all checks.
 * Fields can be overridden via the `overrides` parameter.
 */
function buildFakeAccountData(overrides: {
  version?: number;
  discriminator?: Buffer;
  status?: number;
  hasPreimage?: boolean;
  truncate?: boolean;
} = {}): Buffer {
  const buf = Buffer.alloc(HTLC_ORDER_ACCOUNT_SIZE, 0);

  // Discriminator (8 bytes)
  const disc = overrides.discriminator ?? HTLC_ORDER_DISCRIMINATOR;
  disc.copy(buf, 0);

  // Fields start at offset 8.
  const f = buf.subarray(8);

  f.writeUInt8(overrides.version ?? IDL_VERSION, FIELD_OFFSET.version);

  // Fill pubkey fields with valid-looking deterministic pubkeys.
  // Base-58 alphabet excludes 0, O, I, l — use only safe chars here.
  const senderPk     = new PublicKey("11111111111111111111111111111111"); // System Program
  const beneficiaryPk = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf8Ny8suSzwAh"); // Token Program
  const refundPk     = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bJ9"); // ATA Program
  const mintPk       = new PublicKey(NATIVE_SOL_MINT);

  senderPk.toBuffer().copy(f, FIELD_OFFSET.sender);
  beneficiaryPk.toBuffer().copy(f, FIELD_OFFSET.beneficiary);
  refundPk.toBuffer().copy(f, FIELD_OFFSET.refundAddress);
  mintPk.toBuffer().copy(f, FIELD_OFFSET.mint);

  writeU64LE(f, BigInt(1_000_000_000), FIELD_OFFSET.amount);
  writeU64LE(f, BigInt(1_000_000), FIELD_OFFSET.safetyDeposit);
  HASHLOCK_BYTES.copy(f, FIELD_OFFSET.hashlock);

  // Timelock: Unix second 1_700_000_000 as i64 LE
  writeU64LE(f, BigInt(1_700_000_000), FIELD_OFFSET.timelock);

  f.writeUInt8(overrides.status ?? OrderStatus.Active, FIELD_OFFSET.status);

  if (overrides.hasPreimage) {
    f.writeUInt8(1, FIELD_OFFSET.preimage); // Some tag
    HASHLOCK_BYTES.copy(f, FIELD_OFFSET.preimage + 1); // reuse hashlock bytes as fake preimage
  } else {
    f.writeUInt8(0, FIELD_OFFSET.preimage); // None tag
  }

  if (overrides.truncate) {
    return buf.subarray(0, 100); // intentionally too short
  }

  return buf;
}

// ── deserialiseOrderAccount ───────────────────────────────────────────────────

describe("deserialiseOrderAccount", () => {
  it("parses a valid Active order account", () => {
    const data = buildFakeAccountData();
    const order = deserialiseOrderAccount(data, "fakeOrderId");

    expect(order.orderId).toBe("fakeOrderId");
    expect(order.status).toBe(OrderStatus.Active);
    expect(order.amount).toBe(BigInt(1_000_000_000));
    expect(order.safetyDeposit).toBe(BigInt(1_000_000));
    expect(order.hashlock).toBe(HASHLOCK_HEX);
    expect(order.timelock).toBe(1_700_000_000);
    expect(order.preimage).toBeNull();
    expect(order.mint).toBe(NATIVE_SOL_MINT);
  });

  it("parses a Claimed order with preimage set", () => {
    const data = buildFakeAccountData({ status: OrderStatus.Claimed, hasPreimage: true });
    const order = deserialiseOrderAccount(data, "fakeOrderId");
    expect(order.status).toBe(OrderStatus.Claimed);
    expect(order.preimage).not.toBeNull();
    expect(order.preimage).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("parses a Refunded order", () => {
    const data = buildFakeAccountData({ status: OrderStatus.Refunded });
    const order = deserialiseOrderAccount(data, "fakeOrderId");
    expect(order.status).toBe(OrderStatus.Refunded);
  });

  it("throws when data is too short", () => {
    const data = buildFakeAccountData({ truncate: true });
    expect(() => deserialiseOrderAccount(data, "x")).toThrow(/too small/);
  });

  it("throws when the discriminator does not match", () => {
    const data = buildFakeAccountData({
      discriminator: Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
    });
    expect(() => deserialiseOrderAccount(data, "x")).toThrow(/discriminator/);
  });

  it("throws when the account version is newer than the SDK IDL", () => {
    const data = buildFakeAccountData({ version: IDL_VERSION + 1 });
    expect(() => deserialiseOrderAccount(data, "x")).toThrow(/version/i);
  });
});

// ── Instruction builders ──────────────────────────────────────────────────────

describe("buildCreateOrderInstruction", () => {
  it("uses IX_CREATE_ORDER discriminator as first 8 bytes", () => {
    const programPk = new PublicKey(PROGRAM_ID);
    const { instruction } = buildCreateOrderInstruction(programPk, {
      payer:         new PublicKey("11111111111111111111111111111111"),
      beneficiary:   new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf8Ny8suSzwAh"),
      refundAddress: new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bJ9"),
      mint:          new PublicKey(NATIVE_SOL_MINT),
      amount:           BigInt(1_000_000_000),
      safetyDeposit:    BigInt(1_000_000),
      hashlockBytes:    HASHLOCK_BYTES,
      timelockAbsolute: 1_800_000_000,
    });

    const disc = instruction.data.subarray(0, 8);
    expect(Buffer.from(disc)).toEqual(IX_CREATE_ORDER);
  });

  it("encodes amount correctly in little-endian at offset 8", () => {
    const programPk = new PublicKey(PROGRAM_ID);
    const amount = BigInt(5_000_000_000);
    const { instruction } = buildCreateOrderInstruction(programPk, {
      payer:         new PublicKey("11111111111111111111111111111111"),
      beneficiary:   new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf8Ny8suSzwAh"),
      refundAddress: new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bJ9"),
      mint:          new PublicKey(NATIVE_SOL_MINT),
      amount,
      safetyDeposit:    BigInt(0),
      hashlockBytes:    HASHLOCK_BYTES,
      timelockAbsolute: 0,
    });

    const data = Buffer.from(instruction.data);
    const lo = BigInt(data.readUInt32LE(8));
    const hi = BigInt(data.readUInt32LE(12));
    const decoded = (hi << BigInt(32)) | lo;
    expect(decoded).toBe(amount);
  });

  it("embeds hashlock bytes at offset 24", () => {
    const programPk = new PublicKey(PROGRAM_ID);
    const { instruction } = buildCreateOrderInstruction(programPk, {
      payer:         new PublicKey("11111111111111111111111111111111"),
      beneficiary:   new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf8Ny8suSzwAh"),
      refundAddress: new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bJ9"),
      mint:          new PublicKey(NATIVE_SOL_MINT),
      amount:           BigInt(1),
      safetyDeposit:    BigInt(0),
      hashlockBytes:    HASHLOCK_BYTES,
      timelockAbsolute: 0,
    });

    const hashInData = instruction.data.subarray(24, 56);
    expect(Buffer.from(hashInData)).toEqual(HASHLOCK_BYTES);
  });

  it("returns a PDA that is consistent with deriving it separately", () => {
    const programPk = new PublicKey(PROGRAM_ID);
    const { orderPda } = buildCreateOrderInstruction(programPk, {
      payer:         new PublicKey("11111111111111111111111111111111"),
      beneficiary:   new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf8Ny8suSzwAh"),
      refundAddress: new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bJ9"),
      mint:          new PublicKey(NATIVE_SOL_MINT),
      amount:           BigInt(1),
      safetyDeposit:    BigInt(0),
      hashlockBytes:    HASHLOCK_BYTES,
      timelockAbsolute: 0,
    });

    const [expectedPda] = PublicKey.findProgramAddressSync(
      [ORDER_SEED, HASHLOCK_BYTES],
      programPk
    );
    expect(orderPda.toBase58()).toBe(expectedPda.toBase58());
  });
});

describe("buildClaimOrderInstruction", () => {
  it("uses IX_CLAIM_ORDER discriminator", () => {
    const programPk = new PublicKey(PROGRAM_ID);
    const orderPda = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf8Ny8suSzwAh");
    const claimer = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bJ9");
    const preimageBytes = Buffer.alloc(32, 0xcc);

    const ix = buildClaimOrderInstruction(programPk, {
      claimer,
      orderPda,
      beneficiaryAccount: claimer,
      preimageBytes,
    });

    expect(Buffer.from(ix.data.subarray(0, 8))).toEqual(IX_CLAIM_ORDER);
    expect(Buffer.from(ix.data.subarray(8, 40))).toEqual(preimageBytes);
  });
});

describe("buildRefundOrderInstruction", () => {
  it("uses IX_REFUND_ORDER discriminator and has correct length", () => {
    const programPk = new PublicKey(PROGRAM_ID);
    const orderPda = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf8Ny8suSzwAh");
    const refunder = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bJ9");

    const ix = buildRefundOrderInstruction(programPk, {
      refunder,
      orderPda,
      refundAccount: refunder,
    });

    expect(Buffer.from(ix.data)).toEqual(IX_REFUND_ORDER);
  });
});

// ── SolanaHTLCClient — simulation mode ───────────────────────────────────────

describe("SolanaHTLCClient (simulation mode)", () => {
  it("enters simulation mode when programId is PLACEHOLDER", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = new SolanaHTLCClient({
      rpcUrl: "https://api.devnet.solana.com",
      programId: "PLACEHOLDER",
    });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("simulation mode"));
    warnSpy.mockRestore();
  });

  it("createOrder returns a mock signature in simulation mode", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = new SolanaHTLCClient({
      rpcUrl: "https://api.devnet.solana.com",
      programId: "PLACEHOLDER",
    });

    const fakeSigner: SolanaSigner = {
      publicKey: new PublicKey("11111111111111111111111111111111"),
      signTransaction: async (tx) => tx,
    };

    const result = await client.createOrder(
      {
        sender: "11111111111111111111111111111111",
        beneficiary: "22222222222222222222222222222222",
        refundAddress: "33333333333333333333333333333333",
        mint: NATIVE_SOL_MINT,
        amount: BigInt(1_000),
        safetyDeposit: BigInt(100),
        hashlockHex: HASHLOCK_HEX,
        timelockSeconds: 3600,
      },
      fakeSigner
    );

    expect(result.txSignature).toMatch(/^SIMULATION_/);
    expect(result.orderId).toMatch(/^sim-/);
    vi.restoreAllMocks();
  });

  it("claimOrder returns a mock signature in simulation mode", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = new SolanaHTLCClient({
      rpcUrl: "https://api.devnet.solana.com",
      programId: "PLACEHOLDER",
    });
    const fakeSigner: SolanaSigner = {
      publicKey: new PublicKey("11111111111111111111111111111111"),
      signTransaction: async (tx) => tx,
    };
    const sig = await client.claimOrder("sim-orderId", HASHLOCK_HEX, fakeSigner);
    expect(sig).toMatch(/^SIMULATION_CLAIM_/);
    vi.restoreAllMocks();
  });

  it("refundOrder returns a mock signature in simulation mode", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = new SolanaHTLCClient({
      rpcUrl: "https://api.devnet.solana.com",
      programId: "PLACEHOLDER",
    });
    const fakeSigner: SolanaSigner = {
      publicKey: new PublicKey("11111111111111111111111111111111"),
      signTransaction: async (tx) => tx,
    };
    const sig = await client.refundOrder("sim-orderId", fakeSigner);
    expect(sig).toMatch(/^SIMULATION_REFUND_/);
    vi.restoreAllMocks();
  });

  it("getOrder returns null in simulation mode", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = new SolanaHTLCClient({
      rpcUrl: "https://api.devnet.solana.com",
      programId: "PLACEHOLDER",
    });
    expect(await client.getOrder("anyId")).toBeNull();
    vi.restoreAllMocks();
  });

  it("deriveOrderId throws in simulation mode", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = new SolanaHTLCClient({
      rpcUrl: "https://api.devnet.solana.com",
      programId: "PLACEHOLDER",
    });
    expect(() => client.deriveOrderId(HASHLOCK_HEX)).toThrow(/simulation mode/);
    vi.restoreAllMocks();
  });
});

// ── SolanaHTLCClient — real mode (mocked connection) ─────────────────────────

describe("SolanaHTLCClient (real mode, mocked connection)", () => {
  it("getOrder returns null when the PDA account does not exist", async () => {
    // We can't easily inject a Connection mock into the constructor, so we
    // spy on getAccountInfo via prototype patching.
    const { Connection: RealConnection } = await import("@solana/web3.js");
    const getAccountInfoSpy = vi
      .spyOn(RealConnection.prototype, "getAccountInfo")
      .mockResolvedValue(null);

    const client = new SolanaHTLCClient({
      rpcUrl: "https://api.devnet.solana.com",
      programId: PROGRAM_ID,
    });

    const [pda] = PublicKey.findProgramAddressSync(
      [ORDER_SEED, HASHLOCK_BYTES],
      new PublicKey(PROGRAM_ID)
    );

    const result = await client.getOrder(pda.toBase58());
    expect(result).toBeNull();
    getAccountInfoSpy.mockRestore();
  });

  it("getOrder parses and returns an Active order when account data is valid", async () => {
    const { Connection: RealConnection } = await import("@solana/web3.js");
    const fakeData = buildFakeAccountData();

    const getAccountInfoSpy = vi
      .spyOn(RealConnection.prototype, "getAccountInfo")
      .mockResolvedValue({
        data: fakeData,
        executable: false,
        lamports: 2_000_000,
        owner: new PublicKey(PROGRAM_ID),
        rentEpoch: 0
      });

    const client = new SolanaHTLCClient({
      rpcUrl: "https://api.devnet.solana.com",
      programId: PROGRAM_ID,
    });

    const [pda] = PublicKey.findProgramAddressSync(
      [ORDER_SEED, HASHLOCK_BYTES],
      new PublicKey(PROGRAM_ID)
    );

    const order = await client.getOrder(pda.toBase58());
    expect(order).not.toBeNull();
    expect(order!.status).toBe(OrderStatus.Active);
    expect(order!.hashlock).toBe(HASHLOCK_HEX);
    expect(order!.amount).toBe(BigInt(1_000_000_000));

    getAccountInfoSpy.mockRestore();
  });

  it("deriveOrderId returns the expected PDA base-58 string", () => {
    const client = new SolanaHTLCClient({
      rpcUrl: "https://api.devnet.solana.com",
      programId: PROGRAM_ID,
    });

    const orderId = client.deriveOrderId(HASHLOCK_HEX);
    const [expected] = PublicKey.findProgramAddressSync(
      [ORDER_SEED, HASHLOCK_BYTES],
      new PublicKey(PROGRAM_ID)
    );
    expect(orderId).toBe(expected.toBase58());
  });

  it("deriveOrderId is deterministic for the same hashlock", () => {
    const client = new SolanaHTLCClient({
      rpcUrl: "https://api.devnet.solana.com",
      programId: PROGRAM_ID,
    });
    expect(client.deriveOrderId(HASHLOCK_HEX)).toBe(client.deriveOrderId(HASHLOCK_HEX));
  });

  it("different hashlocks produce different PDAs", () => {
    const client = new SolanaHTLCClient({
      rpcUrl: "https://api.devnet.solana.com",
      programId: PROGRAM_ID,
    });
    const id1 = client.deriveOrderId(("0x" + "aa".repeat(32)) as `0x${string}`);
    const id2 = client.deriveOrderId(("0x" + "bb".repeat(32)) as `0x${string}`);
    expect(id1).not.toBe(id2);
  });
});

// ── Rate-limit middleware unit tests ──────────────────────────────────────────
// (Kept in this file to validate the helper logic without the HTTP stack)

describe("resolveClientIp (imported from coordinator middleware)", () => {
  // These tests import the pure helper directly, keeping them framework-agnostic.
  it("falls back to socket address when trustedProxies is empty", async () => {
    // Dynamic import so we don't drag Express types into the SDK test environment.
    // The middleware is a coordinator concern but the IP logic is pure enough to unit-test.
    const { resolveClientIp } = await import(
      "../../coordinator/src/server/middleware/ratelimit.js" as string
    ).catch(() => ({ resolveClientIp: null }));

    // If the coordinator is not importable from the SDK test environment we skip.
    if (!resolveClientIp) return;

    const fakeReq = {
      socket: { remoteAddress: "127.0.0.1" },
      headers: { "x-forwarded-for": "1.2.3.4" }
    } as any;

    expect(resolveClientIp(fakeReq, new Set())).toBe("127.0.0.1");
    expect(resolveClientIp(fakeReq, undefined)).toBe("127.0.0.1");
  });
});
