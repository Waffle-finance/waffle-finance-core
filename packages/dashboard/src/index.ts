import { Router } from "express";
import type { Request, Response } from "express";
import axios from "axios";

/**
 * Service configuration for the health dashboard.
 * Each service has an endpoint URL and optional auth token.
 */
export interface ServiceConfig {
  name: string;
  url: string;
  authToken?: string;
}

/**
 * Health status of an individual service.
 */
export interface ServiceHealth {
  name: string;
  status: "healthy" | "degraded" | "unhealthy" | "unknown";
  timestamp: number;
  uptime?: number;
  version?: string;
  responseTimeMs?: number;
  error?: string;
  checks?: Array<{ name: string; ok: boolean; detail?: string }>;
}

/**
 * Aggregated dashboard response.
 */
export interface DashboardHealth {
  status: "healthy" | "degraded" | "unhealthy";
  timestamp: number;
  services: ServiceHealth[];
  summary: {
    healthy: number;
    degraded: number;
    unhealthy: number;
    unknown: number;
    total: number;
  };
}

/**
 * Map a service status to HTTP status code.
 */
function statusToHttp(status: string): number {
  return status === "unhealthy" ? 503 : 200;
}

function normalizeServiceStatus(status: unknown): ServiceHealth["status"] {
  if (status === "ok" || status === "healthy") return "healthy";
  if (status === "degraded") return "degraded";
  if (status === "unhealthy") return "unhealthy";
  return "unknown";
}

/**
 * Fetch health from a single service.
 */
async function fetchServiceHealth(config: ServiceConfig): Promise<ServiceHealth> {
  const start = Date.now();
  try {
    const headers = config.authToken
      ? { Authorization: `Bearer ${config.authToken}` }
      : {};
    const resp = await axios.get(`${config.url}/health`, {
      headers,
      timeout: 5000,
      validateStatus: () => true
    });
    const data = resp.data;
    const httpStatus = resp.status ?? 200;
    return {
      name: config.name,
      status: httpStatus >= 500 ? "unhealthy" : normalizeServiceStatus(data.status),
      timestamp: Date.now(),
      uptime: data.uptime ?? data.uptimeSeconds,
      version: data.version,
      responseTimeMs: Date.now() - start,
      checks: data.checks
    };
  } catch (err) {
    const status = "unhealthy" as const;
    return {
      name: config.name,
      status,
      timestamp: Date.now(),
      responseTimeMs: Date.now() - start,
      error: err instanceof Error ? err.message : "Unknown error"
    };
  }
}

/**
 * Fetch liveness (simpler check) for a service.
 */
async function fetchServiceLiveness(config: ServiceConfig): Promise<{ ok: boolean; responseTimeMs: number }> {
  const start = Date.now();
  try {
    const headers = config.authToken
      ? { Authorization: `Bearer ${config.authToken}` }
      : {};
    const resp = await axios.get(`${config.url}/healthz`, {
      headers,
      timeout: 3000,
      validateStatus: () => true
    });
    return { ok: (resp.status ?? 200) < 500, responseTimeMs: Date.now() - start };
  } catch {
    return { ok: false, responseTimeMs: Date.now() - start };
  }
}

/**
 * Fetch readiness (dependency checks) for a service.
 */
async function fetchServiceReadiness(config: ServiceConfig): Promise<{ ok: boolean; checks?: Array<{ name: string; ok: boolean; detail?: string }> }> {
  try {
    const headers = config.authToken
      ? { Authorization: `Bearer ${config.authToken}` }
      : {};
    const resp = await axios.get(`${config.url}/readyz`, {
      headers,
      timeout: 5000,
      validateStatus: () => true
    });
    return {
      ok: (resp.status ?? 200) < 500 && resp.data.status === "ok",
      checks: resp.data.checks
    };
  } catch {
    return { ok: false };
  }
}

/**
 * Determine overall system status from individual service statuses.
 */
function aggregateStatus(services: ServiceHealth[]): DashboardHealth["status"] {
  const statusCounts = services.reduce(
    (acc, s) => {
      acc[s.status] = (acc[s.status] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );

  if (statusCounts.unhealthy > 0) return "unhealthy";
  if (statusCounts.degraded > 0) return "degraded";
  return "healthy";
}

export function dashboardHealthRoutes(services: ServiceConfig[]): Router {
  const router = Router();

  /**
   * GET /dashboard/health
   * Unified view of all core service health.
   */
  router.get("/dashboard/health", async (_req: Request, res: Response) => {
    const [healthResults, livenessResults, readinessResults] = await Promise.all([
      Promise.all(services.map(fetchServiceHealth)),
      Promise.all(services.map(fetchServiceLiveness)),
      Promise.all(services.map(fetchServiceReadiness))
    ]);

    // Merge readiness checks into health results
    const mergedServices: ServiceHealth[] = healthResults.map((svc, i) => ({
      ...svc,
      ...(livenessResults[i]?.ok === false && { status: "unhealthy" as const }),
      ...(livenessResults[i]?.ok !== false &&
        readinessResults[i]?.ok === false &&
        svc.status !== "unhealthy" && { status: "degraded" as const }),
      checks: readinessResults[i]?.checks?.length
        ? readinessResults[i].checks
        : svc.checks
    }));

    const status = aggregateStatus(mergedServices);
    const summary = mergedServices.reduce(
      (acc, s) => ({
        ...acc,
        [s.status]: acc[s.status as keyof typeof acc] + 1,
        total: acc.total + 1
      }),
      { healthy: 0, degraded: 0, unhealthy: 0, unknown: 0, total: 0 }
    );

    const body: DashboardHealth = {
      status,
      timestamp: Date.now(),
      services: mergedServices,
      summary
    };

    res.status(statusToHttp(status)).json(body);
  });

  /**
   * GET /dashboard/liveness
   * Quick liveness check for all services (for orchestrators).
   */
  router.get("/dashboard/liveness", async (_req: Request, res: Response) => {
    const results = await Promise.all(services.map(fetchServiceLiveness));
    const allOk = results.every(r => r.ok);
    res.status(allOk ? 200 : 503).json({
      status: allOk ? "ok" : "degraded",
      timestamp: Date.now(),
      services: results.map((r, i) => ({
        name: services[i].name,
        ok: r.ok,
        responseTimeMs: r.responseTimeMs
      }))
    });
  });

  /**
   * GET /dashboard/readiness
   * Dependency readiness across all services.
   */
  router.get("/dashboard/readiness", async (_req: Request, res: Response) => {
    const results = await Promise.all(services.map(fetchServiceReadiness));
    const allOk = results.every(r => r.ok);
    res.status(allOk ? 200 : 503).json({
      status: allOk ? "ok" : "degraded",
      timestamp: Date.now(),
      services: results.map((r, i) => ({
        name: services[i].name,
        ok: r.ok,
        checks: r.checks
      }))
    });
  });

  return router;
}
