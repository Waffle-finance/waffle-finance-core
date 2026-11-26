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
import { auditRoutes } from "./routes/audit.js";
import { exportRoutes } from "./routes/export.js";
import { sseRoutes } from "./routes/sse.js";
import type { SseBroker } from "../sse/sse-broker.js";
import { apiVersionMiddleware } from "./versioning.js";
import type { OrderService } from "../services/order-service.js";
import type { OrderExportService } from "../services/order-export.js";
import type { SecretService } from "../services/secret-service.js";
import type { QuoteService } from "../services/quote-service.js";
import type { ReconciliationStatus } from "../reconciliation/reconciler.js";
import type { StaleCleanupResult } from "../services/stale-cleanup.js";
import type { ExpiryResult } from "./routes/admin.js";
import { requestIdMiddleware, REQUEST_ID_HEADER } from "./middleware/request-id.js";
import { getRequestContext } from "../request-context.js";
import { sensitiveSerializers } from "../sensitive/sensitive-fields.js";
import { AbuseDetector } from "./middleware/abuse-detection.js";
import { sanitizeForLog } from "../utils/sanitize-for-log.js";
import { SecretRevealError } from "../services/secret-errors.js";
import type { AuditRepository } from "../audit/audit-repo.js";
import type { OrdersRepository } from "../persistence/orders-repo.js";
import { AuditExporter } from "../audit/audit-exporter.js";
import { assertRouteAuthorizationCoverage } from "./authorization-policy.js";

export interface AppDeps {
  log: Logger;
  corsOrigin: string;
  orders: OrderService;
  secrets: SecretService;
  quotes: QuoteService;
  /** Optional — when provided, the audit replay endpoints are mounted. */
  auditRepo?: AuditRepository;
  /** Optional — when provided, enables the /timeline endpoint in audit routes. */
  ordersRepo?: OrdersRepository;
  /** Optional — when provided, the order export endpoints are mounted. */
  orderExport?: OrderExportService;
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
  /**
   * When provided, `POST /admin/expire-now` will trigger an immediate
   * order-expiry scan and return the count of newly-expired orders.
   * Omitting this disables the endpoint (the route is not mounted).
   */
  runExpiry?: () => Promise<ExpiryResult>;
  getReconciliationCursors?: () => ReturnType<OrderService["getReconciliationCursorState"]>;
  /**
   * When provided, the SSE endpoint `GET /api/orders/:id/events` is mounted
   * and OrderService transitions broadcast events to connected clients.
   */
  sseBroker?: SseBroker;
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

  // API versioning middleware — extracts version from Accept header and attaches
  // to req.apiVersion for downstream handlers to use in response shaping.
  app.use(apiVersionMiddleware());

  app.use(
    pinoHttp({
      logger: deps.log,
      // Echo the correlation ID and order ID into the pino-http access log record
      // so the HTTP log line and downstream service log lines share the same fields.
      customProps(_req, res) {
        const r = res as express.Response;
        const ctx = getRequestContext();
        const requestId = (r.locals["requestId"] as string | undefined) ?? ctx?.requestId;
        const correlationId = (r.locals["correlationId"] as string | undefined) ?? ctx?.correlationId ?? requestId;
        const orderId = (r.locals["orderId"] as string | undefined) ?? ctx?.orderId ?? undefined;
        const props: Record<string, unknown> = {};
        if (requestId) props.requestId = requestId;
        if (correlationId) props.correlationId = correlationId;
        if (orderId) props.orderId = orderId;
        return props;
      },
      serializers: sensitiveSerializers(),
    })
  );
  // Per-route payload size limits must be registered BEFORE express.json()
  // so they can reject oversized bodies before the JSON parser buffers them.
  // The global express.json({ limit: "1mb" }) below is a last-resort safety
  // net for routes without an explicit per-route limit.
  //
  // Each LIMITS.* middleware checks Content-Length first (zero body read),
  // then installs a streaming byte counter. When a request exceeds the limit,
  // it responds with 413 and destroys the socket before express.json() can
  // attempt to parse the body.
  const express_json_limit_8k = express.json({ limit: `${8_192}b` });
  const express_json_limit_2k = express.json({ limit: `${2_048}b` });
  app.use("/api/orders/announce", express_json_limit_8k);
  app.use("/api/secrets/reveal", express_json_limit_2k);
  app.use("/api/orders/:id/src-locked", express_json_limit_2k);
  app.use("/api/orders/:id/dst-locked", express_json_limit_2k);
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
  // Static export paths must precede /orders/:id.
  if (deps.orderExport) {
    app.use("/api", exportRoutes(deps.orderExport, deps.log));
  }
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
        runStaleCleanup: deps.runStaleCleanup,
        runExpiry: deps.runExpiry,
        getReconciliationCursors: deps.getReconciliationCursors,
      })
    );
  }

  // Audit replay endpoints — only mounted when an AuditRepository is injected.
  if (deps.auditRepo) {
    const exporter = new AuditExporter(deps.auditRepo);
    app.use("/api", auditRoutes(deps.auditRepo, exporter, deps.log, deps.ordersRepo));
  }

  // SSE endpoint — only mounted when a SseBroker is injected.
  // Provides GET /api/orders/:id/events for real-time push delivery.
  if (deps.sseBroker) {
    app.use("/api", sseRoutes(deps.orders, deps.sseBroker, deps.log));
  }

  // Final error handler - never leak a stack trace to clients.
  app.use(
    (
      err: Error & { type?: string; status?: number; statusCode?: number },
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      // body-parser (express.json) emits an error with type "entity.too.large"
      // and status 413 when the per-route JSON limit is exceeded. Convert it
      // to our standard payload_too_large envelope so the response shape is
      // consistent with what the payload-limits middleware produces.
      if (
        (err.type === "entity.too.large" || err.status === 413 || err.statusCode === 413)
      ) {
        if (!res.headersSent) {
          res.status(413).json({
            error: "payload_too_large",
            message: "Request body exceeds the size limit for this endpoint",
          });
        }
        return;
      }

      const isSafe = err instanceof SecretRevealError;
      const safeErr = isSafe ? err : sanitizeForLog(err);
      
      deps.log.error({ err: safeErr }, "unhandled error");
      res.status(500).json({ error: "internal_error", message: safeErr.message });
    }
  );

  // A route mounted without an explicit policy entry must never ship.
  assertRouteAuthorizationCoverage(app);

  return app;
}
