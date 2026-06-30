import { loadCoordinatorConfig } from "@wafflefinance/config/node";
import type { CoordinatorConfig } from "@wafflefinance/config";

export type { CoordinatorConfig };
export type Network = "testnet" | "mainnet";

export function loadConfig(): CoordinatorConfig {
  return loadCoordinatorConfig();
}
