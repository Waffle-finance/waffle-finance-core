/**
 * /healthz and /readyz HTTP endpoints for the relayer.
 *
 * /healthz — liveness probe: the process is alive and able to receive requests.
 *   Always returns 200 as long as the Express event loop is running.
 *   Container orchestrators (K8s, ECS) use this to decide whether to restart
 *   the container.
 *
 * /readyz — readiness probe: the relayer has established connectivity to all
 *   critical dependencies and is ready to serve traffic.
 *   Returns 200 when all checks pass, 503 when any check fails.
 *   Orchestrators use this to decide whether to send traffic to this instance.
 *
 * /health — detailed health status: full diagnostic payload for monitoring
 *   dashboards and alerting systems. Returns 200 (healthy/degraded) or 503
 *   (unhealthy). Includes per-service health from the UptimeMonitor.
 *
 * Design principles:
 *   - No secrets or sensitive data are ever included in any response.
 *   - RPC URL placeholders are detected and reported as degraded rather than
 *     causing a hard failure — the relayer is alive even when not fully configured.
 *   - Network probe latencies are measured and reported so SLO dashboards can
 *     alert on slow RPCs before they start causing failures.
 *   - Soroban/Solana placeholder detection follows the same pattern used by
 *     the coordinator to keep operational behaviour consistent.
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { getMonitor } from '../services/monitoring.js';

// ---------------------------------------------------------------------------
// Config accessor — reads RPC URLs directly from environment variables so
// this module can be imported in tests without booting the full relayer or
// requiring @wafflefinance/config dist files.
//
// Priority (first non-empty wins):
//   ETHEREUM_RPC_URL  → eth_blockNumber probe
//   STELLAR_HORIZON_URL / STELLAR_HORIZON_URL_TESTNET → Horizon root probe
// ---------------------------------------------------------------------------

function getRelayerRpcConfig(): { ethRpcUrl: string; stellarHorizonUrl: string } {
  return {
    ethRpcUrl: process.env.ETHEREUM_RPC_URL ?? '',
    stellarHorizonUrl:
      process.env.STELLAR_HORIZON_URL ??
      process.env.STELLAR_HORIZON_URL_TESTNET ??
      '',
  };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: number;
  uptime: number;
  version: string;
  services: Array<{ name: string; status: string; lastCheck: number }>;
}

export interface ReadinessCheck {
  name: string;
  ok: boolean;
  detail?: string;
  latencyMs?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PLACEHOLDER_PATTERNS = [
  'YOUR_',
  'PLACEHOLDER',
  'example.com',
  '<',
  '>',
  'undefined',
  'null',
];

const RPC_PROBE_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isPlaceholderUrl(url: string | undefined): boolean {
  if (!url) return true;
  return PLACEHOLDER_PATTERNS.some((p) => url.includes(p));
}

function isSolanaPlaceholder(programId: string | undefined): boolean {
  if (!programId) return true;
  return programId === 'PLACEHOLDER' || PLACEHOLDER_PATTERNS.some((p) => programId.includes(p));
}

function basePayload(startedAt: number) {
  const monitor = getMonitor();
  const metrics = monitor.getMetrics();
  return {
    service: 'wafflefinance-relayer',
    version: metrics.version ?? process.env.npm_package_version ?? '0.1.0',
    uptime: metrics.uptime,
    timestamp: Date.now(),
  };
}

/**
 * Probe a JSON-RPC endpoint.
 *
 * Uses a native `fetch` POST with the supplied method so no SDK is needed
 * at the health-check layer. An AbortController enforces the timeout so
 * a hung RPC node never blocks the health endpoint indefinitely.
 *
 * Returns { ok: true, latencyMs } on success, { ok: false, detail, latencyMs }
 * on any failure — the caller decides how to map this to readiness.
 */
async function probeJsonRpc(
  url: string,
  method: string,
  timeoutMs = RPC_PROBE_TIMEOUT_MS,
): Promise<{ ok: boolean; latencyMs: number; detail?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] }),
      signal: controller.signal,
    });

    const latencyMs = Date.now() - startedAt;

    if (!response.ok) {
      return { ok: false, latencyMs, detail: `http_${response.status}` };
    }

    return { ok: true, latencyMs };
  } catch (err: unknown) {
    const latencyMs = Date.now() - startedAt;
    if (err instanceof Error && err.name === 'AbortError') {
      return { ok: false, latencyMs, detail: 'timeout' };
    }
    return { ok: false, latencyMs, detail: 'connection_error' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe the Stellar Horizon REST API via GET /health (returns `{"status":"ok"}`
 * on a healthy node). Falls back gracefully for non-Horizon endpoints.
 */
async function probeHorizon(
  horizonUrl: string,
  timeoutMs = RPC_PROBE_TIMEOUT_MS,
): Promise<{ ok: boolean; latencyMs: number; detail?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  try {
    const url = horizonUrl.replace(/\/$/, '') + '/';
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
    });

    const latencyMs = Date.now() - startedAt;

    if (!response.ok) {
      return { ok: false, latencyMs, detail: `http_${response.status}` };
    }

    return { ok: true, latencyMs };
  } catch (err: unknown) {
    const latencyMs = Date.now() - startedAt;
    if (err instanceof Error && err.name === 'AbortError') {
      return { ok: false, latencyMs, detail: 'timeout' };
    }
    return { ok: false, latencyMs, detail: 'connection_error' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build the full set of readiness checks.
 *
 * Each check probes a real dependency endpoint.  Placeholder or
 * unconfigured endpoints are detected and reported as
 * detail="disabled_placeholder" (ok=true) so they don't drag down
 * overall readiness — the relayer is usable even when Solana is not
 * yet configured.
 */
async function buildReadinessChecks(): Promise<ReadinessCheck[]> {
  const checks: ReadinessCheck[] = [];
  const { ethRpcUrl, stellarHorizonUrl } = getRelayerRpcConfig();

  // ── Ethereum RPC ─────────────────────────────────────────────────────────
  if (isPlaceholderUrl(ethRpcUrl)) {
    checks.push({ name: 'ethereum_rpc', ok: false, detail: 'not_configured' });
  } else {
    const result = await probeJsonRpc(ethRpcUrl, 'eth_blockNumber');
    checks.push({
      name: 'ethereum_rpc',
      ok: result.ok,
      detail: result.ok ? 'ok' : result.detail,
      latencyMs: result.latencyMs,
    });
  }

  // ── Stellar Horizon ───────────────────────────────────────────────────────
  if (isPlaceholderUrl(stellarHorizonUrl)) {
    checks.push({ name: 'stellar_rpc', ok: false, detail: 'not_configured' });
  } else {
    // Horizon uses REST, not JSON-RPC — probe the root endpoint.
    const result = await probeHorizon(stellarHorizonUrl);
    checks.push({
      name: 'stellar_rpc',
      ok: result.ok,
      detail: result.ok ? 'ok' : result.detail,
      latencyMs: result.latencyMs,
    });
  }

  // ── Soroban RPC (Stellar smart contracts) ─────────────────────────────────
  // The relayer does not use Soroban directly (the coordinator does), but
  // we surface whether it is configured and reachable so the dashboard
  // shows the full cross-chain picture in one place.
  const sorobanRpcUrl = process.env.SOROBAN_RPC_URL;
  if (!sorobanRpcUrl || isPlaceholderUrl(sorobanRpcUrl)) {
    checks.push({ name: 'soroban_rpc', ok: true, detail: 'disabled_placeholder' });
  } else {
    const result = await probeJsonRpc(sorobanRpcUrl, 'getHealth');
    checks.push({
      name: 'soroban_rpc',
      ok: result.ok,
      detail: result.ok ? 'ok' : result.detail,
      latencyMs: result.latencyMs,
    });
  }

  // ── Solana RPC ────────────────────────────────────────────────────────────
  const solanaProgramId =
    process.env.SOLANA_HTLC_PROGRAM ??
    process.env.SOLANA_HTLC_PROGRAM_TESTNET ??
    process.env.SOLANA_HTLC_PROGRAM_MAINNET;
  const solanaRpcUrl = process.env.SOLANA_RPC_URL;

  if (isSolanaPlaceholder(solanaProgramId)) {
    // Solana is explicitly unconfigured — report as disabled rather than failed
    // to avoid noisy false-positive alerts in monitoring.
    checks.push({ name: 'solana_rpc', ok: true, detail: 'disabled_placeholder' });
  } else if (!solanaRpcUrl || isPlaceholderUrl(solanaRpcUrl)) {
    checks.push({ name: 'solana_rpc', ok: false, detail: 'not_configured' });
  } else {
    const result = await probeJsonRpc(solanaRpcUrl, 'getHealth');
    checks.push({
      name: 'solana_rpc',
      ok: result.ok,
      detail: result.ok ? 'ok' : result.detail,
      latencyMs: result.latencyMs,
    });
  }

  return checks;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function healthRouter(): Router {
  const router = Router();
  const startedAt = Date.now();

  // ── /healthz — liveness ───────────────────────────────────────────────────
  // Always returns 200 as long as the process is alive.  No dependency checks.
  router.get('/healthz', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      ...basePayload(startedAt),
    });
  });

  // ── /readyz — readiness ───────────────────────────────────────────────────
  // Probes all configured RPC connections and reports per-dependency status.
  router.get('/readyz', async (_req: Request, res: Response) => {
    try {
      const checks = await buildReadinessChecks();
      // A "disabled_placeholder" check is ok=true but is not required for
      // overall readiness — only genuinely configured dependencies matter.
      const ok = checks.every((c) => c.ok);
      res.status(ok ? 200 : 503).json({
        status: ok ? 'ok' : 'degraded',
        ...basePayload(startedAt),
        checks,
      });
    } catch (err: unknown) {
      res.status(503).json({
        status: 'degraded',
        service: 'wafflefinance-relayer',
        timestamp: Date.now(),
        uptime: Date.now() - startedAt,
        version: process.env.npm_package_version ?? '0.1.0',
        checks: [
          {
            name: 'readiness',
            ok: false,
            detail: err instanceof Error ? err.message : 'readiness_check_failed',
          },
        ],
      });
    }
  });

  // ── /health — detailed health ─────────────────────────────────────────────
  // Full diagnostic payload for monitoring dashboards.
  router.get('/health', (_req: Request, res: Response) => {
    try {
      const monitor = getMonitor();
      const metrics = monitor.getMetrics();
      const status = monitor.getSystemStatus();

      const body: HealthStatus = {
        status,
        timestamp: Date.now(),
        uptime: metrics.uptime,
        version: metrics.version ?? process.env.npm_package_version ?? '0.1.0',
        services: metrics.services.map((s) => ({
          name: s.name,
          status: s.status,
          lastCheck: s.lastCheck,
        })),
      };

      const httpStatus = status === 'unhealthy' ? 503 : 200;
      res.status(httpStatus).json(body);
    } catch (err: unknown) {
      res.status(503).json({
        status: 'unhealthy',
        timestamp: Date.now(),
        uptime: 0,
        version: 'unknown',
        services: [],
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return router;
}
