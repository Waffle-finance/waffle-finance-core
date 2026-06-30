/**
 * /health HTTP endpoint for the relayer.
 *
 * Returns a JSON body with overall service status, uptime, and per-service
 * health details suitable for use by container orchestrators and external
 * monitors.  No secrets or sensitive data are included.
 *
 * HTTP status codes:
 *   200 — healthy or degraded (service is running, some components may be impaired)
 *   503 — unhealthy (service cannot fulfil requests) or health check itself failed
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { getMonitor } from '../services/monitoring.js';

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

function basePayload(metrics: ReturnType<ReturnType<typeof getMonitor>['getMetrics']>) {
  return {
    timestamp: Date.now(),
    uptime: metrics.uptime,
    version: metrics.version,
  };
}

function readinessChecks(): ReadinessCheck[] {
  const monitor = getMonitor();
  const metrics = monitor.getMetrics();
  return [
    {
      name: 'ethereum_rpc',
      ok: metrics.network.ethereum.connected,
      detail: metrics.network.ethereum.connected ? 'ok' : 'unavailable',
      latencyMs: metrics.network.ethereum.responseTime,
    },
    {
      name: 'stellar_rpc',
      ok: metrics.network.stellar.connected,
      detail: metrics.network.stellar.connected ? 'ok' : 'unavailable',
      latencyMs: metrics.network.stellar.responseTime,
    },
    ...metrics.services.map((service) => ({
      name: service.name,
      ok: service.status === 'healthy' || service.status === 'degraded',
      detail: service.status,
      latencyMs: service.responseTime,
    })),
  ];
}

export function healthRouter(): Router {
  const router = Router();

  router.get('/health', (_req: Request, res: Response) => {
    try {
      const monitor = getMonitor();
      const metrics = monitor.getMetrics();
      const status = monitor.getSystemStatus();

      const body: HealthStatus = {
        status,
        ...basePayload(metrics),
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

  router.get('/healthz', (_req: Request, res: Response) => {
    const metrics = getMonitor().getMetrics();
    res.json({
      status: 'ok',
      service: 'wafflefinance-relayer',
      ...basePayload(metrics),
    });
  });

  router.get('/readyz', (_req: Request, res: Response) => {
    try {
      const metrics = getMonitor().getMetrics();
      const checks = readinessChecks();
      const ok = checks.every((check) => check.ok);
      res.status(ok ? 200 : 503).json({
        status: ok ? 'ok' : 'degraded',
        service: 'wafflefinance-relayer',
        ...basePayload(metrics),
        checks,
      });
    } catch (err: unknown) {
      res.status(503).json({
        status: 'degraded',
        service: 'wafflefinance-relayer',
        timestamp: Date.now(),
        uptime: 0,
        version: 'unknown',
        checks: [
          {
            name: 'readiness',
            ok: false,
            detail: err instanceof Error ? err.message : String(err),
          },
        ],
      });
    }
  });

  return router;
}
