import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import { config as dotenvConfig } from "dotenv";
import { resolve } from "path";
import { isValidPrivateKey, isValidRpcUrl } from "./scripts/validateEnv";

// Load environment variables from the repo root .env file.
// Silent when the file is absent (CI provides vars via secrets, not a file).
dotenvConfig({ path: resolve(__dirname, "../.env") });

// ─── RPC resolution ──────────────────────────────────────────────────────────

/**
 * Resolve the RPC URL for a given network using the precedence order
 * documented in env.example:
 *
 *   SEPOLIA_RPC_URL / MAINNET_RPC_URL
 *   → ETHEREUM_RPC_URL  (shared fallback)
 *   → Infura (built from INFURA_API_KEY)
 *   → Public node (last resort — may be rate-limited)
 */
function resolveHardhatRpc(network: "sepolia" | "mainnet"): string {
  const infuraKey = process.env["INFURA_API_KEY"]?.trim();

  if (network === "sepolia") {
    return (
      process.env["SEPOLIA_RPC_URL"]?.trim() ||
      process.env["ETHEREUM_RPC_URL"]?.trim() ||
      (infuraKey ? `https://sepolia.infura.io/v3/${infuraKey}` : "") ||
      "https://ethereum-sepolia-rpc.publicnode.com"
    );
  }

  return (
    process.env["MAINNET_RPC_URL"]?.trim() ||
    process.env["ETHEREUM_RPC_URL"]?.trim() ||
    (infuraKey ? `https://mainnet.infura.io/v3/${infuraKey}` : "") ||
    "https://ethereum-rpc.publicnode.com"
  );
}

// ─── Config-load-time warnings ────────────────────────────────────────────────
//
// These are advisory only and never throw — they cannot break `compile` or
// `test` tasks.  Full deploy-time validation is handled by
// `scripts/validateEnv.ts` which is called from the deploy script itself.

/**
 * Emit a warning if the resolved RPC URL for a live network is not a valid
 * HTTP(S)/WS URL.  Only emits when Hardhat is explicitly invoked with that
 * network flag to avoid noise during `compile` / `test` runs.
 */
function warnIfRpcInvalid(network: "sepolia" | "mainnet"): void {
  const url = resolveHardhatRpc(network);
  if (!isValidRpcUrl(url)) {
    console.warn(
      `[hardhat.config] ⚠️  The resolved RPC URL for "${network}" does not look valid: "${url}". ` +
        "Set SEPOLIA_RPC_URL / MAINNET_RPC_URL or INFURA_API_KEY in your .env file."
    );
  }
}

// Only run RPC and key warnings when targeting a live network.
// `HARDHAT_NETWORK` is set by Hardhat itself when --network is passed.
const targetNetwork = process.env["HARDHAT_NETWORK"] ?? "";
if (targetNetwork === "sepolia") warnIfRpcInvalid("sepolia");
if (targetNetwork === "mainnet") warnIfRpcInvalid("mainnet");

// Warn (but never throw) if a private key is present but structurally invalid.
// A missing key is fine at config-load time — the deploy script's preflight
// checks catch it when the key is actually needed.
(function warnIfKeyMalformatted(): void {
  const rawKey =
    process.env["RELAYER_PRIVATE_KEY"]?.trim() ||
    process.env["PRIVATE_KEY"]?.trim();

  if (rawKey !== undefined && rawKey !== "" && !isValidPrivateKey(rawKey)) {
    // Intentionally vague — never echo any portion of the key value.
    console.warn(
      "[hardhat.config] ⚠️  RELAYER_PRIVATE_KEY / PRIVATE_KEY is set but appears " +
        "malformatted (expected 64 hex chars, optionally 0x-prefixed). " +
        "Transactions on live networks will fail."
    );
  }
})();

// ─── Account helpers ──────────────────────────────────────────────────────────

/**
 * Build the accounts array from available private keys.
 * Returns an empty array when no valid key is found — Hardhat will use its
 * built-in test accounts for local networks and throw a clear error on live
 * networks if a transaction is attempted without an account.
 */
function resolveAccounts(prefer?: string, fallback?: string): string[] {
  const key = prefer?.trim() || fallback?.trim();
  if (!key || !isValidPrivateKey(key)) return [];
  return [key.startsWith("0x") ? key : `0x${key}`];
}

// ─── Hardhat configuration ────────────────────────────────────────────────────

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      viaIR: true,
    },
  },

  networks: {
    hardhat: {
      chainId: 1337,
    },
    sepolia: {
      url: resolveHardhatRpc("sepolia"),
      chainId: 11155111,
      accounts: resolveAccounts(process.env["RELAYER_PRIVATE_KEY"]),
    },
    mainnet: {
      url: resolveHardhatRpc("mainnet"),
      // Mainnet prefers PRIVATE_KEY; falls back to RELAYER_PRIVATE_KEY.
      accounts: resolveAccounts(
        process.env["PRIVATE_KEY"],
        process.env["RELAYER_PRIVATE_KEY"]
      ),
    },
  },

  gasReporter: {
    enabled: process.env["REPORT_GAS"] !== undefined,
    currency: "USD",
  },

  etherscan: {
    apiKey: process.env["ETHERSCAN_API_KEY"],
  },

  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
};

export default config;
