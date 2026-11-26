/**
 * Tests for relayer/src/config/startup-config.ts.
 *
 * Parity tests assert that the extracted helpers return exactly what the
 * original inline entry-point code returned, for every supported network mode.
 */

import { describe, it, expect } from 'vitest';
import {
  NETWORK_CONFIG,
  MAINNET_ESCROW_FACTORY_ABI,
  TESTNET_ESCROW_FACTORY_ABI,
  getEscrowFactoryABI,
  getEscrowFactoryAddress,
  getHtlcBridgeAddress,
  type NetworkMode,
} from '../src/config/networks.js';
import {
  DEFAULT_RELAYER_NETWORK,
  buildEnvironmentValidationInput,
  buildRelayerStartupConfig,
  resolveDefaultNetworkMode,
  resolveRefundWatchdogSettings,
  resolveRelayerContractAddresses,
  resolveStartupDependencyOptions,
  type StartupEnv,
} from '../src/config/startup-config.js';

const MODES: NetworkMode[] = ['testnet', 'mainnet'];

function makeParsedConfig(network: string | undefined) {
  return {
    network,
    port: '3001',
    activePollIntervalMs: 15000,
    idlePollIntervalMs: 60000,
    visitorTtlMs: 900000,
    nodeEnv: 'test',
    enableMockMode: false,
    security: { emergencyShutdown: false, maintenanceMode: false },
    resolverAllowlist: ['0xabc'],
    ethereum: {
      network: network ?? 'testnet',
      rpcUrl: 'https://rpc.example',
      privateKey: '0x' + '1'.repeat(64),
      contractAddress: 'stale-value',
    },
    stellar: {
      network: network ?? 'testnet',
      secretKey: 'S' + 'A'.repeat(55),
    },
  } as unknown as Parameters<typeof buildRelayerStartupConfig>[0];
}

describe('resolveDefaultNetworkMode', () => {
  it('falls back to testnet when the value is undefined or null', () => {
    expect(DEFAULT_RELAYER_NETWORK).toBe('testnet');
    expect(resolveDefaultNetworkMode(undefined)).toBe('testnet');
    expect(resolveDefaultNetworkMode(null)).toBe('testnet');
  });

  it('returns testnet and mainnet unchanged', () => {
    expect(resolveDefaultNetworkMode('testnet')).toBe('testnet');
    expect(resolveDefaultNetworkMode('mainnet')).toBe('mainnet');
  });

  it('throws the shared unknown-network error for unsupported values', () => {
    expect(() => resolveDefaultNetworkMode('devnet')).toThrow(
      'Unknown network mode "devnet". Valid values are "testnet" or "mainnet".',
    );
  });

  it('throws for an empty string instead of silently defaulting', () => {
    expect(() => resolveDefaultNetworkMode('')).toThrow('Unknown network mode ""');
  });
});

describe('resolveRelayerContractAddresses', () => {
  it.each(MODES)('matches the networks.ts helpers for %s', (mode) => {
    expect(resolveRelayerContractAddresses(mode)).toEqual({
      htlcBridgeAddress: getHtlcBridgeAddress(mode, mode),
      escrowFactoryAddress: getEscrowFactoryAddress(mode, mode),
    });
  });

  it.each(MODES)('returns the configured addresses for %s', (mode) => {
    const addresses = resolveRelayerContractAddresses(mode);
    expect(addresses.htlcBridgeAddress).toBe(NETWORK_CONFIG[mode].ethereum.htlcBridge);
    expect(addresses.escrowFactoryAddress).toBe(NETWORK_CONFIG[mode].ethereum.escrowFactory);
  });
});

describe('buildRelayerStartupConfig', () => {
  it('attaches testnet addresses to the runtime config', () => {
    const { defaultNetworkMode, runtimeConfig } = buildRelayerStartupConfig(makeParsedConfig('testnet'));
    expect(defaultNetworkMode).toBe('testnet');
    expect(runtimeConfig.ethereum.contractAddress).toBe(NETWORK_CONFIG.testnet.ethereum.htlcBridge);
    expect(runtimeConfig.ethereum.escrowFactoryAddress).toBe(NETWORK_CONFIG.testnet.ethereum.escrowFactory);
  });

  it('attaches mainnet addresses when the network is mainnet', () => {
    const { defaultNetworkMode, runtimeConfig } = buildRelayerStartupConfig(makeParsedConfig('mainnet'));
    expect(defaultNetworkMode).toBe('mainnet');
    expect(runtimeConfig.ethereum.contractAddress).toBe(NETWORK_CONFIG.mainnet.ethereum.htlcBridge);
    expect(runtimeConfig.ethereum.escrowFactoryAddress).toBe(NETWORK_CONFIG.mainnet.ethereum.escrowFactory);
  });

  it('overrides a stale contractAddress from the parsed config', () => {
    const { runtimeConfig } = buildRelayerStartupConfig(makeParsedConfig('testnet'));
    expect(runtimeConfig.ethereum.contractAddress).not.toBe('stale-value');
  });

  it('keeps every other parsed field and does not mutate the input', () => {
    const parsed = makeParsedConfig('mainnet');
    const snapshot = JSON.parse(JSON.stringify(parsed));
    const { runtimeConfig } = buildRelayerStartupConfig(parsed);
    expect(parsed).toEqual(snapshot);
    expect(runtimeConfig.port).toBe('3001');
    expect(runtimeConfig.resolverAllowlist).toEqual(['0xabc']);
    expect(runtimeConfig.ethereum.rpcUrl).toBe('https://rpc.example');
    expect(runtimeConfig.stellar.secretKey).toBe(parsed.stellar.secretKey);
  });

  it('defaults to testnet when the parsed network is missing', () => {
    const { defaultNetworkMode } = buildRelayerStartupConfig(makeParsedConfig(undefined));
    expect(defaultNetworkMode).toBe('testnet');
  });

  it('propagates an error for an unknown configured network', () => {
    expect(() => buildRelayerStartupConfig(makeParsedConfig('bogus'))).toThrow('Unknown network mode');
  });
});

describe('ABI selection parity', () => {
  it('selects the 1inch ABI for mainnet and the custom ABI for testnet', () => {
    expect(getEscrowFactoryABI(true)).toBe(MAINNET_ESCROW_FACTORY_ABI);
    expect(getEscrowFactoryABI(false)).toBe(TESTNET_ESCROW_FACTORY_ABI);
  });

  it.each(MODES)('uses the same ABI selection rule for %s as before extraction', (mode) => {
    const expected = mode === 'mainnet' ? MAINNET_ESCROW_FACTORY_ABI : TESTNET_ESCROW_FACTORY_ABI;
    expect(getEscrowFactoryABI(mode === 'mainnet')).toBe(expected);
  });
});

describe('buildEnvironmentValidationInput', () => {
  it('maps resolved config values to the validator keys', () => {
    const { runtimeConfig } = buildRelayerStartupConfig(makeParsedConfig('testnet'));
    const input = buildEnvironmentValidationInput({ PATH: '/bin' }, runtimeConfig, 'testnet');
    expect(input).toMatchObject({
      PATH: '/bin',
      NETWORK: 'testnet',
      ETHEREUM_NETWORK: 'testnet',
      STELLAR_NETWORK: 'testnet',
      ETHEREUM_CONTRACT_ADDRESS: NETWORK_CONFIG.testnet.ethereum.htlcBridge,
      ESCROW_FACTORY_ADDRESS: NETWORK_CONFIG.testnet.ethereum.escrowFactory,
      ETHEREUM_PRIVATE_KEY: runtimeConfig.ethereum.privateKey,
      STELLAR_SECRET_KEY: runtimeConfig.stellar.secretKey,
    });
  });

  it('lets the resolved mode override a NETWORK value present in the env', () => {
    const { runtimeConfig } = buildRelayerStartupConfig(makeParsedConfig('mainnet'));
    const env: StartupEnv = { NETWORK: 'testnet' };
    const input = buildEnvironmentValidationInput(env, runtimeConfig, 'mainnet');
    expect(input.NETWORK).toBe('mainnet');
  });

  it('does not mutate the env object it is given', () => {
    const { runtimeConfig } = buildRelayerStartupConfig(makeParsedConfig('testnet'));
    const env: StartupEnv = { FOO: 'bar' };
    buildEnvironmentValidationInput(env, runtimeConfig, 'testnet');
    expect(env).toEqual({ FOO: 'bar' });
  });
});

describe('resolveStartupDependencyOptions', () => {
  it('returns undefined for unset or empty tuning variables', () => {
    const options = resolveStartupDependencyOptions({
      RELAYER_STARTUP_MAX_RETRIES: '',
    });
    expect(options).toEqual({
      coordinatorUrl: undefined,
      resolverRegistryUrl: undefined,
      maxRetries: undefined,
      backoffBaseMs: undefined,
      backoffMaxMs: undefined,
    });
  });

  it('parses the numeric tuning variables and passes URLs through', () => {
    const options = resolveStartupDependencyOptions({
      COORDINATOR_URL: 'http://coordinator:3001',
      RESOLVER_REGISTRY_URL: 'http://resolver:3002',
      RELAYER_STARTUP_MAX_RETRIES: '5',
      RELAYER_STARTUP_BACKOFF_BASE_MS: '250',
      RELAYER_STARTUP_BACKOFF_MAX_MS: '8000',
    });
    expect(options).toEqual({
      coordinatorUrl: 'http://coordinator:3001',
      resolverRegistryUrl: 'http://resolver:3002',
      maxRetries: 5,
      backoffBaseMs: 250,
      backoffMaxMs: 8000,
    });
  });

  it('parses leading integers the same way the original parseInt call did', () => {
    const options = resolveStartupDependencyOptions({ RELAYER_STARTUP_MAX_RETRIES: '3ms' });
    expect(options.maxRetries).toBe(3);
  });

  it('keeps NaN for non-numeric values, matching the original parseInt behaviour', () => {
    const options = resolveStartupDependencyOptions({ RELAYER_STARTUP_BACKOFF_MAX_MS: 'soon' });
    expect(Number.isNaN(options.backoffMaxMs)).toBe(true);
  });
});

describe('resolveRefundWatchdogSettings', () => {
  it('uses the mainnet dedicated secret on mainnet', () => {
    const settings = resolveRefundWatchdogSettings('mainnet', {
      RELAYER_STELLAR_SECRET_MAINNET: 'SMAIN',
      RELAYER_STELLAR_SECRET_TESTNET: 'STEST',
      RELAYER_STELLAR_SECRET: 'SGEN',
    });
    expect(settings).toEqual({
      networkMode: 'mainnet',
      horizonUrl: NETWORK_CONFIG.mainnet.stellar.horizonUrl,
      refundSecret: 'SMAIN',
    });
  });

  it('uses the testnet dedicated secret on testnet', () => {
    const settings = resolveRefundWatchdogSettings('testnet', {
      RELAYER_STELLAR_SECRET_MAINNET: 'SMAIN',
      RELAYER_STELLAR_SECRET_TESTNET: 'STEST',
    });
    expect(settings?.refundSecret).toBe('STEST');
    expect(settings?.horizonUrl).toBe(NETWORK_CONFIG.testnet.stellar.horizonUrl);
    expect(settings?.networkMode).toBe('testnet');
  });

  it('falls back to the generic secret when the dedicated one is missing or empty', () => {
    expect(
      resolveRefundWatchdogSettings('mainnet', { RELAYER_STELLAR_SECRET: 'SGEN' })?.refundSecret,
    ).toBe('SGEN');
    expect(
      resolveRefundWatchdogSettings('mainnet', {
        RELAYER_STELLAR_SECRET_MAINNET: '',
        RELAYER_STELLAR_SECRET: 'SGEN',
      })?.refundSecret,
    ).toBe('SGEN');
  });

  it('returns null when no secret is available, disabling the watchdog', () => {
    expect(resolveRefundWatchdogSettings('testnet', {})).toBeNull();
    expect(
      resolveRefundWatchdogSettings('mainnet', { RELAYER_STELLAR_SECRET_TESTNET: 'STEST' }),
    ).toBeNull();
  });
});
