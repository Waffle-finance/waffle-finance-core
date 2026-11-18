# WaffleFinance Feature Flags

Experimental features and partially supported chains are gated behind explicit
feature flags. This prevents accidental exposure of unstable functionality to
production users and makes it clear which flows are still under development.

## Available Flags

| Flag | Environment Variable | Default | Description |
|------|---------------------|---------|-------------|
| `solanaSimulationMode` | `FEATURE_SOLANA_SIMULATION_MODE` / `VITE_FEATURE_SOLANA_SIMULATION_MODE` | `false` | Enables Solana simulation/mock mode for testing settlement flows without a real on-chain program. |
| `sorobanEarlySupport` | `FEATURE_SOROBAN_EARLY_SUPPORT` / `VITE_FEATURE_SOROBAN_EARLY_SUPPORT` | `false` | Enables early Soroban chain support (experimental routes and contract bindings). |
| `experimentalUiRoutes` | `FEATURE_EXPERIMENTAL_UI_ROUTES` / `VITE_FEATURE_EXPERIMENTAL_UI_ROUTES` | `false` | Enables experimental UI routes and features not yet ready for production users. |

## Usage

### Backend services (coordinator, relayer, resolver)

Set the corresponding `FEATURE_*` environment variable in your `.env` file or
deployment secrets:

```bash
FEATURE_SOLANA_SIMULATION_MODE=true
FEATURE_SOROBAN_EARLY_SUPPORT=false
FEATURE_EXPERIMENTAL_UI_ROUTES=false
```

Access flags via the parsed config:

```ts
import { loadRelayerConfig } from '@wafflefinance/config/node';

const config = loadRelayerConfig();
if (config.featureFlags.solanaSimulationMode) {
  // enable mock settlement flow
}
```

### Frontend

Set the corresponding `VITE_FEATURE_*` environment variable in your `.env` file
or Vite deployment config:

```bash
VITE_FEATURE_SOLANA_SIMULATION_MODE=true
VITE_FEATURE_SOROBAN_EARLY_SUPPORT=false
VITE_FEATURE_EXPERIMENTAL_UI_ROUTES=false
```

Access flags via the frontend config:

```ts
import { frontendConfig } from '@wafflefinance/config';

if (frontendConfig.featureFlags.solanaSimulationMode) {
  // show simulation UI
}
```

## Gating Rules

- **Build-time**: Frontend flags are baked into the Vite bundle via
  `loadFrontendConfig()`. Disabling a flag removes the associated code paths
  from the production bundle.
- **Runtime**: Backend flags are parsed at startup from environment variables.
  Services refuse to start experimental flows unless the flag is explicitly
  enabled.
- **Default**: All experimental flags default to `false`. Misconfigured
  environments do not expose unstable functionality.

## Mainnet feature-flag verification table

The following flags and env vars gate mainnet access. All default to off and
must remain so until an independent security audit has been completed and
signed off (see [`.github/RELEASE_CHECKLIST.md` §5](../.github/RELEASE_CHECKLIST.md)).

| Flag / env var | Consumer(s) | Default | Source type | Release owner |
|---|---|---|---|---|
| `VITE_MAINNET_ENABLED` | Frontend (`packages/config/src/index.ts` → `frontendConfig.mainnetEnabled`; evaluated in `frontend/src/config/networks.ts`) | `false` (unset) | Build-time — Vite inlines this at compile time; changing it requires a production rebuild | Frontend |
| `NETWORK_MODE` | Resolver (`resolver/src/config.ts`), Relayer (`relayer/src/config-validator.ts`) | `testnet` | Runtime — parsed from process environment at startup | Infrastructure / Ops |
| `SOROBAN_HTLC_MAINNET` | Relayer (`relayer/src/config-validator.ts` — required when `NETWORK_MODE=mainnet`) | unset | Runtime — must be populated with the audited mainnet contract address before mainnet traffic | Infrastructure / Ops |
| `RELAYER_STELLAR_SECRET_MAINNET` | Relayer (`relayer/src/routes/orders.ts`) | unset | Runtime — signing key for mainnet Stellar transactions; populate only in a secure secrets store | Security / Ops |

**Key rules:**

- `VITE_MAINNET_ENABLED` being absent or `'false'` is the static assertion
  that the mainnet UI path is disabled by default. The frontend test
  `frontend/src/config/networks.test.ts` verifies this: it asserts that the
  flag evaluates to `false` when the env var is unset in a Vitest run. Run
  `pnpm --filter @wafflefinance/frontend test` to confirm the default holds.
- `NETWORK_MODE=mainnet` in resolver or relayer config is a deliberate
  runtime switch — it is never a default and must not appear in any testnet
  deployment's env file.
- No flag listed here controls settlement on-chain; the HTLC contracts
  enforce settlement independently. These flags gate the off-chain services
  that route traffic to mainnet contracts.

## Adding a New Feature Flag

1. Add the flag to `featureFlagsSchema` in `packages/config/src/schema.ts`.
2. Map the env var in `packages/config/src/node.ts` (backend) and
   `packages/config/src/index.ts` (frontend).
3. Document the flag in this file and in the relevant `.env.example`.
4. Gate the experimental code path behind the flag using `isFeatureEnabled()`
   or direct config access.
