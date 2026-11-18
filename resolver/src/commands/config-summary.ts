import { loadConfig } from "../config.js";
import {
  ConfigValidationError,
  validateEthereumPrivateKey,
  validateStellarSecret,
} from "../validation.js";

type ChainSummary = "configured" | "disabled" | "invalid";

function rpcOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "<unparseable>";
  }
}

function summarizeEvm(cfg: ReturnType<typeof loadConfig>): { status: ChainSummary; detail: string } {
  const { resolverRegistry, resolverPrivateKey, chainId, rpcUrl, htlcEscrow } = cfg.ethereum;
  if (!resolverRegistry && !resolverPrivateKey) {
    return { status: "disabled", detail: "no registry or key configured (observe-only)" };
  }
  if (!resolverRegistry || !resolverPrivateKey) {
    return {
      status: "invalid",
      detail: `partial config: registry ${resolverRegistry ? "present" : "missing"}, key ${resolverPrivateKey ? "present" : "missing"}`,
    };
  }
  try {
    const address = validateEthereumPrivateKey(resolverPrivateKey);
    return {
      status: "configured",
      detail: `chainId=${chainId} rpc=${rpcOrigin(rpcUrl)} registry=${resolverRegistry} htlc=${htlcEscrow ?? "<none>"} address=${address}`,
    };
  } catch (err) {
    return {
      status: "invalid",
      detail: err instanceof ConfigValidationError ? err.message : "invalid private key",
    };
  }
}

function summarizeSoroban(cfg: ReturnType<typeof loadConfig>): { status: ChainSummary; detail: string } {
  const { resolverRegistry, resolverSecret, rpcUrl, networkPassphrase, htlc } = cfg.soroban;
  if (!resolverRegistry && !resolverSecret) {
    return { status: "disabled", detail: "no registry or secret configured (observe-only)" };
  }
  if (!resolverRegistry || !resolverSecret) {
    return {
      status: "invalid",
      detail: `partial config: registry ${resolverRegistry ? "present" : "missing"}, secret ${resolverSecret ? "present" : "missing"}`,
    };
  }
  try {
    const publicKey = validateStellarSecret(resolverSecret);
    return {
      status: "configured",
      detail: `rpc=${rpcOrigin(rpcUrl)} registry=${resolverRegistry} htlc=${htlc ?? "<none>"} publicKey=${publicKey} passphrase=${networkPassphrase}`,
    };
  } catch (err) {
    return {
      status: "invalid",
      detail: err instanceof ConfigValidationError ? err.message : "invalid secret",
    };
  }
}

/**
 * Dry-run configuration summary. Validates the real runtime config, prints
 * per-chain status (configured / intentionally disabled / invalid) with only
 * field presence and non-sensitive identifiers, and never starts listeners.
 * Secret values are never printed. Exits non-zero when the config is invalid.
 */
export async function configSummaryCommand(): Promise<void> {
  let cfg: ReturnType<typeof loadConfig>;
  try {
    cfg = loadConfig();
  } catch (err) {
    console.error(`invalid resolver configuration: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const evm = summarizeEvm(cfg);
  const soroban = summarizeSoroban(cfg);

  // eslint-disable-next-line no-console
  console.log(`network=${cfg.network} pollIntervalMs=${cfg.pollIntervalMs} coordinator=${cfg.coordinatorUrl} logLevel=${cfg.logLevel}`);
  // eslint-disable-next-line no-console
  console.log(`ethereum: ${evm.status} (${evm.detail})`);
  // eslint-disable-next-line no-console
  console.log(`soroban: ${soroban.status} (${soroban.detail})`);

  if (evm.status === "invalid" || soroban.status === "invalid") {
    console.error("configuration invalid: fix the chains reported above");
    process.exit(1);
  }
}
