/**
 * Normalised adapter for SorobanHTLCClient.
 *
 * Wraps the native Stellar SDK client and implements the shared IHTLCClient
 * interface. Soroban's signing model uses a callback (`SorobanSigner`), so the
 * signer is a required argument on all mutating methods.
 *
 * Error mapping
 * ─────────────
 * Soroban orchestration errors are already HTLCError instances (thrown by the
 * orchestration layer). Other errors are caught and re-thrown as HTLCError
 * instances with stable machine-readable codes. The original error is preserved
 * in HTLCError.cause, and submission metadata (attempts, fee-bump history) is
 * available in HTLCError.submissionMeta for orchestrated calls.
 *
 * Orchestration configuration
 * ───────────────────────────
 * Pass an optional `OrchestrationConfig` as the second constructor argument to
 * override retry count, polling interval, and fee-bump cap on a per-adapter
 * basis. These values take precedence over any defaults baked into the client.
 */

import {
  SorobanHTLCClient,
  type SorobanCreateOrderInput,
  type SorobanSigner,
  type OrchestrationConfig,
} from "./index.js";
import {
  HTLCError,
  type IHTLCClient,
  type HTLCCreateResult,
  type HTLCTxResult,
} from "../htlc-client.js";

// ── Error classification ─────────────────────────────────────────────────────
// The orchestration layer already throws HTLCError for all orchestrated calls.
// This classifier handles any residual non-orchestrated errors (e.g. getOrder,
// construction-time failures) that slip through as plain Errors.
//
// Classifier order matters: more-specific patterns appear before catch-alls.

function classifySorobanError(err: unknown): HTLCError {
  if (err instanceof HTLCError) return err;

  const msg = err instanceof Error ? err.message : String(err);
  const lc = msg.toLowerCase();

  // Network / RPC connectivity failures — always retryable transient errors.
  if (
    lc.includes("timeout") ||
    lc.includes("etimedout") ||
    lc.includes("econnreset") ||
    lc.includes("socket hang up") ||
    lc.includes("network error") ||
    lc.includes("connection refused") ||
    lc.includes("econnrefused")
  ) {
    return new HTLCError({
      code: "chain_error",
      message: "Soroban RPC timeout or connectivity error: " + msg,
      retryable: true,
      cause: err,
    });
  }

  // Soroban contract host errors (HostError, WasmVm, invoke failures).
  // These indicate the contract itself rejected the invocation — not retryable.
  if (
    lc.includes("simulation failed") ||
    lc.includes("simulation rejected") ||
    lc.includes("host error") ||
    lc.includes("wasm vm") ||
    lc.includes("wasmvm") ||
    lc.includes("invoke host") ||
    lc.includes("hostenvcatch") ||
    lc.includes("contracterror")
  ) {
    return new HTLCError({
      code: "simulation_failed",
      message: "Soroban simulation or contract host error: " + msg,
      retryable: false,
      cause: err,
    });
  }

  // Preimage / hashlock mismatch — logic error, never retryable.
  if (lc.includes("hashlock") || lc.includes("preimage")) {
    return new HTLCError({
      code: "invalid_preimage",
      message: "Preimage does not match hashlock: " + msg,
      retryable: false,
      cause: err,
    });
  }

  // Timelock not yet expired — caller must wait, never retryable immediately.
  if (lc.includes("timelock")) {
    return new HTLCError({
      code: "timelock_not_expired",
      message: "Timelock has not yet expired: " + msg,
      retryable: false,
      cause: err,
    });
  }

  // Bad auth or mis-signed transaction — key mismatch, not retryable.
  if (
    lc.includes("bad auth") ||
    lc.includes("tx_bad_auth") ||
    lc.includes("txbadauth") ||
    (lc.includes("signature") && lc.includes("invalid"))
  ) {
    return new HTLCError({
      code: "tx_rejected",
      message: "Soroban transaction rejected: bad auth or invalid signature. " +
        "Verify the signing key matches the source account: " + msg,
      retryable: false,
      cause: err,
    });
  }

  // Unknown method / function not found — likely a contract ID mismatch.
  if (
    lc.includes("function not found") ||
    lc.includes("unknown method") ||
    lc.includes("method not found") ||
    lc.includes("no such method") ||
    lc.includes("no such function")
  ) {
    return new HTLCError({
      code: "tx_rejected",
      message: "Soroban contract method not found — check the contract ID and ABI: " + msg,
      retryable: false,
      cause: err,
    });
  }

  // Malformed XDR or data decode failures.
  if (
    lc.includes("xdr decode") ||
    lc.includes("malformed") ||
    (lc.includes("parse") && lc.includes("error")) ||
    lc.includes("decode error")
  ) {
    return new HTLCError({
      code: "tx_rejected",
      message: "Soroban XDR decode or data malformed — check transaction construction: " + msg,
      retryable: false,
      cause: err,
    });
  }

  // Explicit submission rejection codes.
  if (lc.includes("submit failed") || lc.includes("tx_rejected")) {
    return new HTLCError({
      code: "tx_rejected",
      message: "Soroban transaction was rejected by the network: " + msg,
      retryable: false,
      cause: err,
    });
  }

  // Fallback: unknown Soroban or chain error.
  return new HTLCError({
    code: "chain_error",
    message: "Soroban chain error: " + msg,
    retryable: false,
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
  constructor(
    private readonly client: SorobanHTLCClient,
    /** Optional per-adapter orchestration policy overrides. */
    private readonly config?: OrchestrationConfig,
  ) {}

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
      const txHash = await this.client.createOrder(input, signer, this.config);
      const orderId = encodeSorobanOrderRef(input.sender, txHash);
      return { txId: txHash, orderId };
    } catch (err) {
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
        signer,
        this.config,
      );
      return { txId: txHash };
    } catch (err) {
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
        signer,
        this.config,
      );
      return { txId: txHash };
    } catch (err) {
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
