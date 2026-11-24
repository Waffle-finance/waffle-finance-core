import { z } from 'zod';
import { privateKeyToAccount } from 'viem/accounts';
import { Keypair, StrKey } from '@stellar/stellar-sdk';

// Common Schemas
export const networkModeSchema = z.enum(['testnet', 'mainnet']).default('testnet');
export type NetworkMode = z.infer<typeof networkModeSchema>;

export const logLevelSchema = z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info');

export const ethereumPrivateKeySchema = z
  .string()
  .refine(val => /^0x[0-9a-fA-F]{64}$/.test(val), {
    message: 'must be a 0x-prefixed 32-byte hex private key',
  })
  .refine(
    val => {
      try {
        privateKeyToAccount(val as `0x${string}`);
        return true;
      } catch {
        return false;
      }
    },
    {
      message: 'must be a usable secp256k1 private key',
    }
  )
  .transform(v => v as `0x${string}`);

export const stellarSecretSchema = z
  .string()
  .refine(val => StrKey.isValidEd25519SecretSeed(val), {
    message: "must be a valid Stellar Ed25519 secret seed (expected an 'S...' StrKey)",
  })
  .refine(
    val => {
      try {
        Keypair.fromSecret(val);
        return true;
      } catch {
        return false;
      }
    },
    {
      message: 'could not be parsed into a Stellar keypair',
    }
  );

export const evmAddressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, { message: 'must be a 0x-prefixed 20-byte address' })
  .transform(v => v as `0x${string}`);

export const optionalEvmAddressSchema = z
  .string()
  .optional()
  .or(z.literal(''))
  .transform(v => (v && v.trim().length > 0 ? v.trim() : null))
  .refine(v => v === null || /^0x[0-9a-fA-F]{40}$/.test(v), {
    message: 'must be a 0x-prefixed 20-byte address',
  })
  .transform(v => (v ? (v as `0x${string}`) : null));

// Shared feature flags schema (used by coordinator/relayer/resolver)
export const featureFlagsSchema = z.object({
  solanaSimulationMode: z.coerce.boolean().default(false),
  sorobanEarlySupport: z.coerce.boolean().default(false),
  experimentalUiRoutes: z.coerce.boolean().default(false),
});

export type FeatureFlags = z.infer<typeof featureFlagsSchema>;

// Coordinator Configuration Schema
export const coordinatorConfigSchema = z.object({
  network: networkModeSchema,
  port: z.coerce.number().int().positive().default(3001),
  databaseUrl: z.string().default('file:./wafflefinance.db'),
  logLevel: logLevelSchema,
  corsOrigin: z.string().default('*'),
  pollIntervalMs: z.coerce.number().int().positive().default(15000),
  secretStorageKey: z
    .string()
    .optional()
    .transform(v => (v && v.trim().length > 0 ? v.trim() : undefined)),
  apiKeys: z.string().default(''),
  trustedProxies: z.string().default(''),
  featureFlags: featureFlagsSchema.default({}),
  ethereum: z.object({
    rpcUrl: z.string().url(),
    chainId: z.number().int(),
    htlcEscrow: optionalEvmAddressSchema,
    resolverRegistry: optionalEvmAddressSchema,
  }),
  soroban: z.object({
    rpcUrl: z.string().url(),
    horizonUrl: z.string().url(),
    networkPassphrase: z.string(),
    htlcContract: z
      .string()
      .optional()
      .transform(v => v ?? null),
    resolverRegistry: z
      .string()
      .optional()
      .transform(v => v ?? null),
  }),
  solana: z.object({
    rpcUrl: z.string().url(),
    programId: z
      .string()
      .optional()
      .transform(v => v ?? 'PLACEHOLDER'),
    commitment: z.enum(['processed', 'confirmed', 'finalized']).default('confirmed'),
  }),
});

export type CoordinatorConfig = z.infer<typeof coordinatorConfigSchema>;

// Relayer Configuration Schema
export const relayerConfigSchema = z.object({
  network: networkModeSchema,
  port: z.coerce.number().int().positive().default(3001),
  pollInterval: z.coerce.number().int().positive().default(15000),
  activePollIntervalMs: z.coerce.number().int().positive().default(15000),
  idlePollIntervalMs: z.coerce.number().int().positive().default(120000),
  visitorTtlMs: z.coerce.number().int().positive().default(300000),
  retryAttempts: z.coerce.number().int().nonnegative().default(3),
  retryDelay: z.coerce.number().int().nonnegative().default(2000),
  nodeEnv: z.string().default('development'),
  enableMockMode: z.coerce.boolean().default(false),
  debug: z.coerce.boolean().default(false),
  featureFlags: featureFlagsSchema.default({}),
  resolverAllowlist: z
    .string()
    .optional()
    .transform(v => {
      if (!v) return [];
      return v
        .split(',')
        .map(x => x.trim().toLowerCase())
        .filter(Boolean);
    }),
  rpcTimeoutMs: z.coerce.number().int().positive().default(30000),
  ethereum: z.object({
    network: z.string().default('mainnet'),
    rpcUrl: z.string().url(),
    fusionApiUrl: z.string().url().default('https://api.1inch.dev/fusion'),
    fusionApiKey: z.string().default(''),
    privateKey: z.string().default(''), // Loaded raw, validated separately at relayer level if needed
    gasPrice: z.coerce.number().int().positive().default(20),
    gasLimit: z.coerce.number().int().positive().default(300000),
    startBlock: z.coerce.number().int().nonnegative().default(0),
    minConfirmations: z.coerce.number().int().positive().default(6),
  }),
  stellar: z.object({
    network: z.string().default('testnet'),
    horizonUrl: z.string().url(),
    networkPassphrase: z.string(),
    secretKey: z.string().default(''),
    publicKey: z.string().default(''),
    startLedger: z.coerce.number().int().nonnegative().default(0),
    minConfirmations: z.coerce.number().int().positive().default(1),
  }),
  solana: z.object({
    rpcUrl: z.string().url().default('https://api.devnet.solana.com'),
    privateKey: z.string().default(''),
    programId: z.string().default('PLACEHOLDER'),
    commitment: z.enum(['processed', 'confirmed', 'finalized']).default('confirmed'),
  }),
  fees: z.object({
    feeRate: z.coerce.number().int().nonnegative().default(50),
    minSwapAmountUSD: z.coerce.number().nonnegative().default(10),
    maxSwapAmountUSD: z.coerce.number().nonnegative().default(100000),
    maxOrderAmount: z.coerce.number().nonnegative().default(1000000),
  }),
  security: z.object({
    minTimelockDuration: z.coerce.number().int().nonnegative().default(3600),
    maxTimelockDuration: z.coerce.number().int().nonnegative().default(604800),
    defaultTimelockDuration: z.coerce.number().int().nonnegative().default(86400),
    emergencyShutdown: z.coerce.boolean().default(false),
    maintenanceMode: z.coerce.boolean().default(false),
  }),
  monitoring: z.object({
    logLevel: logLevelSchema,
    enableRequestLogging: z.coerce.boolean().default(false),
    verboseLogging: z.coerce.boolean().default(false),
    healthCheckInterval: z.coerce.number().int().positive().default(30000),
    healthCheckTimeout: z.coerce.number().int().positive().default(5000),
  }),
});

export type RelayerConfig = z.infer<typeof relayerConfigSchema>;

// Resolver Configuration Schema
export const resolverConfigSchema = z.object({
  network: networkModeSchema,
  pollIntervalMs: z.coerce.number().int().positive().default(15000),
  coordinatorUrl: z.string().url().default('http://localhost:3001'),
  logLevel: logLevelSchema,
  featureFlags: featureFlagsSchema.default({}),
  ethereum: z.object({
    rpcUrl: z.string().url(),
    chainId: z.number().int(),
    htlcEscrow: optionalEvmAddressSchema,
    resolverRegistry: optionalEvmAddressSchema,
    resolverPrivateKey: z
      .string()
      .optional()
      .or(z.literal(''))
      .transform(v => (v && v.trim().length > 0 ? v.trim() : null))
      .refine(v => v === null || /^0x[0-9a-fA-F]{64}$/.test(v), {
        message: 'must be a 0x-prefixed 32-byte hex private key',
      })
      .transform(v => v as `0x${string}` | null),
  }),
  soroban: z.object({
    rpcUrl: z.string().url(),
    horizonUrl: z.string().url(),
    networkPassphrase: z.string(),
    htlc: z
      .string()
      .optional()
      .transform(v => v ?? null),
    resolverRegistry: z
      .string()
      .optional()
      .transform(v => v ?? null),
    resolverSecret: z
      .string()
      .optional()
      .or(z.literal(''))
      .transform(v => (v && v.trim().length > 0 ? v.trim() : null))
      .refine(v => v === null || StrKey.isValidEd25519SecretSeed(v), {
        message: "must be a valid Stellar Ed25519 secret seed (expected an 'S...' StrKey)",
      })
      .transform(v => v as string | null),
  }),
  rpc: z
    .object({
      maxRetries: z.coerce.number().int().nonnegative().default(3),
      baseDelayMs: z.coerce.number().int().nonnegative().default(100),
      maxDelayMs: z.coerce.number().int().nonnegative().default(2000),
    })
    .default({}),
});

export type ResolverConfig = z.infer<typeof resolverConfigSchema>;

// Frontend Configuration Schema (Vite browser)
export const frontendConfigSchema = z.object({
  network: networkModeSchema,
  mainnetEnabled: z.coerce.boolean().default(false),
  sepoliaRpcUrl: z.string().optional(),
  mainnetRpcUrl: z.string().optional(),
  infuraApiKey: z.string().optional(),
  oneinchApiKey: z.string().optional(),
  apiBaseUrl: z.string().url().default('http://localhost:3001'),
  featureFlags: z
    .object({
      solanaSimulationMode: z.coerce.boolean().default(false),
      sorobanEarlySupport: z.coerce.boolean().default(false),
      experimentalUiRoutes: z.coerce.boolean().default(false),
    })
    .default({}),
});

export type FrontendConfig = z.infer<typeof frontendConfigSchema>;

// ---------------------------------------------------------------------------
// Configuration metadata
// ---------------------------------------------------------------------------

export type ConfigConsumer = 'coordinator' | 'relayer' | 'resolver' | 'frontend';

export interface ConfigKeyMetadata {
  /** Dotted path of the key, e.g. `ethereum.rpcUrl`. */
  key: string;
  /** Human readable description of what the value controls. */
  description: string;
  /** Whether the value must be supplied by the operator. */
  required: boolean;
  /** Default value, or `null` when the schema provides no default. */
  default: string | number | boolean | null;
  /** Whether the value carries secret material and must be redacted. */
  secret: boolean;
  /** Services that consume this key. */
  consumers: ConfigConsumer[];
}

export interface ConfigSchemaMetadata {
  name: string;
  consumers: ConfigConsumer[];
  keys: ConfigKeyMetadata[];
}

const meta = (
  key: string,
  description: string,
  required: boolean,
  defaultValue: string | number | boolean | null,
  secret: boolean,
  consumers: ConfigConsumer[]
): ConfigKeyMetadata => ({ key, description, required, default: defaultValue, secret, consumers });

const sharedFeatureFlagKeys = (consumers: ConfigConsumer[]): ConfigKeyMetadata[] => [
  meta('featureFlags.solanaSimulationMode', 'Enable Solana simulation mode.', false, false, false, consumers),
  meta('featureFlags.sorobanEarlySupport', 'Enable early Soroban support.', false, false, false, consumers),
  meta('featureFlags.experimentalUiRoutes', 'Enable experimental UI routes.', false, false, false, consumers),
];

export const coordinatorConfigMetadata: ConfigSchemaMetadata = {
  name: 'coordinator',
  consumers: ['coordinator'],
  keys: [
    meta('network', 'Network mode the coordinator operates against.', false, 'testnet', false, ['coordinator']),
    meta('port', 'HTTP port the coordinator binds.', false, 3001, false, ['coordinator']),
    meta('databaseUrl', 'Database connection string.', false, 'file:./wafflefinance.db', false, ['coordinator']),
    meta('logLevel', 'Log verbosity.', false, 'info', false, ['coordinator']),
    meta('corsOrigin', 'Allowed CORS origin.', false, '*', false, ['coordinator']),
    meta('pollIntervalMs', 'Polling interval in milliseconds.', false, 15000, false, ['coordinator']),
    meta('secretStorageKey', 'Key used to encrypt stored secrets.', false, null, true, ['coordinator']),
    meta('apiKeys', 'Comma separated API keys.', false, '', true, ['coordinator']),
    meta('trustedProxies', 'Comma separated trusted proxy addresses.', false, '', false, ['coordinator']),
    ...sharedFeatureFlagKeys(['coordinator']),
    meta('ethereum.rpcUrl', 'Ethereum JSON-RPC endpoint.', true, null, false, ['coordinator']),
    meta('ethereum.chainId', 'Ethereum chain ID.', true, null, false, ['coordinator']),
    meta('ethereum.htlcEscrow', 'HTLC escrow contract address.', false, null, false, ['coordinator']),
    meta('ethereum.resolverRegistry', 'Resolver registry contract address.', false, null, false, ['coordinator']),
    meta('soroban.rpcUrl', 'Soroban RPC endpoint.', true, null, false, ['coordinator']),
    meta('soroban.horizonUrl', 'Stellar Horizon endpoint.', true, null, false, ['coordinator']),
    meta('soroban.networkPassphrase', 'Stellar network passphrase.', true, null, false, ['coordinator']),
    meta('soroban.htlcContract', 'Soroban HTLC contract ID.', false, null, false, ['coordinator']),
    meta('soroban.resolverRegistry', 'Soroban resolver registry contract ID.', false, null, false, ['coordinator']),
    meta('solana.rpcUrl', 'Solana RPC endpoint.', true, null, false, ['coordinator']),
    meta('solana.programId', 'Solana program ID.', false, 'PLACEHOLDER', false, ['coordinator']),
    meta('solana.commitment', 'Solana commitment level.', false, 'confirmed', false, ['coordinator']),
  ],
};

export const relayerConfigMetadata: ConfigSchemaMetadata = {
  name: 'relayer',
  consumers: ['relayer'],
  keys: [
    meta('network', 'Network mode the relayer operates against.', false, 'testnet', false, ['relayer']),
    meta('port', 'HTTP port the relayer binds.', false, 3001, false, ['relayer']),
    meta('pollInterval', 'Polling interval in milliseconds.', false, 15000, false, ['relayer']),
    meta('activePollIntervalMs', 'Polling interval while active.', false, 15000, false, ['relayer']),
    meta('idlePollIntervalMs', 'Polling interval while idle.', false, 120000, false, ['relayer']),
    meta('visitorTtlMs', 'Visitor cache TTL in milliseconds.', false, 300000, false, ['relayer']),
    meta('retryAttempts', 'Number of retry attempts.', false, 3, false, ['relayer']),
    meta('retryDelay', 'Delay between retries in milliseconds.', false, 2000, false, ['relayer']),
    meta('nodeEnv', 'Node environment name.', false, 'development', false, ['relayer']),
    meta('enableMockMode', 'Enable mock mode.', false, false, false, ['relayer']),
    meta('debug', 'Enable debug logging.', false, false, false, ['relayer']),
    ...sharedFeatureFlagKeys(['relayer']),
    meta('resolverAllowlist', 'Comma separated resolver allowlist.', false, null, false, ['relayer']),
    meta('rpcTimeoutMs', 'RPC timeout in milliseconds.', false, 30000, false, ['relayer']),
    meta('ethereum.network', 'Ethereum network name.', false, 'mainnet', false, ['relayer']),
    meta('ethereum.rpcUrl', 'Ethereum JSON-RPC endpoint.', true, null, false, ['relayer']),
    meta('ethereum.fusionApiUrl', '1inch Fusion API endpoint.', false, 'https://api.1inch.dev/fusion', false, ['relayer']),
    meta('ethereum.fusionApiKey', '1inch Fusion API key.', false, '', true, ['relayer']),
    meta('ethereum.privateKey', 'Ethereum signing private key.', false, '', true, ['relayer']),
    meta('ethereum.gasPrice', 'Gas price in gwei.', false, 20, false, ['relayer']),
    meta('ethereum.gasLimit', 'Gas limit per transaction.', false, 300000, false, ['relayer']),
    meta('ethereum.startBlock', 'First block to scan.', false, 0, false, ['relayer']),
    meta('ethereum.minConfirmations', 'Minimum confirmations.', false, 6, false, ['relayer']),
    meta('stellar.network', 'Stellar network name.', false, 'testnet', false, ['relayer']),
    meta('stellar.horizonUrl', 'Stellar Horizon endpoint.', true, null, false, ['relayer']),
    meta('stellar.networkPassphrase', 'Stellar network passphrase.', true, null, false, ['relayer']),
    meta('stellar.secretKey', 'Stellar signing secret key.', false, '', true, ['relayer']),
    meta('stellar.publicKey', 'Stellar public key.', false, '', false, ['relayer']),
    meta('stellar.startLedger', 'First ledger to scan.', false, 0, false, ['relayer']),
    meta('stellar.minConfirmations', 'Minimum ledger confirmations.', false, 1, false, ['relayer']),
    meta('solana.rpcUrl', 'Solana RPC endpoint.', false, 'https://api.devnet.solana.com', false, ['relayer']),
    meta('solana.privateKey', 'Solana signing private key.', false, '', true, ['relayer']),
    meta('solana.programId', 'Solana program ID.', false, 'PLACEHOLDER', false, ['relayer']),
    meta('solana.commitment', 'Solana commitment level.', false, 'confirmed', false, ['relayer']),
    meta('fees.feeRate', 'Fee rate in basis points.', false, 50, false, ['relayer']),
    meta('fees.minSwapAmountUSD', 'Minimum swap amount in USD.', false, 10, false, ['relayer']),
    meta('fees.maxSwapAmountUSD', 'Maximum swap amount in USD.', false, 100000, false, ['relayer']),
    meta('fees.maxOrderAmount', 'Maximum order amount.', false, 1000000, false, ['relayer']),
    meta('security.minTimelockDuration', 'Minimum timelock duration in seconds.', false, 3600, false, ['relayer']),
    meta('security.maxTimelockDuration', 'Maximum timelock duration in seconds.', false, 604800, false, ['relayer']),
    meta('security.defaultTimelockDuration', 'Default timelock duration in seconds.', false, 86400, false, ['relayer']),
    meta('security.emergencyShutdown', 'Enable emergency shutdown.', false, false, false, ['relayer']),
    meta('security.maintenanceMode', 'Enable maintenance mode.', false, false, false, ['relayer']),
    meta('monitoring.logLevel', 'Log verbosity.', false, 'info', false, ['relayer']),
    meta('monitoring.enableRequestLogging', 'Log incoming requests.', false, false, false, ['relayer']),
    meta('monitoring.verboseLogging', 'Enable verbose logging.', false, false, false, ['relayer']),
    meta('monitoring.healthCheckInterval', 'Health check interval in milliseconds.', false, 30000, false, ['relayer']),
    meta('monitoring.healthCheckTimeout', 'Health check timeout in milliseconds.', false, 5000, false, ['relayer']),
  ],
};

export const resolverConfigMetadata: ConfigSchemaMetadata = {
  name: 'resolver',
  consumers: ['resolver'],
  keys: [
    meta('network', 'Network mode the resolver operates against.', false, 'testnet', false, ['resolver']),
    meta('pollIntervalMs', 'Polling interval in milliseconds.', false, 15000, false, ['resolver']),
    meta('coordinatorUrl', 'Coordinator base URL.', false, 'http://localhost:3001', false, ['resolver']),
    meta('logLevel', 'Log verbosity.', false, 'info', false, ['resolver']),
    ...sharedFeatureFlagKeys(['resolver']),
    meta('ethereum.rpcUrl', 'Ethereum JSON-RPC endpoint.', true, null, false, ['resolver']),
    meta('ethereum.chainId', 'Ethereum chain ID.', true, null, false, ['resolver']),
    meta('ethereum.htlcEscrow', 'HTLC escrow contract address.', false, null, false, ['resolver']),
    meta('ethereum.resolverRegistry', 'Resolver registry contract address.', false, null, false, ['resolver']),
    meta('ethereum.resolverPrivateKey', 'Ethereum resolver private key.', false, null, true, ['resolver']),
    meta('soroban.rpcUrl', 'Soroban RPC endpoint.', true, null, false, ['resolver']),
    meta('soroban.horizonUrl', 'Stellar Horizon endpoint.', true, null, false, ['resolver']),
    meta('soroban.networkPassphrase', 'Stellar network passphrase.', true, null, false, ['resolver']),
    meta('soroban.htlc', 'Soroban HTLC contract ID.', false, null, false, ['resolver']),
    meta('soroban.resolverRegistry', 'Soroban resolver registry contract ID.', false, null, false, ['resolver']),
    meta('soroban.resolverSecret', 'Stellar resolver secret seed.', false, null, true, ['resolver']),
    meta('rpc.maxRetries', 'Maximum RPC retries.', false, 3, false, ['resolver']),
    meta('rpc.baseDelayMs', 'Base retry delay in milliseconds.', false, 100, false, ['resolver']),
    meta('rpc.maxDelayMs', 'Maximum retry delay in milliseconds.', false, 2000, false, ['resolver']),
  ],
};

export const frontendConfigMetadata: ConfigSchemaMetadata = {
  name: 'frontend',
  consumers: ['frontend'],
  keys: [
    meta('network', 'Network mode the frontend targets.', false, 'testnet', false, ['frontend']),
    meta('mainnetEnabled', 'Enable mainnet in the UI.', false, false, false, ['frontend']),
    meta('sepoliaRpcUrl', 'Sepolia RPC endpoint.', false, null, false, ['frontend']),
    meta('mainnetRpcUrl', 'Mainnet RPC endpoint.', false, null, false, ['frontend']),
    meta('infuraApiKey', 'Infura API key.', false, null, true, ['frontend']),
    meta('oneinchApiKey', '1inch API key.', false, null, true, ['frontend']),
    meta('apiBaseUrl', 'Coordinator API base URL.', false, 'http://localhost:3001', false, ['frontend']),
    ...sharedFeatureFlagKeys(['frontend']),
  ],
};

/**
 * Deterministic registry of every documented configuration key, grouped by
 * schema. Generators should iterate this in declaration order.
 */
export const configMetadata: ConfigSchemaMetadata[] = [
  coordinatorConfigMetadata,
  relayerConfigMetadata,
  resolverConfigMetadata,
  frontendConfigMetadata,
];

// ---------------------------------------------------------------------------
// Cross-field validation
// ---------------------------------------------------------------------------

export interface ConfigValidationIssue {
  /** Dotted path of the offending field. */
  field: string;
  /** Stable machine readable code. */
  code: string;
  /** Actionable, secret-free explanation. */
  message: string;
}

export interface ConfigValidationResult {
  ok: boolean;
  issues: ConfigValidationIssue[];
}

/** Chain IDs considered valid for each network mode. */
export const NETWORK_CHAIN_IDS: Record<NetworkMode, readonly number[]> = {
  testnet: [11155111, 84532, 421614, 11155420],
  mainnet: [1, 8453, 42161, 10],
};

const REDACTED = '[REDACTED]';

const isSecretKeyPath = (path: string): boolean => {
  const lower = path.toLowerCase();
  return (
    lower.includes('privatekey') ||
    lower.includes('secret') ||
    lower.includes('apikey') ||
    lower.includes('storagekey')
  );
};

const redactMessage = (message: string, value: unknown): string => {
  if (typeof value !== 'string' || value.length === 0) return message;
  return message.split(value).join(REDACTED);
};

const getPath = (source: unknown, path: string): unknown => {
  return path.split('.').reduce<unknown>((acc, part) => {
    if (acc && typeof acc === 'object' && part in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[part];
    }
    return undefined;
  }, source);
};

const isPresent = (value: unknown): boolean =>
  value !== undefined && value !== null && !(typeof value === 'string' && value.trim().length === 0);

export interface CrossFieldValidationOptions {
  /** Consumers whose metadata should be used to drive required-field checks. */
  consumers: ConfigConsumer[];
  /** When true, contract addresses required for the selected network are enforced. */
  requireContracts?: boolean;
}

/**
 * Validate cross-field constraints shared by coordinator, relayer and resolver.
 * Returns a structured, secret-redacted list of issues. Never throws.
 */
export const validateCrossFieldConfig = (
  config: unknown,
  options: CrossFieldValidationOptions
): ConfigValidationResult => {
  const issues: ConfigValidationIssue[] = [];
  const add = (field: string, code: string, message: string, value?: unknown) => {
    issues.push({ field, code, message: redactMessage(message, value) });
  };

  const network = getPath(config, 'network');
  const networkMode: NetworkMode = network === 'mainnet' ? 'mainnet' : 'testnet';

  // Required keys per consumer metadata.
  for (const schema of configMetadata) {
    if (!schema.consumers.some(c => options.consumers.includes(c))) continue;
    for (const key of schema.keys) {
      if (!key.required) continue;
      const value = getPath(config, key.key);
      if (!isPresent(value)) {
        add(key.key, 'REQUIRED', `Missing required configuration value for ${key.key}.`);
      }
    }
  }

  // Network mode vs chain ID.
  const chainId = getPath(config, 'ethereum.chainId');
  if (typeof chainId === 'number' && Number.isFinite(chainId)) {
    const allowed = NETWORK_CHAIN_IDS[networkMode];
    if (!allowed.includes(chainId)) {
      add(
        'ethereum.chainId',
        'CHAIN_ID_NETWORK_MISMATCH',
        `Chain ID ${chainId} is not valid for network mode "${networkMode}". Expected one of: ${allowed.join(', ')}.`
      );
    }
  }

  // Contract addresses required per network.
  if (options.requireContracts) {
    const contractFields = ['ethereum.htlcEscrow', 'ethereum.resolverRegistry'];
    for (const field of contractFields) {
      const value = getPath(config, field);
      if (!isPresent(value)) {
        add(field, 'CONTRACT_ADDRESS_REQUIRED', `Contract address ${field} is required for network mode "${networkMode}".`);
      }
    }
  }

  // Secret format checks (values are never echoed).
  const secretChecks: Array<{ field: string; check: (v: string) => boolean; hint: string }> = [
    {
      field: 'ethereum.privateKey',
      check: v => /^0x[0-9a-fA-F]{64}$/.test(v),
      hint: 'must be a 0x-prefixed 32-byte hex private key',
    },
    {
      field: 'ethereum.resolverPrivateKey',
      check: v => /^0x[0-9a-fA-F]{64}$/.test(v),
      hint: 'must be a 0x-prefixed 32-byte hex private key',
    },
    {
      field: 'stellar.secretKey',
      check: v => StrKey.isValidEd25519SecretSeed(v),
      hint: "must be a valid Stellar Ed25519 secret seed (expected an 'S...' StrKey)",
    },
    {
      field: 'soroban.resolverSecret',
      check: v => StrKey.isValidEd25519SecretSeed(v),
      hint: "must be a valid Stellar Ed25519 secret seed (expected an 'S...' StrKey)",
    },
  ];

  for (const { field, check, hint } of secretChecks) {
    const value = getPath(config, field);
    if (typeof value === 'string' && value.trim().length > 0 && !check(value.trim())) {
      add(field, 'SECRET_FORMAT', `Secret value for ${field} ${hint}.`, value);
    }
  }

  return { ok: issues.length === 0, issues };
};

/**
 * Throw a single aggregated error when cross-field validation fails. The error
 * message lists field names and reasons only; secret values are redacted.
 */
export const assertValidCrossFieldConfig = (
  config: unknown,
  options: CrossFieldValidationOptions
): void => {
  const result = validateCrossFieldConfig(config, options);
  if (result.ok) return;
  const details = result.issues.map(i => `${i.field}: ${i.message}`).join('; ');
  const error = new Error(`Invalid configuration: ${details}`);
  (error as Error & { issues?: ConfigValidationIssue[] }).issues = result.issues;
  throw error;
};

export { isSecretKeyPath };
