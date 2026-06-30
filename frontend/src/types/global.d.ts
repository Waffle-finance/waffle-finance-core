import type { DeploymentEnvironment, FeatureFlags } from '../config/feature-flag-definitions';

export {};

// ─── Window / browser globals ────────────────────────────────────────────────

declare global {
  const __DEPLOYMENT_ENVIRONMENT__: DeploymentEnvironment;
  const __FEATURE_FLAGS__: Readonly<FeatureFlags>;

  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: any[] }) => Promise<any>;
      on(event: string, handler: (...args: any[]) => void): void;
      removeListener(event: string, handler: (...args: any[]) => void): void;
      selectedAddress?: string;
    };
    solana?: {
      isPhantom?: boolean;
      publicKey: { toString(): string } | null;
      isConnected: boolean;
      connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: { toString(): string } }>;
      disconnect(): Promise<void>;
      signTransaction(tx: unknown): Promise<unknown>;
      signAllTransactions(txs: unknown[]): Promise<unknown[]>;
      on(event: string, handler: (...args: any[]) => void): void;
      removeListener(event: string, handler: (...args: any[]) => void): void;
    };
    phantom?: { solana?: Window['solana'] };
  }

  // ─── Vite env ──────────────────────────────────────────────────────────────
  interface ImportMetaEnv {
    readonly VITE_NETWORK: string;
    readonly VITE_API_BASE_URL: string;
    readonly VITE_ETHEREUM_CHAIN_ID: string;
    readonly VITE_STELLAR_NETWORK: string;
    readonly VITE_ETHEREUM_RPC_URL: string;
    readonly VITE_STELLAR_HORIZON_URL: string;
    readonly VITE_NETWORK_MODE: string;
    readonly VITE_DEPLOYMENT_ENV?: DeploymentEnvironment;
    readonly VITE_FEATURE_MAINNET?: 'true' | 'false';
    readonly VITE_FEATURE_TESTNET_FAUCETS?: 'true' | 'false';
    readonly VITE_FEATURE_DEBUG_MODE?: 'true' | 'false';
    readonly VITE_FEATURE_MOCK_DATA?: 'true' | 'false';
    readonly VITE_MAINNET_ENABLED?: 'true' | 'false';
    readonly VITE_ENABLE_TESTNET_FAUCETS?: 'true' | 'false';
    readonly VITE_ENABLE_DEBUG_MODE?: 'true' | 'false';
    readonly VITE_ENABLE_MOCK_DATA?: 'true' | 'false';
    readonly VITE_INFURA_API_KEY: string;
    readonly VITE_ONEINCH_API_KEY: string;
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
}
