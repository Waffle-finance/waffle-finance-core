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

export async function runCommand(): Promise<void> {
  const cfg = loadConfig();
  const log = getLogger(cfg.logLevel);
  log.info({ network: cfg.network }, "WaffleFinance resolver starting");

  // Record start time.
  startTimeSeconds.set(Math.floor(Date.now() / 1000));

  // Fail fast: reject bad credentials, wrong chain ids, or mismatched/unreachable
  // RPC endpoints before any listener attaches. This keeps the resolver from
  // silently missing events or submitting claims against the wrong network.
  try {
    await validateResolverConfig(cfg, { logger: log });
  } catch (err) {
    if (err instanceof ConfigValidationError) {
      log.error(`Resolver startup aborted: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
  log.info("resolver configuration validated");

  // Start HTTP server for Prometheus metrics.
  const metricsPort = Number(process.env.RESOLVER_METRICS_PORT ?? 3002);
  const metricsApp = express();
  metricsApp.use(metricsRouter());
  const metricsServer = createServer(metricsApp);
  metricsServer.listen(metricsPort, () => {
    log.info({ port: metricsPort }, "metrics HTTP server listening");
    activeListeners.set({ chain: "http" }, 1);
  });

  const eth = new EthereumListener(cfg, log);
  const stellar = new SorobanListener(cfg, cfg.pollIntervalMs, log);
  const supervisor = new Supervisor({ log, maxRestarts: 5, restartDelayMs: 5_000 });
  const healthPort = Number(process.env.RESOLVER_HEALTH_PORT ?? 3003);
  const healthServer = startResolverHealthServer({ cfg, supervisor }, healthPort);
  log.info({ port: healthPort }, "resolver health server listening");

  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;

    log.info({ signal }, "shutting down");
    supervisor.stop();

    activeListeners.set({ chain: "http" }, 0);

    try {
      await eth.stop();
    } catch (err) {
      log.warn({ err }, "error stopping Ethereum listener");
    }
    try {
      stellar.stop();
    } catch (err) {
      log.warn({ err }, "error stopping Soroban listener");
    }
    healthServer.close();
    metricsServer.close();

    // Flush pino's async transport before exiting so the last log lines land.
    await log.flush?.();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  const listeners = {
    async start() {
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
        }
      });

      await stellar.start({
        onContractEvent: (e) => {
          log.info(
            { ledger: e.ledger, txHash: e.txHash, topics: e.topics.length },
            "Soroban event"
          );
          ordersProcessedTotal.inc({ chain: CHAIN_SOROBAN, action: "contract_event" });
          listenerLastEventTimestampSeconds.set({ chain: CHAIN_SOROBAN }, Math.floor(Date.now() / 1000));
        }
      });
    },
    async stop() {
      await eth.stop();
      stellar.stop();
    }
  };

  try {
    log.info("resolver running; press Ctrl-C to exit");
    await supervisor.run(listeners);
  } catch (err) {
    if (err instanceof FatalError) {
      log.error({ err }, "fatal error — resolver exiting");
    } else {
      log.error({ err }, "supervisor exhausted restarts — resolver exiting");
    }
    await log.flush?.();
    process.exit(1);
  }
}
