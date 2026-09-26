export type AssetMappingNetwork = "testnet" | "mainnet";

export interface CanonicalStellarAsset {
  code: string;
  issuer?: string;
}

export interface CanonicalSolanaAsset {
  /** SPL token mint address, or NATIVE_SOL_MINT for native SOL. */
  mint: string;
  symbol: string;
}

export const NATIVE_ETH_ADDRESS = "0x0000000000000000000000000000000000000000";
export const NATIVE_STELLAR_ASSET: CanonicalStellarAsset = { code: "XLM" };
export const NATIVE_SOL_MINT = "So11111111111111111111111111111111111111112";
export const NATIVE_SOL_ASSET: CanonicalSolanaAsset = { mint: NATIVE_SOL_MINT, symbol: "SOL" };

// ── Error type ────────────────────────────────────────────────────────────

/**
 * Thrown by the strict assertion helpers when an asset has no known mapping
 * on the requested network.  Use the corresponding `isSupportedX()` guard to
 * check before calling into `resolveStellarAsset` / `resolveSolanaAsset` etc.
 * when you want a hard failure instead of the lenient fallback behaviour.
 */
export class UnsupportedAssetError extends Error {
  constructor(
    /** The unrecognised asset identifier (Ethereum address, Stellar key, or Solana mint). */
    public readonly asset: string,
    /** The network on which the mapping was requested. */
    public readonly network: AssetMappingNetwork,
    /** Human-readable description of the direction, e.g. "eth→stellar". */
    public readonly direction: string,
  ) {
    super(`Unsupported asset "${asset}" for ${direction} mapping on ${network}`);
    this.name = "UnsupportedAssetError";
  }
}

// ── Static mapping tables ─────────────────────────────────────────────────

const TESTNET_ETH_TO_STELLAR: Record<string, CanonicalStellarAsset> = {
  [NATIVE_ETH_ADDRESS]: NATIVE_STELLAR_ASSET,
  "0xa0b86a33e6417c4fd30ad9d05d6b9b7cd6dd11b": {
    code: "USDC",
    issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  },
};

const TESTNET_STELLAR_TO_ETH: Record<string, string> = {
  XLM: NATIVE_ETH_ADDRESS,
  "USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5":
    "0xa0b86a33e6417c4fd30ad9d05d6b9b7cd6dd11b",
};

const MAINNET_ETH_TO_STELLAR: Record<string, CanonicalStellarAsset> = {
  [NATIVE_ETH_ADDRESS]: NATIVE_STELLAR_ASSET,
};

const MAINNET_STELLAR_TO_ETH: Record<string, string> = {
  XLM: NATIVE_ETH_ADDRESS,
};

const MAPPINGS: Record<AssetMappingNetwork, {
  ethToStellar: Record<string, CanonicalStellarAsset>;
  stellarToEth: Record<string, string>;
}> = {
  testnet: {
    ethToStellar: TESTNET_ETH_TO_STELLAR,
    stellarToEth: TESTNET_STELLAR_TO_ETH,
  },
  mainnet: {
    ethToStellar: MAINNET_ETH_TO_STELLAR,
    stellarToEth: MAINNET_STELLAR_TO_ETH,
  },
};

const TESTNET_ETH_TO_SOLANA: Record<string, CanonicalSolanaAsset> = {
  [NATIVE_ETH_ADDRESS]: NATIVE_SOL_ASSET,
  // USDC on devnet
  "0xa0b86a33e6417c4fd30ad9d05d6b9b7cd6dd11b": {
    mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    symbol: "USDC",
  },
};

const TESTNET_SOLANA_TO_ETH: Record<string, string> = {
  [NATIVE_SOL_MINT]: NATIVE_ETH_ADDRESS,
  "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU": "0xa0b86a33e6417c4fd30ad9d05d6b9b7cd6dd11b",
};

const MAINNET_ETH_TO_SOLANA: Record<string, CanonicalSolanaAsset> = {
  [NATIVE_ETH_ADDRESS]: NATIVE_SOL_ASSET,
};

const MAINNET_SOLANA_TO_ETH: Record<string, string> = {
  [NATIVE_SOL_MINT]: NATIVE_ETH_ADDRESS,
};

const SOLANA_MAPPINGS: Record<AssetMappingNetwork, {
  ethToSolana: Record<string, CanonicalSolanaAsset>;
  solanaToEth: Record<string, string>;
}> = {
  testnet: { ethToSolana: TESTNET_ETH_TO_SOLANA, solanaToEth: TESTNET_SOLANA_TO_ETH },
  mainnet: { ethToSolana: MAINNET_ETH_TO_SOLANA, solanaToEth: MAINNET_SOLANA_TO_ETH },
};

// ── Stellar ↔ Solana mappings ─────────────────────────────────────────────────

const TESTNET_STELLAR_TO_SOLANA: Record<string, CanonicalSolanaAsset> = {
  XLM: NATIVE_SOL_ASSET,
  "USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5": {
    mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    symbol: "USDC",
  },
};

const TESTNET_SOLANA_TO_STELLAR: Record<string, CanonicalStellarAsset> = {
  [NATIVE_SOL_MINT]: NATIVE_STELLAR_ASSET,
  "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU": {
    code: "USDC",
    issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  },
};

const MAINNET_STELLAR_TO_SOLANA: Record<string, CanonicalSolanaAsset> = {
  XLM: NATIVE_SOL_ASSET,
};

const MAINNET_SOLANA_TO_STELLAR: Record<string, CanonicalStellarAsset> = {
  [NATIVE_SOL_MINT]: NATIVE_STELLAR_ASSET,
};

const STELLAR_SOLANA_MAPPINGS: Record<AssetMappingNetwork, {
  stellarToSolana: Record<string, CanonicalSolanaAsset>;
  solanaToStellar: Record<string, CanonicalStellarAsset>;
}> = {
  testnet: {
    stellarToSolana: TESTNET_STELLAR_TO_SOLANA,
    solanaToStellar: TESTNET_SOLANA_TO_STELLAR,
  },
  mainnet: {
    stellarToSolana: MAINNET_STELLAR_TO_SOLANA,
    solanaToStellar: MAINNET_SOLANA_TO_STELLAR,
  },
};

// ── Normalization helpers ─────────────────────────────────────────────────

/**
 * Normalise an Ethereum token address to lowercase with no surrounding
 * whitespace.  All internal lookups use this canonical form; call it before
 * comparing two Ethereum addresses or constructing a mapping key.
 */
export function normalizeEthereumAddress(address: string): string {
  return address.trim().toLowerCase();
}

/**
 * Produce the canonical string key for a Stellar asset:
 *   - Native XLM    →  `"XLM"`
 *   - Issued asset  →  `"CODE:ISSUER"`
 *
 * Accepts either a {@link CanonicalStellarAsset} object (as returned by
 * `resolveStellarAsset`) or a pre-formatted string key.  Leading/trailing
 * whitespace is stripped from string inputs.
 */
export function normalizeStellarAssetKey(asset: string | CanonicalStellarAsset): string {
  if (typeof asset === "string") {
    return asset.trim();
  }
  return asset.issuer ? `${asset.code}:${asset.issuer}` : asset.code;
}

/**
 * Normalise a Solana mint address by trimming surrounding whitespace.
 * Solana base58 addresses are case-sensitive so no case folding is applied.
 */
export function normalizeSolanaMint(mint: string): string {
  return mint.trim();
}

// ── Boolean support guards ────────────────────────────────────────────────

/**
 * Return `true` if `ethereumTokenAddress` has a known eth→stellar mapping
 * on `network`.  Mixed-case and padded addresses are accepted.
 */
export function isSupportedEthToStellar(
  ethereumTokenAddress: string,
  network: AssetMappingNetwork = "testnet",
): boolean {
  const normalized = normalizeEthereumAddress(ethereumTokenAddress);
  return normalized in (MAPPINGS[network]?.ethToStellar ?? MAPPINGS.testnet.ethToStellar);
}

/**
 * Return `true` if `stellarAsset` has a known stellar→eth mapping on
 * `network`.  Accepts both object and string-key forms.
 */
export function isSupportedStellarToEth(
  stellarAsset: string | CanonicalStellarAsset,
  network: AssetMappingNetwork = "testnet",
): boolean {
  const key = normalizeStellarAssetKey(stellarAsset);
  return key in (MAPPINGS[network]?.stellarToEth ?? MAPPINGS.testnet.stellarToEth);
}

/**
 * Return `true` if `ethereumTokenAddress` has a known eth→solana mapping
 * on `network`.  Mixed-case and padded addresses are accepted.
 */
export function isSupportedEthToSolana(
  ethereumTokenAddress: string,
  network: AssetMappingNetwork = "testnet",
): boolean {
  const normalized = normalizeEthereumAddress(ethereumTokenAddress);
  return normalized in SOLANA_MAPPINGS[network].ethToSolana;
}

/**
 * Return `true` if `mint` has a known solana→eth mapping on `network`.
 * Leading/trailing whitespace is stripped before lookup.
 */
export function isSupportedSolanaToEth(
  mint: string,
  network: AssetMappingNetwork = "testnet",
): boolean {
  return normalizeSolanaMint(mint) in SOLANA_MAPPINGS[network].solanaToEth;
}

// ── Assertion (throwing) guards ───────────────────────────────────────────

/**
 * Assert that `ethereumTokenAddress` maps to a known Stellar asset on
 * `network`.  Throws {@link UnsupportedAssetError} if not.
 *
 * Use this before calling `resolveStellarAsset` when you want a hard failure
 * instead of a silent fallback to native XLM.
 */
export function assertSupportedEthToStellar(
  ethereumTokenAddress: string,
  network: AssetMappingNetwork = "testnet",
): void {
  if (!isSupportedEthToStellar(ethereumTokenAddress, network)) {
    throw new UnsupportedAssetError(
      normalizeEthereumAddress(ethereumTokenAddress),
      network,
      "eth→stellar",
    );
  }
}

/**
 * Assert that `stellarAsset` maps to a known Ethereum token on `network`.
 * Throws {@link UnsupportedAssetError} if not.
 */
export function assertSupportedStellarToEth(
  stellarAsset: string | CanonicalStellarAsset,
  network: AssetMappingNetwork = "testnet",
): void {
  if (!isSupportedStellarToEth(stellarAsset, network)) {
    throw new UnsupportedAssetError(
      normalizeStellarAssetKey(stellarAsset),
      network,
      "stellar→eth",
    );
  }
}

/**
 * Assert that `ethereumTokenAddress` maps to a known Solana mint on
 * `network`.  Throws {@link UnsupportedAssetError} if not.
 */
export function assertSupportedEthToSolana(
  ethereumTokenAddress: string,
  network: AssetMappingNetwork = "testnet",
): void {
  if (!isSupportedEthToSolana(ethereumTokenAddress, network)) {
    throw new UnsupportedAssetError(
      normalizeEthereumAddress(ethereumTokenAddress),
      network,
      "eth→solana",
    );
  }
}

/**
 * Assert that `mint` maps to a known Ethereum token on `network`.
 * Throws {@link UnsupportedAssetError} if not.
 */
export function assertSupportedSolanaToEth(
  mint: string,
  network: AssetMappingNetwork = "testnet",
): void {
  if (!isSupportedSolanaToEth(mint, network)) {
    throw new UnsupportedAssetError(normalizeSolanaMint(mint), network, "solana→eth");
  }
}

// ── Discovery helpers ─────────────────────────────────────────────────────

/**
 * Return all Ethereum token addresses that have a mapping on `network` for
 * the given `direction`.  Useful for building UI token pickers or
 * pre-validating user input before calling a `resolve*` function.
 */
export function getSupportedEthereumAddresses(
  direction: "stellar" | "solana",
  network: AssetMappingNetwork = "testnet",
): string[] {
  if (direction === "stellar") {
    return Object.keys(MAPPINGS[network]?.ethToStellar ?? MAPPINGS.testnet.ethToStellar);
  }
  return Object.keys(SOLANA_MAPPINGS[network].ethToSolana);
}

/**
 * Return all Stellar asset keys (`"XLM"` or `"CODE:ISSUER"`) that have a
 * mapping to an Ethereum token on `network`.
 */
export function getSupportedStellarAssets(
  network: AssetMappingNetwork = "testnet",
): string[] {
  return Object.keys(MAPPINGS[network]?.stellarToEth ?? MAPPINGS.testnet.stellarToEth);
}

/**
 * Return all Solana mint addresses that have a mapping to an Ethereum token
 * on `network`.
 */
export function getSupportedSolanaMints(
  network: AssetMappingNetwork = "testnet",
): string[] {
  return Object.keys(SOLANA_MAPPINGS[network].solanaToEth);
}

// ── Lenient resolvers (original API — silent fallback behaviour) ──────────

export function resolveStellarAsset(
  ethereumTokenAddress: string,
  network: AssetMappingNetwork = "testnet",
): CanonicalStellarAsset {
  const normalized = normalizeEthereumAddress(ethereumTokenAddress);
  const mapping = MAPPINGS[network]?.ethToStellar ?? MAPPINGS.testnet.ethToStellar;
  return mapping[normalized] ?? NATIVE_STELLAR_ASSET;
}

export function resolveEthereumToken(
  stellarAsset: string | CanonicalStellarAsset,
  network: AssetMappingNetwork = "testnet",
): string {
  const key = normalizeStellarAssetKey(stellarAsset);
  const mapping = MAPPINGS[network]?.stellarToEth ?? MAPPINGS.testnet.stellarToEth;
  return mapping[key] ?? NATIVE_ETH_ADDRESS;
}

export function resolveSolanaAsset(
  ethereumTokenAddress: string,
  network: AssetMappingNetwork = "testnet",
): CanonicalSolanaAsset {
  const normalized = normalizeEthereumAddress(ethereumTokenAddress);
  return SOLANA_MAPPINGS[network].ethToSolana[normalized] ?? NATIVE_SOL_ASSET;
}

export function resolveEthereumTokenFromSolana(
  mint: string,
  network: AssetMappingNetwork = "testnet",
): string {
  return SOLANA_MAPPINGS[network].solanaToEth[normalizeSolanaMint(mint)] ?? NATIVE_ETH_ADDRESS;
}

// ── Stellar ↔ Solana support guards and resolvers ─────────────────────────────

/**
 * Return `true` if `stellarAsset` has a known stellar→solana mapping on
 * `network`.  Accepts both object and string-key forms.
 */
export function isSupportedStellarToSolana(
  stellarAsset: string | CanonicalStellarAsset,
  network: AssetMappingNetwork = "testnet",
): boolean {
  const key = normalizeStellarAssetKey(stellarAsset);
  return key in STELLAR_SOLANA_MAPPINGS[network].stellarToSolana;
}

/**
 * Return `true` if `mint` has a known solana→stellar mapping on `network`.
 * Leading/trailing whitespace is stripped before lookup.
 */
export function isSupportedSolanaToStellar(
  mint: string,
  network: AssetMappingNetwork = "testnet",
): boolean {
  return normalizeSolanaMint(mint) in STELLAR_SOLANA_MAPPINGS[network].solanaToStellar;
}

/**
 * Assert that `stellarAsset` maps to a known Solana mint on `network`.
 * Throws {@link UnsupportedAssetError} if not.
 */
export function assertSupportedStellarToSolana(
  stellarAsset: string | CanonicalStellarAsset,
  network: AssetMappingNetwork = "testnet",
): void {
  if (!isSupportedStellarToSolana(stellarAsset, network)) {
    throw new UnsupportedAssetError(
      normalizeStellarAssetKey(stellarAsset),
      network,
      "stellar→solana",
    );
  }
}

/**
 * Assert that `mint` maps to a known Stellar asset on `network`.
 * Throws {@link UnsupportedAssetError} if not.
 */
export function assertSupportedSolanaToStellar(
  mint: string,
  network: AssetMappingNetwork = "testnet",
): void {
  if (!isSupportedSolanaToStellar(mint, network)) {
    throw new UnsupportedAssetError(normalizeSolanaMint(mint), network, "solana→stellar");
  }
}

/**
 * Resolve a Stellar asset to its canonical Solana mint on `network`.
 * Falls back to the native SOL asset when no mapping exists.
 */
export function resolveSolanaAssetFromStellar(
  stellarAsset: string | CanonicalStellarAsset,
  network: AssetMappingNetwork = "testnet",
): CanonicalSolanaAsset {
  const key = normalizeStellarAssetKey(stellarAsset);
  return STELLAR_SOLANA_MAPPINGS[network].stellarToSolana[key] ?? NATIVE_SOL_ASSET;
}

/**
 * Resolve a Solana mint to its canonical Stellar asset on `network`.
 * Falls back to the native XLM asset when no mapping exists.
 */
export function resolveStellarAssetFromSolana(
  mint: string,
  network: AssetMappingNetwork = "testnet",
): CanonicalStellarAsset {
  return STELLAR_SOLANA_MAPPINGS[network].solanaToStellar[normalizeSolanaMint(mint)] ?? NATIVE_STELLAR_ASSET;
}

/**
 * Return all Stellar asset keys that have a stellar→solana mapping on `network`.
 */
export function getSupportedStellarToSolana(
  network: AssetMappingNetwork = "testnet",
): string[] {
  return Object.keys(STELLAR_SOLANA_MAPPINGS[network].stellarToSolana);
}

/**
 * Return all Solana mint addresses that have a solana→stellar mapping on `network`.
 */
export function getSupportedSolanaToStellar(
  network: AssetMappingNetwork = "testnet",
): string[] {
  return Object.keys(STELLAR_SOLANA_MAPPINGS[network].solanaToStellar);
}

// ── Canonical asset identity ──────────────────────────────────────────────────

/**
 * Produce the canonical cross-service asset identifier for a given chain and
 * token.  The format matches the frontend's `NormalizedAsset.canonicalId` so
 * all services emit the same string for the same asset.
 *
 * Format:
 *  - Native assets:   `<chain>:native:<SYMBOL>`     e.g. `ethereum:native:ETH`
 *  - Contract assets: `<chain>:contract:<SYMBOL>:<address_lowercase>`
 *
 * @param chain   The chain the asset lives on.
 * @param symbol  Token symbol (will be upper-cased).
 * @param address Contract address (EVM) or mint address (Solana).
 *                Pass `undefined` or omit for native assets.
 */
export function toCanonicalId(
  chain: "ethereum" | "stellar" | "solana",
  symbol: string,
  address?: string,
): string {
  const sym = symbol.toUpperCase();
  if (!address) return `${chain}:native:${sym}`;
  return `${chain}:contract:${sym}:${address.toLowerCase()}`;
}
