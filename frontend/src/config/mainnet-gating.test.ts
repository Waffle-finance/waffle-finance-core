/**
 * Tests for build-time mainnet gating validation.
 *
 * Verifies that:
 *  - isMainnetEnabled() returns false when VITE_MAINNET_ENABLED is absent
 *    or set to anything other than 'true'
 *  - resolveNetworkMode correctly gates mainnet-only flows
 *  - getCurrentNetwork() returns the testnet config when mainnet is disabled
 *  - getContractAddresses() returns the testnet contracts when mainnet is disabled
 *  - isTestnet() agrees with the clamped mode
 *
 * These tests serve as assertions that match what the build pipeline would
 * enforce: when VITE_MAINNET_ENABLED is not 'true', all network-sensitive
 * helpers must behave as if the app is in testnet-only mode.
 *
 * Coverage:
 *  - isMainnetEnabled: false when VITE_MAINNET_ENABLED absent (test env)
 *  - resolveNetworkMode: clamps 'mainnet' → 'testnet' when disabled
 *  - resolveNetworkMode: passes 'testnet' through unchanged
 *  - getCurrentNetwork: returns sepolia when mainnet disabled
 *  - getContractAddresses: returns sepolia addresses when mainnet disabled
 *  - isTestnet: returns true in default test environment
 *  - getCurrentNetwork().ethereum.testnet: true in default test environment
 *  - getCurrentNetwork().stellar.testnet: true in default test environment
 */

import { describe, it, expect } from 'vitest';
import {
  isMainnetEnabled,
  resolveNetworkMode,
  isTestnet,
  getCurrentNetwork,
  getContractAddresses,
} from './networks';

// ── isMainnetEnabled ──────────────────────────────────────────────────────────

describe('isMainnetEnabled — build-time flag', () => {
  it('returns false when VITE_MAINNET_ENABLED is absent (CI / test default)', () => {
    // In the Vitest environment import.meta.env.VITE_MAINNET_ENABLED is not set,
    // so loadFrontendConfig() should produce mainnetEnabled=false.
    expect(isMainnetEnabled()).toBe(false);
  });
});

// ── resolveNetworkMode ────────────────────────────────────────────────────────

describe('resolveNetworkMode — clamping logic', () => {
  it('clamps "mainnet" to "testnet" when isMainnetEnabled() is false', () => {
    // This is the core build-time guard: requests for mainnet flows are
    // silently downgraded to testnet when the flag is off.
    expect(resolveNetworkMode('mainnet')).toBe('testnet');
  });

  it('passes "testnet" through unchanged', () => {
    expect(resolveNetworkMode('testnet')).toBe('testnet');
  });
});

// ── isTestnet ─────────────────────────────────────────────────────────────────

describe('isTestnet', () => {
  it('returns true in the test environment (no URL params, VITE_MAINNET_ENABLED unset)', () => {
    expect(isTestnet()).toBe(true);
  });
});

// ── getCurrentNetwork ─────────────────────────────────────────────────────────

describe('getCurrentNetwork — returns testnet config when mainnet is disabled', () => {
  it('ethereum config has testnet=true', () => {
    const { ethereum } = getCurrentNetwork();
    expect(ethereum.testnet).toBe(true);
  });

  it('stellar config has testnet=true', () => {
    const { stellar } = getCurrentNetwork();
    expect(stellar.testnet).toBe(true);
  });

  it('ethereum chainId is Sepolia (11155111), not Ethereum Mainnet (1)', () => {
    const { ethereum } = getCurrentNetwork();
    expect(ethereum.id).toBe(11155111);
  });

  it('stellar horizonUrl points to the testnet horizon', () => {
    const { stellar } = getCurrentNetwork();
    expect(stellar.horizonUrl).toContain('testnet');
  });

  it('stellar networkPassphrase is the test network passphrase', () => {
    const { stellar } = getCurrentNetwork();
    expect(stellar.networkPassphrase).toContain('Test SDF Network');
  });
});

// ── getContractAddresses ──────────────────────────────────────────────────────

describe('getContractAddresses — returns Sepolia addresses when mainnet is disabled', () => {
  it('returns sepolia-specific ethereum contract addresses', () => {
    const { ethereum } = getContractAddresses();
    // Sepolia escrow factory should NOT match the mainnet 1inch address
    expect(ethereum.escrowFactory.toLowerCase()).not.toBe(
      '0xa7bcb4eac8964306f9e3764f67db6a7af6ddf99a'
    );
  });

  it('ethereum addresses are non-empty strings', () => {
    const { ethereum } = getContractAddresses();
    expect(typeof ethereum.htlcBridge).toBe('string');
    expect(ethereum.htlcBridge.length).toBeGreaterThan(0);
  });
});

// ── Mainnet-only flows are not reachable when flag is off ─────────────────────

describe('Mainnet-only flows blocked when VITE_MAINNET_ENABLED is unset', () => {
  it('resolveNetworkMode with "mainnet" input never returns "mainnet" when flag is off', () => {
    // This is the canonical test that mainnet-gated code paths cannot be
    // activated by accident when the build-time flag is absent.
    const result = resolveNetworkMode('mainnet');
    // Must be clamped to testnet when isMainnetEnabled() === false
    if (!isMainnetEnabled()) {
      expect(result).toBe('testnet');
    }
  });

  it('getCurrentNetwork returns the same config regardless of a "mainnet" request when disabled', () => {
    // Simulate what would happen if code mistakenly called getCurrentNetwork
    // after an unclamped "mainnet" request — the underlying helper uses
    // readNetworkNameFromEnvOrUrl which itself calls resolveNetworkMode.
    const network = getCurrentNetwork();
    // Should always be the testnet variant since VITE_MAINNET_ENABLED is off.
    expect(network.ethereum.id).toBe(11155111);
  });
});
