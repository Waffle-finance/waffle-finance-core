/**
 * Horizon payment verification for the XLM→ETH settlement path.
 *
 * Responsibilities
 * ----------------
 * 1. Confirm the Stellar transaction exists and succeeded on Horizon.
 * 2. Confirm it contains a native XLM payment TO the relayer's wallet.
 * 3. Optionally verify the source account matches the expected user address.
 * 4. Return the exact verified amount so the ETH release can use it.
 *
 * This is intentionally a pure function (no side effects, no global state)
 * so it is easy to unit-test by swapping the `fetchTx` / `fetchOps`
 * dependencies via the options object.
 *
 * Error taxonomy
 * --------------
 * All rejection reasons are expressed as typed errors so callers can map
 * them to the right HTTP status without string-matching:
 *
 *   StellarTxNotFoundError   → 404 (tx not on Horizon yet, or wrong hash)
 *   StellarTxFailedError     → 400 (tx was submitted but failed on-chain)
 *   StellarPaymentMismatch   → 400 (tx exists but doesn't match expectations)
 */

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/** The transaction was not found on Horizon (unknown hash or not yet indexed). */
export class StellarTxNotFoundError extends Error {
  readonly code = 'STELLAR_TX_NOT_FOUND' as const;
  constructor(stellarTxHash: string) {
    super(`Stellar transaction not found on Horizon: ${stellarTxHash}`);
    this.name = 'StellarTxNotFoundError';
  }
}

/** The transaction was found but its result_code indicates failure. */
export class StellarTxFailedError extends Error {
  readonly code = 'STELLAR_TX_FAILED' as const;
  constructor(stellarTxHash: string, resultCode: string) {
    super(
      `Stellar transaction failed on-chain: ${stellarTxHash} (result_code: ${resultCode})`
    );
    this.name = 'StellarTxFailedError';
  }
}

/**
 * The transaction exists and succeeded but does not match the required
 * payment shape (wrong destination, wrong asset, wrong source, etc.).
 */
export class StellarPaymentMismatch extends Error {
  readonly code = 'STELLAR_PAYMENT_MISMATCH' as const;
  constructor(reason: string) {
    super(`Stellar payment verification failed: ${reason}`);
    this.name = 'StellarPaymentMismatch';
  }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface VerifiedStellarPayment {
  /** The exact native XLM amount transferred (7-decimal string from Horizon). */
  amount: string;
  /** Stellar source account (the user's wallet). */
  from: string;
  /** Stellar destination account (the relayer's wallet). */
  to: string;
  /** Horizon ledger sequence the transaction was included in. */
  ledgerSequence: number;
  /** The tx memo text, if any. */
  memo?: string;
}

export interface VerifyPaymentOptions {
  /** Horizon base URL (e.g. https://horizon-testnet.stellar.org). */
  horizonUrl: string;
  /** The relayer's Stellar public key — must be the payment destination. */
  relayerPublicKey: string;
  /**
   * When provided, the source account of the payment must match this address.
   * Omit to skip source-account verification (e.g. when the user's address
   * is not known ahead of time).
   */
  expectedSourceAccount?: string;
  /**
   * Dependency-injectable Horizon fetch function.  Defaults to a real
   * Horizon SDK call.  Override in tests to avoid network access.
   *
   * Must return a transaction record (with `successful`, `ledger`,
   * `memo`, `result_xdr`) and an array of operation records.
   */
  _fetch?: (
    stellarTxHash: string,
    horizonUrl: string
  ) => Promise<{ tx: HorizonTxRecord; ops: HorizonOpRecord[] }>;
}

/** Minimal shape of what we need from Horizon's transaction record. */
export interface HorizonTxRecord {
  successful: boolean;
  ledger: number;
  memo?: string;
  /** Base64-encoded XDR result — inspected to surface terminal codes. */
  result_xdr?: string;
}

/** Minimal shape of what we need from Horizon's operation record. */
export interface HorizonOpRecord {
  type: string;
  from?: string;
  to?: string;
  amount?: string;
  asset_type?: string;
}

// ---------------------------------------------------------------------------
// Default Horizon fetch implementation
// ---------------------------------------------------------------------------

async function defaultFetch(
  stellarTxHash: string,
  horizonUrl: string
): Promise<{ tx: HorizonTxRecord; ops: HorizonOpRecord[] }> {
  const { Horizon } = await import('@stellar/stellar-sdk');
  const server = new Horizon.Server(horizonUrl);

  let txRecord: any;
  try {
    txRecord = await server.transactions().transaction(stellarTxHash).call();
  } catch (err: unknown) {
    // Horizon 404 surfaces as an error with status 404
    const status = (err as any)?.response?.status ?? (err as any)?.status ?? 0;
    if (status === 404) {
      throw new StellarTxNotFoundError(stellarTxHash);
    }
    throw err;
  }

  let opsResult: any;
  try {
    opsResult = await server.operations().forTransaction(stellarTxHash).call();
  } catch {
    opsResult = { records: [] };
  }

  return {
    tx: {
      successful: txRecord.successful,
      ledger: txRecord.ledger,
      memo: txRecord.memo,
      result_xdr: txRecord.result_xdr,
    },
    ops: opsResult.records ?? [],
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Verify that `stellarTxHash` represents a successful native XLM payment
 * to the relayer's wallet.
 *
 * @throws StellarTxNotFoundError  when the tx is unknown to Horizon
 * @throws StellarTxFailedError    when the tx was submitted but failed
 * @throws StellarPaymentMismatch  when the tx doesn't match requirements
 * @throws Error                   on unexpected Horizon/network errors
 */
export async function verifyIncomingStellarPayment(
  stellarTxHash: string,
  options: VerifyPaymentOptions
): Promise<VerifiedStellarPayment> {
  const { horizonUrl, relayerPublicKey, expectedSourceAccount } = options;
  const fetch = options._fetch ?? defaultFetch;

  // ── 1. Fetch tx + ops from Horizon ──────────────────────────────────────
  const { tx, ops } = await fetch(stellarTxHash, horizonUrl);

  // ── 2. Confirm the transaction succeeded ────────────────────────────────
  if (!tx.successful) {
    throw new StellarTxFailedError(stellarTxHash, 'tx_not_successful');
  }

  // ── 3. Find a native XLM payment to the relayer ─────────────────────────
  const paymentOp = ops.find(
    (op) =>
      op.type === 'payment' &&
      op.asset_type === 'native' &&
      op.to === relayerPublicKey
  );

  if (!paymentOp) {
    throw new StellarPaymentMismatch(
      `No native XLM payment to relayer (${relayerPublicKey}) found in transaction ${stellarTxHash}`
    );
  }

  if (!paymentOp.amount || parseFloat(paymentOp.amount) <= 0) {
    throw new StellarPaymentMismatch(
      `Payment amount is missing or zero in transaction ${stellarTxHash}`
    );
  }

  // ── 4. Optional: verify source account matches expected user ────────────
  if (
    expectedSourceAccount &&
    paymentOp.from !== expectedSourceAccount
  ) {
    throw new StellarPaymentMismatch(
      `Payment source account mismatch: expected ${expectedSourceAccount}, ` +
      `got ${paymentOp.from ?? 'unknown'} in transaction ${stellarTxHash}`
    );
  }

  return {
    amount: paymentOp.amount,
    from: paymentOp.from ?? '',
    to: paymentOp.to ?? relayerPublicKey,
    ledgerSequence: tx.ledger,
    memo: tx.memo,
  };
}
