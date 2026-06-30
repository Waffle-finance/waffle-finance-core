/**
 * Normalised adapter for SolanaHTLCClient.
 *
 * Wraps the native Anchor-based client and implements the shared IHTLCClient
 * interface. Solana's signing model uses a `SolanaSigner` object (Phantom /
 * Backpack / headless keypair), which is required on every mutating call.
 *
 * Error mapping
 * ─────────────
 * Solana RPC / program errors are caught and re-thrown as HTLCError instances
 * with stable machine-readable codes.
 */

import {
  SolanaHTLCClient,
  type SolanaCreateOrderInput,
  type SolanaSigner,
} from "./index.js";
import {
  HTLCError,
  type IHTLCClient,
  type HTLCCreateResult,
  type HTLCTxResult,
} from "../htlc-client.js";

// ── Error classification ─────────────────────────────────────────────────────

function classifySolanaError(err: unknown): HTLCError {
  const msg = err instanceof Error ? err.message : String(err);
  const lc = msg.toLowerCase();

  if (lc.includes("simulation mode")) {
    return new HTLCError({
      code: "simulation_mode",
      message: "SolanaHTLCClient is in simulation mode — no real on-chain call was made: " + msg,
      retryable: false,
      cause: err,
    });
  }

  if (lc.includes("discriminator")) {
    return new HTLCError({
      code: "order_not_found",
      message: "Solana account discriminator mismatch — order not found or wrong program: " + msg,
      retryable: false,
      cause: err,
    });
  }

  if (lc.includes("version")) {
    return new HTLCError({
      code: "chain_error",
      message: "Solana IDL version mismatch — upgrade the SDK: " + msg,
      retryable: false,
      cause: err,
    });
  }

  if (lc.includes("timelock") || lc.includes("not expired")) {
    return new HTLCError({
      code: "timelock_not_expired",
      message: "Timelock has not yet expired: " + msg,
      retryable: false,
      cause: err,
    });
  }

  if (lc.includes("invalid preimage") || lc.includes("hashlock")) {
    return new HTLCError({
      code: "invalid_preimage",
      message: "Preimage does not match hashlock: " + msg,
      retryable: false,
      cause: err,
    });
  }

  if (
    lc.includes("account not found") ||
    lc.includes("does not exist") ||
    lc.includes("too small")
  ) {
    return new HTLCError({
      code: "order_not_found",
      message: "Solana order account not found: " + msg,
      retryable: false,
      cause: err,
    });
  }

  return new HTLCError({
    code: "chain_error",
    message: "Solana chain error: " + msg,
    retryable: lc.includes("timeout") || lc.includes("network") || lc.includes("blockhash"),
    cause: err,
  });
}

// ── Adapter ──────────────────────────────────────────────────────────────────

/**
 * Normalised adapter that wraps `SolanaHTLCClient` and implements the
 * chain-agnostic `IHTLCClient` interface.
 *
 * `orderId` on Solana is the base-58 PDA address, which is deterministically
 * derived from the hashlock and does not require an extra network call.
 */
export class SolanaHTLCAdapter
  implements IHTLCClient<SolanaCreateOrderInput, SolanaSigner>
{
  constructor(private readonly client: SolanaHTLCClient) {}

  /**
   * Lock SOL/SPL tokens in an HTLC order PDA.
   *
   * @returns `{ txId, orderId }` where `orderId` is the base-58 PDA address.
   */
  async createOrder(
    input: SolanaCreateOrderInput,
    signer: SolanaSigner
  ): Promise<HTLCCreateResult> {
    try {
      const { txSignature, orderId } = await this.client.createOrder(input, signer);
      return { txId: txSignature, orderId };
    } catch (err) {
      if (err instanceof HTLCError) throw err;
      throw classifySolanaError(err);
    }
  }

  /**
   * Reveal the preimage on-chain to claim locked SOL/SPL tokens.
   *
   * @param orderId  Base-58 PDA address of the order.
   * @param preimage 0x-prefixed 32-byte hex preimage.
   * @param signer   Phantom / Backpack / headless keypair signer.
   */
  async claimOrder(
    orderId: string,
    preimage: `0x${string}`,
    signer: SolanaSigner
  ): Promise<HTLCTxResult> {
    try {
      const sig = await this.client.claimOrder(orderId, preimage, signer);
      return { txId: sig };
    } catch (err) {
      if (err instanceof HTLCError) throw err;
      throw classifySolanaError(err);
    }
  }

  /**
   * Reclaim locked tokens after timelock expiry.
   *
   * @param orderId Base-58 PDA address.
   * @param signer  Signer controlling the refund_address stored in the order.
   */
  async refundOrder(orderId: string, signer: SolanaSigner): Promise<HTLCTxResult> {
    try {
      const sig = await this.client.refundOrder(orderId, signer);
      return { txId: sig };
    } catch (err) {
      if (err instanceof HTLCError) throw err;
      throw classifySolanaError(err);
    }
  }
}
