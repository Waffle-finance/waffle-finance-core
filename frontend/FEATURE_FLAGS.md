# Feature Flags

The frontend uses a **declarative, typed feature-flag system** to gate experimental
and optional functionality safely during phased rollouts.

## How it works

Every flag is declared **once** in the `FEATURE_FLAG_REGISTRY` inside
`src/config/feature-flags.ts`. The registry is the single source of truth —
adding a flag to the registry automatically extends the `FeatureFlagSet` type and
makes the flag available everywhere via `featureFlags` or the selectors in
`src/config/selectors.ts`.

## Evaluation (deterministic)

At module load time, all flags are evaluated once and frozen. The evaluation
order is:

1. **Env-var override** — If `VITE_FEATURE_<KEY>` is set to `'true'` or `'false'`,
   that value wins unconditionally. This lets operators force a flag on or off
   in any environment without code changes.

2. **Build-mode default** — When no env var is present:
   - **Development** (`import.meta.env.DEV`): all flags default to `true`.
   - **Production** (`import.meta.env.PROD`): each flag uses its declared
     `productionDefault` from the registry.

3. **Phase gate** — A flag in phase `'deprecated'` is always `false` regardless
   of other settings.

## Rollout phases

| Phase          | Meaning                                                   |
| -------------- | --------------------------------------------------------- |
| `development`  | Only enabled in local dev. Not expected in testnet/prod.  |
| `testnet`      | Enabled on testnet deployments, gated in production.       |
| `production`   | Safe for all environments. Can be enabled in production.   |
| `deprecated`   | Permanently disabled. Retained for audit trail.            |

## Current flags

| Flag                    | Phase         | Production default | Description                                    |
| ----------------------- | ------------- | ------------------ | ---------------------------------------------- |
| `faucetEnabled`         | `testnet`     | `false`            | Testnet faucet UI component                    |
| `historyStreamEnabled`  | `testnet`     | `false`            | Real-time transaction history stream           |
| `refundFlowEnabled`     | `testnet`     | `false`            | Permissionless refund dialog                   |
| `solanaRoutesEnabled`   | `development` | `false`            | Solana bridge routes (simulation mode)         |
| `introAnimationEnabled` | `production`  | `true`             | Branded intro animation on first visit         |
| `darkVeilEnabled`       | `production`  | `true`             | Dark-veil WebGL background effect              |
| `claimFallbackEnabled`  | `testnet`     | `false`            | Direct on-chain claim when coordinator is down |

## Adding a new flag

1. Add an entry to `FEATURE_FLAG_REGISTRY` in `src/config/feature-flags.ts`:
   ```typescript
   myNewFeature: {
     key: 'myNewFeature',
     description: 'What this flag gates.',
     owner: 'frontend',
     phase: 'testnet',
     productionDefault: false,
   },
   ```
2. Add a selector in `src/config/selectors.ts`:
   ```typescript
   export function selectMyNewFeatureEnabled(): boolean {
     return featureFlags.myNewFeature;
   }
   ```
3. Add the `VITE_FEATURE_MY_NEW_FEATURE` env var to `src/types/global.d.ts`.
4. Wire it into the relevant component:
   ```tsx
   import { selectMyNewFeatureEnabled } from '../../config/selectors';
   
   const enabled = selectMyNewFeatureEnabled();
   if (!enabled) return null;
   ```
5. Add or update tests in `src/config/feature-flags.test.ts`.
6. Add tests for the component's gated behavior.

## Overriding in production

To enable a flag in production without a redeploy (using Vite env vars at build
time — Vite inlines `VITE_*` vars at compile time, so they require a rebuild):

```bash
VITE_FEATURE_SOLANA_ROUTES_ENABLED=true pnpm build
```

For runtime-configurable flags (future), use a different mechanism like a URL
parameter or an API-fetched config, but the evaluation function in
`feature-flags.ts` will still be the single integration point.

## Logging

On first evaluation, the resolved flag set is logged at `console.debug` level so
operators can inspect which flags are active in the browser console during
development. In production builds, `console.debug` is stripped by Vite's esbuild
config (`vite.config.ts` → `esbuild.drop`).

## Deterministic behavior

- Flags are evaluated **once** at module load time and the result is frozen with
  `Object.freeze()`.
- The same input (env vars, build mode) always produces the same output.
- Flags cannot be mutated at runtime — this is intentional to prevent accidental
  state changes and to make the system simple to reason about.
