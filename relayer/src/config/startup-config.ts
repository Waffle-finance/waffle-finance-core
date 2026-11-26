/**
 * @fileoverview Startup configuration for the relayer entry point.
 *
 * Pure functions that turn the parsed relayer config and the process
 * environment into the values `relayer/src/index.ts` needs at boot:
 *   - default network mode and the contract addresses derived from it
 *   - the runtime config object that is handed to routers and services
 *   - the environment-validation input (built once, used for every gate)
 *   - the startup dependency retry options (coordinator / resolver registry)
 *   - the refund watchdog settings (network, Horizon URL, signing secret)
 *
 * Nothing in this module reads `process.env` or starts a side effect, so each
 * function can be exercised directly with a plain object. The entry point
 * passes `process.env` in explicitly.
 */

import type { RelayerConfig } from '@wafflefinance/config';
import {
  NETWORK_CONFIG,
  getEscrowFactoryAddress,
  getHtlcBridgeAddress,
  getNetworkConfig,
  type NetworkMode,
} from './networks.js';

/** Environment-style key/value map. Matches `process.env`. */
export type StartupEnv = Record<string, string | undefined>;

/** The default network used when the configuration does not name one. */
export const DEFAULT_RELAYER_NETWORK: NetworkMode = 'testnet';

// ---------------------------------------------------------------------------
// Network selection
// ---------------------------------------------------------------------------

/**
 * Resolve the default network mode from the parsed config value.
 *
 * - `undefined` or `null` falls back to `testnet`.
 * - `testnet` and `mainnet` are returned unchanged.
 * - Any other value throws the same "Unknown network mode" error that
 *   `getNetworkConfig` raises, so an invalid value still stops the boot.
 */
export function resolveDefaultNetworkMode(configured: string | null | undefined): NetworkMode {
  if (configured === undefined || configured === null) {
    return DEFAULT_RELAYER_NETWORK;
  }
  // Throws for unknown values; keeps the error text identical to other callers.
  getNetworkConfig(configured);
  return configured as NetworkMode;
}

/** Contract addresses the relayer uses for a given network mode. */
export interface RelayerContractAddresses {
  htlcBridgeAddress: string;
  escrowFactoryAddress: string;
}

/** Resolve the HTLC bridge and EscrowFactory addresses for a network mode. */
export function resolveRelayerContractAddresses(mode: NetworkMode): RelayerContractAddresses {
  return {
    htlcBridgeAddress: getHtlcBridgeAddress(mode, mode),
    escrowFactoryAddress: getEscrowFactoryAddress(mode, mode),
  };
}

// ---------------------------------------------------------------------------
// Runtime config
// ---------------------------------------------------------------------------

/** Parsed relayer config with the network-derived Ethereum addresses attached. */
export type RelayerRuntimeConfig = Omit<RelayerConfig, 'ethereum'> & {
  ethereum: RelayerConfig['ethereum'] & {
    /** HTLC bridge address for the default network (read by listeners and admin routes). */
    contractAddress: string;
    escrowFactoryAddress: string;
  };
};

/** Result of building the runtime config: the resolved mode plus the config. */
export interface RelayerStartupConfig {
  defaultNetworkMode: NetworkMode;
  runtimeConfig: RelayerRuntimeConfig;
}

/**
 * Build the runtime config used by the relayer.
 *
 * The parsed config is not mutated. The Ethereum section gains
 * `contractAddress` (HTLC bridge) and `escrowFactoryAddress`, both taken from
 * the resolved default network.
 */
export function buildRelayerStartupConfig(parsed: RelayerConfig): RelayerStartupConfig {
  const defaultNetworkMode = resolveDefaultNetworkMode(parsed.network);
  const addresses = resolveRelayerContractAddresses(defaultNetworkMode);
  const runtimeConfig: RelayerRuntimeConfig = {
    ...parsed,
    ethereum: {
      ...parsed.ethereum,
      contractAddress: addresses.htlcBridgeAddress,
      escrowFactoryAddress: addresses.escrowFactoryAddress,
    },
  };
  return { defaultNetworkMode, runtimeConfig };
}

// ---------------------------------------------------------------------------
// Environment validation input
// ---------------------------------------------------------------------------

/**
 * Build the input for `validateEnvironment`. The startup gate and the
 * re-validation before listeners start must use the same input, so both call
 * this function.
 */
export function buildEnvironmentValidationInput(
  env: StartupEnv,
  config: RelayerRuntimeConfig,
  defaultNetworkMode: NetworkMode,
): Record<string, string | undefined> {
  return {
    ...env,
    NETWORK: defaultNetworkMode,
    ETHEREUM_NETWORK: config.ethereum.network,
    STELLAR_NETWORK: config.stellar.network,
    ETHEREUM_CONTRACT_ADDRESS: config.ethereum.contractAddress,
    ESCROW_FACTORY_ADDRESS: config.ethereum.escrowFactoryAddress,
    ETHEREUM_PRIVATE_KEY: config.ethereum.privateKey,
    STELLAR_SECRET_KEY: config.stellar.secretKey,
  };
}

// ---------------------------------------------------------------------------
// Startup dependency retry options
// ---------------------------------------------------------------------------

/** Options passed to `assertStartupDependencies`. */
export interface StartupDependencyOptions {
  coordinatorUrl: string | undefined;
  resolverRegistryUrl: string | undefined;
  maxRetries: number | undefined;
  backoffBaseMs: number | undefined;
  backoffMaxMs: number | undefined;
}

/**
 * Read the startup dependency options from the environment.
 *
 * An unset or empty variable yields `undefined`, which lets the health check
 * use its own defaults. A set value is parsed with `parseInt`, the same as the
 * original entry point.
 */
export function resolveStartupDependencyOptions(env: StartupEnv): StartupDependencyOptions {
  return {
    coordinatorUrl: env.COORDINATOR_URL,
    resolverRegistryUrl: env.RESOLVER_REGISTRY_URL,
    maxRetries: parseOptionalInt(env.RELAYER_STARTUP_MAX_RETRIES),
    backoffBaseMs: parseOptionalInt(env.RELAYER_STARTUP_BACKOFF_BASE_MS),
    backoffMaxMs: parseOptionalInt(env.RELAYER_STARTUP_BACKOFF_MAX_MS),
  };
}

function parseOptionalInt(raw: string | undefined): number | undefined {
  return raw ? parseInt(raw, 10) : undefined;
}

// ---------------------------------------------------------------------------
// Refund watchdog settings
// ---------------------------------------------------------------------------

/** Settings needed to start the refund watchdog. */
export interface RefundWatchdogSettings {
  networkMode: 'mainnet' | 'testnet';
  horizonUrl: string;
  refundSecret: string;
}

/**
 * Resolve the refund watchdog settings for the default network.
 *
 * Mainnet reads `RELAYER_STELLAR_SECRET_MAINNET`, testnet reads
 * `RELAYER_STELLAR_SECRET_TESTNET`. Either falls back to the generic
 * `RELAYER_STELLAR_SECRET`. An empty value counts as unset. Returns `null`
 * when no secret is available, meaning the watchdog stays disabled.
 */
export function resolveRefundWatchdogSettings(
  defaultNetworkMode: NetworkMode,
  env: StartupEnv,
): RefundWatchdogSettings | null {
  const networkMode: 'mainnet' | 'testnet' = defaultNetworkMode === 'mainnet' ? 'mainnet' : 'testnet';
  const secretKey = networkMode === 'mainnet' ? 'RELAYER_STELLAR_SECRET_MAINNET' : 'RELAYER_STELLAR_SECRET_TESTNET';
  const refundSecret = env[secretKey] || env.RELAYER_STELLAR_SECRET;
  if (!refundSecret) {
    return null;
  }
  return {
    networkMode,
    horizonUrl: NETWORK_CONFIG[networkMode].stellar.horizonUrl,
    refundSecret,
  };
}
