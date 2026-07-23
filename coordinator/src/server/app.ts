import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import type { Logger } from "pino";
import { healthRoutes } from "./routes/health.js";
import type { ReadinessCheckProvider } from "./routes/health.js";
import { metricsRoutes } from "./routes/metrics.js";
import { httpRequestDuration } from "../metrics.js";
import { ordersRoutes } from "./routes/orders.js";
import { secretsRoutes } from "./routes/secrets.js";
import { quotesRoutes } from "./routes/quotes.js";
import { adminRoutes } from "./routes/admin.js";
import type { OrderService } from "../services/order-service.js";
import type { SecretService } from "../services/secret-service.js";
import type { QuoteService } from "../services/quote-service.js";
import type { ReconciliationStatus } from "../reconciliation/reconciler.js";
import type { StaleCleanupResult } from "../services/stale-cleanup.js";
import { requestIdMiddleware, REQUEST_ID_HEADER } from "./middleware/request-id.js";
import { AbuseDetector } from "./middleware/abuse-detection.js";
import { sanitizeForLog } from "../utils/sanitize-for-log.js";
import { SecretRevealError } from "../services/secret-errors.js";

export interface AppDeps {
  log: Logger;
  corsOrigin: string;
  orders: OrderService;
  secrets: SecretService;
  quotes: QuoteService;
  getReconciliationStatus?: () => ReconciliationStatus;
  getReadinessChecks?: ReadinessCheckProvider;
  /**
   * When provided, `POST /admin/reconcile` will trigger an immediate
   * reconciliation run and return the resulting `ReconciliationStatus`.
   * Omitting this disables the endpoint (the route is not mounted).
   */
  runReconcile?: () => Promise<ReconciliationStatus>;
  /**
   * When provided, `POST /admin/stale-cleanup` will trigger an immediate
   * stale-order cleanup run and return the resulting `StaleCleanupResult`.
   * Omitting this disables the endpoint (the route is not mounted).
   */
  runStaleCleanup?: () => Promise<StaleCleanupResult>;
}

export function createApp(deps: AppDeps): Express {
  const app = express();

  // Shared abuse detector — tracks IPs hitting rate limits across multiple
  // routes and surfaces enumeration / bot signals via Prometheus gauges and
  // structured logs.
  const abuseDetector = new AbuseDetector({ log: deps.log });

  // Request-ID middleware runs first so the ID is available to every subsequent
  // handler, including the pino-http logger which picks it up via the logger
  // mixin bound to the AsyncLocalStorage store.
  app.use(requestIdMiddleware);
  app.use(
    pinoHttp({
      logger: deps.log,
      // Echo the correlation ID into the pino-http access log record so the
      // HTTP log line and downstream service log lines share the same field.
      customProps(_req, res) {
        const r = res as express.Response;
        const id = r.locals["requestId"] as string | undefined;
        return id ? { requestId: id } : {};
      }
    })
  );
  app.use(express.json({ limit: "1mb" }));
  app.use(
    cors({
      origin: deps.corsOrigin === "*" ? true : deps.corsOrigin.split(","),
      credentials: true
    })
  );

  // Prometheus HTTP duration instrumentation
  app.use((req, res, next) => {
    const end = httpRequestDuration.startTimer();
    res.on("finish", () => {
      const route = (req.route?.path as string) ?? req.path;
      end({ method: req.method, route, status_code: String(res.statusCode) });
    });
    next();
  });

  app.use(
    healthRoutes({
      getReconciliationStatus: deps.getReconciliationStatus,
      getReadinessChecks: deps.getReadinessChecks
    })
  );
  app.use(metricsRoutes(deps.log));
  // Pass the logger into route factories so rate-limit abuse events are
  // surfaced through the application's structured log stream.  The shared
  // abuse detector is also threaded through so cross-route enumeration is
  // tracked automatically.
  app.use("/api", ordersRoutes(deps.orders, deps.log, abuseDetector));
  app.use("/api", secretsRoutes(deps.secrets, deps.log, abuseDetector));
  // quotes routes expose /api/quotes/eth-xlm, /api/quotes/eth-sol, and
  // /api/prices (the aggregated endpoint consumed by the BridgeForm).
  app.use("/api", quotesRoutes(deps.quotes));

  // Admin maintenance endpoints — only mounted when the dependency callbacks
  // are injected (i.e. in production wiring via index.ts).  Omitting them in
  // tests keeps the app surface minimal without sacrificing isolation.
  if (deps.runReconcile && deps.runStaleCleanup) {
    app.use(
      adminRoutes({
        log: deps.log,
        runReconcile: deps.runReconcile,
        runStaleCleanup: deps.runStaleCleanup
      })
    );
  }

  // Final error handler - never leak a stack trace to clients.
  app.use(
    (
      err: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      const isSafe = err instanceof SecretRevealError;
      const safeErr = isSafe ? err : sanitizeForLog(err);
      
      deps.log.error({ err: safeErr }, "unhandled error");
      res.status(500).json({ error: "internal_error", message: safeErr.message });
    }
  );

  return app;
}
