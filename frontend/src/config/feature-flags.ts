/**
 * Declarative feature-flag system for the frontend.
 *
 * ## Design
 *
 * Every feature flag is declared **once** in the `FEATURE_FLAG_REGISTRY` with
 * metadata that fully describes its purpose, owner, rollout phase, and default
 * values per deployment environment. The registry is the single source of truth
 * — any flag not declared here cannot be evaluated.
 *
 * ## Evaluation order (deterministic)
 *
 * 1. **Explicit env-var override.** If `VITE_FEATURE_<KEY>` is set to `'true'`
 *    or `'false'`, that value wins unconditionally. This lets operators force a
 *    flag on/off in any environment without a redeploy (if using Vite env vars
 *    at build time) or via runtime config.
 *
 * 2. **Build-mode default.** When no env var is present, the flag receives its
 *    default for the current build mode:
 *      - Development (`import.meta.env.DEV`): all flags default to `true`
 *        (fast iteration).
 *      - Production  (`import.meta.env.PROD`): each flag uses its declared
 *        `productionDefault` (conservative rollout).
 *
 * 3. **Phase gate.** A flag in phase `'deprecated'` is always `false` regardless
 *    of other settings. This is a belt-and-suspenders safety net for flags that
 *    should never be re-enabled.
 *
 * ## Rollout phases
 *
 * - `development`: Only enabled in local dev. Not expected in testnet or production.
 * - `testnet`:     Enabled on testnet deployments, gated in production.
 * - `production`:  Safe for all environments. Enabled in production once rolled out.
 * - `deprecated`:  Permanently disabled. Retained in the registry for audit trail.
 *
 * ## Logging / observability
 *
 * On first evaluation (module load), the resolved flag set is logged at
 * `console.debug` level so operators can inspect which flags are active.
 * In production builds, `console.debug` is stripped by Vite's esbuild config,
 * so no flag state leaks to the public bundle.
 *
 * ## Adding a new flag
 *
 * 1. Add an entry to `FEATURE_FLAG_REGISTRY` with a unique key, a human-readable
 *    description, an owner team/name, a rollout phase, and a production default.
 * 2. The `FeatureFlagSet` type is auto-derived from the registry.
 * 3. Add a selector in `selectors.ts` if consumers need the flat boolean.
 * 4. Wire it into the relevant component(s).
 * 5. Update this file's tests.
 */

// ── Types ────────────────────────────────────────────────────────────────────

/** Rollout phase — controls which environments a flag is eligible for. */
export type RolloutPhase = 'development' | 'testnet' | 'production' | 'deprecated';

/**
 * Metadata for one feature flag.
 *
 * Every flag MUST have a unique key, a human-readable description, and an owner
 * so the registry stays auditable over time.
 */
export interface FeatureFlagMeta {
  /** Unique key used to reference this flag (matches the registry key). */
  key: string;
  /** Human-readable description of what this flag gates. */
  description: string;
  /** Owner team or person — helps with cleanup. */
  owner: string;
  /** Current rollout phase. */
  phase: RolloutPhase;
  /** Default value used in production builds when no env-var override is set. */
  productionDefault: boolean;
}

// ── Registry ─────────────────────────────────────────────────────────────────

/**
 * Declarative registry of every feature flag.
 *
 * This is the **only** place where flags are defined. The `FeatureFlagSet`
 * type is derived automatically from the keys in this record so adding a flag
 * here instantly makes it available to all consumers without a separate type
 * update.
 */
export const FEATURE_FLAG_REGISTRY = {
  faucetEnabled: {
    key: 'faucetEnabled',
    description: 'Enable the testnet faucet UI component.',
    owner: 'frontend',
    phase: 'testnet' as RolloutPhase,
    productionDefault: false,
  },
  historyStreamEnabled: {
    key: 'historyStreamEnabled',
    description: 'Enable the real-time transaction history stream UI.',
    owner: 'frontend',
    phase: 'testnet' as RolloutPhase,
    productionDefault: false,
  },
  refundFlowEnabled: {
    key: 'refundFlowEnabled',
    description: 'Enable the permissionless refund dialog flow.',
    owner: 'frontend',
    phase: 'testnet' as RolloutPhase,
    productionDefault: false,
  },
  solanaRoutesEnabled: {
    key: 'solanaRoutesEnabled',
    description: 'Enable Solana bridge routes (simulation/announce mode).',
    owner: 'frontend',
    phase: 'development' as RolloutPhase,
    productionDefault: false,
  },
  introAnimationEnabled: {
    key: 'introAnimationEnabled',
    description: 'Show the branded intro animation on first visit.',
    owner: 'frontend',
    phase: 'production' as RolloutPhase,
    productionDefault: true,
  },
  darkVeilEnabled: {
    key: 'darkVeilEnabled',
    description: 'Render the dark-veil WebGL background effect.',
    owner: 'frontend',
    phase: 'production' as RolloutPhase,
    productionDefault: true,
  },
  claimFallbackEnabled: {
    key: 'claimFallbackEnabled',
    description: 'Enable the direct on-chain claim fallback dialog when coordinator is unreachable.',
    owner: 'frontend',
    phase: 'testnet' as RolloutPhase,
    productionDefault: false,
  },
} as const satisfies Record<string, FeatureFlagMeta>;

// ── Derived types ────────────────────────────────────────────────────────────

/**
 * The set of resolved flag values.
 *
 * Keys are automatically derived from `FEATURE_FLAG_REGISTRY` so adding a flag
 * to the registry automatically extends this type.
 */
export type FeatureFlagSet = Readonly<{
  [K in keyof typeof FEATURE_FLAG_REGISTRY]: boolean;
}>;

/** All valid flag key strings. */
export type FeatureFlagKey = keyof typeof FEATURE_FLAG_REGISTRY & string;

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Read a Vite env var. Returns `undefined` when the var is not set. */
function readEnvFlag(key: string): string | undefined {
  // Match the project convention for reading import.meta.env (see env.ts, networks.ts).
  const raw = (import.meta as any).env as Record<string, string | undefined> | undefined;
  // Convert camelCase key to VITE_FEATURE_SCREAMING_SNAKE_CASE env var name.
  // e.g. faucetEnabled → VITE_FEATURE_FAUCET_ENABLED
  const envVar = `VITE_FEATURE_${key.replace(/([A-Z])/g, '_$1').toUpperCase()}`;
  if (!raw) return undefined;
  return raw[envVar];
}

// ── Evaluation ────────────────────────────────────────────────────────────────

/**
 * Evaluate a single feature flag to a deterministic boolean.
 *
 * Evaluates in this order:
 * 1. If an explicit env var (`VITE_FEATURE_<KEY>`) is set to `'true'` or `'false'`,
 *    that value wins.
 * 2. If the flag's phase is `'deprecated'`, it is always `false`.
 * 3. If we are in a development build (`import.meta.env.DEV`), the flag is
 *    `true` by default (fast iteration).
 * 4. Otherwise (production build), the flag's `productionDefault` is used.
 */
function evaluateFlag(meta: FeatureFlagMeta): boolean {
  // 1. Env-var override — operator can force on/off in any environment.
  const envValue = readEnvFlag(meta.key);
  if (envValue === 'true') return true;
  if (envValue === 'false') return false;

  // 2. Deprecated flags are permanently off.
  if (meta.phase === 'deprecated') return false;

  // 3. Development: enable everything by default for fast iteration.
  if (import.meta.env.DEV) return true;

  // 4. Production: use the declared production default.
  return meta.productionDefault;
}

// ── Resolved flag set ────────────────────────────────────────────────────────

function resolveAllFlags(): FeatureFlagSet {
  const resolved = {} as Record<string, boolean>;
  for (const [key, meta] of Object.entries(FEATURE_FLAG_REGISTRY)) {
    resolved[key] = evaluateFlag(meta as FeatureFlagMeta);
  }
  return resolved as FeatureFlagSet;
}

/**
 * The resolved feature-flag set, evaluated once at module load time.
 *
 * This object is frozen so it cannot be mutated at runtime. All flag
 * evaluation is deterministic and happens exactly once per page load.
 */
export const featureFlags: FeatureFlagSet = Object.freeze(resolveAllFlags());

/**
 * Returns `true` when the named feature flag is enabled.
 *
 * Prefer the typed selectors in `selectors.ts` for component use; this
 * function is a lower-level escape hatch for dynamic flag lookups.
 */
export function isFeatureEnabled(flag: FeatureFlagKey): boolean {
  return featureFlags[flag] ?? false;
}

/**
 * Returns an array of all currently active flag keys.
 * Useful for operator dashboards and diagnostics.
 */
export function getActiveFlags(): FeatureFlagKey[] {
  return (Object.keys(featureFlags) as FeatureFlagKey[]).filter(
    (k) => featureFlags[k],
  );
}

/**
 * Returns a human-readable summary of all flags and their resolved values.
 * Useful for logging and debugging.
 */
export function describeFlags(): string {
  const lines = (Object.keys(featureFlags) as FeatureFlagKey[]).map((k) => {
    const meta = FEATURE_FLAG_REGISTRY[k];
    const active = featureFlags[k] ? '✅' : '❌';
    return `  ${active} ${k} (phase: ${meta.phase}, owner: ${meta.owner})`;
  });
  return `Feature flags (${import.meta.env.PROD ? 'production' : 'development'} build):\n${lines.join('\n')}`;
}

// ── Operator-facing logging ──────────────────────────────────────────────────

// Log the resolved flag state exactly once at module load time so operators
// can see which flags are active in the browser console during development.
// In production builds, console.debug is stripped by Vite's esbuild config
// (see vite.config.ts → esbuild.drop), so no flag state leaks to the public.
try {
  console.debug(describeFlags());
} catch {
  // No-op — logging is best-effort and must never throw.
}
