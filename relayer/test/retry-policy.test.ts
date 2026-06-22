import { describe, it, expect, vi } from 'vitest';
import { calculateDelay, withRetry } from '../src/utils/retry-policy.js';

describe('calculateDelay', () => {
  it('returns baseMs * 2^attempt (exponential growth) when within max', () => {
    // attempt=0 → 1_000 +- jitter
    // attempt=1 → 2_000 +- jitter
    // attempt=2 → 4_000 +- jitter
    // attempt=3 → 8_000 +- jitter
    const d0 = calculateDelay(0, 1_000, 30_000, 0);
    expect(d0).toBe(1_000);

    const d1 = calculateDelay(1, 1_000, 30_000, 0);
    expect(d1).toBe(2_000);

    const d2 = calculateDelay(2, 1_000, 30_000, 0);
    expect(d2).toBe(4_000);

    const d3 = calculateDelay(3, 1_000, 30_000, 0);
    expect(d3).toBe(8_000);
  });

  it('caps delay at maxMs', () => {
    const d = calculateDelay(10, 1_000, 5_000, 0); // 2^10 = 1024s, capped at 5s
    expect(d).toBe(5_000);
  });

  it('applies jitter within expected range', () => {
    const attempts = 100;
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < attempts; i++) {
      const d = calculateDelay(0, 1_000, 30_000, 0.2);
      if (d < min) min = d;
      if (d > max) max = d;
    }
    // jitter = +-20% of 1000 = +-200, so range should be 800-1200
    expect(min).toBeGreaterThanOrEqual(800);
    expect(max).toBeLessThanOrEqual(1_200);
  });
});

describe('withRetry', () => {
  it('resolves on the first attempt if fn succeeds', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    await expect(withRetry(fn, { maxRetries: 3 })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on failure and eventually succeeds', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('fail-1'))
      .mockRejectedValueOnce(new Error('fail-2'))
      .mockResolvedValue('recovered');

    await expect(withRetry(fn, { maxRetries: 3, baseDelayMs: 5 })).resolves.toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws after exhausting all retries', async () => {
    const err = new Error('always fails');
    const fn = vi.fn().mockRejectedValue(err);

    await expect(withRetry(fn, { maxRetries: 2, baseDelayMs: 5 })).rejects.toThrow('always fails');
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('calls onRetry between attempts', async () => {
    const onRetry = vi.fn();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValue('ok');

    await withRetry(fn, { maxRetries: 3, baseDelayMs: 5, onRetry });
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onRetry).toHaveBeenCalledWith(0, expect.any(Number), expect.any(Error));
  });

  it('uses zero retries (just one attempt)', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('boom'));
    await expect(withRetry(fn, { maxRetries: 0, baseDelayMs: 5 })).rejects.toThrow('boom');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('wraps non-Error throws in Error', async () => {
    const fn = vi.fn().mockRejectedValue('string error');
    await expect(withRetry(fn, { maxRetries: 0 })).rejects.toThrow('string error');
  });
});
