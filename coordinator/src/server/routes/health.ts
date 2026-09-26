import { Router } from 'express';
import { evaluateDependencyHealth } from '../../degraded-mode.js';
import type { ReconciliationStatus } from '../../reconciliation/reconciler.js';

export interface ReadinessCheck {
  name: string;
  ok: boolean;
  detail?: string;
  latencyMs?: number;
}

export type ReadinessCheckProvider = () => ReadinessCheck[] | Promise<ReadinessCheck[]>;

export interface SorobanStalenessInfo {
  state: "connected" | "degraded" | "stale" | "inactive";
  lastPollAgeSeconds: number;
  lastEventAgeSeconds: number;
  lastProcessedLedger: number;
}

export interface HealthRouteOptions {
  getReconciliationStatus?: () => ReconciliationStatus;
  getReadinessChecks?: ReadinessCheckProvider;
  /**
   * Returns the Soroban listener's current staleness state so the /health
   * endpoint can surface it for monitoring dashboards.  Omit when the
   * Soroban listener is not configured.
   */
  getSorobanStalenessInfo?: () => SorobanStalenessInfo;
}

function servicePayload(startedAt: number) {
  return {
    service: 'wafflefinance-coordinator',
    version: process.env.npm_package_version ?? '0.1.0',
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    timestamp: new Date().toISOString(),
  };
}

export function healthRoutes(options: HealthRouteOptions = {}): Router {
  const router = Router();
  const startedAt = Date.now();

  router.get('/health', (_req, res) => {
    const reconciliation = options.getReconciliationStatus?.() ?? null;
    const sorobanStaleness = options.getSorobanStalenessInfo?.() ?? null;
    res.json({
      status: 'ok',
      ...servicePayload(startedAt),
      reconciliation,
      soroban: sorobanStaleness
        ? {
            state: sorobanStaleness.state,
            lastPollAgeSeconds: sorobanStaleness.lastPollAgeSeconds,
            lastEventAgeSeconds: sorobanStaleness.lastEventAgeSeconds,
            lastProcessedLedger: sorobanStaleness.lastProcessedLedger,
          }
        : null,
    });
  });

  router.get('/healthz', (_req, res) => {
    res.json({
      status: 'ok',
      ...servicePayload(startedAt),
    });
  });

  router.get('/readyz', async (_req, res) => {
    try {
      const checks = await (options.getReadinessChecks?.() ?? []);
      const report = evaluateDependencyHealth(checks);
      const ok = report.overall === 'healthy';
      res.status(ok ? 200 : 503).json({
        status: ok ? 'ok' : 'degraded',
        mode: report.overall,
        degradedServices: report.degradedServices,
        ...servicePayload(startedAt),
        checks,
      });
    } catch {
      res.status(503).json({
        status: 'degraded',
        mode: 'degraded',
        degradedServices: ['readiness'],
        ...servicePayload(startedAt),
        checks: [
          {
            name: 'readiness',
            ok: false,
            detail: 'readiness_check_failed',
          },
        ],
      });
    }
  });

  return router;
}
