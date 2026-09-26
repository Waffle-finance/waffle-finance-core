/**
 * Relayer startup configuration validator.
 *
 * Collects every misconfiguration in a single pass and returns them all at
 * once so operators see the complete list of problems rather than fixing one
 * error at a time and re-starting.  The validator never throws — callers
 * decide what to do with the returned errors.
 */

export interface ConfigError {
  /** Environment variable or config field that failed validation. */
  field: string;
  /** Machine-readable classification of the failure. */
  code:
    | "missing"
    | "placeholder"
    | "invalid_format"
    | "invalid_value";
  /** Human-readable description for the operator. */
  message: string;
}

const PLACEHOLDER_PATTERNS = [
  /YOUR_/i,
  /SAMPLE/i,
  /REPLACE_ME/i,
  /CHANGEME/i,
];

function isPlaceholder(value: string): boolean {
  return PLACEHOLDER_PATTERNS.some((re) => re.test(value));
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** Zero-key patterns that indicate a dummy Ethereum private key. */
function isZeroishEthKey(key: string): boolean {
  const stripped = key.startsWith("0x") ? key.slice(2) : key;
  return /^0+$/.test(stripped) || stripped === "1".padStart(64, "0");
}

/** Stellar secret keys always start with 'S' and are 56 characters long. */
function isValidStellarSecretFormat(secret: string): boolean {
  return /^S[A-Z2-7]{55}$/.test(secret);
}

/**
 * Stellar contract IDs are 56-character StrKey strings starting with 'C'
 * (base32 alphabet A–Z plus digits 2–7).
 */
function isStellarContractId(value: string): boolean {
  return /^C[A-Z2-7]{55}$/.test(value.trim());
}

const STELLAR_TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
const STELLAR_MAINNET_PASSPHRASE = "Public Global Stellar Network ; September 2015";

export interface RelayerRuntimeConfig {
  ethereumPrivateKey?: string | null;
  stellarSecretKey?: string | null;
  /** Network mode — used to validate the Stellar network passphrase. Defaults to 'testnet'. */
  network?: "testnet" | "mainnet";
}

/**
 * Validate relayer startup configuration.
 *
 * @param env  - A subset of environment variables to check (pass `process.env`
 *               in production, a plain object in tests).
 * @param cfg  - Runtime config values already parsed by `loadRelayerConfig()`.
 * @returns    Array of all validation errors found.  Empty array means valid.
 */
export function validateRelayerStartup(
  env: Record<string, string | undefined>,
  cfg: RelayerRuntimeConfig = {},
): ConfigError[] {
  const errors: ConfigError[] = [];

  // ── Chain RPC endpoints ───────────────────────────────────────────────────

  const ethRpc = env["ETHEREUM_RPC_URL"];
  if (!ethRpc) {
    errors.push({
      field: "ETHEREUM_RPC_URL",
      code: "missing",
      message: "ETHEREUM_RPC_URL is not set. Provide a valid Ethereum JSON-RPC endpoint.",
    });
  } else if (isPlaceholder(ethRpc)) {
    errors.push({
      field: "ETHEREUM_RPC_URL",
      code: "placeholder",
      message: `ETHEREUM_RPC_URL looks like a placeholder value (${ethRpc}). Set a real RPC endpoint.`,
    });
  } else if (!isHttpUrl(ethRpc)) {
    errors.push({
      field: "ETHEREUM_RPC_URL",
      code: "invalid_format",
      message: `ETHEREUM_RPC_URL must be an http(s) URL, got: ${ethRpc}`,
    });
  }

  const stellarUrl = env["STELLAR_HORIZON_URL"];
  if (!stellarUrl) {
    errors.push({
      field: "STELLAR_HORIZON_URL",
      code: "missing",
      message: "STELLAR_HORIZON_URL is not set. Provide a valid Stellar Horizon endpoint.",
    });
  } else if (isPlaceholder(stellarUrl)) {
    errors.push({
      field: "STELLAR_HORIZON_URL",
      code: "placeholder",
      message: `STELLAR_HORIZON_URL looks like a placeholder value (${stellarUrl}). Set a real Horizon URL.`,
    });
  } else if (!isHttpUrl(stellarUrl)) {
    errors.push({
      field: "STELLAR_HORIZON_URL",
      code: "invalid_format",
      message: `STELLAR_HORIZON_URL must be an http(s) URL, got: ${stellarUrl}`,
    });
  }

  // ── Private keys / secrets ────────────────────────────────────────────────

  const ethKey = cfg.ethereumPrivateKey ?? env["RELAYER_PRIVATE_KEY"];
  if (!ethKey) {
    errors.push({
      field: "RELAYER_PRIVATE_KEY",
      code: "missing",
      message:
        "RELAYER_PRIVATE_KEY is not set. Generate a real key: " +
        "node -e \"console.log(require('ethers').Wallet.createRandom().privateKey)\"",
    });
  } else if (isPlaceholder(ethKey)) {
    errors.push({
      field: "RELAYER_PRIVATE_KEY",
      code: "placeholder",
      message: "RELAYER_PRIVATE_KEY looks like a placeholder. Set a real Ethereum private key.",
    });
  } else if (isZeroishEthKey(ethKey)) {
    errors.push({
      field: "RELAYER_PRIVATE_KEY",
      code: "invalid_value",
      message:
        "RELAYER_PRIVATE_KEY is an all-zero or dummy key. " +
        "Generate a real key before starting the relayer.",
    });
  }

  const stellarSecret = cfg.stellarSecretKey ?? env["RELAYER_STELLAR_SECRET"];
  if (!stellarSecret) {
    errors.push({
      field: "RELAYER_STELLAR_SECRET",
      code: "missing",
      message:
        "RELAYER_STELLAR_SECRET is not set. Generate a real key: stellar keys generate",
    });
  } else if (isPlaceholder(stellarSecret)) {
    errors.push({
      field: "RELAYER_STELLAR_SECRET",
      code: "placeholder",
      message: "RELAYER_STELLAR_SECRET looks like a placeholder. Set a real Stellar secret key.",
    });
  } else if (!isValidStellarSecretFormat(stellarSecret)) {
    errors.push({
      field: "RELAYER_STELLAR_SECRET",
      code: "invalid_format",
      message:
        `RELAYER_STELLAR_SECRET must be a 56-character Stellar secret key starting with 'S'. ` +
        `Got a value of length ${stellarSecret.length}.`,
    });
  }

  // ── Soroban RPC endpoint ─────────────────────────────────────────────────
  // Required for all Stellar/Soroban interactions. A missing or malformed URL
  // causes every Soroban operation to fail at runtime rather than at startup.

  const sorobanRpcUrl = env["SOROBAN_RPC_URL"];
  if (!sorobanRpcUrl) {
    errors.push({
      field: "SOROBAN_RPC_URL",
      code: "missing",
      message:
        "SOROBAN_RPC_URL is not set. Provide a valid Soroban RPC endpoint " +
        "(e.g. https://soroban-testnet.stellar.org for testnet, " +
        "https://mainnet.sorobanrpc.com for mainnet).",
    });
  } else if (isPlaceholder(sorobanRpcUrl)) {
    errors.push({
      field: "SOROBAN_RPC_URL",
      code: "placeholder",
      message: `SOROBAN_RPC_URL looks like a placeholder (${sorobanRpcUrl}). Set a real Soroban RPC endpoint.`,
    });
  } else if (!isHttpUrl(sorobanRpcUrl)) {
    errors.push({
      field: "SOROBAN_RPC_URL",
      code: "invalid_format",
      message: `SOROBAN_RPC_URL must be an http(s) URL, got: ${sorobanRpcUrl}`,
    });
  }

  // ── Stellar network passphrase ────────────────────────────────────────────
  // The passphrase is embedded in every signed Stellar transaction. A mismatch
  // causes signature verification to fail on-chain with tx_bad_auth — often
  // with no obvious connection back to the misconfiguration.

  const networkMode = env["NETWORK_MODE"] ?? cfg.network ?? "testnet";
  const isMainnet = networkMode === "mainnet";
  const expectedPassphrase = isMainnet
    ? STELLAR_MAINNET_PASSPHRASE
    : STELLAR_TESTNET_PASSPHRASE;

  const stellarPassphrase = env["STELLAR_NETWORK_PASSPHRASE"];
  if (!stellarPassphrase) {
    errors.push({
      field: "STELLAR_NETWORK_PASSPHRASE",
      code: "missing",
      message:
        `STELLAR_NETWORK_PASSPHRASE is not set. ` +
        `Expected: "${expectedPassphrase}" for network mode "${networkMode}".`,
    });
  } else if (stellarPassphrase.trim() !== expectedPassphrase) {
    errors.push({
      field: "STELLAR_NETWORK_PASSPHRASE",
      code: "invalid_value",
      message:
        `STELLAR_NETWORK_PASSPHRASE does not match network mode "${networkMode}". ` +
        `Got: "${stellarPassphrase.trim()}". ` +
        `Expected: "${expectedPassphrase}". ` +
        `Ensure NETWORK_MODE and STELLAR_NETWORK_PASSPHRASE are consistent.`,
    });
  }

  // ── Soroban HTLC contract ID (OPTIONAL, format-checked if provided) ───────
  // The contract ID is not required — missing means Soroban settlement is
  // disabled. But if a value is set it must be a valid Stellar StrKey so that
  // the service does not start with a syntactically invalid contract address.

  const htlcEnvKey = isMainnet ? "SOROBAN_HTLC_MAINNET" : "SOROBAN_HTLC_TESTNET";
  const htlcContractId = env[htlcEnvKey];
  if (htlcContractId && !isPlaceholder(htlcContractId) && !isStellarContractId(htlcContractId)) {
    errors.push({
      field: htlcEnvKey,
      code: "invalid_format",
      message:
        `${htlcEnvKey} is not a valid Stellar contract ID. ` +
        `Expected a 56-character StrKey starting with 'C' (base32 A–Z, 2–7), ` +
        `got: "${htlcContractId}".`,
    });
  }

  // ── Polling intervals ────────────────────────────────────────────────────

  const activePollEnv = env["RELAYER_ACTIVE_POLL_INTERVAL_MS"];
  if (activePollEnv !== undefined) {
    const parsed = Number(activePollEnv);
    if (!Number.isFinite(parsed) || parsed < 0) {
      errors.push({
        field: "RELAYER_ACTIVE_POLL_INTERVAL_MS",
        code: "invalid_value",
        message: `RELAYER_ACTIVE_POLL_INTERVAL_MS must be a non-negative number, got: ${activePollEnv}`,
      });
    }
  }

  const idlePollEnv = env["RELAYER_IDLE_POLL_INTERVAL_MS"];
  if (idlePollEnv !== undefined) {
    const parsed = Number(idlePollEnv);
    if (!Number.isFinite(parsed) || parsed < 0) {
      errors.push({
        field: "RELAYER_IDLE_POLL_INTERVAL_MS",
        code: "invalid_value",
        message: `RELAYER_IDLE_POLL_INTERVAL_MS must be a non-negative number, got: ${idlePollEnv}`,
      });
    }
  }

  return errors;
}

/**
 * Format validation errors as a multi-line string suitable for logging to
 * stderr at startup.
 */
export function formatStartupErrors(errors: ConfigError[]): string {
  return errors
    .map((e) => `  [${e.code}] ${e.field}: ${e.message}`)
    .join("\n");
}
