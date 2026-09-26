import { createServer, type Server, type ServerResponse } from "node:http";
import {
  describeSupportPolicy,
  supportsAction,
  type SupportPolicy,
} from "@wafflefinance/config";
import type { ResolverConfig } from "./config.js";
import type { Supervisor } from "./supervisor.js";
import { buildSupportPolicy } from "./support.js";
import { ResolverTelemetryCollector, globalStalenessMonitor } from "./telemetry.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ResolverHealthDeps {
  cfg: ResolverConfig;
  supervisor: Supervisor;
  startedAt?: number;
  /**
   * The runtime's declared capabilities.  Defaults to the policy derived from
   * `cfg`, so callers that do not thread one through still get policy-backed
   * readiness rather than ad-hoc config sniffing.
   */
  policy?: SupportPolicy;
  /** Chains to report liveness for on GET /telemetry. Defaults to ["ethereum", "soroban"]. */
  telemetryChains?: string[];
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function servicePayload(startedAt: number) {
  return {
    service: "wafflefinance-resolver",
    version: process.env.npm_package_version ?? "1.0.0",
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    timestamp: new Date().toISOString(),
  };
}

/**
 * Build the per-dependency readiness checks.
 *
 * These are lightweight capability checks against the support policy (no live
 * RPC calls) so they complete in microseconds and never block a health probe.
 *
 * A chain is "ready" when the resolver can `claim` on it — the action that makes
 * a resolver useful.  This is the same underlying condition the previous
 * hand-rolled checks tested (HTLC address plus signing key), but the reported
 * detail now names the actual defect: the old code reported
 * `missing_htlc_escrow` even when the escrow was present and the *key* was the
 * missing piece.
 */
function readinessChecks(deps: ResolverHealthDeps, policy: SupportPolicy) {
  const { supervisor } = deps;

  const ethClaim = supportsAction(policy, "ethereum", "claim");
  const sorobanClaim = supportsAction(policy, "stellar", "claim");

  // "supervisor" check: ok when it is actively running or idle (not yet
  // started).  Not-ok when it has stopped due to exhausted restarts or a fatal
  // error.  Stopping due to a signal is a deliberate action and is reported
  // as ok=true with detail="stopping" so orchestration systems don't
  // immediately restart the pod before teardown completes.
  const supervisorState = supervisor.state;
  const supervisorOk =
    supervisorState === "idle" ||
    supervisorState === "running" ||
    supervisorState === "restarting" ||
    supervisorState === "stopping" ||
    supervisorState === "stopped";

  const checks = [
    {
      name: "ethereum_config",
      ok: ethClaim.supported,
      detail: ethClaim.supported ? "configured" : ethClaim.reason,
      level: policy.chains.ethereum.level,
    },
    {
      name: "soroban_config",
      ok: sorobanClaim.supported,
      detail: sorobanClaim.supported ? "configured" : sorobanClaim.reason,
      level: policy.chains.stellar.level,
    },
    {
      name: "supervisor",
      ok: supervisorOk,
      detail: supervisorState,
    },
  ];

  // Registry status: not-ready when this resolver's own on-chain standing on
  // any tracked chain is low_stake / slashed / unbonding / inactive. A chain
  // that has never been probed (registry not configured for it) reports
  // ok=true — see ResolverStatusMonitor.isReady().
  if (registryStatus) {
    const ready = registryStatus.isReady();
    checks.push({
      name: "registry_status",
      ok: ready,
      detail: ready ? "active" : "degraded",
    });
  }

  return checks;
}

// ── Server factory ────────────────────────────────────────────────────────────

/**
 * Create an HTTP server exposing health endpoints:
 *
 * - `GET /healthz`        — liveness probe (always 200 while the process is alive).
 * - `GET /readyz`         — readiness probe (503 when a required dependency check fails).
 * - `GET /health`         — combined health payload with supervisor state and restart count.
 * - `GET /telemetry`      — resolver runtime telemetry (connected/degraded/stale/inactive).
 * - `GET /support`        — the runtime's declared support policy (chains, actions,
 *                           routes, and the routes it will refuse).
 * - `GET /listener-health`— per-chain listener health: missed-event batches, consecutive
 *                           failures, staleness seconds, and health state per chain.
 *                           Returns 503 when any chain is stale, degraded, or stopped.
 *                           See issue #769.
 */
export function createResolverHealthServer(deps: ResolverHealthDeps): Server {
  const startedAt = deps.startedAt ?? Date.now();
  const telemetryChains = deps.telemetryChains ?? ["ethereum", "soroban"];
  const telemetryCollector = new ResolverTelemetryCollector();
  const policy = deps.policy ?? buildSupportPolicy(deps.cfg);

  return createServer((req, res) => {
    if (req.method !== "GET") {
      json(res, 405, { error: "method_not_allowed" });
      return;
    }

    // ── /healthz — liveness ──────────────────────────────────────────────
    // Always 200 while the process is alive. A failing liveness probe causes
    // the orchestrator to kill and replace the pod — only use for truly
    // unrecoverable states (not transient restart loops).
    if (req.url === "/healthz") {
      json(res, 200, {
        status: "ok",
        ...servicePayload(startedAt),
      });
      return;
    }

    // ── /readyz — readiness ──────────────────────────────────────────────
    // Returns 503 when a required dependency is missing or misconfigured.
    // Orchestration systems stop routing traffic to the pod when this fails.
    //
    // A supervisor in "stopping" state returns 503 so new traffic is not
    // routed to a pod that is mid-teardown.
    if (req.url === "/readyz") {
      const checks = readinessChecks(deps, policy);
      const state = deps.supervisor.state;

      // Pods that are cleanly stopping should not receive new traffic.
      const isStoppingOrStopped =
        state === "stopping" || state === "stopped" || state === "failed";

      const allChecksOk = checks.every((c) => c.ok);
      const ok = allChecksOk && !isStoppingOrStopped;

      json(res, ok ? 200 : 503, {
        status: ok ? "ok" : "degraded",
        supervisorState: state,
        ...servicePayload(startedAt),
        checks,
      });
      return;
    }

    // ── /health — combined health ────────────────────────────────────────
    // Full health payload for dashboards and debugging.  Not used by
    // Kubernetes probes directly (too verbose for high-frequency polling).
    if (req.url === "/health") {
      const checks = readinessChecks(deps, policy);
      const state = deps.supervisor.state;
      const dependencyFailures = checks.filter((c) => !c.ok);

      const overallStatus =
        state === "failed"
          ? "unhealthy"
          : state === "stopping" || state === "stopped"
            ? "stopping"
            : dependencyFailures.length > 0
              ? "degraded"
              : "healthy";

      json(res, state === "failed" ? 503 : 200, {
        status: overallStatus,
        supervisorState: state,
        restarts: deps.supervisor.restarts,
        ...servicePayload(startedAt),
        checks,
      });
      return;
    }

    // ── /telemetry — resolver runtime telemetry ──────────────────────────
    // Reports whether the resolver is connected, degraded, stale, or
    // inactive so operators can distinguish "delayed" from "not doing its
    // job" without reading raw logs. See src/telemetry.ts.
    if (req.url === "/telemetry") {
      telemetryCollector
        .collect({ supervisor: deps.supervisor, chains: telemetryChains })
        .then((snapshot) => {
          json(res, snapshot.state === "inactive" ? 503 : 200, {
            ...snapshot,
            ...servicePayload(startedAt),
          });
        })
        .catch((err) => {
          json(res, 500, { error: "telemetry_collection_failed", detail: String(err) });
        });
      return;
    }

    // ── /support — declared capabilities ─────────────────────────────────
    // Makes the support policy observable: which chains and actions this
    // process can use, which routes it will carry, and which chain pairs it
    // will refuse (with the reason).  Returns 503 when the runtime cannot
    // carry any route, so "started but useless" is externally visible.
    if (req.url === "/support") {
      const summary = describeSupportPolicy(policy);
      json(res, summary.actionable ? 200 : 503, {
        ...summary,
        ...servicePayload(startedAt),
      });
      return;
    }

    // ── /listener-health — per-chain missed-event and staleness detail ────
    // Provides a focused view of the per-chain listener health state for
    // operators who need more detail than /telemetry's coarse state.
    // Returns 200 when all listeners are healthy, 503 when any chain has a
    // non-healthy state (stale, degraded, or stopped).
    //
    // This endpoint is specifically designed to satisfy issue #769:
    // "Resolver missed-event behavior is visible from the monitoring interface,
    // and degraded states are not hidden behind generic health responses."
    if (req.url === "/listener-health") {
      const staleAfterSeconds = deps.cfg.soroban?.pollIntervalMs
        ? Math.max(300, (deps.cfg.soroban.pollIntervalMs / 1000) * 10)
        : 300;

      const chainData = globalStalenessMonitor.snapshotChainData();
      const nowSeconds = Math.floor(Date.now() / 1000);

      const chains = chainData.map((c) => {
        const staleness = c.lastHealthyTickSeconds !== null
          ? Math.max(0, nowSeconds - c.lastHealthyTickSeconds)
          : null;
        const isStale = staleness === null || staleness > staleAfterSeconds;
        const healthState =
          !c.isActive
            ? "stopped"
            : c.consecutiveFailures >= 3
              ? "degraded"
              : isStale
                ? "stale"
                : "healthy";

        return {
          chain:              c.chain,
          healthState,
          isActive:           c.isActive,
          staleness_seconds:  staleness,
          staleAfterSeconds,
          consecutiveFailures: c.consecutiveFailures,
          missedEventBatches: c.missedEventBatches,
          lastHealthyTickAt: c.lastHealthyTickSeconds !== null
            ? new Date(c.lastHealthyTickSeconds * 1000).toISOString()
            : null,
        };
      });

      const allHealthy = chains.every((c) => c.healthState === "healthy");
      const unhealthyChains = chains.filter((c) => c.healthState !== "healthy").map((c) => c.chain);
      const totalMissedBatches = chains.reduce((sum, c) => sum + c.missedEventBatches, 0);

      json(res, allHealthy ? 200 : 503, {
        status: allHealthy ? "healthy" : "degraded",
        allHealthy,
        unhealthyChains,
        totalMissedEventBatches: totalMissedBatches,
        chains,
        ...servicePayload(startedAt),
      });
      return;
    }

    json(res, 404, { error: "not_found" });
  });
}

/**
 * Create and immediately start listening the resolver health server.
 */
export function startResolverHealthServer(deps: ResolverHealthDeps, port: number): Server {
  const server = createResolverHealthServer(deps);
  server.listen(port);
  return server;
}
