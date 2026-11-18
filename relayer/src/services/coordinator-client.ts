/**
 * @fileoverview CoordinatorClient — safe fallback wrapper for coordinator HTTP calls.
 *
 * Issue #754: Add safe fallback when coordinator order metadata is unavailable.
 *
 * Problem
 * -------
 * The relayer depends on coordinator state to decide whether an order should
 * proceed to settlement or be held for recovery.  If the coordinator is
 * temporarily unreachable, the relayer must NOT fall back to guessing or to
 * stale cached data — it must stop and surface the degraded state so operators
 * can intervene rather than letting an incorrect settlement execute.
 *
 * Solution
 * --------
 * CoordinatorClient wraps every coordinator HTTP call with:
 *
 *  1. AVAILABILITY TRACKING — consecutive failure count drives a circuit that
 *     flips the client into SAFE_MODE after MAX_CONSECUTIVE_FAILURES.
 *
 *  2. SAFE_MODE — when in safe mode, all metadata fetch calls return null and
 *     log a structured warning.  No settlement action is taken on null metadata.
 *
 *  3. METRICS — every fetch is counted by result (success | failure | timeout)
 *     via coordinatorStateFetchTotal.  coordinatorStalenessSeconds tracks age
 *     of the last successful fetch.  coordinatorFallbacksTotal counts refused
 *     settlement actions.
 *
 *  4. HEALTH REPORTING — isAvailable() and getSafeModeReason() let the health
 *     endpoint reflect coordinator state without importing fetch logic.
 *
 * Usage
 * -----
 * ```ts
 * const client = new CoordinatorClient({ baseUrl: 'http://coordinator:3000' });
 *
 * const meta = await client.getOrderMetadata(orderId);
 * if (!client.isAvailable() || meta === null) {
 *   coordinatorFallbacksTotal.inc({ reason: 'unavailable' });
 *   logger.warn({ orderId }, '[coordinator-client] blocked settlement: coordinator unavailable');
 *   return res.status(503).json({ error: 'coordinator_unavailable' });
 * }
 * ```
 */

import { getLogger } from '../logger.js';
import {
  coordinatorStateFetchTotal,
  coordinatorStalenessSeconds,
  coordinatorFallbacksTotal,
} from '../metrics.js';

const log = getLogger().child({ service: 'coordinator-client' });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Number of consecutive failures before entering SAFE_MODE. */
const MAX_CONSECUTIVE_FAILURES = 3;

/** Fetch timeout in milliseconds.  Sized to avoid blocking settlement paths. */
const FETCH_TIMEOUT_MS = 5_000;

/** Maximum age (ms) of a cached health result before it is considered stale. */
const STALE_THRESHOLD_MS = 30_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CoordinatorOrderMetadata {
  orderId: string;
  status: string;
  hashlock?: string | null;
  direction?: string | null;
  resolverAddress?: string | null;
  createdAt?: number | null;
}

export interface CoordinatorClientOptions {
  /** Base URL of the coordinator service, e.g. http://coordinator:3001 */
  baseUrl: string;
  /** Override fetch timeout in ms (default: 5 000). */
  timeoutMs?: number;
  /** Override consecutive-failure threshold for SAFE_MODE (default: 3). */
  maxConsecutiveFailures?: number;
}

// ---------------------------------------------------------------------------
// CoordinatorClient
// ---------------------------------------------------------------------------

export class CoordinatorClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxConsecutiveFailures: number;

  /** Monotonic count of consecutive fetch failures (any kind). */
  private consecutiveFailures = 0;

  /** Epoch ms of the last successful coordinator fetch. */
  private lastSuccessAt: number | null = null;

  /** Whether the client is currently in safe mode. */
  private safeModeActive = false;

  /** Human-readable reason the client entered safe mode. */
  private safeModeReason: string | null = null;

  constructor(opts: CoordinatorClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS;
    this.maxConsecutiveFailures = opts.maxConsecutiveFailures ?? MAX_CONSECUTIVE_FAILURES;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Returns true when the coordinator has been reachable within the last
   * STALE_THRESHOLD_MS and the client is not in safe mode.
   */
  isAvailable(): boolean {
    if (this.safeModeActive) return false;
    if (this.lastSuccessAt === null) return false;
    return Date.now() - this.lastSuccessAt < STALE_THRESHOLD_MS;
  }

  /** Returns the safe-mode reason string, or null when not in safe mode. */
  getSafeModeReason(): string | null {
    return this.safeModeReason;
  }

  /** Age in seconds of the last successful coordinator response. */
  getStalenessSeconds(): number | null {
    if (this.lastSuccessAt === null) return null;
    return (Date.now() - this.lastSuccessAt) / 1000;
  }

  /**
   * Fetch order metadata from the coordinator.
   *
   * Returns null when:
   *   - The client is in safe mode (consecutive failures exceeded threshold).
   *   - The HTTP request times out.
   *   - The coordinator returns a non-2xx response.
   *   - Any network error occurs.
   *
   * Callers MUST treat null as "do not proceed with settlement".
   */
  async getOrderMetadata(orderId: string): Promise<CoordinatorOrderMetadata | null> {
    if (this.safeModeActive) {
      coordinatorFallbacksTotal.inc({ reason: 'safe_mode' });
      log.warn(
        { orderId, safeModeReason: this.safeModeReason },
        '[coordinator-client] safe mode active — returning null metadata',
      );
      return null;
    }

    const url = `${this.baseUrl}/api/orders/${encodeURIComponent(orderId)}`;
    return this._fetch<CoordinatorOrderMetadata>(url, orderId);
  }

  /**
   * Probe the coordinator health endpoint to refresh availability state.
   *
   * Called by the relayer health route to include coordinator reachability
   * in the /readyz and /health responses.
   */
  async probe(): Promise<boolean> {
    const url = `${this.baseUrl}/healthz`;
    const result = await this._fetch<{ status: string }>(url, 'health-probe');
    return result !== null;
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private async _fetch<T>(url: string, context: string): Promise<T | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, { signal: controller.signal });

      if (!response.ok) {
        this._recordFailure(`http_${response.status}`);
        coordinatorStateFetchTotal.inc({ result: 'failure' });
        log.warn(
          { context, status: response.status },
          '[coordinator-client] non-2xx response from coordinator',
        );
        return null;
      }

      const body = (await response.json()) as T;
      this._recordSuccess();
      coordinatorStateFetchTotal.inc({ result: 'success' });
      return body;
    } catch (err: unknown) {
      const isTimeout = err instanceof Error && err.name === 'AbortError';
      const reason = isTimeout ? 'timeout' : 'connection_error';

      this._recordFailure(reason);
      coordinatorStateFetchTotal.inc({ result: isTimeout ? 'timeout' : 'failure' });
      log.warn(
        { context, reason },
        '[coordinator-client] fetch failed',
      );
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private _recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.lastSuccessAt = Date.now();
    coordinatorStalenessSeconds.set(0);

    if (this.safeModeActive) {
      log.info('[coordinator-client] coordinator reachable — exiting safe mode');
      this.safeModeActive = false;
      this.safeModeReason = null;
    }
  }

  private _recordFailure(reason: string): void {
    this.consecutiveFailures += 1;

    // Update staleness gauge with current age.
    if (this.lastSuccessAt !== null) {
      coordinatorStalenessSeconds.set((Date.now() - this.lastSuccessAt) / 1000);
    }

    if (!this.safeModeActive && this.consecutiveFailures >= this.maxConsecutiveFailures) {
      this.safeModeActive = true;
      this.safeModeReason =
        `${this.consecutiveFailures} consecutive failures (last: ${reason})`;
      log.error(
        { consecutiveFailures: this.consecutiveFailures, reason },
        '[coordinator-client] entering safe mode — settlement actions will be blocked',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton
// ---------------------------------------------------------------------------

let _globalClient: CoordinatorClient | null = null;

/**
 * Return (or lazily create) the process-wide CoordinatorClient.
 *
 * The base URL is read from COORDINATOR_URL env var, defaulting to
 * http://localhost:3001 for local development.
 */
export function getCoordinatorClient(): CoordinatorClient {
  if (!_globalClient) {
    const baseUrl = process.env.COORDINATOR_URL ?? 'http://localhost:3001';
    _globalClient = new CoordinatorClient({ baseUrl });
    log.info({ baseUrl }, '[coordinator-client] initialised');
  }
  return _globalClient;
}

/**
 * Replace the global client (used in tests / dependency injection).
 */
export function setCoordinatorClient(client: CoordinatorClient): void {
  _globalClient = client;
}

/**
 * Assert that coordinator metadata is available before executing a settlement
 * action.  Returns { safe: true } when the relayer may proceed, or
 * { safe: false, reason } when it must not.
 *
 * Increments coordinatorFallbacksTotal on every blocked action so the
 * Prometheus alert fires without requiring log parsing.
 */
export function assertCoordinatorSafe(
  client: CoordinatorClient,
  orderId: string,
  metadata: CoordinatorOrderMetadata | null,
): { safe: true } | { safe: false; reason: string } {
  if (!client.isAvailable()) {
    const reason = client.getSafeModeReason() ?? 'coordinator_unreachable';
    coordinatorFallbacksTotal.inc({ reason: 'unavailable' });
    log.warn(
      { orderId, reason },
      '[coordinator-client] settlement blocked — coordinator not available',
    );
    return { safe: false, reason };
  }

  if (metadata === null) {
    coordinatorFallbacksTotal.inc({ reason: 'null_metadata' });
    log.warn(
      { orderId },
      '[coordinator-client] settlement blocked — null metadata returned',
    );
    return { safe: false, reason: 'null_metadata' };
  }

  return { safe: true };
}
