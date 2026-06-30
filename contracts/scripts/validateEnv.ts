/**
 * Deploy-time environment validation for WaffleFinance v2.
 *
 * Validates all required environment variables and network configuration
 * BEFORE any deployment transaction is sent. Fails fast and loudly so
 * misconfigurations waste zero gas.
 *
 * Security note: private key values are NEVER logged; only their presence
 * and basic format are checked.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DeployEnv {
  /** Deployer private key (hex, 0x-prefixed or raw 32 bytes). Present and non-empty. */
  privateKey: string;
  /** ERC20 address used as the staking asset for ResolverRegistry. */
  stakeAsset: string;
  /** Minimum resolver stake in wei (bigint). */
  minStake: bigint;
  /** Minimum safety deposit in wei (bigint). Defaults to 0 if unset. */
  minSafetyDeposit: bigint;
  /** Resolved RPC URL for the target network. */
  rpcUrl: string;
  /** Target network name as passed to Hardhat (`--network <name>`). */
  networkName: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Ethereum address regex: 0x followed by exactly 40 hex characters. */
const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Raw private key: exactly 64 hex characters without 0x prefix,
 * OR 66 characters with 0x prefix.
 */
const PRIVATE_KEY_RE = /^(0x)?[0-9a-fA-F]{64}$/;

/** Minimum sane minStake when deploying to a live network (1 token with 18 decimals). */
const LIVE_MIN_STAKE_FLOOR = BigInt("1000000000000000000"); // 1e18

/** Known Hardhat/local network names that bypass live-network checks. */
const LOCAL_NETWORKS = new Set(["hardhat", "localhost", "local"]);

// ─── Address validation ───────────────────────────────────────────────────────

/**
 * Returns true if `value` looks like a checksummed or lowercase Ethereum address.
 * Does not perform EIP-55 checksum verification — that requires a web3 library.
 */
export function isValidAddress(value: string): boolean {
  return ETH_ADDRESS_RE.test(value);
}

/**
 * Returns true if `value` is the zero address (0x000...0).
 * Useful for detecting unconfigured address fields.
 */
export function isZeroAddress(value: string): boolean {
  return /^0x0{40}$/.test(value);
}

// ─── Private key validation ───────────────────────────────────────────────────

/**
 * Checks that a private key is present and structurally valid (64 hex bytes).
 * DOES NOT log the key value under any circumstances.
 *
 * @returns `true` if the key passes format validation.
 */
export function isValidPrivateKey(value: string | undefined): boolean {
  if (!value || value.trim() === "") return false;
  return PRIVATE_KEY_RE.test(value.trim());
}

// ─── RPC URL validation ───────────────────────────────────────────────────────

/**
 * Returns true if `url` looks like a plausible HTTP(S) or WebSocket RPC endpoint.
 * Does not make a live connection — use `checkRpcConnectivity` for that.
 */
export function isValidRpcUrl(url: string | undefined): boolean {
  if (!url || url.trim() === "") return false;
  try {
    const parsed = new URL(url.trim());
    return ["http:", "https:", "ws:", "wss:"].includes(parsed.protocol);
  } catch {
    return false;
  }
}

// ─── Core validation ──────────────────────────────────────────────────────────

/**
 * Validate all environment variables required by deploy.ts.
 *
 * Errors   → hard failures; deployment must not proceed.
 * Warnings → advisory notices; deployment can proceed but reviewer should note.
 *
 * @param env   Raw process.env-style object (defaults to `process.env`).
 * @param networkName  The Hardhat `--network` value (e.g. "sepolia", "mainnet").
 */
export function validateDeployEnv(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
  networkName: string = "hardhat"
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const isLive = !LOCAL_NETWORKS.has(networkName.toLowerCase());

  // ── 1. Private key ──────────────────────────────────────────────────────────

  const rawKey = env.RELAYER_PRIVATE_KEY ?? env.PRIVATE_KEY;

  if (!rawKey || rawKey.trim() === "") {
    errors.push(
      "Missing deployer private key. " +
        "Set RELAYER_PRIVATE_KEY (or PRIVATE_KEY for mainnet) in your .env file. " +
        "Do NOT commit private keys to source control."
    );
  } else if (!isValidPrivateKey(rawKey)) {
    // Report the issue without echoing the key.
    errors.push(
      "RELAYER_PRIVATE_KEY / PRIVATE_KEY is present but has an invalid format. " +
        "Expected a 32-byte hex string (64 hex chars, optionally 0x-prefixed). " +
        "Check for leading/trailing whitespace or truncation."
    );
  }

  // ── 2. Stake asset address ──────────────────────────────────────────────────

  const stakeAsset = env.V2_STAKE_ASSET?.trim();

  if (!stakeAsset) {
    errors.push(
      "V2_STAKE_ASSET is not set. " +
        "Provide the ERC20 token address to use as the resolver staking asset."
    );
  } else if (!isValidAddress(stakeAsset)) {
    errors.push(
      `V2_STAKE_ASSET "${stakeAsset}" is not a valid Ethereum address. ` +
        "Expected 0x followed by 40 hex characters."
    );
  } else if (isZeroAddress(stakeAsset)) {
    errors.push(
      "V2_STAKE_ASSET is the zero address (0x000...0). " +
        "ResolverRegistry will revert with InvalidAddress on deployment. " +
        "Provide a real ERC20 token address."
    );
  }

  // ── 3. Min stake ────────────────────────────────────────────────────────────

  const rawMinStake = env.V2_MIN_STAKE?.trim();
  let minStake = 0n;

  if (!rawMinStake) {
    if (isLive) {
      errors.push(
        "V2_MIN_STAKE is not set. " +
          "On live networks the minimum resolver stake must be configured explicitly " +
          "to avoid deploying with a zero-stake registry that accepts any resolver."
      );
    } else {
      warnings.push(
        "V2_MIN_STAKE is not set; defaulting to 0. " +
          "This is acceptable for local testing but must be set before deploying to a live network."
      );
    }
  } else {
    try {
      minStake = BigInt(rawMinStake);
      if (minStake < 0n) {
        errors.push("V2_MIN_STAKE must be a non-negative integer (wei).");
      } else if (isLive && minStake < LIVE_MIN_STAKE_FLOOR) {
        warnings.push(
          `V2_MIN_STAKE is ${minStake.toString()} wei, which is less than 1 token ` +
            "(1e18 wei). Confirm this is intentional — a very low minimum stake makes " +
            "the resolver registry trivially bypassable."
        );
      }
    } catch {
      errors.push(
        `V2_MIN_STAKE "${rawMinStake}" is not a valid integer. ` +
          "Provide the value in wei as a decimal string (e.g. \"100000000000000000000\" for 100 tokens)."
      );
    }
  }

  // ── 4. Min safety deposit ───────────────────────────────────────────────────

  const rawMinSD = env.V2_MIN_SAFETY_DEPOSIT?.trim();

  if (rawMinSD) {
    try {
      const minSD = BigInt(rawMinSD);
      if (minSD < 0n) {
        errors.push("V2_MIN_SAFETY_DEPOSIT must be a non-negative integer (wei).");
      }
    } catch {
      errors.push(
        `V2_MIN_SAFETY_DEPOSIT "${rawMinSD}" is not a valid integer. ` +
          "Provide the value in wei as a decimal string (e.g. \"1000000000000000\" for 0.001 ETH)."
      );
    }
  } else {
    warnings.push(
      "V2_MIN_SAFETY_DEPOSIT is not set; defaulting to 0. " +
        "Orders can be created without a safety deposit, which removes the gas-cost incentive " +
        "for relayers to submit claim/refund transactions."
    );
  }

  // ── 5. RPC URL ──────────────────────────────────────────────────────────────

  if (isLive) {
    let rpcUrl: string | undefined;
    if (networkName === "sepolia") {
      rpcUrl =
        env.SEPOLIA_RPC_URL?.trim() ||
        env.ETHEREUM_RPC_URL?.trim() ||
        (env.INFURA_API_KEY?.trim()
          ? `https://sepolia.infura.io/v3/${env.INFURA_API_KEY.trim()}`
          : undefined) ||
        undefined;
    } else if (networkName === "mainnet") {
      rpcUrl =
        env.MAINNET_RPC_URL?.trim() ||
        env.ETHEREUM_RPC_URL?.trim() ||
        (env.INFURA_API_KEY?.trim()
          ? `https://mainnet.infura.io/v3/${env.INFURA_API_KEY.trim()}`
          : undefined) ||
        undefined;
    }

    if (!rpcUrl) {
      if (networkName === "mainnet") {
        warnings.push(
          "No RPC URL configured for mainnet " +
            "(checked MAINNET_RPC_URL, ETHEREUM_RPC_URL, INFURA_API_KEY). " +
            "Hardhat will use a public fallback which may be rate-limited or unreliable."
        );
      } else {
        warnings.push(
          `No RPC URL configured for ${networkName} ` +
            "(checked SEPOLIA_RPC_URL, ETHEREUM_RPC_URL, INFURA_API_KEY). " +
            "Hardhat will use a public fallback which may be rate-limited or unreliable."
        );
      }
    } else if (!isValidRpcUrl(rpcUrl)) {
      errors.push(
        `Resolved RPC URL "${rpcUrl}" does not look like a valid HTTP(S)/WS endpoint.`
      );
    }
  }

  // ── 6. Network / mainnet guard ──────────────────────────────────────────────

  if (networkName === "mainnet") {
    warnings.push(
      "⚠️  MAINNET DEPLOYMENT DETECTED. Verify all parameters carefully before confirming. " +
        "This will spend real ETH and deploy to production."
    );
  }

  return { valid: errors.length === 0, errors, warnings };
}

// ─── Pre-flight entry point ───────────────────────────────────────────────────

/**
 * Run validation and print results to stdout/stderr.
 * Throws on failure so the deploy script exits with a non-zero code.
 *
 * @param networkName  Current Hardhat network name.
 * @param env          Environment variables (defaults to `process.env`).
 */
export function runPreflightChecks(
  networkName: string,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>
): void {
  const result = validateDeployEnv(env, networkName);

  if (result.warnings.length > 0) {
    console.warn("\n⚠️  Deployment warnings:");
    for (const w of result.warnings) {
      console.warn(`   • ${w}`);
    }
  }

  if (!result.valid) {
    console.error("\n❌ Deployment blocked — environment configuration errors:\n");
    for (const e of result.errors) {
      console.error(`   ✗ ${e}`);
    }
    console.error(
      "\nFix the errors above and retry. " +
        "See env.example at the repository root for reference.\n"
    );
    throw new Error(
      `Preflight check failed with ${result.errors.length} error(s). Deployment aborted.`
    );
  }

  console.log(`✅ Preflight checks passed for network "${networkName}".`);
}
