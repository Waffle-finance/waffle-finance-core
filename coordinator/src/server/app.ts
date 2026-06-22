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
import type { OrderService } from "../services/order-service.js";
import type { SecretService } from "../services/secret-service.js";
import type { QuoteService } from "../services/quote-service.js";
import type { ReconciliationStatus } from "../reconciliation/reconciler.js";

export interface AppDeps {
  log: Logger;
  corsOrigin: string;
  orders: OrderService;
  secrets: SecretService;
  quotes: QuoteService;
  getReconciliationStatus?: () => ReconciliationStatus;
  getReadinessChecks?: ReadinessCheckProvider;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.use(pinoHttp({ logger: deps.log }));
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
  app.use(metricsRoutes());
  // Pass the logger into route factories so rate-limit abuse events are
  // surfaced through the application's structured log stream.
  app.use("/api", ordersRoutes(deps.orders, deps.log));
  app.use("/api", secretsRoutes(deps.secrets, deps.log));
  // quotes routes expose /api/quotes/eth-xlm, /api/quotes/eth-sol, and
  // /api/prices (the aggregated endpoint consumed by the BridgeForm).
  app.use("/api", quotesRoutes(deps.quotes));

  // Final error handler - never leak a stack trace to clients.
  app.use(
    (
      err: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      deps.log.error({ err }, "unhandled error");
      res.status(500).json({ error: "internal_error", message: err.message });
    }
  );

  return app;
}
