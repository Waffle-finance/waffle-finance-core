import { describe, expect, it } from 'vitest';
import { FEATURE_FLAG_DEFAULTS } from './feature-flag-definitions';
import { deploymentEnvironment, featureFlags, isFeatureEnabled } from './feature-flags';

describe('build-time feature flags', () => {
  it('injects the test defaults into Vitest builds', () => {
    expect(deploymentEnvironment).toBe('test');
    expect(featureFlags).toEqual(FEATURE_FLAG_DEFAULTS.test);
  });

  it('provides typed feature lookups from immutable configuration', () => {
    expect(isFeatureEnabled('testnetFaucets')).toBe(true);
    expect(isFeatureEnabled('mainnet')).toBe(false);
    expect(Object.isFrozen(featureFlags)).toBe(true);
  });
});
