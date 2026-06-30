/**
 * Tests for network configuration helpers.
 *
 * In the Vitest environment VITE_MAINNET_ENABLED is not set, so
 * isMainnetEnabled() deterministically returns false. This makes
 * the tests stable without needing to patch import.meta.env.
 *
 * Coverage:
 *  - isMainnetEnabled: returns false when env flag is absent
 *  - resolveNetworkMode: passes testnet through, clamps mainnet when disabled
 *  - isTestnet: returns true in the default (no-URL, no-env) test context
 */

import { describe, it, expect } from 'vitest';
import { isMainnetEnabled, resolveNetworkMode, isTestnet, validateNetworkMode, frontendConfig } from './networks';

describe('isMainnetEnabled', () => {
  it('returns false when VITE_MAINNET_ENABLED is not set in the test environment', () => {
    // In Vitest, VITE_MAINNET_ENABLED is not provided, so the flag evaluates false.
    expect(isMainnetEnabled()).toBe(false);
  });
});

describe('resolveNetworkMode', () => {
  it('passes "testnet" through unchanged', () => {
    expect(resolveNetworkMode('testnet')).toBe('testnet');
  });

  it('clamps "mainnet" to "testnet" when mainnet is not enabled', () => {
    // isMainnetEnabled() === false in tests, so mainnet requests are downgraded.
    expect(resolveNetworkMode('mainnet')).toBe('testnet');
  });
});

describe('isTestnet', () => {
  it('returns true in the default test context (no URL params, no VITE_NETWORK env)', () => {
    // No window.location.search set, no VITE_NETWORK env → defaults to testnet.
    expect(isTestnet()).toBe(true);
  });
});

describe('validateNetworkMode', () => {
  it('passes "testnet" through successfully', () => {
    expect(validateNetworkMode('testnet')).toBe('testnet');
  });

  it('throws an error for invalid/unsupported network modes (whitelisting check)', () => {
    expect(() => validateNetworkMode('invalid_mode')).toThrow(/Invalid network mode/);
    expect(() => validateNetworkMode('')).toThrow(/Invalid network mode/);
  });

  it('throws an error for "mainnet" when mainnet is not enabled', () => {
    const originalValue = frontendConfig.mainnetEnabled;
    try {
      (frontendConfig as any).mainnetEnabled = false;
      expect(() => validateNetworkMode('mainnet')).toThrow(/Mainnet mode is disabled/);
    } finally {
      (frontendConfig as any).mainnetEnabled = originalValue;
    }
  });

  it('passes "mainnet" through successfully when mainnet is enabled', () => {
    const originalValue = frontendConfig.mainnetEnabled;
    try {
      (frontendConfig as any).mainnetEnabled = true;
      expect(validateNetworkMode('mainnet')).toBe('mainnet');
    } finally {
      (frontendConfig as any).mainnetEnabled = originalValue;
    }
  });
});
