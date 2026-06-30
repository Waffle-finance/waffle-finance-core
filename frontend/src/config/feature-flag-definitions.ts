export type DeploymentEnvironment = 'local' | 'test' | 'production';

export interface FeatureFlags {
  readonly mainnet: boolean;
  readonly testnetFaucets: boolean;
  readonly debugMode: boolean;
  readonly mockData: boolean;
}

export type FeatureFlagName = keyof FeatureFlags;

export const FEATURE_FLAG_DEFAULTS = {
  local: {
    mainnet: false,
    testnetFaucets: true,
    debugMode: true,
    mockData: false,
  },
  test: {
    mainnet: false,
    testnetFaucets: true,
    debugMode: false,
    mockData: false,
  },
  production: {
    mainnet: false,
    testnetFaucets: false,
    debugMode: false,
    mockData: false,
  },
} as const satisfies Record<DeploymentEnvironment, FeatureFlags>;

const FEATURE_FLAG_ENV_KEYS = {
  mainnet: ['VITE_FEATURE_MAINNET', 'VITE_MAINNET_ENABLED'],
  testnetFaucets: ['VITE_FEATURE_TESTNET_FAUCETS', 'VITE_ENABLE_TESTNET_FAUCETS'],
  debugMode: ['VITE_FEATURE_DEBUG_MODE', 'VITE_ENABLE_DEBUG_MODE'],
  mockData: ['VITE_FEATURE_MOCK_DATA', 'VITE_ENABLE_MOCK_DATA'],
} as const satisfies Record<FeatureFlagName, readonly string[]>;

export interface ResolvedFeatureFlagConfig {
  readonly environment: DeploymentEnvironment;
  readonly flags: Readonly<FeatureFlags>;
}

function parseBooleanOverride(
  value: string | undefined,
  environmentVariable: string,
  fallback: boolean
): boolean {
  const normalized = value?.trim().toLowerCase();

  if (!normalized) {
    return fallback;
  }

  if (normalized === 'true') {
    return true;
  }

  if (normalized === 'false') {
    return false;
  }

  throw new Error(`${environmentVariable} must be either "true" or "false".`);
}

function readOverride(
  rawEnv: Readonly<Record<string, string | undefined>>,
  keys: readonly string[]
): { key: string; value: string | undefined } {
  const configuredKey = keys.find(key => rawEnv[key] !== undefined && rawEnv[key] !== '');
  const key = configuredKey ?? keys[0];

  return { key, value: rawEnv[key] };
}

export function resolveDeploymentEnvironment(
  mode: string,
  configuredEnvironment?: string
): DeploymentEnvironment {
  const configured = configuredEnvironment?.trim().toLowerCase();

  if (configured) {
    if (configured === 'local' || configured === 'test' || configured === 'production') {
      return configured;
    }

    throw new Error('VITE_DEPLOYMENT_ENV must be one of "local", "test", or "production".');
  }

  if (mode === 'production') {
    return 'production';
  }

  if (mode === 'test') {
    return 'test';
  }

  return 'local';
}

export function resolveFeatureFlagConfig(
  mode: string,
  rawEnv: Readonly<Record<string, string | undefined>> = {}
): ResolvedFeatureFlagConfig {
  const environment = resolveDeploymentEnvironment(mode, rawEnv.VITE_DEPLOYMENT_ENV);
  const defaults = FEATURE_FLAG_DEFAULTS[environment];
  const mainnet = readOverride(rawEnv, FEATURE_FLAG_ENV_KEYS.mainnet);
  const testnetFaucets = readOverride(rawEnv, FEATURE_FLAG_ENV_KEYS.testnetFaucets);
  const debugMode = readOverride(rawEnv, FEATURE_FLAG_ENV_KEYS.debugMode);
  const mockData = readOverride(rawEnv, FEATURE_FLAG_ENV_KEYS.mockData);

  const flags: FeatureFlags = Object.freeze({
    mainnet: parseBooleanOverride(mainnet.value, mainnet.key, defaults.mainnet),
    testnetFaucets: parseBooleanOverride(
      testnetFaucets.value,
      testnetFaucets.key,
      defaults.testnetFaucets
    ),
    debugMode: parseBooleanOverride(debugMode.value, debugMode.key, defaults.debugMode),
    mockData: parseBooleanOverride(mockData.value, mockData.key, defaults.mockData),
  });

  return Object.freeze({ environment, flags });
}
