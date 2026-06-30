/**
 * Solana HTLC client for the WaffleFinance bridge.
 *
 * Mirrors the structure of SorobanHTLCClient and EthereumHTLCClient.
 * Signing is always delegated to the caller — this module never holds keys.
 *
 * Real vs simulation mode
 * ───────────────────────
 * When `programId` is "PLACEHOLDER" or empty the client enters simulation
 * mode: mutating calls return mock signatures and `getOrder` returns null.
 * All other code paths use the Anchor IDL defined in `./idl/htlc.ts` to
 * build instructions and deserialise on-chain accounts.
 *
 * Instruction layout
 * ──────────────────
 * Each instruction starts with an 8-byte Anchor discriminator followed by
 * the serialised arguments in little-endian order.  See `./idl/htlc.ts`
 * for the full byte map.
 *
 * Account deserialisation
 * ───────────────────────
 * `getOrder()` reads the PDA account and parses the fields directly from
 * the raw byte buffer using the offsets declared in the IDL.  The version
 * byte is checked first; if a newer layout is detected the call throws
 * rather than silently returning garbage fields.
 */

import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  SYSVAR_CLOCK_PUBKEY,
  type TransactionSignature,
  type Commitment,
  type AccountMeta,
} from "@solana/web3.js";

import {
  HTLC_ORDER_DISCRIMINATOR,
  HTLC_ORDER_ACCOUNT_SIZE,
  IDL_VERSION,
  FIELD_OFFSET,
  IX_CREATE_ORDER,
  IX_CLAIM_ORDER,
  IX_REFUND_ORDER,
  ORDER_SEED,
} from "./idl/htlc.js";

// Re-export the status enum for consumers without pulling it into local scope.
export { OrderStatus } from "./idl/htlc.js";

// Import shared utilities for hex conversion and U64 LE serialisation.
import {
  bufferToHex as sharedBufferToHex,
  writeU64LE as sharedWriteU64LE,
  readU64LE as sharedReadU64LE,
  readI64LE as sharedReadI64LE,
  hex32ToBuffer,
} from "../shared-utils/index.js";

/** 0x-prefixed hex string (mirrors viem's HexString). */
type HexString = `0x${string}`;

// ── Types ──────────────────────────────────────────────────────────────────

export interface SolanaHTLCClientOptions {
  /** Solana RPC endpoint, e.g. https://api.devnet.solana.com */
  rpcUrl: string;
  /** Deployed Anchor program id for the HTLC contract. */
  programId: string;
  /** Commitment level for reads/confirmations. */
  commitment?: Commitment;
}

export interface SolanaCreateOrderInput {
  /** Sender public-key (base-58). */
  sender: string;
  /** Beneficiary public-key (base-58). */
  beneficiary: string;
  /** Refund address public-key (base-58). */
  refundAddress: string;
  /** SPL token mint. Use NATIVE_SOL_MINT for native SOL. */
  mint: string;
  /** Amount in lamports (or SPL token atomic units). */
  amount: bigint;
  /** Safety deposit in lamports. */
  safetyDeposit: bigint;
  /** sha256 hashlock, 0x-prefixed 32-byte hex. */
  hashlockHex: HexString;
  /** Timelock duration in seconds from now. */
  timelockSeconds: number;
}

export interface SolanaOrderData {
  /** Base-58 encoded PDA address — used as the canonical order id. */
  orderId: string;
  sender: string;
  beneficiary: string;
  refundAddress: string;
  mint: string;
  amount: bigint;
  safetyDeposit: bigint;
  hashlock: HexString;
  /** Absolute unix timestamp (seconds). */
  timelock: number;
  /** 0=Active 1=Claimed 2=Refunded */
  status: 0 | 1 | 2;
  preimage: HexString | null;
}

/** Minimal signer interface — delegates to Phantom / Backpack / headless keypair. */
export type SolanaSigner = {
  publicKey: PublicKey;
  signTransaction(tx: Transaction): Promise<Transaction>;
};

// ── Constants ──────────────────────────────────────────────────────────────

/** Represents native SOL (no SPL mint). */
export const NATIVE_SOL_MINT = "So11111111111111111111111111111111111111112";

// ── Serialisation helpers ──────────────────────────────────────────────────
// Using shared utilities from ../shared-utils/index.js

const bufferToHex = sharedBufferToHex;
const writeU64LE = sharedWriteU64LE;
const readU64LE = sharedReadU64LE;
const readI64LE = sharedReadI64LE;

// ── PDA derivation ─────────────────────────────────────────────────────────

/**
 * Derive the deterministic PDA for an HTLC order from its hashlock.
 *
 * Seeds: [b"order", hashlock_bytes (32)]
 */
function deriveOrderPda(
  hashlockBytes: Buffer,
  programId: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [ORDER_SEED, hashlockBytes],
    programId
  );
}

// ── Account deserialisation ────────────────────────────────────────────────

/**
 * Parse a raw HTLCOrder account data buffer into a `SolanaOrderData`.
 *
 * Throws when:
 *  - The account is too small to be a valid HTLCOrder account
 *  - The 8-byte discriminator does not match HTLC_ORDER_DISCRIMINATOR
 *  - The `version` byte is higher than IDL_VERSION (unknown layout)
 */
export function deserialiseOrderAccount(
  data: Buffer,
  orderId: string
): SolanaOrderData {
  // Minimum size: 8 (discriminator) + 219 (fields) = 227 bytes.
  if (data.length < HTLC_ORDER_ACCOUNT_SIZE) {
    throw new Error(
      `HTLCOrder account data too small: expected >= ${HTLC_ORDER_ACCOUNT_SIZE} bytes, got ${data.length}`
    );
  }

  // Verify Anchor account discriminator.
  const disc = data.subarray(0, 8);
  if (!disc.equals(HTLC_ORDER_DISCRIMINATOR)) {
    throw new Error(
      `Invalid HTLCOrder discriminator: ${disc.toString("hex")}`
    );
  }

  // All field offsets are relative to byte 8 (after the discriminator).
  const fields = data.subarray(8);

  const version = fields.readUInt8(FIELD_OFFSET.version);
  if (version > IDL_VERSION) {
    throw new Error(
      `HTLCOrder account version ${version} is newer than SDK IDL version ${IDL_VERSION}. ` +
      "Update the SDK to parse this account."
    );
  }

  const sender = new PublicKey(
    fields.subarray(FIELD_OFFSET.sender, FIELD_OFFSET.sender + 32)
  ).toBase58();

  const beneficiary = new PublicKey(
    fields.subarray(FIELD_OFFSET.beneficiary, FIELD_OFFSET.beneficiary + 32)
  ).toBase58();

  const refundAddress = new PublicKey(
    fields.subarray(FIELD_OFFSET.refundAddress, FIELD_OFFSET.refundAddress + 32)
  ).toBase58();

  const mint = new PublicKey(
    fields.subarray(FIELD_OFFSET.mint, FIELD_OFFSET.mint + 32)
  ).toBase58();

  const amount = readU64LE(fields, FIELD_OFFSET.amount);
  const safetyDeposit = readU64LE(fields, FIELD_OFFSET.safetyDeposit);

  const hashlock = bufferToHex(
    fields.subarray(FIELD_OFFSET.hashlock, FIELD_OFFSET.hashlock + 32)
  );

  const timelockBigInt = readI64LE(fields, FIELD_OFFSET.timelock);
  const timelock = Number(timelockBigInt);

  const statusByte = fields.readUInt8(FIELD_OFFSET.status);
  if (statusByte !== 0 && statusByte !== 1 && statusByte !== 2) {
    throw new Error(`Unknown HTLCOrder status byte: ${statusByte}`);
  }
  const status = statusByte as 0 | 1 | 2;

  // Option<[u8;32]>: 1-byte tag (1 = Some, 0 = None) + 32 bytes value.
  const preimageTag = fields.readUInt8(FIELD_OFFSET.preimage);
  const preimage: HexString | null =
    preimageTag === 1
      ? bufferToHex(
          fields.subarray(FIELD_OFFSET.preimage + 1, FIELD_OFFSET.preimage + 33)
        )
      : null;

  return {
    orderId,
    sender,
    beneficiary,
    refundAddress,
    mint,
    amount,
    safetyDeposit,
    hashlock,
    timelock,
    status,
    preimage,
  };
}

// ── Instruction builders ───────────────────────────────────────────────────

/**
 * Build a `create_order` instruction.
 *
 * Instruction data layout (after 8-byte discriminator):
 *   8   amount          u64 LE
 *   8   safety_deposit  u64 LE
 *  32   hashlock        [u8;32]
 *   8   timelock        i64 LE (absolute unix seconds)
 *
 * Accounts:
 *   [signer, writable]   payer      (fee-payer / sender)
 *   [writable]           order_pda  (HTLCOrder account, created by program)
 *   []                   mint
 *   []                   beneficiary
 *   []                   refund_address
 *   []                   system_program
 *   []                   clock      (SYSVAR_CLOCK_PUBKEY)
 */
export function buildCreateOrderInstruction(
  programId: PublicKey,
  input: {
    payer: PublicKey;
    beneficiary: PublicKey;
    refundAddress: PublicKey;
    mint: PublicKey;
    amount: bigint;
    safetyDeposit: bigint;
    hashlockBytes: Buffer;
    timelockAbsolute: number;
  }
): { instruction: TransactionInstruction; orderPda: PublicKey } {
  const [orderPda] = deriveOrderPda(input.hashlockBytes, programId);

  // Serialise instruction data: discriminator + args.
  const data = Buffer.allocUnsafe(8 + 8 + 8 + 32 + 8);
  IX_CREATE_ORDER.copy(data, 0);
  writeU64LE(data, input.amount, 8);
  writeU64LE(data, input.safetyDeposit, 16);
  input.hashlockBytes.copy(data, 24);
  // Timelock as i64 LE.
  const tl = BigInt(input.timelockAbsolute);
  writeU64LE(data, tl < BigInt(0) ? tl + (BigInt(1) << BigInt(64)) : tl, 56);

  const keys: AccountMeta[] = [
    { pubkey: input.payer,         isSigner: true,  isWritable: true  },
    { pubkey: orderPda,            isSigner: false, isWritable: true  },
    { pubkey: input.mint,          isSigner: false, isWritable: false },
    { pubkey: input.beneficiary,   isSigner: false, isWritable: false },
    { pubkey: input.refundAddress, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
  ];

  return {
    instruction: new TransactionInstruction({ keys, programId, data }),
    orderPda,
  };
}

/**
 * Build a `claim_order` instruction.
 *
 * Instruction data layout:
 *   32   preimage  [u8;32]
 *
 * Accounts:
 *   [signer, writable]  claimer    (beneficiary or authorised claimer)
 *   [writable]          order_pda  (HTLCOrder PDA)
 *   [writable]          beneficiary_token_account (SPL ATA or system account)
 *   []                  system_program
 */
export function buildClaimOrderInstruction(
  programId: PublicKey,
  input: {
    claimer: PublicKey;
    orderPda: PublicKey;
    beneficiaryAccount: PublicKey;
    preimageBytes: Buffer;
  }
): TransactionInstruction {
  const data = Buffer.allocUnsafe(8 + 32);
  IX_CLAIM_ORDER.copy(data, 0);
  input.preimageBytes.copy(data, 8);

  const keys: AccountMeta[] = [
    { pubkey: input.claimer,             isSigner: true,  isWritable: true  },
    { pubkey: input.orderPda,            isSigner: false, isWritable: true  },
    { pubkey: input.beneficiaryAccount,  isSigner: false, isWritable: true  },
    { pubkey: SystemProgram.programId,   isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({ keys, programId, data });
}

/**
 * Build a `refund_order` instruction.
 *
 * Instruction data layout: discriminator only (no args — the program
 * validates timelock expiry on-chain).
 *
 * Accounts:
 *   [signer, writable]  refunder        (refund_address stored in order)
 *   [writable]          order_pda       (HTLCOrder PDA)
 *   [writable]          refund_account  (destination for returned lamports/tokens)
 *   []                  system_program
 *   []                  clock
 */
export function buildRefundOrderInstruction(
  programId: PublicKey,
  input: {
    refunder: PublicKey;
    orderPda: PublicKey;
    refundAccount: PublicKey;
  }
): TransactionInstruction {
  const data = Buffer.from(IX_REFUND_ORDER);

  const keys: AccountMeta[] = [
    { pubkey: input.refunder,          isSigner: true,  isWritable: true  },
    { pubkey: input.orderPda,          isSigner: false, isWritable: true  },
    { pubkey: input.refundAccount,     isSigner: false, isWritable: true  },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_CLOCK_PUBKEY,     isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({ keys, programId, data });
}

// ── Client ─────────────────────────────────────────────────────────────────

export class SolanaHTLCClient {
  public readonly programId: string;
  private readonly connection: Connection;
  private readonly commitment: Commitment;
  private readonly simulation: boolean;
  private readonly programPk: PublicKey | null;

  constructor(opts: SolanaHTLCClientOptions) {
    this.programId = opts.programId;
    this.commitment = opts.commitment ?? "confirmed";
    this.connection = new Connection(opts.rpcUrl, this.commitment);

    // Enter simulation mode only when no real program id is configured.
    this.simulation = opts.programId === "PLACEHOLDER" || opts.programId === "";

    if (this.simulation) {
      this.programPk = null;
      console.warn(
        "[SolanaHTLCClient] No program id configured — running in simulation mode. " +
        "All mutating calls return mock signatures."
      );
    } else {
      this.programPk = new PublicKey(opts.programId);
    }
  }

  // ── Read ──────────────────────────────────────────────────────────────────

  /**
   * Fetch and deserialise the on-chain HTLCOrder account for `orderId`
   * (base-58 PDA address).
   *
   * Returns `null` when:
   *  - the client is in simulation mode
   *  - the account does not exist on-chain
   *
   * Throws when the account exists but cannot be parsed (wrong discriminator,
   * newer layout version, truncated data).
   */
  async getOrder(orderId: string): Promise<SolanaOrderData | null> {
    if (this.simulation) return null;

    const pda = new PublicKey(orderId);
    const info = await this.connection.getAccountInfo(pda, this.commitment);
    if (!info) return null;

    return deserialiseOrderAccount(Buffer.from(info.data), orderId);
  }

  /**
   * Derive the PDA address (= orderId) from a hashlock without hitting the
   * network.  Useful for pre-computing the order id before creating the order.
   */
  deriveOrderId(hashlockHex: HexString): string {
    if (!this.programPk) {
      throw new Error(
        "Cannot derive orderId in simulation mode — no programId configured."
      );
    }
    const hashlockBytes = hex32ToBuffer(hashlockHex, "hashlock");
    const [pda] = deriveOrderPda(hashlockBytes, this.programPk);
    return pda.toBase58();
  }

  async getNativeBalance(address: string): Promise<bigint> {
    const pk = new PublicKey(address);
    const lamports = await this.connection.getBalance(pk, this.commitment);
    return BigInt(lamports);
  }

  // ── Write ─────────────────────────────────────────────────────────────────

  /**
   * Build, sign, and submit a `create_order` instruction.
   *
   * @returns The transaction signature and the deterministic order id
   *          (= PDA address derived from the hashlock).
   */
  async createOrder(
    input: SolanaCreateOrderInput,
    signer: SolanaSigner
  ): Promise<{ txSignature: TransactionSignature; orderId: string }> {
    if (this.simulation) {
      const mockSig = "SIMULATION_" + input.hashlockHex.slice(2, 18);
      console.warn("[SolanaHTLCClient] simulation createOrder →", mockSig);
      return { txSignature: mockSig, orderId: "sim-" + input.hashlockHex.slice(2, 18) };
    }

    const programPk = this.programPk!;
    const hashlockBytes = hex32ToBuffer(input.hashlockHex, "hashlock");
    const nowSeconds = Math.floor(Date.now() / 1000);
    const timelockAbsolute = nowSeconds + input.timelockSeconds;

    const { instruction, orderPda } = buildCreateOrderInstruction(programPk, {
      payer:         signer.publicKey,
      beneficiary:   new PublicKey(input.beneficiary),
      refundAddress: new PublicKey(input.refundAddress),
      mint:          new PublicKey(input.mint),
      amount:        input.amount,
      safetyDeposit: input.safetyDeposit,
      hashlockBytes,
      timelockAbsolute,
    });

    const sig = await this._buildSignSend([instruction], signer);
    return { txSignature: sig, orderId: orderPda.toBase58() };
  }

  /**
   * Reveal the preimage on-chain to claim the locked funds.
   *
   * @param orderId    Base-58 PDA address of the order to claim.
   * @param preimage   The secret preimage (0x-prefixed hex, 32 bytes).
   * @param signer     Wallet that controls the beneficiary account.
   */
  async claimOrder(
    orderId: string,
    preimage: HexString,
    signer: SolanaSigner
  ): Promise<TransactionSignature> {
    if (this.simulation) {
      const mockSig = "SIMULATION_CLAIM_" + orderId.slice(0, 8);
      console.warn("[SolanaHTLCClient] simulation claimOrder →", mockSig);
      return mockSig;
    }

    const programPk = this.programPk!;
    const orderPda = new PublicKey(orderId);
    const preimageBytes = hex32ToBuffer(preimage, "preimage");

    const ix = buildClaimOrderInstruction(programPk, {
      claimer:            signer.publicKey,
      orderPda,
      // For native SOL the beneficiary system account receives the lamports;
      // for SPL tokens callers should pass the ATA.  We use signer.publicKey
      // as a safe default — downstream code may override via a wrapper.
      beneficiaryAccount: signer.publicKey,
      preimageBytes,
    });

    return this._buildSignSend([ix], signer);
  }

  /**
   * Reclaim locked funds after the timelock has expired.
   *
   * @param orderId  Base-58 PDA address.
   * @param signer   Wallet controlling the refund_address stored in the order.
   */
  async refundOrder(
    orderId: string,
    signer: SolanaSigner
  ): Promise<TransactionSignature> {
    if (this.simulation) {
      const mockSig = "SIMULATION_REFUND_" + orderId.slice(0, 8);
      console.warn("[SolanaHTLCClient] simulation refundOrder →", mockSig);
      return mockSig;
    }

    const programPk = this.programPk!;
    const orderPda = new PublicKey(orderId);

    const ix = buildRefundOrderInstruction(programPk, {
      refunder:      signer.publicKey,
      orderPda,
      refundAccount: signer.publicKey,
    });

    return this._buildSignSend([ix], signer);
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /** Fetch a recent blockhash, build, sign, send, and confirm a transaction. */
  private async _buildSignSend(
    instructions: TransactionInstruction[],
    signer: SolanaSigner
  ): Promise<TransactionSignature> {
    const { blockhash } = await this.connection.getLatestBlockhash(this.commitment);
    const tx = new Transaction({ recentBlockhash: blockhash, feePayer: signer.publicKey });
    tx.add(...instructions);
    const signed = await signer.signTransaction(tx);
    const sig = await this.connection.sendRawTransaction(signed.serialize());
    await this.connection.confirmTransaction(sig, this.commitment);
    return sig;
  }
}
