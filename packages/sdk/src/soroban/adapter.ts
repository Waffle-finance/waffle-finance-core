/**
 * Normalised adapter for SorobanHTLCClient.
 *
 * Wraps the native Stellar SDK client and implements the shared IHTLCClient
 * interface. Soroban's signing model uses a callback (`SorobanSigner`), so the
 * signer is a required argument on all mutating methods.
 *
 * Error mapping
 * ─────────────
 * Soroban simulation/submit errors are caught and re-thrown as HTLCError
 * instances with stable machine-readable codes. The original error is
 * preserved in HTLCError.cause.
 */

import {
  SorobanHTLCClient,
  type SorobanCreateOrderInput,
  type SorobanSigner,
} from "./index.js";
import {
  HTLCError,
  type IHTLCClient,
  type HTLCCreateResult,
  type HTLCTxResult,
} from "../htlc-client.js";

// ── Error classification ─────────────────────────────────────────────────────

function classifySorobanError(err: unknown): HTLCError {
  const msg = err instanceof Error ? err.message : String(err);
  const lc = msg.toLowerCase();

  if (lc.includes("simulation failed")) {
    return new HTLCError({
      code: "simulation_failed",
      message: "Soroban simulation rejected the call: " + msg,
      retryable: false,
      cause: err,
    });
  }

  if (lc.includes("submit failed") || lc.includes("error")) {
    return new HTLCError({
      code: "tx_rejected",
      message: "Soroban transaction was rejected: " + msg,
      retryable: lc.includes("timeout") || lc.includes("network"),
      cause: err,
    });
  }

  if (lc.includes("hashlock") || lc.includes("preimage")) {
    return new HTLCError({
      code: "invalid_preimage",
      message: "Preimage does not match hashlock: " + msg,
      retryable: false,
      cause: err,
    });
  }

  if (lc.includes("timelock")) {
    return new HTLCError({
      code: "timelock_not_expired",
      message: "Timelock has not yet expired: " + msg,
      retryable: false,
      cause: err,
    });
  }

  return new HTLCError({
    code: "chain_error",
    message: "Soroban chain error: " + msg,
    retryable: lc.includes("timeout") || lc.includes("network"),
    cause: err,
  });
}

// ── Adapter ──────────────────────────────────────────────────────────────────

/**
 * Input shape for createOrder on the normalised Soroban adapter.
 *
 * The caller id (`sender`) is always read from the signer's `publicKey` field,
 * so consumers do not need to repeat it in the input shape.
 */
export type SorobanAdapterCreateInput = SorobanCreateOrderInput;

/**
 * Normalised adapter that wraps `SorobanHTLCClient` and implements the
 * chain-agnostic `IHTLCClient` interface.
 *
 * For Soroban, the caller account id must be included in `createOrder` input
 * (as `sender`) and passed explicitly to `claimOrder` / `refundOrder` as
 * `callerAccountId`. The `signer` argument is required on all mutating calls.
 *
 * claimOrder / refundOrder extra options
 * ──────────────────────────────────────
 * Because the Soroban client requires `callerAccountId` separately from the
 * orderId, these methods accept it as part of the `orderId` string by encoding
 * it as `"<callerAccountId>:<orderId>"`. Callers should use the
 * `encodeSorobanOrderRef` / `decodeSorobanOrderRef` helpers.
 */
export class SorobanHTLCAdapter
  implements IHTLCClient<SorobanAdapterCreateInput, SorobanSigner>
{
  constructor(private readonly client: SorobanHTLCClient) {}

  /**
   * Create a Soroban HTLC order.
   *
   * @returns `{ txId, orderId }` where `txId` and `orderId` are both the
   *          Stellar transaction hash (Soroban orders are keyed by hashlock,
   *          not by an on-chain sequence number).
   */
  async createOrder(
    input: SorobanAdapterCreateInput,
    signer: SorobanSigner
  ): Promise<HTLCCreateResult> {
    try {
      const txHash = await this.client.createOrder(input, signer);
      // Soroban does not return a discrete orderId from createOrder — the
      // canonical reference is the transaction hash. We encode a reference
      // that claimOrder/refundOrder can decode.
      const orderId = encodeSorobanOrderRef(input.sender, txHash);
      return { txId: txHash, orderId };
    } catch (err) {
      if (err instanceof HTLCError) throw err;
      throw classifySorobanError(err);
    }
  }

  /**
   * Claim a Soroban HTLC order.
   *
   * @param orderId  Either a plain `bigint`-string order id, or an encoded
   *                 `"<callerAccountId>:<numericOrderId>"` ref produced by
   *                 `encodeSorobanOrderRef`.
   * @param preimage 0x-prefixed 32-byte hex preimage.
   * @param signer   Soroban signing callback.
   */
  async claimOrder(
    orderId: string,
    preimage: `0x${string}`,
    signer: SorobanSigner
  ): Promise<HTLCTxResult> {
    try {
      const { callerAccountId, numericId } = decodeSorobanOrderRef(orderId);
      const txHash = await this.client.claimOrder(
        callerAccountId,
        BigInt(numericId),
        preimage,
        signer
      );
      return { txId: txHash };
    } catch (err) {
      if (err instanceof HTLCError) throw err;
      throw classifySorobanError(err);
    }
  }

  /**
   * Refund a Soroban HTLC order after timelock expiry.
   *
   * @param orderId  Either a plain numeric string, or an encoded ref.
   * @param signer   Soroban signing callback.
   */
  async refundOrder(
    orderId: string,
    signer: SorobanSigner
  ): Promise<HTLCTxResult> {
    try {
      const { callerAccountId, numericId } = decodeSorobanOrderRef(orderId);
      const txHash = await this.client.refundOrder(
        callerAccountId,
        BigInt(numericId),
        signer
      );
      return { txId: txHash };
    } catch (err) {
      if (err instanceof HTLCError) throw err;
      throw classifySorobanError(err);
    }
  }
}

// ── Encoding helpers ─────────────────────────────────────────────────────────
// Soroban requires both a `callerAccountId` (Stellar G-address) and a numeric
// `orderId` (bigint). We pack them into a single string so the normalised
// interface's single `orderId: string` parameter carries both pieces of data.
//
// Format:  "<callerAccountId>:<numericOrderId>"
// Example: "GABC...XYZ:42"

const SEPARATOR = ":";

/**
 * Encode a Soroban caller account id and numeric order id into the single
 * `orderId` string consumed by the normalised adapter.
 */
export function encodeSorobanOrderRef(
  callerAccountId: string,
  numericOrderId: string | bigint | number
): string {
  return `${callerAccountId}${SEPARATOR}${String(numericOrderId)}`;
}

/**
 * Decode a Soroban order ref back into its two components.
 *
 * If the string does not contain the separator it is treated as a pure numeric
 * id with an empty callerAccountId, allowing compatibility with callers that
 * pass a plain bigint-string.
 */
export function decodeSorobanOrderRef(orderId: string): {
  callerAccountId: string;
  numericId: string;
} {
  const sepIdx = orderId.indexOf(SEPARATOR);
  if (sepIdx === -1) {
    return { callerAccountId: "", numericId: orderId };
  }
  return {
    callerAccountId: orderId.slice(0, sepIdx),
    numericId: orderId.slice(sepIdx + 1),
  };
}
