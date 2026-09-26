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
  SolanaRpcProvider,
  createSolanaRpcProvider,
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
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "SolanaSubmissionError";
  }
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
class ConfiguredSolanaIntegration implements SolanaIntegration {
  readonly mode: SolanaConfigStatus = "configured";
  private readonly rpcProvider: SolanaRpcProvider;
  private readonly connection: Connection;
  private readonly keypair: Keypair;
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

    // Parse the private key — supports both base-58 and hex formats.
    let secretKey: Uint8Array;
    if (privateKey.startsWith("[")) {
      // JSON array format: [1,2,3,...]
      secretKey = new Uint8Array(JSON.parse(privateKey));
    } else if (privateKey.startsWith("0x")) {
      // Hex format: 0x...
      const hex = privateKey.slice(2);
      secretKey = new Uint8Array(Buffer.from(hex, "hex"));
    } else {
      // Base-58 format
      secretKey = Uint8Array.from(
        Buffer.from(privateKey, "base58")
      );
    }
    this.keypair = Keypair.fromSecretKey(secretKey);
  }

  isEnabled(): boolean {
    return true;
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
        payer: this.keypair.publicKey.toBase58(),
      },
      "Submitting Solana lock transaction"
    );

    const { instruction, orderPda } = buildCreateOrderInstruction(
      this.programPk,
      {
        payer: this.keypair.publicKey,
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
      const { blockhash } = await this.rpcProvider.withFallback(
        (conn) => conn.getLatestBlockhash(this.commitment),
        "getLatestBlockhash(lock)"
      );
      const tx = new Transaction({
        recentBlockhash: blockhash,
        feePayer: this.keypair.publicKey,
      });
      tx.add(instruction);
      tx.partialSign(this.keypair);

      const sig = await this.rpcProvider.withFallback(
        (conn) => conn.sendRawTransaction(tx.serialize(), {
          skipPreflight: false,
          maxRetries: 3,
        }),
        "sendRawTransaction(lock)"
      );
      await this.rpcProvider.withFallback(
        (conn) => conn.confirmTransaction(sig, this.commitment),
        "confirmTransaction(lock)"
      );

      const slot = await this.rpcProvider.withFallback(
        (conn) => conn.getSlot(this.commitment),
        "getSlot(lock)"
      );

      this.log.info(
        { signature: sig, orderId: orderPda.toBase58(), slot },
        "Solana lock transaction confirmed"
      );

      return {
        signature: sig,
        orderId: orderPda.toBase58(),
        blockNumber: slot,
      };
    } catch (err) {
      this.log.error({ err, hashlock: params.hashlock }, "Solana lock submission failed");
      throw new SolanaSubmissionError(
        `Solana lock submission failed: ${err instanceof Error ? err.message : String(err)}`,
        err
      );
    }
  }

  async submitClaim(params: SolanaClaimParams): Promise<SolanaClaimResult> {
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
      claimer: this.keypair.publicKey,
      orderPda,
      beneficiaryAccount: this.keypair.publicKey,
      preimageBytes,
    });

    try {
      const { blockhash } = await this.rpcProvider.withFallback(
        (conn) => conn.getLatestBlockhash(this.commitment),
        "getLatestBlockhash(claim)"
      );
      const tx = new Transaction({
        recentBlockhash: blockhash,
        feePayer: this.keypair.publicKey,
      });
      tx.add(ix);
      tx.partialSign(this.keypair);

      const sig = await this.rpcProvider.withFallback(
        (conn) => conn.sendRawTransaction(tx.serialize(), {
          skipPreflight: false,
          maxRetries: 3,
        }),
        "sendRawTransaction(claim)"
      );
      await this.rpcProvider.withFallback(
        (conn) => conn.confirmTransaction(sig, this.commitment),
        "confirmTransaction(claim)"
      );

      const slot = await this.rpcProvider.withFallback(
        (conn) => conn.getSlot(this.commitment),
        "getSlot(claim)"
      );

      this.log.info(
        { signature: sig, orderId: params.orderId, slot },
        "Solana claim transaction confirmed"
      );

      return {
        signature: sig,
        blockNumber: slot,
      };
    } catch (err) {
      this.log.error({ err, orderId: params.orderId }, "Solana claim submission failed");
      throw new SolanaSubmissionError(
        `Solana claim submission failed: ${err instanceof Error ? err.message : String(err)}`,
        err
      );
    }
  }

  async submitRefund(params: SolanaRefundParams): Promise<SolanaRefundResult> {
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
      refunder: this.keypair.publicKey,
      orderPda,
      refundAccount: this.keypair.publicKey,
    });

    try {
      const { blockhash } = await this.rpcProvider.withFallback(
        (conn) => conn.getLatestBlockhash(this.commitment),
        "getLatestBlockhash(refund)"
      );
      const tx = new Transaction({
        recentBlockhash: blockhash,
        feePayer: this.keypair.publicKey,
      });
      tx.add(ix);
      tx.partialSign(this.keypair);

      const sig = await this.rpcProvider.withFallback(
        (conn) => conn.sendRawTransaction(tx.serialize(), {
          skipPreflight: false,
          maxRetries: 3,
        }),
        "sendRawTransaction(refund)"
      );
      await this.rpcProvider.withFallback(
        (conn) => conn.confirmTransaction(sig, this.commitment),
        "confirmTransaction(refund)"
      );

      const slot = await this.rpcProvider.withFallback(
        (conn) => conn.getSlot(this.commitment),
        "getSlot(refund)"
      );

      this.log.info(
        { signature: sig, orderId: params.orderId, slot },
        "Solana refund transaction confirmed"
      );

      return {
        signature: sig,
        blockNumber: slot,
      };
    } catch (err) {
      this.log.error({ err, orderId: params.orderId }, "Solana refund submission failed");
      throw new SolanaSubmissionError(
        `Solana refund submission failed: ${err instanceof Error ? err.message : String(err)}`,
        err
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
