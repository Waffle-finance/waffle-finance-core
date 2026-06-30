import { loadConfig } from "../config.js";
import { validateResolverConfig, ConfigValidationError } from "../validation.js";
import { getLogger } from "../logger.js";
import { EthereumListener } from "../listeners/ethereum.js";
import { SorobanListener } from "../listeners/soroban.js";
import { Supervisor, FatalError } from "../supervisor.js";
import { startResolverHealthServer } from "../health.js";

export async function runCommand(): Promise<void> {
  const cfg = loadConfig();
  const log = getLogger(cfg.logLevel);
  log.info({ network: cfg.network }, "WaffleFinance resolver starting");

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
        },
        onOrderClaimed: (e) => {
          log.info({ orderId: e.orderId.toString(), preimage: e.preimage }, "ETH order claimed");
        },
        onOrderRefunded: (e) => {
          log.info({ orderId: e.orderId.toString() }, "ETH order refunded");
        }
      });

      await stellar.start({
        onContractEvent: (e) => {
          log.info(
            { ledger: e.ledger, txHash: e.txHash, topics: e.topics.length },
            "Soroban event"
          );
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
