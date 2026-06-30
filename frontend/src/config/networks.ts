/**
 * Network Configuration for WaffleFinance
 */

import { loadFrontendConfig } from '@wafflefinance/config';
import { resolveViteMainnetRpcUrl, resolveViteSepoliaRpcUrl } from './rpc-urls';

export type AppNetworkMode = 'mainnet' | 'testnet';

// Central configuration entry point for the frontend dApp
export const frontendConfig = loadFrontendConfig((import.meta as any).env || {});

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

export const ETHEREUM_NETWORKS: Record<string, NetworkConfig> = {
  mainnet: {
    id: 1,
    name: 'ethereum',
    displayName: 'Ethereum Mainnet',
    rpcUrl: resolveViteMainnetRpcUrl(),
    explorerUrl: 'https://etherscan.io',
    escrowFactory: '0xa7bCb4EAc8964306F9e3764f67Db6A7af6DdF99A', // 1inch Escrow Factory
    nativeCurrency: {
      name: 'Ether',
      symbol: 'ETH',
      decimals: 18,
    },
    testnet: false,
  },
  sepolia: {
    id: 11155111,
    name: 'sepolia',
    displayName: 'Sepolia Testnet',
    rpcUrl: resolveViteSepoliaRpcUrl(),
    explorerUrl: 'https://sepolia.etherscan.io',
    escrowFactory: '0x3f344ACDd17a0c4D21096da895152820f595dc8A', // Testnet HTLC Bridge
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
    horizonUrl: 'https://horizon.stellar.org',
    networkPassphrase: 'Public Global Stellar Network ; September 2015',
    explorerUrl: 'https://stellarchain.io',
    testnet: false,
  },
  testnet: {
    name: 'testnet',
    displayName: 'Stellar Testnet',
    horizonUrl: 'https://horizon-testnet.stellar.org',
    networkPassphrase: 'Test SDF Network ; September 2015',
    explorerUrl: 'https://testnet.stellarchain.io',
    testnet: true,
  },
};

export const CONTRACT_ADDRESSES = {
  ethereum: {
    mainnet: {
      htlcBridge: '0x0000000000000000000000000000000000000000', // Will use 1inch escrow instead
      escrowFactory: '0xa7bcb4eac8964306f9e3764f67db6a7af6ddf99a', // 1inch Escrow Factory
      testToken: '0xA0b86a33E6441b8bB770AE39aaDC4e75C0f03E6F', // WETH mainnet
    },
    sepolia: {
      htlcBridge: '0x3f344ACDd17a0c4D21096da895152820f595dc8A',
      escrowFactory: '0x6c3818E074d891F1FBB3A75913e4BDe87BcF1123',
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
export const getCurrentNetwork = () => {
  const networkName = readNetworkNameFromEnvOrUrl();
  return {
    ethereum: ETHEREUM_NETWORKS[networkName === 'mainnet' ? 'mainnet' : 'sepolia'],
    stellar: STELLAR_NETWORKS[networkName === 'mainnet' ? 'mainnet' : 'testnet'],
  };
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