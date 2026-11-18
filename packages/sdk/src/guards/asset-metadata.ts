/**
 * Runtime guard for asset metadata (#733).
 *
 * The gap
 * ───────
 * `assets/index.ts` models an asset as:
 *
 * ```ts
 * interface CanonicalStellarAsset { code: string; issuer?: string }
 * interface CanonicalSolanaAsset   { mint: string; symbol: string }
 * ```
 *
 * and resolves them with `resolveStellarAsset(ethereumTokenAddress, network)`.
 * Three things are unstated in those types and all three cause real bugs:
 *
 * 1. **`code` is not any string.** A Stellar asset code is 1–5 characters from
 *    `A–Z0–9`. A lowercase or 6-character code names an asset that does not
 *    exist on the ledger, and the SDK returns it happily because the return
 *    type says `string`.
 * 2. **`issuer` is optional, so `{ code: "USDC" }` type-checks** — and that
 *    is a *different asset* from `USDC:<issuer>`. The whole point of an
 *    issued asset is the issuer; a missing one silently resolves to "no
 *    issuer", which for a fungible token is a different (or nonexistent)
 *    asset.
 * 3. **`symbol` has no relationship to `mint`.** `resolveSolanaAsset` falls
 *    back to `NATIVE_SOL_ASSET` for an unknown mint, so a caller that trusts
 *    the symbol alone can label an arbitrary token "SOL".
 *
 * Why new types rather than edits to `assets/index.ts`
 * ────────────────────────────────────────────────────
 * `CanonicalStellarAsset` and `CanonicalSolanaAsset` are exported from the
 * package and consumed by `routes/index.ts` (`tokenGroupForAsset`) and by the
 * frontend. `tokenGroupForAsset` switches on the exact strings `"XLM"` and
 * `"USDC:GBBD47…"`, so narrowing `code` to a literal union there would ripple
 * straight through the route registry. Adding `decimals` to the interfaces
 * would break every hand-built literal.
 *
 * `AssetMetadata` below is therefore additive: an opt-in, fully-validated
 * description of an asset that carries the information the loose types omit.
 *
 * `decimals` is the important omission. The bridge never needs a token's
 * decimal count to move atomic units correctly — which is exactly why it is
 * dangerous not to have one: a UI rendering "1.5 USDC" from an atomic amount
 * has to guess, and a wrong guess is a wrong balance. A contract-asset
 * record that does not state `decimals` is rejected; only the three
 * chain-native assets may omit it, because their decimals are protocol
 * constants (ETH 18, XLM 7, SOL 9) rather than token metadata.
 */

import {
  NATIVE_ETH_ADDRESS,
  NATIVE_SOL_ASSET,
  NATIVE_SOL_MINT,
  NATIVE_STELLAR_ASSET,
  toCanonicalId,
  type AssetMappingNetwork,
  type CanonicalSolanaAsset,
  type CanonicalStellarAsset,
} from '../assets/index.js';
import { SUPPORTED_CHAINS } from '../routes/index.js';
import type { Chain } from '../types/index.js';
import { assertGuard, GuardIssueCollector, type GuardResult } from './result.js';
import {
  parseChainAddress,
  type ChainAddress,
  type EvmAddress,
  type SolanaAddress,
  type StellarAccountId,
} from './branded.js';

// ── Types ───────────────────────────────────────────────────────────────────

/** How an asset's canonical identifier is formed. */
export type AssetKind = 'native' | 'contract';

/**
 * A fully-described asset.
 *
 * Every field is required — that is the point. There is no shape in this
 * type that leaves the decimals, the issuer, or the address unspecified.
 */
export interface AssetMetadata {
  /** Chain the asset is held on. */
  readonly chain: Chain;
  readonly kind: AssetKind;
  /** Upper-case ticker, 1–10 characters, `[A-Z0-9]`. */
  readonly symbol: string;
  /**
   * Decimal places of the asset's human unit, 0–36.
   *
   * `null` is permitted **only** for a chain-native asset, whose decimals
   * are a protocol constant rather than a property of a deployed token.
   */
  readonly decimals: number | null;
  /**
   * Chain-native placeholder, or the contract / mint / issuer address.
   *
   * Ethereum: the ERC20 address (the all-zero address for native ETH).
   * Stellar:  the issuing account for a classic asset. Native XLM has no
   *           issuer and uses the all-zero placeholder.
   * Solana:   the SPL mint (`So111…112` for native SOL).
   */
  readonly address: ChainAddress;
  /**
   * Stellar issuer, for classic assets. `null` for a Stellar contract asset,
   * for native XLM, and for every non-Stellar chain.
   */
  readonly issuer: StellarAccountId | null;
  /** Networks the asset is mapped on, as `assets/index.ts` knows it. */
  readonly networks: readonly AssetMappingNetwork[];
}

// ── Constants ───────────────────────────────────────────────────────────────

/** The all-zero address `assets/index.ts` uses as the native-ETH placeholder. */
const NATIVE_ETH_PLACEHOLDER = '0x0000000000000000000000000000000000000000' as EvmAddress;

/**
 * The all-zero placeholder used for native XLM, which has no contract.
 *
 * Stellar cannot represent "no account" as an address, so the SDK models
 * native XLM as `{ code: "XLM" }` with no issuer at all. A validated
 * `AssetMetadata` still needs *some* address, and the all-zero string is the
 * only value that cannot collide with a real account id.
 */
const NATIVE_STELLAR_PLACEHOLDER = '0'.repeat(56);

/** Decimals of each chain's native asset. Fixed by the protocol, not metadata. */
export const NATIVE_ASSET_DECIMALS: Readonly<Record<Chain, number>> = {
  ethereum: 18,
  stellar: 7,
  solana: 9,
};

/** Ticker for each chain's native asset. */
export const NATIVE_ASSET_SYMBOLS: Readonly<Record<Chain, string>> = {
  ethereum: 'ETH',
  stellar: 'XLM',
  solana: 'SOL',
};

/** The placeholder address a chain's native asset uses, if it has one. */
export function nativePlaceholderFor(chain: Chain): string {
  if (chain === 'ethereum') return NATIVE_ETH_ADDRESS;
  if (chain === 'solana') return NATIVE_SOL_MINT;
  return NATIVE_STELLAR_PLACEHOLDER;
}

/** Stellar asset codes: 1–5 characters, uppercase alphanumeric. */
const STELLAR_CODE = /^[A-Z0-9]{1,5}$/;

/** Ticker symbols as the bridge uses them: 1–10 uppercase alphanumeric. */
const SYMBOL = /^[A-Z0-9]{1,10}$/;

const NETWORKS: readonly AssetMappingNetwork[] = ['testnet', 'mainnet'];

// ── Guard ───────────────────────────────────────────────────────────────────

/**
 * Validate an asset descriptor supplied by a caller, a deep link, or a
 * coordinator response.
 *
 * The input is `unknown`, so this is safe to point at anything decoded from
 * JSON. On success the value is narrowed to {@link AssetMetadata} — the
 * caller gets no cast.
 */
export function validateAssetMetadata(input: unknown): GuardResult<AssetMetadata> {
  const issues = new GuardIssueCollector();

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return issues.add('asset', 'must be an object').finish(undefined as unknown as AssetMetadata);
  }
  const record = input as Record<string, unknown>;

  // ── chain ───────────────────────────────────────────────────────────────
  const chain = record['chain'];
  if (typeof chain !== 'string' || !SUPPORTED_CHAINS.includes(chain as Chain)) {
    issues.add('asset.chain', `must be one of: ${SUPPORTED_CHAINS.join(', ')}`);
  }
  const knownChain =
    typeof chain === 'string' && SUPPORTED_CHAINS.includes(chain as Chain)
      ? (chain as Chain)
      : undefined;

  // ── kind ────────────────────────────────────────────────────────────────
  const kind = record['kind'];
  if (kind !== 'native' && kind !== 'contract') {
    issues.add('asset.kind', 'must be "native" or "contract"');
  }

  // ── symbol ──────────────────────────────────────────────────────────────
  const symbol = record['symbol'];
  if (typeof symbol !== 'string' || !SYMBOL.test(symbol)) {
    issues.add('asset.symbol', 'must be 1–10 uppercase alphanumeric characters');
  }

  // ── decimals ────────────────────────────────────────────────────────────
  const decimals = record['decimals'];
  if (decimals === null) {
    if (kind !== 'native') {
      issues.add(
        'asset.decimals',
        'must be an integer 0–36 for a contract asset; a null here is only valid for a chain-native asset'
      );
    }
  } else if (
    typeof decimals !== 'number' ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 36
  ) {
    issues.add('asset.decimals', 'must be null (native assets only) or an integer 0–36');
  }

  // ── address ─────────────────────────────────────────────────────────────
  let address: ChainAddress | undefined;
  const rawAddress = record['address'];
  const expectedNative = knownChain === undefined ? null : nativePlaceholderFor(knownChain);
  const looksLikeNativePlaceholder =
    typeof rawAddress === 'string' &&
    expectedNative !== null &&
    rawAddress.toLowerCase() === expectedNative.toLowerCase();

  if (typeof rawAddress !== 'string') {
    issues.add('asset.address', 'must be a string');
  } else if (knownChain === undefined) {
    // chain is already reported as invalid; do not pile on
  } else if (looksLikeNativePlaceholder) {
    // `parseChainAddress` rejects the all-zero address as a counterparty,
    // which is right for an order leg and wrong for an asset id, so the
    // placeholder is accepted here explicitly.
    address = rawAddress.toLowerCase() as ChainAddress;
  } else {
    const parsed = parseChainAddress(knownChain, rawAddress, 'asset.address');
    if (parsed.ok) {
      address = parsed.value;
    } else {
      for (const issue of parsed.issues) issues.add(issue.field, issue.message);
    }
  }

  // Native assets must point at their chain's placeholder and contract
  // assets must not. Getting this backwards is exactly what lets a UI
  // render "1.5 SOL" for an arbitrary SPL token.
  if (address !== undefined && expectedNative !== null) {
    if (kind === 'native' && !looksLikeNativePlaceholder) {
      issues.add(
        'asset.address',
        `a native ${knownChain as Chain} asset must use the placeholder address ${expectedNative}`
      );
    }
    if (kind === 'contract' && looksLikeNativePlaceholder) {
      issues.add('asset.address', 'a contract asset must not use the native placeholder address');
    }
  }

  // ── issuer ──────────────────────────────────────────────────────────────
  let issuer: StellarAccountId | null = null;
  const rawIssuer = record['issuer'];
  if (rawIssuer === null || rawIssuer === undefined) {
    // No issuer is correct for a non-Stellar asset and for native XLM. It is
    // wrong for a Stellar contract asset, whose address is the contract id
    // and whose *issuer* field is not applicable either — so this is fine.
  } else {
    if (knownChain !== undefined && knownChain !== 'stellar') {
      issues.add('asset.issuer', `only a Stellar asset has an issuer (got chain "${knownChain}")`);
    }
    const parsed = parseChainAddress('stellar', rawIssuer, 'asset.issuer');
    if (!parsed.ok) {
      for (const issue of parsed.issues) issues.add(issue.field, issue.message);
    } else {
      issuer = parsed.value as StellarAccountId;
    }
  }

  // ── networks ────────────────────────────────────────────────────────────
  const networks = record['networks'];
  if (!Array.isArray(networks) || networks.length === 0) {
    issues.add('asset.networks', 'must be a non-empty array');
  } else {
    networks.forEach((network, index) => {
      if (!NETWORKS.includes(network as AssetMappingNetwork)) {
        issues.add(`asset.networks[${index}]`, `must be one of: ${NETWORKS.join(', ')}`);
      }
    });
  }

  if (issues.length > 0) return { ok: false, issues: issues.list() };

  return {
    ok: true,
    value: {
      chain: knownChain as Chain,
      kind: kind as AssetKind,
      symbol: symbol as string,
      decimals: (decimals as number | null) ?? null,
      address: address as ChainAddress,
      issuer,
      networks: [...(networks as AssetMappingNetwork[])],
    },
  };
}

/** Assertion form of {@link validateAssetMetadata}. */
export function assertAssetMetadata(input: unknown): AssetMetadata {
  return assertGuard(validateAssetMetadata(input), 'asset metadata');
}

// ── Constructors from the SDK's own constants ───────────────────────────────

/**
 * Build validated metadata for a chain-native asset.
 *
 * Every value comes from the SDK's own constants (`NATIVE_ETH_ADDRESS`,
 * `NATIVE_STELLAR_ASSET`, `NATIVE_SOL_MINT`) so the result cannot drift from
 * `assets/index.ts`.
 */
export function nativeAssetMetadata(
  chain: Chain,
  networks: readonly AssetMappingNetwork[]
): GuardResult<AssetMetadata> {
  const address =
    chain === 'ethereum'
      ? NATIVE_ETH_PLACEHOLDER
      : chain === 'solana'
        ? (NATIVE_SOL_MINT.toLowerCase() as SolanaAddress)
        : (NATIVE_STELLAR_PLACEHOLDER as ChainAddress);
  return validateAssetMetadata({
    chain,
    kind: 'native',
    symbol: NATIVE_ASSET_SYMBOLS[chain],
    decimals: NATIVE_ASSET_DECIMALS[chain],
    address,
    issuer: null,
    networks: [...networks],
  });
}

/**
 * Build validated metadata for a Stellar asset from the SDK's
 * `CanonicalStellarAsset` (or a `"CODE:ISSUER"` key).
 *
 * Rejects a classic asset whose `code` is not a legal Stellar asset code and
 * an issued asset with no issuer — both of which the loose type allows.
 */
export function stellarAssetMetadata(
  asset: CanonicalStellarAsset | string,
  networks: readonly AssetMappingNetwork[],
  /** Token decimals. Defaults to 7 for a classic asset; native XLM ignores it. */
  decimals = 7
): GuardResult<AssetMetadata> {
  const key =
    typeof asset === 'string' ? asset : asset.issuer ? `${asset.code}:${asset.issuer}` : asset.code;
  const code = key.split(':')[0] ?? '';
  const issuerPart = key.split(':')[1];

  if (code === NATIVE_STELLAR_ASSET.code && !issuerPart) {
    return nativeAssetMetadata('stellar', networks);
  }
  if (!STELLAR_CODE.test(code)) {
    return {
      ok: false,
      issues: [
        {
          field: 'asset.code',
          message: `"${code}" is not a valid Stellar asset code (1–5 uppercase alphanumeric characters)`,
        },
      ],
    };
  }
  if (!issuerPart) {
    return {
      ok: false,
      issues: [
        {
          field: 'asset.issuer',
          message: `issued asset "${code}" has no issuer; a classic asset is identified by "CODE:ISSUER"`,
        },
      ],
    };
  }

  const parsedAddress = parseChainAddress('stellar', issuerPart, 'asset.address');
  if (!parsedAddress.ok) return { ok: false, issues: parsedAddress.issues };

  return validateAssetMetadata({
    chain: 'stellar',
    kind: 'contract',
    symbol: code,
    decimals,
    address: issuerPart,
    issuer: issuerPart,
    networks: [...networks],
  });
}

/**
 * Build validated metadata for a Solana asset from the SDK's
 * `CanonicalSolanaAsset`.
 *
 * `decimals` is a required argument for a non-native asset: SPL mints carry
 * their decimals on-chain and the SDK cannot read them without an RPC call,
 * so a caller that does not know them has not described the asset.
 */
export function solanaAssetMetadata(
  asset: CanonicalSolanaAsset,
  networks: readonly AssetMappingNetwork[],
  decimals?: number
): GuardResult<AssetMetadata> {
  if (asset.mint === NATIVE_SOL_ASSET.mint) {
    return nativeAssetMetadata('solana', networks);
  }
  if (!SYMBOL.test(asset.symbol)) {
    return {
      ok: false,
      issues: [
        {
          field: 'asset.symbol',
          message: `"${asset.symbol}" is not 1–10 uppercase alphanumeric characters`,
        },
      ],
    };
  }
  if (decimals === undefined) {
    return {
      ok: false,
      issues: [
        {
          field: 'asset.decimals',
          message:
            "an SPL mint's decimals live on-chain; read them from the mint account and pass them in",
        },
      ],
    };
  }
  return validateAssetMetadata({
    chain: 'solana',
    kind: 'contract',
    symbol: asset.symbol,
    decimals,
    address: asset.mint,
    issuer: null,
    networks: [...networks],
  });
}

// ── Canonical-id cross-check ────────────────────────────────────────────────

/**
 * Verify that a validated `AssetMetadata` yields the canonical id that the
 * frontend and the coordinator agree on (`assets/index.ts` `toCanonicalId`).
 *
 * The interesting failure this catches is a *native* asset whose symbol or
 * address does not match the SDK's own constant — a hand-built descriptor
 * that then renders as a different token in the UI than the one the route
 * registry will actually move.
 */
export function validateCanonicalId(metadata: AssetMetadata): GuardResult<string> {
  const issues = new GuardIssueCollector();

  if (metadata.kind === 'native') {
    // `toCanonicalId` picks the `contract:` form whenever an address is
    // supplied, and a native asset's address is a placeholder rather than a
    // real contract. The canonical native form is therefore produced with no
    // address at all — which is what the frontend's `NormalizedAsset
    // .canonicalId` does.
    const expected = toCanonicalId(metadata.chain, metadata.symbol);
    const canonical = toCanonicalId(metadata.chain, NATIVE_ASSET_SYMBOLS[metadata.chain]);
    if (expected !== canonical) {
      issues.add(
        'asset',
        `native ${metadata.chain} asset must yield the canonical id "${canonical}" (got "${expected}")`
      );
    }
    if (issues.length > 0) return { ok: false, issues: issues.list() };
    return { ok: true, value: expected };
  }

  const expected = toCanonicalId(metadata.chain, metadata.symbol, metadata.address);
  return { ok: true, value: expected };
}
