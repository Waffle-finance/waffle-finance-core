/**
 * Wagmi v2 client configuration for WaffleFinance.
 *
 * Wires up viem transports for Ethereum Mainnet and Sepolia, and registers the
 * Mainnet and Sepolia transports. RainbowKit v2 wraps this config through
 * `getDefaultConfig`, which handles WalletConnect project-id plumbing and
 * supplies additional connectors (Coinbase Wallet, Rainbow, etc.) automatically.
 *
 * The wagmi `Config` exported here is consumed by:
 *   - `<WagmiProvider config={wagmiConfig}>` in main.tsx
 *   - `useEthereumWallet` hook (reads account, chain, sends transactions)
 *   - `useNetworkMode` (switches chains via wagmi's useSwitchChain)
 */

import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import { mainnet, sepolia } from 'wagmi/chains';
import { http } from 'wagmi';
import { resolveViteMainnetRpcUrl, resolveViteSepoliaRpcUrl } from './rpc-urls';

// WalletConnect project ID is optional for MetaMask-only flows but required
// for the full RainbowKit modal.  Provide a build-time override via
// VITE_WALLETCONNECT_PROJECT_ID; fall back to a placeholder that disables
// WalletConnect silently rather than throwing.
const walletConnectProjectId =
  (import.meta as any).env?.VITE_WALLETCONNECT_PROJECT_ID ?? 'wafflefinance-dev';

export const wagmiConfig = getDefaultConfig({
  appName: 'WaffleFinance',
  projectId: walletConnectProjectId,
  chains: [mainnet, sepolia],
  transports: {
    [mainnet.id]: http(resolveViteMainnetRpcUrl()),
    [sepolia.id]: http(resolveViteSepoliaRpcUrl()),
  },
  // SSR is off — this is a pure client-side Vite app.
  ssr: false,
});
