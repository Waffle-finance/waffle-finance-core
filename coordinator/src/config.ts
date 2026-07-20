import { loadCoordinatorConfig } from "@wafflefinance/config/node";
import type { CoordinatorConfig } from "@wafflefinance/config";
import {
  isSolanaPlaceholder,
  checkSolanaConfig,
  logSolanaStatus,
  SOLANA_PLACEHOLDER_VALUES,
} from "@wafflefinance/config";

export type { CoordinatorConfig };
export type Network = "testnet" | "mainnet";
export { isSolanaPlaceholder, checkSolanaConfig, logSolanaStatus, SOLANA_PLACEHOLDER_VALUES };

export function loadConfig(): CoordinatorConfig {
  return loadCoordinatorConfig();
}
