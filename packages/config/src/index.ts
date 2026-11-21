import {
  frontendConfigSchema,
  type FrontendConfig,
  type NetworkMode,
} from "./schema.js";

export { ZodError, z } from "zod";
export * from "./schema.js";
export * from "./ethereum-rpc-url.js";
export * from "./solana-placeholder.js";
export * from "./soroban-chain-config.js";
export * from "./support-policy.js";
export * from "./feature-flags.js";
export * from "./metadata.js";
export * from "./validation.js";

/**
 * Validates and loads frontend configuration.
 *
 * Designed to be called with Vite's `import.meta.env` (or similar browser environments).
 */
export function loadFrontendConfig(
  rawEnv: Record<string, any>
): FrontendConfig {
  const network = (rawEnv.VITE_NETWORK ?? rawEnv.VITE_NETWORK_MODE ?? "testnet") as NetworkMode;

  const mapped = {
    network,
    mainnetEnabled: rawEnv.VITE_MAINNET_ENABLED ?? false,
    sepoliaRpcUrl: rawEnv.VITE_SEPOLIA_RPC_URL,
    mainnetRpcUrl: rawEnv.VITE_MAINNET_RPC_URL,
    infuraApiKey: rawEnv.VITE_INFURA_API_KEY,
    oneinchApiKey: rawEnv.VITE_ONEINCH_API_KEY,
    apiBaseUrl: rawEnv.VITE_API_BASE_URL ?? "http://localhost:3001",
    featureFlags: {
      solanaSimulationMode: rawEnv.VITE_FEATURE_SOLANA_SIMULATION_MODE ?? false,
      sorobanEarlySupport: rawEnv.VITE_FEATURE_SOROBAN_EARLY_SUPPORT ?? false,
      experimentalUiRoutes: rawEnv.VITE_FEATURE_EXPERIMENTAL_UI_ROUTES ?? false,
    },
  };

  return frontendConfigSchema.parse(mapped);
}