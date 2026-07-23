import { Router } from "express";
import type { Logger } from "pino";
import type { StaleCleanupResult } from "../../services/stale-cleanup.js";
import type { ReconciliationStatus } from "../../reconciliation/reconciler.js";
import { requireRole, loadOperatorKeys } from "../middleware/auth.js";
import { loadTrustedProxies } from "../middleware/ratelimit.js";

export interface AdminRouteDeps {
  log: Logger;
  /**
   * Trigger a reconciliation run immediately and return when it completes.
   * Returns the updated `ReconciliationStatus` so callers can surface the
   * result in the HTTP response.
   */
  runReconcile: () => Promise<ReconciliationStatus>;
  /**
   * Trigger a stale-order cleanup run immediately and return when it completes.
   * Returns the `StaleCleanupResult` containing the count of archived orders.
   */
  runStaleCleanup: () => Promise<StaleCleanupResult>;
}

/**
 * Admin maintenance endpoints.
 *
 * All routes require an `Authorization: Bearer <token>` header with a valid
 * key from the `COORDINATOR_OPERATOR_KEYS` environment variable.
 *
 * Routes:
 *   POST /admin/reconcile      — trigger an immediate reconciliation run
 *   POST /admin/stale-cleanup  — trigger an immediate stale-order cleanup run
 *
 * These endpoints are intentionally POST so they cannot be triggered by bots
 * or browser prefetching. They are not idempotent in the HTTP sense: each call
 * performs real work. They are, however, safe to call concurrently because the
 * underlying services are designed to be idempotent at the data layer.
 */
export function adminRoutes(deps: AdminRouteDeps): Router {
  const router = Router();

  const operatorKeys = loadOperatorKeys();
  const trustedProxies = loadTrustedProxies();
  const auth = requireRole("operator", { operatorKeys, log: deps.log, trustedProxies });

  /**
   * POST /admin/reconcile
   *
   * Runs the chain-event reconciler immediately (outside the normal schedule).
   * Useful after a known RPC outage or when an operator suspects the coordinator
   * has missed events.
   *
   * Response 200:
   *   { ok: true, lastRunOk: boolean, lastRunAt: number | null, eventsReplayed: number }
   *
   * Response 500:
   *   { ok: false, error: "reconciliation_failed", message: string }
   */
  router.post("/admin/reconcile", auth, async (_req, res, next) => {
    deps.log.info("[admin] manual reconciliation run triggered");
    try {
      const status = await deps.runReconcile();
      res.json({
        ok: true,
        lastRunOk: status.lastRunOk,
        lastRunAt: status.lastRunAt,
        eventsReplayed: status.eventsReplayed
      });
    } catch (err) {
      deps.log.error({ err }, "[admin] manual reconciliation run failed");
      next(err);
    }
  });

  /**
   * POST /admin/stale-cleanup
   *
   * Runs the stale-order cleanup immediately (outside the normal schedule).
   * Useful after a bulk import, database restore, or to forcibly prune the
   * order book without waiting for the next scheduled run.
   *
   * Response 200:
   *   { ok: true, archivedCount: number }
   *
   * Response 500:
   *   { ok: false, error: "stale_cleanup_failed", message: string }
   */
  router.post("/admin/stale-cleanup", auth, async (_req, res, next) => {
    deps.log.info("[admin] manual stale-order cleanup triggered");
    try {
      const result = await deps.runStaleCleanup();
      res.json({ ok: true, archivedCount: result.archivedCount });
    } catch (err) {
      deps.log.error({ err }, "[admin] manual stale-order cleanup failed");
      next(err);
    }
  });

  return router;
}
