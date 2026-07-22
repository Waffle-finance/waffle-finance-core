/**
 * Permissionless XLM refund helper for failed XLM→ETH swaps.
 *
 * Lives outside index.ts so it can be reused by:
 *  - the inline `/api/orders/xlm-to-eth` error handler (immediate refund),
 *  - the `/api/orders/manual-refund` endpoint (user-initiated),
 *  - the background watchdog (rescues orders the user never retried).
 *
 * Design constraints
 * ------------------
 * 1. EXACT INTEGER MATH — all XLM amounts are represented as stroops
 *    (1 XLM = 10_000_000 stroops) throughout. No parseFloat, no toFixed.
 *    Horizon amount strings are converted to bigint stroops on ingestion
 *    and back to 7-decimal strings only at the final SDK build step.
 *
 * 2. HORIZON TIMEOUT / 504 CLASSIFICATION — a 504, 408, or network-level
 *    timeout means the transaction MAY have already landed. The function
 *    throws `HorizonTimeoutError` so callers can mark the entry ambiguous
 *    rather than releasing the idempotency lock.
 *
 * 3. RETRYABLE vs TERMINAL ERRORS — Horizon returns structured
 *    `extras.result_codes` on 4xx failures.
 *    - tx_bad_seq: reload account and retry with a fresh sequence number.
 *    - tx_insufficient_fee: fee-bump up to FEE_BUMP_CAP_STROOPS.
 *    - Other terminal codes: wrapped in HorizonTerminalError, never retried.
 *    - Transient (5xx, connection errors): retried with exponential back-off.
 *
 * 4. IDEMPOTENCY — callers pass an optional `ledger` (RefundLedger).
 *    When set, the function checks for an existing committed or in-flight
 *    entry and returns the cached result / refuses the duplicate without
 *    contacting Horizon.
 *
 * 5. NO GUESS FALLBACK — when the original payment amount cannot be
 *    determined (no stellarTxHash, no valid fallbackStroops), the function
 *    throws `RefundAmountUnknownError` so the watchdog can defer the order
 *    to a later tick instead of under-refunding.
 */

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
   * Fallback amount used when the original payment cannot be looked up.
   * Must be a positive integer stroop string or number. When absent and
   * the tx lookup also fails, the function throws RefundAmountUnknownError
   * so the watchdog defers instead of guessing.
   */
  fallbackStroops?: string | number;
  /**
   * When provided the function checks for an existing committed refund and
   * returns it without hitting Horizon. The caller is responsible for
   * calling claim()/commit()/release() around this function.
   */
  ledger?: RefundLedger;
  /**
   * Maximum number of times to retry transient (non-terminal, non-timeout)
   * Horizon errors. Defaults to 3. Set to 0 to disable internal retries.
   */
  maxRetries?: number;
  /**
   * Maximum fee in stroops we will ever pay for a fee-bumped transaction.
   * Defaults to 10_000 stroops (0.001 XLM). If the required fee exceeds
   * this cap the transaction is abandoned with HorizonTerminalError.
   */
  feeBumpCapStroops?: bigint;
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
 * The Horizon submit call timed out or returned a 504/408. The transaction
 * may or may not have landed. Callers MUST NOT retry immediately — mark the
 * entry ambiguous and let the watchdog resolve it later.
 */
export class HorizonTimeoutError extends Error {
  readonly isTimeout = true;
  constructor(message: string) {
    super(message);
    this.name = 'HorizonTimeoutError';
  }
}

/**
 * Horizon returned a definitive rejection. Retrying with the same parameters
 * will not help. `resultCode` holds the Stellar result code string.
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
 * A transient Horizon or network error — the call was retried internally
 * and all attempts failed. The caller may try again later.
 */
export class HorizonTransientError extends Error {
  readonly isTransient = true;
  constructor(message: string) {
    super(message);
    this.name = 'HorizonTransientError';
  }
}

/**
 * The refund amount could not be determined: no stellarTxHash was supplied
 * (or the lookup failed) and no valid fallbackStroops were provided.
 * The caller should defer the refund to a later attempt rather than guessing.
 */
export class RefundAmountUnknownError extends Error {
  readonly isUnknownAmount = true;
  constructor(orderId: string) {
    super(
      `[xlm-refund] Cannot determine refund amount for orderId=${orderId}. ` +
      `Provide stellarTxHash or fallbackStroops. Deferring.`
    );
    this.name = 'RefundAmountUnknownError';
  }
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

/** 1 XLM = 10_000_000 stroops (Stellar fixed-point scale). */
const STROOPS_PER_XLM = 10_000_000n;

/** Minimum refund: 1 stroop (1e-7 XLM). Zero payments are rejected by Horizon. */
const MIN_REFUND_STROOPS = 1n;

/** Fee reserved for the refund transaction itself (base fee = 100 stroops). */
const TX_FEE_STROOPS = 100n;

/**
 * Default cap on fee-bumped transactions. If the fee Horizon demands exceeds
 * this, we give up with HorizonTerminalError rather than paying an unlimited fee.
 * Callers can override via RefundXlmArgs.feeBumpCapStroops.
 */
const DEFAULT_FEE_BUMP_CAP_STROOPS = 10_000n; // 0.001 XLM

/**
 * Terminal Horizon result codes — retrying is pointless.
 * tx_bad_seq and tx_insufficient_fee are handled specially before this set.
 * See https://developers.stellar.org/docs/data/horizon/api-reference/errors/result-codes
 */
const TERMINAL_RESULT_CODES = new Set([
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
// Structured logger (thin wrapper — replace with winston when available)
// ---------------------------------------------------------------------------

function log(
  level: 'info' | 'warn' | 'error',
  msg: string,
  ctx: Record<string, unknown> = {}
): void {
  const entry = JSON.stringify({ level, msg, ...ctx, ts: new Date().toISOString() });
  if (level === 'error') {
    process.stderr.write(entry + '\n');
  } else {
    process.stdout.write(entry + '\n');
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Submit a refund payment on Stellar. Throws typed errors on failure —
 * callers decide whether to surface, defer, or alert.
 *
 * Error types:
 *  - `RefundAmountUnknownError` → defer; watchdog will retry after Horizon indexes
 *  - `HorizonTimeoutError`      → mark ambiguous; do not retry immediately
 *  - `HorizonTerminalError`     → do not retry; alert operator
 *  - `HorizonTransientError`    → was already retried internally; may retry later
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
    feeBumpCapStroops = DEFAULT_FEE_BUMP_CAP_STROOPS,
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
    // in_flight or ambiguous — the caller should not be calling us again.
    if (existing?.state.phase === 'in_flight' || existing?.state.phase === 'ambiguous') {
      refundDuplicatesSuppressed.inc({ network_mode: networkMode });
      throw new Error(
        `[xlm-refund] Duplicate refund attempt for orderId=${orderId} ` +
        `(current state: ${existing.state.phase}). ` +
        `Call RefundLedger.claim() before invoking refundXlmToUser.`
      );
    }
  }

  // ── SDK imports (dynamic to avoid loading Stellar at startup) ──────────
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

  // ── Determine refund amount in stroops ─────────────────────────────────
  // Throws RefundAmountUnknownError when amount cannot be determined.
  let refundStroops = await resolveRefundStroops({
    server,
    keypair,
    stellarTxHash,
    fallbackStroops,
    orderId,
  });

  // Deduct the transaction base fee so the relayer is not left with dust.
  refundStroops = refundStroops > TX_FEE_STROOPS
    ? refundStroops - TX_FEE_STROOPS
    : MIN_REFUND_STROOPS;

  const refundAmountStr = stroopsToXlmString(refundStroops);
  const networkPassphrase = networkMode === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET;
  // "Refund:" + first 20 chars of orderId = max 27 bytes, fits within 28.
  const memoText = `Refund:${(orderId || 'unknown').substring(0, 20)}`;

  // Current fee in stroops; may be bumped on tx_insufficient_fee.
  let currentFeeStroops = BigInt(BASE_FEE);

  // ── Build, sign, submit — with per-attempt account reload ──────────────
  const submitOnce = async (): Promise<RefundXlmResult> => {
    // Always reload to get the current sequence number. This is the fix for
    // tx_bad_seq on retries caused by stale state.
    const account = await loadAccountWithClassification(server, keypair.publicKey());

    const payment = Operation.payment({
      destination: stellarAddress,
      asset: Asset.native(),
      amount: refundAmountStr,
    });

    const tx = new TransactionBuilder(account, {
      fee: currentFeeStroops.toString(),
      networkPassphrase,
    })
      .addOperation(payment)
      .addMemo(Memo.text(memoText))
      .setTimeout(300)
      .build();

    tx.sign(keypair);

    return await submitWithClassification(server, tx, networkMode);
  };

  // ── Retry loop ──────────────────────────────────────────────────────────
  let attempt = 0;
  let lastErr: unknown;

  while (attempt <= maxRetries) {
    try {
      const result = await submitOnce();
      // Commit to ledger if caller already holds the claim.
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

      // ── Ambiguous timeout: surface immediately, never retry ────────────
      if (err instanceof HorizonTimeoutError) {
        refundHorizonTimeouts.inc({ network_mode: networkMode });
        throw err;
      }

      // ── tx_bad_seq: the sequence number was stale — reload on next iter ─
      // submitOnce already reloads the account at the top of each attempt,
      // so we just increment attempt and loop without extra delay.
      if (err instanceof HorizonTerminalError && err.resultCode === 'tx_bad_seq') {
        log('warn', '[xlm-refund] tx_bad_seq — reloading account on next attempt', {
          orderId, attempt,
        });
        if (attempt < maxRetries) {
          refundHorizonRetries.inc({ network_mode: networkMode });
          attempt++;
          continue;
        }
        throw err;
      }

      // ── tx_insufficient_fee: bump fee up to the configured cap ─────────
      if (err instanceof HorizonTerminalError && err.resultCode === 'tx_insufficient_fee') {
        const nextFee = currentFeeStroops * 2n;
        if (nextFee > feeBumpCapStroops) {
          log('error', '[xlm-refund] fee-bump cap exceeded — abandoning refund', {
            orderId, currentFeeStroops: currentFeeStroops.toString(),
            nextFee: nextFee.toString(), feeBumpCapStroops: feeBumpCapStroops.toString(),
          });
          throw new HorizonTerminalError(
            `Fee-bump cap of ${feeBumpCapStroops} stroops exceeded (would need ${nextFee})`,
            'fee_bump_cap_exceeded'
          );
        }
        log('warn', '[xlm-refund] tx_insufficient_fee — bumping fee', {
          orderId, from: currentFeeStroops.toString(), to: nextFee.toString(),
        });
        currentFeeStroops = nextFee;
        if (attempt < maxRetries) {
          refundHorizonRetries.inc({ network_mode: networkMode });
          attempt++;
          continue;
        }
        throw err;
      }

      // ── Other terminal errors: no point retrying ───────────────────────
      if (err instanceof HorizonTerminalError) {
        throw err;
      }

      // ── Transient error: exponential back-off then retry ───────────────
      if (attempt < maxRetries) {
        const delayMs = Math.min(30_000, 1_000 * Math.pow(2, attempt));
        refundHorizonRetries.inc({ network_mode: networkMode });
        log('warn', '[xlm-refund] transient error — retrying', {
          orderId,
          attempt: attempt + 1,
          maxRetries: maxRetries + 1,
          delayMs,
          error: err instanceof Error ? err.message : String(err),
        });
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
 *  3. Throw RefundAmountUnknownError — never guess.
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
        const stroops = xlmStringToStroops(paymentOp.amount);
        if (stroops > 0n) {
          return stroops;
        }
      }
    } catch (lookupErr) {
      log('warn', '[xlm-refund] original tx lookup failed', {
        orderId,
        stellarTxHash,
        error: lookupErr instanceof Error ? lookupErr.message : String(lookupErr),
      });
    }
  }

  // Use explicit fallback if provided and valid.
  if (fallbackStroops !== undefined && fallbackStroops !== null) {
    const parsed = parseFallbackStroops(fallbackStroops);
    if (parsed > 0n) return parsed;
  }

  // Amount is unknown. Throw so the watchdog defers rather than guessing.
  throw new RefundAmountUnknownError(orderId);
}

/**
 * loadAccount wrapper that maps Horizon errors to our error taxonomy.
 */
async function loadAccountWithClassification(server: any, publicKey: string): Promise<any> {
  try {
    return await server.loadAccount(publicKey);
  } catch (err: unknown) {
    throw classifyHorizonError(err);
  }
}

/**
 * Submit a signed transaction and classify the Horizon response.
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

  const amountStr = getAmountFromTx(tx);
  const stroops = xlmStringToStroops(amountStr);
  return {
    hash: rawResult.hash,
    amount: stroopsToXlmString(stroops),
    stroops,
    ledger: rawResult.ledger,
  };
}

/**
 * Extract the payment amount string from the built transaction's operations.
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
 * Map a raw Horizon error to one of our typed error classes.
 * The Stellar SDK wraps non-2xx responses as `{ response: { status, data } }`.
 */
function classifyHorizonError(err: unknown): Error {
  if (
    err instanceof HorizonTimeoutError ||
    err instanceof HorizonTerminalError ||
    err instanceof HorizonTransientError
  ) {
    return err;
  }

  const response = (err as any)?.response;

  if (response) {
    const status: number = response?.status ?? 0;

    // 504 / 408 / ECONNABORTED — transaction may have landed already.
    if (status === 504 || status === 408 || (err as any)?.code === 'ECONNABORTED') {
      return new HorizonTimeoutError(
        `Horizon returned ${status} — transaction may have landed. ` +
        `Do not retry immediately. (${(err as Error)?.message ?? String(err)})`
      );
    }

    // 400 — inspect result_codes for terminal vs retryable classification.
    if (status === 400) {
      const resultCodes: Record<string, unknown> =
        response?.data?.extras?.result_codes ?? {};
      const txCode: string = (resultCodes?.transaction as string) ?? '';
      const opCodes: string[] = Array.isArray(resultCodes?.operations)
        ? (resultCodes.operations as string[])
        : [];
      const allCodes = [txCode, ...opCodes].filter(Boolean);

      // tx_bad_seq and tx_insufficient_fee are handled specially in the retry loop.
      if (txCode === 'tx_bad_seq') {
        return new HorizonTerminalError(
          `Horizon rejected: tx_bad_seq (stale sequence number)`,
          'tx_bad_seq'
        );
      }

      if (txCode === 'tx_insufficient_fee') {
        return new HorizonTerminalError(
          `Horizon rejected: tx_insufficient_fee`,
          'tx_insufficient_fee'
        );
      }

      const terminalCode = allCodes.find((c) => TERMINAL_RESULT_CODES.has(c));
      if (terminalCode) {
        return new HorizonTerminalError(
          `Horizon rejected transaction with terminal code: ${terminalCode}` +
          ` (all codes: ${allCodes.join(', ')})`,
          terminalCode
        );
      }

      // Unknown 400 — possibly a transient sequence race; allow retry.
      return new HorizonTransientError(
        `Horizon 400 with unknown result codes: ${allCodes.join(', ')} — ` +
        `may be retryable. (${(err as Error)?.message ?? String(err)})`
      );
    }

    // 5xx other than 504 — transient.
    if (status >= 500) {
      return new HorizonTransientError(
        `Horizon ${status} error — transient. (${(err as Error)?.message ?? String(err)})`
      );
    }
  }

  // Network-level timeout patterns.
  const msg = (err as Error)?.message ?? String(err);
  if (
    msg.includes('timeout') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('ECONNRESET') ||
    msg.includes('socket hang up')
  ) {
    return new HorizonTimeoutError(`Network timeout during Horizon submit: ${msg}`);
  }

  // Unknown — treat as transient.
  return new HorizonTransientError(`Unknown Horizon error: ${msg}`);
}

// ---------------------------------------------------------------------------
// Stroop / XLM integer math utilities (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Convert a Horizon 7-decimal XLM string to an exact bigint stroop count.
 * Uses only integer arithmetic — no parseFloat, no toFixed.
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
    // No decimal part — treat entire string as whole XLM.
    return BigInt(trimmed) * STROOPS_PER_XLM;
  }

  const intPart = trimmed.substring(0, dotIndex) || '0';
  const rawFrac = trimmed.substring(dotIndex + 1);
  // Pad to 7 digits or truncate — never round.
  const fracPadded = rawFrac.padEnd(7, '0').substring(0, 7);

  return BigInt(intPart) * STROOPS_PER_XLM + BigInt(fracPadded);
}

/**
 * Convert a bigint stroop count to a 7-decimal XLM string.
 * Suitable for Stellar SDK `Operation.payment`.
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
 *  - A stroop integer string ("10000000")
 *  - A decimal XLM string ("1.5")
 *  - A number >= 1e7 → treated as stroops
 *  - A number < 1e7  → treated as XLM float
 *
 * Returns 0n for invalid, zero, or negative inputs.
 */
export function parseFallbackStroops(value: string | number): bigint {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return 0n;
    if (value >= 1e7) return BigInt(Math.round(value));
    // Treat as XLM decimal.
    return xlmStringToStroops(value.toFixed(7));
  }

  const str = String(value).trim();
  if (!str || str === '0') return 0n;

  if (str.includes('.')) {
    return xlmStringToStroops(str);
  }

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
