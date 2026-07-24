import type { CoordinatorConfig } from "./config.js";
import type { Database } from "./persistence/db.js";
import type { ReconciliationStatus } from "./reconciliation/reconciler.js";
import type { ReadinessCheck } from "./server/routes/health.js";
import { isSolanaPlaceholder } from "./config.js";

// ── Types ────────────────────────────────────────────────────────────────────

type FetchLike = (
  url: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  }
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

/**
 * Startup lifecycle phases exposed via readiness.
 *
 * - `starting`       — the coordinator process has launched but dependencies
 *                      (DB, RPC nodes) are still being waited on.  The HTTP
 *                      server is listening but the readiness endpoint returns
 *                      503 with phase="starting".
 * - `pending`        — all required dependencies came up but one or more
 *                      optional / transient checks are still unhealthy.
 * - `ready`          — all checks pass; the coordinator is fully operational.
 * - `degraded`       — one or more dependency checks are failing after the
 *                      coordinator was previously ready.
 */
export type StartupPhase = "starting" | "pending" | "ready" | "degraded";

export interface ReadinessDeps {
  cfg: CoordinatorConfig;
  db: Database;
  getReconciliationStatus: () => ReconciliationStatus;
  fetcher?: FetchLike;
  timeoutMs?: number;
  /**
   * When provided, the readiness check will include a synthetic
   * `startup_phase` entry reflecting the coordinator's current lifecycle
   * stage.  This is set by index.ts as the coordinator progresses through
   * its startup sequence.
   */
  getStartupPhase?: () => StartupPhase;
}

// ── Internal helpers ─────────────────────────────────────────────────────────

async function timedCheck(name: string, probe: () => Promise<void>): Promise<ReadinessCheck> {
  const startedAt = Date.now();
  try {
    await probe();
    return { name, ok: true, latencyMs: Date.now() - startedAt };
  } catch {
    return {
      name,
      ok: false,
      detail: "unavailable",
      latencyMs: Date.now() - startedAt,
    };
  }
}

async function probeDatabase(db: Database): Promise<void> {
  const stmt = db.prepare("SELECT 1 AS ok");
  if ("getAsync" in stmt && typeof stmt.getAsync === "function") {
    await stmt.getAsync();
    return;
  }
  stmt.get();
}

async function probeJsonRpc(
  fetcher: FetchLike,
  url: string,
  method: string,
  timeoutMs: number
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetcher(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error("rpc_http_error");
    }

    const body = (await response.json()) as { error?: unknown };
    if (body?.error) {
      throw new Error("rpc_error");
    }
  } finally {
    clearTimeout(timeout);
  }
}

function reconciliationCheck(status: ReconciliationStatus): ReadinessCheck {
  if (status.lastRunOk === false) {
    return { name: "reconciliation", ok: false, detail: "last_run_failed" };
  }
  return {
    name: "reconciliation",
    ok: true,
    detail: status.lastRunAt ? "last_run_ok" : "not_run_yet",
  };
}

/**
 * Derive an overall StartupPhase from the list of individual checks.
 *
 * Rules (applied in priority order):
 *  1. If a `startup_phase` check is already present (injected by the caller),
 *     use its detail field directly.
 *  2. If any required check (database) is failing, the phase is "degraded".
 *  3. If the reconciliation check has `detail="not_run_yet"`, the phase is
 *     "pending" — dependencies are up but the coordinator hasn't completed its
 *     first reconciliation pass yet.
 *  4. If all checks pass, the phase is "ready".
 *  5. Otherwise, "degraded".
 */
export function deriveStartupPhase(
  checks: ReadinessCheck[],
  externalPhase?: StartupPhase
): StartupPhase {
  if (externalPhase === "starting") return "starting";

  const db = checks.find((c) => c.name === "database");
  if (db && !db.ok) return "degraded";

  const anyFailed = checks.some(
    (c) => !c.ok && c.name !== "startup_phase"
  );
  if (anyFailed) return "degraded";

  const reconciliation = checks.find((c) => c.name === "reconciliation");
  if (reconciliation?.detail === "not_run_yet") return "pending";

  return "ready";
}

// ── Public factory ────────────────────────────────────────────────────────────

/**
 * Build a readiness-check function that probes all coordinator dependencies.
 *
 * The returned function is called by the /readyz HTTP endpoint on every
 * request.  It returns an array of ReadinessCheck results plus an optional
 * synthetic `startup_phase` check so operators can see the coordinator's
 * current lifecycle stage at a glance.
 *
 * Startup phase semantics:
 *  - While `getStartupPhase()` returns "starting", a synthetic check with
 *    `ok: false` and `detail: "starting"` is prepended so the /readyz route
 *    returns HTTP 503 until dependencies are up.
 *  - Once "pending" (dependencies up, first reconciliation not yet done), the
 *    check is `ok: true` with `detail: "pending"` — not blocking, but visible.
 *  - "ready" omits the synthetic check entirely (no noise in healthy payloads).
 */
export function createReadinessChecks({
  cfg,
  db,
  getReconciliationStatus,
  fetcher = globalThis.fetch as FetchLike,
  timeoutMs = 750,
  getStartupPhase,
}: ReadinessDeps): () => Promise<ReadinessCheck[]> {
  return async () => {
    // The Solana RPC probe is skipped when the program ID is a placeholder.
    // Probing a devnet/mainnet RPC endpoint that we never actually use would
    // produce false-positive failures and make operators think something is
    // broken when it's simply unconfigured.  The skipped check is returned
    // as ok=true with detail="disabled_placeholder" so it is visible in
    // health payloads without polluting the pass/fail count.
    const solanaCheck: ReadinessCheck = isSolanaPlaceholder(cfg.solana.programId)
      ? { name: "solana_rpc", ok: true, detail: "disabled_placeholder" }
      : await timedCheck("solana_rpc", () =>
          probeJsonRpc(fetcher, cfg.solana.rpcUrl, "getHealth", timeoutMs)
        );

    const checks: ReadinessCheck[] = [
      await timedCheck("database", () => probeDatabase(db)),
      await timedCheck("ethereum_rpc", () =>
        probeJsonRpc(fetcher, cfg.ethereum.rpcUrl, "eth_blockNumber", timeoutMs)
      ),
      await timedCheck("soroban_rpc", () =>
        probeJsonRpc(fetcher, cfg.soroban.rpcUrl, "getHealth", timeoutMs)
      ),
      solanaCheck,
      reconciliationCheck(getReconciliationStatus()),
    ];

    // Inject a synthetic startup_phase check when the caller provides a phase
    // getter.  This surfaces the coordinator's lifecycle stage in the /readyz
    // response without polluting the core dependency checks.
    if (getStartupPhase) {
      const phase = getStartupPhase();

      if (phase === "starting") {
        checks.unshift({
          name: "startup_phase",
          ok: false,
          detail: "starting",
        });
      } else if (phase === "pending") {
        checks.unshift({
          name: "startup_phase",
          ok: true,
          detail: "pending",
        });
      }
      // "ready" / "degraded" — no synthetic check; the real checks speak for themselves.
    }

    return checks;
  };
}
