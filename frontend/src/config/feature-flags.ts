import type {
  DeploymentEnvironment,
  FeatureFlagName,
  FeatureFlags,
} from './feature-flag-definitions';

/**
 * Feature configuration resolved and injected by Vite when the bundle is built.
 * No runtime environment lookup is performed in the browser.
 */
export const deploymentEnvironment: DeploymentEnvironment = __DEPLOYMENT_ENVIRONMENT__;
export const featureFlags: Readonly<FeatureFlags> = Object.freeze(__FEATURE_FLAGS__);

export function isFeatureEnabled(feature: FeatureFlagName): boolean {
  return featureFlags[feature];
}

export type { DeploymentEnvironment, FeatureFlagName, FeatureFlags };
