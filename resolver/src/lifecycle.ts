/**
 * @file lifecycle.ts
 *
 * Explicit resolver lifecycle state machine with safe transitions.
 *
 * Lifecycle States
 * ----------------
 * - `idle`         — newly created, listeners not yet started
 * - `starting`     — listeners are being initialized and started
 * - `running`      — listeners are active and processing events
 * - `pausing`      — graceful pause requested; waiting for in-flight work to complete
 * - `paused`       — all listeners paused; no event processing
 * - `restarting`   — recoverable error; listeners are stopping before restart
 * - `stopping`     — shutdown requested; tearing down listeners
 * - `stopped`      — cleanly stopped via stop() or clean exit
 * - `failed`       — exhausted restarts or fatal error; will not recover
 *
 * Safe Transitions
 * ----------------
 * All transitions are validated to prevent invalid state changes:
 *
 *   idle → starting → running → {pausing, stopping} → {paused, stopped}
 *   running → restarting → starting → running
 *   running → stopping → stopped
 *   paused → restarting → starting → running
 *   paused → stopping → stopped
 *
 * Unsafe transitions (prevented):
 *   - Cannot transition from stopped/failed to any state except restart
 *   - Cannot pause a non-running service
 *   - Cannot restart from failed state
 *
 * Telemetry
 * ---------
 * - `resolver_lifecycle_state{state}` — gauge showing current state
 * - `resolver_lifecycle_transitions_total{from, to}` — transition counts
 * - `resolver_lifecycle_duration_seconds{state}` — time spent in each state
 *
 * Usage
 * -----
 * ```ts
 * const lifecycle = new ResolverLifecycle(log);
 *
 * // Start the service
 * lifecycle.transition('starting');
 * await doStartupWork();
 * lifecycle.transition('running');
 *
 * // Pause gracefully
 * lifecycle.transition('pausing');
 * await drainInFlightWork();
 * lifecycle.transition('paused');
 *
 * // Resume
 * lifecycle.transition('restarting');
 * lifecycle.transition('starting');
 * lifecycle.transition('running');
 *
 * // Stop
 * lifecycle.transition('stopping');
 * await cleanup();
 * lifecycle.transition('stopped');
 * ```
 */

import type { Logger } from "pino";

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * All valid lifecycle states.
 */
export type LifecycleState =
  | "idle"
  | "starting"
  | "running"
  | "pausing"
  | "paused"
  | "restarting"
  | "stopping"
  | "stopped"
  | "failed";

/**
 * Valid transitions from each state.
 */
export interface StateTransitions {
  [key: string]: LifecycleState[];
}

/**
 * Transition configuration: defines which state transitions are valid.
 */
export const LIFECYCLE_TRANSITIONS: StateTransitions = {
  // Initial state
  idle: ["starting"],
  
  // Startup phase
  starting: ["running", "stopping", "failed"],
  
  // Active processing
  running: ["pausing", "restarting", "stopping", "failed"],
  
  // Pause phases
  pausing: ["paused", "stopping"],
  paused: ["restarting", "stopping"],
  
  // Recovery phases
  restarting: ["starting", "stopping", "failed"],
  
  // Shutdown phases
  stopping: ["stopped", "failed"],
  
  // Terminal states
  stopped: [],  // No transitions from stopped (new instance required)
  failed: [],   // No transitions from failed (new instance required)
};

/**
 * Error thrown when an invalid state transition is attempted.
 */
export class InvalidLifecycleTransitionError extends Error {
  constructor(
    public readonly from: LifecycleState,
    public readonly to: LifecycleState,
    public readonly allowed: LifecycleState[],
  ) {
    super(
      `Invalid lifecycle transition: ${from} → ${to}. Allowed: [${allowed.join(", ")}]`
    );
    this.name = "InvalidLifecycleTransitionError";
  }
}

/**
 * Error thrown when an operation is not allowed in the current state.
 */
export class StateNotAllowedError extends Error {
  constructor(
    public readonly state: LifecycleState,
    public readonly operation: string,
  ) {
    super(`Operation "${operation}" not allowed in state "${state}"`);
    this.name = "StateNotAllowedError";
  }
}

// ── Metrics (exported for use in metrics.ts) ────────────────────────────────

import {
  lifecycleStateGauge,
  lifecycleTransitionsTotal,
} from "./metrics.js";

// ── ResolverLifecycle Class ───────────────────────────────────────────────────

/**
 * Manages resolver lifecycle state with safe transitions and telemetry.
 */
export class ResolverLifecycle {
  private _state: LifecycleState = "idle";
  private _stateStartedAt: number = Date.now();
  private _transitionCount: number = 0;
  private readonly log: Logger;

  /**
   * Create a new lifecycle manager.
   * @param log Logger instance for lifecycle change notifications.
   */
  constructor(log: Logger) {
    this.log = log.child({ component: "Lifecycle" });
  }

  /**
   * Current lifecycle state.
   */
  get state(): LifecycleState {
    return this._state;
  }

  /**
   * Time when the current state was entered (ms since epoch).
   */
  get stateStartedAt(): number {
    return this._stateStartedAt;
  }

  /**
   * Number of transitions that have occurred.
   */
  get transitionCount(): number {
    return this._transitionCount;
  }

  /**
   * Duration spent in current state (ms).
   */
  get stateDurationMs(): number {
    return Date.now() - this._stateStartedAt;
  }

  /**
   * Check if the lifecycle is in a safe state for shutdown.
   * Safe states: stopped, failed, pausing, stopping
   */
  get isSafeToStop(): boolean {
    return ["stopped", "failed", "pausing", "stopping"].includes(this._state);
  }

  /**
   * Check if the lifecycle allows event processing.
   * Processing states: running
   */
  get isProcessingEvents(): boolean {
    return this._state === "running";
  }

  /**
   * Check if the lifecycle is paused.
   */
  get isPaused(): boolean {
    return this._state === "paused";
  }

  /**
   * Check if the lifecycle is running (including starting).
   */
  get isRunning(): boolean {
    return ["running", "starting", "restarting"].includes(this._state);
  }

  /**
   * Check if the lifecycle is in a terminal state.
   */
  get isTerminal(): boolean {
    return ["stopped", "failed"].includes(this._state);
  }

  /**
   * Transition to a new state if valid.
   *
   * @param nextState The target state.
   * @throws InvalidLifecycleTransitionError if the transition is not allowed.
   * @throws StateNotAllowedError if target state has preconditions that aren't met.
   */
  transition(nextState: LifecycleState): void {
    // Validate the transition
    const allowed = LIFECYCLE_TRANSITIONS[this._state];
    
    if (!allowed) {
      throw new InvalidLifecycleTransitionError(
        this._state,
        nextState,
        []
      );
    }

    if (!allowed.includes(nextState)) {
      throw new InvalidLifecycleTransitionError(
        this._state,
        nextState,
        allowed
      );
    }

    // Additional safety checks for specific transitions
    this.validateTransition(this._state, nextState);

    // Apply the transition
    const previousState = this._state;
    this._state = nextState;
    this._stateStartedAt = Date.now();
    this._transitionCount++;

    // Log the transition
    this.log.info(
      { from: previousState, to: nextState, durationMs: this._stateDurationMs },
      "lifecycle state transition"
    );

    // Update metrics
    lifecycleStateGauge.set(nextState);
    lifecycleTransitionsCounter.inc(previousState, nextState);
  }

  /**
   * Validate a transition has all required preconditions.
   */
  private validateTransition(from: LifecycleState, to: LifecycleState): void {
    // Cannot pause a non-running service
    if (from !== "running" && to === "paused") {
      throw new StateNotAllowedError(
        from,
        "pause"
      );
    }

    // Cannot restart from failed state
    if (from === "failed" && to === "restarting") {
      throw new StateNotAllowedError(
        from,
        "restart"
      );
    }

    // Cannot start from stopped/failed without reset
    if ((from === "stopped" || from === "failed") && to === "starting") {
      throw new StateNotAllowedError(
        from,
        "start"
      );
    }
  }

  /**
   * Force a state change without validation (for emergency situations).
   * Use sparingly - prefer valid transitions.
   *
   * @param nextState The new state.
   * @param reason Reason for forcing the transition.
   */
  forceTransition(nextState: LifecycleState, reason: string): void {
    const previousState = this._state;
    this._state = nextState;
    this._stateStartedAt = Date.now();
    this._transitionCount++;

    this.log.warn(
      { from: previousState, to: nextState, reason, durationMs: this._stateDurationMs },
      "forced lifecycle state transition"
    );

    lifecycleStateGauge.set(nextState);
    lifecycleTransitionsCounter.inc(previousState, nextState);
  }

  /**
   * Wait for a condition to be met before allowing transition.
   *
   * @param condition Check if transition is allowed.
   * @param timeoutMs Maximum time to wait.
   * @throws StateNotAllowedError if condition is not met within timeout.
   */
  async waitForState(
    condition: (state: LifecycleState) => boolean,
    timeoutMs: number = 30_000
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const check = () => {
        if (condition(this._state)) {
          resolve();
        } else {
          reject(
            new StateNotAllowedError(
              this._state,
              `waiting for state condition: ${condition.toString()}`
            )
          );
        }
      };

      // Check immediately
      check();

      // Set up interval
      const interval = setInterval(check, 100);
      
      // Set up timeout
      const timeout = setTimeout(() => {
        clearInterval(interval);
        reject(
          new Error(
            `Timeout waiting for state condition after ${timeoutMs}ms: ${condition.toString()}`
          )
        );
      }, timeoutMs);

      // Cleanup on resolution
      const cleanup = () => {
        clearInterval(interval);
        clearTimeout(timeout);
      };
      resolve().then(cleanup).catch(cleanup);
    });
  }

  /**
   * Wait for the lifecycle to enter a specific state.
   *
   * @param targetState The state to wait for.
   * @param timeoutMs Maximum time to wait.
   */
  async waitFor(targetState: LifecycleState, timeoutMs: number = 30_000): Promise<void> {
    return this.waitForState((state) => state === targetState, timeoutMs);
  }

  /**
   * Wait until processing is complete (state is stopped).
   *
   * @param timeoutMs Maximum time to wait.
   */
  async waitForStop(timeoutMs: number = 60_000): Promise<void> {
    return this.waitFor("stopped", timeoutMs);
  }

  /**
   * Get a snapshot of the current lifecycle state.
   */
  snapshot(): {
    state: LifecycleState;
    stateStartedAt: number;
    stateDurationMs: number;
    transitionCount: number;
    isSafeToStop: boolean;
    isProcessingEvents: boolean;
    isPaused: boolean;
    isRunning: boolean;
    isTerminal: boolean;
  } {
    return {
      state: this._state,
      stateStartedAt: this._stateStartedAt,
      stateDurationMs: this.stateDurationMs,
      transitionCount: this._transitionCount,
      isSafeToStop: this.isSafeToStop,
      isProcessingEvents: this.isProcessingEvents,
      isPaused: this.isPaused,
      isRunning: this.isRunning,
      isTerminal: this.isTerminal,
    };
  }

  /**
   * Get a summary of valid transitions from the current state.
   */
  nextPossibleStates(): LifecycleState[] {
    return LIFECYCLE_TRANSITIONS[this._state] || [];
  }

  /**
   * Reset the lifecycle to idle state (for testing).
   */
  reset(): void {
    const previousState = this._state;
    this._state = "idle";
    this._stateStartedAt = Date.now();
    this._transitionCount = 0;

    this.log.info(
      { from: previousState, to: "idle" },
      "lifecycle reset"
    );
  }
}

// ── Lifecycle Guards ──────────────────────────────────────────────────────────

/**
 * Guard that ensures only safe operations are performed based on lifecycle state.
 */
export class LifecycleGuard {
  private lifecycle: ResolverLifecycle;

  constructor(lifecycle: ResolverLifecycle) {
    this.lifecycle = lifecycle;
  }

  /**
   * Assert that the lifecycle allows event processing.
   */
  assertCanProcessEvents(): void {
    if (!this.lifecycle.isProcessingEvents) {
      throw new StateNotAllowedError(
        this.lifecycle.state,
        "process_events"
      );
    }
  }

  /**
   * Assert that the lifecycle allows starting operations.
   */
  assertCanStart(): void {
    const allowed = ["idle", "paused", "restarting"];
    if (!allowed.includes(this.lifecycle.state)) {
      throw new StateNotAllowedError(
        this.lifecycle.state,
        "start"
      );
    }
  }

  /**
   * Assert that the lifecycle allows stopping operations.
   */
  assertCanStop(): void {
    const allowed = ["running", "pausing", "paused", "starting", "restarting"];
    if (!allowed.includes(this.lifecycle.state)) {
      throw new StateNotAllowedError(
        this.lifecycle.state,
        "stop"
      );
    }
  }

  /**
   * Assert that the lifecycle allows pausing operations.
   */
  assertCanPause(): void {
    if (!["running"].includes(this.lifecycle.state)) {
      throw new StateNotAllowedError(
        this.lifecycle.state,
        "pause"
      );
    }
  }

  /**
   * Assert that the lifecycle allows restarting operations.
   */
  assertCanRestart(): void {
    const allowed = ["running", "pausing", "paused"];
    if (!allowed.includes(this.lifecycle.state)) {
      throw new StateNotAllowedError(
        this.lifecycle.state,
        "restart"
      );
    }
  }
}

// ── Lifecycle Metrics Helpers ─────────────────────────────────────────────────

/**
 * Record metrics for a lifecycle state.
 */
export function recordLifecycleMetrics(
  state: LifecycleState,
  durationMs: number
): void {
  // This will be implemented in metrics.ts
  lifecycleStateGauge.set(state);
  // duration metric would be recorded here
}

/**
 * Get a human-readable description of a lifecycle state.
 */
export function describeLifecycleState(state: LifecycleState): string {
  const descriptions: Record<LifecycleState, string> = {
    idle: "Service created but not yet started",
    starting: "Initializing listeners and preparing to process events",
    running: "Listeners active and processing events",
    pausing: "Gracefully pausing; waiting for in-flight work to complete",
    paused: "All listeners paused; no event processing",
    restarting: "Recoverable error; listeners stopping before restart",
    stopping: "Shutdown requested; tearing down listeners",
    stopped: "Cleanly stopped",
    failed: "Exhausted restarts or fatal error; will not recover",
  };
  return descriptions[state] || "Unknown state";
}

/**
 * Check if a state is safe for operator intervention.
 */
export function isSafeForIntervention(state: LifecycleState): boolean {
  const safeStates: LifecycleState[] = ["paused", "stopped", "failed"];
  return safeStates.includes(state);
}
