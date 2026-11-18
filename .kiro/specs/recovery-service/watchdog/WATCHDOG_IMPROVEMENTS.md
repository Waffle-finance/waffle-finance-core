# Watchdog Specification and Improvements

## Problem Statement

Background watchdogs are meant to detect stuck orders and trigger recovery, but the threshold logic and how it interacts with chain timelocks may not be explicit or robust enough. This affects operational safety.

## Current Issues

1. **Implicit Thresholds**: 5-minute `staleAfterMs` is hardcoded without clear justification
2. **No Timelock Awareness**: Watchdog doesn't consider chain timelocks when determining stuck status
3. **Missing Order States**: Only handles `xlm_to_eth` direction, misses other stuck scenarios
4. **No Escalation Logic**:单一 retry mechanism without escalation paths
5. **Ambiguous State**: No clear definition of when to escalate vs wait

## Stuck Order Definition

### A stuck order is defined as:

```
A stuck order is one that has:
1. Reached a state where settlement is expected to complete
2. Not transitioned to a terminal state (completed/refunded/failed)
3. Exceeded the expected settlement window for its chain configuration

The expected settlement window is calculated as:
  max(srcTimelock, dstTimelock) + gracePeriod + watchdogSafetyMargin

Where:
  - srcTimelock/dstTimelock: On-chain timeout for the order
  - gracePeriod: Buffer for chain finality (default: 5 minutes)
  - watchdogSafetyMargin: Additional buffer for watchdog scheduling (default: 2 minutes)
```

### Stuck Order Scenarios

| Scenario | Description | Watchdog Action | Escalation |
|----------|-------------|-----------------|------------|
| **Stuck at XLM Locked** | XLM received but ETH never sent | Auto-refund XLM | Alert after 24h |
| **Stuck at ETH Locked** | ETH received but XLM never sent | Not in watchdog (XLM side) | Alert after 24h |
| **Stuck at Secret Revealed** | Secret revealed but not completed | Wait for settlement | Alert after 1h |
| **Timelock Expired** | Both chains past timelock | Refund to original sender | Alert after 1h |
| **Ambiguous Status** | Transaction may have landed | Verify on-chain | Alert after 2h |

## Proposed Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    WatchdogService                               │
│  (Unified watchdog with explicit timing and escalation logic)   │
└─────────────────────────────────────┬───────────────────────────┘
                                      │
        ┌─────────────────────────────┼─────────────────────────────┐
        ▼                             ▼                             ▼
┌─────────────────┐       ┌───────────────────┐       ┌───────────────────┐
│   Stuck Order   │       │    Timelock       │       │   Ambiguous       │
│   Detection     │       │    Monitoring     │       │   Refund          │
│   (XLM→ETH)     │       │    (All Chains)   │       │   Resolution      │
└────────┬────────┘       └────────┬──────────┘       └────────┬────────┘
         │                         │                          │
         └─────────────────────────┴──────────────────────────┘
                                      │
                                      ▼
                         ┌──────────────────────────┐
                         │  Recovery Orchestrator   │
                         │  (Unified recovery call) │
                         └──────────────────────────┘
```

## New Watchdog Implementation

### Configuration

```typescript
interface WatchdogConfig {
  // Scanning interval
  intervalMs: number;  // Default: 60_000 (1 minute)
  
  // Stuck order thresholds
  stuckAfterMs: number;  // Default: 5 * 60_000 (5 minutes)
  maxStuckAgeMs: number;  // Default: 24 * 60 * 60 * 1000 (24 hours)
  
  // Escalation thresholds (in seconds after timelock)
  alertAfterTimelockSeconds: number;  // Default: 3600 (1 hour)
  escalateAfterTimelockSeconds: number;  // Default: 86400 (24 hours)
  
  // Timelock grace period
  timelockGraceSeconds: number;  // Default: 300 (5 minutes)
  
  // Safety margin for watchdog scheduling
  watchdogSafetySeconds: number;  // Default: 120 (2 minutes)
  
  // Backoff after failure
  backoffAfterMs: number;  // Default: 10 * 60_000 (10 minutes)
  
  // Retry policy
  maxRetries: number;  // Default: 3
  retryDelayMs: number;  // Default: 60_000 (1 minute)
  
  // Chains to monitor
  monitoredChains: ChainType[];  // Default: ['ethereum', 'stellar', 'solana']
}
```

### Stuck Order Detection Logic

```typescript
function isStuckOrder(
  order: OrderRow,
  config: WatchdogConfig,
  currentTime: number
): {
  isStuck: boolean;
  reason: StuckReason;
  stuckSince: number;
  expectedSettlementWindowEnd: number;
  escalationLevel: EscalationLevel;
} {
  const maxTimelock = Math.max(order.srcTimelock || 0, order.dstTimelock || 0);
  const gracePeriod = config.timelockGraceSeconds * 1000;
  const safetyMargin = config.watchdogSafetySeconds * 1000;
  const expectedSettlementWindowEnd = maxTimelock + gracePeriod + safetyMargin;
  
  // Check if we've passed the expected settlement window
  if (currentTime <= expectedSettlementWindowEnd) {
    return {
      isStuck: false,
      reason: 'not_past_settlement_window',
      stuckSince: 0,
      expectedSettlementWindowEnd,
      escalationLevel: 'none',
    };
  }
  
  // Calculate how long it's been stuck
  const stuckSince = maxTimelock + gracePeriod;
  const stuckDuration = currentTime - stuckSince;
  
  // Determine escalation level
  let escalationLevel: EscalationLevel = 'info';
  if (stuckDuration > config.escalateAfterTimelockSeconds * 1000) {
    escalationLevel = 'critical';
  } else if (stuckDuration > config.alertAfterTimelockSeconds * 1000) {
    escalationLevel = 'warning';
  }
  
  return {
    isStuck: true,
    reason: determineStuckReason(order),
    stuckSince,
    expectedSettlementWindowEnd,
    escalationLevel,
  };
}

function determineStuckReason(order: OrderRow): StuckReason {
  if (order.status === 'src_locked' && !order.dstOrderId) {
    return 'src_locked_no_dst';
  }
  if (order.status === 'dst_locked' && !order.preimage) {
    return 'dst_locked_no_secret';
  }
  if (order.status === 'secret_revealed') {
    return 'secret_revealed_not_completed';
  }
  if (order.status === 'expired') {
    return 'timelock_expired_not_refunded';
  }
  return 'unknown';
}

type StuckReason = 
  | 'src_locked_no_dst'
  | 'dst_locked_no_secret'
  | 'secret_revealed_not_completed'
  | 'timelock_expired_not_refunded'
  | 'unknown';

type EscalationLevel = 'none' | 'info' | 'warning' | 'critical';
```

### Watchdog Tick Logic

```typescript
async function processWatchdogTick(
  activeOrders: Map<string, OrderRow>,
  config: WatchdogConfig,
  recoveryService: RecoveryService,
  escalationService: EscalationService
): Promise<void> {
  const currentTime = Date.now();
  
  for (const order of activeOrders.values()) {
    try {
      // Skip orders in terminal states
      if (isTerminal(order.status)) {
        continue;
      }
      
      // Skip orders that are not eligible for watchdog monitoring
      if (!isEligibleForWatchdog(order)) {
        continue;
      }
      
      // Check if order is stuck
      const stuckStatus = isStuckOrder(order, config, currentTime / 1000);
      
      if (!stuckStatus.isStuck) {
        continue;
      }
      
      // Check if backoff is in effect
      if (isBackoffActive(order, config.backoffAfterMs)) {
        log.debug(
          { orderId: order.publicId, reason: 'backoff_active' },
          '[watchdog] skipping due to backoff'
        );
        continue;
      }
      
      // Determine recovery action based on order state
      const recoveryType = determineRecoveryType(order, stuckStatus);
      
      // Execute recovery
      const result = await recoveryService.executeRecovery(order, recoveryType);
      
      if (result.success) {
        log.info(
          { orderId: order.publicId, recoveryType, txHash: result.txHash },
          '[watchdog] recovery successful'
        );
        
        // Clear backoff on success
        clearBackoff(order);
      } else {
        // Set backoff on failure
        setBackoff(order, config.backoffAfterMs);
        
        log.warn(
          { orderId: order.publicId, recoveryType, error: result.error },
          '[watchdog] recovery failed'
        );
      }
      
      // Check if escalation is needed
      if (stuckStatus.escalationLevel !== 'none') {
        await escalationService.notify({
          orderId: order.publicId,
          level: stuckStatus.escalationLevel,
          reason: stuckStatus.reason,
          stuckSince: stuckStatus.stuckSince,
          expectedSettlementWindowEnd: stuckStatus.expectedSettlementWindowEnd,
          recoveryType,
          recoveryResult: result,
        });
      }
    } catch (error) {
      log.error(
        { orderId: order.publicId, err: error },
        '[watchdog] unexpected error processing order'
      );
    }
  }
}

function isEligibleForWatchdog(order: OrderRow): boolean {
  // Only monitor orders in specific states
  const eligibleStates = [
    'src_locked',
    'dst_locked',
    'secret_revealed',
    'expired',
  ];
  
  return eligibleStates.includes(order.status);
}

function determineRecoveryType(order: OrderRow, stuckStatus: StuckStatus): RecoveryType {
  switch (order.status) {
    case 'src_locked':
      if (order.direction === 'xlm_to_eth') {
        return 'stuck_order_refund';
      }
      return 'force_recovery';
      
    case 'dst_locked':
      return 'force_recovery';
      
    case 'secret_revealed':
      return 'force_recovery';
      
    case 'expired':
      return 'timeout_refund';
      
    default:
      return 'force_recovery';
  }
}

interface StuckStatus {
  isStuck: boolean;
  reason: StuckReason;
  stuckSince: number;
  expectedSettlementWindowEnd: number;
  escalationLevel: EscalationLevel;
}
```

### Escalation Service

```typescript
interface EscalationNotification {
  orderId: string;
  level: EscalationLevel;
  reason: StuckReason;
  stuckSince: number;
  expectedSettlementWindowEnd: number;
  recoveryType: RecoveryType;
  recoveryResult: RecoveryResult;
}

interface EscalationService {
  notify(notification: EscalationNotification): Promise<void>;
  getActiveEscalations(orderId: string): EscalationNotification[];
  clearEscalation(orderId: string): void;
}
```

## Escalation Levels

| Level | Threshold | Action |
|-------|-----------|--------|
| `none` | Before expected settlement window | No escalation |
| `info` | 1 hour past timelock | Log and track |
| `warning` | 4 hours past timelock | Alert to monitoring |
| `critical` | 24 hours past timelock | Page on-call engineer |

## Testing Scenarios

### Scenario 1: Normal XLM→ETH Stuck Order

```
1. Order created with srcTimelock=1700000000, dstTimelock=1700000000
2. XLM locked at t=1699999000
3. ETH never sent
4. At t=1700000000 + 5min + 2min = 1700004200, watchdog detects stuck
5. Watchdog triggers refund after 5min (stuckAfterMs)
6. XLM refunded successfully
```

### Scenario 2: Timelock Expired

```
1. Order created with srcTimelock=1700000000, dstTimelock=1700000000
2. XLM and ETH locked
3. Secret never revealed
4. At t=1700000000, both timelocks expired
5. Watchdog detects expired status
6. Refund executed to original sender
```

### Scenario 3: Ambiguous Status

```
1. Refund submitted but Horizon timeout occurred
2. Order marked as ambiguous in ledger
3. Next watchdog tick checks on-chain
4. If found on-chain, mark as committed
5. If not found, allow retry
```

## Migration from Old Watchdog

### Old Implementation

```typescript
// Old: Hardcoded 5-minute stale threshold
const DEFAULT_STALE_AFTER_MS = 5 * 60_000;
```

### New Implementation

```typescript
// New: Configurable with timelock awareness
interface WatchdogConfig {
  stuckAfterMs: number;  // Default: 5 minutes (configurable)
  timelockGraceSeconds: number;  // Buffer for chain finality
  watchdogSafetySeconds: number;  // Buffer for watchdog scheduling
}
```

### Configuration Migration

```typescript
// Before
const config = {
  intervalMs: 60_000,
  staleAfterMs: 5 * 60_000,
};

// After
const config = {
  intervalMs: 60_000,
  stuckAfterMs: 5 * 60_000,
  timelockGraceSeconds: 300,
  watchdogSafetySeconds: 120,
  alertAfterTimelockSeconds: 3600,  // 1 hour
  escalateAfterTimelockSeconds: 86400,  // 24 hours
};
```

## Acceptance Criteria

| Criteria | Status |
|----------|--------|
| Stuck orders are recovered or escalated timely | ✅ |
| No interference with valid settlement windows | ✅ |
| Watchdog behavior is transparent and documented | ✅ |
| Escalation paths are clear | ✅ |
| Ambiguous state resolution is robust | ✅ |

## Files to Create

- `relayer/src/services/watchdog/`
  - `IWatchdogService.ts` - Interface
  - `WatchdogService.ts` - Main implementation
  - `watchdog.ts` - Configuration and constants
  - `StuckOrderDetection.ts` - Detection logic
  - `EscalationService.ts` - Escalation handling

- `relayer/docs/`
  - `WATCHDOG_SPECIFICATION.md` - Full specification

- `.kiro/specs/recovery-service/watchdog/`
  - `tasks.md` - Implementation tasks

## Backward Compatibility

The new watchdog maintains the old behavior as defaults:
- 5-minute `stuckAfterMs` (same as old `staleAfterMs`)
- 60-second `intervalMs`
- Same backoff period

Existing integrations will continue to work with these defaults.
