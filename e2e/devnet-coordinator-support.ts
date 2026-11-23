/** Guards and fixture builders for the opt-in devnet event → coordinator suite. */

export const SEPOLIA_CHAIN_ID = 11_155_111;
export const MAINNET_CHAIN_ID = 1;
export const DEVNET_FINALITY_CONFIRMATIONS = 12;

/**
 * Refuse mainnet RPC endpoints and non-testnet chain IDs.
 * The suite submits real, funded transactions and must never point at mainnet.
 */
export function assertDevnetRpcAllowed(rpcUrl: string, chainId: number): void {
  let host = "";
  let pathname = "";
  try {
    const parsed = new URL(rpcUrl);
    host = parsed.hostname.toLowerCase();
    pathname = parsed.pathname.toLowerCase();
  } catch {
    throw new Error(`invalid devnet RPC URL: ${rpcUrl}`);
  }

  const mainnetPattern =
    /(^|\.|-)(mainnet|eth-mainnet|ethereum-mainnet)(\.|$)|(^|\/)eth(\/|$)|mainnet/;
  if (mainnetPattern.test(`${host}${pathname}`) || chainId === MAINNET_CHAIN_ID) {
    throw new Error(`refusing to run devnet suite against mainnet RPC: ${rpcUrl} (chain ${chainId})`);
  }
  if (chainId !== SEPOLIA_CHAIN_ID) {
    throw new Error(`unsupported devnet chain id ${chainId}; expected ${SEPOLIA_CHAIN_ID} (Sepolia)`);
  }
}

export interface DevnetAnnouncePayload {
  direction: "eth_to_xlm";
  hashlock: string;
  srcChain: "ethereum";
  srcAddress: string;
  srcAsset: string;
  srcAmount: string;
  srcSafetyDeposit: string;
  dstChain: "stellar";
  dstAddress: string;
  dstAsset: string;
  dstAmount: string;
}

export function buildDevnetAnnouncePayload(input: {
  hashlock: string;
  signerAddress: string;
  destinationAddress: string;
}): DevnetAnnouncePayload {
  return {
    direction: "eth_to_xlm",
    hashlock: input.hashlock,
    srcChain: "ethereum",
    srcAddress: input.signerAddress,
    srcAsset: "0x0000000000000000000000000000000000000000",
    srcAmount: "1000000000000000",
    srcSafetyDeposit: "0",
    dstChain: "stellar",
    dstAddress: input.destinationAddress,
    dstAsset: "native",
    dstAmount: "1000",
  };
}

/** Deterministic cleanup record kept when an external provider fails or times out. */
export function devnetCleanupRecord(input: {
  txHash: string;
  orderId: string;
  providerFailure: boolean;
  timeoutMs: number;
}): { action: "refund_after_timelock"; txHash: string; orderId: string; providerFailure: boolean; timeoutMs: number } {
  return {
    action: "refund_after_timelock",
    txHash: input.txHash,
    orderId: input.orderId,
    providerFailure: input.providerFailure,
    timeoutMs: input.timeoutMs,
  };
}
