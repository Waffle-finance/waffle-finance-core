/**
 * @fileoverview EVM transaction nonce coordination and replacement handling.
 *
 * Problem (#1082)
 * ---------------
 * Concurrent relayer actions can submit transactions from the same relayer
 * account, and an underpriced transaction may stay pending while recovery
 * logic attempts another action. Without coordination two actions can
 * collide on the same nonce (one is dropped) or recovery can double-settle
 * an order whose original transaction quietly confirmed after a timeout.
 *
 * Solution
 * --------
 * `NonceCoordinator` serializes nonce allocation at the narrowest necessary
 * boundary — a single relayer account — so concurrent actions never share a
 * nonce, and resolves the post-timeout ambiguity by checking the original
 * transaction's receipt *before* resubmitting. Replacement submissions
 * (fee bumps that reuse a nonce) record the original → replacement hash
 * lineage in structured logs so operators can trace a transaction's history.
 *
 * The coordinator is provider-agnostic: it depends on a small
 * {@link EvmNonceProvider} interface so a {@link FakeEvmProvider} (or a real
 * ethers `JsonRpcProvider`) can be injected. This keeps the nonce behaviour
 * unit-testable without a live chain.
 */

import { getLogger } from '../logger.js';

const log = getLogger().child({ component: 'nonce-coordinator' });

// ── Provider interface ────────────────────────────────────────────────────────

/** A receipt for a mined EVM transaction. */
export interface EvmReceipt {
  /** Transaction hash. */
  hash: string;
  /** Block the transaction was mined in. */
  blockNumber: number;
  /** 1 = success, 0 = reverted. */
  status: number;
  /** Confirmations observed (optional). */
  confirmations?: number;
}

/**
 * Minimal provider surface the coordinator relies on. Satisfied by ethers'
 * `JsonRpcProvider` or by {@link FakeEvmProvider} in tests.
 */
export interface EvmNonceProvider {
  getTransactionCount(address: string, blockTag?: string): Promise<number>;
  getTransactionReceipt(txHash: string): Promise<EvmReceipt | null>;
}

// ── Error types ───────────────────────────────────────────────────────────────

/** Base class for the typed submission outcomes the coordinator reacts to. */
export abstract class EvmSubmissionError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'EvmSubmissionError';
  }
}

/** The nonce submitted is below the account's current pending nonce. */
export class NonceTooLowError extends EvmSubmissionError {
  constructor(message = 'nonce too low') {
    super(message, 'NONCE_TOO_LOW');
    this.name = 'NonceTooLowError';
  }
}

/** A replacement transaction did not raise the fee enough. */
export class UnderpricedError extends EvmSubmissionError {
  constructor(message = 'replacement transaction underpriced') {
    super(message, 'UNDERPRICED');
    this.name = 'UnderpricedError';
  }
}

/**
 * Map a raw provider error into one of the typed submission errors, or
 * return `null` when the error is not a known nonce/fee condition. The
 * matching is intentionally string-based so it works with ethers errors,
 * plain `Error`s, and the {@link FakeEvmProvider}.
 */
export function classifySubmissionError(err: unknown): EvmSubmissionError | null {
  const msg =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : '';
  const lower = msg.toLowerCase();
  if (lower.includes('nonce too low') || lower.includes('replacementtransaction')) {
    // 'replacementtransaction' covers some node variants of nonce-too-low
    if (lower.includes('underpriced')) return new UnderpricedError(msg);
    return new NonceTooLowError(msg);
  }
  if (lower.includes('underpriced') || lower.includes('replacement underpriced')) {
    return new UnderpricedError(msg);
  }
  return null;
}

// ── Coordinator types ─────────────────────────────────────────────────────────

/**
 * Why a particular `buildAndSend` invocation is happening. Lets the builder
 * decide whether to bump the fee (replacement) or just change the nonce.
 */
export type SendReason = 'initial' | 'nonce_bump' | 'replacement_bump';

export interface SubmitContext {
  /** Nonce to use for this submission. */
  nonce: number;
  /** Why this submission is happening. */
  reason: SendReason;
  /** The hash this submission replaces, if any (replacement lineage). */
  replacing?: string;
}

/**
 * A caller-supplied function that builds and broadcasts a transaction with the
 * supplied nonce and returns its hash. Should throw a typed
 * {@link EvmSubmissionError} (or an error whose message matches the
 * classifier) so the coordinator can react to nonce/fee conditions.
 */
export type BuildAndSend = (ctx: SubmitContext) => Promise<string>;

export interface SubmitOptions {
  /** Relayer account whose nonce is being allocated. */
  account: string;
  /** Provider used to read the pending nonce and (optionally) receipts. */
  provider: EvmNonceProvider;
  /** Builds and broadcasts the transaction; returns its hash. */
  buildAndSend: BuildAndSend;
  /** Human-readable label for structured logs (e.g. orderId). */
  label?: string;
  /** Maximum nonce-bump retries on nonce-too-low. Defaults to 5. */
  maxNonceRetries?: number;
}

export interface SubmitResult {
  /** Hash of the submitted transaction. */
  txHash: string;
  /** Nonce that was actually used. */
  nonce: number;
  /** Number of send attempts made (≥1). */
  attempts: number;
  /** Hash this submission replaced, when the final attempt was a replacement. */
  replacedFrom?: string;
  /** Lineage of hashes for this logical submission, oldest first. */
  lineage: string[];
}

// ── Tracked account state ────────────────────────────────────────────────────

interface AccountState {
  /** Promise chain used to serialize access to this account's nonce. */
  chain: Promise<unknown>;
  /** Last nonce handed out / confirmed; the next submission starts here. */
  lastNonce: number | null;
  /** Hashes currently considered in-flight for the account (oldest first). */
  inFlight: string[];
}

// ── NonceCoordinator ──────────────────────────────────────────────────────────

/**
 * Coordinates EVM nonce allocation and replacement handling for a relayer
 * account.
 *
 * Construct one per process. The per-account lock guarantees that two
 * concurrent {@link submit} calls for the same account receive distinct
 * nonces, while {@link resolveAfterTimeout} prevents a second settlement
 * when a transaction that appeared to time out actually confirmed.
 */
export class NonceCoordinator {
  private readonly accounts = new Map<string, AccountState>();

  /**
   * Submit a transaction for `account`, serializing nonce allocation against
   * any other concurrent submission for the same account.
   *
   * Behaviour:
   *   - The first submission reads the pending nonce from the provider and
   *     records it; subsequent submissions (within the lock) advance by one.
   *   - On {@link NonceTooLowError} the nonce is bumped to the provider's
   *     current pending count and retried (up to `maxNonceRetries`).
   *
   * Use {@link replace} to replace a known pending transaction (fee bump) —
   * that path records the original → replacement hash lineage. Use
   * {@link resolveAfterTimeout} to avoid a second settlement when a timed-out
   * transaction actually confirmed.
   */
  async submit(opts: SubmitOptions): Promise<SubmitResult> {
    const { account, provider, buildAndSend, label = account } = opts;
    const maxNonceRetries = opts.maxNonceRetries ?? 5;
    const state = this._state(account);

    // Serialize all nonce decisions for this account. The lock is held for
    // the duration of a single logical submission (including its internal
    // retries) so the next submission sees the nonce we just consumed.
    return this._runSerialized(account, async () => {
      let nonce = await this._nextNonce(account, provider);
      let attempts = 0;
      const lineage: string[] = [];

      for (;;) {
        attempts++;
        const ctx: SubmitContext = {
          nonce,
          reason: attempts === 1 ? 'initial' : 'nonce_bump',
        };
        let hash: string;
        try {
          hash = await buildAndSend(ctx);
        } catch (err) {
          const classified = classifySubmissionError(err);
          if (classified instanceof NonceTooLowError) {
            if (attempts > maxNonceRetries) {
              throw err;
            }
            nonce = await provider.getTransactionCount(account, 'pending');
            log.warn({ account, label, nonce, reason: 'nonce_too_low' }, '[nonce] rebasing nonce after nonce-too-low');
            continue;
          }
          throw err;
        }

        lineage.push(hash);
        state.lastNonce = nonce;
        state.inFlight = [hash];
        log.info(
          { account, label, nonce, txHash: hash, reason: ctx.reason, lineage },
          '[nonce] transaction submitted',
        );
        return { txHash: hash, nonce, attempts, lineage };
      }
    });
  }

  /**
   * Replace a known pending transaction for `account` with a fee-bumped
   * replacement at the same nonce.
   *
   * Records the replacement lineage (original → replacement[s]) in structured
   * logs. On {@link UnderpricedError} the same nonce is retried with the
   * builder expected to raise the fee, up to `maxFeeRetries`. On
   * {@link NonceTooLowError} the original is treated as already mined (the
   * account moved past this nonce) and the original hash is returned — no
   * second settlement is produced.
   */
  async replace(opts: {
    account: string;
    provider: EvmNonceProvider;
    /** Nonce of the pending transaction being replaced. */
    nonce: number;
    /** Hash of the pending transaction being replaced. */
    originalHash: string;
    buildAndSend: BuildAndSend;
    label?: string;
    maxFeeRetries?: number;
  }): Promise<SubmitResult> {
    const { account, nonce, originalHash, buildAndSend, label = account } = opts;
    const maxFeeRetries = opts.maxFeeRetries ?? 5;
    const state = this._state(account);

    return this._runSerialized(account, async () => {
      const lineage: string[] = [originalHash];
      let attempts = 0;
      let lastHash = originalHash;
      const replacedFrom = originalHash;

      for (;;) {
        attempts++;
        const ctx: SubmitContext = { nonce, reason: 'replacement_bump', replacing: lastHash };
        let hash: string;
        try {
          hash = await buildAndSend(ctx);
        } catch (err) {
          const classified = classifySubmissionError(err);
          if (classified instanceof UnderpricedError) {
            if (attempts > maxFeeRetries) throw err;
            log.warn({ account, label, nonce, replacing: lastHash, reason: 'underpriced' }, '[nonce] replacing underpriced in-flight tx');
            continue;
          }
          if (classified instanceof NonceTooLowError) {
            // The original mined (or was replaced elsewhere) — return it, do
            // not produce a second settlement.
            log.warn({ account, label, nonce, originalHash, reason: 'nonce_too_low_on_replace' }, '[nonce] original already mined — no replacement submitted');
            return { txHash: originalHash, nonce, attempts, replacedFrom, lineage };
          }
          throw err;
        }

        lineage.push(hash);
        lastHash = hash;
        state.inFlight = [hash];
        log.info(
          { account, label, nonce, txHash: hash, reason: 'replacement_bump', replacedFrom, lineage },
          '[nonce] replacement transaction submitted',
        );
        return { txHash: hash, nonce, attempts, replacedFrom, lineage };
      }
    });
  }

  /**
   * Resolve the outcome of a transaction that appeared to time out while
   * waiting for a receipt.
   *
   * Before resubmitting, the coordinator asks the provider for the *original*
   * transaction's receipt. If it confirmed, the original hash is returned
   * unchanged (outcome `confirmed`) — no second settlement. Only when the
   * original is genuinely absent does the caller resubmit via {@link submit}
   * (or via the optional `resubmit` hook).
   */
  async resolveAfterTimeout(opts: {
    account: string;
    provider: EvmNonceProvider;
    originalHash: string;
    label?: string;
    /**
     * Optional hook invoked only when the original is genuinely unconfirmed.
     * Return the replacement hash. When omitted, the coordinator returns
     * `outcome: 'missing'` and the caller decides how to resubmit.
     */
    resubmit?: () => Promise<string>;
  }): Promise<{ txHash: string; outcome: 'confirmed' | 'replaced' | 'missing' }> {
    const { account, provider, originalHash, label = account, resubmit } = opts;
    const receipt = await provider.getTransactionReceipt(originalHash);
    if (receipt) {
      // The original confirmed after the timeout window — do NOT resubmit.
      log.info(
        { account, label, originalHash, blockNumber: receipt.blockNumber, status: receipt.status },
        '[nonce] timed-out transaction confirmed — no second settlement',
      );
      return { txHash: originalHash, outcome: 'confirmed' };
    }
    if (!resubmit) {
      log.warn({ account, label, originalHash }, '[nonce] original unconfirmed and no resubmit hook — surfacing missing');
      return { txHash: originalHash, outcome: 'missing' };
    }
    const replacementHash = await resubmit();
    log.warn({ account, label, originalHash, replacementHash }, '[nonce] original unconfirmed — submitted replacement');
    return { txHash: replacementHash, outcome: 'replaced' };
  }

  /** Current in-flight hashes for an account (diagnostic / test helper). */
  inFlight(account: string): string[] {
    return [...(this._state(account).inFlight)];
  }

  /** Last nonce handed out for an account (diagnostic / test helper). */
  lastNonce(account: string): number | null {
    return this._state(account).lastNonce;
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  private _state(account: string): AccountState {
    let s = this.accounts.get(account);
    if (!s) {
      s = { chain: Promise.resolve(), lastNonce: null, inFlight: [] };
      this.accounts.set(account, s);
    }
    return s;
  }

  private _runSerialized<T>(account: string, fn: () => Promise<T>): Promise<T> {
    const state = this._state(account);
    const run = state.chain.then(fn, fn);
    // Keep the chain alive even if fn rejects so a failure doesn't block
    // subsequent submissions for the account.
    state.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async _nextNonce(account: string, provider: EvmNonceProvider): Promise<number> {
    const state = this._state(account);
    if (state.lastNonce !== null) {
      // Advance from the last nonce we handed out. This is what makes
      // concurrent submissions receive distinct nonces: each call, while
      // holding the account lock, increments from the previous one.
      return state.lastNonce + 1;
    }
    const pending = await provider.getTransactionCount(account, 'pending');
    state.lastNonce = pending - 1; // so +1 below yields `pending`
    return pending;
  }
}

// ── FakeEvmProvider (for tests) ───────────────────────────────────────────────

/**
 * In-memory EVM provider for nonce-coordination tests.
 *
 * Simulates:
 *   - `getTransactionCount(address, 'pending')` — the account's next nonce,
 *     advancing as transactions are accepted.
 *   - `sendTransaction(tx)` — accepts a tx with a nonce, returns a synthetic
 *     hash, and records it. Throws {@link NonceTooLowError} when the nonce is
 *     below the current pending count, or {@link UnderpricedError} when
 *     configured for the given nonce.
 *   - `getTransactionReceipt(hash)` — returns a receipt after the configured
 *     delay, or `null` when the tx was replaced or never mined.
 */
export class FakeEvmProvider implements EvmNonceProvider {
  /** Next nonce to use for a brand-new transaction (highest assigned + 1). */
  private nextPendingNonce = 0;
  /** Nonces that have been mined and can no longer be reused. */
  private readonly minedNonces = new Set<number>();
  /** Pending (submitted, unmined) txs keyed by nonce: nonce → current hash. */
  private readonly pendingByNonce = new Map<number, string>();
  private readonly receipts = new Map<string, { receipt: EvmReceipt; readyAt: number }>();
  /** nonce -> number of times to throw UnderpricedError before accepting. */
  private readonly underpricedForNonce = new Map<number, number>();
  private nowMs = 0;
  private hashCounter = 0;

  constructor(opts: { initialPendingNonce?: number; startNowMs?: number } = {}) {
    this.nextPendingNonce = opts.initialPendingNonce ?? 0;
    this.nowMs = opts.startNowMs ?? 0;
  }

  /** Advance the fake clock used for receipt-delay simulation. */
  advance(ms: number): void {
    this.nowMs += ms;
  }

  /** Configure the provider to reject the next `n` sends at `nonce` as underpriced. */
  rejectUnderpriced(nonce: number, times: number): void {
    this.underpricedForNonce.set(nonce, times);
  }

  async getTransactionCount(_address: string, _blockTag?: string): Promise<number> {
    return this.nextPendingNonce;
  }

  /**
   * Accept a transaction payload `{ nonce, from, ... }` and return a synthetic
   * hash. Throws typed errors for nonce-too-low / underpriced conditions.
   *
   * Nonce semantics:
   *   - A nonce already mined              → NonceTooLowError.
   *   - A nonce with a pending (unmined) tx → replacement: accepted unless
   *     configured underpriced, in which case UnderpricedError.
   *   - A nonce below the next-pending that is neither pending nor mined
   *     → NonceTooLowError.
   *   - Any new nonce ≥ next-pending       → accepted as a new tx.
   */
  async sendTransaction(tx: { nonce: number; from?: string; value?: bigint; data?: string }): Promise<string> {
    if (this.minedNonces.has(tx.nonce)) {
      throw new NonceTooLowError(`nonce too low: ${tx.nonce} (already mined)`);
    }
    const isReplacement = this.pendingByNonce.has(tx.nonce);
    if (!isReplacement && tx.nonce < this.nextPendingNonce) {
      throw new NonceTooLowError(`nonce too low: ${tx.nonce} (pending=${this.nextPendingNonce})`);
    }
    const remaining = this.underpricedForNonce.get(tx.nonce) ?? 0;
    if (remaining > 0) {
      this.underpricedForNonce.set(tx.nonce, remaining - 1);
      throw new UnderpricedError(`replacement transaction underpriced for nonce=${tx.nonce}`);
    }
    const hash = `0x${(this.hashCounter++).toString(16).padStart(8, '0')}tx`;
    if (isReplacement) {
      // The old pending tx at this nonce is replaced and will never mine.
      const oldHash = this.pendingByNonce.get(tx.nonce);
      if (oldHash) this.receipts.delete(oldHash);
    }
    this.pendingByNonce.set(tx.nonce, hash);
    this.nextPendingNonce = Math.max(this.nextPendingNonce, tx.nonce + 1);
    // Default: the tx is mineable immediately (ready at now). Tests can delay it.
    this.receipts.set(hash, {
      receipt: { hash, blockNumber: 1, status: 1, confirmations: 1 },
      readyAt: this.nowMs,
    });
    return hash;
  }

  /** Delay the receipt for `hash` until the fake clock reaches `readyAtMs`. */
  delayReceipt(hash: string, readyAtMs: number): void {
    const entry = this.receipts.get(hash);
    if (entry) entry.readyAt = readyAtMs;
  }

  /** Mark a hash as replaced (no receipt will ever be returned for it). */
  replace(hash: string): void {
    this.receipts.delete(hash);
  }

  async getTransactionReceipt(txHash: string): Promise<EvmReceipt | null> {
    const entry = this.receipts.get(txHash);
    if (!entry) return null;
    if (this.nowMs < entry.readyAt) return null; // not yet mined
    this.minedNonces.add(entry.receipt.blockNumber);
    return entry.receipt;
  }
}
