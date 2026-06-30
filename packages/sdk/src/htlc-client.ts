/**
 * Shared HTLC client interface and error types.
 *
 * All three chain clients (Ethereum, Soroban, Solana) implement this interface
 * so that multi-chain orchestration code can work with any client identically.
 *
 * Design goals
 * ─────────────
 * • createOrder  — locks funds on-chain and returns a normalised result
 * • claimOrder   — reveals the preimage and claims locked funds
 * • refundOrder  — returns funds after timelock expiry
 *
 * Each method always:
 *   - Returns a plain object (never throws for "expected" failures like
 *     insufficient balance — those are wrapped in HTLCError)
 *   - Includes a `txId` string (tx hash on EVM, Stellar tx hash, Solana sig)
 *   - Includes an `orderId` string (uint256 decimal on EVM, PDA base-58 on
 *     Solana, bigint-stringified on Soroban)
 *
 * The chain-specific clients retain their full type-safe APIs. This interface
 * is an additional normalisation layer for code that needs to work
 * chain-agnostically (e.g. the coordinator relayer, integration tests,
 * future route-abstraction layer).
 */

// ── Shared result types ─────────────────────────────────────────────────────

/** Result returned by any normalised createOrder call. */
export interface HTLCCreateResult {
  /** Chain transaction identifier (tx hash or signature). */
  txId: string;
  /**
   * Canonical order id for the chain.
   * - Ethereum: decimal string of the uint256 orderId returned by the contract
   * - Soroban:  the submitted transaction hash (Soroban orders are keyed by hashlock)
   * - Solana:   base-58 PDA address
   */
  orderId: string;
}

/** Result returned by any normalised claimOrder or refundOrder call. */
export interface HTLCTxResult {
  /** Chain transaction identifier. */
  txId: string;
}

// ── Error types ─────────────────────────────────────────────────────────────

export type HTLCErrorCode =
  /** The signer/wallet rejected the transaction or is unavailable. */
  | "wallet_unavailable"
  /** The on-chain simulation rejected the call (e.g. insufficient allowance). */
  | "simulation_failed"
  /** The transaction was submitted but the chain rejected it. */
  | "tx_rejected"
  /** The order does not exist or has already been settled. */
  | "order_not_found"
  /** The timelock has not yet expired; refund is premature. */
  | "timelock_not_expired"
  /** The preimage does not match the hashlock. */
  | "invalid_preimage"
  /** Client is in simulation/placeholder mode — no real on-chain call made. */
  | "simulation_mode"
  /** Any other chain-level error. */
  | "chain_error";

/**
 * Normalised error thrown by all chain-client methods when an expected failure
 * occurs.  Unexpected errors (programmer mistakes, null-deref, etc.) are still
 * plain `Error` instances.
 *
 * `retryable` is a hint for callers:
 *   - `true`  → transient (RPC timeout, nonce conflict) — safe to retry
 *   - `false` → permanent (order already claimed, wrong preimage) — do not retry
 */
export class HTLCError extends Error {
  public readonly code: HTLCErrorCode;
  public readonly retryable: boolean;
  /** Optional lower-level cause (chain SDK error, network error, etc.). */
  public readonly cause?: unknown;

  constructor(opts: {
    code: HTLCErrorCode;
    message: string;
    retryable?: boolean;
    cause?: unknown;
  }) {
    super(opts.message);
    this.name = "HTLCError";
    this.code = opts.code;
    this.retryable = opts.retryable ?? false;
    this.cause = opts.cause;
  }
}

// ── Shared interface ────────────────────────────────────────────────────────

/**
 * Normalised HTLC client interface implemented by all chain adapters.
 *
 * All methods may throw `HTLCError` for expected failures. Implementations
 * should wrap chain-specific errors into `HTLCError` before propagating.
 *
 * Generic type parameters let each adapter type its chain-specific signer
 * without losing type safety at the call site.
 *
 * @typeParam TCreateInput  — chain-specific create order input
 * @typeParam TSigner       — chain-specific signer (wallet client, callback, etc.)
 */
export interface IHTLCClient<TCreateInput = unknown, TSigner = unknown> {
  /**
   * Lock funds on-chain for an HTLC swap.
   *
   * @throws {HTLCError} with code `wallet_unavailable`, `simulation_failed`, or `tx_rejected`
   */
  createOrder(input: TCreateInput, signer?: TSigner): Promise<HTLCCreateResult>;

  /**
   * Reveal the preimage on-chain to claim locked funds.
   *
   * @param orderId   Chain-canonical order identifier.
   * @param preimage  0x-prefixed 32-byte hex string.
   * @param signer    Chain-specific signer (omit for EVM clients that
   *                  already hold a walletClient).
   *
   * @throws {HTLCError} with code `invalid_preimage`, `order_not_found`, or `tx_rejected`
   */
  claimOrder(orderId: string, preimage: `0x${string}`, signer?: TSigner): Promise<HTLCTxResult>;

  /**
   * Return locked funds to the sender after the timelock has expired.
   *
   * @param orderId  Chain-canonical order identifier.
   * @param signer   Chain-specific signer (omit for EVM clients).
   *
   * @throws {HTLCError} with code `timelock_not_expired`, `order_not_found`, or `tx_rejected`
   */
  refundOrder(orderId: string, signer?: TSigner): Promise<HTLCTxResult>;
}
