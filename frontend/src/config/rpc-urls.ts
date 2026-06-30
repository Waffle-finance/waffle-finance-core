/**
 * Browser-side EVM RPC URLs (MetaMask / wallet reads).
 *
 * Set either the full URL (VITE_SEPOLIA_RPC_URL) or VITE_INFURA_API_KEY.
 * Infura keys in the frontend are visible in the bundle — that is normal for
 * wallet RPC endpoints; restrict the key by HTTP referrer in the Infura dashboard.
 */

import { frontendConfig } from './networks';

const INFURA_SEPOLIA = 'https://sepolia.infura.io/v3';
const INFURA_MAINNET = 'https://mainnet.infura.io/v3';
const PUBLIC_SEPOLIA = 'https://ethereum-sepolia-rpc.publicnode.com';
const PUBLIC_MAINNET = 'https://ethereum-rpc.publicnode.com';

export function resolveViteSepoliaRpcUrl(): string {
  return (
    frontendConfig.sepoliaRpcUrl ||
    (frontendConfig.infuraApiKey ? `${INFURA_SEPOLIA}/${frontendConfig.infuraApiKey}` : '') ||
    PUBLIC_SEPOLIA
  );
}

export function resolveViteMainnetRpcUrl(): string {
  return (
    frontendConfig.mainnetRpcUrl ||
    (frontendConfig.infuraApiKey ? `${INFURA_MAINNET}/${frontendConfig.infuraApiKey}` : '') ||
    PUBLIC_MAINNET
  );
}
