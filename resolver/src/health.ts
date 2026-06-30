import { createServer, type Server, type ServerResponse } from "node:http";
import type { ResolverConfig } from "./config.js";
import type { Supervisor } from "./supervisor.js";

export interface ResolverHealthDeps {
  cfg: ResolverConfig;
  supervisor: Supervisor;
  startedAt?: number;
}

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

function readinessChecks(deps: ResolverHealthDeps) {
  return [
    {
      name: "ethereum_config",
      ok: Boolean(deps.cfg.ethereum.htlcEscrow && deps.cfg.ethereum.resolverPrivateKey),
      detail: deps.cfg.ethereum.htlcEscrow ? "configured" : "missing_htlc_escrow",
    },
    {
      name: "soroban_config",
      ok: Boolean(deps.cfg.soroban.htlc && deps.cfg.soroban.resolverSecret),
      detail: deps.cfg.soroban.htlc ? "configured" : "missing_htlc_contract",
    },
    {
      name: "supervisor",
      ok: !deps.supervisor.isStopped,
      detail: deps.supervisor.isStopped ? "stopped" : "running",
    },
  ];
}

export function createResolverHealthServer(deps: ResolverHealthDeps): Server {
  const startedAt = deps.startedAt ?? Date.now();

  return createServer((req, res) => {
    if (req.method !== "GET") {
      json(res, 405, { error: "method_not_allowed" });
      return;
    }

    if (req.url === "/healthz") {
      json(res, 200, {
        status: "ok",
        ...servicePayload(startedAt),
      });
      return;
    }

    if (req.url === "/readyz") {
      const checks = readinessChecks(deps);
      const ok = checks.every((check) => check.ok);
      json(res, ok ? 200 : 503, {
        status: ok ? "ok" : "degraded",
        ...servicePayload(startedAt),
        checks,
      });
      return;
    }

    if (req.url === "/health") {
      const checks = readinessChecks(deps);
      const dependencyFailures = checks.filter((check) => !check.ok);
      json(res, deps.supervisor.isStopped ? 503 : 200, {
        status: deps.supervisor.isStopped
          ? "unhealthy"
          : dependencyFailures.length > 0
            ? "degraded"
            : "healthy",
        ...servicePayload(startedAt),
        restarts: deps.supervisor.restarts,
        checks,
      });
      return;
    }

    json(res, 404, { error: "not_found" });
  });
}

export function startResolverHealthServer(deps: ResolverHealthDeps, port: number): Server {
  const server = createResolverHealthServer(deps);
  server.listen(port);
  return server;
}
