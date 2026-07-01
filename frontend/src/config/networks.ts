/**
 * Network Configuration for WaffleFinance
 */

import { loadChainSettings, loadFrontendConfig } from '@wafflefinance/config';
import { resolveViteMainnetRpcUrl, resolveViteSepoliaRpcUrl } from './rpc-urls';

export type AppNetworkMode = 'mainnet' | 'testnet';

// Central configuration entry point for the frontend dApp
export const frontendConfig = loadFrontendConfig((import.meta as any).env || {});
const rawFrontendEnv = ((import.meta as any).env || {}) as Record<string, string | undefined>;
const testnetChainSettings = loadChainSettings('testnet', rawFrontendEnv, {
  vite: true,
  ethereumRpcUrl: resolveViteSepoliaRpcUrl(),
});
const mainnetChainSettings = loadChainSettings('mainnet', rawFrontendEnv, {
  vite: true,
  ethereumRpcUrl: resolveViteMainnetRpcUrl(),
});

/**
 * When false, the dApp is testnet-only. Mainnet toggle shows "Mainnet Coming".
 * Re-enable with VITE_MAINNET_ENABLED=true (post v2 audit / mainnet launch).
 */
export const isMainnetEnabled = (): boolean => {
  return frontendConfig.mainnetEnabled;
};

/** Clamp requested mode when mainnet is temporarily disabled. */
export const resolveNetworkMode = (requested: AppNetworkMode): AppNetworkMode => {
  if (requested === 'mainnet' && !isMainnetEnabled()) {
    return 'testnet';
  }
  return requested;
};

function readNetworkNameFromEnvOrUrl(): AppNetworkMode {
  let networkName: AppNetworkMode = 'testnet';

  if (typeof window !== 'undefined') {
    const urlNetwork = new URLSearchParams(window.location.search).get('network');
    if (urlNetwork === 'mainnet' || urlNetwork === 'testnet') {
      networkName = urlNetwork;
      return resolveNetworkMode(networkName);
    }
  }

  networkName = frontendConfig.network;

  return resolveNetworkMode(networkName);
}

export interface NetworkConfig {
  id: number;
  name: string;
  displayName: string;
  rpcUrl: string;
  explorerUrl: string;
  escrowFactory?: string;
  nativeCurrency: {
    name: string;
    symbol: string;
    decimals: number;
  };
  testnet: boolean;
}

export interface StellarNetworkConfig {
  name: string;
  displayName: string;
  horizonUrl: string;
  networkPassphrase: string;
  explorerUrl: string;
  testnet: boolean;
}

export interface SolanaNetworkConfig {
  name: string;
  displayName: string;
  rpcUrl: string;
  testnet: boolean;
}

export const ETHEREUM_NETWORKS: Record<string, NetworkConfig> = {
  mainnet: {
    id: mainnetChainSettings.ethereum.chainId,
    name: 'ethereum',
    displayName: 'Ethereum Mainnet',
    rpcUrl: mainnetChainSettings.ethereum.rpcUrl,
    explorerUrl: mainnetChainSettings.ethereum.explorerUrl,
    escrowFactory: mainnetChainSettings.ethereum.escrowFactory ?? undefined,
    nativeCurrency: {
      name: 'Ether',
      symbol: 'ETH',
      decimals: 18,
    },
    testnet: false,
  },
  sepolia: {
    id: testnetChainSettings.ethereum.chainId,
    name: 'sepolia',
    displayName: 'Sepolia Testnet',
    rpcUrl: testnetChainSettings.ethereum.rpcUrl,
    explorerUrl: testnetChainSettings.ethereum.explorerUrl,
    escrowFactory: testnetChainSettings.ethereum.escrowFactory ?? testnetChainSettings.ethereum.htlcBridge ?? undefined,
    nativeCurrency: {
      name: 'Sepolia Ether',
      symbol: 'SEP',
      decimals: 18,
    },
    testnet: true,
  },
  hardhat: {
    id: 31337,
    name: 'hardhat',
    displayName: 'Hardhat Local',
    rpcUrl: 'http://127.0.0.1:8545',
    explorerUrl: 'https://etherscan.io',
    nativeCurrency: {
      name: 'Ether',
      symbol: 'ETH',
      decimals: 18,
    },
    testnet: true,
  },
};

export const STELLAR_NETWORKS: Record<string, StellarNetworkConfig> = {
  mainnet: {
    name: 'mainnet',
    displayName: 'Stellar Mainnet',
    horizonUrl: mainnetChainSettings.soroban.horizonUrl,
    networkPassphrase: mainnetChainSettings.soroban.networkPassphrase,
    explorerUrl: 'https://stellarchain.io',
    testnet: false,
  },
  testnet: {
    name: 'testnet',
    displayName: 'Stellar Testnet',
    horizonUrl: testnetChainSettings.soroban.horizonUrl,
    networkPassphrase: testnetChainSettings.soroban.networkPassphrase,
    explorerUrl: 'https://testnet.stellarchain.io',
    testnet: true,
  },
};

export const SOLANA_NETWORKS: Record<string, SolanaNetworkConfig> = {
  mainnet: {
    name: 'mainnet-beta',
    displayName: 'Solana Mainnet',
    rpcUrl: mainnetChainSettings.solana.rpcUrl,
    testnet: false,
  },
  testnet: {
    name: 'devnet',
    displayName: 'Solana Devnet',
    rpcUrl: testnetChainSettings.solana.rpcUrl,
    testnet: true,
  },
};

export const CONTRACT_ADDRESSES = {
  ethereum: {
    mainnet: {
      htlcBridge: mainnetChainSettings.ethereum.htlcBridge ?? '0x0000000000000000000000000000000000000000',
      escrowFactory: mainnetChainSettings.ethereum.escrowFactory ?? '0x0000000000000000000000000000000000000000',
      testToken: '0xA0b86a33E6441b8bB770AE39aaDC4e75C0f03E6F', // WETH mainnet
    },
    sepolia: {
      htlcBridge: testnetChainSettings.ethereum.htlcBridge ?? '0x0000000000000000000000000000000000000000',
      escrowFactory: testnetChainSettings.ethereum.escrowFactory ?? '0x0000000000000000000000000000000000000000',
      testToken: '0x677afcB4A57a938A74a1A76a93913dE4Db3e5C63',
    },
  },
  stellar: {
    mainnet: {
      // Stellar uses account addresses, not contract addresses
      // These should be actual funded accounts for mainnet operations
      bridgeAccount: 'GCKFBEIYTKP6RSTVVK6FKXKMK7DIS3R6SEWXO5SWH3V7GDPRX2VDKYXB', // Replace with actual mainnet bridge account
      escrowAccount: 'GCKFBEIYTKP6RSTVVK6FKXKMK7DIS3R6SEWXO5SWH3V7GDPRX2VDKYXB', // Replace with actual mainnet escrow account
    },
    testnet: {
      bridgeAccount: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      escrowAccount: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    },
  },
};

export const FAUCETS = {
  ethereum: {
    sepolia: [
      {
        name: 'Sepolia Faucet',
        url: 'https://sepoliafaucet.com/',
        description: 'Get Sepolia ETH for testing',
      },
      {
        name: 'Alchemy Faucet',
        url: 'https://sepoliafaucet.com/',
        description: 'Alchemy Sepolia ETH Faucet',
      },
    ],
  },
  stellar: {
    testnet: [
      {
        name: 'Stellar Testnet Faucet',
        url: 'https://laboratory.stellar.org/#account-creator',
        description: 'Create and fund testnet accounts',
      },
      {
        name: 'Stellar Quest Faucet',
        url: 'https://quest.stellar.org/faucet',
        description: 'Get testnet XLM',
      },
    ],
  },
};

// Environment-based configuration with URL parameter support
export const getNetworkConfigForMode = (mode: AppNetworkMode) => ({
  ethereum: ETHEREUM_NETWORKS[mode === 'mainnet' ? 'mainnet' : 'sepolia'],
  stellar: STELLAR_NETWORKS[mode === 'mainnet' ? 'mainnet' : 'testnet'],
  solana: SOLANA_NETWORKS[mode === 'mainnet' ? 'mainnet' : 'testnet'],
});

export const getCurrentNetwork = () => {
  const networkName = readNetworkNameFromEnvOrUrl();
  return getNetworkConfigForMode(networkName);
};

export const getContractAddresses = () => {
  const networkName = readNetworkNameFromEnvOrUrl();
  return {
    ethereum: CONTRACT_ADDRESSES.ethereum[networkName === 'mainnet' ? 'mainnet' : 'sepolia'],
    stellar: CONTRACT_ADDRESSES.stellar[networkName === 'mainnet' ? 'mainnet' : 'testnet'],
  };
};

export const getFaucets = () => {
  const networkName = (import.meta as any).env?.VITE_NETWORK || 'testnet';
  if (networkName === 'mainnet') {
    return { ethereum: [], stellar: [] };
  }
  return {
    ethereum: FAUCETS.ethereum.sepolia,
    stellar: FAUCETS.stellar.testnet,
  };
};

export const isTestnet = () => readNetworkNameFromEnvOrUrl() !== 'mainnet'; 
