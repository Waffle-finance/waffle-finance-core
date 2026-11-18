/**
 * @file soroban-chain-config.ts
 *
 * Typed environment configuration contract for Soroban deployment and chain
 * settings across all WaffleFinance services.
 *
 * ## Why this file exists
 *
 * The repo has many environment-driven settings, but Soroban and chain
 * endpoint configuration was previously validated only partially inside each
 * service's `loadXxxConfig()` function.  That approach is fragile:
 *
 *  - A missing contract address is silently `null` at runtime, causing the
 *    service to start and then fail mysteriously on first use.
 *  - Placeholder values (e.g. the blank Soroban contract IDs in .env.example)
 *    are accepted as valid configuration, hiding the fact that a required
 *    deployment step was not completed.
 *  - There is no single, authoritative source describing which fields are
 *    required vs optional vs placeholder-safe.
 *
 * This module formalises the contract and exposes a fail-fast validator that
 * should be called during startup so misconfigurations are caught before the
 * service is considered ready.
 *
 * ## Field classifications
 *
 * REQUIRED — must be a non-blank, non-placeholder value.  Validation fails
 *   immediately when a required field is absent.
 *
 * OPTIONAL — may be absent or null.  When absent the corresponding feature
 *   (e.g. source-chain settlement) is disabled but the service remains
 *   operational.  The validator records an INFO-level status for optional
 *   absent fields.
 *
 * PLACEHOLDER-SAFE — a specific set of well-known sentinel strings (empty
 *   string, "PLACEHOLDER", "YOUR_…", etc.) are treated as "not configured"
 *   and are normalised to `null`.  This matches the conventions already used
 *   in `solana-placeholder.ts` and lets `.env.example` ship with blank values
 *   that the validator understands.
 *
 * ## Usage
 *
 * ```ts
 * import { validateSorobanChainConfig } from "@wafflefinance/config";
 *
 * const result = validateSorobanChainConfig({
 *   network: cfg.network,
 *   soroban: cfg.soroban,
 *   ethereum: cfg.ethereum,
 *   solana: cfg.solana,
 * });
 *
 * if (!result.ok) {
 *   log.fatal({ errors: result.errors }, "Soroban/chain configuration is invalid");
 *   process.exit(1);
 * }
 *
 * if (result.warnings.length > 0) {
 *   result.warnings.forEach(w => log.warn(w));
 * }
 * ```
 */

import type { NetworkMode } from './schema.js';

// ── Placeholder detection ─────────────────────────────────────────────────────

/**
 * Strings treated as "not configured" for Soroban contract IDs and related
 * address-like fields.  This set is intentionally broad: all of these values
 * can appear in template .env files and must be caught before runtime.
 */
const CONTRACT_PLACEHOLDER_VALUES: ReadonlySet<string> = new Set([
  '',
  'PLACEHOLDER',
  'YOUR_CONTRACT_ID',
  'YOUR_SOROBAN_CONTRACT',
  'YOUR_SOROBAN_HTLC',
  'YOUR_RESOLVER_REGISTRY',
  'YOUR_ETH_HTLC_ESCROW',
  'YOUR_ETH_RESOLVER_REGISTRY',
  'YOUR_SOLANA_HTLC_PROGRAM',
  'YOUR_SOLANA_PROGRAM',
  'YOUR_PROGRAM_ID',
  // Stellar contract IDs are 56-char StrKey starting with 'C' — flag known bad prefixes
  'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB42222',
  // Solana system program
  '11111111111111111111111111111111',
  // Common dummy ETH addresses
  '0X0000000000000000000000000000000000000000',
  '0X1111111111111111111111111111111111111111',
  '0x0000000000000000000000000000000000000000',
  '0x1111111111111111111111111111111111111111',
]);

/**
 * Returns `true` when `value` looks like an unfilled template placeholder.
 * The check is case-insensitive and also catches any value that contains the
 * word "PLACEHOLDER" or starts with "YOUR_".
 */
export function isPlaceholderValue(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return true;
  const trimmed = value.trim();
  if (trimmed === '') return true;
  const upper = trimmed.toUpperCase();
  if (CONTRACT_PLACEHOLDER_VALUES.has(upper)) return true;
  if (upper.includes('PLACEHOLDER')) return true;
  if (upper.startsWith('YOUR_')) return true;
  return false;
}

/**
 * Normalise a raw env string to `null` when it is a placeholder.
 * Returns the trimmed value otherwise.
 */
export function normaliseContractId(raw: string | null | undefined): string | null {
  if (isPlaceholderValue(raw)) return null;
  return (raw as string).trim();
}

// ── Input contract ────────────────────────────────────────────────────────────

/**
 * The configuration surfaces that `validateSorobanChainConfig` inspects.
 * Shaped to match the typed sub-objects already present in
 * `CoordinatorConfig`, `RelayerConfig`, and `ResolverConfig`.
 */
export interface SorobanChainConfigInput {
  /** Active network mode — drives which contract address env vars are checked. */
  network: NetworkMode;

  soroban: {
    rpcUrl: string;
    horizonUrl: string;
    networkPassphrase: string;
    /**
     * Soroban HTLC contract ID.
     * OPTIONAL — null/placeholder disables Soroban settlement flows.
     */
    htlcContract?: string | null;
    /**
     * Soroban resolver registry contract ID.
     * OPTIONAL — null/placeholder disables on-chain resolver lookup on Soroban.
     */
    resolverRegistry?: string | null;
  };

  ethereum: {
    rpcUrl: string;
    chainId: number;
    /**
     * EVM HTLC escrow contract address.
     * OPTIONAL — null/placeholder disables Ethereum settlement flows.
     */
    htlcEscrow?: `0x${string}` | string | null;
    /**
     * EVM resolver registry contract address.
     * OPTIONAL — null/placeholder disables on-chain resolver lookup on Ethereum.
     */
    resolverRegistry?: `0x${string}` | string | null;
  };

  solana?: {
    rpcUrl?: string;
    /**
     * Solana HTLC program ID.
     * OPTIONAL — placeholder value disables Solana settlement flows.
     */
    programId?: string | null;
  };
}

// ── Validation result ─────────────────────────────────────────────────────────

/** A single validation failure with a machine-readable code. */
export interface ConfigValidationError {
  /** Machine-readable identifier, usable in metrics or alert rules. */
  code: ConfigValidationErrorCode;
  /** Human-readable description for operator and local-dev debugging. */
  message: string;
  /** The environment variable name that is missing or invalid. */
  envVar: string;
  /** The field path inside the config object. */
  field: string;
}

export type ConfigValidationErrorCode =
  | 'MISSING_REQUIRED' // required field is absent
  | 'PLACEHOLDER_REJECTED' // known placeholder where a real value is needed
  | 'INVALID_URL' // field must be a valid HTTP(S) URL but is not
  | 'CHAIN_ID_MISMATCH' // chainId does not match the declared network mode
  | 'PASSPHRASE_MISMATCH' // Stellar passphrase does not match network mode
  | 'INVALID_CONTRACT_ID' // contract ID format is wrong (not a valid StrKey etc.)
  | 'INVALID_ADDRESS' // EVM address format is wrong
  | 'ENDPOINT_SCHEME_MISMATCH'; // non-HTTPS endpoint in mainnet mode

/** An advisory warning that does not prevent startup but should be surfaced. */
export interface ConfigValidationWarning {
  /** Identifies the category of warning. */
  code: ConfigValidationWarningCode;
  message: string;
  field: string;
  envVar: string;
}

export type ConfigValidationWarningCode =
  | 'CONTRACT_NOT_CONFIGURED' // optional contract address absent — feature disabled
  | 'SOLANA_PLACEHOLDER_MODE' // Solana program is a placeholder — Solana flows disabled
  | 'HTTP_ENDPOINT_IN_TESTNET' // non-HTTPS RPC in testnet (acceptable, but visible)
  | 'DEFAULT_PASSPHRASE_USED'; // network passphrase was not explicitly set

/** Final result returned by `validateSorobanChainConfig`. */
export interface SorobanChainConfigResult {
  /** `true` when there are zero errors (warnings do not affect `ok`). */
  ok: boolean;
  errors: ConfigValidationError[];
  warnings: ConfigValidationWarning[];
  /**
   * Normalised, validated view of the input — guaranteed non-null for
   * required fields when `ok === true`.
   */
  normalised: NormalisedSorobanChainConfig;
}

/**
 * The post-validation, normalised config shape.
 * All optional contract IDs are explicitly `string | null` so callers can
 * write `if (cfg.soroban.htlcContract)` without null-coalescing gymnastics.
 */
export interface NormalisedSorobanChainConfig {
  network: NetworkMode;
  soroban: {
    rpcUrl: string;
    horizonUrl: string;
    networkPassphrase: string;
    htlcContract: string | null;
    resolverRegistry: string | null;
    /** Whether the HTLC contract is configured and settlement flows are active. */
    settlementActive: boolean;
  };
  ethereum: {
    rpcUrl: string;
    chainId: number;
    htlcEscrow: string | null;
    resolverRegistry: string | null;
    /** Whether the Ethereum escrow is configured. */
    escrowActive: boolean;
  };
  solana: {
    programId: string | null;
    /** Whether the Solana program is configured (not a placeholder). */
    active: boolean;
  };
}

// ── Known passphrase constants ────────────────────────────────────────────────

export const STELLAR_TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015' as const;
export const STELLAR_MAINNET_PASSPHRASE = 'Public Global Stellar Network ; September 2015' as const;

// Known Soroban / Stellar public RPC endpoints (for scheme checks)
const SOROBAN_TESTNET_DEFAULT = 'https://soroban-testnet.stellar.org';
const SOROBAN_MAINNET_DEFAULT = 'https://mainnet.sorobanrpc.com';

// Known Ethereum chain IDs
const ETH_MAINNET_CHAIN_ID = 1;
const ETH_SEPOLIA_CHAIN_ID = 11_155_111;

// ── Internal helpers ──────────────────────────────────────────────────────────

function isValidUrl(raw: string): boolean {
  try {
    new URL(raw);
    return true;
  } catch {
    return false;
  }
}

function isHttpsUrl(raw: string): boolean {
  return raw.startsWith('https://');
}

// ── Core validator ────────────────────────────────────────────────────────────

/**
 * Validate the Soroban and chain configuration surfaces.
 *
 * This function:
 *  1. Checks that all REQUIRED fields are present and non-placeholder.
 *  2. Verifies that URLs are well-formed and, in mainnet mode, use HTTPS.
 *  3. Confirms that chainId and networkPassphrase match the declared network.
 *  4. Normalises optional contract IDs to `null` when they are placeholders.
 *  5. Records OPTIONAL absent contracts as warnings (not errors).
 *
 * It NEVER throws — callers should inspect `result.ok` and `result.errors`.
 */
export function validateSorobanChainConfig(
  input: SorobanChainConfigInput
): SorobanChainConfigResult {
  const errors: ConfigValidationError[] = [];
  const warnings: ConfigValidationWarning[] = [];
  const { network } = input;
  const isMainnet = network === 'mainnet';

  // ── Helpers ─────────────────────────────────────────────────────────────────

  function addError(
    code: ConfigValidationErrorCode,
    envVar: string,
    field: string,
    message: string
  ): void {
    errors.push({ code, envVar, field, message });
  }

  function addWarning(
    code: ConfigValidationWarningCode,
    envVar: string,
    field: string,
    message: string
  ): void {
    warnings.push({ code, envVar, field, message });
  }

  function requireUrl(value: string, envVar: string, field: string, label: string): void {
    if (!isValidUrl(value)) {
      addError(
        'INVALID_URL',
        envVar,
        field,
        `${label} is not a valid URL: "${value}". ` +
          `Set ${envVar} to a reachable HTTP(S) endpoint.`
      );
      return;
    }
    if (isMainnet && !isHttpsUrl(value)) {
      addError(
        'ENDPOINT_SCHEME_MISMATCH',
        envVar,
        field,
        `${label} must use HTTPS in mainnet mode but got: "${value}". ` +
          `Update ${envVar} to an https:// endpoint.`
      );
    } else if (!isMainnet && !isHttpsUrl(value)) {
      addWarning(
        'HTTP_ENDPOINT_IN_TESTNET',
        envVar,
        field,
        `${label} uses HTTP (not HTTPS) in testnet mode: "${value}". ` +
          `Consider switching to an HTTPS endpoint.`
      );
    }
  }

  // ── Soroban RPC URL (REQUIRED) ───────────────────────────────────────────
  const sorobanRpcEnv = isMainnet ? 'SOROBAN_RPC_URL' : 'SOROBAN_RPC_URL';

  if (!input.soroban.rpcUrl || !isValidUrl(input.soroban.rpcUrl)) {
    addError(
      'INVALID_URL',
      sorobanRpcEnv,
      'soroban.rpcUrl',
      `Soroban RPC URL is missing or invalid: "${input.soroban.rpcUrl ?? ''}". ` +
        `Set SOROBAN_RPC_URL to a reachable Soroban RPC endpoint ` +
        `(default: ${isMainnet ? SOROBAN_MAINNET_DEFAULT : SOROBAN_TESTNET_DEFAULT}).`
    );
  } else {
    requireUrl(input.soroban.rpcUrl, 'SOROBAN_RPC_URL', 'soroban.rpcUrl', 'Soroban RPC URL');
  }

  // ── Horizon URL (REQUIRED) ───────────────────────────────────────────────
  if (!input.soroban.horizonUrl || !isValidUrl(input.soroban.horizonUrl)) {
    addError(
      'INVALID_URL',
      'STELLAR_HORIZON_URL',
      'soroban.horizonUrl',
      `Stellar Horizon URL is missing or invalid: "${input.soroban.horizonUrl ?? ''}". ` +
        `Set STELLAR_HORIZON_URL (e.g. https://horizon-testnet.stellar.org).`
    );
  } else {
    requireUrl(
      input.soroban.horizonUrl,
      'STELLAR_HORIZON_URL',
      'soroban.horizonUrl',
      'Stellar Horizon URL'
    );
  }

  // ── Network passphrase (REQUIRED, must match network mode) ───────────────
  const expectedPassphrase = isMainnet ? STELLAR_MAINNET_PASSPHRASE : STELLAR_TESTNET_PASSPHRASE;

  if (!input.soroban.networkPassphrase || input.soroban.networkPassphrase.trim() === '') {
    addError(
      'MISSING_REQUIRED',
      'STELLAR_NETWORK_PASSPHRASE',
      'soroban.networkPassphrase',
      `Stellar network passphrase is required but was not provided. ` +
        `Expected: "${expectedPassphrase}".`
    );
  } else if (input.soroban.networkPassphrase.trim() !== expectedPassphrase) {
    addError(
      'PASSPHRASE_MISMATCH',
      'STELLAR_NETWORK_PASSPHRASE',
      'soroban.networkPassphrase',
      `Stellar network passphrase does not match the declared network mode "${network}". ` +
        `Got: "${input.soroban.networkPassphrase.trim()}". ` +
        `Expected: "${expectedPassphrase}". ` +
        `Ensure NETWORK_MODE and STELLAR_NETWORK_PASSPHRASE are consistent.`
    );
  }

  // ── Ethereum RPC URL (REQUIRED) ──────────────────────────────────────────
  const ethRpcEnv = isMainnet ? 'MAINNET_RPC_URL' : 'SEPOLIA_RPC_URL';
  if (!input.ethereum.rpcUrl || !isValidUrl(input.ethereum.rpcUrl)) {
    addError(
      'INVALID_URL',
      ethRpcEnv,
      'ethereum.rpcUrl',
      `Ethereum RPC URL is missing or invalid: "${input.ethereum.rpcUrl ?? ''}". ` +
        `Set ${ethRpcEnv} or ETHEREUM_RPC_URL.`
    );
  } else {
    requireUrl(input.ethereum.rpcUrl, ethRpcEnv, 'ethereum.rpcUrl', 'Ethereum RPC URL');
  }

  // ── Ethereum chain ID (REQUIRED, must match network mode) ────────────────
  const expectedChainId = isMainnet ? ETH_MAINNET_CHAIN_ID : ETH_SEPOLIA_CHAIN_ID;
  if (input.ethereum.chainId !== expectedChainId) {
    addError(
      'CHAIN_ID_MISMATCH',
      'NETWORK_MODE',
      'ethereum.chainId',
      `Ethereum chainId ${input.ethereum.chainId} does not match network mode "${network}". ` +
        `Expected chainId ${expectedChainId} for ${isMainnet ? 'Ethereum mainnet' : 'Sepolia testnet'}. ` +
        `Ensure NETWORK_MODE is set correctly.`
    );
  }

  // ── Optional Soroban contract IDs ────────────────────────────────────────
  const htlcContractEnv = isMainnet ? 'SOROBAN_HTLC_MAINNET' : 'SOROBAN_HTLC_TESTNET';
  const sorobanRegistryEnv = isMainnet
    ? 'SOROBAN_RESOLVER_REGISTRY_MAINNET'
    : 'SOROBAN_RESOLVER_REGISTRY_TESTNET';

  const normSorobanHtlc = normaliseContractId(input.soroban.htlcContract);
  const normSorobanRegistry = normaliseContractId(input.soroban.resolverRegistry);

  if (normSorobanHtlc === null) {
    addWarning(
      'CONTRACT_NOT_CONFIGURED',
      htlcContractEnv,
      'soroban.htlcContract',
      `Soroban HTLC contract is not configured (${htlcContractEnv} is blank or a placeholder). ` +
        `Soroban settlement flows are DISABLED. ` +
        `Set ${htlcContractEnv} to the deployed contract ID to enable them.`
    );
  }

  if (normSorobanRegistry === null) {
    addWarning(
      'CONTRACT_NOT_CONFIGURED',
      sorobanRegistryEnv,
      'soroban.resolverRegistry',
      `Soroban resolver registry is not configured (${sorobanRegistryEnv} is blank or a placeholder). ` +
        `On-chain resolver lookup on Soroban is DISABLED. ` +
        `Set ${sorobanRegistryEnv} to the deployed contract ID.`
    );
  }

  // ── Optional Ethereum contract addresses ─────────────────────────────────
  const ethEscrowEnv = isMainnet ? 'ETH_HTLC_ESCROW_MAINNET' : 'ETH_HTLC_ESCROW_TESTNET';
  const ethRegistryEnv = isMainnet
    ? 'ETH_RESOLVER_REGISTRY_MAINNET'
    : 'ETH_RESOLVER_REGISTRY_TESTNET';

  const rawEthEscrow = input.ethereum.htlcEscrow ?? null;
  const rawEthRegistry = input.ethereum.resolverRegistry ?? null;

  const normEthEscrow = normaliseContractId(rawEthEscrow ? String(rawEthEscrow) : null);
  const normEthRegistry = normaliseContractId(rawEthRegistry ? String(rawEthRegistry) : null);

  if (normEthEscrow === null) {
    addWarning(
      'CONTRACT_NOT_CONFIGURED',
      ethEscrowEnv,
      'ethereum.htlcEscrow',
      `Ethereum HTLC escrow address is not configured (${ethEscrowEnv} is blank or a placeholder). ` +
        `Ethereum settlement flows are DISABLED. ` +
        `Set ${ethEscrowEnv} to the deployed contract address.`
    );
  } else if (!/^0x[0-9a-fA-F]{40}$/.test(normEthEscrow)) {
    addError(
      'INVALID_ADDRESS',
      ethEscrowEnv,
      'ethereum.htlcEscrow',
      `${ethEscrowEnv} is not a valid 0x-prefixed 20-byte Ethereum address: "${normEthEscrow}". ` +
        `Provide a correctly checksummed address.`
    );
  }

  if (normEthRegistry === null) {
    addWarning(
      'CONTRACT_NOT_CONFIGURED',
      ethRegistryEnv,
      'ethereum.resolverRegistry',
      `Ethereum resolver registry address is not configured (${ethRegistryEnv} is blank or a placeholder). ` +
        `On-chain resolver lookup on Ethereum is DISABLED. ` +
        `Set ${ethRegistryEnv} to the deployed contract address.`
    );
  } else if (!/^0x[0-9a-fA-F]{40}$/.test(normEthRegistry)) {
    addError(
      'INVALID_ADDRESS',
      ethRegistryEnv,
      'ethereum.resolverRegistry',
      `${ethRegistryEnv} is not a valid 0x-prefixed 20-byte Ethereum address: "${normEthRegistry}". ` +
        `Provide a correctly checksummed address.`
    );
  }

  // ── Solana program ID (OPTIONAL / placeholder-safe) ──────────────────────
  const solanaEnv = isMainnet ? 'SOLANA_HTLC_PROGRAM_MAINNET' : 'SOLANA_HTLC_PROGRAM_TESTNET';
  const rawSolanaProgramId = input.solana?.programId ?? null;
  const normSolanaProgramId = normaliseContractId(rawSolanaProgramId);
  const solanaActive = normSolanaProgramId !== null;

  if (!solanaActive) {
    addWarning(
      'SOLANA_PLACEHOLDER_MODE',
      solanaEnv,
      'solana.programId',
      `Solana HTLC program is not configured (${solanaEnv} is blank or a placeholder). ` +
        `Solana settlement flows are DISABLED. ` +
        `Set ${solanaEnv} to a real Solana program address to enable them.`
    );
  }

  // ── Build normalised output ───────────────────────────────────────────────
  const normalised: NormalisedSorobanChainConfig = {
    network,
    soroban: {
      rpcUrl: input.soroban.rpcUrl,
      horizonUrl: input.soroban.horizonUrl,
      networkPassphrase: input.soroban.networkPassphrase,
      htlcContract: normSorobanHtlc,
      resolverRegistry: normSorobanRegistry,
      settlementActive: normSorobanHtlc !== null,
    },
    ethereum: {
      rpcUrl: input.ethereum.rpcUrl,
      chainId: input.ethereum.chainId,
      htlcEscrow: normEthEscrow,
      resolverRegistry: normEthRegistry,
      escrowActive: normEthEscrow !== null,
    },
    solana: {
      programId: normSolanaProgramId,
      active: solanaActive,
    },
  };

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    normalised,
  };
}

// ── Fail-fast helper ──────────────────────────────────────────────────────────

/**
 * Validate the Soroban/chain config and throw a descriptive error on the first
 * failure.  Use this at service startup when you want a single, clear message
 * rather than a full error list.
 *
 * @throws {SorobanChainConfigError} when any required field is invalid.
 */
export function assertSorobanChainConfig(
  input: SorobanChainConfigInput
): NormalisedSorobanChainConfig {
  const result = validateSorobanChainConfig(input);
  if (!result.ok) {
    throw new SorobanChainConfigError(result.errors, result.warnings);
  }
  return result.normalised;
}

/**
 * Thrown by `assertSorobanChainConfig` when validation fails.
 *
 * The `errors` array contains every failing field with a machine-readable
 * `code` and a human-readable `message` that is precise enough for operator
 * and local-dev debugging without leaking secrets.
 */
export class SorobanChainConfigError extends Error {
  constructor(
    public readonly errors: ConfigValidationError[],
    public readonly warnings: ConfigValidationWarning[]
  ) {
    const summary = errors.map(e => `  [${e.code}] ${e.envVar}: ${e.message}`).join('\n');
    super(
      `Soroban/chain configuration is invalid — ${errors.length} error(s) must be resolved before the service can start:\n` +
        summary
    );
    this.name = 'SorobanChainConfigError';
  }
}

// ── Structured log / report helper ───────────────────────────────────────────

/**
 * Format a `SorobanChainConfigResult` into a human-readable report string
 * suitable for structured logging or CLI output.
 *
 * ```
 * Soroban/chain configuration report — testnet
 * ✓ soroban.rpcUrl        https://soroban-testnet.stellar.org
 * ✓ ethereum.rpcUrl       https://sepolia.infura.io/v3/…
 * ⚠ soroban.htlcContract  NOT CONFIGURED (SOROBAN_HTLC_TESTNET is blank — Soroban settlement DISABLED)
 * ✗ soroban.networkPassphrase  PASSPHRASE_MISMATCH: …
 * ```
 */
export function formatConfigReport(result: SorobanChainConfigResult): string {
  const lines: string[] = [`Soroban/chain configuration report — ${result.normalised.network}`];

  for (const err of result.errors) {
    lines.push(`  ✗ [${err.code}] ${err.field} (${err.envVar}): ${err.message}`);
  }

  for (const warn of result.warnings) {
    lines.push(`  ⚠ [${warn.code}] ${warn.field} (${warn.envVar}): ${warn.message}`);
  }

  if (result.ok && result.warnings.length === 0) {
    lines.push('  ✓ All required fields valid. All optional contracts configured.');
  } else if (result.ok) {
    lines.push(
      `  ✓ Required fields valid. ${result.warnings.length} optional field(s) not configured.`
    );
  }

  return lines.join('\n');
}
