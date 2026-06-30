import { z } from "zod";
import { optionalEvmAddressSchema, type NetworkMode } from "./schema.js";

const chainNetworkSchema = z.enum(["testnet", "mainnet"]);

const nullableStringSchema = z
  .string()
  .optional()
  .or(z.literal(""))
  .transform((v) => (v && v.trim().length > 0 ? v.trim() : null));

const requiredStringSchema = z
  .string()
  .transform((v) => v.trim())
  .refine((v) => v.length > 0, { message: "must not be empty" });

const optionalChainEvmAddressSchema = optionalEvmAddressSchema
  .or(z.null())
  .transform((v) => v ?? null);

export const chainSettingsSchema = z.object({
  network: chainNetworkSchema,
  ethereum: z.object({
    chainId: z.coerce.number().int().positive(),
    rpcUrl: z.string().url(),
    explorerUrl: z.string().url(),
    htlcEscrow: optionalChainEvmAddressSchema,
    resolverRegistry: optionalChainEvmAddressSchema,
    escrowFactory: optionalChainEvmAddressSchema,
    htlcBridge: optionalChainEvmAddressSchema,
  }),
  soroban: z.object({
    rpcUrl: z.string().url(),
    horizonUrl: z.string().url(),
    networkPassphrase: requiredStringSchema,
    htlcContract: nullableStringSchema,
    resolverRegistry: nullableStringSchema,
  }),
  solana: z.object({
    rpcUrl: z.string().url(),
    programId: nullableStringSchema,
    commitment: z.enum(["processed", "confirmed", "finalized"]).default("confirmed"),
  }),
  fees: z.object({
    feeRateBps: z.coerce.number().int().nonnegative().default(50),
    minSwapAmountUsd: z.coerce.number().nonnegative().default(10),
    maxSwapAmountUsd: z.coerce.number().nonnegative().default(100000),
    maxOrderAmount: z.coerce.number().nonnegative().default(1000000),
  }),
});

export type ChainSettings = z.infer<typeof chainSettingsSchema>;

const DEFAULT_CHAIN_SETTINGS: Record<NetworkMode, ChainSettings> = {
  testnet: {
    network: "testnet",
    ethereum: {
      chainId: 11_155_111,
      rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
      explorerUrl: "https://sepolia.etherscan.io",
      htlcEscrow: null,
      resolverRegistry: null,
      escrowFactory: "0x6c3818E074d891F1FBB3A75913e4BDe87BcF1123",
      htlcBridge: "0x3f344ACDd17a0c4D21096da895152820f595dc8A",
    },
    soroban: {
      rpcUrl: "https://soroban-testnet.stellar.org",
      horizonUrl: "https://horizon-testnet.stellar.org",
      networkPassphrase: "Test SDF Network ; September 2015",
      htlcContract: null,
      resolverRegistry: null,
    },
    solana: {
      rpcUrl: "https://api.devnet.solana.com",
      programId: null,
      commitment: "confirmed",
    },
    fees: {
      feeRateBps: 50,
      minSwapAmountUsd: 10,
      maxSwapAmountUsd: 100000,
      maxOrderAmount: 1000000,
    },
  },
  mainnet: {
    network: "mainnet",
    ethereum: {
      chainId: 1,
      rpcUrl: "https://ethereum-rpc.publicnode.com",
      explorerUrl: "https://etherscan.io",
      htlcEscrow: null,
      resolverRegistry: null,
      escrowFactory: "0xa7bcb4eac8964306f9e3764f67db6a7af6ddf99a",
      htlcBridge: "0x87372d4bba85acf7c2374b4719a1020e507ab73e",
    },
    soroban: {
      rpcUrl: "https://mainnet.sorobanrpc.com",
      horizonUrl: "https://horizon.stellar.org",
      networkPassphrase: "Public Global Stellar Network ; September 2015",
      htlcContract: null,
      resolverRegistry: null,
    },
    solana: {
      rpcUrl: "https://api.mainnet-beta.solana.com",
      programId: null,
      commitment: "confirmed",
    },
    fees: {
      feeRateBps: 50,
      minSwapAmountUsd: 10,
      maxSwapAmountUsd: 100000,
      maxOrderAmount: 1000000,
    },
  },
};

type Env = Record<string, string | undefined>;

function pick(env: Env, names: string[], fallback: string | null | undefined): string | null | undefined {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return fallback;
}

function networkSuffix(network: NetworkMode): "TESTNET" | "MAINNET" {
  return network === "mainnet" ? "MAINNET" : "TESTNET";
}

/**
 * Builds and validates the complete chain/runtime surface.
 *
 * Use `vite: true` for browser-safe Vite variables. Node services should use
 * the unprefixed variables so one `.env` can drive all backend processes.
 */
export function loadChainSettings(
  network: NetworkMode,
  env: Env,
  options: { vite?: boolean; ethereumRpcUrl?: string } = {}
): ChainSettings {
  const parsedNetwork = chainNetworkSchema.parse(network);
  const defaults = DEFAULT_CHAIN_SETTINGS[parsedNetwork];
  const suffix = networkSuffix(parsedNetwork);
  const vite = options.vite === true;
  const prefix = vite ? "VITE_" : "";
  const ethereumRpcNames = vite
    ? parsedNetwork === "mainnet"
      ? ["VITE_MAINNET_RPC_URL", "VITE_ETHEREUM_RPC_URL", "VITE_MAINNET_ETHEREUM_RPC_URL"]
      : ["VITE_SEPOLIA_RPC_URL", "VITE_ETHEREUM_RPC_URL", "VITE_TESTNET_ETHEREUM_RPC_URL"]
    : ["ETHEREUM_RPC_URL", `${suffix}_RPC_URL`];

  const mapped = {
    network: parsedNetwork,
    ethereum: {
      chainId: pick(env, [`${prefix}ETHEREUM_CHAIN_ID`, `${prefix}${suffix}_ETHEREUM_CHAIN_ID`], String(defaults.ethereum.chainId)),
      rpcUrl: options.ethereumRpcUrl ?? pick(env, ethereumRpcNames, defaults.ethereum.rpcUrl),
      explorerUrl: pick(env, [`${prefix}ETHEREUM_EXPLORER_URL`, `${prefix}${suffix}_ETHEREUM_EXPLORER_URL`], defaults.ethereum.explorerUrl),
      htlcEscrow: pick(env, [`${prefix}ETH_HTLC_ESCROW_${suffix}`], defaults.ethereum.htlcEscrow ?? ""),
      resolverRegistry: pick(env, [`${prefix}ETH_RESOLVER_REGISTRY_${suffix}`], defaults.ethereum.resolverRegistry ?? ""),
      escrowFactory: pick(env, [`${prefix}ETH_ESCROW_FACTORY_${suffix}`, `${prefix}ONEINCH_ESCROW_FACTORY_${suffix}`], defaults.ethereum.escrowFactory ?? ""),
      htlcBridge: pick(env, [`${prefix}ETH_HTLC_BRIDGE_${suffix}`], defaults.ethereum.htlcBridge ?? ""),
    },
    soroban: {
      rpcUrl: pick(env, [`${prefix}SOROBAN_RPC_URL`, `${prefix}SOROBAN_RPC_URL_${suffix}`], defaults.soroban.rpcUrl),
      horizonUrl: pick(env, [`${prefix}STELLAR_HORIZON_URL`, `${prefix}STELLAR_HORIZON_URL_${suffix}`], defaults.soroban.horizonUrl),
      networkPassphrase: pick(env, [`${prefix}STELLAR_NETWORK_PASSPHRASE`, `${prefix}STELLAR_NETWORK_PASSPHRASE_${suffix}`], defaults.soroban.networkPassphrase),
      htlcContract: pick(env, [`${prefix}SOROBAN_HTLC_${suffix}`], defaults.soroban.htlcContract ?? ""),
      resolverRegistry: pick(env, [`${prefix}SOROBAN_RESOLVER_REGISTRY_${suffix}`], defaults.soroban.resolverRegistry ?? ""),
    },
    solana: {
      rpcUrl: pick(env, [`${prefix}SOLANA_RPC_URL`, `${prefix}SOLANA_RPC_URL_${suffix}`], defaults.solana.rpcUrl),
      programId: pick(env, [`${prefix}SOLANA_HTLC_PROGRAM_${suffix}`, `${prefix}SOLANA_HTLC_PROGRAM`], defaults.solana.programId ?? ""),
      commitment: pick(env, [`${prefix}SOLANA_COMMITMENT`], defaults.solana.commitment),
    },
    fees: {
      feeRateBps: pick(env, [`${prefix}RELAYER_FEE_RATE`, `${prefix}FEE_RATE_BPS`], String(defaults.fees.feeRateBps)),
      minSwapAmountUsd: pick(env, [`${prefix}MIN_SWAP_AMOUNT_USD`], String(defaults.fees.minSwapAmountUsd)),
      maxSwapAmountUsd: pick(env, [`${prefix}MAX_SWAP_AMOUNT_USD`], String(defaults.fees.maxSwapAmountUsd)),
      maxOrderAmount: pick(env, [`${prefix}MAX_ORDER_AMOUNT`], String(defaults.fees.maxOrderAmount)),
    },
  };

  return chainSettingsSchema.parse(mapped);
}
