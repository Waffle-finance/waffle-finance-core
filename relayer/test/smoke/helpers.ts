/**
 * @fileoverview Shared helpers for smoke tests.
 * 
 * This file contains utilities used across all smoke test scenarios.
 */

import { vi } from 'vitest';

// ── Error constructors ───────────────────────────────────────────────────────

/**
 * Creates a network timeout error.
 */
export function createTimeoutError(): Error {
  const err = new Error('ETIMEDOUT: connection timeout');
  (err as any).code = 'ETIMEDOUT';
  return err;
}

/**
 * Creates a rate limit error.
 */
export function createRateLimitError(): Error {
  const err = new Error('429 Too Many Requests: rate limit exceeded');
  (err as any).status = 429;
  return err;
}

/**
 * Creates a connection refused error.
 */
export function createConnectionRefusedError(): Error {
  const err = new Error('ECONNREFUSED: connection refused');
  (err as any).code = 'ECONNREFUSED';
  return err;
}

/**
 * Creates a transaction reverted error (terminal).
 */
export function createTransactionRevertedError(): Error {
  return new Error('execution reverted: insufficient funds');
}

/**
 * Creates an RPC timeout error.
 */
export function createRpcTimeoutError(): Error {
  return new Error('RPC getBalance timeout');
}

// ── Mock providers ──────────────────────────────────────────────────────────

/**
 * Creates a mock Ethereum provider for testing.
 */
export function createMockProvider(overrides: {
  getTransactionReceipt?: any;
  getBlockNumber?: any;
} = {}) {
  return {
    getTransactionReceipt: vi.fn().mockResolvedValue(
      overrides.getTransactionReceipt ?? {
        hash: '0xabc123',
        blockNumber: 100,
        blockHash: '0xblock',
        status: 1,
        gasUsed: 21000n,
        confirmations: 12,
      }
    ),
    getBlockNumber: vi.fn().mockResolvedValue(
      overrides.getBlockNumber ?? 200
    ),
  };
}

// ── Order generation ────────────────────────────────────────────────────────

/**
 * Generates a random hex string.
 */
export function randomHex(length: number = 64): string {
  let hex = '0x';
  for (let i = 0; i < length / 2; i++) {
    hex += Math.floor(Math.random() * 16).toString(16).padStart(2, '0');
  }
  return hex as string;
}

/**
 * Generates a random order ID.
 */
export function generateOrderId(prefix: string = 'order'): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
}

/**
 * Generates a correlation ID.
 */
export function generateCorrelationId(prefix: string = 'cid'): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
}

// ── Simulation helpers ──────────────────────────────────────────────────────

/**
 * Creates an action that fails with a specific error N times, then succeeds.
 */
export function createFailingAction(
  failureCount: number,
  error: Error = createTimeoutError(),
  successResult: string = '0xtx-success'
) {
  let attempts = 0;
  return async () => {
    attempts++;
    if (attempts <= failureCount) {
      throw error;
    }
    return successResult;
  };
}

/**
 * Creates an action that simulates varying latency.
 */
export function createLatencyAction(
  baseLatency: number = 10,
  maxLatency: number = 100,
  eventuallyFail: boolean = false,
  failAt: number = 5,
  failureError: Error = createTimeoutError()
) {
  let attempts = 0;
  return async () => {
    attempts++;
    
    // Simulate variable latency
    const latency = Math.random() * (maxLatency - baseLatency) + baseLatency;
    await new Promise(resolve => setTimeout(resolve, latency));
    
    if (eventuallyFail && attempts >= failAt) {
      throw failureError;
    }
    
    return `0xtx-latency-${attempts}`;
  };
}

/**
 * Creates an action that simulates rate limiting.
 */
export function createRateLimitAction(
  rateLimitEvery: number = 3,
  rateLimitError: Error = createRateLimitError(),
  successResult: string = '0xtx-ratelimit'
) {
  let attempts = 0;
  return async () => {
    attempts++;
    if (attempts > 1 && attempts % rateLimitEvery === 0) {
      throw rateLimitError;
    }
    return successResult;
  };
}

// ── State verification helpers ──────────────────────────────────────────────

/**
 * Verifies that an order is in an expected state.
 */
export function verifyOrderState(
  state: string,
  expectedStates: string | string[]
): void {
  const expected = Array.isArray(expectedStates) ? expectedStates : [expectedStates];
  expect(expected).toContain(state);
}

/**
 * Verifies that a transaction hash is valid.
 */
export function verifyTransactionHash(hash: string): void {
  expect(hash).toMatch(/^0x[a-fA-F0-9]{64}$/);
}

/**
 * Verifies that a receipt is valid.
 */
export function verifyReceipt(receipt: any): void {
  expect(receipt).toBeDefined();
  expect(receipt.hash).toBeDefined();
  expect(receipt.blockNumber).toBeDefined();
  expect(receipt.status).toBeDefined();
}

// ── Performance helpers ─────────────────────────────────────────────────────

/**
 * Measures the duration of an async operation.
 */
export async function measureDuration<T>(
  name: string,
  fn: () => Promise<T>
): Promise<{ result: T; durationMs: number }> {
  const start = Date.now();
  const result = await fn();
  const durationMs = Date.now() - start;
  return { result, durationMs };
}

/**
 * Creates a large batch of orders for testing.
 */
export function createOrderBatch(
  count: number,
  prefix: string = 'order',
  directions: string[] = ['xlm_to_eth', 'eth_to_xlm']
): Array<{ orderId: string; direction: string }> {
  return Array.from({ length: count }, (_, i) => ({
    orderId: `${prefix}-${i.toString().padStart(6, '0')}`,
    direction: directions[i % directions.length],
  }));
}

// ── Circuit breaker helpers ─────────────────────────────────────────────────

/**
 * Trips a circuit breaker by making it fail N times.
 */
export async function tripCircuit(
  settleFn: (orderId: string) => Promise<void>,
  orderIdPrefix: string,
  failures: number
): Promise<void> {
  for (let i = 0; i < failures; i++) {
    try {
      await settleFn(`${orderIdPrefix}-${i}`);
    } catch {
      // Expected failure
    }
  }
}

/**
 * Waits for a circuit breaker cooldown period.
 */
export async function waitCircuitCooldown(cooldownMs: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, cooldownMs));
}
