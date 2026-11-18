# Asset Mapping Contract

## Overview

This document defines the canonical source of truth for asset metadata and mappings across chains in the WaffleFinance cross-chain bridge.

## Canonical Asset Identifiers

Order payloads and contract calls must use chain-local canonical identifiers:

- **Ethereum addresses** are `0x`-prefixed 20-byte hex strings. The SDK
  canonical form is lowercase for mapping keys and canonical-id serialization.
- **Stellar assets** are `XLM` for native XLM or `CODE:G...ISSUER` for issued
  assets. Asset codes are uppercase alphanumeric and at most 12 characters.
- **Solana mints** are base58 public keys and are case-sensitive. Never
  lowercase a Solana mint.

Use `assertCanonicalEthereumAddress`, `assertCanonicalStellarAssetKey`,
`assertCanonicalSolanaMint`, or `toCanonicalId` when building payloads that
will reach a contract layer. These throw `InvalidAssetIdentifierError` before
an ambiguous value can be mapped to the wrong chain.

### Native Assets

- **Ethereum**: `0x0000000000000000000000000000000000000000` (NATIVE_ETH_ADDRESS)
- **Stellar**: `{ code: "XLM" }` (NATIVE_STELLAR_ASSET)
- **Solana**: `So11111111111111111111111111111111111111112` (NATIVE_SOL_MINT)

### Supported Asset Mappings

#### Testnet Mappings

**Ethereum → Stellar**
- Native ETH → Native XLM
- `0xa0b86a33e6417c4fd30ad9d05d6b9b7cd6dd11b` → USDC (`USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`)

**Stellar → Ethereum**
- Native XLM → Native ETH
- USDC (`USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`) → `0xa0b86a33e6417c4fd30ad9d05d6b9b7cd6dd11b`

**Ethereum → Solana**
- Native ETH → Native SOL
- `0xa0b86a33e6417c4fd30ad9d05d6b9b7cd6dd11b` → USDC (`4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`)

**Solana → Ethereum**
- Native SOL → Native ETH
- USDC (`4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`) → `0xa0b86a33e6417c4fd30ad9d05d6b9b7cd6dd11b`

#### Mainnet Mappings

**Ethereum → Stellar**
- Native ETH → Native XLM

**Stellar → Ethereum**
- Native XLM → Native ETH

**Ethereum → Solana**
- Native ETH → Native SOL

**Solana → Ethereum**
- Native SOL → Native ETH

## Usage Guidelines

### 1. Always Normalize Before Lookup

```typescript
import { normalizeEthereumAddress, normalizeStellarAssetKey, normalizeSolanaMint } from '@wafflefinance/sdk';

// Ethereum addresses are case-insensitive
const normalizedEth = normalizeEthereumAddress(userInput);

// Stellar assets use CODE:ISSUER format
const normalizedStellar = normalizeStellarAssetKey({ code: "USDC", issuer: "..." });

// Solana mints are case-sensitive but should be trimmed
const normalizedSolana = normalizeSolanaMint(userInput);
```

Normalization is not validation. For settlement-bound payloads, validate the
normalized value with the corresponding `assertCanonical*` helper and use the
throwing `assertSupported*` mapping guard before calling a lenient resolver.

### 2. Check Support Before Resolving

```typescript
import { 
  isSupportedEthToStellar, 
  assertSupportedEthToStellar,
  UnsupportedAssetError 
} from '@wafflefinance/sdk';

// Non-throwing check
if (isSupportedEthToStellar(tokenAddress, network)) {
  const stellarAsset = resolveStellarAsset(tokenAddress, network);
}

// Throwing check for strict validation
try {
  assertSupportedEthToStellar(tokenAddress, network);
  const stellarAsset = resolveStellarAsset(tokenAddress, network);
} catch (err) {
  if (err instanceof UnsupportedAssetError) {
    // Handle unsupported asset explicitly
  }
}
```

### 3. Use Lenient Resolvers for Backward Compatibility

The original `resolve*` functions provide silent fallback to native assets for unknown inputs. Use these when you want graceful degradation:

```typescript
import { resolveStellarAsset } from '@wafflefinance/sdk';

// Returns native XLM for unknown Ethereum addresses
const stellarAsset = resolveStellarAsset(unknownAddress, network);
```

### 4. Get Supported Assets for UI

```typescript
import { getSupportedEthereumAddresses, getSupportedStellarAssets } from '@wafflefinance/sdk';

// Build token selector dropdowns
const ethTokens = getSupportedEthereumAddresses('stellar', 'testnet');
const stellarAssets = getSupportedStellarAssets('testnet');
```

## Adding New Asset Mappings

To add a new asset mapping:

1. **Add to the mapping tables** in `packages/sdk/src/assets/index.ts`
2. **Add corresponding tests** in `packages/sdk/test/assets.test.ts`
3. **Update this document** with the new mapping
4. **Ensure round-trip consistency** by testing both directions

## Network-Specific Behavior

- **Testnet**: Includes additional test tokens (e.g., USDC on Sepolia/devnet)
- **Mainnet**: Currently only supports native assets (ETH/XLM/SOL)
- Mappings are network-aware; an asset mapped on testnet may not be available on mainnet

## Error Handling

When an asset is not supported:

- Use `isSupported*()` guards to check before operations
- Use `assertSupported*()` for strict validation that throws `UnsupportedAssetError`
- The error includes the asset identifier, network, and direction for debugging
- Use `assertCanonical*()` for malformed identifiers; these throw
  `InvalidAssetIdentifierError` before mapping lookup

## Testing

Run asset mapping tests:

```bash
cd packages/sdk
npm test
```

Tests cover:
- Normalization functions
- Support checks for all directions
- Assertion functions and error types
- Round-trip consistency
- Network-specific behavior
- Edge cases (whitespace, mixed case, unknown assets)
