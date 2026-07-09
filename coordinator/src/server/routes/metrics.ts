import { Router } from "express";
import type { Logger } from "pino";
import { registry } from "../../metrics.js";
import { requireRole, loadOperatorKeys } from "../middleware/auth.js";
import { loadTrustedProxies } from "../middleware/ratelimit.js";

export function metricsRoutes(log?: Logger): Router {
  const router = Router();
  const operatorKeys = loadOperatorKeys();
  const trustedProxies = loadTrustedProxies();

  router.get(
    "/metrics",
    requireRole("operator", { operatorKeys, log, trustedProxies }),
    async (_req, res) => {
    try {
      res.set("Content-Type", registry.contentType);
      res.end(await registry.metrics());
    } catch (err) {
      res.status(500).end(String(err));
    }
  });

  return router;
}
