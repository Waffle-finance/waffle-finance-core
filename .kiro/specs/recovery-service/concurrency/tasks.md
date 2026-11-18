# Relayer Concurrency Control

## Summary

Define concurrency limits, batching rules, and job priorities for the relayer. Ensure live settlement orders take priority over stale order cleanup and recovery work.

## Requirements

### Functional

1. Define concurrency limits for different job types
2. Implement priority queues for job scheduling
3. Batch multiple orders into single operations where possible
4. Ensure live settlement priority over cleanup/recovery
5. Track and expose queue metrics

### Non-Functional

1. Service remains stable under increased order volume
2. No RPC endpoint overload
3. Graceful degradation under load

## Current Issues

1. **Unbounded parallelism**: No limits on concurrent operations
2. **No priority**: All jobs treated equally
3. **No batching**: Individual operations instead of batches
4. **No metrics**: Queue state not visible

## Design

### Job Priority Levels

```
Priority 0 (Critical):    Live settlement - orders in active settlement window
Priority 1 (High):        Recovery - orders past timelock but within grace period
Priority 2 (Medium):      Cleanup - orphaned/abandoned orders
Priority 3 (Low):         Maintenance - batch operations, health checks
```

### Concurrency Control Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                  JobManagerService                           │
│  (Central job scheduling with priority and concurrency)      │
└───────────────────────────────────────┬──────────────────────┘
                                        │
        ┌───────────────────────────────┼───────────────────────────────┐
        ▼                               ▼                               ▼
┌─────────────────┐       ┌───────────────────┐       ┌───────────────────┐
│   PriorityQueues│       │  ConcurrencyLimiter│       │   JobMetrics      │
│   (Per Priority)│       │  (Global + PerJob) │       │   (Telemetry)     │
└────────┬────────┘       └────────┬──────────┘       └────────┬────────┘
         │                         │                          │
         └─────────────────────────┴──────────────────────────┘
                                      │
                                      ▼
                         ┌──────────────────────────┐
                         │  ThreadPoolExecutor      │
                         │  (Configurable workers)  │
                         └──────────────────────────┘
```

## Implementation Tasks

### Phase 1: Core Infrastructure - IN PROGRESS

- [ ] Create Priority Queue with job levels
- [ ] Create ConcurrencyLimiter
- [ ] Create JobManagerService
- [ ] Create ThreadPoolExecutor
- [ ] Add metrics collection

### Phase 2: Integration

- [ ] Update watchdog to use JobManager
- [ ] Update recovery to use JobManager
- [ ] Add job types for different operations

### Phase 3: Testing

- [ ] Tests for priority ordering
- [ ] Tests for concurrency limits
- [ ] Load tests under high volume

## Acceptance Criteria

| Criteria | Status |
|----------|--------|
| Relayer does not starve itself or overload RPC | |
| Queue remains stable under load | |
| Live settlement actions have priority | |

## Files to Create

```
relayer/src/services/job-manager/
├── index.ts
├── IJobManagerService.ts
├── PriorityQueue.ts
├── ConcurrencyLimiter.ts
├── JobManagerService.ts
└── ThreadPoolExecutor.ts

relayer/src/services/concurrency/
├── index.ts
└── metrics.ts

.kiro/specs/recovery-service/concurrency/
├── tasks.md
└── SPECIFICATION.md
```

## Status

**Phase 1 - In Progress**
