/**
 * Typed Solana integration contract layer for the relayer.
 *
 * This module establishes a stable contract for Solana settlement behavior,
 * making the placeholder-mode decision explicit and controlled. When Solana
 * is disabled (placeholder mode), all operations fail fast with clear errors.
 * When configured, the contract owns real settlement submission semantics.
 *
 * Design:
 *  - SolanaIntegration is the main interface, with two implementations:
 *    - PlaceholderSolanaIntegration (disabled/placeholder mode)
 *    - ConfiguredSolanaIntegration (real program ID configured)
 *  - Factory function `createSolanaIntegration` decides which impl to use
 *    based on the program ID and logs the choice explicitly at startup.
 *  - All relayer Solana interactions go through this contract rather than
 *    scattering placeholder checks across services.
 */

import type { Logger } from "pino";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  type Commitment,
} from "@solana/web3.js";
import {
  buildCreateOrderInstruction,
  buildClaimOrderInstruction,
  buildRefundOrderInstruction,
  NATIVE_SOL_MINT,
  deserialiseOrderAccount,
  OrderStatus,
  SolanaRpcProvider,
  createSolanaRpcProvider,
  SolanaAccountInitError,
  assertAccountIsUninitialised,
  assertPayerCanFund,
  classifyUninitialisedAccount,
  rentExemptMinimumFor,
  simulateTransactionOrThrow,
  verifyInitialisedAccount,
  type SimulatableTransaction,
  type SimulationCapableConnection,
  type SolanaAccountLayoutName,
} from "@wafflefinance/sdk/solana";
import {
  isSolanaPlaceholder,
  checkSolanaConfig,
  type SolanaConfigStatus,
} from "@wafflefinance/config";

/**
 * Solana settlement capabilities exposed to the relayer.
 *
 * When placeholder mode is active, all operations throw
 * `SolanaDisabledError` immediately. When configured, operations
 * perform real Solana RPC calls and transaction submission.
 */
export interface SolanaIntegration {
  /**
   * Returns the current mode: "placeholder" when Solana is disabled,
   * "configured" when a real program ID is set.
   */
  readonly mode: SolanaConfigStatus;

  /**
   * The Solana HTLC program address, or undefined when in placeholder mode.
   */
  readonly programId: string | undefined;

  /**
   * Submit a lock transaction to the Solana HTLC program.
   *
   * @throws {SolanaDisabledError} when in placeholder mode
   * @throws {SolanaSubmissionError} on RPC or transaction failures
   */
  submitLock(params: SolanaLockParams): Promise<SolanaLockResult>;

  /**
   * Submit a claim transaction to the Solana HTLC program.
   *
   * @throws {SolanaDisabledError} when in placeholder mode
   * @throws {SolanaSubmissionError} on RPC or transaction failures
   */
  submitClaim(params: SolanaClaimParams): Promise<SolanaClaimResult>;

  /**
   * Submit a refund transaction to reclaim locked funds after timelock expiry.
   *
   * @throws {SolanaDisabledError} when in placeholder mode
   * @throws {SolanaSubmissionError} on RPC or transaction failures
   */
  submitRefund(params: SolanaRefundParams): Promise<SolanaRefundResult>;

  /**
   * Check whether the integration can handle Solana settlement.
   * Returns false when in placeholder mode, true when configured.
   */
  isEnabled(): boolean;

  /**
   * Validate a Solana address format.
   * Safe to call in both placeholder and configured modes.
   */
  validateAddress(address: string): boolean;
}

/** Parameters for creating a Solana HTLC lock. */
export interface SolanaLockParams {
  /** Beneficiary address (who can claim with the preimage) */
  beneficiary: string;
  /** Refund address (who can reclaim after timelock) */
  refundAddress: string;
  /** Amount to lock (in lamports) */
  amount: bigint;
  /** SHA256 hashlock */
  hashlock: string;
  /** Timelock (unix seconds) */
  timelock: number;
  /** Token mint address, or undefined for native SOL */
  tokenMint?: string;
}

/** Result of a successful Solana lock submission. */
export interface SolanaLockResult {
  /** Transaction signature */
  signature: string;
  /** On-chain order ID (if applicable) */
  orderId?: string;
  /** Block number/slot where the tx was confirmed */
  blockNumber: number;
}

/** Parameters for claiming a Solana HTLC. */
export interface SolanaClaimParams {
  /** Order ID to claim */
  orderId: string;
  /** Preimage (secret) to unlock */
  preimage: string;
  /** Claimer's address */
  claimer: string;
}

/** Result of a successful Solana claim submission. */
export interface SolanaClaimResult {
  /** Transaction signature */
  signature: string;
  /** Block number/slot where the tx was confirmed */
  blockNumber: number;
}

/** Parameters for refunding a Solana HTLC. */
export interface SolanaRefundParams {
  /** Order ID to refund */
  orderId: string;
  /** Refunder's address */
  refunder: string;
}

/** Result of a successful Solana refund submission. */
export interface SolanaRefundResult {
  /** Transaction signature */
  signature: string;
  /** Block number/slot where the tx was confirmed */
  blockNumber: number;
}

/** Thrown when Solana operations are attempted in placeholder mode. */
export class SolanaDisabledError extends Error {
  constructor(operation: string) {
    super(
      `Solana operation "${operation}" is disabled: SOLANA_HTLC_PROGRAM is not configured. ` +
      `Set SOLANA_HTLC_PROGRAM_TESTNET or SOLANA_HTLC_PROGRAM_MAINNET to enable Solana support.`
    );
    this.name = "SolanaDisabledError";
  }
}

/** Thrown on Solana RPC or transaction submission failures. */
export class SolanaSubmissionError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
    public readonly signature?: string
  ) {
    super(message);
    this.name = "SolanaSubmissionError";
  }
}

export function assertSolanaTransactionSucceeded(
  signature: string,
  operation: "claim" | "refund",
  transactionError: unknown
): void {
  if (transactionError !== null && transactionError !== undefined) {
    throw new SolanaSubmissionError(
      `Solana ${operation} transaction ${signature} was confirmed with an on-chain error`,
      transactionError,
      signature
    );
  }
}

export type SolanaTerminalOrderStatus =
  | typeof OrderStatus.Claimed
  | typeof OrderStatus.Refunded;

export interface SolanaOrderStatusVerificationOptions {
  orderId: string;
  signature: string;
  expectedStatus: SolanaTerminalOrderStatus;
  readStatus: () => Promise<number | null>;
  attempts?: number;
  retryDelayMs?: number;
}

/**
 * Wait until the order account reflects the confirmed claim/refund. A
 * successful send or confirmation response alone is not enough to report a
 * settlement success to callers.
 */
export async function verifySolanaOrderStatus(
  opts: SolanaOrderStatusVerificationOptions
): Promise<void> {
  const attempts = opts.attempts ?? 10;
  const retryDelayMs = opts.retryDelayMs ?? 500;
  const expectedName = opts.expectedStatus === OrderStatus.Claimed ? "claimed" : "refunded";
  let observedStatus: number | null = null;
  let lastReadError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      observedStatus = await opts.readStatus();
      lastReadError = undefined;

      if (observedStatus === opts.expectedStatus) return;

      if (
        observedStatus !== null &&
        observedStatus !== OrderStatus.Active &&
        observedStatus !== opts.expectedStatus
      ) {
        const actualName = observedStatus === OrderStatus.Claimed ? "claimed" : "refunded";
        throw new SolanaSubmissionError(
          `Solana order ${opts.orderId} is ${actualName} on-chain; expected ${expectedName} ` +
          `(signature ${opts.signature})`,
          undefined,
          opts.signature
        );
      }
    } catch (err) {
      if (err instanceof SolanaSubmissionError) throw err;
      lastReadError = err;
    }

    if (attempt < attempts) {
      await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }

  const observed = observedStatus === null
    ? "not yet visible"
    : observedStatus === OrderStatus.Active
      ? "still active"
      : `in unexpected status ${observedStatus}`;
  throw new SolanaSubmissionError(
    `Solana ${expectedName} transaction ${opts.signature} was submitted, but order ` +
    `${opts.orderId} is ${observed} after ${attempts} verification attempt(s)`,
    lastReadError,
    opts.signature
  );
}

/**
 * A pre- or post-initialisation safety rail failed: the rent exemption could
 * not be computed, the payer could not fund it, the target account was in an
 * illegal state, or the account created did not match the declared layout.
 *
 * Re-exported so relayer callers can catch it without depending on the SDK
 * directly, and so it is distinguishable from a generic submission failure.
 */
export { SolanaAccountInitError };

/**
 * Preflight for a `create_order`, run before any lamports are committed.
 *
 * Three checks, in order of cost:
 *
 *  1. **Rent from the cluster** for the account's real size. Never a hardcoded
 *     lamport figure: the rent table is a runtime parameter.
 *  2. **Payer solvency** for rent + amount + safety deposit + fee. An
 *     under-funded relayer keypair otherwise fails at execution with an opaque
 *     "insufficient funds" after the fee is spent.
 *  3. **Target account state.** `create_account` requires a zero-lamport,
 *     unallocated account, so an address that already holds lamports — or an
 *     already-initialised order — would revert with "already in use". Both are
 *     refused here with the account named in the message.
 *
 * Throws a `SolanaAccountInitError` subclass on the first failure. Nothing is
 * submitted, so a failure cannot leave a half-initialised account behind: the
 * program is never invoked.
 */
async function preflightCreateOrder(args: {
  connection: Connection;
  commitment: Commitment;
  programPk: PublicKey;
  orderPda: PublicKey;
  payer: PublicKey;
  mint: PublicKey;
  amount: bigint;
  safetyDeposit: bigint;
  layout: SolanaAccountLayoutName;
}): Promise<bigint> {
  const account = args.orderPda.toBase58();

  // 1. Rent exemption, derived from the account's real size (`layout` is the
  //    shared field table, not a literal) and asked of the cluster rather than
  //    hardcoded.
  const rentLamports = await rentExemptMinimumFor(args.connection, args.layout);

  // 2. Payer solvency: rent + locked funds + the transaction fee. For an SPL
  //    mint the tokens move from a token account, so only rent and the fee come
  //    out of the native balance.
  const balanceLamports = BigInt(
    await args.connection.getBalance(args.payer, args.commitment)
  );
  assertPayerCanFund({
    payer: args.payer,
    account,
    rentLamports,
    amountLamports: args.mint.toBase58() === NATIVE_SOL_MINT ? args.amount : 0n,
    safetyDepositLamports: args.safetyDeposit,
    // create_order is signed by the relayer keypair only.
    signatureCount: 1,
    balanceLamports,
  });

  // 3. The target must be absent. `getAccountInfo` returns null for a
  //    zero-lamport account, so a stray transfer to a future order address is
  //    indistinguishable from "does not exist" unless classified explicitly.
  const existing = await args.connection.getAccountInfo(args.orderPda, args.commitment);
  assertAccountIsUninitialised(classifyUninitialisedAccount(existing, args.programPk), {
    account,
    programId: args.programPk.toBase58(),
  });

  return rentLamports;
}

/**
 * Placeholder implementation: all operations fail fast with clear errors.
 * Used when SOLANA_HTLC_PROGRAM is unset or a placeholder value.
 */
class PlaceholderSolanaIntegration implements SolanaIntegration {
  readonly mode: SolanaConfigStatus = "placeholder";
  readonly programId: string | undefined = undefined;

  constructor(private readonly log: Logger) {}

  isEnabled(): boolean {
    return false;
  }

  validateAddress(address: string): boolean {
    // Basic Solana base58 address validation (32-byte pubkey)
    // This is a permissive check suitable for placeholder mode.
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
  }

  async submitLock(_params: SolanaLockParams): Promise<SolanaLockResult> {
    this.log.warn("Attempted Solana lock submission in placeholder mode");
    throw new SolanaDisabledError("submitLock");
  }

  async submitClaim(_params: SolanaClaimParams): Promise<SolanaClaimResult> {
    this.log.warn("Attempted Solana claim submission in placeholder mode");
    throw new SolanaDisabledError("submitClaim");
  }

  async submitRefund(_params: SolanaRefundParams): Promise<SolanaRefundResult> {
    this.log.warn("Attempted Solana refund submission in placeholder mode");
    throw new SolanaDisabledError("submitRefund");
  }
}

/**
 * Configured implementation: performs real Solana settlement operations.
 * Used when a real program ID is set in the environment.
 *
 * Uses the SDK's instruction builders to construct HTLC transactions and
 * @solana/web3.js to sign and submit them to the network.
 */
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/**
 * Decode a base-58 string to bytes.
 *
 * `Buffer.from(value, "base58")` throws `Unknown encoding: base58` — Node has
 * no such encoding — so the configured relayer could never load a base-58
 * `SOLANA_RELAYER_PRIVATE_KEY`, which is the format every Solana wallet and
 * `solana-keygen` emits. This is the standard bitcoin-alphabet decoder, kept
 * local so the relayer gains no new dependency.
 */
function decodeBase58(input: string): Uint8Array {
  if (input.length === 0) {
    throw new SolanaSubmissionError("SOLANA_RELAYER_PRIVATE_KEY is empty");
  }

  const bytes: number[] = [0];
  for (const char of input) {
    const value = BASE58_ALPHABET.indexOf(char);
    if (value === -1) {
      // The offending character is not included: it is a byte of the secret.
      throw new SolanaSubmissionError(
        "SOLANA_RELAYER_PRIVATE_KEY is not valid base-58: it contains a character outside the base-58 alphabet"
      );
    }
    let carry = value;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  // Each leading "1" is a leading zero byte.
  for (let i = 0; i < input.length && input[i] === "1"; i++) {
    bytes.push(0);
  }

  return Uint8Array.from(bytes.reverse());
}

/**
 * Load the relayer signing key, or return `undefined` with a warning.
 *
 * Accepts base-58 (what `solana-keygen` and every wallet emit), `0x`-hex, and a
 * JSON byte array. A missing or malformed key is reported once at startup
 * rather than thrown: the relayer still needs to boot so the operator can see
 * the problem, and every submission path fails loudly via `requireSigner`.
 */
function loadRelayerKeypair(privateKey: string, log: Logger): Keypair | undefined {
  const trimmed = privateKey.trim();

  if (trimmed.length === 0) {
    log.warn(
      "Solana is configured but SOLANA_RELAYER_PRIVATE_KEY is not set. " +
        "The relayer will start but cannot sign or settle orders."
    );
    return undefined;
  }

  try {
    let secretKey: Uint8Array;
    if (trimmed.startsWith("[")) {
      // JSON array format: [1,2,3,...]
      secretKey = new Uint8Array(JSON.parse(trimmed) as number[]);
    } else if (trimmed.startsWith("0x")) {
      const hex = trimmed.slice(2);
      if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
        throw new Error("not valid hex");
      }
      secretKey = new Uint8Array(Buffer.from(hex, "hex"));
    } else {
      secretKey = decodeBase58(trimmed);
    }

    // A Solana secret key is exactly 64 bytes (32-byte seed + 32-byte public
    // key). Reject anything else here, where the cause is still obvious.
    if (secretKey.length !== 64) {
      throw new Error(
        `decoded to ${secretKey.length} bytes, expected 64 — check that this is a ` +
          "secret key and not a public key or address"
      );
    }

    return Keypair.fromSecretKey(secretKey);
  } catch (error) {
    // Deliberately NOT logging `error`: a JSON.parse failure in V8 echoes the
    // offending input into its message, which would put a slice of
    // SOLANA_RELAYER_PRIVATE_KEY into the logs. The error class is enough to
    // tell a malformed key from a bad length, and the operator has the source
    // of the value anyway.
    log.error(
      { errorType: error instanceof Error ? error.name : typeof error },
      "SOLANA_RELAYER_PRIVATE_KEY could not be loaded. The relayer will start " +
        "but cannot sign or settle orders. Set it to a 64-byte secret key as " +
        "base-58, 0x-hex, or a JSON byte array."
    );
    return undefined;
  }
}

class ConfiguredSolanaIntegration implements SolanaIntegration {
  readonly mode: SolanaConfigStatus = "configured";
  private readonly rpcProvider: SolanaRpcProvider;
  private readonly connection: Connection;
  /**
   * Undefined when no usable key was configured. Construction must still
   * succeed so the process can start and report the misconfiguration, but every
   * submission fails through {@link requireSigner}.
   */
  private readonly keypair: Keypair | undefined;
  private readonly programPk: PublicKey;
  private readonly commitment: Commitment;

  constructor(
    readonly programId: string,
    private readonly log: Logger,
    private readonly rpcUrl: string,
    privateKey: string,
    commitment: Commitment = "confirmed"
  ) {
    this.programPk = new PublicKey(programId);
    this.commitment = commitment;
    this.rpcProvider = createSolanaRpcProvider(rpcUrl, commitment);
    // Keep a direct Connection for callers that build Transactions themselves.
    this.connection = this.rpcProvider.getConnection();
    this.keypair = loadRelayerKeypair(privateKey, log);
  }

  /**
   * The signing key, or a clear error explaining how to fix its absence.
   *
   * Every `submit*` path goes through here, so a relayer started without a key
   * fails with an actionable message instead of a `TypeError` on `undefined`.
   */
  private requireSigner(): Keypair {
    if (!this.keypair) {
      throw new SolanaSubmissionError(
        "Cannot sign Solana transaction: no usable SOLANA_RELAYER_PRIVATE_KEY was configured. " +
          "Provide a 64-byte secret key as base-58, 0x-hex, or a JSON byte array. " +
          "The relayer can start without one, but it cannot settle orders."
      );
    }
    return this.keypair;
  }

  isEnabled(): boolean {
    return true;
  }

  private async readOrderStatus(orderId: string): Promise<number | null> {
    const orderPda = new PublicKey(orderId);
    const info = await this.rpcProvider.withFallback(
      (conn) => conn.getAccountInfo(orderPda, this.commitment),
      `getAccountInfo(${orderId.slice(0, 8)}…)`
    );
    if (!info) return null;
    if (!info.owner.equals(this.programPk)) {
      throw new Error(`Solana order ${orderId} is owned by ${info.owner.toBase58()}, not the configured HTLC program`);
    }
    return deserialiseOrderAccount(Buffer.from(info.data), orderId).status;
  }

  validateAddress(address: string): boolean {
    try {
      new PublicKey(address);
      return true;
    } catch {
      return false;
    }
  }

  async submitLock(params: SolanaLockParams): Promise<SolanaLockResult> {
    if (!this.keypair) {
      throw new SolanaSubmissionError(
        "Solana private key is required for lock submission but was not provided or is invalid."
      );
    }

    const hashlockHex = params.hashlock.startsWith("0x")
      ? params.hashlock
      : `0x${params.hashlock}`;
    const hashlockBytes = Buffer.from(hashlockHex.slice(2), "hex");
    const mint = params.tokenMint ?? NATIVE_SOL_MINT;
    const timelockAbsolute = params.timelock;

    this.log.info(
      {
        programId: this.programId,
        beneficiary: params.beneficiary,
        amount: params.amount.toString(),
        hashlock: params.hashlock,
        timelock: timelockAbsolute,
        payer:         this.requireSigner().publicKey.toBase58(),
      },
      "Submitting Solana lock transaction"
    );

    const { instruction, orderPda } = buildCreateOrderInstruction(
      this.programPk,
      {
        payer:         this.requireSigner().publicKey,
        beneficiary: new PublicKey(params.beneficiary),
        refundAddress: new PublicKey(params.refundAddress),
        mint: new PublicKey(mint),
        amount: params.amount,
        safetyDeposit: BigInt(0),
        hashlockBytes,
        timelockAbsolute,
      }
    );

    try {
      // ── Preflight ────────────────────────────────────────────────────────
      // Nothing is submitted until rent is known, the payer is proven solvent,
      // and the target PDA is proven absent. Runs first so a misconfiguration
      // costs no fee and creates no half-initialised account.
      await preflightCreateOrder({
        connection: this.connection,
        commitment: this.commitment,
        programPk: this.programPk,
        orderPda,
        payer:         this.requireSigner().publicKey,
        mint: new PublicKey(mint),
        amount: params.amount,
        safetyDeposit: BigInt(0),
        layout: "htlcOrder",
      });

      const { blockhash } = await this.rpcProvider.withFallback(
        (conn) => conn.getLatestBlockhash(this.commitment),
        "getLatestBlockhash(lock)"
      );
      const tx = new Transaction({
        recentBlockhash: blockhash,
        feePayer:         this.requireSigner().publicKey,
      });
      tx.add(instruction);
      tx.partialSign(this.requireSigner());

      const serialized = tx.serialize();

      // Explicit simulation rather than relying on sendRawTransaction's
      // implicit preflight: the implicit one rejects the transaction but
      // discards the program logs, so a rejected `create_order` arrives as a
      // bare "Custom program error: 0x…" with no indication of which on-chain
      // check fired.
      await simulateTransactionOrThrow(
        this.connection as unknown as SimulationCapableConnection,
        tx as unknown as SimulatableTransaction,
        { account: orderPda.toBase58() }
      );

      const sig = await this.rpcProvider.withFallback(
        (conn) => conn.sendRawTransaction(serialized, {
          // The simulation above *is* the preflight; repeating it would only
          // cost a round trip.
          skipPreflight: true,
          maxRetries: 3,
        }),
        "sendRawTransaction(lock)"
      );
      await this.rpcProvider.withFallback(
        (conn) => conn.confirmTransaction(sig, this.commitment),
        "confirmTransaction(lock)"
      );

      // ── Post-init verification ──────────────────────────────────────────
      // A confirmed transaction is not proof of a correct account: the program
      // can exit successfully having written a truncated or un-funded account.
      // Re-read it and check owner, exact data length, and rent exemption.
      const account = await verifyInitialisedAccount(
        this.connection,
        orderPda,
        "htlcOrder",
        { expectedOwner: this.programPk, commitment: this.commitment }
      );

      const slot = await this.rpcProvider.withFallback(
        (conn) => conn.getSlot(this.commitment),
        "getSlot(lock)"
      );

      this.log.info(
        {
          signature: sig,
          orderId: orderPda.toBase58(),
          slot,
          accountBytes: account.dataLength,
          accountLamports: account.lamports.toString(),
          rentExemptMinimum: account.rentExemptMinimum.toString(),
        },
        "Solana lock transaction confirmed and account verified"
      );

      return {
        signature: sig,
        orderId: orderPda.toBase58(),
        blockNumber: slot,
      };
    } catch (err) {
      // A rejected simulation carries the program logs; keep them on the error
      // rather than letting the catch block flatten them into a string.
      const simulationLogs = err instanceof SolanaAccountInitError
        ? err.simulationLogs
        : undefined;
      this.log.error(
        { err, hashlock: params.hashlock, simulationLogs },
        "Solana lock submission failed"
      );
      throw new SolanaSubmissionError(
        `Solana lock submission failed: ${err instanceof Error ? err.message : String(err)}`,
        err,
        simulationLogs
      );
    }
  }

  async submitClaim(params: SolanaClaimParams): Promise<SolanaClaimResult> {
    if (!this.keypair) {
      throw new SolanaSubmissionError(
        "Solana private key is required for claim submission but was not provided or is invalid."
      );
    }

    const preimageHex = params.preimage.startsWith("0x")
      ? params.preimage
      : `0x${params.preimage}`;
    const preimageBytes = Buffer.from(preimageHex.slice(2), "hex");
    const orderPda = new PublicKey(params.orderId);

    this.log.info(
      {
        programId: this.programId,
        orderId: params.orderId,
        claimer: params.claimer,
      },
      "Submitting Solana claim transaction"
    );

    const ix = buildClaimOrderInstruction(this.programPk, {
      claimer:         this.requireSigner().publicKey,
      orderPda,
      beneficiaryAccount:         this.requireSigner().publicKey,
      preimageBytes,
    });

    let signature: string | undefined;
    try {
      const { blockhash } = await this.rpcProvider.withFallback(
        (conn) => conn.getLatestBlockhash(this.commitment),
        "getLatestBlockhash(claim)"
      );
      const tx = new Transaction({
        recentBlockhash: blockhash,
        feePayer:         this.requireSigner().publicKey,
      });
      tx.add(ix);
      tx.partialSign(this.requireSigner());

      const submittedSignature = await this.rpcProvider.withFallback(
        (conn) => conn.sendRawTransaction(tx.serialize(), {
          skipPreflight: false,
          maxRetries: 3,
        }),
        "sendRawTransaction(claim)"
      );
      signature = submittedSignature;
      const confirmation = await this.rpcProvider.withFallback(
        (conn) => conn.confirmTransaction(submittedSignature, this.commitment),
        "confirmTransaction(claim)"
      );
      assertSolanaTransactionSucceeded(submittedSignature, "claim", confirmation.value.err);

      await verifySolanaOrderStatus({
        orderId: params.orderId,
        signature: submittedSignature,
        expectedStatus: OrderStatus.Claimed,
        readStatus: () => this.readOrderStatus(params.orderId),
      });

      this.log.info(
        { signature: submittedSignature, orderId: params.orderId, slot: confirmation.context.slot },
        "Solana claim transaction confirmed and verified on-chain"
      );

      return {
        signature: submittedSignature,
        blockNumber: confirmation.context.slot,
      };
    } catch (err) {
      this.log.error({ err, orderId: params.orderId }, "Solana claim submission failed");
      if (err instanceof SolanaSubmissionError) throw err;
      throw new SolanaSubmissionError(
        `Solana claim submission failed${signature ? ` (signature ${signature})` : ""}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
        err,
        signature
      );
    }
  }

  async submitRefund(params: SolanaRefundParams): Promise<SolanaRefundResult> {
    if (!this.keypair) {
      throw new SolanaSubmissionError(
        "Solana private key is required for refund submission but was not provided or is invalid."
      );
    }

    const orderPda = new PublicKey(params.orderId);

    this.log.info(
      {
        programId: this.programId,
        orderId: params.orderId,
        refunder: params.refunder,
      },
      "Submitting Solana refund transaction"
    );

    const ix = buildRefundOrderInstruction(this.programPk, {
      refunder:         this.requireSigner().publicKey,
      orderPda,
      refundAccount:         this.requireSigner().publicKey,
    });

    let signature: string | undefined;
    try {
      const { blockhash } = await this.rpcProvider.withFallback(
        (conn) => conn.getLatestBlockhash(this.commitment),
        "getLatestBlockhash(refund)"
      );
      const tx = new Transaction({
        recentBlockhash: blockhash,
        feePayer:         this.requireSigner().publicKey,
      });
      tx.add(ix);
      tx.partialSign(this.requireSigner());

      const submittedSignature = await this.rpcProvider.withFallback(
        (conn) => conn.sendRawTransaction(tx.serialize(), {
          skipPreflight: false,
          maxRetries: 3,
        }),
        "sendRawTransaction(refund)"
      );
      signature = submittedSignature;
      const confirmation = await this.rpcProvider.withFallback(
        (conn) => conn.confirmTransaction(submittedSignature, this.commitment),
        "confirmTransaction(refund)"
      );
      assertSolanaTransactionSucceeded(submittedSignature, "refund", confirmation.value.err);

      await verifySolanaOrderStatus({
        orderId: params.orderId,
        signature: submittedSignature,
        expectedStatus: OrderStatus.Refunded,
        readStatus: () => this.readOrderStatus(params.orderId),
      });

      this.log.info(
        { signature: submittedSignature, orderId: params.orderId, slot: confirmation.context.slot },
        "Solana refund transaction confirmed and verified on-chain"
      );

      return {
        signature: submittedSignature,
        blockNumber: confirmation.context.slot,
      };
    } catch (err) {
      this.log.error({ err, orderId: params.orderId }, "Solana refund submission failed");
      if (err instanceof SolanaSubmissionError) throw err;
      throw new SolanaSubmissionError(
        `Solana refund submission failed${signature ? ` (signature ${signature})` : ""}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
        err,
        signature
      );
    }
  }
}

/**
 * Factory function: create the appropriate Solana integration based on
 * the program ID. Logs the decision explicitly so operators see whether
 * Solana is enabled or disabled.
 *
 * @param programId - The Solana HTLC program address (from env)
 * @param log - Pino logger instance
 * @param rpcUrl - Solana RPC URL (only used when configured)
 * @param privateKey - Solana private key for signing (only used when configured)
 * @param commitment - Solana commitment level (default: "confirmed")
 * @returns SolanaIntegration instance (placeholder or configured)
 */
export function createSolanaIntegration(
  programId: string | undefined,
  log: Logger,
  rpcUrl: string,
  privateKey?: string,
  commitment: Commitment = "confirmed"
): SolanaIntegration {
  const status = checkSolanaConfig(programId);

  if (status === "placeholder") {
    log.warn(
      "Solana integration is in PLACEHOLDER mode: all Solana operations are disabled. " +
      "Set SOLANA_HTLC_PROGRAM_TESTNET or SOLANA_HTLC_PROGRAM_MAINNET to enable."
    );
    return new PlaceholderSolanaIntegration(log);
  }

  // status === "configured"
  if (!privateKey) {
    log.warn(
      "Solana program is configured but SOLANA_PRIVATE_KEY is not set. " +
      "Solana settlement operations will fail at runtime."
    );
  }

  log.info(
    { programId, rpcUrl },
    "Solana integration is CONFIGURED: Solana settlement is enabled."
  );
  return new ConfiguredSolanaIntegration(programId!, log, rpcUrl, privateKey ?? "", commitment);
}

/**
 * Type guard: check if a Solana integration is in configured mode.
 * Useful for conditional logic that needs to branch on mode.
 */
export function isConfiguredSolana(
  integration: SolanaIntegration
): integration is ConfiguredSolanaIntegration {
  return integration.mode === "configured";
}
