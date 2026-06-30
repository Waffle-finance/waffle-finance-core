# @wafflefinance/frontend

Frontend interface for WaffleFinance cross-chain token swaps.

## Build-time feature flags

Vite resolves one typed, immutable feature configuration when the frontend bundle is built.
Application code reads `featureFlags` from `src/config/feature-flags.ts`; browser runtime
environment checks are not used for feature availability.

`VITE_DEPLOYMENT_ENV` accepts `local`, `test`, or `production`. When it is omitted, Vite's
`development` mode maps to `local`, `test` maps to `test`, and `production` maps to `production`.
Other Vite modes use the safe `local` defaults unless `VITE_DEPLOYMENT_ENV` is set explicitly.

| Typed flag       | Environment variable           | Local | Test | Production |
| ---------------- | ------------------------------ | ----: | ---: | ---------: |
| `mainnet`        | `VITE_FEATURE_MAINNET`         |   off |  off |        off |
| `testnetFaucets` | `VITE_FEATURE_TESTNET_FAUCETS` |    on |   on |        off |
| `debugMode`      | `VITE_FEATURE_DEBUG_MODE`      |    on |  off |        off |
| `mockData`       | `VITE_FEATURE_MOCK_DATA`       |   off |  off |        off |

Each flag can be overridden for a build with exactly `true` or `false`; invalid values fail the
build instead of being silently coerced. For example:

```bash
VITE_DEPLOYMENT_ENV=test VITE_FEATURE_MOCK_DATA=true pnpm build
```

`VITE_MAINNET_ENABLED`, `VITE_ENABLE_TESTNET_FAUCETS`, `VITE_ENABLE_DEBUG_MODE`, and
`VITE_ENABLE_MOCK_DATA` remain supported as migration aliases. When both forms are present, the
canonical `VITE_FEATURE_*` variable wins.

## Soroban Smart Contract Integration

When integrating with the Soroban HTLC contract, please refer to the formal IDL documentation and account schema reference located in the main `soroban` workspace:

[Soroban HTLC IDL Reference](../../soroban/docs/HTLC_IDL.md)

This IDL is critical for understanding the structure of `Order` data, order statuses, and entrypoints.
