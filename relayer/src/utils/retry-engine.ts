/**
 * @fileoverview Typed retry engine with circuit breaker for the WaffleFinance relayer.
 *
 * Problem
 * -------
 * The relayer operates in a hostile environment: RPC rate limits, Horizon
 * timeouts, chain confirmation gaps, and transient node failures are normal.
 * The previous codebase handled retries inline — ad-hoc loops with magic
 * constants, no shared classification logic, and no way to stop a broken
 * path from hammering a degraded endpoint. Operators could not tell from
 * metrics whether a job was waiting, retrying, or permanently failed.
 *
 * Solution
 * --------
 * `RetryEngine` is a shared, configurable retry wrapper that all relayer
 * actions call instead of writing local retry loops. It provides:
 *
 *  1. FAULT CLASSIFICATION — every thrown error is classified before a
 *     retry decision is made:
 *       - `transient`            → retryable; apply exponential backoff
 *       - `confirmation_delay`   → retryable but with a longer cool-down;
 *                                  used for "tx not yet mined" conditions
 *       - `terminal`             → never retried; surfaced immediately
 *
 *  2. EXPONENTIAL BACKOFF WITH JITTER — delay doubles per attempt with
 *     ±20% jitter to prevent thundering-herd reconnect storms.
 *
 *  3. CIRCUIT BREAKER — each action namespace (e.g. 'rpc', 'horizon',
 *     'coordinator') maintains an independent breaker. After
 *     `circuitBreakerThreshold` consecutive failures the breaker opens
 *     and all subsequent calls fast-fail without touching the endpoint.
 *     The breaker resets after `circuitBreakerResetMs` of silence, or
 *     when `resetCircuit(action)` is called explicitly.
 *
 *  4. PROMETHEUS METRICS — every attempt, backoff, circuit trip, and
 *     fast-fail is recorded so operators can trace retry lifecycles.
 *
 *  5. CORRELATION INTEGRATION — when called inside a `withCorrelation`
 *     scope the engine records retry hops on the active context so the
 *     full retry path is visible per-order in logs.
 *
 * Fault classification
 * --------------------
 * Callers register a `FaultClassifier` for each action namespace. When none
 * is registered the default classifier is used:
 *
 *   - Errors matching `TERMINAL_PATTERNS` (bad auth, invalid params, etc.)
 *     → `terminal`
 *   - Errors matching `CONFIRMATION_DELAY_PATTERNS` (not mined, nonce too low)
 *     → `confirmation_delay`
 *   - Everything else → `transient`
 *
 * Callers can override or extend the default by providing a custom classifier
 * to `RetryEngine.run()`. This lets the xlm-refund and xlm-to-eth paths plug
 * in their existing `HorizonTimeoutError` / `HorizonTerminalError` taxonomy
 * without duplicating classification logic.
 *
 * Circuit breaker states
 * ----------------------
 *   closed  → normal operation; calls pass through
 *   open    → fast-fail; calls return CircuitOpenError without executing fn
 *   half-open → one probe call allowed; success → closed, failure → open
 *
 * Usage
 * -----
 * ```ts
 * const engine = new RetryEngine();
 *
 * // Simple RPC call with default classifier:
 * const blockNumber = await engine.run('rpc', () => provider.getBlockNumber());
 *
 * // Custom classifier for Horizon calls:
 * const result = await engine.run('horizon', submitTx, {
 *   classifier: (err) => {
 *     if (err instanceof HorizonTerminalError) return 'terminal';
 *     if (err instanceof HorizonTimeoutError)  return 'transient';
 *     return 'transient';
 *   },
 *   maxAttempts: 4,
 * });
 *
 * // Check circuit state:
 * engine.circuitState('rpc'); // 'closed' | 'open' | 'half-open'
 * engine.resetCircuit('rpc');  // force back to closed
 * ```
 */

import {
  retryEngineAttemptsTotal,
  retryEngineExhaustedTotal,
  retryEngineCircuitOpenedTotal,
  retryEngineCircuitRejectedTotal,
  retryEngineCircuitState,
  retryEngineBackoffSeconds,
} from '../metrics.js';
import { getCorrelation } from '../correlation/correlation-context.js';
import { getLogger } from '../logger.js';

// ---------------------------------------------------------------------------
// Fault classification
// ---------------------------------------------------------------------------

/** How a thrown error should be treated by the retry engine. */
export type FaultClass = 'transient' | 'confirmation_delay' | 'terminal';

/**
 * A function that maps a thrown error to a fault class.
 * Return `null` to fall through to the default classifier.
 */
export type FaultClassifier = (err: unknown) => FaultClass | null;

/**
 * Error patterns that indicate a terminal (non-retryable) fault.
 * These are checked against `error.message` case-insensitively.
 */
const TERMINAL_PATTERNS = [
  /invalid signature/i,
  /bad auth/i,
  /insufficient funds/i,
  /nonce too high/i,
  /transaction underpriced/i,
  /replacement transaction underpriced/i,
  /gas limit exceeded/i,
  /execution reverted/i,
  /not authorized/i,
  /invalid params/i,
  /method not found/i,
  /missing or invalid/i,
  /op_no_destination/i,
  /op_no_trust/i,
  /op_line_full/i,
  /tx_bad_auth/i,
  /tx_insufficient_balance/i,
  /tx_no_source_account/i,
];

/**
 * Error patterns that indicate a confirmation delay (tx submitted but not
 * yet mined / sequenced). These warrant a longer cool-down before retry.
 */
const CONFIRMATION_DELAY_PATTERNS = [
  /transaction not found/i,
  /tx not found/i,
  /nonce too low/i,
  /already known/i,
  /known transaction/i,
  /pending/i,
  /not yet mined/i,
  /waiting for confirmation/i,
];

/**
 * Default fault classifier applied when no custom classifier is provided
 * or when the custom classifier returns `null`.
 */
export function defaultClassifier(err: unknown): FaultClass {
  const msg =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : JSON.stringify(err);

  for (const pattern of TERMINAL_PATTERNS) {
    if (pattern.test(msg)) return 'terminal';
  }
  for (const pattern of CONFIRMATION_DELAY_PATTERNS) {
    if (pattern.test(msg)) return 'confirmation_delay';
  }
  return 'transient';
}

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

type BreakerState = 'closed' | 'open' | 'half-open';

interface CircuitBreaker {
  state: BreakerState;
  consecutiveFailures: number;
  lastFailureAt: number;
  halfOpenAllowed: boolean; // whether a probe call has been let through
}

// ---------------------------------------------------------------------------
// RetryEngine config
// ---------------------------------------------------------------------------

export interface RetryEngineOptions {
  /**
   * Default maximum number of attempts per `run()` call (including the first).
   * Defaults to 5.
   */
  defaultMaxAttempts?: number;

  /** Default base delay in ms. Doubles each attempt. Defaults to 1_000. */
  defaultBaseDelayMs?: number;

  /** Hard cap on delay in ms. Defaults to 30_000. */
  defaultMaxDelayMs?: number;

  /**
   * Extra multiplier applied to the calculated delay for `confirmation_delay`
   * faults. Defaults to 3 (confirmation delays get 3× the normal backoff).
   */
  confirmationDelayMultiplier?: number;

  /**
   * Number of consecutive failures in the same action namespace before the
   * circuit breaker opens. Defaults to 5.
   */
  circuitBreakerThreshold?: number;

  /**
   * How long (ms) the circuit stays open before entering half-open.
   * Defaults to 60_000 (1 minute).
   */
  circuitBreakerResetMs?: number;

  /** Jitter factor (fraction of delay, ±). Defaults to 0.2 (±20%). */
  jitterFactor?: number;
}

export interface RunOptions {
  /**
   * Custom fault classifier for this specific call.
   * Falls through to the default classifier when it returns `null`.
   */
  classifier?: FaultClassifier;

  /**
   * Override the max attempts for this specific call.
   */
  maxAttempts?: number;

  /**
   * Override the base delay for this specific call (ms).
   */
  baseDelayMs?: number;

  /**
   * Override the max delay for this specific call (ms).
   */
  maxDelayMs?: number;

  /**
   * Human-readable note attached to retry log lines for this call.
   * Useful for distinguishing two different `run('rpc', ...)` calls.
   */
  note?: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown when the retry engine exhausts all attempts.
 * `faultClass` is the classification of the last error.
 * `attempts` is the total number of attempts made.
 */
export class RetryExhaustedError extends Error {
  readonly faultClass: FaultClass;
  readonly attempts: number;
  readonly cause: unknown;
  constructor(message: string, faultClass: FaultClass, attempts: number, cause: unknown) {
    super(message);
    this.name = 'RetryExhaustedError';
    this.faultClass = faultClass;
    this.attempts = attempts;
    this.cause = cause;
  }
}

/**
 * Thrown when a call is rejected by an open circuit breaker (fast-fail).
 */
export class CircuitOpenError extends Error {
  readonly action: string;
  constructor(action: string) {
    super(`[retry-engine] Circuit for '${action}' is open — fast-failing`);
    this.name = 'CircuitOpenError';
    this.action = action;
  }
}

// ---------------------------------------------------------------------------
// RetryEngine
// ---------------------------------------------------------------------------

export class RetryEngine {
  private readonly cfg: Required<RetryEngineOptions>;
  private readonly breakers = new Map<string, CircuitBreaker>();

  constructor(options: RetryEngineOptions = {}) {
    const merged = {
      defaultMaxAttempts: 5,
      defaultBaseDelayMs: 1_000,
      defaultMaxDelayMs: 30_000,
      confirmationDelayMultiplier: 3,
      circuitBreakerThreshold: 5,
      circuitBreakerResetMs: 60_000,
      jitterFactor: 0.2,
      ...options,
    };

    // Clamp delay-related fields to their minimum sensible values so that a
    // negative base delay or jitter factor cannot collapse backoff into an
    // immediate busy-loop, which would make outage behaviour worse.
    merged.defaultBaseDelayMs = Math.max(0, merged.defaultBaseDelayMs);
    merged.defaultMaxDelayMs  = Math.max(0, merged.defaultMaxDelayMs);
    merged.jitterFactor        = Math.max(0, merged.jitterFactor);

    this.cfg = merged;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Execute `fn` under the retry engine for the given `action` namespace.
   *
   * - If the circuit for `action` is open, throws `CircuitOpenError` immediately.
   * - On each failure the error is classified, metrics are recorded, and a
   *   backoff delay is applied before the next attempt.
   * - Terminal faults are re-thrown immediately without further retries.
   * - After exhausting all attempts, throws `RetryExhaustedError`.
   */
  async run<T>(
    action: string,
    fn: () => Promise<T>,
    opts: RunOptions = {},
  ): Promise<T> {
    const maxAttempts = opts.maxAttempts ?? this.cfg.defaultMaxAttempts;
    const baseDelayMs = Math.max(0, opts.baseDelayMs ?? this.cfg.defaultBaseDelayMs);
    const maxDelayMs  = Math.max(0, opts.maxDelayMs  ?? this.cfg.defaultMaxDelayMs);

    // Circuit-breaker pre-check
    this._checkCircuit(action);

    let lastErr: unknown;
    let lastClass: FaultClass = 'transient';

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const result = await fn();
        // Success — reset the breaker failure count
        this._onSuccess(action);
        return result;
      } catch (err: unknown) {
        lastErr = err;
        lastClass = this._classify(err, opts.classifier);

        // Record attempt metric
        retryEngineAttemptsTotal.inc({ fault_class: lastClass, action });

        // Stamp the correlation context if we're inside a relay operation
        const ctx = getCorrelation();
        if (ctx && attempt > 1) {
          ctx.incrementRetry(`${action}:${lastClass}`);
        }

        _log('warn', `[retry-engine] attempt ${attempt}/${maxAttempts} failed`, {
          action,
          faultClass: lastClass,
          attempt,
          maxAttempts,
          note: opts.note,
          error: err instanceof Error ? err.message : String(err),
        });

        // Terminal fault — never retry
        if (lastClass === 'terminal') {
          this._onFailure(action);
          retryEngineExhaustedTotal.inc({ fault_class: lastClass, action });
          _log('error', `[retry-engine] terminal fault — aborting`, {
            action, attempt, error: err instanceof Error ? err.message : String(err),
          });
          throw err; // re-throw the original error directly
        }

        // Update circuit breaker on non-terminal failure
        this._onFailure(action);

        // No more attempts left
        if (attempt === maxAttempts) break;

        // Calculate backoff
        const delayMs = this._backoffDelay(attempt, baseDelayMs, maxDelayMs, lastClass);

        retryEngineBackoffSeconds.observe(
          { fault_class: lastClass, action },
          delayMs / 1000,
        );

        _log('info', `[retry-engine] backing off`, {
          action,
          faultClass: lastClass,
          attempt,
          delayMs,
          note: opts.note,
        });

        await _sleep(delayMs);

        // Re-check circuit after backoff (it may have opened during the delay)
        this._checkCircuit(action);
      }
    }

    retryEngineExhaustedTotal.inc({ fault_class: lastClass, action });
    throw new RetryExhaustedError(
      `[retry-engine] '${action}' exhausted ${maxAttempts} attempts (last fault: ${lastClass})`,
      lastClass,
      maxAttempts,
      lastErr,
    );
  }

  // ── Circuit breaker API ───────────────────────────────────────────────────

  /** Current circuit breaker state for an action namespace. */
  circuitState(action: string): BreakerState {
    return this._getBreaker(action).state;
  }

  /**
   * Force the circuit for `action` back to `closed` (e.g. after an operator
   * resolves a downstream outage and wants to resume immediately).
   */
  resetCircuit(action: string): void {
    const breaker = this._getBreaker(action);
    const prev = breaker.state;
    breaker.state = 'closed';
    breaker.consecutiveFailures = 0;
    breaker.halfOpenAllowed = false;
    retryEngineCircuitState.set({ action }, 0);
    _log('info', `[retry-engine] circuit reset to closed`, { action, prev });
  }

  /** Snapshot of all circuit breaker states — for health endpoints. */
  allCircuits(): Record<string, { state: BreakerState; consecutiveFailures: number }> {
    const out: Record<string, { state: BreakerState; consecutiveFailures: number }> = {};
    for (const [action, breaker] of this.breakers) {
      out[action] = { state: breaker.state, consecutiveFailures: breaker.consecutiveFailures };
    }
    return out;
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  private _classify(err: unknown, custom?: FaultClassifier): FaultClass {
    if (custom) {
      const result = custom(err);
      if (result !== null) return result;
    }
    return defaultClassifier(err);
  }

  private _backoffDelay(
    attempt: number,
    baseMs: number,
    maxMs: number,
    faultClass: FaultClass,
  ): number {
    const exponential = Math.min(maxMs, baseMs * Math.pow(2, attempt - 1));
    const jitter = this.cfg.jitterFactor * exponential * (Math.random() - 0.5) * 2;
    let delay = Math.max(0, Math.round(exponential + jitter));

    // Confirmation delays need more breathing room
    if (faultClass === 'confirmation_delay') {
      delay = Math.min(maxMs, delay * this.cfg.confirmationDelayMultiplier);
    }

    return delay;
  }

  // ── Circuit breaker internals ─────────────────────────────────────────────

  private _getBreaker(action: string): CircuitBreaker {
    if (!this.breakers.has(action)) {
      this.breakers.set(action, {
        state: 'closed',
        consecutiveFailures: 0,
        lastFailureAt: 0,
        halfOpenAllowed: false,
      });
    }
    return this.breakers.get(action)!;
  }

  private _checkCircuit(action: string): void {
    const breaker = this._getBreaker(action);

    if (breaker.state === 'closed') return;

    if (breaker.state === 'open') {
      const elapsed = Date.now() - breaker.lastFailureAt;
      if (elapsed >= this.cfg.circuitBreakerResetMs) {
        // Transition to half-open: allow one probe call
        breaker.state = 'half-open';
        breaker.halfOpenAllowed = true;
        retryEngineCircuitState.set({ action }, 0); // half-open treated as not fully open
        _log('info', `[retry-engine] circuit half-open — probing`, { action });
        return; // probe call allowed through
      }

      // Still open — fast-fail
      retryEngineCircuitRejectedTotal.inc({ action });
      throw new CircuitOpenError(action);
    }

    if (breaker.state === 'half-open') {
      if (breaker.halfOpenAllowed) {
        // Consume the probe slot
        breaker.halfOpenAllowed = false;
        return;
      }
      // Already used probe slot — fast-fail until we know the outcome
      retryEngineCircuitRejectedTotal.inc({ action });
      throw new CircuitOpenError(action);
    }
  }

  private _onSuccess(action: string): void {
    const breaker = this._getBreaker(action);
    if (breaker.state !== 'closed') {
      _log('info', `[retry-engine] circuit closed after successful probe`, {
        action,
        prev: breaker.state,
      });
    }
    breaker.state = 'closed';
    breaker.consecutiveFailures = 0;
    breaker.halfOpenAllowed = false;
    retryEngineCircuitState.set({ action }, 0);
  }

  private _onFailure(action: string): void {
    const breaker = this._getBreaker(action);
    breaker.consecutiveFailures++;
    breaker.lastFailureAt = Date.now();

    if (breaker.state === 'half-open') {
      // Probe failed — reopen immediately
      breaker.state = 'open';
      breaker.halfOpenAllowed = false;
      retryEngineCircuitState.set({ action }, 1);
      retryEngineCircuitOpenedTotal.inc({ action });
      _log('warn', `[retry-engine] circuit re-opened after failed probe`, { action });
      return;
    }

    if (
      breaker.state === 'closed' &&
      breaker.consecutiveFailures >= this.cfg.circuitBreakerThreshold
    ) {
      breaker.state = 'open';
      retryEngineCircuitState.set({ action }, 1);
      retryEngineCircuitOpenedTotal.inc({ action });
      _log('warn', `[retry-engine] circuit opened`, {
        action,
        consecutiveFailures: breaker.consecutiveFailures,
        threshold: this.cfg.circuitBreakerThreshold,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Process-wide singleton
// ---------------------------------------------------------------------------

/**
 * Shared RetryEngine instance for the relayer process.
 *
 * Action namespaces in use:
 *   'rpc'         — Ethereum JSON-RPC calls (provider.getBalance, sendTransaction, etc.)
 *   'horizon'     — Stellar Horizon API calls
 *   'coordinator' — HTTP calls to the coordinator service
 *   'price-feed'  — CoinGecko / price feed fetches
 *
 * In tests, create isolated instances:
 *   const engine = new RetryEngine({ defaultMaxAttempts: 2 });
 */
export const globalRetryEngine = new RetryEngine();

// ---------------------------------------------------------------------------
// Utilities (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Calculate the backoff delay for a given attempt without going through
 * a full RetryEngine instance. Useful for unit-testing delay curves.
 *
 * @param attempt     1-based attempt number.
 * @param baseMs      Base delay in ms.
 * @param maxMs       Hard cap in ms.
 * @param jitter      Jitter factor (0 = no jitter). Pass 0 for deterministic tests.
 * @param multiplier  Multiplier for confirmation_delay faults. Pass 1 for default.
 */
export function calculateBackoff(
  attempt: number,
  baseMs: number,
  maxMs: number,
  jitter = 0.2,
  multiplier = 1,
): number {
  const exponential = Math.min(maxMs, baseMs * Math.pow(2, attempt - 1));
  const j = jitter * exponential * (Math.random() - 0.5) * 2;
  const raw = Math.max(0, Math.round(exponential + j));
  return Math.min(maxMs, raw * multiplier);
}

// ---------------------------------------------------------------------------
// Private utilities
// ---------------------------------------------------------------------------

function _sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function _log(
  level: 'info' | 'warn' | 'error',
  msg: string,
  extra: Record<string, unknown> = {},
): void {
  getLogger()[level](extra, msg);
}
