import { createServer } from "node:http";
import express from "express";
import { loadConfig } from "../config.js";
import { validateResolverConfig, ConfigValidationError } from "../validation.js";
import { getLogger } from "../logger.js";
import { EthereumListener } from "../listeners/ethereum.js";
import { SorobanListener } from "../listeners/soroban.js";
import { Supervisor, FatalError } from "../supervisor.js";
import { startResolverHealthServer } from "../health.js";
import { metricsRouter } from "../routes/metrics.js";
import {
  startTimeSeconds,
  ordersProcessedTotal,
  activeListeners,
  listenerLastEventTimestampSeconds,
} from "../metrics.js";

const CHAIN_ETH = "ethereum";
const CHAIN_SOROBAN = "soroban";

/**
 * Maximum time in milliseconds the shutdown sequence is allowed to run before
 * we force-exit.  Prevents a hung listener or in-flight RPC call from
 * blocking the process indefinitely on SIGTERM.
 */
const SHUTDOWN_TIMEOUT_MS = 15_000;

export async function runCommand(): Promise<void> {
  // ── 1. Configuration ──────────────────────────────────────────────────────
  const cfg = loadConfig();
  const log = getLogger(cfg.logLevel);
  log.info({ network: cfg.network }, "WaffleFinance resolver starting");

  startTimeSeconds.set(Math.floor(Date.now() / 1000));

  // ── 2. Startup validation (FATAL on bad credentials / wrong network) ──────
  //
  // Reject bad credentials, wrong chain ids, or mismatched/unreachable RPC
  // endpoints before any listener attaches.  This keeps the resolver from
  // silently missing events or submitting claims against the wrong network.
  try {
    await validateResolverConfig(cfg, { logger: log });
  } catch (err) {
    if (err instanceof ConfigValidationError) {
      log.error({ reason: err.message }, "resolver startup aborted: invalid configuration");
      process.exit(1);
    }
    throw err;
  }
  log.info("resolver configuration validated");

  // ── 3. Metrics HTTP server ────────────────────────────────────────────────
  const metricsPort = Number(process.env.RESOLVER_METRICS_PORT ?? 3002);
  const metricsApp = express();
  metricsApp.use(metricsRouter());
  const metricsServer = createServer(metricsApp);
  metricsServer.listen(metricsPort, () => {
    log.info({ port: metricsPort }, "metrics HTTP server listening");
    activeListeners.set({ chain: "http" }, 1);
  });

  // ── 4. Supervisor and health server ──────────────────────────────────────
  const eth = new EthereumListener(cfg, log);
  const stellar = new SorobanListener(cfg, cfg.pollIntervalMs, log);
  const supervisor = new Supervisor({
    log,
    maxRestarts: 5,
    restartDelayMs: 5_000,
    maxRestartDelayMs: 60_000,
  });

  const healthPort = Number(process.env.RESOLVER_HEALTH_PORT ?? 3003);
  const healthServer = startResolverHealthServer({ cfg, supervisor }, healthPort);
  log.info({ port: healthPort }, "resolver health server listening");

  // ── 5. Signal handlers ───────────────────────────────────────────────────
  //
  // All termination signals funnel through a single `shutdown()` function that:
  //   a) signals the supervisor to stop (cancels any restart sleep immediately),
  //   b) stops both listeners and awaits their cleanup,
  //   c) closes HTTP servers,
  //   d) flushes async log transport,
  //   e) force-exits after SHUTDOWN_TIMEOUT_MS to prevent hangs.
  //
  // The guard flag ensures re-entrant signal delivery (e.g. double Ctrl-C)
  // doesn't start a second teardown race.

  let shuttingDown = false;
  /** Holds the promise returned by supervisor.run() so shutdown can await it. */
  let supervisorRunPromise: Promise<void> | undefined;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      log.warn({ signal }, "shutdown already in progress — ignoring duplicate signal");
      return;
    }
    shuttingDown = true;

    log.info({ signal }, "resolver shutting down");

    // Arm a hard timeout so we never hang indefinitely.
    const forceExitTimer = setTimeout(() => {
      log.error(
        { timeoutMs: SHUTDOWN_TIMEOUT_MS },
        "shutdown timed out — forcing process exit"
      );
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    // Don't let this timer keep the event loop alive longer than needed.
    forceExitTimer.unref?.();

    // Tell the supervisor to stop and cancel any pending restart sleep.
    supervisor.stop();

    // Stop listeners concurrently.  Each stop is independently try-caught so
    // one failure doesn't prevent the other from being cleaned up.
    activeListeners.set({ chain: "http" }, 0);
    await Promise.allSettled([
      eth.stop().catch((err) => log.warn({ err }, "error stopping Ethereum listener")),
      Promise.resolve().then(() => {
        try {
          stellar.stop();
        } catch (err) {
          log.warn({ err }, "error stopping Soroban listener");
        }
      }),
    ]);

    // Await the supervisor's run loop — it will resolve promptly now that
    // `stopped` is true and the listeners have been told to stop.
    if (supervisorRunPromise) {
      try {
        await supervisorRunPromise;
      } catch {
        // The supervisor may reject if it was in a failed state; ignore here
        // since we're already shutting down intentionally.
      }
    }

    // Close HTTP servers.
    await Promise.allSettled([
      new Promise<void>((resolve) => healthServer.close(() => resolve())),
      new Promise<void>((resolve) => metricsServer.close(() => resolve())),
    ]);

    log.info({ signal }, "resolver stopped cleanly");

    // Flush pino's async transport so the last log lines land before exit.
    await log.flush?.();

    clearTimeout(forceExitTimer);
    process.exit(0);
  };

  // SIGINT  — Ctrl-C in a terminal / Kubernetes SIGINT during rolling update
  // SIGTERM — standard process termination (systemd, Docker, Kubernetes)
  // SIGHUP  — log rotation / soft reload signal; treated as graceful restart
  //           here (stop + let the process manager restart the binary)
  process.on("SIGINT",  () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGHUP",  () => {
    log.info("SIGHUP received — initiating graceful shutdown for restart");
    void shutdown("SIGHUP");
  });

  // Catch unhandled promise rejections so they surface clearly in logs rather
  // than silently terminating the process with an obscure exit code.
  process.on("unhandledRejection", (reason) => {
    log.error({ reason }, "unhandled promise rejection — this is a bug");
    // Do NOT exit here; the supervisor's error handling will decide what to do.
  });

  // ── 6. Listener set definition ──────────────────────────────────────────
  //
  // The listener set is what the Supervisor restarts on recoverable failure.
  // `start()` attaches to both chains; `stop()` tears both down cleanly.
  // Both operations are awaitable so in-flight work can be drained.

  const listeners = {
    async start(): Promise<void> {
      await eth.start({
        onOrderCreated: (e) => {
          log.info(
            { orderId: e.orderId.toString(), hashlock: e.hashlock, amount: e.amount.toString() },
            "ETH order created"
          );
          ordersProcessedTotal.inc({ chain: CHAIN_ETH, action: "order_created" });
          listenerLastEventTimestampSeconds.set({ chain: CHAIN_ETH }, Math.floor(Date.now() / 1000));
        },
        onOrderClaimed: (e) => {
          log.info({ orderId: e.orderId.toString(), preimage: e.preimage }, "ETH order claimed");
          ordersProcessedTotal.inc({ chain: CHAIN_ETH, action: "order_claimed" });
          listenerLastEventTimestampSeconds.set({ chain: CHAIN_ETH }, Math.floor(Date.now() / 1000));
        },
        onOrderRefunded: (e) => {
          log.info({ orderId: e.orderId.toString() }, "ETH order refunded");
          ordersProcessedTotal.inc({ chain: CHAIN_ETH, action: "order_refunded" });
          listenerLastEventTimestampSeconds.set({ chain: CHAIN_ETH }, Math.floor(Date.now() / 1000));
        },
      });

      await stellar.start({
        onOrderCreated: (e) => {
          log.info(
            { orderId: e.orderId, hashlock: e.hashlock, ledger: e.ledger },
            "Soroban order created"
          );
          ordersProcessedTotal.inc({ chain: CHAIN_SOROBAN, action: "order_created" });
          listenerLastEventTimestampSeconds.set({ chain: CHAIN_SOROBAN }, Math.floor(Date.now() / 1000));
        },
        onOrderClaimed: (e) => {
          log.info(
            { orderId: e.orderId, preimage: e.preimage, ledger: e.ledger },
            "Soroban order claimed"
          );
          ordersProcessedTotal.inc({ chain: CHAIN_SOROBAN, action: "order_claimed" });
          listenerLastEventTimestampSeconds.set({ chain: CHAIN_SOROBAN }, Math.floor(Date.now() / 1000));
        },
        onOrderRefunded: (e) => {
          log.info({ orderId: e.orderId, ledger: e.ledger }, "Soroban order refunded");
          ordersProcessedTotal.inc({ chain: CHAIN_SOROBAN, action: "order_refunded" });
          listenerLastEventTimestampSeconds.set({ chain: CHAIN_SOROBAN }, Math.floor(Date.now() / 1000));
        },
      });
    },

    async stop(): Promise<void> {
      await eth.stop();
      stellar.stop();
    },
  };

  // ── 7. Run ───────────────────────────────────────────────────────────────
  log.info("resolver running; press Ctrl-C to exit");

  supervisorRunPromise = supervisor.run(listeners);

  try {
    await supervisorRunPromise;
    // Supervisor resolved cleanly (stop() was called or listeners exited).
    log.info("supervisor exited cleanly");
  } catch (err) {
    if (shuttingDown) {
      // Error during an intentional shutdown — log at info level and exit 0.
      log.info({ err: err instanceof Error ? err.message : String(err) },
        "supervisor error during shutdown — exiting");
      await log.flush?.();
      process.exit(0);
    }

    if (err instanceof FatalError) {
      log.error({ err }, "fatal listener error — resolver exiting");
    } else {
      log.error(
        { err, restarts: supervisor.restarts },
        "supervisor exhausted restarts — resolver exiting"
      );
    }
    await log.flush?.();
    process.exit(1);
  }
}
