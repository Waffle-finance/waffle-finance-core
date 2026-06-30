import { describe, expect, it } from 'vitest';
import {
  FEATURE_FLAG_DEFAULTS,
  resolveDeploymentEnvironment,
  resolveFeatureFlagConfig,
} from './feature-flag-definitions';

describe('resolveDeploymentEnvironment', () => {
  it.each([
    ['development', 'local'],
    ['local', 'local'],
    ['staging', 'local'],
    ['test', 'test'],
    ['production', 'production'],
  ] as const)('maps Vite mode %s to %s', (mode, expected) => {
    expect(resolveDeploymentEnvironment(mode)).toBe(expected);
  });

  it('prefers an explicit deployment environment over the Vite mode', () => {
    expect(resolveDeploymentEnvironment('production', 'test')).toBe('test');
  });

  it('rejects an unsupported deployment environment', () => {
    expect(() => resolveDeploymentEnvironment('development', 'preview')).toThrow(
      /VITE_DEPLOYMENT_ENV/
    );
  });
});

describe('resolveFeatureFlagConfig', () => {
  it.each(['local', 'test', 'production'] as const)(
    'uses the documented defaults for %s builds',
    environment => {
      const config = resolveFeatureFlagConfig('development', {
        VITE_DEPLOYMENT_ENV: environment,
      });

      expect(config).toEqual({
        environment,
        flags: FEATURE_FLAG_DEFAULTS[environment],
      });
    }
  );

  it('applies typed build-time overrides without changing other defaults', () => {
    const config = resolveFeatureFlagConfig('production', {
      VITE_FEATURE_MAINNET: 'true',
      VITE_FEATURE_TESTNET_FAUCETS: 'true',
    });

    expect(config.flags).toEqual({
      ...FEATURE_FLAG_DEFAULTS.production,
      mainnet: true,
      testnetFaucets: true,
    });
  });

  it('supports the previous environment variable names during migration', () => {
    const config = resolveFeatureFlagConfig('test', {
      VITE_MAINNET_ENABLED: 'true',
      VITE_ENABLE_DEBUG_MODE: 'true',
      VITE_ENABLE_MOCK_DATA: 'true',
      VITE_ENABLE_TESTNET_FAUCETS: 'false',
    });

    expect(config.flags).toEqual({
      mainnet: true,
      testnetFaucets: false,
      debugMode: true,
      mockData: true,
    });
  });

  it('gives canonical variables precedence over migration aliases', () => {
    const config = resolveFeatureFlagConfig('local', {
      VITE_FEATURE_MAINNET: 'false',
      VITE_MAINNET_ENABLED: 'true',
    });

    expect(config.flags.mainnet).toBe(false);
  });

  it('rejects ambiguous boolean values instead of coercing them', () => {
    expect(() => resolveFeatureFlagConfig('local', { VITE_FEATURE_MOCK_DATA: '1' })).toThrow(
      /VITE_FEATURE_MOCK_DATA must be either "true" or "false"/
    );
  });

  it('returns immutable configuration', () => {
    const config = resolveFeatureFlagConfig('test');

    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.flags)).toBe(true);
  });
});
