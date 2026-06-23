import { loadConfig } from "../config.js";
import { validateResolverConfig, ConfigValidationError } from "../validation.js";
import { getLogger } from "../logger.js";
import { EthereumListener } from "../listeners/ethereum.js";
import { SorobanListener } from "../listeners/soroban.js";

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

  const eth = new EthereumListener(cfg.ethereum, log);
  const stellar = new SorobanListener(cfg.soroban, cfg.pollIntervalMs, log);

  await eth.start({
    onOrderCreated: (e) => {
      log.info({ orderId: e.orderId.toString(), hashlock: e.hashlock, amount: e.amount.toString() }, "ETH order created");
      // Resolver fill logic will be added in Phase 5 once the SDK exposes the
      // counterpart Soroban submission helper. Until then this resolver is
      // observe-only and the reference coordinator handles secret relay.
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
      log.info({ ledger: e.ledger, txHash: e.txHash, topics: e.topics.length }, "Soroban event");
    }
  });

  const shutdown = async () => {
    log.info("shutting down");
    await eth.stop();
    stellar.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  log.info("resolver running; press Ctrl-C to exit");
}
