import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Keypair, StrKey, rpc } from "@stellar/stellar-sdk";
import type { Logger } from "pino";
import type { ResolverConfig } from "./config.js";

/**
 * Strict startup validation for the resolver daemon.
 *
 * This module is deliberately isolated from runtime logic: it never starts
 * an event listener or any long-running service. It performs cheap, single-run
 * checks so that bad credentials, wrong chain ids, or unreachable / mismatched
 * RPC endpoints fail fast *before* any listener attaches.
 *
 * Security: private key material is never included in error messages or logs.
 * Errors report *which* value is invalid and *how*, never *what* it was. RPC
 * URLs are reduced to their origin so embedded API keys never leak.
 */

/** Thrown when the resolver environment / config is invalid. */
export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigValidationError";
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Reduce an RPC URL to its origin (scheme + host) so any embedded credentials
 * — e.g. an Infura project key in the path — are not leaked in error messages.
 */
function redactUrl(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "<configured RPC endpoint>";
  }
}

/**
 * Validate a Stellar Ed25519 secret seed (an `S...` StrKey).
 *
 * @returns the derived public key (`G...`), which is safe to log.
 * @throws ConfigValidationError if the seed is malformed. The secret is never
 *         echoed back in the error.
 */
export function validateStellarSecret(
  secret: string,
  label = "RESOLVER_STELLAR_SECRET"
): string {
  if (!StrKey.isValidEd25519SecretSeed(secret)) {
    throw new ConfigValidationError(
      `${label} is not a valid Stellar Ed25519 secret seed ` +
        `(expected an 'S...' StrKey). The provided value is not logged.`
    );
  }
  try {
    return Keypair.fromSecret(secret).publicKey();
  } catch {
    throw new ConfigValidationError(
      `${label} could not be parsed into a Stellar keypair. The value is not logged.`
    );
  }
}

/**
 * Validate a 0x-prefixed 32-byte secp256k1 private key.
 *
 * @returns the derived checksummed account address, which is safe to log.
 * @throws ConfigValidationError if the key is malformed or unusable. The key
 *         is never echoed back in the error.
 */
export function validateEthereumPrivateKey(
  key: string,
  label = "RESOLVER_ETH_PRIVATE_KEY"
): `0x${string}` {
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new ConfigValidationError(
      `${label} must be a 0x-prefixed 32-byte hex private key. The provided value is not logged.`
    );
  }
  try {
    return privateKeyToAccount(key as `0x${string}`).address;
  } catch {
    throw new ConfigValidationError(
      `${label} is not a usable secp256k1 private key. The value is not logged.`
    );
  }
}

/** Probe the chain id reported by an Ethereum JSON-RPC endpoint. */
export type EthereumChainIdProbe = (rpcUrl: string) => Promise<number>;
/** Probe the network passphrase reported by a Soroban RPC endpoint. */
export type SorobanPassphraseProbe = (rpcUrl: string) => Promise<string>;

async function defaultGetEthereumChainId(rpcUrl: string): Promise<number> {
  const client = createPublicClient({ transport: http(rpcUrl) });
  return client.getChainId();
}

async function defaultGetSorobanPassphrase(rpcUrl: string): Promise<string> {
  const server = new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith("http://") });
  const network = await server.getNetwork();
  return network.passphrase;
}

/**
 * Verify the Ethereum RPC endpoint is reachable and reports the chain id the
 * resolver expects for the active NETWORK_MODE.
 */
export async function assertEthereumChainId(
  rpcUrl: string,
  expectedChainId: number,
  getChainId: EthereumChainIdProbe = defaultGetEthereumChainId
): Promise<void> {
  let actual: number;
  try {
    actual = await getChainId(rpcUrl);
  } catch (err) {
    throw new ConfigValidationError(
      `Could not reach Ethereum RPC at ${redactUrl(rpcUrl)} to verify chain id: ${errMessage(err)}`
    );
  }
  if (actual !== expectedChainId) {
    throw new ConfigValidationError(
      `Ethereum RPC chain id mismatch: endpoint ${redactUrl(rpcUrl)} reports chain ${actual}, ` +
        `but NETWORK_MODE expects chain ${expectedChainId}. Point RESOLVER at an RPC for the correct network.`
    );
  }
}

/**
 * Verify the Soroban RPC endpoint is reachable and serves the network whose
 * passphrase the resolver expects for the active NETWORK_MODE.
 */
export async function assertSorobanReachable(
  rpcUrl: string,
  expectedPassphrase: string,
  getPassphrase: SorobanPassphraseProbe = defaultGetSorobanPassphrase
): Promise<void> {
  let actual: string;
  try {
    actual = await getPassphrase(rpcUrl);
  } catch (err) {
    throw new ConfigValidationError(
      `Could not reach Soroban RPC at ${redactUrl(rpcUrl)}: ${errMessage(err)}`
    );
  }
  if (actual !== expectedPassphrase) {
    throw new ConfigValidationError(
      `Soroban RPC network mismatch: endpoint ${redactUrl(rpcUrl)} reports passphrase ` +
        `"${actual}", but NETWORK_MODE expects "${expectedPassphrase}". ` +
        `Point RESOLVER at a Soroban RPC for the correct network.`
    );
  }
}

export interface ValidateOptions {
  /**
   * When true (default) the validator performs network round-trips to confirm
   * the Ethereum chain id and Soroban network passphrase. Set to false for
   * dry-run / offline checks (e.g. tests) that should not require live RPC.
   */
  checkConnectivity?: boolean;
  /** Optional logger for progress messages. Only public material is logged. */
  logger?: Pick<Logger, "info">;
  /** Overrideable probes — primarily for testing without live RPC. */
  ethereumChainIdProbe?: EthereumChainIdProbe;
  sorobanPassphraseProbe?: SorobanPassphraseProbe;
}

/**
 * Validate the full resolver config before any listeners are bootstrapped.
 *
 * Order: cheap, synchronous key-material checks first (so malformed secrets
 * fail instantly and offline), then optional network/endpoint consistency
 * checks. Secrets are optional — the reference resolver runs observe-only when
 * they are absent — but when present they must be well-formed.
 */
export async function validateResolverConfig(
  cfg: ResolverConfig,
  opts: ValidateOptions = {}
): Promise<void> {
  const { checkConnectivity = true, logger } = opts;

  // 1. Synchronous key-material validation. Always runs; never touches network.
  if (cfg.ethereum.resolverPrivateKey) {
    const address = validateEthereumPrivateKey(cfg.ethereum.resolverPrivateKey);
    logger?.info({ resolverAddress: address }, "Ethereum resolver key validated");
  }
  if (cfg.soroban.resolverSecret) {
    const publicKey = validateStellarSecret(cfg.soroban.resolverSecret);
    logger?.info({ stellarPublicKey: publicKey }, "Stellar resolver secret validated");
  }

  // 2. Network / endpoint consistency. Optional so dry-runs stay offline.
  if (checkConnectivity) {
    await assertEthereumChainId(
      cfg.ethereum.rpcUrl,
      cfg.ethereum.chainId,
      opts.ethereumChainIdProbe
    );
    logger?.info({ chainId: cfg.ethereum.chainId }, "Ethereum RPC chain id verified");

    await assertSorobanReachable(
      cfg.soroban.rpcUrl,
      cfg.soroban.networkPassphrase,
      opts.sorobanPassphraseProbe
    );
    logger?.info(
      { networkPassphrase: cfg.soroban.networkPassphrase },
      "Soroban RPC connectivity verified"
    );
  }
}
