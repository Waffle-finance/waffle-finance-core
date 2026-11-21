import { loadResolverConfig } from "@wafflefinance/config/node";
import {
  ZodError,
  validateResolverConfig,
  type ResolverConfig,
  type NetworkMode,
} from "@wafflefinance/config";
import { ConfigValidationError } from "./validation.js";

export type { ResolverConfig };
export type Network = NetworkMode;

export interface EthereumConfig {
  rpcUrl: string;
  chainId: number;
  htlcEscrow: `0x${string}` | null;
  resolverRegistry: `0x${string}` | null;
  resolverPrivateKey: `0x${string}` | null;
}

export interface SorobanConfig {
  rpcUrl: string;
  networkPassphrase: string;
  horizonUrl: string;
  htlc: string | null;
  resolverRegistry: string | null;
  resolverSecret: string | null;
}

export function loadConfig(): ResolverConfig {
  let config: ResolverConfig;
  try {
    config = loadResolverConfig();
  } catch (err) {
    if (err instanceof ZodError) {
      const issue = err.issues[0];
      const path = issue?.path.join(".");

      if (path === "network") {
        throw new ConfigValidationError(
          `NETWORK_MODE must be 'testnet' or 'mainnet', got: ${process.env.NETWORK_MODE}`,
        );
      }

      const fieldMsg = path ? `Field '${path}' ` : "";
      throw new ConfigValidationError(`${fieldMsg}${issue?.message}`);
    }
    throw err;
  }

  // Cross-field validation runs before any listener binds a port. Failures are
  // reported as a structured list of field names with actionable, redacted
  // reasons so secret values never leak into logs or error surfaces.
  const result = validateResolverConfig(config);
  if (!result.ok) {
    const details = result.errors
      .map((e) => `${e.field}: ${e.reason}`)
      .join("; ");
    throw new ConfigValidationError(
      `Invalid resolver configuration: ${details}`,
      result.errors,
    );
  }

  return config;
}