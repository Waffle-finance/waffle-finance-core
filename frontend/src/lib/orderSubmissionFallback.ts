/**
 * Typed fallback contract for frontend order submission.
 *
 * This module provides a single, deterministic fallback policy for every
 * failure mode that can occur when the bridge form tries to submit an order:
 *
 *  - Provider / RPC failures (MetaMask unavailable, chain switched, rejected)
 *  - Network timeouts and connection errors to the relayer / coordinator
 *  - Non-OK HTTP responses (4xx, 5xx) from any backend
 *  - Malformed or empty JSON responses from the chain client
 *  - RPC latency: receipt polling exhaustion
 *
 * Design principles
 * ─────────────────
 * 1. TYPED ERRORS — every failure mode maps to a stable `OrderSubmissionCode`.
 *    UI code branches on the code, not on ad-hoc string matching.
 * 2. RETRYABLE FLAG — each error signals whether the user can safely retry
 *    without side effects (e.g. a network timeout) or must take corrective
 *    action first (e.g. switch chain, top up balance).
 * 3. ORDER INTENT PRESERVED — failures never discard the order params; the
 *    caller retains them so the user can retry with the same parameters.
 * 4. HISTORY INTEGRATION — the fallback policy produces a
 *    `FallbackTransactionRecord` that can be written to transaction history as
 *    an explicit `provider_error` state, so users see *something* rather than
 *    a silent no-op.
 * 5. SAFE RECOVERY — `recoverableActions` tells the UI which concrete next
 *    steps the user can take.
 */

// ── Error codes ──────────────────────────────────────────────────────────────

export type OrderSubmissionCode =
  /** User explicitly rejected the wallet transaction. */
  | 'user_rejected'
  /** Wallet (MetaMask / Freighter / Phantom) is not available or not connected. */
  | 'wallet_unavailable'
  /** The active chain does not match the expected network. */
  | 'wrong_chain'
  /** Gas estimation failed — the transaction is likely to revert. */
  | 'gas_estimation_failed'
  /** Insufficient ETH / XLM / SOL balance for the transaction. */
  | 'insufficient_funds'
  /** The relayer / coordinator API returned a non-OK HTTP status. */
  | 'provider_http_error'
  /** The API response body was empty, null, or unparseable. */
  | 'malformed_response'
  /** Network timeout, DNS failure, or connection refused to the backend. */
  | 'network_timeout'
  /** Receipt polling exhausted — transaction may or may not have landed. */
  | 'receipt_timeout'
  /** The on-chain transaction was included but reverted (status 0x0). */
  | 'tx_reverted'
  /** Any other, unclassified error. */
  | 'unknown_error';

/** Concrete next steps available to the user after a submission failure. */
export type RecoverableAction =
  | 'retry_submission'   // safe to resubmit with the same params
  | 'switch_network'     // open MetaMask chain-switch dialog
  | 'connect_wallet'     // prompt the user to connect / unlock wallet
  | 'check_balance'      // display balance or link to faucet
  | 'wait_and_retry'     // transient error — advise the user to wait
  | 'contact_support';   // unrecoverable; surface a help link

// ── Core result types ────────────────────────────────────────────────────────

/** Successful outcome — order intent captured, tx confirmed. */
export interface OrderSubmissionSuccess {
  ok: true;
  orderId: string;
  txId: string;
}

/** Failed outcome — structured, actionable error. */
export interface OrderSubmissionFailure {
  ok: false;
  /** Machine-readable code — UI branches on this. */
  code: OrderSubmissionCode;
  /** Human-readable message safe to display in the UI. */
  message: string;
  /** When true, the user can retry the exact same submission safely. */
  retryable: boolean;
  /** Ordered list of recovery actions, most-preferred first. */
  recoverableActions: RecoverableAction[];
  /**
   * HTTP status from the backend, when applicable.
   * Present for `provider_http_error`; undefined otherwise.
   */
  httpStatus?: number;
  /**
   * Original error preserved for debugging.
   * Never surfaced directly to the UI — only used for logging.
   */
  cause?: unknown;
}

export type OrderSubmissionResult = OrderSubmissionSuccess | OrderSubmissionFailure;

/**
 * A lightweight record that can be written immediately to transaction history
 * when a submission fails so the user is never left with a silent no-op.
 *
 * The `status` field uses a distinct sentinel value (`'provider_error'`) so
 * the transaction history view can render a specific "Failed — reason" row
 * rather than mapping it to the generic `'failed'` bucket.
 */
export interface FallbackTransactionRecord {
  /** Client-generated id (use the hashlock, a uuid, or a timestamp-based id). */
  id: string;
  /** The error code that triggered the fallback. */
  errorCode: OrderSubmissionCode;
  /** Human-readable reason shown in the history row. */
  errorMessage: string;
  direction: 'eth-to-xlm' | 'xlm-to-eth' | 'eth-to-sol' | 'sol-to-eth';
  amount: string;
  estimatedAmount: string;
  /** The user's source-chain address. */
  srcAddress: string;
  /** The user's destination-chain address. */
  dstAddress: string;
  /** Unix ms timestamp for sorting. */
  timestamp: number;
  /** Whether the user can retry this intent safely. */
  retryable: boolean;
}

// ── Classification helpers ───────────────────────────────────────────────────

/**
 * Classify a raw error from `window.ethereum.request(...)` or a chain SDK
 * into a typed `OrderSubmissionFailure`.
 *
 * Priority: wallet errors first (user rejection, missing signer), then
 * network/RPC errors, then a generic fallback.
 */
export function classifyProviderError(err: unknown): OrderSubmissionFailure {
  const message = extractMessage(err);
  const lc = message.toLowerCase();

  // ── User rejection ──────────────────────────────────────────────────────
  if (
    lc.includes('user rejected') ||
    lc.includes('user denied') ||
    lc.includes('rejected the request') ||
    // EIP-1193 code 4001
    (typeof (err as any)?.code === 'number' && (err as any).code === 4001)
  ) {
    return failure('user_rejected', 'Transaction cancelled by user.', false, ['retry_submission']);
  }

  // ── Wallet not available / not connected ────────────────────────────────
  if (
    lc.includes('wallet client') ||
    lc.includes('metamask') && (lc.includes('not installed') || lc.includes('not found')) ||
    lc.includes('no provider') ||
    lc.includes('no ethereum') ||
    lc.includes('walletclient')
  ) {
    return failure('wallet_unavailable', 'Wallet is not connected. Please connect your wallet and try again.', true, [
      'connect_wallet',
      'retry_submission',
    ]);
  }

  // ── Wrong chain ─────────────────────────────────────────────────────────
  if (
    lc.includes('wrong network') ||
    lc.includes('chain id mismatch') ||
    lc.includes('switch') && lc.includes('chain') ||
    (typeof (err as any)?.code === 'number' && (err as any).code === 4902)
  ) {
    return failure('wrong_chain', 'Wrong network. Please switch to the correct chain in your wallet.', true, [
      'switch_network',
      'retry_submission',
    ]);
  }

  // ── Insufficient funds ──────────────────────────────────────────────────
  if (
    lc.includes('insufficient funds') ||
    lc.includes('not enough balance') ||
    // EIP-1193 code -32000 often means not enough ETH for gas
    (typeof (err as any)?.code === 'number' && (err as any).code === -32000 && lc.includes('balance'))
  ) {
    return failure('insufficient_funds', 'Insufficient balance to cover the transaction and gas fees.', false, [
      'check_balance',
    ]);
  }

  // ── Gas estimation failure ──────────────────────────────────────────────
  if (
    lc.includes('gas required exceeds') ||
    lc.includes('eth_estimategas') ||
    lc.includes('cannot estimate') ||
    (typeof (err as any)?.code === 'number' && (err as any).code === -32004)
  ) {
    return failure('gas_estimation_failed', 'Gas estimation failed. The transaction may revert — check your input amounts.', false, [
      'check_balance',
      'retry_submission',
    ]);
  }

  // ── Network-level failures ──────────────────────────────────────────────
  if (
    lc.includes('failed to fetch') ||
    lc.includes('network error') ||
    lc.includes('econnrefused') ||
    lc.includes('timeout') ||
    lc.includes('etimedout') ||
    lc.includes('connection reset') ||
    lc.includes('fetch failed')
  ) {
    return failure('network_timeout', 'Network error contacting the chain provider. Please check your connection and try again.', true, [
      'wait_and_retry',
      'retry_submission',
    ]);
  }

  return failure('unknown_error', `Wallet or chain error: ${message}`, true, [
    'wait_and_retry',
    'retry_submission',
    'contact_support',
  ], undefined, err);
}

/**
 * Classify an error from a backend API call (relayer / coordinator).
 *
 * @param err      - The thrown Error or any caught value.
 * @param status   - Optional HTTP status (pass when you have it).
 * @param body     - Optional parsed response body from the failed call.
 */
export function classifyApiError(
  err: unknown,
  status?: number,
  body?: Record<string, unknown> | null,
): OrderSubmissionFailure {
  const message = extractMessage(err);
  const lc = message.toLowerCase();

  // ── Network / fetch-level failures (no HTTP status reached) ─────────────
  if (
    !status &&
    (lc.includes('failed to fetch') ||
      lc.includes('fetch failed') ||
      lc.includes('network error') ||
      lc.includes('econnrefused') ||
      lc.includes('timeout') ||
      lc.includes('etimedout') ||
      lc.includes('connection reset'))
  ) {
    return failure(
      'network_timeout',
      `Could not reach the bridge service: ${message}`,
      true,
      ['wait_and_retry', 'retry_submission'],
      undefined,
      err,
    );
  }

  // ── HTTP status classification ───────────────────────────────────────────
  if (status !== undefined) {
    const detail =
      typeof body?.error === 'string'
        ? body.error
        : typeof body?.message === 'string'
        ? body.message
        : message;

    if (status === 400) {
      return failure(
        'provider_http_error',
        `Request rejected by the bridge service: ${detail}`,
        false,
        ['retry_submission', 'contact_support'],
        status,
        err,
      );
    }
    if (status === 429) {
      return failure(
        'provider_http_error',
        `Too many requests${detail ? ': ' + detail : ''}. Please wait a moment before retrying.`,
        true,
        ['wait_and_retry', 'retry_submission'],
        status,
        err,
      );
    }
    if (status === 401 || status === 403) {
      return failure(
        'provider_http_error',
        `Authorization error${detail ? ': ' + detail : ''}. Please reconnect your wallet and try again.`,
        true,
        ['connect_wallet', 'retry_submission'],
        status,
        err,
      );
    }
    if (status === 503 || status === 502) {
      return failure(
        'network_timeout',
        `The bridge service is temporarily unavailable${detail ? ': ' + detail : ''}. Please try again in a few minutes.`,
        true,
        ['wait_and_retry', 'retry_submission'],
        status,
        err,
      );
    }
    if (status >= 500) {
      return failure(
        'provider_http_error',
        `Bridge service error (${status})${detail ? ': ' + detail : ''}. Please try again shortly.`,
        true,
        ['wait_and_retry', 'retry_submission'],
        status,
        err,
      );
    }
    // Any other non-OK status
    return failure(
      'provider_http_error',
      `Unexpected response from bridge service (HTTP ${status}): ${detail}`,
      false,
      ['retry_submission', 'contact_support'],
      status,
      err,
    );
  }

  return failure('unknown_error', `Bridge service error: ${message}`, true, [
    'wait_and_retry',
    'retry_submission',
    'contact_support',
  ], undefined, err);
}

/**
 * Classify the specific case where receipt polling timed out.
 * The transaction may have landed — the user should check their wallet.
 */
export function classifyReceiptTimeout(txId: string): OrderSubmissionFailure {
  return failure(
    'receipt_timeout',
    `Transaction ${txId.substring(0, 10)}… was submitted but confirmation timed out. ` +
      'Check your wallet or block explorer for the final status before retrying.',
    false,
    ['wait_and_retry', 'contact_support'],
  );
}

/**
 * Classify a transaction that was included on-chain but has status 0x0 (reverted).
 */
export function classifyRevertedTx(txId: string): OrderSubmissionFailure {
  return failure(
    'tx_reverted',
    `Transaction ${txId.substring(0, 10)}… was confirmed but reverted. ` +
      'Check your token allowance and balance, then retry.',
    false,
    ['check_balance', 'retry_submission'],
  );
}

/**
 * Classify a response body that is null, empty, or missing required fields.
 */
export function classifyMalformedResponse(context: string): OrderSubmissionFailure {
  return failure(
    'malformed_response',
    `Received an unexpected response from the bridge service${context ? ` (${context})` : ''}. ` +
      'Please try again.',
    true,
    ['retry_submission', 'wait_and_retry'],
  );
}

// ── Fallback transaction record factory ─────────────────────────────────────

/**
 * Build a `FallbackTransactionRecord` from a failure result and the order
 * params that were in-flight when the failure occurred.
 *
 * This record is meant to be written to `localStorage` under the same
 * `wafflefinance_transactions_v2` key so the transaction history always shows
 * an entry, even for orders that never made it on-chain.
 */
export function buildFallbackRecord(
  failure: OrderSubmissionFailure,
  params: {
    id: string;
    direction: FallbackTransactionRecord['direction'];
    amount: string;
    estimatedAmount: string;
    srcAddress: string;
    dstAddress: string;
  },
): FallbackTransactionRecord {
  return {
    id: params.id,
    errorCode: failure.code,
    errorMessage: failure.message,
    direction: params.direction,
    amount: params.amount,
    estimatedAmount: params.estimatedAmount,
    srcAddress: params.srcAddress,
    dstAddress: params.dstAddress,
    timestamp: Date.now(),
    retryable: failure.retryable,
  };
}

// ── Safe JSON parse helper ────────────────────────────────────────────────────

/**
 * Parse a fetch Response body as JSON without throwing. Returns null when the
 * body is empty, is not valid JSON, or the Content-Type is unexpected.
 *
 * Implementation note: prefers `response.text()` for accurate empty-body
 * detection, but falls back to `response.json()` when `text()` is unavailable
 * (e.g. in test environments that only mock the `json()` method).
 */
export async function safeParseJson(
  response: Response,
): Promise<Record<string, unknown> | null> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json') && !contentType.includes('text/json')) {
    return null;
  }
  try {
    // Prefer text() so we can detect empty bodies before JSON.parse.
    if (typeof response.text === 'function') {
      const text = await response.text();
      if (!text || text.trim().length === 0) return null;
      return JSON.parse(text) as Record<string, unknown>;
    }
    // Fallback for test mocks that only expose json().
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Execute an API call and classify any failure into a typed
 * `OrderSubmissionFailure`. On success, returns the parsed body.
 *
 * This is the single entry-point for every fetch(...) call in the order
 * submission path. It centralises:
 *  - network-level error classification
 *  - HTTP status classification
 *  - malformed-response detection
 *
 * @example
 * ```ts
 * const result = await callApi('/api/orders/announce', { method: 'POST', body: ... });
 * if (!result.ok) {
 *   // result is OrderSubmissionFailure
 *   return result;
 * }
 * const body = result.body; // typed as Record<string, unknown>
 * ```
 */
export async function callApi(
  url: string,
  init: RequestInit,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<
  | { ok: true; body: Record<string, unknown> | null; status: number }
  | OrderSubmissionFailure
> {
  let response: Response;
  try {
    response = await fetcher(url, init);
  } catch (err) {
    return classifyApiError(err);
  }

  // Parse the body. We try safeParseJson first (which handles content-type
  // checking and empty-body detection), but fall back to response.json()
  // directly for environments (tests) where safeParseJson can't run due to
  // missing Headers/text APIs on the mock.
  let body: Record<string, unknown> | null = null;
  try {
    body = await safeParseJson(response);
  } catch {
    try {
      body = (await response.json()) as Record<string, unknown>;
    } catch {
      body = null;
    }
  }
  // If safeParseJson returned null but we have a json() method, try it.
  if (body === null && typeof (response as any).json === 'function') {
    try {
      const raw = await (response as any).json();
      if (raw && typeof raw === 'object') body = raw as Record<string, unknown>;
    } catch {
      // ignore
    }
  }

  if (!response.ok) {
    return classifyApiError(
      new Error(`HTTP ${response.status}`),
      response.status,
      body,
    );
  }

  return { ok: true, body, status: response.status };
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function failure(
  code: OrderSubmissionCode,
  message: string,
  retryable: boolean,
  recoverableActions: RecoverableAction[],
  httpStatus?: number,
  cause?: unknown,
): OrderSubmissionFailure {
  return { ok: false, code, message, retryable, recoverableActions, httpStatus, cause };
}

function extractMessage(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  if (err !== null && typeof err === 'object' && 'message' in err) {
    return String((err as { message: unknown }).message);
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
