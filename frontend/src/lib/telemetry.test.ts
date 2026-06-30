import { describe, it, expect } from 'vitest';
import { classifyError } from './telemetry.js';

describe('classifyError', () => {
  it('classifies MetaMask user rejection correctly', () => {
    const error = {
      code: 4001,
      message: 'User rejected the transaction signature request.',
    };
    const result = classifyError(error, 'metamask');
    expect(result.failureType).toBe('wallet_rejection');
    expect(result.errorCode).toBe(4001);
    expect(result.errorMessage).toBe('User rejected the transaction signature request.');
  });

  it('classifies Freighter user rejection correctly', () => {
    const error = new Error('User declined to sign the transaction.');
    const result = classifyError(error, 'freighter');
    expect(result.failureType).toBe('wallet_rejection');
    expect(result.errorCode).toBe('USER_REJECTED');
    expect(result.errorMessage).toBe('User rejected the transaction signature request.');
  });

  it('classifies network and fetch failures correctly', () => {
    const error = new Error('Failed to fetch');
    const result = classifyError(error, 'metamask');
    expect(result.failureType).toBe('network_failure');
    expect(result.errorCode).toBe('NETWORK_ERROR');
  });

  it('classifies connection timeout correctly', () => {
    const error = {
      code: 'TIMEOUT',
      message: 'Request timed out after 30000ms',
    };
    const result = classifyError(error, 'unknown');
    expect(result.failureType).toBe('network_failure');
    expect(result.errorCode).toBe('TIMEOUT');
  });

  it('classifies contract reversion correctly and sanitizes addresses', () => {
    const error = {
      code: -32603,
      message: 'Internal JSON-RPC error: execution reverted: 0x1111111111111111111111111111111111111111 is not authorized',
    };
    const result = classifyError(error, 'metamask');
    expect(result.failureType).toBe('contract_rejection');
    expect(result.errorCode).toBe(-32603);
    expect(result.errorMessage).toBe('Internal JSON-RPC error: execution reverted: [ADDRESS/HASH] is not authorized');
  });

  it('classifies insufficient funds correctly', () => {
    const error = {
      code: -32000,
      message: 'insufficient funds for gas * price + value',
    };
    const result = classifyError(error, 'metamask');
    expect(result.failureType).toBe('contract_rejection');
    expect(result.errorCode).toBe(-32000);
  });
});
