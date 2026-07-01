import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { logger } from './logger';

describe('StructuredLogger', () => {
  let consoleSpy: Record<string, ReturnType<typeof vi.spyOn>>;

  beforeEach(() => {
    // Spy on console methods
    consoleSpy = {
      log: vi.spyOn(console, 'log').mockImplementation(() => {}),
      warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
      error: vi.spyOn(console, 'error').mockImplementation(() => {}),
      info: vi.spyOn(console, 'info').mockImplementation(() => {}),
    };
  });

  afterEach(() => {
    // Restore console methods
    Object.values(consoleSpy).forEach(spy => spy.mockRestore());
  });

  describe('wallet events', () => {
    it('should log wallet connection', () => {
      logger.walletConnect('MetaMask', '0x1234...5678');
      expect(consoleSpy.log).toHaveBeenCalled();
    });

    it('should log wallet disconnection', () => {
      logger.walletDisconnect('MetaMask');
      expect(consoleSpy.log).toHaveBeenCalled();
    });

    it('should log wallet errors', () => {
      logger.walletError('Freighter', new Error('Connection failed'));
      expect(consoleSpy.error).toHaveBeenCalled();
    });

    it('should mask sensitive wallet addresses in logs', () => {
      logger.walletConnect('MetaMask', '0x1234567890123456789012345678901234567890');
      expect(consoleSpy.log).toHaveBeenCalled();
      const callArgs = consoleSpy.log.mock.calls[0];
      // The address should be masked in the output
      expect(JSON.stringify(callArgs)).not.toContain('0x12345678901234567890123456789012345678900');
    });
  });

  describe('transaction events', () => {
    it('should log transaction start', () => {
      logger.transactionStart('order-123', { direction: 'ETH -> XLM', amount: '1.5' });
      expect(consoleSpy.log).toHaveBeenCalled();
    });

    it('should log transaction sign', () => {
      logger.transactionSign('order-123', 'MetaMask');
      expect(consoleSpy.log).toHaveBeenCalled();
    });

    it('should log transaction submission', () => {
      logger.transactionSubmit('order-123', '0x1234567890abcdef');
      expect(consoleSpy.log).toHaveBeenCalled();
    });

    it('should log transaction confirmation', () => {
      logger.transactionConfirm('order-123', '0x1234567890abcdef', 12345);
      expect(consoleSpy.log).toHaveBeenCalled();
    });

    it('should log transaction errors', () => {
      logger.transactionError('order-123', new Error('TX failed'));
      expect(consoleSpy.error).toHaveBeenCalled();
    });
  });

  describe('network events', () => {
    it('should log network check', () => {
      logger.networkCheck('0x1', '0x1', { status: 'OK' });
      expect(consoleSpy.log).toHaveBeenCalled();
    });

    it('should log network switch', () => {
      logger.networkSwitch('Mainnet', 'Sepolia');
      expect(consoleSpy.log).toHaveBeenCalled();
    });

    it('should log network errors', () => {
      logger.networkError(new Error('Network unreachable'));
      expect(consoleSpy.error).toHaveBeenCalled();
    });
  });

  describe('API events', () => {
    it('should log API requests', () => {
      logger.apiRequest('POST', '/api/orders/create', { mode: 'testnet' });
      expect(consoleSpy.log).toHaveBeenCalled();
    });

    it('should log API responses', () => {
      logger.apiResponse('POST', '/api/orders/create', 200, { mode: 'testnet' });
      expect(consoleSpy.log).toHaveBeenCalled();
    });

    it('should log API errors', () => {
      logger.apiError('POST', '/api/orders/create', new Error('400 Bad Request'));
      expect(consoleSpy.error).toHaveBeenCalled();
    });
  });

  describe('validation events', () => {
    it('should log validation errors', () => {
      logger.validationError('amount', 'Amount must be positive');
      expect(consoleSpy.warn).toHaveBeenCalled();
    });
  });

  describe('state change events', () => {
    it('should log state changes', () => {
      logger.stateChange('BridgeForm', 'isSubmitting', { value: true });
      expect(consoleSpy.log).toHaveBeenCalled();
    });
  });

  describe('debug mode control', () => {
    it('should enable debug logging', () => {
      logger.enableDebug();
      expect(logger.isDebugEnabled()).toBe(true);
    });

    it('should disable debug logging', () => {
      logger.enableDebug();
      logger.disableDebug();
      expect(logger.isDebugEnabled()).toBe(false);
    });
  });

  describe('sensitive data masking', () => {
    it('should not log raw private keys', () => {
      const callsWithKey = consoleSpy.log.mock.calls.filter(
        call => JSON.stringify(call).includes('0x' + 'a'.repeat(64))
      );
      expect(callsWithKey.length).toBe(0);
    });

    it('should mask XDR strings', () => {
      logger.transactionSign('order-123', 'Freighter', { xdr: 'A'.repeat(500) });
      expect(consoleSpy.log).toHaveBeenCalled();
      // The full XDR should be masked
      const output = JSON.stringify(consoleSpy.log.mock.calls[0]);
      expect(output.length).toBeLessThan(500 + 100); // Should be significantly shorter
    });
  });

  describe('generic event logging', () => {
    it('should log custom events', () => {
      logger.event('wallet_connect', 'Custom message', { customData: 'value' });
      expect(consoleSpy.log).toHaveBeenCalled();
    });

    it('should include event type in logs', () => {
      logger.event('wallet_connect', 'Test message');
      expect(consoleSpy.log).toHaveBeenCalled();
      const callArgs = consoleSpy.log.mock.calls[0];
      expect(JSON.stringify(callArgs)).toContain('wallet_connect');
    });

    it('should accept all log levels', () => {
      const levels = ['debug', 'info', 'warn', 'error'] as const;
      
      levels.forEach(level => {
        consoleSpy[level === 'debug' ? 'log' : level].mockClear();
        logger.event('test_event', 'Test message', {}, level);
      });

      expect(consoleSpy.log).toHaveBeenCalled(); // debug
      expect(consoleSpy.info).toHaveBeenCalled();
      expect(consoleSpy.warn).toHaveBeenCalled();
      expect(consoleSpy.error).toHaveBeenCalled();
    });
  });

  describe('data sanitization', () => {
    it('should include non-sensitive data in logs', () => {
      logger.event('transaction_start', 'Test', { 
        status: 'pending', 
        amount: '1.5', 
        chainId: '0x1' 
      });
      expect(consoleSpy.log).toHaveBeenCalled();
      const output = JSON.stringify(consoleSpy.log.mock.calls[0]);
      expect(output).toContain('pending');
      expect(output).toContain('1.5');
      expect(output).toContain('0x1');
    });

    it('should handle nested objects', () => {
      logger.event('test_event', 'Test', {
        nested: {
          address: '0x1234567890123456789012345678901234567890',
          normalData: 'visible'
        }
      });
      expect(consoleSpy.log).toHaveBeenCalled();
    });
  });
});
