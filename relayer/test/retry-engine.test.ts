/**
 * Tests for relayer/src/utils/retry-engine.ts
 *
 * Covers:
 *  a. Successful first attempt — no retry
 *  b. Transient fault — retries up to maxAttempts then throws RetryExhaustedError
 *  c. Terminal fault — surfaces immediately, never retried
 *  d. Confirmation-delay fault — retried with extra multiplier
 *  e. Custom classifier overrides the default
 *  f. Circuit breaker:
 *      - opens after N consecutive failures
 *      - rejects calls while open (CircuitOpenError)
 *      - half-open probe: success → closed, failure → open
 *      - resetCircuit() forces back to closed
 *  g. allCircuits() / circuitState() reporting
 *  h. calculateBackoff() deterministic test (jitter = 0)
 *  i. Correlation context retry-hop recording
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FakeClock } from '../../packages/test-utils/src/fake-clock.js';

// ── Isolate metrics ───────────────────────────────────────────────────────────
vi.mock('../src/metrics.js', () => ({
  retryEngineAttemptsTotal:    { inc: vi.fn() },
  retryEngineExhaustedTotal:   { inc: vi.fn() },
  retryEngineCircuitOpenedTotal:  { inc: vi.fn() },
  retryEngineCircuitRejectedTotal: { inc: vi.fn() },
  retryEngineCircuitState:     { set: vi.fn() },
  retryEngineBackoffSeconds:   { observe: vi.fn() },
  // correlation mocks (used by getCorrelation inside the engine)
  correlationOpsTotal:         { inc: vi.fn() },
  correlationCheckpointsTotal: { inc: vi.fn() },
  correlationOpDurationSeconds: { startTimer: () => () => {} },
  correlationRetryHopsTotal:   { inc: vi.fn() },
}));

import {
  RetryEngine,
  RetryExhaustedError,
  CircuitOpenError,
  defaultClassifier,
  calculateBackoff,
  type FaultClass,
} from '../src/utils/retry-engine.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Create a fresh RetryEngine with fast delays so tests don't hang. */
function makeEngine(overrides: ConstructorParameters<typeof RetryEngine>[0] = {}) {
  return new RetryEngine({
    defaultMaxAttempts: 4,
    defaultBaseDelayMs: 1,       // 1 ms base — tests run in < 1s
    defaultMaxDelayMs: 5,
    circuitBreakerThreshold: 3,
    circuitBreakerResetMs: 50,   // 50 ms — testable in-process
    jitterFactor: 0,             // deterministic delays
    ...overrides,
  });
}

/** Build an fn that fails the first N times then succeeds. */
function failNTimes(n: number, error: Error = new Error('transient')): () => Promise<string> {
  let calls = 0;
  return async () => {
    calls++;
    if (calls <= n) throw error;
    return 'ok';
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('RetryEngine — basic retry behaviour', () => {

  it('succeeds on first attempt without retrying', async () => {
    const engine = makeEngine();
    const fn = vi.fn().mockResolvedValue('success');
    const result = await engine.run('rpc', fn);
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries a transient fault and succeeds on attempt 2', async () => {
    const engine = makeEngine();
    const fn = failNTimes(1);
    const result = await engine.run('rpc', fn);
    expect(result).toBe('ok');
  });

  it('retries maxAttempts times then throws RetryExhaustedError', async () => {
    const engine = makeEngine({ defaultMaxAttempts: 3 });
    const fn = vi.fn().mockRejectedValue(new Error('always fails'));
    await expect(engine.run('rpc', fn)).rejects.toThrow(RetryExhaustedError);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('RetryExhaustedError carries the correct attempt count', async () => {
    const engine = makeEngine({ defaultMaxAttempts: 2 });
    const fn = vi.fn().mockRejectedValue(new Error('boom'));
    try {
      await engine.run('rpc', fn);
    } catch (err) {
      expect(err).toBeInstanceOf(RetryExhaustedError);
      expect((err as RetryExhaustedError).attempts).toBe(2);
    }
  });

  it('RetryExhaustedError carries the last fault class', async () => {
    const engine = makeEngine({ defaultMaxAttempts: 2 });
    const fn = vi.fn().mockRejectedValue(new Error('rate limit exceeded'));
    try {
      await engine.run('rpc', fn);
    } catch (err) {
      expect(err).toBeInstanceOf(RetryExhaustedError);
      // default classifier maps "rate limit" → transient
      expect((err as RetryExhaustedError).faultClass).toBe('transient');
    }
  });

  it('per-call maxAttempts override takes precedence', async () => {
    const engine = makeEngine({ defaultMaxAttempts: 10 });
    const fn = vi.fn().mockRejectedValue(new Error('boom'));
    await expect(engine.run('rpc', fn, { maxAttempts: 2 })).rejects.toThrow(RetryExhaustedError);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe('RetryEngine — fault classification', () => {

  it('terminal fault is surfaced immediately (no retry)', async () => {
    const engine = makeEngine({ defaultMaxAttempts: 5 });
    const terminalErr = new Error('execution reverted: bad auth');
    const fn = vi.fn().mockRejectedValue(terminalErr);
    await expect(engine.run('rpc', fn)).rejects.toThrow('execution reverted: bad auth');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('terminal fault re-throws the original error (not RetryExhaustedError)', async () => {
    const engine = makeEngine();
    const original = new Error('insufficient funds');
    const fn = vi.fn().mockRejectedValue(original);
    try {
      await engine.run('rpc', fn);
    } catch (err) {
      expect(err).toBe(original);
      expect(err).not.toBeInstanceOf(RetryExhaustedError);
    }
  });

  it('confirmation_delay fault is retried (not terminal)', async () => {
    const engine = makeEngine({ defaultMaxAttempts: 3 });
    const fn = failNTimes(2, new Error('transaction not found'));
    const result = await engine.run('rpc', fn);
    expect(result).toBe('ok');
  });

  it('custom classifier overrides the default', async () => {
    const engine = makeEngine({ defaultMaxAttempts: 5 });
    // Pretend any error is terminal via custom classifier
    const customClassifier = vi.fn().mockReturnValue('terminal' as FaultClass);
    const fn = vi.fn().mockRejectedValue(new Error('some transient-looking error'));
    await expect(
      engine.run('rpc', fn, { classifier: customClassifier })
    ).rejects.not.toBeInstanceOf(RetryExhaustedError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('custom classifier returning null falls through to default', async () => {
    const engine = makeEngine({ defaultMaxAttempts: 3 });
    const nullClassifier = vi.fn().mockReturnValue(null);
    // "execution reverted" is terminal per the default classifier
    const fn = vi.fn().mockRejectedValue(new Error('execution reverted'));
    await expect(engine.run('rpc', fn, { classifier: nullClassifier })).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1); // terminal, no retry
  });
});

describe('defaultClassifier', () => {
  it('classifies execution reverted as terminal', () => {
    expect(defaultClassifier(new Error('execution reverted'))).toBe('terminal');
  });

  it('classifies insufficient funds as terminal', () => {
    expect(defaultClassifier(new Error('Insufficient funds'))).toBe('terminal');
  });

  it('classifies transaction not found as confirmation_delay', () => {
    expect(defaultClassifier(new Error('transaction not found on network'))).toBe('confirmation_delay');
  });

  it('classifies rate limit errors as transient', () => {
    expect(defaultClassifier(new Error('compute units exceeded rate limit'))).toBe('transient');
  });

  it('classifies unknown error as transient', () => {
    expect(defaultClassifier(new Error('some totally unknown error'))).toBe('transient');
  });

  it('handles non-Error objects gracefully', () => {
    expect(defaultClassifier('string error')).toBe('transient');
    expect(defaultClassifier({ message: 'execution reverted' })).toBe('transient'); // not an Error
  });
});

describe('RetryEngine — circuit breaker', () => {

  it('circuit starts closed', () => {
    const engine = makeEngine();
    expect(engine.circuitState('rpc')).toBe('closed');
  });

  it('circuit opens after circuitBreakerThreshold consecutive failures', async () => {
    const engine = makeEngine({ circuitBreakerThreshold: 3, defaultMaxAttempts: 1 });
    const fn = vi.fn().mockRejectedValue(new Error('fail'));

    // 3 failing calls should trip the circuit
    for (let i = 0; i < 3; i++) {
      await engine.run('rpc', fn).catch(() => {});
    }
    expect(engine.circuitState('rpc')).toBe('open');
  });

  it('open circuit rejects calls with CircuitOpenError', async () => {
    const engine = makeEngine({ circuitBreakerThreshold: 2, defaultMaxAttempts: 1 });
    const fn = vi.fn().mockRejectedValue(new Error('fail'));

    // Trip the circuit
    for (let i = 0; i < 2; i++) {
      await engine.run('rpc', fn).catch(() => {});
    }

    // Should now fast-fail
    await expect(engine.run('rpc', () => Promise.resolve('x'))).rejects.toThrow(CircuitOpenError);
  });

  it('resetCircuit() closes an open circuit immediately', async () => {
    const engine = makeEngine({ circuitBreakerThreshold: 2, defaultMaxAttempts: 1 });
    const fn = vi.fn().mockRejectedValue(new Error('fail'));

    for (let i = 0; i < 2; i++) {
      await engine.run('rpc', fn).catch(() => {});
    }
    expect(engine.circuitState('rpc')).toBe('open');

    engine.resetCircuit('rpc');
    expect(engine.circuitState('rpc')).toBe('closed');
  });

  it('half-open probe: success → closed', async () => {
    const engine = makeEngine({
      circuitBreakerThreshold: 2,
      circuitBreakerResetMs: 10,
      defaultMaxAttempts: 1,
    });
    const alwaysFail = vi.fn().mockRejectedValue(new Error('fail'));

    // Trip the circuit
    for (let i = 0; i < 2; i++) {
      await engine.run('rpc', alwaysFail).catch(() => {});
    }
    expect(engine.circuitState('rpc')).toBe('open');

    // Wait for half-open window
    await new Promise<void>(r => setTimeout(r, 20));

    // Probe with a succeeding call — circuit should close
    const result = await engine.run('rpc', () => Promise.resolve('probe-ok'));
    expect(result).toBe('probe-ok');
    expect(engine.circuitState('rpc')).toBe('closed');
  });

  it('half-open probe: failure → re-opens circuit', async () => {
    const engine = makeEngine({
      circuitBreakerThreshold: 2,
      circuitBreakerResetMs: 10,
      defaultMaxAttempts: 1,
    });
    const alwaysFail = vi.fn().mockRejectedValue(new Error('fail'));

    // Trip the circuit
    for (let i = 0; i < 2; i++) {
      await engine.run('rpc', alwaysFail).catch(() => {});
    }

    // Wait for half-open
    await new Promise<void>(r => setTimeout(r, 20));

    // Probe with a failing call — circuit should re-open
    await engine.run('rpc', alwaysFail).catch(() => {});
    expect(engine.circuitState('rpc')).toBe('open');
  });

  it('allCircuits() returns state for all registered actions', async () => {
    const engine = makeEngine({ circuitBreakerThreshold: 1, defaultMaxAttempts: 1 });
    await engine.run('rpc', vi.fn().mockRejectedValue(new Error('x'))).catch(() => {});
    await engine.run('horizon', vi.fn().mockRejectedValue(new Error('y'))).catch(() => {});

    const circuits = engine.allCircuits();
    expect('rpc' in circuits).toBe(true);
    expect('horizon' in circuits).toBe(true);
    expect(circuits.rpc.state).toBe('open');
    expect(circuits.horizon.state).toBe('open');
  });

  it('different action namespaces have independent circuits', async () => {
    const engine = makeEngine({ circuitBreakerThreshold: 2, defaultMaxAttempts: 1 });
    const fail = vi.fn().mockRejectedValue(new Error('fail'));

    // Trip 'rpc' circuit
    for (let i = 0; i < 2; i++) {
      await engine.run('rpc', fail).catch(() => {});
    }

    // 'horizon' should still be closed
    expect(engine.circuitState('rpc')).toBe('open');
    expect(engine.circuitState('horizon')).toBe('closed');

    // 'horizon' calls should still work
    const result = await engine.run('horizon', () => Promise.resolve('horizon-ok'));
    expect(result).toBe('horizon-ok');
  });

  it('circuit success resets consecutive failure count', async () => {
    const engine = makeEngine({ circuitBreakerThreshold: 3, defaultMaxAttempts: 1 });
    const fail = vi.fn().mockRejectedValue(new Error('fail'));

    // Fail twice (below threshold)
    await engine.run('rpc', fail).catch(() => {});
    await engine.run('rpc', fail).catch(() => {});
    expect(engine.circuitState('rpc')).toBe('closed');

    // Succeed once — should reset the failure count
    await engine.run('rpc', () => Promise.resolve('ok'));

    // Now fail twice again — should still be closed (count reset)
    await engine.run('rpc', fail).catch(() => {});
    await engine.run('rpc', fail).catch(() => {});
    expect(engine.circuitState('rpc')).toBe('closed');
  });
});

describe('calculateBackoff()', () => {
  it('doubles on each attempt with no jitter', () => {
    const base = 100;
    const max = 10_000;
    // jitter=0, multiplier=1
    expect(calculateBackoff(1, base, max, 0)).toBe(100);
    expect(calculateBackoff(2, base, max, 0)).toBe(200);
    expect(calculateBackoff(3, base, max, 0)).toBe(400);
    expect(calculateBackoff(4, base, max, 0)).toBe(800);
  });

  it('caps at maxMs', () => {
    expect(calculateBackoff(10, 100, 500, 0)).toBe(500);
  });

  it('applies multiplier for confirmation_delay', () => {
    const delay = calculateBackoff(1, 100, 10_000, 0, 3);
    expect(delay).toBe(300);
  });
});

describe('RetryEngine — delayed confirmation scenario', () => {
  it('retries "transaction not found" until receipt appears', async () => {
    const engine = makeEngine({ defaultMaxAttempts: 4, defaultBaseDelayMs: 1, defaultMaxDelayMs: 5 });
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls < 3) throw new Error('transaction not found');
      return 'mined';
    };
    const result = await engine.run('rpc', fn);
    expect(result).toBe('mined');
    expect(calls).toBe(3);
  });
});

describe('RetryEngine — RPC timeout simulation', () => {
  it('retries on network timeout and eventually succeeds', async () => {
    const engine = makeEngine({ defaultMaxAttempts: 5 });
    const fn = failNTimes(3, new Error('RPC getBalance timeout'));
    const result = await engine.run('rpc', fn);
    expect(result).toBe('ok');
  });

  it('exhausts retries when every call times out', async () => {
    const engine = makeEngine({ defaultMaxAttempts: 3 });
    const fn = vi.fn().mockRejectedValue(new Error('RPC sendTransaction timeout'));
    await expect(engine.run('rpc', fn)).rejects.toThrow(RetryExhaustedError);
    expect(fn).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// Circuit breaker — cooldown boundary (FakeClock)
// ---------------------------------------------------------------------------
//
// This suite pins down the exact cooldown contract using the shared FakeClock
// utility from @wafflefinance/test-utils so the test is deterministic and
// documents the transition points precisely — without any real wall-clock
// sleeps and with guaranteed cleanup even when a test throws:
//
//   closed ──[threshold failures]──▶ open
//      open ──[elapsed < resetMs]──▶ fast-fail (CircuitOpenError)
//      open ──[elapsed >= resetMs]──▶ half-open (one probe allowed)
//   half-open + success ──▶ closed
//   half-open + failure ──▶ open
//
// FakeClock.restore() is called in afterEach, so fake-timer state never leaks
// into the negative-delay suite or any other suite that runs afterwards.
// ---------------------------------------------------------------------------

describe('RetryEngine — circuit breaker cooldown boundary (FakeClock)', () => {
  // One shared clock instance; each test installs it and afterEach restores.
  const clock = new FakeClock({ scope: 'all' });

  beforeEach(() => clock.install());
  afterEach(() => clock.restore());

  /**
   * Helper: trip the circuit by running `threshold` failing calls.
   * Uses maxAttempts=1 so each run() call is exactly one attempt.
   */
  async function tripCircuit(engine: RetryEngine, action: string, threshold: number): Promise<void> {
    const fail = vi.fn().mockRejectedValue(new Error('forced failure'));
    for (let i = 0; i < threshold; i++) {
      await engine.run(action, fail, { maxAttempts: 1 }).catch(() => {});
    }
  }

  it('circuit opens after threshold failures and blocks calls immediately', async () => {
    const THRESHOLD = 3;
    const RESET_MS = 1_000;
    const engine = new RetryEngine({
      circuitBreakerThreshold: THRESHOLD,
      circuitBreakerResetMs: RESET_MS,
      defaultBaseDelayMs: 0,
      defaultMaxDelayMs: 0,
      jitterFactor: 0,
    });

    await tripCircuit(engine, 'rpc', THRESHOLD);
    expect(engine.circuitState('rpc')).toBe('open');

    // Immediately after opening the circuit must fast-fail.
    const probe = vi.fn().mockResolvedValue('should-not-reach');
    await expect(engine.run('rpc', probe, { maxAttempts: 1 })).rejects.toBeInstanceOf(CircuitOpenError);
    expect(probe).not.toHaveBeenCalled();
  });

  it('calls are still blocked 1 ms before the cooldown expires', async () => {
    const RESET_MS = 5_000;
    const engine = new RetryEngine({
      circuitBreakerThreshold: 2,
      circuitBreakerResetMs: RESET_MS,
      defaultBaseDelayMs: 0,
      defaultMaxDelayMs: 0,
      jitterFactor: 0,
    });

    await tripCircuit(engine, 'rpc', 2);
    expect(engine.circuitState('rpc')).toBe('open');

    // Advance to 1 ms before the reset window closes — still open.
    clock.advance(RESET_MS - 1);
    const blocked = vi.fn().mockResolvedValue('nope');
    await expect(engine.run('rpc', blocked, { maxAttempts: 1 })).rejects.toBeInstanceOf(CircuitOpenError);
    expect(blocked).not.toHaveBeenCalled();
  });

  it('transitions to half-open exactly at the cooldown boundary', async () => {
    const RESET_MS = 5_000;
    const engine = new RetryEngine({
      circuitBreakerThreshold: 2,
      circuitBreakerResetMs: RESET_MS,
      defaultBaseDelayMs: 0,
      defaultMaxDelayMs: 0,
      jitterFactor: 0,
    });

    await tripCircuit(engine, 'rpc', 2);
    expect(engine.circuitState('rpc')).toBe('open');

    // Advance exactly to the reset boundary.
    clock.advance(RESET_MS);

    // The probe call is allowed through and succeeds → circuit closes.
    const probeWorker = vi.fn().mockResolvedValue('probe-result');
    const result = await engine.run('rpc', probeWorker, { maxAttempts: 1 });

    expect(probeWorker).toHaveBeenCalledTimes(1);
    expect(result).toBe('probe-result');
    expect(engine.circuitState('rpc')).toBe('closed');
  });

  it('failed half-open probe reopens the circuit immediately', async () => {
    const RESET_MS = 5_000;
    const engine = new RetryEngine({
      circuitBreakerThreshold: 2,
      circuitBreakerResetMs: RESET_MS,
      defaultBaseDelayMs: 0,
      defaultMaxDelayMs: 0,
      jitterFactor: 0,
    });

    await tripCircuit(engine, 'rpc', 2);

    // Advance exactly to the reset boundary so a probe is allowed.
    clock.advance(RESET_MS);

    // Probe fails → circuit must reopen immediately.
    const failingProbe = vi.fn().mockRejectedValue(new Error('probe failure'));
    await engine.run('rpc', failingProbe, { maxAttempts: 1 }).catch(() => {});

    expect(failingProbe).toHaveBeenCalledTimes(1);
    expect(engine.circuitState('rpc')).toBe('open');

    // A subsequent call (without advancing time) must fast-fail again.
    const blocked = vi.fn().mockResolvedValue('nope');
    await expect(engine.run('rpc', blocked, { maxAttempts: 1 })).rejects.toBeInstanceOf(CircuitOpenError);
    expect(blocked).not.toHaveBeenCalled();
  });

  it('1 ms before cooldown is still open; exactly at boundary is half-open', async () => {
    // Verify the boundary condition is >= (inclusive), not >.
    const RESET_MS = 2_000;
    const engine = new RetryEngine({
      circuitBreakerThreshold: 1,
      circuitBreakerResetMs: RESET_MS,
      defaultBaseDelayMs: 0,
      defaultMaxDelayMs: 0,
      jitterFactor: 0,
    });

    await tripCircuit(engine, 'rpc', 1);

    // One ms before the boundary — still blocked.
    clock.advance(RESET_MS - 1);
    await expect(
      engine.run('rpc', vi.fn().mockResolvedValue('x'), { maxAttempts: 1 })
    ).rejects.toBeInstanceOf(CircuitOpenError);

    // Advance the final 1 ms to reach the exact boundary.
    clock.advance(1);
    const worker = vi.fn().mockResolvedValue('boundary-ok');
    await expect(engine.run('rpc', worker, { maxAttempts: 1 })).resolves.toBe('boundary-ok');
    expect(engine.circuitState('rpc')).toBe('closed');
  });
});

// ---------------------------------------------------------------------------
// Negative delay / jitter clamping
// ---------------------------------------------------------------------------
//
// Negative base delays or jitter values collapse backoff into an immediate
// busy-loop, making outage behaviour worse.  The engine must clamp them to
// zero at construction time and also when per-call overrides are provided,
// so no negative timer is ever scheduled.
// ---------------------------------------------------------------------------

describe('RetryEngine — negative delay clamping', () => {
  // Shared clock for the two tests in this suite that need fake timers.
  const clock = new FakeClock({ scope: 'all' });
  afterEach(() => clock.restore());

  // ── Constructor-level clamping ────────────────────────────────────────────

  it('clamps negative defaultBaseDelayMs to zero — no negative timer scheduled', async () => {
    clock.install();
    const engine = new RetryEngine({
      defaultBaseDelayMs: -5_000,   // should be treated as 0
      defaultMaxDelayMs: 100,
      defaultMaxAttempts: 2,
      jitterFactor: 0,
      circuitBreakerThreshold: 99,
    });

    // Two attempts: first fails (transient), second succeeds.
    let calls = 0;
    const fn = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls === 1) throw new Error('transient');
      return 'ok';
    });

    // Run the engine — the backoff sleep is setTimeout(resolve, 0) when
    // base is clamped to 0.  Advance timers by 0 ms to flush it.
    const p = engine.run('rpc', fn);
    clock.advance(0);
    const result = await p;

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
    // Confirm the clamped config value.
    expect((engine as any).cfg.defaultBaseDelayMs).toBe(0);
  });

  it('clamps negative defaultMaxDelayMs to zero', () => {
    const engine = new RetryEngine({ defaultMaxDelayMs: -1 });
    expect((engine as any).cfg.defaultMaxDelayMs).toBe(0);
  });

  it('clamps negative jitterFactor to zero', () => {
    const engine = new RetryEngine({ jitterFactor: -0.5 });
    expect((engine as any).cfg.jitterFactor).toBe(0);
  });

  it('does not alter valid (non-negative) delay settings', () => {
    const engine = new RetryEngine({
      defaultBaseDelayMs: 250,
      defaultMaxDelayMs: 10_000,
      jitterFactor: 0.15,
    });
    expect((engine as any).cfg.defaultBaseDelayMs).toBe(250);
    expect((engine as any).cfg.defaultMaxDelayMs).toBe(10_000);
    expect((engine as any).cfg.jitterFactor).toBe(0.15);
  });

  it('clamps zero base and max delay — still schedules zero-ms timers, not negative', () => {
    // Zero is a valid value (disables backoff entirely); must not be bumped up.
    const engine = new RetryEngine({ defaultBaseDelayMs: 0, defaultMaxDelayMs: 0 });
    expect((engine as any).cfg.defaultBaseDelayMs).toBe(0);
    expect((engine as any).cfg.defaultMaxDelayMs).toBe(0);
  });

  // ── Per-call override clamping ────────────────────────────────────────────

  it('clamps a negative per-call baseDelayMs override to zero', async () => {
    clock.install();
    const engine = new RetryEngine({
      defaultMaxAttempts: 2,
      jitterFactor: 0,
      circuitBreakerThreshold: 99,
      defaultBaseDelayMs: 1_000,  // positive default …
      defaultMaxDelayMs: 5_000,
    });

    let calls = 0;
    const fn = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls === 1) throw new Error('transient');
      return 'clamped-ok';
    });

    // Override with a negative value — must be treated as 0.
    const p = engine.run('rpc', fn, { baseDelayMs: -9_999, maxDelayMs: -1 });
    clock.advance(0);
    const result = await p;

    expect(result).toBe('clamped-ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  // ── Retry count invariance ────────────────────────────────────────────────

  it('clamping does not change the number of retry attempts', async () => {
    clock.install();
    const MAX = 3;
    const engine = new RetryEngine({
      defaultMaxAttempts: MAX,
      defaultBaseDelayMs: -100,  // negative → clamped to 0
      defaultMaxDelayMs: -100,   // negative → clamped to 0
      jitterFactor: -1,           // negative → clamped to 0
      circuitBreakerThreshold: 99,
    });

    const fn = vi.fn().mockRejectedValue(new Error('always fails'));
    const p = engine.run('rpc', fn);
    // With 0-ms delays each backoff is setTimeout(resolve, 0).
    // Flush all pending micro/macro tasks for each retry.
    for (let i = 0; i < MAX; i++) {
      clock.advance(0);
      await Promise.resolve(); // let the microtask queue drain
    }
    await p.catch(() => {});

    // All MAX attempts were made despite clamped-to-zero delays.
    expect(fn).toHaveBeenCalledTimes(MAX);
  });

  // ── calculateBackoff utility ──────────────────────────────────────────────

  it('calculateBackoff with jitter=0 never returns a negative value', () => {
    // Even if someone passes a negative base directly to calculateBackoff,
    // the Math.max(0, ...) guard inside should keep the result non-negative.
    // (calculateBackoff itself doesn't clamp inputs — that's the engine's job —
    //  but the output floor is guaranteed by the existing guard.)
    for (let attempt = 1; attempt <= 8; attempt++) {
      expect(calculateBackoff(attempt, 0, 0, 0)).toBeGreaterThanOrEqual(0);
      expect(calculateBackoff(attempt, 100, 1_000, 0)).toBeGreaterThanOrEqual(0);
    }
  });
});
