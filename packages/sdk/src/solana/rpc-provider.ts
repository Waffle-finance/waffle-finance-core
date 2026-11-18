/**
 * Multi-endpoint Solana RPC provider with automatic failover (#713).
 *
 * Design
 * ──────
 * A single RPC endpoint is insufficient for production reliability.
 * This module wraps `@solana/web3.js` `Connection` calls and routes them
 * through a prioritised list of endpoints, trying each in turn on failure.
 *
 * Behaviour
 * ─────────
 * - Endpoints are tried in order (primary first, fallbacks after).
 * - Any transient error (network error, 5xx, timeout) causes an automatic
 *   fallback to the next endpoint.
 * - Non-transient errors (program errors, insufficient funds) are rethrown
 *   immediately without trying fallbacks.
 * - The provider tracks per-endpoint health (latency + consecutive errors)
 *   and emits a degraded status when all primaries are unhealthy.
 * - Callers can inspect `getHealth()` to surface the degraded state in
 *   `/health` endpoints and metrics.
 *
 * Usage
 * ─────
 * ```ts
 * const provider = new SolanaRpcProvider({
 *   endpoints: [
 *     "https://api.mainnet-beta.solana.com",
 *     "https://solana-api.projectserum.com",
 *   ],
 *   commitment: "confirmed",
 * });
 *
 * // Use anywhere a Connection is needed:
 * const slot = await provider.withFallback((conn) => conn.getSlot());
 * ```
 */

import { Connection, type Commitment } from "@solana/web3.js";

// ── Types ──────────────────────────────────────────────────────────────────

/** Health status for a single RPC endpoint. */
export interface EndpointHealth {
  url: string;
  consecutiveErrors: number;
  lastErrorMs: number | null;
  lastSuccessMs: number | null;
  latencyMs: number | null;
}

/** Overall provider health summary. */
export interface SolanaProviderHealth {
  /** True when at least one endpoint responded successfully in the last window. */
  healthy: boolean;
  /** True when the primary endpoint is down but at least one fallback is working. */
  degraded: boolean;
  /** Endpoint-level breakdown for observability. */
  endpoints: EndpointHealth[];
  /** The URL of the endpoint that served the most recent successful call. */
  activeEndpoint: string | null;
}

export interface SolanaRpcProviderOptions {
  /** Ordered list of endpoints — first is primary, rest are fallbacks. */
  endpoints: string[];
  /** Solana commitment level applied to all connections. */
  commitment?: Commitment;
  /**
   * Maximum consecutive errors on a single endpoint before it is deprioritised.
   * Default: 3.
   */
  maxConsecutiveErrors?: number;
  /**
   * How many milliseconds an endpoint must be error-free before being
   * promoted back to primary.  Default: 30_000 (30 s).
   */
  recoveryWindowMs?: number;
}

// ── Error classification ───────────────────────────────────────────────────

/** Categories that trigger fallback. */
const RETRYABLE_PATTERNS = [
  /timeout/i,
  /network/i,
  /connection (refused|reset|closed)/i,
  /fetch failed/i,
  /failed to fetch/i,
  /socket hang up/i,
  /503/,
  /502/,
  /504/,
  /429/,
  /ECONNREFUSED/,
  /ETIMEDOUT/,
  /ENOTFOUND/,
];

/**
 * Return true when the error is transient and retrying on a different
 * endpoint is likely to succeed.
 */
function isRetryable(err: unknown): boolean {
  const msg =
    err instanceof Error
      ? err.message
      : typeof err === "string"
      ? err
      : JSON.stringify(err);
  return RETRYABLE_PATTERNS.some((p) => p.test(msg));
}

// ── Provider ───────────────────────────────────────────────────────────────

/**
 * Multi-endpoint Solana RPC provider with automatic failover.
 *
 * Wraps `@solana/web3.js` Connection in a way that is transparent to
 * callers: pass any `(conn: Connection) => Promise<T>` to `withFallback`
 * and the provider handles endpoint selection and retry.
 */
export class SolanaRpcProvider {
  private readonly connections: Connection[];
  private readonly health: EndpointHealth[];
  private readonly maxConsecutiveErrors: number;
  private readonly recoveryWindowMs: number;
  private activeEndpointIdx: number = 0;
  private lastSuccessUrl: string | null = null;

  constructor(private readonly opts: SolanaRpcProviderOptions) {
    if (!opts.endpoints || opts.endpoints.length === 0) {
      throw new Error("SolanaRpcProvider: at least one endpoint is required");
    }

    const commitment = opts.commitment ?? "confirmed";
    this.maxConsecutiveErrors = opts.maxConsecutiveErrors ?? 3;
    this.recoveryWindowMs = opts.recoveryWindowMs ?? 30_000;

    this.connections = opts.endpoints.map(
      (url) => new Connection(url, commitment)
    );

    this.health = opts.endpoints.map((url) => ({
      url,
      consecutiveErrors: 0,
      lastErrorMs: null,
      lastSuccessMs: null,
      latencyMs: null,
    }));
  }

  // ── Public API ─────────────────────────────────────────────────────────

  /**
   * Execute `fn` against the best available endpoint, falling back through
   * the endpoint list on retryable errors.
   *
   * @param fn         A callback that receives a `Connection` and returns a
   *                   promise.  Will be called at most `endpoints.length` times.
   * @param context    Optional label for error/log messages.
   */
  async withFallback<T>(
    fn: (conn: Connection) => Promise<T>,
    context?: string
  ): Promise<T> {
    const order = this.buildEndpointOrder();
    const errors: Array<{ url: string; err: unknown }> = [];

    for (const idx of order) {
      const conn = this.connections[idx];
      const url = this.opts.endpoints[idx];
      const started = Date.now();

      try {
        const result = await fn(conn);
        const latencyMs = Date.now() - started;
        this.recordSuccess(idx, latencyMs);
        return result;
      } catch (err) {
        const latencyMs = Date.now() - started;
        this.recordError(idx, latencyMs);

        if (!isRetryable(err)) {
          // Non-transient error — bubble up immediately without trying fallbacks.
          throw err;
        }

        errors.push({ url, err });
        // Continue to the next endpoint.
      }
    }

    // All endpoints failed.
    const summary = errors
      .map((e) => `${e.url}: ${e.err instanceof Error ? e.err.message : String(e.err)}`)
      .join("; ");
    throw new SolanaRpcFallbackExhaustedError(
      `All Solana RPC endpoints failed${context ? ` (${context})` : ""}: ${summary}`,
      errors.map((e) => e.err)
    );
  }

  /**
   * Return the primary `Connection` object (for callers that construct
   * their own transactions and just need a connection handle).
   *
   * In degraded mode this returns the best available endpoint connection,
   * not necessarily the first configured endpoint.
   */
  getConnection(): Connection {
    const order = this.buildEndpointOrder();
    return this.connections[order[0]];
  }

  /**
   * Return the URL of the primary (first healthy) endpoint, or the first
   * configured endpoint if all are unhealthy.
   */
  getPrimaryUrl(): string {
    const order = this.buildEndpointOrder();
    return this.opts.endpoints[order[0]];
  }

  /** Return per-endpoint and aggregate health statistics. */
  getHealth(): SolanaProviderHealth {
    const now = Date.now();
    const endpoints = this.health.map((h) => ({ ...h }));
    const anyHealthy = endpoints.some(
      (h) =>
        h.lastSuccessMs !== null &&
        now - h.lastSuccessMs < this.recoveryWindowMs * 2
    );
    const primaryHealthy =
      endpoints[0].consecutiveErrors < this.maxConsecutiveErrors;
    const degraded = anyHealthy && !primaryHealthy;

    return {
      healthy: anyHealthy,
      degraded,
      endpoints,
      activeEndpoint: this.lastSuccessUrl,
    };
  }

  // ── Private helpers ────────────────────────────────────────────────────

  /**
   * Build an ordered list of endpoint indices to try.
   *
   * Healthy endpoints are tried first (in their original priority order),
   * degraded endpoints follow.  If an endpoint has been error-free for
   * longer than `recoveryWindowMs` it is considered recovered and promoted
   * back to the front of its tier.
   */
  private buildEndpointOrder(): number[] {
    const now = Date.now();
    const healthy: number[] = [];
    const degraded: number[] = [];

    for (let i = 0; i < this.health.length; i++) {
      const h = this.health[i];
      const recovered =
        h.consecutiveErrors > 0 &&
        h.lastErrorMs !== null &&
        now - h.lastErrorMs > this.recoveryWindowMs;

      if (recovered) {
        this.health[i].consecutiveErrors = 0;
      }

      if (this.health[i].consecutiveErrors >= this.maxConsecutiveErrors) {
        degraded.push(i);
      } else {
        healthy.push(i);
      }
    }

    const order = [...healthy, ...degraded];
    return order.length > 0 ? order : [0]; // fallback to index 0 if empty
  }

  private recordSuccess(idx: number, latencyMs: number): void {
    const h = this.health[idx];
    h.consecutiveErrors = 0;
    h.lastSuccessMs = Date.now();
    h.latencyMs = latencyMs;
    this.lastSuccessUrl = this.opts.endpoints[idx];
    this.activeEndpointIdx = idx;
  }

  private recordError(idx: number, _latencyMs: number): void {
    const h = this.health[idx];
    h.consecutiveErrors += 1;
    h.lastErrorMs = Date.now();
  }
}

// ── Errors ─────────────────────────────────────────────────────────────────

/** Thrown when every endpoint in the fallback chain has failed. */
export class SolanaRpcFallbackExhaustedError extends Error {
  constructor(
    message: string,
    public readonly causes: unknown[]
  ) {
    super(message);
    this.name = "SolanaRpcFallbackExhaustedError";
  }
}

// ── Utility: build a SolanaRpcProvider from a comma-separated env var ─────

/**
 * Parse a comma-separated list of RPC endpoint URLs and create a
 * `SolanaRpcProvider`.
 *
 * Accepts both a single URL and a comma-delimited list:
 *   "https://api.devnet.solana.com"
 *   "https://api.devnet.solana.com,https://fallback.example.com"
 */
export function createSolanaRpcProvider(
  rpcUrlEnv: string,
  commitment: Commitment = "confirmed",
  opts: Partial<SolanaRpcProviderOptions> = {}
): SolanaRpcProvider {
  const endpoints = rpcUrlEnv
    .split(",")
    .map((u) => u.trim())
    .filter((u) => u.length > 0);

  if (endpoints.length === 0) {
    throw new Error(
      "createSolanaRpcProvider: SOLANA_RPC_URL must contain at least one endpoint URL"
    );
  }

  return new SolanaRpcProvider({ endpoints, commitment, ...opts });
}
