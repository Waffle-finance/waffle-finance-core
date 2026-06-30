import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { config as dotenvConfig } from "dotenv";
import { loadChainSettings } from "./chains.js";
import { resolveEthereumRpcUrl } from "./ethereum-rpc-url.js";
import {
  coordinatorConfigSchema,
  type CoordinatorConfig,
  relayerConfigSchema,
  type RelayerConfig,
  resolverConfigSchema,
  type ResolverConfig,
  type NetworkMode,
} from "./schema.js";

/**
 * Traverses up from the current directory to find the nearest .env file.
 */
export function findEnvFile(): string | null {
  let dir = process.cwd();
  while (true) {
    const envPath = join(dir, ".env");
    if (existsSync(envPath)) {
      return envPath;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return null;
}

/**
 * Resolves the .env file path and loads it via dotenv.
 */
export function loadDotenv(): void {
  const envPath = findEnvFile();
  if (envPath) {
    dotenvConfig({ path: envPath });
  } else {
    // Fallback to local .env
    dotenvConfig();
  }
}

/**
 * Validates and loads coordinator configuration.
 */
export function loadCoordinatorConfig(
  rawEnv: Record<string, string | undefined> = process.env
): CoordinatorConfig {
  loadDotenv();
  
  const network = (rawEnv.NETWORK_MODE ?? rawEnv.NETWORK ?? "testnet") as NetworkMode;
  const isMainnet = network === "mainnet";
  const chain = loadChainSettings(network, rawEnv, {
    ethereumRpcUrl: resolveEthereumRpcUrl(isMainnet ? "mainnet" : "testnet", rawEnv),
  });

  const mapped = {
    network,
    port: rawEnv.COORDINATOR_PORT ?? rawEnv.RELAYER_PORT ?? "3001",
    databaseUrl: rawEnv.DATABASE_URL ?? "file:./wafflefinance.db",
    logLevel: rawEnv.LOG_LEVEL ?? "info",
    corsOrigin: rawEnv.CORS_ORIGIN ?? "*",
    pollIntervalMs: rawEnv.COORDINATOR_POLL_INTERVAL_MS ?? "15000",
    secretStorageKey: rawEnv.SECRET_STORAGE_KEY,
    apiKeys: rawEnv.COORDINATOR_API_KEYS ?? "",
    trustedProxies: rawEnv.COORDINATOR_TRUSTED_PROXIES ?? "",
    ethereum: {
      rpcUrl: chain.ethereum.rpcUrl,
      chainId: chain.ethereum.chainId,
      htlcEscrow: chain.ethereum.htlcEscrow ?? "",
      resolverRegistry: chain.ethereum.resolverRegistry ?? "",
    },
    soroban: {
      rpcUrl: chain.soroban.rpcUrl,
      horizonUrl: chain.soroban.horizonUrl,
      networkPassphrase: chain.soroban.networkPassphrase,
      htlcContract: chain.soroban.htlcContract ?? "",
      resolverRegistry: chain.soroban.resolverRegistry ?? "",
    },
    solana: {
      rpcUrl: chain.solana.rpcUrl,
      programId: chain.solana.programId ?? "PLACEHOLDER",
      commitment: chain.solana.commitment,
    },
  };

  return coordinatorConfigSchema.parse(mapped);
}

/**
 * Validates and loads relayer configuration.
 */
export function loadRelayerConfig(
  rawEnv: Record<string, string | undefined> = process.env
): RelayerConfig {
  loadDotenv();

  const network = (rawEnv.NETWORK_MODE ?? rawEnv.NETWORK ?? "testnet") as NetworkMode;
  const isMainnet = network === "mainnet";
  const chain = loadChainSettings(network, rawEnv, {
    ethereumRpcUrl: resolveEthereumRpcUrl(isMainnet ? "mainnet" : "testnet", rawEnv),
  });

  const mapped = {
    network,
    port: rawEnv.RELAYER_PORT ?? rawEnv.PORT ?? "3001",
    pollInterval: rawEnv.RELAYER_POLL_INTERVAL ?? "15000",
    activePollIntervalMs: rawEnv.RELAYER_ACTIVE_POLL_INTERVAL_MS ?? "15000",
    idlePollIntervalMs: rawEnv.RELAYER_IDLE_POLL_INTERVAL_MS ?? "120000",
    visitorTtlMs: rawEnv.RELAYER_VISITOR_TTL_MS ?? "300000",
    retryAttempts: rawEnv.RELAYER_RETRY_ATTEMPTS ?? "3",
    retryDelay: rawEnv.RELAYER_RETRY_DELAY ?? "2000",
    nodeEnv: rawEnv.NODE_ENV ?? "development",
    enableMockMode: rawEnv.ENABLE_MOCK_MODE ?? "false",
    debug: rawEnv.DEBUG ?? "false",
    resolverAllowlist: rawEnv.RELAYER_RESOLVER_ADDRESSES,
    rpcTimeoutMs: rawEnv.RELAYER_RPC_TIMEOUT_MS ?? "30000",
    ethereum: {
      network: rawEnv.ETHEREUM_NETWORK ?? (isMainnet ? "mainnet" : "testnet"),
      rpcUrl: chain.ethereum.rpcUrl,
      fusionApiUrl: "https://api.1inch.dev/fusion",
      fusionApiKey: rawEnv.ONEINCH_API_KEY ?? "",
      privateKey: rawEnv.RELAYER_PRIVATE_KEY ?? "",
      gasPrice: rawEnv.GAS_PRICE_GWEI ?? "20",
      gasLimit: rawEnv.GAS_LIMIT ?? "300000",
      startBlock: rawEnv.START_BLOCK_ETHEREUM ?? "0",
      minConfirmations: rawEnv.MIN_CONFIRMATION_BLOCKS ?? "6",
    },
    stellar: {
      network: rawEnv.STELLAR_NETWORK ?? network,
      horizonUrl: chain.soroban.horizonUrl,
      networkPassphrase: chain.soroban.networkPassphrase,
      secretKey: rawEnv.RELAYER_STELLAR_SECRET ?? "",
      publicKey: rawEnv.RELAYER_STELLAR_PUBLIC ?? "",
      startLedger: rawEnv.START_LEDGER_STELLAR ?? "0",
      minConfirmations: rawEnv.STELLAR_MIN_CONFIRMATIONS ?? "1",
    },
    fees: {
      feeRate: chain.fees.feeRateBps,
      minSwapAmountUSD: chain.fees.minSwapAmountUsd,
      maxSwapAmountUSD: chain.fees.maxSwapAmountUsd,
      maxOrderAmount: chain.fees.maxOrderAmount,
    },
    security: {
      minTimelockDuration: rawEnv.MIN_TIMELOCK_DURATION ?? "3600",
      maxTimelockDuration: rawEnv.MAX_TIMELOCK_DURATION ?? "604800",
      defaultTimelockDuration: rawEnv.DEFAULT_TIMELOCK_DURATION ?? "86400",
      emergencyShutdown: rawEnv.EMERGENCY_SHUTDOWN ?? "false",
      maintenanceMode: rawEnv.MAINTENANCE_MODE ?? "false",
    },
    monitoring: {
      logLevel: rawEnv.LOG_LEVEL ?? "info",
      enableRequestLogging: rawEnv.ENABLE_REQUEST_LOGGING ?? "false",
      verboseLogging: rawEnv.VERBOSE_LOGGING ?? "false",
      healthCheckInterval: rawEnv.HEALTH_CHECK_INTERVAL ?? "30000",
      healthCheckTimeout: rawEnv.HEALTH_CHECK_TIMEOUT ?? "5000",
    },
  };

  return relayerConfigSchema.parse(mapped);
}

/**
 * Validates and loads resolver configuration.
 */
export function loadResolverConfig(
  rawEnv: Record<string, string | undefined> = process.env
): ResolverConfig {
  loadDotenv();

  const network = (rawEnv.NETWORK_MODE ?? rawEnv.NETWORK ?? "testnet") as NetworkMode;
  const isMainnet = network === "mainnet";
  const chain = loadChainSettings(network, rawEnv, {
    ethereumRpcUrl: resolveEthereumRpcUrl(isMainnet ? "mainnet" : "testnet", rawEnv),
  });

  const mapped = {
    network,
    pollIntervalMs: rawEnv.RESOLVER_POLL_INTERVAL_MS ?? "15000",
    coordinatorUrl: rawEnv.COORDINATOR_URL ?? "http://localhost:3001",
    logLevel: rawEnv.LOG_LEVEL ?? "info",
    ethereum: {
      rpcUrl: chain.ethereum.rpcUrl,
      chainId: chain.ethereum.chainId,
      htlcEscrow: chain.ethereum.htlcEscrow ?? "",
      resolverRegistry: chain.ethereum.resolverRegistry ?? "",
      resolverPrivateKey: rawEnv.RESOLVER_ETH_PRIVATE_KEY ?? "",
    },
    soroban: {
      rpcUrl: chain.soroban.rpcUrl,
      horizonUrl: chain.soroban.horizonUrl,
      networkPassphrase: chain.soroban.networkPassphrase,
      htlc: chain.soroban.htlcContract ?? "",
      resolverRegistry: chain.soroban.resolverRegistry ?? "",
      resolverSecret: rawEnv.RESOLVER_STELLAR_SECRET ?? "",
    },
  };

  return resolverConfigSchema.parse(mapped);
}
