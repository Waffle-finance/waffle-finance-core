# Resolver Operational Policy

This document describes how the WaffleFinance resolver behaves under partial
and total chain outages, and what operators should do in each degraded state.

---

## Chain health state machine

Each chain the resolver tracks goes through three states:

```
healthy  ──(failures ≥ degrade_threshold)──▶  degraded
  ▲                                               │
  │         (failures ≥ suspend_threshold)        ▼
  └─────────────────(success)──────────────── suspended
```

| State      | Meaning                                         |
|------------|-------------------------------------------------|
| `healthy`  | Chain is responding normally.                   |
| `degraded` | Failures are elevated but below suspend ceiling. |
| `suspended`| Consecutive failures reached the suspend threshold. Actions halted. |

Default thresholds (configurable via `ChainFallbackPolicy`):
- `degrade_threshold`: **2** consecutive failures
- `suspend_threshold`: **5** consecutive failures

---

## Per-state operator runbook

### `healthy` — no action needed

The resolver is polling and processing events normally. No intervention required.

---

### `degraded` — monitor closely

**What is happening:** One or more RPC calls have failed recently but the chain
has not yet been suspended. The resolver is retrying with exponential backoff.

**What to check:**
1. Look at `resolver_listener_errors_total{chain="<chain>"}` in Prometheus.
2. Check the resolver logs for `chain-fallback: <chain> → degraded`.
3. Verify the RPC endpoint is reachable: `curl <rpc_url>`.
4. Check for upstream network issues or provider maintenance windows.

**What the resolver is doing:**
- Continuing to listen and process events where possible.
- Retrying failed RPC calls with backoff scaled to the error type
  (`timeout` → short backoff, `unavailable` → long backoff).
- No actions are suppressed — claims and refunds proceed as normal.

**When to escalate:** If the chain stays in `degraded` for more than
`suspend_threshold - degrade_threshold` additional failures without recovering,
it will transition to `suspended` automatically.

---

### `suspended` — immediate operator attention required

**What is happening:** The resolver has seen `suspend_threshold` consecutive
failures on this chain without a single success. To prevent runaway retry
loops and to avoid submitting claims against an endpoint that cannot be
confirmed, **the resolver has halted all actions on this chain**.

**What the resolver is doing:**
- **Listener polling is paused** — no new events are fetched from this chain.
- **No claims or refunds are issued** — `canAct()` returns `false`.
- The other chains continue operating normally.
- The `/telemetry` endpoint reports `state: "degraded"` (at minimum).
- `resolver_listener_errors_total{chain="<chain>",error_type="poll_error"}` is incrementing.

**What to do (in order):**

1. **Verify the RPC endpoint:**
   ```
   curl -X POST <rpc_url> \
     -H 'Content-Type: application/json' \
     -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
   ```
   For Soroban:
   ```
   curl <rpc_url>/network
   ```

2. **Check for provider incidents** at the relevant status page
   (Alchemy / Infura / QuickNode / Stellar Foundation).

3. **Once the endpoint is confirmed healthy**, the resolver will auto-recover
   on the next successful poll — no manual restart is required.

4. **If the endpoint has permanently changed** (e.g. migration to a new
   provider), update `RESOLVER_ETH_RPC_URL` / `SOROBAN_RPC_URL` and restart
   the resolver process. The supervisor will restart listeners cleanly.

5. **Force a manual reset** (if the provider is healthy but the resolver
   hasn't recovered yet):
   ```
   # Send SIGHUP to trigger a graceful restart
   kill -HUP <pid>
   ```
   Or call `ChainFallbackPolicy.forceReset("<chain>")` via the admin API if
   one is wired up.

**Do NOT:**
- Restart the pod in a tight loop — the supervisor already has capped backoff.
- Lower the suspend threshold below 3 — this causes false suspensions on
  transient blips.

---

## Partial chain failure (one chain down, others healthy)

When chain A is suspended and chain B is healthy:

- The resolver **continues observing and acting on chain B** as normal.
- Events on chain A that arrive during the suspension window **will be missed**
  unless the chain's event history is replayed on recovery.
- For Soroban: the cursor-based polling means events are NOT missed if the
  outage is within the RPC node's retention window (~7 days on most providers).
  On recovery the listener resumes from the last persisted cursor.
- For Ethereum: viem's `watchEvent` subscription is torn down and restarted by
  the supervisor. Events during the outage window may require a historical
  backfill if the provider does not replay missed subscription events.

---

## Total chain failure (all chains suspended)

When all configured chains are suspended:

- The resolver enters `state: "degraded"` on `/telemetry`.
- No claims or refunds are issued.
- The supervisor does NOT exit — it waits for the chains to recover.
- The `/readyz` endpoint returns `503` (supervisor state is still `running`
  but telemetry is degraded).

**Operator action:** Follow the `suspended` runbook for each chain. Coordinate
with the team to confirm whether the outage is provider-side or network-wide.
Consider pausing new order announcements on the coordinator until at least one
chain recovers.

---

## Metrics reference

| Metric | Meaning |
|--------|---------|
| `resolver_listener_errors_total{chain,error_type}` | Cumulative listener errors by type |
| `resolver_listener_poll_runs_total{chain,result}` | Poll run outcomes (success/failure) |
| `resolver_listener_last_event_timestamp_seconds{chain}` | Age of last received event |
| `resolver_runtime_state_info{state}` | Current runtime state (1 = active) |
| `resolver_active_listeners{chain}` | Whether listener is active (1/0) |

Suggested alerting rules:
- Alert when `resolver_listener_last_event_timestamp_seconds` age exceeds 5 minutes on any chain.
- Alert when `resolver_runtime_state_info{state="suspended"} == 1`.
- Alert when `resolver_listener_errors_total` rate exceeds 1/min for 5 minutes.

---

## Retry and backoff reference

RPC errors are classified before applying backoff so the delay is proportional
to the severity:

| Error class    | Base delay multiplier | Typical scenarios |
|----------------|-----------------------|-------------------|
| `timeout`      | ×0.5                  | Read timeout, ETIMEDOUT |
| `partial`      | ×0.5                  | Malformed JSON, truncated response |
| `reset`        | ×0.75                 | ECONNRESET, socket hang up |
| `transient`    | ×1.0                  | Tagged TransientError |
| `unknown`      | ×1.0                  | Unclassified errors |
| `unavailable`  | ×1.5                  | ECONNREFUSED, 503 |
| `rate_limited` | ×2.0                  | HTTP 429, "too many requests" |

With the default base of 1 000 ms and a cap of 30 000 ms, a rate-limited
endpoint will see delays of approximately 2 s → 4 s → 8 s → 16 s → 30 s
across five attempts before the supervisor considers a restart.
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
