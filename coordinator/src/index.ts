import { loadConfig, logSolanaStatus } from "./config.js";
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
import { StaleCleanupService } from "./services/stale-cleanup.js";
import { createReadinessChecks } from "./readiness.js";
import type { StartupPhase } from "./readiness.js";
import { retryAsync } from "./retry.js";
import { solanaPlaceholderMode } from "./metrics.js";
import type { CoordinatorConfig } from "./config.js";

// ── Startup dependency probes ────────────────────────────────────────────────

/**
 * Probe each chain RPC to confirm it is reachable before starting listeners.
 * These are TRANSIENT checks — a temporary outage should not crash the
 * coordinator.  Returns true if all probes pass; logs warnings and returns
 * false otherwise so the caller can decide whether to proceed or retry.
 *
 * This is intentionally lightweight: we only check network reachability here,
 * not chain-id or network-passphrase consistency (the listeners do that).
 */
async function probeRpcEndpoints(
  cfg: CoordinatorConfig,
  log: ReturnType<typeof getLogger>
): Promise<void> {
  type FetchLike = typeof globalThis.fetch;
  const fetcher: FetchLike = globalThis.fetch;

  const probes: Array<{ name: string; url: string; method: string }> = [
    { name: "ethereum_rpc", url: cfg.ethereum.rpcUrl, method: "eth_blockNumber" },
    { name: "soroban_rpc",  url: cfg.soroban.rpcUrl,  method: "getHealth"       },
  ];

  // Only probe the Solana RPC when the program id is a real address.
  if (!cfg.solana.programId.startsWith("PLACEHOLDER")) {
    probes.push({ name: "solana_rpc", url: cfg.solana.rpcUrl, method: "getHealth" });
  }

  const errors: string[] = [];
  await Promise.all(
    probes.map(async ({ name, url, method }) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5_000);
      try {
        const res = await fetcher(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method }),
          signal: controller.signal,
        });
        if (!res.ok) {
          errors.push(`${name}: HTTP ${res.status}`);
        }
      } catch (err) {
        errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        clearTimeout(timer);
      }
    })
  );

  if (errors.length > 0) {
    throw new Error(`RPC probe failed — ${errors.join("; ")}`);
  }

  log.info("all RPC endpoints reachable");
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // ── 1. Load and validate configuration (FATAL on failure) ────────────────
  //
  // Config loading reads env vars and validates their shape. A failure here
  // is always fatal: there is nothing to retry because the problem is in the
  // deployment environment, not a transient service outage.
  let cfg: CoordinatorConfig;
  try {
    cfg = loadConfig();
  } catch (err) {
    console.error(
      "[coordinator] FATAL: configuration is invalid — cannot start.",
      err instanceof Error ? err.message : err
    );
    process.exit(1);
  }

  const log = getLogger(cfg.logLevel);
  log.info({ network: cfg.network, port: cfg.port }, "WaffleFinance coordinator starting");

  // ── 2. Solana placeholder check ────────────────────────────────────────
  const solanaStatus = logSolanaStatus(cfg.solana.programId);
  solanaPlaceholderMode.set(solanaStatus === "placeholder" ? 1 : 0);
  if (solanaStatus === "placeholder") {
    log.warn(
      { programId: cfg.solana.programId },
      "Solana HTLC program is a placeholder — Solana listener and settlement flows are DISABLED"
    );
  } else {
    log.info({ programId: cfg.solana.programId }, "Solana HTLC program configured");
  }

  // ── 3. Database connection (TRANSIENT retry, FATAL on schema mismatch) ──
  //
  // Network/filesystem glitches opening the database are transient; we retry
  // with exponential backoff.  Schema version mismatches are fatal: running an
  // old binary against a migrated database is a deployment error that requires
  // human intervention, not an automatic retry.
  log.info(
    { maxAttempts: 10, baseDelayMs: 1_000 },
    "connecting to database (will retry on transient failures)"
  );

  const db = await retryAsync(() => openDatabase(cfg.databaseUrl), {
    maxAttempts: 10,
    baseDelayMs: 1_000,
    maxDelayMs: 30_000,
    jitterMs: 300,
    // Schema errors and bad-URL errors are fatal — do not retry them.
    shouldRetry: (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      // These phrases indicate the database is permanently unusable in its
      // current form; retrying will never help.
      if (msg.includes("Schema validation failed")) return false;
      if (msg.includes("Database schema is behind")) return false;
      if (msg.includes("Database schema is ahead")) return false;
      if (msg.includes("Schema version mismatch")) return false;
      if (msg.includes("Migration history is out of order")) return false;
      return true;
    },
    onRetry: ({ attempt, maxAttempts, delayMs, err }) => {
      log.warn(
        {
          attempt,
          maxAttempts,
          delayMs,
          err: err instanceof Error ? err.message : String(err),
        },
        "database connection attempt failed — retrying (transient)"
      );
    },
  }).catch((err): never => {
    const msg = err instanceof Error ? err.message : String(err);
    // Classify the final error before crashing so operators see clear context.
    if (
      msg.includes("Schema validation failed") ||
      msg.includes("Database schema is") ||
      msg.includes("Schema version mismatch") ||
      msg.includes("Migration history is out of order")
    ) {
      log.error(
        { err },
        "FATAL: database schema mismatch — run migrations before starting the coordinator"
      );
    } else {
      log.error(
        { err },
        "FATAL: could not connect to database after all retry attempts"
      );
    }
    process.exit(1);
  });

  log.info("database ready");

  // ── 4. RPC endpoint health probe (TRANSIENT retry) ─────────────────────
  //
  // Chain RPC nodes may be temporarily overloaded or restarting. We retry the
  // probes before starting listeners so the coordinator never enters a state
  // where its listeners silently miss blocks.  This is NOT a fatal condition —
  // the probes will succeed once the RPC nodes recover.
  log.info("probing chain RPC endpoints (will retry on transient failures)");

  await retryAsync(() => probeRpcEndpoints(cfg, log), {
    maxAttempts: 8,
    baseDelayMs: 2_000,
    maxDelayMs: 30_000,
    jitterMs: 500,
    onRetry: ({ attempt, maxAttempts, delayMs, err }) => {
      log.warn(
        {
          attempt,
          maxAttempts,
          delayMs,
          err: err instanceof Error ? err.message : String(err),
        },
        "RPC probe failed — coordinator is PENDING (waiting for dependencies)"
      );
    },
  }).catch((err) => {
    // Exhausted retries — start anyway and let the readiness endpoint report
    // the degraded state.  The listeners have their own internal retry/backoff
    // and will recover once the RPCs come back.
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "RPC probe exhausted retries — starting listeners anyway; readiness will reflect degraded state"
    );
  });

  // ── 5. Wire up services ─────────────────────────────────────────────────
  //
  // Track and expose the startup lifecycle phase so the readiness endpoint can
  // report "starting" → "pending" → "ready" transitions to health checkers and
  // orchestration systems (e.g. Kubernetes readinessProbe).
  let startupPhase: StartupPhase = "starting";

  const repo = new OrdersRepository(db);
  const orders = new OrderService(repo, log);
  const secrets = new SecretService(orders, log, cfg.secretStorageKey ?? undefined);
  const quotes = new QuoteService(log);

  const reconciler = new Reconciler(cfg, orders, log);
  const staleCleanup = new StaleCleanupService(repo, log);

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
      getReconciliationStatus: () => reconciler.getStatus(),
      getStartupPhase: () => startupPhase,
    }),
    runReconcile: async () => {
      await reconciler.run();
      return reconciler.getStatus();
    },
    runStaleCleanup: () => staleCleanup.run(),
  });

  const server = app.listen(cfg.port, () => {
    log.info({ port: cfg.port }, "HTTP server listening");
  });

  // ── 6. Background intervals ─────────────────────────────────────────────
  void reconciler.run().then(() => {
    // Transition to "ready" once the first reconciliation pass completes.
    // This is the signal to orchestration systems (e.g. Kubernetes readinessProbe)
    // that the coordinator is fully operational.
    startupPhase = "ready";
    log.info("first reconciliation complete — coordinator is READY");
  }).catch((err) => {
    log.warn({ err }, "first reconciliation run failed — staying in pending state");
  });
  const reconcileInterval = setInterval(
    () => void reconciler.run(),
    cfg.pollIntervalMs * 4
  );

  const runExpiry = (): void => {
    orders
      .expireStaleOrders()
      .then((n) => {
        if (n > 0) log.info({ count: n }, "expired stale orders by timelock");
      })
      .catch((err) => log.warn({ err }, "order expiry scan failed"));
  };
  void runExpiry();
  const expiryInterval = setInterval(runExpiry, cfg.pollIntervalMs * 4);

  const runStaleCleanup = (): void => {
    staleCleanup.run().catch((err) => log.warn({ err }, "stale order cleanup failed"));
  };
  const staleCleanupInterval = setInterval(runStaleCleanup, cfg.pollIntervalMs * 240);

  // ── 7. Listeners ────────────────────────────────────────────────────────
  const ethListener = new EthereumListener(cfg, orders, log);
  const sorobanListener = new SorobanListener(cfg, orders, log);
  const solanaListener = new SolanaListener(cfg, orders, log);
  ethListener.start();
  sorobanListener.start();
  solanaListener.start();

  // Transition to "pending" — dependencies are up, first reconciliation
  // not yet done.  The readiness endpoint will return HTTP 200 but with
  // detail="pending" so orchestration systems can distinguish "warming up"
  // from "fully ready".
  startupPhase = "pending";

  log.info("coordinator fully started — all listeners active");

  // ── 8. Graceful shutdown ────────────────────────────────────────────────
  const shutdown = async (signal: string) => {
    log.info({ signal }, "shutting down");
    clearInterval(reconcileInterval);
    clearInterval(expiryInterval);
    clearInterval(staleCleanupInterval);
    ethListener.stop();
    sorobanListener.stop();
    solanaListener.stop();
    server.close(() => {
      if ("close" in db) (db as any).close();
      process.exit(0);
    });
  };

  process.on("SIGINT",  () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(
    "[coordinator] FATAL: unhandled startup error:",
    err instanceof Error ? err.message : err
  );
  process.exit(1);
});
