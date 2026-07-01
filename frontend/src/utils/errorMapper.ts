export interface ClassifiedError {
  type: 'wallet_rejection' | 'insufficient_funds' | 'network_mismatch' | 'rpc_timeout' | 'unknown';
  message: string;
  action: string;
}

/**
 * Classifies raw transaction errors from various Web3 providers (MetaMask, Freighter, Phantom)
 * and translates them into user-friendly messages and recovery actions.
 * 
 * Time Complexity: O(1) - Constant time lookups and string searches
 * Space Complexity: O(1) - Returns a predefined memory structure
 */
export function classifyTransactionError(error: any, direction?: string): ClassifiedError {
  if (!error) {
    return {
      type: 'unknown',
      message: 'An unexpected transaction error occurred.',
      action: 'Please check your wallet connection and try again.'
    };
  }

  // Normalize error properties
  const message = error.message || error.reason || '';
  const code = error.code;
  
  const isStellar = direction === 'xlm_to_eth' || direction === 'xlm_to_sol';
  const isSolana = direction === 'sol_to_eth' || direction === 'sol_to_xlm';
  const isEthereum = direction === 'eth_to_xlm' || direction === 'eth_to_sol';

  // 1. Wallet Rejection Detection
  const isWalletRejection = 
    code === 4001 || 
    code === 'ACTION_REJECTED' ||
    message.includes('user rejected') ||
    message.includes('User rejected') ||
    message.includes('ACTION_REJECTED') ||
    message.includes('User declined') ||
    message.includes('declined') ||
    message.includes('Signature request denied') ||
    message.includes('Transaction was rejected');

  if (isWalletRejection) {
    return {
      type: 'wallet_rejection',
      message: 'Transaction request rejected.',
      action: 'Please approve the transaction signature request in your wallet extension.'
    };
  }

  // 2. Insufficient Funds Detection
  const isInsufficientFunds =
    code === -32000 ||
    code === 'INSUFFICIENT_FUNDS' ||
    message.includes('insufficient funds') ||
    message.includes('INSUFFICIENT_FUNDS') ||
    message.includes('transfer amount exceeds balance') ||
    message.includes('tx_insufficient_balance') ||
    message.includes('op_underfunded') ||
    message.includes('insufficient lamports') ||
    (code === -32603 && message.toLowerCase().includes('insufficient'));

  if (isInsufficientFunds) {
    const asset = isStellar ? 'XLM' : isSolana ? 'SOL' : 'ETH';
    return {
      type: 'insufficient_funds',
      message: `Insufficient ${asset} balance to complete swap.`,
      action: `Ensure you have enough ${asset} in your wallet to cover the bridge amount and gas fees.`
    };
  }

  // 3. Network Mismatch Detection
  const isNetworkMismatch =
    message.includes('network mismatch') ||
    message.includes('mismatch') ||
    message.includes('wallet_switchEthereumChain') ||
    message.includes('wrong network') ||
    message.includes('Chain ID mismatch');

  if (isNetworkMismatch) {
    return {
      type: 'network_mismatch',
      message: 'Network mismatch detected.',
      action: 'Please switch your wallet network to match the bridge route selected.'
    };
  }

  // 4. RPC / Timeout Detection
  const isRpcTimeout =
    code === -32005 ||
    message.includes('timeout') ||
    message.includes('TIMEOUT') ||
    message.includes('request limit exceeded') ||
    message.includes('exceeded') ||
    message.includes('NetworkError') ||
    message.includes('net::ERR') ||
    message.includes('fetch');

  if (isRpcTimeout) {
    return {
      type: 'rpc_timeout',
      message: message ? `Network connection timed out: ${message}` : 'Network connection timed out.',
      action: 'The RPC node took too long to respond. Please check your network connection and try again.'
    };
  }

  // 5. Fallback Unknown Error
  return {
    type: 'unknown',
    message: message ? `Transaction submission failed: ${message}` : 'Transaction submission failed.',
    action: 'Check your wallet extension status or RPC configuration, then try again.'
  };
}
