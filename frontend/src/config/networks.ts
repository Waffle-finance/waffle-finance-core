/**
 * Network Configuration Layer for WaffleFinance
 *
 * This layer is responsible for resolving the active blockchain network
 * configuration (Ethereum + Stellar) based on environment and URL parameters.
 * It does NOT own API base URLs, feature flags, or route definitions.
 */

import { resolveViteMainnetRpcUrl, resolveViteSepoliaRpcUrl } from './rpc-urls';

export type AppNetworkMode = 'mainnet' | 'testnet';

// ── Network resolution ────────────────────────────────────────────────────────

function readNetworkNameFromEnvOrUrl(): AppNetworkMode {
  let networkName: AppNetworkMode = 'testnet';

  if (typeof window !== 'undefined') {
    const urlNetwork = new URLSearchParams(window.location.search).get('network');
    if (urlNetwork === 'mainnet' || urlNetwork === 'testnet') {
      networkName = urlNetwork;
      return resolveNetworkMode(networkName);
    }
  }

  const raw = (import.meta as any).env || {};
  networkName = raw.VITE_NETWORK ?? raw.VITE_NETWORK_MODE ?? 'testnet';

  return resolveNetworkMode(networkName);
}

/** Clamp requested mode when mainnet is temporarily disabled. */
export const resolveNetworkMode = (requested: AppNetworkMode): AppNetworkMode => {
  if (requested === 'mainnet' && !isMainnetEnabled()) {
    return 'testnet';
  }
  return requested;
};

/** When false, the dApp is testnet-only. Mainnet toggle shows "Mainnet Coming". */
export const isMainnetEnabled = (): boolean => {
  const raw = (import.meta as any).env || {};
  return raw.VITE_MAINNET_ENABLED === 'true';
};

/** True when the resolved network is testnet. */
export const isTestnet = (): boolean => readNetworkNameFromEnvOrUrl() !== 'mainnet';

// ── Network config types ──────────────────────────────────────────────────────

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

// ── Static network definitions ────────────────────────────────────────────────

export const ETHEREUM_NETWORKS: Record<string, NetworkConfig> = {
  mainnet: {
    id: 1,
    name: 'ethereum',
    displayName: 'Ethereum Mainnet',
    rpcUrl: resolveViteMainnetRpcUrl(),
    explorerUrl: 'https://etherscan.io',
    escrowFactory: '0xa7bCb4EAc8964306F9e3764f67Db6A7af6DdF99A',
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
    escrowFactory: '0x3f344ACDd17a0c4D21096da895152820f595dc8A',
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
      htlcBridge: '0x0000000000000000000000000000000000000000',
      escrowFactory: '0xa7bcb4eac8964306f9e3764f67db6a7af6ddf99a',
      testToken: '0xA0b86a33E6441b8bB770AE39aaDC4e75C0f03E6F',
    },
    sepolia: {
      htlcBridge: '0x3f344ACDd17a0c4D21096da895152820f595dc8A',
      escrowFactory: '0x6c3818E074d891F1FBB3A75913e4BDe87BcF1123',
      testToken: '0x677afcB4A57a938A74a1A76a93913dE4Db3e5C63',
    },
  },
  stellar: {
    mainnet: {
      bridgeAccount: 'GCKFBEIYTKP6RSTVVK6FKXKMK7DIS3R6SEWXO5SWH3V7GDPRX2VDKYXB',
      escrowAccount: 'GCKFBEIYTKP6RSTVVK6FKXKMK7DIS3R6SEWXO5SWH3V7GDPRX2VDKYXB',
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

// ── Derived network accessors ─────────────────────────────────────────────────

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
  const raw = (import.meta as any).env || {};
  const networkName = raw.VITE_NETWORK || 'testnet';
  if (networkName === 'mainnet') {
    return { ethereum: [], stellar: [] };
  }
  return {
    ethereum: FAUCETS.ethereum.sepolia,
    stellar: FAUCETS.stellar.testnet,
  };
};

// ── Route selection ───────────────────────────────────────────────────────────

export type AppRouteSurface = 'mainnet' | 'testnet';

/**
 * Select the route surface for the app. Mainnet routes are only reachable when
 * the mainnet build flag is enabled; otherwise the requested mode is clamped to
 * testnet by `resolveNetworkMode`.
 */
export const selectRouteSurface = (
  requested: AppNetworkMode = readNetworkNameFromEnvOrUrl(),
): AppRouteSurface => resolveNetworkMode(requested);
