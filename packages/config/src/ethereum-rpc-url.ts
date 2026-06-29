/**
 * Resolves EVM JSON-RPC URLs from environment variables.
 *
 * Priority (testnet): SEPOLIA_RPC_URL → ETHEREUM_RPC_URL → Infura (INFURA_API_KEY) → public fallback
 * Priority (mainnet): MAINNET_RPC_URL → ETHEREUM_RPC_URL → Infura (INFURA_API_KEY) → public fallback
 */

export type EvmNetworkMode = 'testnet' | 'mainnet';

const INFURA_SEPOLIA = 'https://sepolia.infura.io/v3';
const INFURA_MAINNET = 'https://mainnet.infura.io/v3';
const PUBLIC_SEPOLIA = 'https://ethereum-sepolia-rpc.publicnode.com';
const PUBLIC_MAINNET = 'https://ethereum-rpc.publicnode.com';

export function infuraRpcUrl(network: EvmNetworkMode, apiKey: string): string {
  const key = apiKey.trim();
  const base = network === 'mainnet' ? INFURA_MAINNET : INFURA_SEPOLIA;
  return `${base}/${key}`;
}

export function resolveEthereumRpcUrl(
  network: EvmNetworkMode,
  env: Record<string, string | undefined> = (typeof process !== 'undefined' ? process.env : {}) as Record<string, string | undefined>
): string {
  const infuraKey = env.INFURA_API_KEY?.trim();

  if (network === 'testnet') {
    return (
      env.SEPOLIA_RPC_URL?.trim() ||
      env.ETHEREUM_RPC_URL?.trim() ||
      (infuraKey ? infuraRpcUrl('testnet', infuraKey) : '') ||
      PUBLIC_SEPOLIA
    );
  }

  return (
    env.MAINNET_RPC_URL?.trim() ||
    env.ETHEREUM_RPC_URL?.trim() ||
    (infuraKey ? infuraRpcUrl('mainnet', infuraKey) : '') ||
    PUBLIC_MAINNET
  );
}
