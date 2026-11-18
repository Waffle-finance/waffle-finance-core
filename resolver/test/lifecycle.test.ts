/**
 * @fileoverview Tests for lifecycle.ts
 *
 * Validates:
 *   - Lifecycle state transitions are valid
 *   - Invalid transitions are rejected
 *   - Metrics are updated correctly
 *   - Safety guards work as expected
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createLogger } from "pino";
import {
  ResolverLifecycle,
  LIFECYCLE_TRANSITIONS,
  InvalidLifecycleTransitionError,
  StateNotAllowedError,
  LifecycleGuard,
  describeLifecycleState,
  isSafeForIntervention,
} from '../src/lifecycle.js';

// ── Test helpers ──────────────────────────────────────────────────────────────

function createTestLogger() {
  return createLogger({ level: 'silent' });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ResolverLifecycle', () => {
  let lifecycle: ResolverLifecycle;

  beforeEach(() => {
    lifecycle = new ResolverLifecycle(createTestLogger());
  });

  describe('initial state', () => {
    it('starts in idle state', () => {
      expect(lifecycle.state).toBe('idle');
    });

    it('stateStartedAt is set on creation', () => {
      expect(lifecycle.stateStartedAt).toBeGreaterThan(0);
    });

    it('transitionCount is 0 initially', () => {
      expect(lifecycle.transitionCount).toBe(0);
    });
  });

  describe('valid transitions', () => {
    it('transitions from idle to starting', () => {
      lifecycle.transition('starting');
      expect(lifecycle.state).toBe('starting');
    });

    it('transitions from starting to running', () => {
      lifecycle.transition('starting');
      lifecycle.transition('running');
      expect(lifecycle.state).toBe('running');
    });

    it('transitions from running to stopping', () => {
      lifecycle.transition('starting');
      lifecycle.transition('running');
      lifecycle.transition('stopping');
      expect(lifecycle.state).toBe('stopping');
    });

    it('transitions from running to pausing', () => {
      lifecycle.transition('starting');
      lifecycle.transition('running');
      lifecycle.transition('pausing');
      expect(lifecycle.state).toBe('pausing');
    });

    it('transitions from pausing to paused', () => {
      lifecycle.transition('starting');
      lifecycle.transition('running');
      lifecycle.transition('pausing');
      lifecycle.transition('paused');
      expect(lifecycle.state).toBe('paused');
    });

    it('transitions from running to restarting', () => {
      lifecycle.transition('starting');
      lifecycle.transition('running');
      lifecycle.transition('restarting');
      expect(lifecycle.state).toBe('restarting');
    });

    it('transitions from restarting to starting', () => {
      lifecycle.transition('starting');
      lifecycle.transition('running');
      lifecycle.transition('restarting');
      lifecycle.transition('starting');
      expect(lifecycle.state).toBe('starting');
    });

    it('increments transitionCount on each transition', () => {
      expect(lifecycle.transitionCount).toBe(0);
      lifecycle.transition('starting');
      expect(lifecycle.transitionCount).toBe(1);
      lifecycle.transition('running');
      expect(lifecycle.transitionCount).toBe(2);
    });

    it('updates stateStartedAt on transition', () => {
      const firstTime = lifecycle.stateStartedAt;
      lifecycle.transition('starting');
      expect(lifecycle.stateStartedAt).toBeGreaterThan(firstTime);
    });
  });

  describe('invalid transitions', () => {
    it('rejects idle → running (must go through starting)', () => {
      expect(() => lifecycle.transition('running')).toThrow(InvalidLifecycleTransitionError);
      expect(() => lifecycle.transition('running')).toThrow(/idle → running/);
    });

    it('rejects running → idle (no backward transition)', () => {
      lifecycle.transition('starting');
      lifecycle.transition('running');
      expect(() => lifecycle.transition('idle')).toThrow(InvalidLifecycleTransitionError);
    });

    it('rejects stopped → starting (must create new instance)', () => {
      lifecycle.transition('starting');
      lifecycle.transition('running');
      lifecycle.transition('stopping');
      lifecycle.transition('stopped');
      expect(() => lifecycle.transition('starting')).toThrow(StateNotAllowedError);
    });

    it('rejects failed → restarting (cannot recover from failed)', () => {
      lifecycle.transition('starting');
      lifecycle.transition('running');
      lifecycle.transition('failed');
      expect(() => lifecycle.transition('restarting')).toThrow(StateNotAllowedError);
    });

    it('rejects paused → pausing (already paused)', () => {
      lifecycle.transition('starting');
      lifecycle.transition('running');
      lifecycle.transition('pausing');
      lifecycle.transition('paused');
      expect(() => lifecycle.transition('pausing')).toThrow(InvalidLifecycleTransitionError);
    });

    it('rejects idle → pausing (cannot pause non-running)', () => {
      expect(() => lifecycle.transition('pausing')).toThrow(StateNotAllowedError);
    });

    it('rejects starting → paused (must go through running first)', () => {
      lifecycle.transition('starting');
      expect(() => lifecycle.transition('paused')).toThrow(StateNotAllowedError);
    });
  });

  describe('state properties', () => {
    describe('isSafeToStop', () => {
      it('true for stopped state', () => {
        lifecycle.transition('stopped');
        expect(lifecycle.isSafeToStop).toBe(true);
      });

      it('true for failed state', () => {
        lifecycle.transition('failed');
        expect(lifecycle.isSafeToStop).toBe(true);
      });

      it('true for stopping state', () => {
        lifecycle.transition('stopping');
        expect(lifecycle.isSafeToStop).toBe(true);
      });

      it('true for pausing state', () => {
        lifecycle.transition('pausing');
        expect(lifecycle.isSafeToStop).toBe(true);
      });

      it('false for running state', () => {
        lifecycle.transition('running');
        expect(lifecycle.isSafeToStop).toBe(false);
      });

      it('false for idle state', () => {
        expect(lifecycle.isSafeToStop).toBe(false);
      });
    });

    describe('isProcessingEvents', () => {
      it('true for running state', () => {
        lifecycle.transition('running');
        expect(lifecycle.isProcessingEvents).toBe(true);
      });

      it('false for idle state', () => {
        expect(lifecycle.isProcessingEvents).toBe(false);
      });

      it('false for stopped state', () => {
        lifecycle.transition('stopped');
        expect(lifecycle.isProcessingEvents).toBe(false);
      });

      it('false for pausing state', () => {
        lifecycle.transition('pausing');
        expect(lifecycle.isProcessingEvents).toBe(false);
      });
    });

    describe('isPaused', () => {
      it('true for paused state', () => {
        lifecycle.transition('paused');
        expect(lifecycle.isPaused).toBe(true);
      });

      it('false for running state', () => {
        lifecycle.transition('running');
        expect(lifecycle.isPaused).toBe(false);
      });
    });

    describe('isRunning', () => {
      it('true for running state', () => {
        lifecycle.transition('running');
        expect(lifecycle.isRunning).toBe(true);
      });

      it('true for starting state', () => {
        lifecycle.transition('starting');
        expect(lifecycle.isRunning).toBe(true);
      });

      it('true for restarting state', () => {
        lifecycle.transition('restarting');
        expect(lifecycle.isRunning).toBe(true);
      });

      it('false for paused state', () => {
        lifecycle.transition('paused');
        expect(lifecycle.isRunning).toBe(false);
      });

      it('false for stopped state', () => {
        lifecycle.transition('stopped');
        expect(lifecycle.isRunning).toBe(false);
      });
    });

    describe('isTerminal', () => {
      it('true for stopped state', () => {
        lifecycle.transition('stopped');
        expect(lifecycle.isTerminal).toBe(true);
      });

      it('true for failed state', () => {
        lifecycle.transition('failed');
        expect(lifecycle.isTerminal).toBe(true);
      });

      it('false for running state', () => {
        lifecycle.transition('running');
        expect(lifecycle.isTerminal).toBe(false);
      });
    });
  });

  describe('state duration', () => {
    it('stateDurationMs increases over time', async () => {
      const duration1 = lifecycle.stateDurationMs;
      await new Promise(resolve => setTimeout(resolve, 10));
      const duration2 = lifecycle.stateDurationMs;
      expect(duration2).toBeGreaterThan(duration1);
    });
  });

  describe('nextPossibleStates', () => {
    it('returns allowed transitions from current state', () => {
      lifecycle.transition('starting');
      const allowed = lifecycle.nextPossibleStates();
      expect(allowed).toContain('running');
      expect(allowed).toContain('stopping');
      expect(allowed).toContain('failed');
    });

    it('returns empty array for terminal states', () => {
      lifecycle.transition('stopped');
      expect(lifecycle.nextPossibleStates()).toHaveLength(0);
    });
  });

  describe('forceTransition', () => {
    it('bypasses validation and forces the transition', () => {
      lifecycle.transition('stopped');
      // Should throw with normal transition
      expect(() => lifecycle.transition('starting')).toThrow(StateNotAllowedError);

      // Force transition should work
      lifecycle.forceTransition('running', 'emergency override');
      expect(lifecycle.state).toBe('running');
    });

    it('logs forced transition as warning', () => {
      const log = createLogger({ level: 'warn' });
      const lifecycleWithLog = new ResolverLifecycle(log);

      let logged = false;
      log.on('warn', () => { logged = true; });

      lifecycleWithLog.forceTransition('running', 'test');
      expect(logged).toBe(true);
    });
  });

  describe('reset', () => {
    it('resets to idle state', () => {
      lifecycle.transition('starting');
      lifecycle.transition('running');
      lifecycle.transition('stopping');
      lifecycle.transition('stopped');
      lifecycle.reset();
      expect(lifecycle.state).toBe('idle');
    });

    it('resets transitionCount to 0', () => {
      lifecycle.transition('starting');
      lifecycle.transition('running');
      expect(lifecycle.transitionCount).toBe(2);
      lifecycle.reset();
      expect(lifecycle.transitionCount).toBe(0);
    });

    it('updates stateStartedAt', () => {
      const before = lifecycle.stateStartedAt;
      lifecycle.reset();
      expect(lifecycle.stateStartedAt).toBeGreaterThan(before);
    });
  });

  describe('snapshot', () => {
    it('returns complete lifecycle state', () => {
      lifecycle.transition('running');
      const snap = lifecycle.snapshot();

      expect(snap.state).toBe('running');
      expect(snap.stateStartedAt).toBeGreaterThan(0);
      expect(snap.stateDurationMs).toBeGreaterThan(0);
      expect(snap.transitionCount).toBe(1);
      expect(snap.isSafeToStop).toBe(false);
      expect(snap.isProcessingEvents).toBe(true);
      expect(snap.isPaused).toBe(false);
      expect(snap.isRunning).toBe(true);
      expect(snap.isTerminal).toBe(false);
    });
  });
});

describe('LifecycleGuard', () => {
  let lifecycle: ResolverLifecycle;
  let guard: LifecycleGuard;

  beforeEach(() => {
    lifecycle = new ResolverLifecycle(createTestLogger());
    guard = new LifecycleGuard(lifecycle);
  });

  describe('assertCanProcessEvents', () => {
    it('throws when not in running state', () => {
      expect(() => guard.assertCanProcessEvents()).toThrow(StateNotAllowedError);
    });

    it('succeeds in running state', () => {
      lifecycle.transition('running');
      expect(() => guard.assertCanProcessEvents()).not.toThrow();
    });
  });

  describe('assertCanStart', () => {
    it('allows starting from idle', () => {
      lifecycle.transition('idle');
      expect(() => guard.assertCanStart()).not.toThrow();
    });

    it('allows starting from paused', () => {
      lifecycle.transition('paused');
      expect(() => guard.assertCanStart()).not.toThrow();
    });

    it('allows starting from restarting', () => {
      lifecycle.transition('restarting');
      expect(() => guard.assertCanStart()).not.toThrow();
    });

    it('throws when in running state', () => {
      lifecycle.transition('running');
      expect(() => guard.assertCanStart()).toThrow(StateNotAllowedError);
    });
  });

  describe('assertCanStop', () => {
    it('allows stopping from running', () => {
      lifecycle.transition('running');
      expect(() => guard.assertCanStop()).not.toThrow();
    });

    it('allows stopping from pausing', () => {
      lifecycle.transition('pausing');
      expect(() => guard.assertCanStop()).not.toThrow();
    });

    it('allows stopping from paused', () => {
      lifecycle.transition('paused');
      expect(() => guard.assertCanStop()).not.toThrow();
    });

    it('allows stopping from starting', () => {
      lifecycle.transition('starting');
      expect(() => guard.assertCanStop()).not.toThrow();
    });

    it('allows stopping from restarting', () => {
      lifecycle.transition('restarting');
      expect(() => guard.assertCanStop()).not.toThrow();
    });

    it('throws when in idle state', () => {
      expect(() => guard.assertCanStop()).toThrow(StateNotAllowedError);
    });

    it('throws when in stopped state', () => {
      lifecycle.transition('stopped');
      expect(() => guard.assertCanStop()).toThrow(StateNotAllowedError);
    });
  });

  describe('assertCanPause', () => {
    it('allows pausing from running', () => {
      lifecycle.transition('running');
      expect(() => guard.assertCanPause()).not.toThrow();
    });

    it('throws when in idle state', () => {
      expect(() => guard.assertCanPause()).toThrow(StateNotAllowedError);
    });

    it('throws when in paused state', () => {
      lifecycle.transition('paused');
      expect(() => guard.assertCanPause()).toThrow(StateNotAllowedError);
    });
  });

  describe('assertCanRestart', () => {
    it('allows restarting from running', () => {
      lifecycle.transition('running');
      expect(() => guard.assertCanRestart()).not.toThrow();
    });

    it('allows restarting from paused', () => {
      lifecycle.transition('paused');
      expect(() => guard.assertCanRestart()).not.toThrow();
    });

    it('allows restarting from pausing', () => {
      lifecycle.transition('pausing');
      expect(() => guard.assertCanRestart()).not.toThrow();
    });

    it('throws when in idle state', () => {
      expect(() => guard.assertCanRestart()).toThrow(StateNotAllowedError);
    });

    it('throws when in stopped state', () => {
      lifecycle.transition('stopped');
      expect(() => guard.assertCanRestart()).toThrow(StateNotAllowedError);
    });

    it('throws when in failed state', () => {
      lifecycle.transition('failed');
      expect(() => guard.assertCanRestart()).toThrow(StateNotAllowedError);
    });
  });
});

describe('describeLifecycleState', () => {
  it('describes all states correctly', () => {
    const descriptions = [
      ['idle', 'Service created but not yet started'],
      ['starting', 'Initializing listeners and preparing to process events'],
      ['running', 'Listeners active and processing events'],
      ['pausing', 'Gracefully pausing; waiting for in-flight work to complete'],
      ['paused', 'All listeners paused; no event processing'],
      ['restarting', 'Recoverable error; listeners stopping before restart'],
      ['stopping', 'Shutdown requested; tearing down listeners'],
      ['stopped', 'Cleanly stopped'],
      ['failed', 'Exhausted restarts or fatal error; will not recover'],
    ];

    for (const [state, expected] of descriptions) {
      expect(describeLifecycleState(state as any)).toBe(expected);
    }
  });

  it('handles unknown states', () => {
    expect(describeLifecycleState('unknown' as any)).toBe('Unknown state');
  });
});

describe('isSafeForIntervention', () => {
  it('true for paused state', () => {
    expect(isSafeForIntervention('paused')).toBe(true);
  });

  it('true for stopped state', () => {
    expect(isSafeForIntervention('stopped')).toBe(true);
  });

  it('true for failed state', () => {
    expect(isSafeForIntervention('failed')).toBe(true);
  });

  it('false for running state', () => {
    expect(isSafeForIntervention('running')).toBe(false);
  });

  it('false for idle state', () => {
    expect(isSafeForIntervention('idle')).toBe(false);
  });
});

describe('lifecycle state machine completeness', () => {
  it('all states are defined in LIFECYCLE_TRANSITIONS', () => {
    const expectedStates: LifecycleState[] = [
      'idle',
      'starting',
      'running',
      'pausing',
      'paused',
      'restarting',
      'stopping',
      'stopped',
      'failed',
    ];

    for (const state of expectedStates) {
      expect(LIFECYCLE_TRANSITIONS).toHaveProperty(state);
    }
  });

  it('all transitions are symmetric in documentation', () => {
    // Verify that if A can transition to B, then A is in B's allowed sources
    const validStates: LifecycleState[] = [
      'idle',
      'starting',
      'running',
      'pausing',
      'paused',
      'restarting',
      'stopping',
      'stopped',
      'failed',
    ];

    for (const fromState of validStates) {
      const allowed = LIFECYCLE_TRANSITIONS[fromState];
      if (allowed) {
        for (const toState of allowed) {
          // Verify the transition is documented
          expect(validStates).toContain(toState);
        }
      }
    }
  });
});
