/**
 * @file startup-health-check.ts
 *
 * Relayer startup dependency health-check with exponential back-off retry.
 *
 * Before the relayer begins processing orders it must confirm that its upstream
 * dependencies are reachable:
 *
 *   1. **Coordinator** — the order-book service must accept HTTP requests.
 *   2. **Resolver registry** — at least one resolver must be registered and
 *      active on-chain so orders can be settled.
 *
 * If a dependency is not ready the relayer enters a safe waiting loop, logs
 * each attempt with back-off delay information, and exits gracefully if the
 * configured maximum retry count is exceeded.
 *
 * ## Configuration (via environment variables)
 *
 * | Variable                              | Default | Description                                          |
 * |---------------------------------------|---------|------------------------------------------------------|
 * | RELAYER_STARTUP_MAX_RETRIES           | 10      | Maximum check attempts before giving up              |
 * | RELAYER_STARTUP_BACKOFF_BASE_MS       | 2000    | Base delay in ms for the first retry                 |
 * | RELAYER_STARTUP_BACKOFF_MAX_MS        | 30000   | Maximum delay cap in ms (prevents unbounded waits)   |
 * | COORDINATOR_URL                       | —       | Base URL of the coordinator service (required)       |
 * | RESOLVER_REGISTRY_URL                 | —       | URL to the resolver registry readiness endpoint      |
 */

// ── Types ──────────────────────────────────────────────────────────────────

export type StartupCheckResult =
  | { ok: true }
  | { ok: false; reason: string };

export interface StartupDependencyConfig {
  /** Base URL of the coordinator service, e.g. http://localhost:4000 */
  coordinatorUrl: string | undefined;
  /**
   * Base URL for the resolver registry liveness check.
   * The check calls `GET <resolverRegistryUrl>/healthz`.
   * If omitted the resolver registry check is skipped (optional dependency).
   */
  resolverRegistryUrl?: string | undefined;
  /** Maximum number of retry attempts.  Defaults to 10. */
  maxRetries?: number;
  /** Base back-off delay in ms before the first retry.  Defaults to 2 000. */
  backoffBaseMs?: number;
  /** Maximum back-off delay cap in ms.  Defaults to 30 000. */
  backoffMaxMs?: number;
  /**
   * Dependency-injectable fetch implementation.  Defaults to the global
   * `fetch`.  Override in tests to simulate connectivity.
   */
  _fetch?: typeof fetch;
  /**
   * Dependency-injectable sleep implementation.  Defaults to a real
   * `setTimeout`-based sleep.  Override in tests to skip actual delays.
   */
  _sleep?: (ms: number) => Promise<void>;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function calculateBackoff(attempt: number, baseMs: number, maxMs: number): number {
  // Exponential back-off: baseMs * 2^attempt, capped at maxMs.
  // Add ±10% jitter to avoid thundering-herd on simultaneous restarts.
  const exp = Math.min(baseMs * Math.pow(2, attempt), maxMs);
  const jitter = exp * 0.1 * (Math.random() * 2 - 1);
  return Math.round(Math.max(baseMs, exp + jitter));
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

// ── Individual dependency checks ───────────────────────────────────────────

/**
 * Verify the coordinator is reachable by calling `GET <url>/readyz`.
 * Returns ok=true when the HTTP status is 2xx; treats all other outcomes
 * (network errors, 4xx, 5xx) as not-ready.
 */
async function checkCoordinator(
  url: string,
  fetchFn: typeof fetch,
): Promise<StartupCheckResult> {
  const endpoint = `${url.replace(/\/+$/, "")}/readyz`;
  try {
    const res = await fetchFn(endpoint, { signal: AbortSignal.timeout(5_000) });
    if (res.ok) {
      return { ok: true };
    }
    return {
      ok: false,
      reason: `coordinator returned HTTP ${res.status} from ${endpoint}`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `coordinator unreachable at ${endpoint}: ${message}` };
  }
}

/**
 * Verify the resolver registry health endpoint is reachable.
 * Returns ok=true when the HTTP status is 2xx.
 * Returns ok=true (skipped) when `url` is not configured.
 */
async function checkResolverRegistry(
  url: string | undefined,
  fetchFn: typeof fetch,
): Promise<StartupCheckResult> {
  if (!url) {
    // Resolver registry is optional — if no URL is configured we skip the check.
    return { ok: true };
  }
  const endpoint = `${url.replace(/\/+$/, "")}/healthz`;
  try {
    const res = await fetchFn(endpoint, { signal: AbortSignal.timeout(5_000) });
    if (res.ok) {
      return { ok: true };
    }
    return {
      ok: false,
      reason: `resolver registry returned HTTP ${res.status} from ${endpoint}`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `resolver registry unreachable at ${endpoint}: ${message}` };
  }
}

// ── Main entry-point ───────────────────────────────────────────────────────

/**
 * Run startup dependency health checks with exponential back-off retry.
 *
 * Resolves when all checks pass.  Rejects with an `Error` describing the
 * failing dependency when `maxRetries` is exhausted without success.
 *
 * @example
 * ```ts
 * await assertStartupDependencies({
 *   coordinatorUrl: process.env.COORDINATOR_URL,
 *   resolverRegistryUrl: process.env.RESOLVER_REGISTRY_URL,
 * });
 * ```
 */
export async function assertStartupDependencies(
  cfg: StartupDependencyConfig,
): Promise<void> {
  const maxRetries = cfg.maxRetries ?? 10;
  const backoffBaseMs = cfg.backoffBaseMs ?? 2_000;
  const backoffMaxMs = cfg.backoffMaxMs ?? 30_000;
  const fetchFn = cfg._fetch ?? fetch;
  const sleepFn = cfg._sleep ?? defaultSleep;

  if (!cfg.coordinatorUrl) {
    throw new Error(
      "[startup] COORDINATOR_URL is not set — cannot verify coordinator availability. " +
        "Set COORDINATOR_URL to the base URL of the coordinator service before starting the relayer.",
    );
  }

  console.log("[startup] beginning dependency health checks");
  console.log(`[startup] coordinator: ${cfg.coordinatorUrl}`);
  if (cfg.resolverRegistryUrl) {
    console.log(`[startup] resolver registry: ${cfg.resolverRegistryUrl}`);
  } else {
    console.log("[startup] resolver registry: not configured (skipping check)");
  }
  console.log(`[startup] max retries: ${maxRetries}, back-off base: ${backoffBaseMs} ms, cap: ${backoffMaxMs} ms`);

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // ── Run all checks in parallel ───────────────────────────────────────
    const [coordinatorResult, resolverResult] = await Promise.all([
      checkCoordinator(cfg.coordinatorUrl, fetchFn),
      checkResolverRegistry(cfg.resolverRegistryUrl, fetchFn),
    ]);

    const failures: string[] = [];
    if (!coordinatorResult.ok) failures.push(`coordinator: ${coordinatorResult.reason}`);
    if (!resolverResult.ok) failures.push(`resolver registry: ${resolverResult.reason}`);

    if (failures.length === 0) {
      console.log(`[startup] all dependency checks passed (attempt ${attempt + 1}/${maxRetries + 1})`);
      return;
    }

    // ── Log failures ─────────────────────────────────────────────────────
    if (attempt < maxRetries) {
      const delay = calculateBackoff(attempt, backoffBaseMs, backoffMaxMs);
      console.warn(
        `[startup] dependency check failed (attempt ${attempt + 1}/${maxRetries + 1}, ` +
          `retrying in ${delay} ms):`,
      );
      for (const f of failures) {
        console.warn(`[startup]   - ${f}`);
      }
      console.log(`[startup] waiting ${delay} ms before next attempt...`);
      await sleepFn(delay);
    } else {
      // ── Max retries exceeded — exit gracefully ────────────────────────
      console.error(
        `[startup] dependency health checks failed after ${maxRetries + 1} attempt(s). ` +
          "The relayer will not start until all required dependencies are available.",
      );
      for (const f of failures) {
        console.error(`[startup]   FAILED: ${f}`);
      }
      throw new Error(
        `Relayer startup aborted: dependency health checks failed after ${maxRetries + 1} attempt(s).\n` +
          failures.map((f) => `  - ${f}`).join("\n"),
      );
    }
  }
}

/**
 * Log startup state transitions for observability.
 *
 * Call this at key transitions during the startup sequence so operators can
 * correlate log lines with timing without enabling debug-level logging.
 */
export function logStartupTransition(
  phase:
    | "config_validated"
    | "deps_checking"
    | "deps_ready"
    | "listeners_starting"
    | "ready"
    | "shutdown_initiated",
  detail?: Record<string, unknown>,
): void {
  const msg: Record<string, unknown> = {
    phase,
    timestamp: new Date().toISOString(),
    ...detail,
  };
  console.log(`[startup:${phase}]`, JSON.stringify(msg));
}
