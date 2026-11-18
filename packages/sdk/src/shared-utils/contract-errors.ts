/**
 * Cross-chain contract error normalization.
 *
 * Different chains surface contract failures differently:
 * - Ethereum: viem error messages with revert reasons
 * - Soroban: Stellar SDK host errors and simulation failures
 * - Solana: Anchor program errors and account validation failures
 *
 * This module provides a unified error taxonomy so all services can handle
 * chain-specific failures through a common API.
 */

export type ContractErrorCategory =
  | "wallet_unavailable"
  | "insufficient_funds"
  | "insufficient_allowance"
  | "timelock_not_expired"
  | "invalid_preimage"
  | "order_not_found"
  | "resolver_not_authorised"
  | "safety_deposit_too_small"
  | "simulation_failed"
  | "tx_rejected"
  | "network_error"
  | "unknown";

export interface NormalizedContractError {
  /** Stable error category for programmatic handling */
  category: ContractErrorCategory;
  /** Human-readable message */
  message: string;
  /** Whether the operation can be retried */
  retryable: boolean;
  /** Chain where the error occurred */
  chain: "ethereum" | "stellar" | "solana";
  /** Original error for debugging */
  cause?: unknown;
  /** Chain-specific error code if available */
  chainErrorCode?: string;
}

/**
 * Normalize an Ethereum contract error into a stable category.
 */
export function normalizeEthereumError(err: unknown): NormalizedContractError {
  const msg = err instanceof Error ? err.message : String(err);
  const lc = msg.toLowerCase();

  // Wallet / signer errors
  if (
    lc.includes("user rejected") ||
    lc.includes("rejected the request") ||
    lc.includes("wallet client") ||
    lc.includes("walletclient") ||
    lc.includes("signer")
  ) {
    return {
      category: "wallet_unavailable",
      message: "Wallet rejected or is unavailable",
      retryable: true,
      chain: "ethereum",
      cause: err,
    };
  }

  // Timelock errors
  if (lc.includes("timelock") && (lc.includes("not expired") || lc.includes("active"))) {
    return {
      category: "timelock_not_expired",
      message: "Timelock has not yet expired",
      retryable: false,
      chain: "ethereum",
      cause: err,
    };
  }

  // Preimage/hashlock errors
  if (lc.includes("invalid preimage") || lc.includes("hashlock")) {
    return {
      category: "invalid_preimage",
      message: "Preimage does not match the hashlock",
      retryable: false,
      chain: "ethereum",
      cause: err,
    };
  }

  // Order not found
  if (lc.includes("not found") || lc.includes("does not exist") || lc.includes("ordernotfound")) {
    return {
      category: "order_not_found",
      message: "Order not found on-chain",
      retryable: false,
      chain: "ethereum",
      cause: err,
    };
  }

  // ERC20 allowance
  if (lc.includes("insufficientallowance") || lc.includes("insufficient allowance")) {
    return {
      category: "insufficient_allowance",
      message: "ERC20 allowance is too low",
      retryable: false,
      chain: "ethereum",
      cause: err,
    };
  }

  // Resolver authorization
  if (
    lc.includes("resolvernotauthorised") ||
    lc.includes("resolver not authorised") ||
    lc.includes("resolver not authorized")
  ) {
    return {
      category: "resolver_not_authorised",
      message: "Caller is not an active resolver",
      retryable: false,
      chain: "ethereum",
      cause: err,
    };
  }

  // Safety deposit
  if (lc.includes("safetydeposittoosmall") || lc.includes("safety deposit too small")) {
    return {
      category: "safety_deposit_too_small",
      message: "Safety deposit is below the contract minimum",
      retryable: false,
      chain: "ethereum",
      cause: err,
    };
  }

  // Insufficient funds
  if (lc.includes("insufficient balance") || lc.includes("insufficient funds")) {
    return {
      category: "insufficient_funds",
      message: "Insufficient balance for transaction",
      retryable: false,
      chain: "ethereum",
      cause: err,
    };
  }

  // Simulation failures
  if (
    lc.includes("simulat") ||
    lc.includes("invalidtoken") ||
    lc.includes("invalidvalue") ||
    lc.includes("reverted")
  ) {
    return {
      category: "simulation_failed",
      message: "Contract simulation rejected the call",
      retryable: false,
      chain: "ethereum",
      cause: err,
    };
  }

  // Network errors
  if (lc.includes("timeout") || lc.includes("nonce") || lc.includes("network")) {
    return {
      category: "network_error",
      message: "Network or RPC error",
      retryable: true,
      chain: "ethereum",
      cause: err,
    };
  }

  return {
    category: "unknown",
    message: msg,
    retryable: false,
    chain: "ethereum",
    cause: err,
  };
}

/**
 * Normalize a Solana contract error into a stable category.
 */
export function normalizeSolanaError(err: unknown): NormalizedContractError {
  const msg = err instanceof Error ? err.message : String(err);
  const lc = msg.toLowerCase();

  // Simulation mode
  if (lc.includes("simulation mode")) {
    return {
      category: "simulation_failed",
      message: "Client is in simulation mode",
      retryable: false,
      chain: "solana",
      cause: err,
    };
  }

  // Account discriminator
  if (lc.includes("discriminator")) {
    return {
      category: "order_not_found",
      message: "Account discriminator mismatch",
      retryable: false,
      chain: "solana",
      cause: err,
    };
  }

  // Timelock
  if (lc.includes("timelock") || lc.includes("not expired")) {
    return {
      category: "timelock_not_expired",
      message: "Timelock has not yet expired",
      retryable: false,
      chain: "solana",
      cause: err,
    };
  }

  // Preimage
  if (lc.includes("invalid preimage") || lc.includes("hashlock")) {
    return {
      category: "invalid_preimage",
      message: "Preimage does not match hashlock",
      retryable: false,
      chain: "solana",
      cause: err,
    };
  }

  // Account not found
  if (
    lc.includes("account not found") ||
    lc.includes("does not exist") ||
    lc.includes("too small")
  ) {
    return {
      category: "order_not_found",
      message: "Order account not found",
      retryable: false,
      chain: "solana",
      cause: err,
    };
  }

  // Network errors
  if (lc.includes("timeout") || lc.includes("network") || lc.includes("blockhash")) {
    return {
      category: "network_error",
      message: "Network or RPC error",
      retryable: true,
      chain: "solana",
      cause: err,
    };
  }

  return {
    category: "unknown",
    message: msg,
    retryable: false,
    chain: "solana",
    cause: err,
  };
}

/**
 * Normalize a Soroban/Stellar contract error into a stable category.
 */
export function normalizeSorobanError(err: unknown): NormalizedContractError {
  const msg = err instanceof Error ? err.message : String(err);
  const lc = msg.toLowerCase();

  // Network errors
  if (
    lc.includes("timeout") ||
    lc.includes("etimedout") ||
    lc.includes("econnreset") ||
    lc.includes("socket hang up") ||
    lc.includes("network error") ||
    lc.includes("connection refused") ||
    lc.includes("econnrefused")
  ) {
    return {
      category: "network_error",
      message: "RPC timeout or connectivity error",
      retryable: true,
      chain: "stellar",
      cause: err,
    };
  }

  // Simulation failures
  if (
    lc.includes("simulation failed") ||
    lc.includes("simulation rejected") ||
    lc.includes("host error") ||
    lc.includes("wasm vm") ||
    lc.includes("wasmvm") ||
    lc.includes("invoke host") ||
    lc.includes("hostenvcatch") ||
    lc.includes("contracterror")
  ) {
    return {
      category: "simulation_failed",
      message: "Contract simulation or host error",
      retryable: false,
      chain: "stellar",
      cause: err,
    };
  }

  // Preimage errors
  if (lc.includes("hashlock") || lc.includes("preimage")) {
    return {
      category: "invalid_preimage",
      message: "Preimage does not match hashlock",
      retryable: false,
      chain: "stellar",
      cause: err,
    };
  }

  // Timelock errors
  if (lc.includes("timelock")) {
    return {
      category: "timelock_not_expired",
      message: "Timelock has not yet expired",
      retryable: false,
      chain: "stellar",
      cause: err,
    };
  }

  // Auth errors
  if (
    lc.includes("bad auth") ||
    lc.includes("tx_bad_auth") ||
    lc.includes("txbadauth") ||
    (lc.includes("signature") && lc.includes("invalid"))
  ) {
    return {
      category: "tx_rejected",
      message: "Transaction rejected: bad auth or invalid signature",
      retryable: false,
      chain: "stellar",
      cause: err,
    };
  }

  // Method not found
  if (
    lc.includes("function not found") ||
    lc.includes("unknown method") ||
    lc.includes("method not found") ||
    lc.includes("no such method") ||
    lc.includes("no such function")
  ) {
    return {
      category: "tx_rejected",
      message: "Contract method not found",
      retryable: false,
      chain: "stellar",
      cause: err,
    };
  }

  // XDR errors
  if (
    lc.includes("xdr decode") ||
    lc.includes("malformed") ||
    (lc.includes("parse") && lc.includes("error")) ||
    lc.includes("decode error")
  ) {
    return {
      category: "tx_rejected",
      message: "XDR decode or data malformed",
      retryable: false,
      chain: "stellar",
      cause: err,
    };
  }

  // Submission failures
  if (lc.includes("submit failed") || lc.includes("tx_rejected")) {
    return {
      category: "tx_rejected",
      message: "Transaction was rejected by the network",
      retryable: false,
      chain: "stellar",
      cause: err,
    };
  }

  return {
    category: "unknown",
    message: msg,
    retryable: false,
    chain: "stellar",
    cause: err,
  };
}

/**
 * Normalize a contract error from any supported chain.
 */
export function normalizeContractError(
  err: unknown,
  chain: "ethereum" | "stellar" | "solana"
): NormalizedContractError {
  switch (chain) {
    case "ethereum":
      return normalizeEthereumError(err);
    case "stellar":
      return normalizeSorobanError(err);
    case "solana":
      return normalizeSolanaError(err);
  }
}
