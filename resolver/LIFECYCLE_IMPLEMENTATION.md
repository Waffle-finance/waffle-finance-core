# Resolver Lifecycle Implementation

This document describes the explicit resolver lifecycle implementation and how it improves operational safety during startup and shutdown.

## Overview

The resolver now has an explicit lifecycle state machine that:

1. **Prevents invalid state transitions** - Only valid transitions are allowed
2. **Provides visibility** - Current state is always known
3. **Enables safe operations** - Operations are only allowed in appropriate states
4. **Supports operators** - Clear state model for incident response

## Key Changes

### 1. Lifecycle State Machine

**New States:**
- `idle` - Service created but not yet started
- `starting` - Listeners initializing
- `running` - Listeners active and processing
- `pausing` - Graceful pause in progress
- `paused` - All listeners paused
- `restarting` - Recoverable error; before restart
- `stopping` - Shutdown in progress
- `stopped` - Cleanly stopped
- `failed` - Fatal error; no recovery

**Previously Unavailable:**
- Pausing/resuming (for graceful pause)
- Explicit startup phase
- Better shutdown visibility

### 2. Safe Transitions

All transitions are validated:

```typescript
lifecycle.transition('running');  // OK
lifecycle.transition('failed');   // OK
lifecycle.transition('idle');     // Throws InvalidLifecycleTransitionError
```

### 3. LifecycleGuard

New guard class for operation validation:

```typescript
const guard = new LifecycleGuard(lifecycle);

// Throws if not in running state
guard.assertCanProcessEvents();

// Throws if not in safe start state
guard.assertCanStart();

// Throws if not in safe stop state
guard.assertCanStop();
```

### 4. Metrics

New Prometheus metrics:

```prometheus
# Current lifecycle state
resolver_lifecycle_state{state="running"} 1

# Transition counts
resolver_lifecycle_transitions_total{from="idle", to="running"} 1

# Time spent in each state
resolver_lifecycle_duration_seconds{state="running"} 3600.5
```

## Files Created

1. `resolver/src/lifecycle.ts` - Core lifecycle implementation
2. `resolver/test/lifecycle.test.ts` - Comprehensive test suite
3. `resolver/docs/lifecycle.md` - Full documentation

## Integration with Existing Code

### Supervisor Integration

The supervisor now integrates with the lifecycle manager:

```typescript
const lifecycle = new ResolverLifecycle(log);
const supervisor = new Supervisor({
  log,
  lifecycle,
  maxRestarts: 5,
});

// Supervisor updates lifecycle on state changes
await supervisor.run(listeners);
```

### Health Integration

Health endpoints expose lifecycle state:

```json
{
  "status": "healthy",
  "lifecycleState": "running",
  "supervisorState": "running",
  "restarts": 0,
  "checks": [...]
}
```

## Usage Examples

### Normal Operation

```typescript
const lifecycle = new ResolverLifecycle(log);

// Start
lifecycle.transition('starting');
await startListeners();
lifecycle.transition('running');

// Stop
lifecycle.transition('stopping');
await stopListeners();
lifecycle.transition('stopped');
```

### Graceful Pause

```typescript
// Pause
lifecycle.transition('pausing');
await drainInFlightWork();
lifecycle.transition('paused');

// Resume
lifecycle.transition('restarting');
await startListeners();
lifecycle.transition('running');
```

### Recovery

```typescript
try {
  await processEvent(event);
} catch (err) {
  if (isRecoverable(err)) {
    lifecycle.transition('restarting');
    await stopListeners();
    await startListeners();
    lifecycle.transition('running');
  } else {
    lifecycle.transition('failed');
  }
}
```

## Testing

Run tests:

```bash
pnpm --filter @wafflefinance/resolver test lifecycle
```

Test coverage:

- All valid transitions
- All invalid transitions
- State properties
- Guard assertions
- Force transitions
- Reset functionality

## Benefits

### Operational Safety

1. **No invalid state changes** - Invalid transitions throw errors
2. **Operation validation** - Guard ensures operations are safe
3. **Clear state model** - Operators know what's happening

### Incident Response

1. **State visibility** - Always know current state
2. **Safe intervention** - Only intervene in safe states
3. **Recovery paths** - Clear paths to recover

### Development

1. **Clear state machine** - Easier to understand flow
2. **Type safety** - TypeScript enforces valid states
3. **Test coverage** - All transitions tested

## Migration Guide

### For Operators

**Before:** No explicit lifecycle state

**After:** Lifecycle state always available

- Check state: `GET /health`
- Pause: `lifecycle.transition('pausing')`
- Resume: `lifecycle.transition('restarting')`

### For Developers

**Before:** Supervisor tracked only basic states

**After:** Lifecycle manager tracks full state machine

```typescript
// Before
supervisor.state  // "running" | "stopping" | "failed" | ...

// After
lifecycle.state   // "idle" | "starting" | "running" | "pausing" | "paused" | ...
```

## Health Checks

### GET /health

Returns lifecycle state:

```json
{
  "status": "healthy|degraded|stopping|unhealthy",
  "lifecycleState": "running",
  "supervisorState": "running",
  "restarts": 0,
  "checks": [...]
}
```

### GET /readyz

Returns 503 when:

- Any dependency check fails
- Lifecycle is `stopping`, `stopped`, or `failed`

## Metrics

### resolver_lifecycle_state{state}

Gauge showing current lifecycle state.

```prometheus
resolver_lifecycle_state{state="running"} 1
resolver_lifecycle_state{state="idle"} 0
```

### resolver_lifecycle_transitions_total{from, to}

Counter for transitions.

```prometheus
resolver_lifecycle_transitions_total{from="idle", to="running"} 1
```

### resolver_lifecycle_duration_seconds{state}

Time spent in each state.

```prometheus
resolver_lifecycle_duration_seconds{state="running"} 3600.5
```

## Safety Guarantees

1. **No invalid transitions** - Throws `InvalidLifecycleTransitionError`
2. **Operation validation** - Throws `StateNotAllowedError`
3. **Idempotent operations** - Stop is safe to call multiple times
4. **Graceful shutdown** - Pausing allows in-flight work to complete

## Future Enhancements

Potential future additions:

1. **API endpoints** for pause/resume
2. **State change notifications** via WebSocket
3. **Custom state validation** rules
4. **State persistence** across restarts

## Related Documentation

- [Resolver README](../README.md)
- [Health Checks](./docs/health-checks.md)
- [Supervisor](./docs/supervisor.md)

## Testing

Run lifecycle tests:

```bash
pnpm --filter @wafflefinance/resolver test lifecycle
```
