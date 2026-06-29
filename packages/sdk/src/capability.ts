import type { Chain, ExternalBridgeKind } from "./types/index.js";

export type CapabilityStatus = "supported" | "partially-supported" | "unsupported";

export interface Capability {
  status: CapabilityStatus;
  reason: string;
  actionableGuidance: string;
}

/**
 * Returns the capability details for a given swap route (leg direction and bridge provider).
 * This establishes a clear contract for support states in both the backend API and frontend UI.
 */
export function getRouteCapability(
  fromChain: Chain | string,
  toChain: Chain | string,
  routeKind: ExternalBridgeKind | string = "wafflefinance-htlc",
  networkMode: "testnet" | "mainnet" = "testnet"
): Capability {
  // 1. Validate route kind (only wafflefinance-htlc is currently built-in/supported)
  if (routeKind !== "wafflefinance-htlc") {
    return {
      status: "unsupported",
      reason: `Bridge route '${routeKind}' is currently under development.`,
      actionableGuidance: `This route adapter is scheduled for release in Q1 2027. Please select the 'wafflefinance-htlc' route.`
    };
  }

  // 2. Prevent same-chain swaps
  if (fromChain === toChain) {
    return {
      status: "unsupported",
      reason: `Intra-chain transfers on ${fromChain} are not supported.`,
      actionableGuidance: "Please select different source and destination chains for a cross-chain swap."
    };
  }

  const isSolanaInvolved = fromChain === "solana" || toChain === "solana";

  // 3. Check Solana capability
  if (isSolanaInvolved) {
    if (networkMode === "mainnet") {
      return {
        status: "unsupported",
        reason: "Solana swaps are not supported on Mainnet yet.",
        actionableGuidance: "Please use testnet to test Solana simulation mode, or switch your target chains to Ethereum and Stellar."
      };
    } else {
      // Testnet Solana is under simulation
      return {
        status: "partially-supported",
        reason: "Solana is in Simulation Mode on Testnet.",
        actionableGuidance: "Solana transactions are simulated. Swaps will be announced to the coordinator, but actual on-chain settlement is mocked."
      };
    }
  }

  // 4. Validate accepted chain combinations (Ethereum <-> Stellar)
  const isValidEthStellar =
    (fromChain === "ethereum" && toChain === "stellar") ||
    (fromChain === "stellar" && toChain === "ethereum");

  if (!isValidEthStellar) {
    return {
      status: "unsupported",
      reason: `The swap route from ${fromChain} to ${toChain} is not supported.`,
      actionableGuidance: "Please choose from the supported options: Ethereum, Stellar, or Solana (testnet only)."
    };
  }

  // 5. Fully supported Ethereum <-> Stellar
  return {
    status: "supported",
    reason: "Fully supported route.",
    actionableGuidance: "This swap leg is fully operational."
  };
}
