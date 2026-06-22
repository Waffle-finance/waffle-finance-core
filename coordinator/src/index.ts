import { loadConfig } from "./config.js";
import { getLogger } from "./logger.js";
import { openDatabase } from "./persistence/db.js";
import { OrdersRepository } from "./persistence/orders-repo.js";
import { OrderService } from "./services/order-service.js";
import { QuoteService } from "./services/quote-service.js";
import { SecretService } from "./services/secret-service.js";
import { createApp } from "./server/app.js";
import { EthereumListener } from "./listeners/ethereum-listener.js";
import { SorobanListener } from "./listeners/soroban-listener.js";
import { SolanaListener } from "./listeners/solana-listener.js";
import { Reconciler } from "./reconciliation/reconciler.js";
import { createReadinessChecks } from "./readiness.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = getLogger(cfg.logLevel);
  log.info({ network: cfg.network, port: cfg.port }, "WaffleFinance coordinator starting");

  const db = await openDatabase(cfg.databaseUrl);
  const repo = new OrdersRepository(db);
  const orders = new OrderService(repo, log);
  const secrets = new SecretService(orders, log, cfg.secretStorageKey ?? undefined);
  const quotes = new QuoteService(log);

  const reconciler = new Reconciler(cfg, orders, log);

  const app = createApp({
    log,
    corsOrigin: cfg.corsOrigin,
    orders,
    secrets,
    quotes,
    getReconciliationStatus: () => reconciler.getStatus(),
    getReadinessChecks: createReadinessChecks({
      cfg,
      db,
      getReconciliationStatus: () => reconciler.getStatus()
    })
  });

  const server = app.listen(cfg.port, () => {
    log.info({ port: cfg.port }, "HTTP server listening");
  });

  // Run reconciliation once at startup, then every poll interval.
  void reconciler.run();
  const reconcileInterval = setInterval(
    () => void reconciler.run(),
    cfg.pollIntervalMs * 4 // ~1 min at default 15s poll
  );

  const ethListener = new EthereumListener(cfg, orders, log);
  const sorobanListener = new SorobanListener(cfg, orders, log);
  const solanaListener = new SolanaListener(cfg, orders, log);
  ethListener.start();
  sorobanListener.start();
  solanaListener.start();

  const shutdown = async (signal: string) => {
    log.info({ signal }, "shutting down");
    clearInterval(reconcileInterval);
    ethListener.stop();
    sorobanListener.stop();
    solanaListener.stop();
    server.close(() => {
      if ('close' in db) (db as any).close();
      process.exit(0);
    });
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("Fatal coordinator startup error:", err);
  process.exit(1);
});
