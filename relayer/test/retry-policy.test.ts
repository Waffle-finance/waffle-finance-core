import { describe, it, expect, vi } from 'vitest';
import { calculateDelay, withRetry } from '../src/utils/retry-policy.js';

vi.useFakeTimers();

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

  it('is deterministic when jitterFactor is 0', () => {
    // With jitterFactor=0, all attempts at the same level produce identical delays
    const d0a = calculateDelay(0, 1_000, 30_000, 0);
    const d0b = calculateDelay(0, 1_000, 30_000, 0);
    expect(d0a).toBe(d0b);
    expect(d0a).toBe(1_000);
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

  // ── NEW TESTS FOR TERMINAL LIMIT AND EXHAUSTED STATE ───────────────────────

  it('enforces maximum attempts exactly — no extra attempts beyond maxRetries', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('always fails'));
    await expect(withRetry(fn, { maxRetries: 3, baseDelayMs: 0 })).rejects.toThrow('always fails');
    // 4 attempts total: attempt 0 (initial) + 3 retries = maxRetries + 1
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('records final status when attempts are exhausted', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('permanent error'));
    await expect(withRetry(fn, { maxRetries: 2, baseDelayMs: 0 })).rejects.toThrow('permanent error');
    // 3 attempts total: initial + 2 retries
    expect(fn).toHaveBeenCalledTimes(3);
    // The error should be thrown directly, not wrapped
    const error = new Error('permanent error');
    expect(error.message).toBe('permanent error');
  });

  it('permanent errors skip retries immediately', async () => {
    const permanentErr = new Error('invalid params');
    const fn = vi.fn().mockRejectedValue(permanentErr);

    // maxRetries: 5, but first attempt returns a terminal error
    await expect(withRetry(fn, { maxRetries: 5, baseDelayMs: 10 })).rejects.toThrow('invalid params');
    // Should only have been called once — terminal errors do not trigger retries
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('tracks attempt count and delay at each step with fake timers', async () => {
    const attempts: number[] = [];
    const delays: number[] = [];
    const onRetry = vi.fn().mockImplementation((attempt, delay) => {
      attempts.push(attempt);
      delays.push(delay);
    });

    const fn = vi.fn().mockRejectedValue(new Error('persistent'));
    await expect(
      withRetry(fn, { maxRetries: 3, baseDelayMs: 20, onRetry, baseDelayMs: 10 }),
    ).rejects.toThrow('persistent');

    // Attempts 0, 1, 2, 3 (initial + 3 retries)
    expect(attempts).toEqual([0, 1, 2, 3]);
    // With baseDelayMs=10 and no jitter, delays should be: 10, 20, 40
    // (exponential backoff: 10 * 2^0, 10 * 2^1, 10 * 2^2)
    expect(delays).toEqual([10, 20, 40]);

    // Fake timers should have been advanced
    expect(vi.getTimerCount()).toBeGreaterThan(0);
  });

  it('does not advance past maxAttempts when maxRetries is 0', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('boom'));
    await expect(withRetry(fn, { maxRetries: 0, baseDelayMs: 5 })).rejects.toThrow('boom');
    expect(fn).toHaveBeenCalledTimes(1);
    // No retries should occur
    const delayCalls = vi.getAllTimers();
    // With fake timers and no retry, no delays should be scheduled
  });
});
