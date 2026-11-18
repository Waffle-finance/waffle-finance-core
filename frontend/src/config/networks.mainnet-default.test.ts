// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

async function loadNetworks() {
  vi.resetModules();
  return await import('./networks');
}

beforeEach(() => {
  vi.stubEnv('VITE_MAINNET_ENABLED', '');
  vi.stubEnv('VITE_NETWORK', 'testnet');
  vi.stubEnv('VITE_NETWORK_MODE', 'testnet');
  window.history.replaceState({}, '', '/');
});

afterEach(() => {
  vi.unstubAllEnvs();
  window.history.replaceState({}, '', '/');
});

describe('mainnet disabled by default', () => {
  it('leaves mainnet disabled when the flag is unset', async () => {
    vi.stubEnv('VITE_MAINNET_ENABLED', undefined as unknown as string);
    const { isMainnetEnabled } = await loadNetworks();
    expect(isMainnetEnabled()).toBe(false);
  });

  it('leaves mainnet disabled when the flag is not "true"', async () => {
    vi.stubEnv('VITE_MAINNET_ENABLED', 'false');
    const { isMainnetEnabled } = await loadNetworks();
    expect(isMainnetEnabled()).toBe(false);
  });

  it('clamps a mainnet route request to testnet when disabled', async () => {
    vi.stubEnv('VITE_MAINNET_ENABLED', '');
    const { resolveNetworkMode } = await loadNetworks();
    expect(resolveNetworkMode('mainnet')).toBe('testnet');
  });

  it('serves testnet contracts and network when mainnet is disabled', async () => {
    vi.stubEnv('VITE_MAINNET_ENABLED', '');
    const { getContractAddresses, getCurrentNetwork } = await loadNetworks();
    const contracts = getContractAddresses();
    const current = getCurrentNetwork();
    expect(current.ethereum.testnet).toBe(true);
    expect(current.stellar.testnet).toBe(true);
    expect(contracts.ethereum.htlcBridge).toBe('0x3f344ACDd17a0c4D21096da895152820f595dc8A');
  });
});

describe('mainnet explicitly enabled', () => {
  it('selects only mainnet configuration', async () => {
    vi.stubEnv('VITE_MAINNET_ENABLED', 'true');
    vi.stubEnv('VITE_NETWORK', 'mainnet');
    const { isMainnetEnabled, resolveNetworkMode, getContractAddresses, getCurrentNetwork } =
      await loadNetworks();
    expect(isMainnetEnabled()).toBe(true);
    expect(resolveNetworkMode('mainnet')).toBe('mainnet');
    const contracts = getContractAddresses();
    const current = getCurrentNetwork();
    expect(current.ethereum.testnet).toBe(false);
    expect(current.stellar.testnet).toBe(false);
    expect(current.ethereum.displayName).toBe('Ethereum Mainnet');
  });

  it('does not reuse testnet addresses as mainnet values', async () => {
    vi.stubEnv('VITE_MAINNET_ENABLED', 'true');
    const { CONTRACT_ADDRESSES } = await loadNetworks();
    expect(CONTRACT_ADDRESSES.ethereum.mainnet.htlcBridge).not.toBe(
      CONTRACT_ADDRESSES.ethereum.sepolia.htlcBridge,
    );
    expect(CONTRACT_ADDRESSES.stellar.mainnet.bridgeAccount).not.toBe(
      CONTRACT_ADDRESSES.stellar.testnet.bridgeAccount,
    );
    expect(CONTRACT_ADDRESSES.ethereum.mainnet.escrowFactory).not.toBe(
      CONTRACT_ADDRESSES.ethereum.sepolia.escrowFactory,
    );
  });
});
