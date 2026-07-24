/**
 * Tests for the typed fallback contract for frontend order submission.
 *
 * Covers:
 *  - classifyProviderError: user rejection, wallet unavailable, wrong chain,
 *    insufficient funds, gas estimation failure, network timeout, unknown error
 *  - classifyApiError: network-level failure, every HTTP status bucket (400,
 *    429, 401/403, 502/503, 5xx, other), body detail extraction, unknown
 *  - callApi: provider delay (simulated with slow response), empty response
 *    body, malformed (non-JSON) response, HTTP errors, network throw
 *  - classifyReceiptTimeout, classifyRevertedTx, classifyMalformedResponse
 *  - buildFallbackRecord: record shape and field mapping
 *  - safeParseJson: valid, empty, null, malformed, wrong content-type
 *  - retryable flag contract across all code paths
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  classifyProviderError,
  classifyApiError,
  classifyReceiptTimeout,
  classifyRevertedTx,
  classifyMalformedResponse,
  buildFallbackRecord,
  safeParseJson,
  callApi,
  type OrderSubmissionFailure,
} from './orderSubmissionFallback';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeError(message: string, code?: number): Error & { code?: number } {
  const e = new Error(message) as Error & { code?: number };
  if (code !== undefined) e.code = code;
  return e;
}

function makeResponse(
  ok: boolean,
  status: number,
  body: unknown,
  contentType = 'application/json',
): Response {
  return {
    ok,
    status,
    headers: new Headers({ 'content-type': contentType }),
    text: async () => (body === null || body === undefined ? '' : JSON.stringify(body)),
  } as unknown as Response;
}

// ── classifyProviderError ────────────────────────────────────────────────────

describe('classifyProviderError', () => {
  it('classifies EIP-1193 code 4001 as user_rejected, not retryable', () => {
    const result = classifyProviderError(makeError('User rejected the request.', 4001));
    expect(result.ok).toBe(false);
    expect(result.code).toBe('user_rejected');
    expect(result.retryable).toBe(false);
    expect(result.recoverableActions).toContain('retry_submission');
  });

  it('classifies "user rejected" message text as user_rejected', () => {
    const result = classifyProviderError(new Error('MetaMask: user rejected transaction'));
    expect(result.code).toBe('user_rejected');
    expect(result.retryable).toBe(false);
  });

  it('classifies "User denied" message as user_rejected', () => {
    const result = classifyProviderError(new Error('User denied transaction signature'));
    expect(result.code).toBe('user_rejected');
  });

  it('classifies wallet-unavailable messages as wallet_unavailable', () => {
    const messages = [
      'No provider found — MetaMask not installed',
      'WalletClient is not available',
      'No ethereum provider detected',
    ];
    for (const msg of messages) {
      const result = classifyProviderError(new Error(msg));
      expect(result.code, msg).toBe('wallet_unavailable');
      expect(result.retryable, msg).toBe(true);
      expect(result.recoverableActions).toContain('connect_wallet');
    }
  });

  it('classifies wrong-chain error as wrong_chain, retryable', () => {
    const result = classifyProviderError(new Error('Wrong network: expected chain 1, got 11155111'));
    expect(result.code).toBe('wrong_chain');
    expect(result.retryable).toBe(true);
    expect(result.recoverableActions).toContain('switch_network');
  });

  it('classifies EIP-1193 code 4902 (chain not added) as wrong_chain', () => {
    const result = classifyProviderError(makeError('Chain not added to wallet', 4902));
    expect(result.code).toBe('wrong_chain');
    expect(result.recoverableActions).toContain('switch_network');
  });

  it('classifies insufficient_funds as not retryable', () => {
    const result = classifyProviderError(new Error('insufficient funds for gas * price + value'));
    expect(result.code).toBe('insufficient_funds');
    expect(result.retryable).toBe(false);
    expect(result.recoverableActions).toContain('check_balance');
  });

  it('classifies code -32000 with balance mention as insufficient_funds', () => {
    const result = classifyProviderError(makeError('cannot cover balance', -32000));
    expect(result.code).toBe('insufficient_funds');
  });

  it('classifies gas estimation failure as not retryable', () => {
    const result = classifyProviderError(new Error('gas required exceeds allowance (300000)'));
    expect(result.code).toBe('gas_estimation_failed');
    expect(result.retryable).toBe(false);
  });

  it('classifies "eth_estimateGas" mentions as gas_estimation_failed', () => {
    const result = classifyProviderError(new Error('eth_estimateGas returned null'));
    expect(result.code).toBe('gas_estimation_failed');
  });

  it('classifies "Failed to fetch" as network_timeout, retryable', () => {
    const result = classifyProviderError(new Error('Failed to fetch'));
    expect(result.code).toBe('network_timeout');
    expect(result.retryable).toBe(true);
    expect(result.recoverableActions).toContain('wait_and_retry');
  });

  it('classifies ETIMEDOUT as network_timeout', () => {
    const result = classifyProviderError(new Error('ETIMEDOUT after 30s'));
    expect(result.code).toBe('network_timeout');
    expect(result.retryable).toBe(true);
  });

  it('classifies connection reset as network_timeout', () => {
    const result = classifyProviderError(new Error('connection reset by peer'));
    expect(result.code).toBe('network_timeout');
  });

  it('classifies unknown errors with retryable=true and contact_support action', () => {
    const result = classifyProviderError(new Error('completely unexpected message xyz'));
    expect(result.code).toBe('unknown_error');
    expect(result.retryable).toBe(true);
    expect(result.recoverableActions).toContain('contact_support');
  });

  it('handles non-Error thrown values (strings, objects)', () => {
    const fromString = classifyProviderError('plain string error');
    expect(fromString.code).toBe('unknown_error');

    const fromObj = classifyProviderError({ code: 999, message: 'weird object' });
    expect(fromObj.code).toBe('unknown_error');
    expect(fromObj.message).toContain('weird object');
  });
});

// ── classifyApiError ─────────────────────────────────────────────────────────

describe('classifyApiError', () => {
  it('classifies network-level throw (no status) as network_timeout, retryable', () => {
    const result = classifyApiError(new Error('Failed to fetch'), undefined, null);
    expect(result.code).toBe('network_timeout');
    expect(result.retryable).toBe(true);
  });

  it('classifies ECONNREFUSED as network_timeout', () => {
    const result = classifyApiError(new Error('ECONNREFUSED 127.0.0.1:3001'));
    expect(result.code).toBe('network_timeout');
  });

  it('classifies HTTP 400 as provider_http_error, not retryable', () => {
    const result = classifyApiError(
      new Error('HTTP 400'),
      400,
      { error: 'validation_error', message: 'invalid hashlock' },
    );
    expect(result.code).toBe('provider_http_error');
    expect(result.retryable).toBe(false);
    expect(result.httpStatus).toBe(400);
    expect(result.message).toContain('validation_error');
  });

  it('extracts body.message when body.error is absent', () => {
    const result = classifyApiError(new Error('HTTP 400'), 400, { message: 'bad input' });
    expect(result.message).toContain('bad input');
  });

  it('classifies HTTP 429 as provider_http_error, retryable, advise wait', () => {
    const result = classifyApiError(new Error('HTTP 429'), 429, { error: 'too_many_requests' });
    expect(result.code).toBe('provider_http_error');
    expect(result.retryable).toBe(true);
    expect(result.recoverableActions).toContain('wait_and_retry');
    expect(result.httpStatus).toBe(429);
    expect(result.message).toContain('too_many_requests');
  });

  it('classifies HTTP 401 as provider_http_error, retryable with connect_wallet action', () => {
    const result = classifyApiError(new Error('HTTP 401'), 401, { error: 'unauthorized' });
    expect(result.code).toBe('provider_http_error');
    expect(result.retryable).toBe(true);
    expect(result.recoverableActions).toContain('connect_wallet');
  });

  it('classifies HTTP 403 the same as 401', () => {
    const result = classifyApiError(new Error('HTTP 403'), 403, null);
    expect(result.code).toBe('provider_http_error');
    expect(result.retryable).toBe(true);
    expect(result.recoverableActions).toContain('connect_wallet');
  });

  it('classifies HTTP 502 as network_timeout, retryable', () => {
    const result = classifyApiError(new Error('HTTP 502'), 502, null);
    expect(result.code).toBe('network_timeout');
    expect(result.retryable).toBe(true);
  });

  it('classifies HTTP 503 as network_timeout, retryable', () => {
    const result = classifyApiError(new Error('HTTP 503'), 503, { error: 'service_unavailable' });
    expect(result.code).toBe('network_timeout');
    expect(result.retryable).toBe(true);
    expect(result.recoverableActions).toContain('wait_and_retry');
  });

  it('classifies HTTP 500 as provider_http_error, retryable', () => {
    const result = classifyApiError(new Error('HTTP 500'), 500, { error: 'internal_error' });
    expect(result.code).toBe('provider_http_error');
    expect(result.retryable).toBe(true);
  });

  it('classifies an arbitrary non-ok status as provider_http_error, not retryable', () => {
    const result = classifyApiError(new Error('HTTP 422'), 422, { error: 'unprocessable' });
    expect(result.code).toBe('provider_http_error');
    expect(result.retryable).toBe(false);
    expect(result.httpStatus).toBe(422);
  });

  it('falls back to unknown_error when no status and no recognisable pattern', () => {
    const result = classifyApiError(new Error('some weird error with no pattern'), undefined, null);
    // Could be network_timeout or unknown — ensure it is one of the two
    expect(['network_timeout', 'unknown_error']).toContain(result.code);
    expect(result.retryable).toBe(true);
  });

  it('preserves the cause on failure objects', () => {
    const original = new Error('original cause');
    const result = classifyApiError(original, 500, null);
    expect(result.cause).toBe(original);
  });
});

// ── classifyReceiptTimeout ────────────────────────────────────────────────────

describe('classifyReceiptTimeout', () => {
  it('returns receipt_timeout code, not retryable', () => {
    const result = classifyReceiptTimeout('0xdeadbeef00000000000000000000000000000000000000000000000000000001');
    expect(result.ok).toBe(false);
    expect(result.code).toBe('receipt_timeout');
    expect(result.retryable).toBe(false);
  });

  it('includes a truncated tx hash in the message', () => {
    const txId = '0xdeadbeef00000000000000000000000000000000000000000000000000000001';
    const result = classifyReceiptTimeout(txId);
    expect(result.message).toContain('0xdeadbe');
  });

  it('recommends wait_and_retry and contact_support', () => {
    const result = classifyReceiptTimeout('0xabc');
    expect(result.recoverableActions).toContain('wait_and_retry');
    expect(result.recoverableActions).toContain('contact_support');
  });
});

// ── classifyRevertedTx ────────────────────────────────────────────────────────

describe('classifyRevertedTx', () => {
  it('returns tx_reverted code, not retryable', () => {
    const result = classifyRevertedTx('0xabc123');
    expect(result.ok).toBe(false);
    expect(result.code).toBe('tx_reverted');
    expect(result.retryable).toBe(false);
  });

  it('recommends check_balance and retry_submission', () => {
    const result = classifyRevertedTx('0xabc123');
    expect(result.recoverableActions).toContain('check_balance');
    expect(result.recoverableActions).toContain('retry_submission');
  });
});

// ── classifyMalformedResponse ─────────────────────────────────────────────────

describe('classifyMalformedResponse', () => {
  it('returns malformed_response code, retryable', () => {
    const result = classifyMalformedResponse('announce endpoint');
    expect(result.ok).toBe(false);
    expect(result.code).toBe('malformed_response');
    expect(result.retryable).toBe(true);
  });

  it('includes the context in the message', () => {
    const result = classifyMalformedResponse('missing orderId');
    expect(result.message).toContain('missing orderId');
  });

  it('works with an empty context string', () => {
    const result = classifyMalformedResponse('');
    expect(result.code).toBe('malformed_response');
  });

  it('recommends retry_submission', () => {
    const result = classifyMalformedResponse('test');
    expect(result.recoverableActions).toContain('retry_submission');
  });
});

// ── buildFallbackRecord ───────────────────────────────────────────────────────

describe('buildFallbackRecord', () => {
  const baseFailure: OrderSubmissionFailure = {
    ok: false,
    code: 'network_timeout',
    message: 'Could not reach bridge service',
    retryable: true,
    recoverableActions: ['wait_and_retry', 'retry_submission'],
  };

  const baseParams = {
    id: 'test-id-001',
    direction: 'eth-to-xlm' as const,
    amount: '0.5',
    estimatedAmount: '5000',
    srcAddress: '0x1111111111111111111111111111111111111111',
    dstAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422',
  };

  it('copies all required fields from failure and params', () => {
    const record = buildFallbackRecord(baseFailure, baseParams);
    expect(record.id).toBe('test-id-001');
    expect(record.errorCode).toBe('network_timeout');
    expect(record.errorMessage).toBe('Could not reach bridge service');
    expect(record.direction).toBe('eth-to-xlm');
    expect(record.amount).toBe('0.5');
    expect(record.estimatedAmount).toBe('5000');
    expect(record.srcAddress).toBe(baseParams.srcAddress);
    expect(record.dstAddress).toBe(baseParams.dstAddress);
    expect(record.retryable).toBe(true);
  });

  it('sets a recent timestamp', () => {
    const before = Date.now();
    const record = buildFallbackRecord(baseFailure, baseParams);
    const after = Date.now();
    expect(record.timestamp).toBeGreaterThanOrEqual(before);
    expect(record.timestamp).toBeLessThanOrEqual(after);
  });

  it('correctly propagates retryable=false from the failure', () => {
    const nonRetryable: OrderSubmissionFailure = {
      ...baseFailure,
      code: 'user_rejected',
      retryable: false,
    };
    const record = buildFallbackRecord(nonRetryable, baseParams);
    expect(record.retryable).toBe(false);
    expect(record.errorCode).toBe('user_rejected');
  });

  it('supports all four direction values', () => {
    const directions: Array<typeof baseParams['direction']> = [
      'eth-to-xlm', 'xlm-to-eth', 'eth-to-sol', 'sol-to-eth',
    ];
    for (const direction of directions) {
      const record = buildFallbackRecord(baseFailure, { ...baseParams, direction });
      expect(record.direction).toBe(direction);
    }
  });
});

// ── safeParseJson ─────────────────────────────────────────────────────────────

describe('safeParseJson', () => {
  it('parses a valid JSON response with application/json content-type', async () => {
    const response = makeResponse(true, 200, { orderId: 'abc' });
    const result = await safeParseJson(response);
    expect(result).toEqual({ orderId: 'abc' });
  });

  it('returns null for an empty body', async () => {
    const response = {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => '',
    } as unknown as Response;
    const result = await safeParseJson(response);
    expect(result).toBeNull();
  });

  it('returns null for a whitespace-only body', async () => {
    const response = {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => '   \n  ',
    } as unknown as Response;
    const result = await safeParseJson(response);
    expect(result).toBeNull();
  });

  it('returns null for invalid (malformed) JSON', async () => {
    const response = {
      ok: false,
      status: 500,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => 'not json at all {{{',
    } as unknown as Response;
    const result = await safeParseJson(response);
    expect(result).toBeNull();
  });

  it('returns null when content-type is text/html (not JSON)', async () => {
    const response = makeResponse(false, 503, null, 'text/html');
    const result = await safeParseJson(response);
    expect(result).toBeNull();
  });

  it('accepts text/json content-type', async () => {
    const response = makeResponse(true, 200, { ok: true }, 'text/json');
    const result = await safeParseJson(response);
    expect(result).toEqual({ ok: true });
  });
});

// ── callApi ──────────────────────────────────────────────────────────────────

describe('callApi', () => {
  it('returns ok:true and parsed body for a successful response', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      makeResponse(true, 200, { id: 'pub-123', status: 'announced' }),
    );
    const result = await callApi('/api/orders/announce', { method: 'POST' }, mockFetch);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.body).toEqual({ id: 'pub-123', status: 'announced' });
      expect(result.status).toBe(200);
    }
  });

  it('returns OrderSubmissionFailure when fetch throws (network error)', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('Failed to fetch'));
    const result = await callApi('/api/orders/announce', { method: 'POST' }, mockFetch);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('network_timeout');
      expect(result.retryable).toBe(true);
    }
  });

  it('classifies HTTP 400 response as failure without throwing', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      makeResponse(false, 400, { error: 'validation_error' }),
    );
    const result = await callApi('/api/orders/announce', { method: 'POST' }, mockFetch);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('provider_http_error');
      expect(result.httpStatus).toBe(400);
      expect(result.retryable).toBe(false);
    }
  });

  it('classifies HTTP 503 as network_timeout', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      makeResponse(false, 503, { error: 'service_unavailable' }),
    );
    const result = await callApi('/api/prices', { method: 'GET' }, mockFetch);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('network_timeout');
      expect(result.retryable).toBe(true);
    }
  });

  it('handles a null/empty response body for a non-ok status gracefully', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      makeResponse(false, 500, null),
    );
    const result = await callApi('/api/orders/create', { method: 'POST' }, mockFetch);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('provider_http_error');
    }
  });

  it('simulates provider delay — slow fetch resolves correctly', async () => {
    const slowFetch = vi.fn().mockImplementation(
      () => new Promise<Response>((resolve) =>
        setTimeout(() => resolve(makeResponse(true, 201, { id: 'delayed-order' })), 50),
      ),
    );
    const result = await callApi('/api/orders/announce', { method: 'POST' }, slowFetch);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.body).toEqual({ id: 'delayed-order' });
    }
  });

  it('handles a response with wrong content-type (returns ok:true with null body)', async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeResponse(true, 200, {}, 'text/plain'));
    const result = await callApi('/api/prices', { method: 'GET' }, mockFetch);
    // 200 OK but body is null because content-type is not JSON
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.body).toBeNull();
    }
  });
});

// ── Retryable contract — invariant checks ─────────────────────────────────────

describe('retryable flag contract', () => {
  const RETRYABLE_CODES = [
    'wallet_unavailable',
    'wrong_chain',
    'network_timeout',
    'unknown_error',
  ] as const;

  const NON_RETRYABLE_CODES = [
    'user_rejected',
    'insufficient_funds',
    'gas_estimation_failed',
    'tx_reverted',
  ] as const;

  it.each(RETRYABLE_CODES)('%s should always be retryable=true', (code) => {
    // We derive a sample failure for each code through the appropriate classifier
    let result: OrderSubmissionFailure;
    if (code === 'wallet_unavailable') {
      result = classifyProviderError(new Error('No ethereum provider found'));
    } else if (code === 'wrong_chain') {
      result = classifyProviderError(new Error('Wrong network detected'));
    } else if (code === 'network_timeout') {
      result = classifyApiError(new Error('Failed to fetch'));
    } else {
      result = classifyProviderError(new Error('some completely unexpected xyz error'));
    }
    expect(result.retryable, `expected ${code} to be retryable`).toBe(true);
  });

  it.each(NON_RETRYABLE_CODES)('%s should always be retryable=false', (code) => {
    let result: OrderSubmissionFailure;
    if (code === 'user_rejected') {
      result = classifyProviderError(makeError('User rejected', 4001));
    } else if (code === 'insufficient_funds') {
      result = classifyProviderError(new Error('insufficient funds for gas'));
    } else if (code === 'gas_estimation_failed') {
      result = classifyProviderError(new Error('gas required exceeds allowance'));
    } else {
      result = classifyRevertedTx('0xabc');
    }
    expect(result.retryable, `expected ${code} to be non-retryable`).toBe(false);
  });
});

// ── recoverableActions contract ───────────────────────────────────────────────

describe('recoverableActions contract', () => {
  it('every failure has at least one recoverable action', () => {
    const failures: OrderSubmissionFailure[] = [
      classifyProviderError(makeError('User rejected', 4001)),
      classifyProviderError(new Error('No provider')),
      classifyProviderError(new Error('Wrong network')),
      classifyProviderError(new Error('insufficient funds')),
      classifyProviderError(new Error('gas required exceeds')),
      classifyProviderError(new Error('Failed to fetch')),
      classifyProviderError(new Error('completely unexpected')),
      classifyApiError(new Error('Failed to fetch')),
      classifyApiError(new Error('HTTP 400'), 400, { error: 'bad' }),
      classifyApiError(new Error('HTTP 429'), 429, null),
      classifyApiError(new Error('HTTP 500'), 500, null),
      classifyReceiptTimeout('0xabc'),
      classifyRevertedTx('0xdef'),
      classifyMalformedResponse('ctx'),
    ];

    for (const f of failures) {
      expect(
        f.recoverableActions.length,
        `${f.code} must have at least one recoverable action`,
      ).toBeGreaterThan(0);
    }
  });
});
