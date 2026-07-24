/**
 * Tests for relayer/src/utils/sanitize-for-log.ts
 *
 * Verifies that secret material (long hex strings matching the 0x + 16+
 * hex chars pattern) is redacted from every supported input shape, and
 * that non-sensitive values are left intact.
 */

import { describe, it, expect } from 'vitest';
import { sanitizeForLog } from '../src/utils/sanitize-for-log.js';

// ---------------------------------------------------------------------------
// Patterns we expect to be redacted
// ---------------------------------------------------------------------------

const PRIVATE_KEY = '0x' + 'ab'.repeat(32);   // 64 hex chars — ETH private key
const PREIMAGE    = '0x' + 'cd'.repeat(32);   // 64 hex chars — HTLC preimage
const HASHLOCK    = '0x' + 'ef'.repeat(32);   // 64 hex chars — hashlock
const SHORT_HEX   = '0x' + 'aa'.repeat(7);    // 14 hex chars — below threshold, NOT redacted
const ETH_ADDR    = '0x1111111111111111111111111111111111111111'; // 40 hex — redacted

// ---------------------------------------------------------------------------
// Primitive string inputs
// ---------------------------------------------------------------------------

describe('sanitizeForLog — strings', () => {
  it('redacts a bare private key string', () => {
    expect(sanitizeForLog(PRIVATE_KEY)).toBe('[REDACTED_SECRET]');
  });

  it('redacts a preimage embedded in a sentence', () => {
    const result = sanitizeForLog(`preimage is ${PREIMAGE} for order X`);
    expect(result).not.toContain('cd'.repeat(32));
    expect(result).toContain('[REDACTED_SECRET]');
  });

  it('redacts a hashlock embedded in a log message', () => {
    const result = sanitizeForLog(`hashlock=${HASHLOCK}`);
    expect(result).not.toContain('ef'.repeat(32));
    expect(result).toContain('[REDACTED_SECRET]');
  });

  it('does NOT redact short hex strings (below the 16-char threshold)', () => {
    const result = sanitizeForLog(SHORT_HEX);
    expect(result).toBe(SHORT_HEX);
  });

  it('passes through non-hex strings unchanged', () => {
    expect(sanitizeForLog('hello world')).toBe('hello world');
  });

  it('passes through numbers unchanged', () => {
    expect(sanitizeForLog(42 as any)).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// Object inputs
// ---------------------------------------------------------------------------

describe('sanitizeForLog — objects', () => {
  it('redacts sensitive values inside a flat object', () => {
    const input = { preimage: PREIMAGE, orderId: 'order_001', amount: '1000' };
    const result = sanitizeForLog(input) as typeof input;

    expect(result.preimage).toBe('[REDACTED_SECRET]');
    expect(result.orderId).toBe('order_001');
    expect(result.amount).toBe('1000');
  });

  it('redacts sensitive values inside a nested object', () => {
    const input = {
      outer: {
        secret: PRIVATE_KEY,
        safe: 'plain text',
      },
    };
    const result = sanitizeForLog(input) as typeof input;

    expect(result.outer.secret).toBe('[REDACTED_SECRET]');
    expect(result.outer.safe).toBe('plain text');
  });

  it('redacts sensitive values inside an array', () => {
    const input = [PREIMAGE, 'safe', HASHLOCK];
    const result = sanitizeForLog(input) as typeof input;

    expect(result[0]).toBe('[REDACTED_SECRET]');
    expect(result[1]).toBe('safe');
    expect(result[2]).toBe('[REDACTED_SECRET]');
  });

  it('returns [MAX_DEPTH_REACHED] when nesting exceeds depth 3', () => {
    const deep = { a: { b: { c: { d: PREIMAGE } } } };
    const result = sanitizeForLog(deep) as any;
    // At depth 3 the value is truncated
    expect(result.a.b.c).toBe('[MAX_DEPTH_REACHED]');
  });
});

// ---------------------------------------------------------------------------
// Error inputs
// ---------------------------------------------------------------------------

describe('sanitizeForLog — Error instances', () => {
  it('redacts a hex secret from an error message', () => {
    const err = new Error(`swap failed: preimage=${PREIMAGE}`);
    const sanitized = sanitizeForLog(err) as Error;

    expect(sanitized.message).not.toContain('cd'.repeat(32));
    expect(sanitized.message).toContain('[REDACTED_SECRET]');
  });

  it('redacts a hex secret from an error stack trace', () => {
    const err = new Error(`preimage=${PREIMAGE} leaked into stack`);
    const sanitized = sanitizeForLog(err) as Error;

    if (sanitized.stack) {
      expect(sanitized.stack).not.toContain('cd'.repeat(32));
    }
  });

  it('preserves the error name and is still an Error instance', () => {
    class CustomError extends Error {
      readonly code = 'custom';
    }
    const err = new CustomError(`leak ${PREIMAGE}`);
    err.name = 'CustomError';

    const sanitized = sanitizeForLog(err) as Error;
    expect(sanitized).toBeInstanceOf(Error);
    expect(sanitized.name).toBe('CustomError');
  });

  it('redacts a custom property that holds a hex secret', () => {
    const err = Object.assign(new Error('base message'), {
      privateKey: PRIVATE_KEY,
    }) as Error & { privateKey: string };

    const sanitized = sanitizeForLog(err) as typeof err;
    expect(sanitized.privateKey).toBe('[REDACTED_SECRET]');
  });

  it('preserves a safe custom property value', () => {
    const err = Object.assign(new Error('base'), { code: 'ERR_001' }) as Error & { code: string };
    const sanitized = sanitizeForLog(err) as typeof err;
    expect(sanitized.code).toBe('ERR_001');
  });
});

// ---------------------------------------------------------------------------
// Null / undefined passthrough
// ---------------------------------------------------------------------------

describe('sanitizeForLog — null and undefined', () => {
  it('passes null through unchanged', () => {
    expect(sanitizeForLog(null)).toBeNull();
  });

  it('passes undefined through unchanged', () => {
    expect(sanitizeForLog(undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Response body safety — verifies that redacted values do not appear in
// serialised JSON (simulating what an operator would see in a log sink).
// ---------------------------------------------------------------------------

describe('sanitizeForLog — JSON serialisation safety', () => {
  it('serialised output of a complex payload does not contain any long hex secrets', () => {
    const payload = {
      event: 'order.claimed',
      data: {
        hashlock: HASHLOCK,
        preimage: PREIMAGE,
        orderId: 'wf_abc123',
        txHash: '0x' + 'dd'.repeat(32),
        caller: ETH_ADDR,
      },
    };

    const sanitized = sanitizeForLog(payload);
    const serialised = JSON.stringify(sanitized);

    // None of the original secrets should appear in the output
    expect(serialised).not.toContain('ef'.repeat(32)); // hashlock
    expect(serialised).not.toContain('cd'.repeat(32)); // preimage
    expect(serialised).not.toContain('dd'.repeat(32)); // txHash (64 chars — redacted)

    // Safe values should still be present
    expect(serialised).toContain('order.claimed');
    expect(serialised).toContain('wf_abc123');
  });
});
