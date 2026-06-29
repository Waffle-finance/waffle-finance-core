import { z } from "zod";
import { privateKeyToAccount } from "viem/accounts";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { resolveEthereumRpcUrl } from "./ethereum-rpc-url.js";

// Common Schemas
export const networkModeSchema = z.enum(["testnet", "mainnet"]).default("testnet");
export type NetworkMode = z.infer<typeof networkModeSchema>;

export const logLevelSchema = z
  .enum(["trace", "debug", "info", "warn", "error"])
  .default("info");

export const ethereumPrivateKeySchema = z
  .string()
  .refine((val) => /^0x[0-9a-fA-F]{64}$/.test(val), {
    message: "must be a 0x-prefixed 32-byte hex private key"
  })
  .refine((val) => {
    try {
      privateKeyToAccount(val as `0x${string}`);
      return true;
    } catch {
      return false;
    }
  }, {
    message: "must be a usable secp256k1 private key"
  })
  .transform(v => v as `0x${string}`);

export const stellarSecretSchema = z
  .string()
  .refine((val) => StrKey.isValidEd25519SecretSeed(val), {
    message: "must be a valid Stellar Ed25519 secret seed (expected an 'S...' StrKey)"
  })
  .refine((val) => {
    try {
      Keypair.fromSecret(val);
      return true;
    } catch {
      return false;
    }
  }, {
    message: "could not be parsed into a Stellar keypair"
  });

export const evmAddressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, { message: "must be a 0x-prefixed 20-byte address" })
  .transform((v) => v as `0x${string}`);

export const optionalEvmAddressSchema = z
  .string()
  .optional()
  .or(z.literal(""))
  .transform((v) => (v && v.trim().length > 0 ? v.trim() : null))
  .refine((v) => v === null || /^0x[0-9a-fA-F]{40}$/.test(v), {
    message: "must be a 0x-prefixed 20-byte address"
  })
  .transform((v) => (v ? (v as `0x${string}`) : null));

// Coordinator Configuration Schema
export const coordinatorConfigSchema = z.object({
  network: networkModeSchema,
  port: z.coerce.number().int().positive().default(3001),
  databaseUrl: z.string().default("file:./wafflefinance.db"),
  logLevel: logLevelSchema,
  corsOrigin: z.string().default("*"),
  pollIntervalMs: z.coerce.number().int().positive().default(15000),
  secretStorageKey: z
    .string()
    .optional()
    .transform((v) => (v && v.trim().length > 0 ? v.trim() : undefined)),
  apiKeys: z.string().default(""),
  trustedProxies: z.string().default(""),
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
    htlcContract: z.string().optional().transform((v) => v ?? null),
    resolverRegistry: z.string().optional().transform((v) => v ?? null),
  }),
  solana: z.object({
    rpcUrl: z.string().url(),
    programId: z.string().optional().transform((v) => v ?? "PLACEHOLDER"),
    commitment: z.enum(["processed", "confirmed", "finalized"]).default("confirmed"),
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
  nodeEnv: z.string().default("development"),
  enableMockMode: z.coerce.boolean().default(false),
  debug: z.coerce.boolean().default(false),
  resolverAllowlist: z
    .string()
    .optional()
    .transform((v) => {
      if (!v) return [];
      return v.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
    }),
  rpcTimeoutMs: z.coerce.number().int().positive().default(30000),
  ethereum: z.object({
    network: z.string().default("mainnet"),
    rpcUrl: z.string().url(),
    fusionApiUrl: z.string().url().default("https://api.1inch.dev/fusion"),
    fusionApiKey: z.string().default(""),
    privateKey: z.string().default(""), // Loaded raw, validated separately at relayer level if needed
    gasPrice: z.coerce.number().int().positive().default(20),
    gasLimit: z.coerce.number().int().positive().default(300000),
    startBlock: z.coerce.number().int().nonnegative().default(0),
    minConfirmations: z.coerce.number().int().positive().default(6),
  }),
  stellar: z.object({
    network: z.string().default("testnet"),
    horizonUrl: z.string().url(),
    networkPassphrase: z.string(),
    secretKey: z.string().default(""),
    publicKey: z.string().default(""),
    startLedger: z.coerce.number().int().nonnegative().default(0),
    minConfirmations: z.coerce.number().int().positive().default(1),
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
  coordinatorUrl: z.string().url().default("http://localhost:3001"),
  logLevel: logLevelSchema,
  ethereum: z.object({
    rpcUrl: z.string().url(),
    chainId: z.number().int(),
    htlcEscrow: optionalEvmAddressSchema,
    resolverRegistry: optionalEvmAddressSchema,
    resolverPrivateKey: z
      .string()
      .optional()
      .or(z.literal(""))
      .transform((v) => (v && v.trim().length > 0 ? v.trim() : null))
      .refine((v) => v === null || /^0x[0-9a-fA-F]{64}$/.test(v), {
        message: "must be a 0x-prefixed 32-byte hex private key"
      })
      .transform((v) => v as `0x${string}` | null),
  }),
  soroban: z.object({
    rpcUrl: z.string().url(),
    horizonUrl: z.string().url(),
    networkPassphrase: z.string(),
    htlc: z.string().optional().transform((v) => v ?? null),
    resolverRegistry: z.string().optional().transform((v) => v ?? null),
    resolverSecret: z
      .string()
      .optional()
      .or(z.literal(""))
      .transform((v) => (v && v.trim().length > 0 ? v.trim() : null))
      .refine((v) => v === null || StrKey.isValidEd25519SecretSeed(v), {
        message: "must be a valid Stellar Ed25519 secret seed (expected an 'S...' StrKey)"
      })
      .transform((v) => v as string | null),
  }),
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
  apiBaseUrl: z.string().url().default("http://localhost:3001"),
});

export type FrontendConfig = z.infer<typeof frontendConfigSchema>;
