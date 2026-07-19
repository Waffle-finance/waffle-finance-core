/**
 * Permissionless XLM refund helper for failed XLMΓåÆETH swaps.
 *
 * Lives outside index.ts so it can be reused by:
 *  - the inline `/api/orders/xlm-to-eth` error handler (immediate refund),
 *  - the `/api/orders/manual-refund` endpoint (user-initiated),
 *  - the background watchdog (rescues orders the user never retried).
 *
 * Design constraints
 * ------------------
 * 1. EXACT INTEGER MATH — all XLM amounts are represented as stroops
 *    (1 XLM = 10_000_000 stroops) throughout. Floating-point is only used
 *    when reading Horizon's decimal-string responses and is immediately
 *    rounded to the nearest stroop. The Stellar SDK's `Operation.payment`
 *    accepts decimal strings; we convert stroops back to a 7-decimal string
 *    only at the final build step so no precision is ever lost mid-flight.
 *
 * 2. HORIZON TIMEOUT / 504 CLASSIFICATION — a 504 or a network-level
 *    timeout means the transaction MAY have already landed. The function
 *    throws a `HorizonTimeoutError` so callers can distinguish "definitely
 *    failed" from "ambiguous, do not retry blindly". The RefundLedger uses
 *    this to mark the entry ambiguous rather than releasing the lock.
 *
 * 3. RETRYABLE vs TERMINAL ERRORS — Horizon returns structured
 *    `extras.result_codes` on 4xx failures. Transaction codes that are
 *    definitively terminal (tx_bad_seq, tx_insufficient_balance, …) are
 *    wrapped in `HorizonTerminalError` and are never retried. Transient
 *    network errors receive `HorizonTransientError` and are retried with
 *    exponential back-off inside this function (up to maxRetries).
 *
 * 4. IDEMPOTENCY — callers pass an optional `idempotencyKey` (the orderId).
 *    When set, the function checks if the key is already locked/committed in
 *    the supplied `RefundLedger` and returns the committed result without
 *    hitting Horizon again. Callers that don't own a RefundLedger can omit
 *    the key; deduplication is then the caller's responsibility.
 *
 * Order book bookkeeping (updating order.status, order.refundTxHash, etc.)
 * is left to callers — this function is intentionally side-effect-light.
 */

import { withRetry } from '../utils/retry-policy.js';
import type { RefundLedger } from './refund-ledger.js';
import {
  refundHorizonTimeouts,
  refundHorizonRetries,
  refundDuplicatesSuppressed,
} from '../metrics.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type RefundNetworkMode = 'mainnet' | 'testnet';

export interface RefundXlmArgs {
  /** Order id used in the refund memo (truncated to fit Stellar's 28-byte text memo). */
  orderId: string;
  /** Destination Stellar address receiving the refunded XLM. */
  stellarAddress: string;
  /** Hash of the user's original XLM payment to the relayer (used to size the refund). */
  stellarTxHash?: string;
  /** `mainnet` for Stellar Public, `testnet` otherwise. */
  networkMode: RefundNetworkMode;
  /** Horizon endpoint to use for the chosen network. */
  horizonUrl: string;
  /** Stellar secret to sign the refund. Should be the relayer's hot wallet. */
  refundSecret: string;
  /**
   * Fallback amount in stroops used when the original payment cannot be
   * looked up — e.g. the watchdog firing before Horizon has indexed the
   * user's tx. Optional. Must be a positive integer string or number.
   */
  fallbackStroops?: string | number;
  /**
   * When provided the function will check the ledger for an existing
   * committed refund and skip Horizon if one is found. The caller is
   * responsible for calling claim()/commit()/release() around this
   * function — or use `withLedger` which does it automatically.
   */
  ledger?: RefundLedger;
  /**
   * Maximum number of times to retry transient (non-terminal) Horizon
   * errors. Defaults to 3. Set to 0 to disable internal retries.
   */
  maxRetries?: number;
}

export interface RefundXlmResult {
  /** Stellar transaction hash of the refund payment. */
  hash: string;
  /** Exact amount refunded as a 7-decimal XLM string (e.g. "12.3456789"). */
  amount: string;
  /** Amount in stroops for downstream integer comparisons. */
  stroops: bigint;
  /** Ledger sequence number on which the tx was included (if returned). */
  ledger?: number;
  /** True when the result was served from the RefundLedger cache (no Horizon call). */
  fromCache?: boolean;
}

// ---------------------------------------------------------------------------
// Error taxonomy
// ---------------------------------------------------------------------------

/**
 * The Horizon submit call timed out or returned a 504. The transaction
 * may or may not have landed. Callers MUST NOT retry immediately and MUST
 * NOT release the RefundLedger lock — mark the entry as ambiguous instead.
 */
export class HorizonTimeoutError extends Error {
  readonly isTimeout = true;
  constructor(message: string) {
    super(message);
    this.name = 'HorizonTimeoutError';
  }
}

/**
 * Horizon returned a definitive failure (e.g. tx_bad_seq, insufficient
 * balance). Retrying with the same parameters will not help.
 */
export class HorizonTerminalError extends Error {
  readonly isTerminal = true;
  readonly resultCode: string;
  constructor(message: string, resultCode: string) {
    super(message);
    this.name = 'HorizonTerminalError';
    this.resultCode = resultCode;
  }
}

/**
 * A transient Horizon or network error that may succeed on retry
 * (connection reset, 503, etc.).
 */
export class HorizonTransientError extends Error {
  readonly isTransient = true;
  constructor(message: string) {
    super(message);
    this.name = 'HorizonTransientError';
  }
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

/** 1 XLM = 10_000_000 stroops (Stellar fixed-point scale). */
const STROOPS_PER_XLM = 10_000_000n;

/**
 * Minimum refund: 1 stroop (1e-7 XLM).
 * We refuse to build a 0-amount payment, which Horizon would reject.
 */
const MIN_REFUND_STROOPS = 1n;

/**
 * Fee reserved for the refund transaction itself (100 stroops = base fee).
 * We subtract this from the inferred amount so the relayer is not left
 * with a stranded dust balance after each refund.
 */
const TX_FEE_STROOPS = 100n;

/**
 * Terminal Horizon result codes. Retrying these is pointless.
 * See https://developers.stellar.org/docs/data/horizon/api-reference/errors/result-codes
 */
const TERMINAL_RESULT_CODES = new Set([
  'tx_bad_seq',
  'tx_bad_auth',
  'tx_insufficient_balance',
  'tx_no_source_account',
  'tx_bad_auth_extra',
  'tx_internal_error',
  'op_no_destination',
  'op_no_trust',
  'op_line_full',
  'op_not_authorized',
  'op_bad_asset',
]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Submit a refund payment on Stellar. Throws on any error — callers
 * decide whether to surface, retry, or just log it.
 *
 * Errors are typed:
 *  - `HorizonTimeoutError`  → mark ambiguous, do not retry immediately
 *  - `HorizonTerminalError` → do not retry at all
 *  - `HorizonTransientError` → was already retried internally; bubble up
 *  - Anything else          → treat as transient
 */
export async function refundXlmToUser(args: RefundXlmArgs): Promise<RefundXlmResult> {
  const {
    orderId,
    stellarAddress,
    stellarTxHash,
    networkMode,
    horizonUrl,
    refundSecret,
    fallbackStroops,
    ledger,
    maxRetries = 3,
  } = args;

  // ── Idempotency fast-path ──────────────────────────────────────────────
  if (ledger) {
    const existing = ledger.getEntry(orderId);
    if (existing?.state.phase === 'committed') {
      refundDuplicatesSuppressed.inc({ network_mode: networkMode });
      const s = existing.state;
      return {
        hash: s.txHash,
        amount: s.amount,
        stroops: xlmStringToStroops(s.amount),
        ledger: s.ledger,
        fromCache: true,
      };
    }
    // in_flight or ambiguous — caller should not be calling us again, but
    // protect against it by refusing to double-submit.
    if (existing?.state.phase === 'in_flight' || existing?.state.phase === 'ambiguous') {
      refundDuplicatesSuppressed.inc({ network_mode: networkMode });
      throw new Error(
        `[xlm-refund] Duplicate refund attempt for orderId=${orderId} ` +
        `(current state: ${existing.state.phase}). ` +
        `Call RefundLedger.claim() before invoking refundXlmToUser.`
      );
    }
  }

  // ── SDK imports (dynamic to avoid loading Stellar at startup) ────────
  const {
    Horizon,
    Keypair,
    Asset,
    Operation,
    TransactionBuilder,
    Networks,
    BASE_FEE,
    Memo,
  } = await import('@stellar/stellar-sdk');

  const server = new Horizon.Server(horizonUrl);
  const keypair = Keypair.fromSecret(refundSecret);

  // ── Determine refund amount in stroops ───────────────────────────────
  let refundStroops = await resolveRefundStroops({
    server,
    keypair,
    stellarTxHash,
    fallbackStroops,
    orderId,
  });

  // Deduct the transaction fee from the refund amount so the relayer is
  // not left with a stranded dust balance. Never go below 1 stroop.
  refundStroops = refundStroops > TX_FEE_STROOPS
    ? refundStroops - TX_FEE_STROOPS
    : MIN_REFUND_STROOPS;

  const refundAmountStr = stroopsToXlmString(refundStroops);

  const networkPassphrase = networkMode === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET;

  // Memo: "Refund:" + first 20 chars of orderId fits within 28 bytes.
  const memoText = `Refund:${(orderId || 'unknown').substring(0, 20)}`;

  // ── Build and sign (outside retry loop — sequence number is refreshed
  //    on each attempt inside the loop) ──────────────────────────────────
  const submitOnce = async (): Promise<RefundXlmResult> => {
    // Always load a fresh account to get the current sequence number.
    // This prevents tx_bad_seq on retries caused by stale sequence state.
    const account = await loadAccountWithClassification(server, keypair.publicKey());

    const payment = Operation.payment({
      destination: stellarAddress,
      asset: Asset.native(),
      amount: refundAmountStr,
    });

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase,
    })
      .addOperation(payment)
      .addMemo(Memo.text(memoText))
      .setTimeout(300)
      .build();

    tx.sign(keypair);

    return await submitWithClassification(server, tx, networkMode);
  };

  // ── Retry loop wrapping submitOnce ────────────────────────────────────
  let attempt = 0;
  let lastErr: unknown;

  while (attempt <= maxRetries) {
    try {
      const result = await submitOnce();
      // Populate ledger if caller owns it (they called claim already)
      if (ledger) {
        ledger.commit(orderId, {
          txHash: result.hash,
          amount: result.amount,
          ledger: result.ledger,
        });
      }
      return result;
    } catch (err: unknown) {
      lastErr = err;

      if (err instanceof HorizonTimeoutError) {
        // Ambiguous — do not retry; surface immediately so the caller can
        // mark the ledger entry ambiguous.
        refundHorizonTimeouts.inc({ network_mode: networkMode });
        throw err;
      }

      if (err instanceof HorizonTerminalError) {
        // No point retrying.
        throw err;
      }

      // Transient error — retry with back-off.
      if (attempt < maxRetries) {
        const delayMs = Math.min(30_000, 1_000 * Math.pow(2, attempt));
        refundHorizonRetries.inc({ network_mode: networkMode });
        console.warn(
          `[xlm-refund] orderId=${orderId} transient error on attempt ${attempt + 1}/${maxRetries + 1},` +
          ` retrying in ${delayMs}ms:`,
          err instanceof Error ? err.message : String(err)
        );
        await sleep(delayMs);
      }

      attempt++;
    }
  }

  throw lastErr;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Determine the refund amount in stroops.
 *
 * Priority:
 *  1. Look up the original payment in Horizon to get the exact amount.
 *  2. Fall back to `fallbackStroops` if provided and positive.
 *  3. Fall back to a conservative 1_000_000 stroops (0.1 XLM).
 */
async function resolveRefundStroops(opts: {
  server: any;
  keypair: any;
  stellarTxHash?: string;
  fallbackStroops?: string | number;
  orderId: string;
}): Promise<bigint> {
  const { server, keypair, stellarTxHash, fallbackStroops, orderId } = opts;

  if (stellarTxHash) {
    try {
      const ops = await server.operations().forTransaction(stellarTxHash).call();
      const paymentOp: any = ops.records.find(
        (op: any) =>
          op.type === 'payment' &&
          op.to === keypair.publicKey() &&
          op.asset_type === 'native'
      );
      if (paymentOp) {
        // Horizon returns amounts as 7-decimal strings; convert to stroops
        // using integer arithmetic only.
        const stroops = xlmStringToStroops(paymentOp.amount);
        if (stroops > 0n) {
          return stroops;
        }
      }
    } catch (lookupErr) {
      console.warn(
        `[xlm-refund] orderId=${orderId} original tx lookup failed, falling back:`,
        lookupErr instanceof Error ? lookupErr.message : String(lookupErr)
      );
    }
  }

  // Use explicit fallback if provided and valid
  if (fallbackStroops !== undefined && fallbackStroops !== null) {
    const parsed = parseFallbackStroops(fallbackStroops);
    if (parsed > 0n) return parsed;
  }

  // Conservative stub — visible to the operator in logs but keeps the
  // order bookkeeping moving.
  console.warn(`[xlm-refund] orderId=${orderId} using minimum stub refund (1_000_000 stroops = 0.1 XLM)`);
  return 1_000_000n;
}

/**
 * `loadAccount` wrapper that maps Horizon errors to our error taxonomy.
 */
async function loadAccountWithClassification(server: any, publicKey: string): Promise<any> {
  try {
    return await server.loadAccount(publicKey);
  } catch (err: unknown) {
    throw classifyHorizonError(err);
  }
}

/**
 * Submit a signed transaction to Horizon and classify the response.
 */
async function submitWithClassification(
  server: any,
  tx: any,
  networkMode: RefundNetworkMode
): Promise<RefundXlmResult> {
  let rawResult: any;

  try {
    rawResult = await server.submitTransaction(tx);
  } catch (err: unknown) {
    throw classifyHorizonError(err);
  }

  // Stellar SDK resolves the promise with the response object on success.
  return {
    hash: rawResult.hash,
    amount: stroopsToXlmString(xlmStringToStroops(
      // result may carry `successful: true` and `envelope_xdr`; extract
      // the amount from the original tx instead of the response.
      getAmountFromTx(tx)
    )),
    stroops: xlmStringToStroops(getAmountFromTx(tx)),
    ledger: rawResult.ledger,
  };
}

/**
 * Extract the payment amount string from a built TransactionBuilder result.
 * Falls back to '0.0000000' if the operation structure is unexpected.
 */
function getAmountFromTx(tx: any): string {
  try {
    const ops = tx.operations ?? tx._operations;
    if (Array.isArray(ops) && ops.length > 0) {
      return ops[0].amount ?? '0.0000000';
    }
  } catch {
    /* ignore */
  }
  return '0.0000000';
}

/**
 * Map a raw Horizon error (from the SDK) to one of our typed error classes.
 *
 * The Stellar SDK wraps non-2xx Horizon responses as `{ response: { status, data } }`.
 */
function classifyHorizonError(err: unknown): Error {
  if (err instanceof HorizonTimeoutError ||
      err instanceof HorizonTerminalError ||
      err instanceof HorizonTransientError) {
    return err;
  }

  // SDK wraps Horizon responses in an object with a `.response` property.
  const response = (err as any)?.response;

  if (response) {
    const status: number = response?.status ?? 0;

    // 504 Gateway Timeout or ECONNABORTED — transaction may have landed.
    if (status === 504 || (err as any)?.code === 'ECONNABORTED') {
      return new HorizonTimeoutError(
        `Horizon returned ${status} — transaction may have landed. ` +
        `Do not retry immediately. (${(err as Error)?.message ?? String(err)})`
      );
    }

    // 400 with result_codes — inspect for terminal vs transient codes.
    if (status === 400) {
      const resultCodes: Record<string, string> =
        response?.data?.extras?.result_codes ?? {};
      const txCode: string = resultCodes?.transaction ?? '';
      const opCodes: string[] = Array.isArray(resultCodes?.operations)
        ? (resultCodes.operations as string[])
        : [];
      const allCodes = [txCode, ...opCodes].filter(Boolean);

      const terminalCode = allCodes.find((c) => TERMINAL_RESULT_CODES.has(c));
      if (terminalCode) {
        return new HorizonTerminalError(
          `Horizon rejected transaction with terminal code: ${terminalCode}` +
          ` (all codes: ${allCodes.join(', ')})`,
          terminalCode
        );
      }

      // Unknown 400 — treat as transient (maybe sequence race)
      return new HorizonTransientError(
        `Horizon 400 with unknown result codes: ${allCodes.join(', ')} — ` +
        `may be retryable. (${(err as Error)?.message ?? String(err)})`
      );
    }

    // 5xx other than 504 — transient
    if (status >= 500) {
      return new HorizonTransientError(
        `Horizon ${status} error — transient. (${(err as Error)?.message ?? String(err)})`
      );
    }

    // 408 Request Timeout
    if (status === 408) {
      return new HorizonTimeoutError(
        `Horizon 408 timeout — transaction may have landed. ` +
        `(${(err as Error)?.message ?? String(err)})`
      );
    }
  }

  // Network-level timeout patterns
  const msg = (err as Error)?.message ?? String(err);
  if (
    msg.includes('timeout') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('ECONNRESET') ||
    msg.includes('socket hang up')
  ) {
    return new HorizonTimeoutError(`Network timeout during Horizon submit: ${msg}`);
  }

  // Unknown — treat as transient
  return new HorizonTransientError(
    `Unknown Horizon error: ${msg}`
  );
}

// ---------------------------------------------------------------------------
// Stroop / XLM integer math utilities (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Convert a 7-decimal XLM string (as returned by Horizon) to an exact
 * bigint stroop count. Uses only integer arithmetic.
 *
 * "12.3456789" → 123456789n
 * "12"         → 120000000n
 * "0.0000001"  → 1n
 */
export function xlmStringToStroops(xlm: string): bigint {
  if (!xlm || typeof xlm !== 'string') return 0n;

  const trimmed = xlm.trim();
  const dotIndex = trimmed.indexOf('.');

  if (dotIndex === -1) {
    // No decimal part
    return BigInt(trimmed) * STROOPS_PER_XLM;
  }

  const intPart = trimmed.substring(0, dotIndex) || '0';
  // Pad or truncate fractional part to exactly 7 digits
  const rawFrac = trimmed.substring(dotIndex + 1);
  const fracPadded = rawFrac.padEnd(7, '0').substring(0, 7);

  return BigInt(intPart) * STROOPS_PER_XLM + BigInt(fracPadded);
}

/**
 * Convert a bigint stroop count to a 7-decimal XLM string.
 * Suitable for passing to Stellar SDK `Operation.payment`.
 *
 * 123456789n → "12.3456789"
 * 1n         → "0.0000001"
 * 0n         → "0.0000000"
 */
export function stroopsToXlmString(stroops: bigint): string {
  if (stroops < 0n) stroops = 0n;
  const intPart = stroops / STROOPS_PER_XLM;
  const fracPart = stroops % STROOPS_PER_XLM;
  return `${intPart}.${fracPart.toString().padStart(7, '0')}`;
}

/**
 * Parse a fallback amount that may be expressed as:
 *  - A stroop integer string ("1234567")
 *  - A decimal XLM string ("12.34")   ← converted via xlmStringToStroops
 *  - A number (treated as stroops if >= 1e7, as XLM float otherwise)
 */
export function parseFallbackStroops(value: string | number): bigint {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return 0n;
    // Heuristic: values >= 1e7 look like stroops; smaller values look like XLM
    if (value >= 1e7) return BigInt(Math.round(value));
    // Treat as XLM decimal
    return xlmStringToStroops(value.toFixed(7));
  }

  const str = String(value).trim();
  if (!str || str === '0') return 0n;

  if (str.includes('.')) {
    return xlmStringToStroops(str);
  }

  // Pure integer string — assume stroops
  try {
    const n = BigInt(str);
    return n > 0n ? n : 0n;
  } catch {
    return 0n;
  }
}

// ---------------------------------------------------------------------------
// Private utilities
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
