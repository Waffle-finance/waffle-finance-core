import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { config as dotenvConfig } from "dotenv";
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
import {
  validateSorobanChainConfig,
  formatConfigReport,
  type SorobanChainConfigInput,
} from "./soroban-chain-config.js";

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
    featureFlags: {
      solanaSimulationMode: rawEnv.FEATURE_SOLANA_SIMULATION_MODE ?? "false",
      sorobanEarlySupport: rawEnv.FEATURE_SOROBAN_EARLY_SUPPORT ?? "false",
      experimentalUiRoutes: rawEnv.FEATURE_EXPERIMENTAL_UI_ROUTES ?? "false",
    },
    ethereum: {
      rpcUrl: resolveEthereumRpcUrl(isMainnet ? "mainnet" : "testnet", rawEnv),
      chainId: isMainnet ? 1 : 11_155_111,
      htlcEscrow: rawEnv[isMainnet ? "ETH_HTLC_ESCROW_MAINNET" : "ETH_HTLC_ESCROW_TESTNET"] ?? "",
      resolverRegistry: rawEnv[isMainnet ? "ETH_RESOLVER_REGISTRY_MAINNET" : "ETH_RESOLVER_REGISTRY_TESTNET"] ?? "",
    },
    soroban: {
      rpcUrl: rawEnv.SOROBAN_RPC_URL ?? (isMainnet ? "https://mainnet.sorobanrpc.com" : "https://soroban-testnet.stellar.org"),
      horizonUrl: rawEnv.STELLAR_HORIZON_URL ?? (isMainnet ? "https://horizon.stellar.org" : "https://horizon-testnet.stellar.org"),
      networkPassphrase: isMainnet
        ? "Public Global Stellar Network ; September 2015"
        : "Test SDF Network ; September 2015",
      htlcContract: rawEnv[isMainnet ? "SOROBAN_HTLC_MAINNET" : "SOROBAN_HTLC_TESTNET"],
      resolverRegistry: rawEnv[isMainnet ? "SOROBAN_RESOLVER_REGISTRY_MAINNET" : "SOROBAN_RESOLVER_REGISTRY_TESTNET"],
    },
    solana: {
      rpcUrl: rawEnv.SOLANA_RPC_URL ?? (isMainnet ? "https://api.mainnet-beta.solana.com" : "https://api.devnet.solana.com"),
      programId: rawEnv[isMainnet ? "SOLANA_HTLC_PROGRAM_MAINNET" : "SOLANA_HTLC_PROGRAM_TESTNET"] ?? "PLACEHOLDER",
      commitment: rawEnv.SOLANA_COMMITMENT ?? "confirmed",
    },
  };

  // ── Soroban/chain config contract validation ─────────────────────────────
  // Run the typed config contract before Zod parsing so that semantic and
  // connectivity problems (endpoint format, chain ID mismatch, placeholder IDs)
  // produce formatted, actionable reports instead of raw Zod errors.
  const chainInput: SorobanChainConfigInput = {
    network: mapped.network,
    soroban: {
      rpcUrl: mapped.soroban.rpcUrl,
      horizonUrl: mapped.soroban.horizonUrl,
      networkPassphrase: mapped.soroban.networkPassphrase,
      htlcContract: mapped.soroban.htlcContract,
      resolverRegistry: mapped.soroban.resolverRegistry,
    },
    ethereum: {
      rpcUrl: mapped.ethereum.rpcUrl,
      chainId: mapped.ethereum.chainId,
      htlcEscrow: mapped.ethereum.htlcEscrow ?? null,
      resolverRegistry: mapped.ethereum.resolverRegistry ?? null,
    },
    solana: {
      programId: mapped.solana.programId,
      rpcUrl: mapped.solana.rpcUrl,
    },
  };
  const chainResult = validateSorobanChainConfig(chainInput);

  // Always print the report at startup so operators can see which chains are
  // active vs disabled without having to inspect individual env vars.
  if (!chainResult.ok || chainResult.warnings.length > 0) {
    console.warn(formatConfigReport(chainResult));
  }

  if (!chainResult.ok) {
    const details = chainResult.errors
      .map((e) => `  [${e.code}] ${e.envVar}: ${e.message}`)
      .join("\n");
    throw new Error(
      `Coordinator configuration rejected by Soroban/chain contract — ` +
      `${chainResult.errors.length} error(s):\n${details}`
    );
  }

  const cfg = coordinatorConfigSchema.parse(mapped);
  return cfg;
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
    featureFlags: {
      solanaSimulationMode: rawEnv.FEATURE_SOLANA_SIMULATION_MODE ?? "false",
      sorobanEarlySupport: rawEnv.FEATURE_SOROBAN_EARLY_SUPPORT ?? "false",
      experimentalUiRoutes: rawEnv.FEATURE_EXPERIMENTAL_UI_ROUTES ?? "false",
    },
    resolverAllowlist: rawEnv.RELAYER_RESOLVER_ADDRESSES,
    rpcTimeoutMs: rawEnv.RELAYER_RPC_TIMEOUT_MS ?? "30000",
    ethereum: {
      network: rawEnv.ETHEREUM_NETWORK ?? (isMainnet ? "mainnet" : "testnet"),
      rpcUrl: resolveEthereumRpcUrl(isMainnet ? "mainnet" : "testnet", rawEnv),
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
      horizonUrl: rawEnv.STELLAR_HORIZON_URL ?? (isMainnet ? "https://horizon.stellar.org" : "https://horizon-testnet.stellar.org"),
      networkPassphrase: rawEnv.STELLAR_NETWORK_PASSPHRASE ?? (isMainnet
        ? "Public Global Stellar Network ; September 2015"
        : "Test SDF Network ; September 2015"),
      secretKey: rawEnv.RELAYER_STELLAR_SECRET ?? "",
      publicKey: rawEnv.RELAYER_STELLAR_PUBLIC ?? "",
      startLedger: rawEnv.START_LEDGER_STELLAR ?? "0",
      minConfirmations: rawEnv.STELLAR_MIN_CONFIRMATIONS ?? "1",
    },
    solana: {
      rpcUrl: rawEnv.SOLANA_RPC_URL ?? (isMainnet ? "https://api.mainnet-beta.solana.com" : "https://api.devnet.solana.com"),
      privateKey: rawEnv.SOLANA_PRIVATE_KEY ?? "",
      programId: rawEnv.SOLANA_HTLC_PROGRAM ?? rawEnv.SOLANA_HTLC_PROGRAM_TESTNET ?? rawEnv.SOLANA_HTLC_PROGRAM_MAINNET ?? "PLACEHOLDER",
      commitment: (rawEnv.SOLANA_COMMITMENT as "processed" | "confirmed" | "finalized") ?? "confirmed",
    },
    fees: {
      feeRate: rawEnv.RELAYER_FEE_RATE ?? "50",
      minSwapAmountUSD: rawEnv.MIN_SWAP_AMOUNT_USD ?? "10",
      maxSwapAmountUSD: rawEnv.MAX_SWAP_AMOUNT_USD ?? "100000",
      maxOrderAmount: rawEnv.MAX_ORDER_AMOUNT ?? "1000000",
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

  const relayCfg = relayerConfigSchema.parse(mapped);

  // ── Soroban/chain config contract validation ─────────────────────────────
  // The relayer uses `stellar` (not `soroban`) for its Stellar block.  We
  // build a minimal SorobanChainConfigInput from the relayer's parsed fields
  // so the shared validator can check endpoint reachability, passphrase
  // consistency, and contract address format without duplicating logic here.
  const relayerChainInput: SorobanChainConfigInput = {
    network: relayCfg.network,
    soroban: {
      rpcUrl: rawEnv.SOROBAN_RPC_URL ??
        (isMainnet ? "https://mainnet.sorobanrpc.com" : "https://soroban-testnet.stellar.org"),
      horizonUrl: relayCfg.stellar.horizonUrl,
      networkPassphrase: relayCfg.stellar.networkPassphrase,
      // Relayer does not use Soroban contracts directly — optional here.
      htlcContract: null,
      resolverRegistry: null,
    },
    ethereum: {
      rpcUrl: relayCfg.ethereum.rpcUrl,
      chainId: isMainnet ? 1 : 11_155_111,
      htlcEscrow: rawEnv[isMainnet ? "ETH_HTLC_ESCROW_MAINNET" : "ETH_HTLC_ESCROW_TESTNET"] ?? null,
      resolverRegistry:
        rawEnv[isMainnet ? "ETH_RESOLVER_REGISTRY_MAINNET" : "ETH_RESOLVER_REGISTRY_TESTNET"] ?? null,
    },
    // Relayer uses Solana for direct settlement when configured.
    solana: {
      programId: relayCfg.solana.programId,
      rpcUrl: relayCfg.solana.rpcUrl,
    },
  };
  const relayerChainResult = validateSorobanChainConfig(relayerChainInput);

  if (!relayerChainResult.ok || relayerChainResult.warnings.length > 0) {
    console.warn(formatConfigReport(relayerChainResult));
  }

  if (!relayerChainResult.ok) {
    const details = relayerChainResult.errors
      .map((e) => `  [${e.code}] ${e.envVar}: ${e.message}`)
      .join("\n");
    throw new Error(
      `Relayer configuration rejected by Soroban/chain contract — ` +
      `${relayerChainResult.errors.length} error(s):\n${details}`
    );
  }

  return relayCfg;
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

  const mapped = {
    network,
    pollIntervalMs: rawEnv.RESOLVER_POLL_INTERVAL_MS ?? "15000",
    coordinatorUrl: rawEnv.COORDINATOR_URL ?? "http://localhost:3001",
    logLevel: rawEnv.LOG_LEVEL ?? "info",
    featureFlags: {
      solanaSimulationMode: rawEnv.FEATURE_SOLANA_SIMULATION_MODE ?? "false",
      sorobanEarlySupport: rawEnv.FEATURE_SOROBAN_EARLY_SUPPORT ?? "false",
      experimentalUiRoutes: rawEnv.FEATURE_EXPERIMENTAL_UI_ROUTES ?? "false",
    },
    ethereum: {
      rpcUrl: resolveEthereumRpcUrl(isMainnet ? "mainnet" : "testnet", rawEnv),
      chainId: isMainnet ? 1 : 11_155_111,
      htlcEscrow: rawEnv[isMainnet ? "ETH_HTLC_ESCROW_MAINNET" : "ETH_HTLC_ESCROW_TESTNET"] ?? "",
      resolverRegistry: rawEnv[isMainnet ? "ETH_RESOLVER_REGISTRY_MAINNET" : "ETH_RESOLVER_REGISTRY_TESTNET"] ?? "",
      resolverPrivateKey: rawEnv.RESOLVER_ETH_PRIVATE_KEY ?? "",
    },
    soroban: {
      rpcUrl: rawEnv.SOROBAN_RPC_URL ?? (isMainnet ? "https://mainnet.sorobanrpc.com" : "https://soroban-testnet.stellar.org"),
      horizonUrl: rawEnv.STELLAR_HORIZON_URL ?? (isMainnet ? "https://horizon.stellar.org" : "https://horizon-testnet.stellar.org"),
      networkPassphrase: isMainnet
        ? "Public Global Stellar Network ; September 2015"
        : "Test SDF Network ; September 2015",
      htlc: rawEnv[isMainnet ? "SOROBAN_HTLC_MAINNET" : "SOROBAN_HTLC_TESTNET"] ?? "",
      resolverRegistry: rawEnv[isMainnet ? "SOROBAN_RESOLVER_REGISTRY_MAINNET" : "SOROBAN_RESOLVER_REGISTRY_TESTNET"] ?? "",
      resolverSecret: rawEnv.RESOLVER_STELLAR_SECRET ?? "",
    },
  };

  const resolverCfg = resolverConfigSchema.parse(mapped);

  // ── Soroban/chain config contract validation ─────────────────────────────
  // Resolver uses `soroban.htlc` (not `htlcContract`) in its own schema but
  // we map it to the shared validator's field name here so the contract is
  // applied consistently across all three services.
  const resolverChainInput: SorobanChainConfigInput = {
    network: resolverCfg.network,
    soroban: {
      rpcUrl: resolverCfg.soroban.rpcUrl,
      horizonUrl: resolverCfg.soroban.horizonUrl,
      networkPassphrase: resolverCfg.soroban.networkPassphrase,
      htlcContract: resolverCfg.soroban.htlc,
      resolverRegistry: resolverCfg.soroban.resolverRegistry,
    },
    ethereum: {
      rpcUrl: resolverCfg.ethereum.rpcUrl,
      chainId: resolverCfg.ethereum.chainId,
      htlcEscrow: resolverCfg.ethereum.htlcEscrow ?? null,
      resolverRegistry: resolverCfg.ethereum.resolverRegistry ?? null,
    },
    // Resolver does not interact with Solana directly.
    solana: { programId: null },
  };
  const resolverChainResult = validateSorobanChainConfig(resolverChainInput);

  if (!resolverChainResult.ok || resolverChainResult.warnings.length > 0) {
    console.warn(formatConfigReport(resolverChainResult));
  }

  if (!resolverChainResult.ok) {
    const details = resolverChainResult.errors
      .map((e) => `  [${e.code}] ${e.envVar}: ${e.message}`)
      .join("\n");
    throw new Error(
      `Resolver configuration rejected by Soroban/chain contract — ` +
      `${resolverChainResult.errors.length} error(s):\n${details}`
    );
  }

  return resolverCfg;
}
