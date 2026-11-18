# Resolver Lifecycle

This document describes the explicit lifecycle state machine for the WaffleFinance resolver and how operators can reason about its state during maintenance and incident response.

## Overview

The resolver has an explicit lifecycle with well-defined states and safe transitions. This design ensures:

1. **Safety**: Only valid state transitions are allowed
2. **Visibility**: Operators can always determine the current state
3. **Recovery**: Clear paths exist for restarting, pausing, and stopping
4. **Operational Clarity**: State changes are logged and metrics are exposed

## Lifecycle States

| State | Description | When it occurs |
|-------|-------------|----------------|
| `idle` | Newly created, listeners not yet started | After instantiation, before first start |
| `starting` | Listeners initializing and starting | Between start() call and listeners active |
| `running` | Listeners active and processing events | Normal operation |
| `pausing` | Gracefully pausing; waiting for in-flight work | Pause requested, in-flight work draining |
| `paused` | All listeners paused; no event processing | After pausing completes |
| `restarting` | Recoverable error; listeners stopping before restart | After recoverable error |
| `stopping` | Shutdown requested; tearing down listeners | Shutdown signal received |
| `stopped` | Cleanly stopped via stop() or clean exit | After stopping completes |
| `failed` | Exhausted restarts or fatal error | After fatal error or max restarts exceeded |

## Safe Transitions

### State Machine

```
    +--------+
    |  idle  |
    +--------+
         |
         v
    +---------+
    | starting|
    +---------+
         |
    +----+----+
    |         |
    v         v
+---------+ +-------+
|running  | |stopping|
+---------+ +-------+
    |         |
+---+----+  + v     +
|pausing |  |stopped|
+---+----+  +-------+
    |
    v
+-------+
|paused |
+-------+
    |
    v
+----------+
|restarting|
+----------+
    |
    v
+---------+
|starting |
+---------+
```

### Valid Transitions

| From | To |
|------|-----|
| idle | starting |
| starting | running, stopping, failed |
| running | pausing, restarting, stopping, failed |
| pausing | paused, stopping |
| paused | restarting, stopping |
| restarting | starting, stopping, failed |
| stopping | stopped, failed |
| stopped | (terminal - no transitions) |
| failed | (terminal - no transitions) |

### Invalid Transitions

| From | To | Reason |
|------|-----|--------|
| idle → running | Must go through starting |
| idle → pausing | Cannot pause non-running |
| running → idle | No backward transition |
| stopped → starting | Must create new instance |
| failed → restarting | Cannot recover from failed |
| pausing → paused (already paused) | Duplicate transition |

## Operations

### Starting

```typescript
lifecycle.transition('starting');
await doStartupWork();
lifecycle.transition('running');
```

### Pausing (Graceful Pause)

```typescript
lifecycle.transition('pausing');
await drainInFlightWork();
lifecycle.transition('paused');
```

### Resuming

```typescript
lifecycle.transition('restarting');
lifecycle.transition('starting');
lifecycle.transition('running');
```

### Stopping

```typescript
lifecycle.transition('stopping');
await cleanup();
lifecycle.transition('stopped');
```

### Restarting (Recoverable Error)

```typescript
lifecycle.transition('restarting');
await stopListeners();
await startListeners();
lifecycle.transition('starting');
lifecycle.transition('running');
```

### Force Transition (Emergency)

```typescript
lifecycle.forceTransition('running', 'emergency override');
```

## API Reference

### ResolverLifecycle

```typescript
class ResolverLifecycle {
  // Current state
  readonly state: LifecycleState

  // Time when current state was entered (ms since epoch)
  readonly stateStartedAt: number

  // Number of transitions that have occurred
  readonly transitionCount: number

  // Duration spent in current state (ms)
  readonly stateDurationMs: number

  // Properties
  readonly isSafeToStop: boolean
  readonly isProcessingEvents: boolean
  readonly isPaused: boolean
  readonly isRunning: boolean
  readonly isTerminal: boolean

  // Methods
  transition(nextState: LifecycleState): void
  forceTransition(nextState: LifecycleState, reason: string): void
  waitForState(condition: (state: LifecycleState) => boolean, timeoutMs?: number): Promise<void>
  waitFor(targetState: LifecycleState, timeoutMs?: number): Promise<void>
  waitForStop(timeoutMs?: number): Promise<void>
  snapshot(): LifecycleSnapshot
  nextPossibleStates(): LifecycleState[]
  reset(): void
}
```

### LifecycleGuard

```typescript
class LifecycleGuard {
  constructor(lifecycle: ResolverLifecycle)

  assertCanProcessEvents(): void
  assertCanStart(): void
  assertCanStop(): void
  assertCanPause(): void
  assertCanRestart(): void
}
```

### Helper Functions

```typescript
describeLifecycleState(state: LifecycleState): string
isSafeForIntervention(state: LifecycleState): boolean
```

## Health Checks

The resolver exposes lifecycle state via health endpoints:

### GET /health

```json
{
  "status": "healthy|degraded|stopping|unhealthy",
  "lifecycleState": "running",
  "supervisorState": "running",
  "restarts": 0,
  "uptimeSeconds": 3600,
  "checks": [...]
}
```

### GET /readyz

Returns 503 when:
- Any dependency check fails
- Lifecycle is `stopping`, `stopped`, or `failed`

### GET /telemetry

Reports resolver runtime telemetry including lifecycle state.

## Metrics

### resolver_lifecycle_state{state}

Gauge showing current lifecycle state. Exactly one state has value `1`, all others `0`.

```prometheus
resolver_lifecycle_state{state="running"} 1
resolver_lifecycle_state{state="idle"} 0
resolver_lifecycle_state{state="stopping"} 0
# ... etc
```

### resolver_lifecycle_transitions_total{from, to}

Counter for lifecycle state transitions.

```prometheus
resolver_lifecycle_transitions_total{from="idle", to="starting"} 1
resolver_lifecycle_transitions_total{from="starting", to="running"} 1
# ... etc
```

### resolver_lifecycle_duration_seconds{state}

Histogram for time spent in each lifecycle state.

```prometheus
resolver_lifecycle_duration_seconds{state="running"} 3600.5
resolver_lifecycle_duration_seconds{state="stopping"} 10.2
# ... etc
```

## Safety Guarantees

### No Unsafe Transitions

- Invalid state transitions throw `InvalidLifecycleTransitionError`
- State-specific operation restrictions throw `StateNotAllowedError`
- Transitions are validated before applying

### Idempotent Operations

- `stop()` is idempotent and safe to call from any state
- `forceTransition()` is idempotent but should be used sparingly

### Graceful Shutdown

- Pause allows in-flight work to complete before stopping
- Stop tears down listeners cleanly
- ForceExit timer prevents indefinite hangs

## Operational Guidance

### During Maintenance

1. **Pause before maintenance** (if supported):
   ```bash
   curl -X POST http://localhost:3003/api/pause
   ```

2. **Verify paused state**:
   ```bash
   curl http://localhost:3003/health
   ```

3. **Perform maintenance**

4. **Resume**:
   ```bash
   curl -X POST http://localhost:3003/api/resume
   ```

### During Incident Response

1. **Check current state**:
   ```bash
   curl http://localhost:3003/health
   ```

2. **Determine safe intervention**:
   - `paused`, `stopped`, `failed`: Safe to干预
   - `running`, `starting`, `restarting`: Not safe for intervention

3. **If intervention needed**:
   ```bash
   # Force stop if needed
   curl -X POST http://localhost:3003/api/stop
   ```

### For Operators

- **Idle**: Service created, ready to start
- **Starting**: Initializing, wait for running
- **Running**: Normal operation
- **Pausing**: Drain in-flight work, will pause
- **Paused**: All paused, can intervene
- **Restarting**: Recoverable error, will resume
- **Stopping**: Shutdown in progress
- **Stopped**: Cleanly stopped, safe to restart
- **Failed**: Fatal error, new instance required

## Testing

Run lifecycle tests:

```bash
pnpm --filter @wafflefinance/resolver test lifecycle
```

Test coverage includes:
- All valid transitions
- All invalid transitions
- State properties
- Guard assertions
- Force transitions
- Reset functionality

## Examples

### Example 1: Normal Startup

```typescript
const lifecycle = new ResolverLifecycle(log);

lifecycle.transition('starting');
log.info('Starting listeners...');

await startListeners();

lifecycle.transition('running');
log.info('All listeners running');
```

### Example 2: Graceful Pause and Resume

```typescript
// Pause
lifecycle.transition('pausing');
await drainInFlightWork();
lifecycle.transition('paused');
log.info('All listeners paused');

// Resume
lifecycle.transition('restarting');
await startListeners();
lifecycle.transition('starting');
lifecycle.transition('running');
log.info('All listeners resumed');
```

### Example 3: Recovery from Error

```typescript
try {
  await processEvent(event);
} catch (err) {
  if (isRecoverable(err)) {
    lifecycle.transition('restarting');
    log.warn('Recoverable error, restarting listeners');
    await stopListeners();
    await startListeners();
    lifecycle.transition('starting');
    lifecycle.transition('running');
  } else {
    lifecycle.forceTransition('failed', 'fatal error');
    log.error('Fatal error, shutting down');
    process.exit(1);
  }
}
```

### Example 4: Shutdown

```typescript
process.on('SIGTERM', async () => {
  log.info('SIGTERM received, initiating shutdown');
  
  lifecycle.transition('stopping');
  
  await Promise.all([
    stopListeners(),
    stopMetricsServer(),
    stopHealthServer(),
  ]);
  
  lifecycle.transition('stopped');
  log.info('Resolver stopped cleanly');
  process.exit(0);
});
```

## Related Documentation

- [Resolver README](../README.md)
- [Health Checks](./health-checks.md)
- [Supervisor](./supervisor.md)

## Restart and Recovery Behavior

The supervisor (`src/supervisor.ts`) restarts listeners on recoverable errors
with exponential backoff and exits when recovery is no longer possible.
Defaults (constructor options, also hardwired in `src/commands/run.ts`):

- `maxRestarts = 5`
- `restartDelayMs = 5_000`
- `maxRestartDelayMs = 60_000`
- Backoff: `delay = min(restartDelayMs * 2^(restartCount - 1), maxRestartDelayMs)`
- A `FatalError` never retries — the supervisor transitions to `failed` immediately.
- When `restartCount > maxRestarts`, the supervisor transitions to `failed`
  and throws `Supervisor: max restarts exceeded`, which makes the process exit
  non-zero (`run.ts`). `failed` and `stopped` are terminal: a new process
  instance is required. `stop()` is idempotent and cancels a pending
  restart-delay sleep so shutdown is not delayed.

Lifecycle metrics for alerting (`src/metrics.ts`):

- `resolver_lifecycle_state{state}` — gauge, exactly one state is `1`.
- `resolver_lifecycle_transitions_total{from,to}` — counter.
- `resolver_lifecycle_duration_seconds{state}` — histogram.

Health signals (`src/health.ts`, `GET /health`, `GET /readyz`, `GET /healthz`;
ports `RESOLVER_HEALTH_PORT` default `3003`, `RESOLVER_METRICS_PORT` default
`3002`):

- `/health` returns `503` when the lifecycle state is `failed`; `readyz`
  returns `503` when the state is `stopping`, `stopped`, or `failed`, or when
  any dependency check fails.

### Recovery table

| Case | Lifecycle state | Health signal | Operator action |
|------|----------------|---------------|-----------------|
| Transient listener failure (recoverable error, restarts remaining) | `restarting` (returns to `running`) | `/health` `200` (`healthy`/`degraded`), `restarts` incremented | No action. Automatic retry with backoff; monitor `resolver_lifecycle_transitions_total` and restart count. |
| Exhausted retries or fatal error | `failed` (terminal) | `/health` `503`, `/readyz` `503` | Manual restart required: fix the underlying cause (see logs for `max restarts exceeded` or `fatal listener error`), then start a new process instance. |
| Gracefully paused | `paused` (via `pausing`) | `/health` reflects paused lifecycle state | No restart needed. Resume via the configured resume path, or `stop()` then start a new instance if shutdown is intended. |
| Cleanly stopped | `stopped` (terminal) | `/readyz` `503` | No recovery needed if shutdown was intentional. Otherwise start a new process instance. |

Related configuration: restart limits are code defaults (`SupervisorOptions`
`maxRestarts` / `restartDelayMs` / `maxRestartDelayMs`); health/metrics ports
via `RESOLVER_HEALTH_PORT` / `RESOLVER_METRICS_PORT`; polling and chain
settings via the standard resolver config (`NETWORK_MODE`, RPC URLs, keys,
`pollIntervalMs`, see `packages/config`).
