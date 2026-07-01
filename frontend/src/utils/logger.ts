/**
 * Structured Logger Utility
 * - Enabled in development mode only
 * - Provides structured logging with event types
 * - Masks sensitive data (wallet addresses, private keys, etc.)
 * - Lightweight and optional for production builds
 */

/// <reference types="vite/client" />

// Log levels
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

// Event types for structured logging
export type EventType = 
  | 'wallet_connect'
  | 'wallet_disconnect'
  | 'wallet_error'
  | 'wallet_state_change'
  | 'transaction_start'
  | 'transaction_sign'
  | 'transaction_submit'
  | 'transaction_confirm'
  | 'transaction_error'
  | 'network_check'
  | 'network_switch'
  | 'network_error'
  | 'api_request'
  | 'api_response'
  | 'api_error'
  | 'validation_error'
  | 'state_change';

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  event: EventType;
  message: string;
  data?: Record<string, any>;
}

// Sensitive patterns to mask
const SENSITIVE_PATTERNS = [
  /0x[a-fA-F0-9]{40}/g, // Ethereum addresses
  /0x[a-fA-F0-9]{64}/g, // Private keys / Transaction hashes (we'll mask hashes partially)
  /(0x[a-fA-F0-9]{40,})/g, // Generic hex strings (addresses, keys)
];

/**
 * Recursively mask sensitive data in objects
 */
function maskSensitiveData(data: any): any {
  if (typeof data !== 'object' || data === null) {
    return data;
  }

  if (Array.isArray(data)) {
    return data.map(item => maskSensitiveData(item));
  }

  const masked: Record<string, any> = {};

  for (const [key, value] of Object.entries(data)) {
    // Skip masking for known non-sensitive keys
    if (['status', 'level', 'code', 'count', 'balance', 'amount', 'decimals', 'chainId', 'networkMode'].includes(key.toLowerCase())) {
      masked[key] = value;
      continue;
    }

    // Mask sensitive keys
    if (['address', 'publicKey', 'privateKey', 'secret', 'password', 'token', 'key', 'xdr'].includes(key.toLowerCase())) {
      if (typeof value === 'string') {
        masked[key] = value.length > 10 ? `${value.substring(0, 6)}...${value.substring(value.length - 4)}` : '***';
      } else {
        masked[key] = value;
      }
      continue;
    }

    // Recursively mask nested objects
    if (typeof value === 'object') {
      masked[key] = maskSensitiveData(value);
    } else if (typeof value === 'string') {
      // Apply regex-based masking for hex strings
      let maskedValue = value;
      SENSITIVE_PATTERNS.forEach(pattern => {
        maskedValue = maskedValue.replace(pattern, (match) => {
          if (match.length <= 10) return match;
          return `${match.substring(0, 6)}...${match.substring(match.length - 4)}`;
        });
      });
      masked[key] = maskedValue;
    } else {
      masked[key] = value;
    }
  }

  return masked;
}

const isDevelopment = import.meta.env.DEV;
const enableDebugLogging = isDevelopment && (import.meta.env.VITE_DEBUG_LOGGING === 'true' || typeof localStorage !== 'undefined' && localStorage.getItem('waffle_debug_logging') === 'true');

class StructuredLogger {
  private isDev: boolean;
  private debugEnabled: boolean;

  constructor() {
    this.isDev = isDevelopment;
    this.debugEnabled = enableDebugLogging;
  }

  /**
   * Check if logging is enabled
   */
  private isEnabled(): boolean {
    return this.isDev && this.debugEnabled;
  }

  /**
   * Format and output a log entry
   */
  private output(level: LogLevel, entry: LogEntry): void {
    if (!this.isEnabled()) return;

    const style = this.getStyleForLevel(level);
    const prefix = `[${entry.event}]`;

    if (entry.data) {
      const maskedData = maskSensitiveData(entry.data);
      console[level](`%c${prefix} ${entry.message}`, style, maskedData);
    } else {
      console[level](`%c${prefix} ${entry.message}`, style);
    }
  }

  /**
   * Get console style for log level
   */
  private getStyleForLevel(level: LogLevel): string {
    const styles: Record<LogLevel, string> = {
      debug: 'color: #999; font-size: 12px;',
      info: 'color: #2563eb; font-weight: bold;',
      warn: 'color: #ea580c; font-weight: bold;',
      error: 'color: #dc2626; font-weight: bold;',
    };
    return styles[level] || '';
  }

  /**
   * Log an event with structured data
   */
  event(
    eventType: EventType,
    message: string,
    data?: Record<string, any>,
    level: LogLevel = 'info'
  ): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      event: eventType,
      message,
      data,
    };

    this.output(level, entry);
  }

  /**
   * Log wallet connection event
   */
  walletConnect(wallet: string, address?: string, data?: Record<string, any>): void {
    this.event('wallet_connect', `Connected to ${wallet} wallet`, { wallet, address, ...data }, 'info');
  }

  /**
   * Log wallet disconnection event
   */
  walletDisconnect(wallet: string, data?: Record<string, any>): void {
    this.event('wallet_disconnect', `Disconnected from ${wallet} wallet`, { wallet, ...data }, 'info');
  }

  /**
   * Log wallet error
   */
  walletError(wallet: string, error: any, data?: Record<string, any>): void {
    const message = error instanceof Error ? error.message : String(error);
    this.event('wallet_error', `${wallet} wallet error: ${message}`, { wallet, error: message, ...data }, 'error');
  }

  /**
   * Log transaction start
   */
  transactionStart(orderId: string, data?: Record<string, any>): void {
    this.event('transaction_start', `Transaction started: ${orderId}`, { orderId, ...data }, 'info');
  }

  /**
   * Log transaction sign
   */
  transactionSign(orderId: string, method: string, data?: Record<string, any>): void {
    this.event('transaction_sign', `Signing transaction with ${method}`, { orderId, method, ...data }, 'info');
  }

  /**
   * Log transaction submission
   */
  transactionSubmit(orderId: string, txHash: string, data?: Record<string, any>): void {
    this.event('transaction_submit', `Transaction submitted: ${txHash}`, { orderId, txHash, ...data }, 'info');
  }

  /**
   * Log transaction confirmation
   */
  transactionConfirm(orderId: string, txHash: string, blockNumber?: number, data?: Record<string, any>): void {
    this.event('transaction_confirm', `Transaction confirmed at block ${blockNumber}`, { orderId, txHash, blockNumber, ...data }, 'info');
  }

  /**
   * Log transaction error
   */
  transactionError(orderId: string, error: any, data?: Record<string, any>): void {
    const message = error instanceof Error ? error.message : String(error);
    this.event('transaction_error', `Transaction error: ${message}`, { orderId, error: message, ...data }, 'error');
  }

  /**
   * Log network check
   */
  networkCheck(chainId: string, expected: string, data?: Record<string, any>): void {
    this.event('network_check', `Network check: ${chainId === expected ? 'OK' : 'MISMATCH'}`, { chainId, expected, ...data }, 'info');
  }

  /**
   * Log network switch
   */
  networkSwitch(fromChain: string, toChain: string, data?: Record<string, any>): void {
    this.event('network_switch', `Switching from ${fromChain} to ${toChain}`, { fromChain, toChain, ...data }, 'info');
  }

  /**
   * Log network error
   */
  networkError(error: any, data?: Record<string, any>): void {
    const message = error instanceof Error ? error.message : String(error);
    this.event('network_error', `Network error: ${message}`, { error: message, ...data }, 'error');
  }

  /**
   * Log API request
   */
  apiRequest(method: string, url: string, data?: Record<string, any>): void {
    this.event('api_request', `${method} ${url}`, { method, url, ...data }, 'debug');
  }

  /**
   * Log API response
   */
  apiResponse(method: string, url: string, status: number, data?: Record<string, any>): void {
    this.event('api_response', `${method} ${url} - ${status}`, { method, url, status, ...data }, 'debug');
  }

  /**
   * Log API error
   */
  apiError(method: string, url: string, error: any, data?: Record<string, any>): void {
    const message = error instanceof Error ? error.message : String(error);
    this.event('api_error', `${method} ${url} - Error: ${message}`, { method, url, error: message, ...data }, 'error');
  }

  /**
   * Log validation error
   */
  validationError(field: string, error: string, data?: Record<string, any>): void {
    this.event('validation_error', `Validation error in ${field}: ${error}`, { field, error, ...data }, 'warn');
  }

  /**
   * Log state change
   */
  stateChange(component: string, state: string, data?: Record<string, any>): void {
    this.event('state_change', `${component} state: ${state}`, { component, state, ...data }, 'debug');
  }

  /**
   * Enable debug logging (stored in localStorage)
   */
  enableDebug(): void {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('waffle_debug_logging', 'true');
      this.debugEnabled = true;
      console.log('✅ Debug logging enabled');
    }
  }

  /**
   * Disable debug logging
   */
  disableDebug(): void {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem('waffle_debug_logging');
      this.debugEnabled = false;
      console.log('❌ Debug logging disabled');
    }
  }

  /**
   * Check if debug is enabled
   */
  isDebugEnabled(): boolean {
    return this.debugEnabled;
  }
}

export const logger = new StructuredLogger();

// Export as default for easier imports
export default logger;

