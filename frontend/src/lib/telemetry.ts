export type TelemetryFailureType = 'wallet_rejection' | 'network_failure' | 'contract_rejection' | 'unknown';

export interface TelemetryPayload {
  orderId?: string;
  direction: string;
  step: string;
  walletType: 'metamask' | 'freighter' | 'unknown';
  failureType: TelemetryFailureType;
  errorCode?: string | number;
  errorMessage: string;
  state?: Record<string, any>;
}

export function classifyError(error: any, _walletType: 'metamask' | 'freighter' | 'unknown'): {
  failureType: TelemetryFailureType;
  errorCode?: string | number;
  errorMessage: string;
} {
  const message = error?.message || String(error || '');
  const code = error?.code;

  // 1. Wallet Rejection
  if (
    code === 4001 ||
    message.toLowerCase().includes('user rejected') ||
    message.toLowerCase().includes('user declined') ||
    message.includes('User declined')
  ) {
    return {
      failureType: 'wallet_rejection',
      errorCode: code || 'USER_REJECTED',
      errorMessage: 'User rejected the transaction signature request.',
    };
  }

  // 2. Network / RPC Failures
  if (
    message.toLowerCase().includes('network error') ||
    message.toLowerCase().includes('failed to fetch') ||
    message.toLowerCase().includes('fetch failed') ||
    message.toLowerCase().includes('timeout') ||
    message.toLowerCase().includes('time out') ||
    code === -32005 || // Limit exceeded / Rate limit
    code === 'TIMEOUT'
  ) {
    return {
      failureType: 'network_failure',
      errorCode: code || 'NETWORK_ERROR',
      errorMessage: 'Network or RPC communication failure.',
    };
  }

  // 3. Contract / Blockchain Rejections
  if (
    code === -32603 || // Internal error (usually revert)
    code === -32000 || // Insufficient funds
    code === -32602 || // Invalid parameters
    message.toLowerCase().includes('insufficient funds') ||
    message.toLowerCase().includes('revert') ||
    message.toLowerCase().includes('always failing transaction') ||
    message.toLowerCase().includes('transaction failed')
  ) {
    // Clean message of hex values / hashes to be non-sensitive
    const cleanedMessage = message.replace(/0x[a-fA-F0-9]{40,}/g, '[ADDRESS/HASH]');
    return {
      failureType: 'contract_rejection',
      errorCode: code || 'CONTRACT_REJECTION',
      errorMessage: cleanedMessage,
    };
  }

  // 4. Fallback
  const cleanedMessage = message.replace(/0x[a-fA-F0-9]{40,}/g, '[ADDRESS/HASH]');
  return {
    failureType: 'unknown',
    errorCode: code,
    errorMessage: cleanedMessage,
  };
}

const PRODUCTION_API_BASE_URL = 'https://oversync-k36vx.ondigitalocean.app';
const API_BASE_URL = import.meta.env.PROD
  ? ''
  : import.meta.env.VITE_API_BASE_URL || PRODUCTION_API_BASE_URL;

export async function trackFailedSubmission(params: {
  orderId?: string;
  direction: string;
  step: string;
  walletType: 'metamask' | 'freighter' | 'unknown';
  error: any;
  state?: Record<string, any>;
}): Promise<void> {
  const { failureType, errorCode, errorMessage } = classifyError(params.error, params.walletType);

  const payload: TelemetryPayload = {
    orderId: params.orderId,
    direction: params.direction,
    step: params.step,
    walletType: params.walletType,
    failureType,
    errorCode,
    errorMessage,
    state: params.state,
  };

  console.warn('📡 Sending telemetry event:', payload);

  try {
    const res = await fetch(`${API_BASE_URL}/api/telemetry`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error(`Telemetry endpoint returned status ${res.status}`);
    }
  } catch (err) {
    console.error('Failed to send telemetry event to coordinator:', err);
  }
}
