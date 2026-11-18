# Idempotency Tracking Implementation Summary

This document summarizes the idempotency tracking system added to prevent duplicate transaction submissions in relayer recovery operations.

## Overview

The idempotency system prevents duplicate transactions and ensures safe recovery after crashes by tracking actions with a composite key (orderId + actionType) and maintaining state persistence across restarts.

## Problem Addressed

### Issue
Recovery operations (claims, refunds) can be retried due to:
- Network timeouts causing failed submissions
- Process restarts mid-operation
- Event re-delivery from chain listeners
- Operator-initiated recovery

Without proper tracking, retries can:
- Submit duplicate transactions to the chain
- Process the same order twice
- Create overfunding or incorrect state
- Confuse operators with duplicate logs

### Solution
The idempotency system provides:
1. **In-memory deduplication** within a process lifetime
2. **Persistent state** across restarts (disk-backed)
3. **Safe retry** for known network failures
4. **Recovery after crash** without duplicate submission

## Implementation Details

### Core Components

1. **IdempotencyManager**
   - Tracks actions by composite key (orderId + actionType)
   - Manages state transitions: pending → submitted → completed/failed
   - Provides retry safety assessment
   - Persists state to disk for crash recovery

2. **IdempotencyGuard**
   - Validates operations based on idempotency state
   - Provides assertions for safe operations
   - Throws IdempotencyError for invalid operations

3. **SettlementService Integration**
   - Uses IdempotencyManager for action tracking
   - CanAttempt() method checks if action can proceed
   - Automatic deduplication for duplicate calls

### State Machine

| State | Description | Can Retry |
|-------|-------------|-----------|
| `pending` | Attempt recorded, not yet submitted | ✅ Yes |
| `submitted` | Transaction submitted, waiting for receipt | ✅ Yes (if not mined) |
| `completed` | Successfully completed | ❌ No |
| `failed` | Permanently failed | ❌ No |
| `abandoned` | Abandoned by operator | ✅ Yes (if retries available) |

### Safe Retry Scenarios

1. **New action** - Always safe (first attempt)
2. **Pending submission** - Safe if retryCount < maxRetryCount
3. **Submitted, not mined** - Safe if within pending timeout
4. **Completed** - Never safe (already done)
5. **Failed** - Never safe (permanent failure)
6. **Abandoned** - Safe if retryCount < maxRetryCount

## Files Created

### Core Implementation
1. `relayer/src/idempotency.ts` - Main implementation with:
   - IdempotencyManager class
   - IdempotencyGuard class
   - IdempotentActionType enum
   - AttemptState enum
   - RecoveryContext type
   - Error types

### Tests
2. `relayer/test/idempotency.test.ts` - Comprehensive test suite covering:
   - Duplicate detection
   - State transitions
   - Retry validation
   - Recovery scenarios
   - Edge cases

### Documentation
3. `relayer/docs/idempotency.md` - Full documentation
4. `relayer/IDEMPOTENCY_QUICK_START.md` - Quick start guide
5. `relayer/IDEMPOTENCY_SUMMARY.md` - This file

### Configuration Updates
6. `relayer/package.json` - Added idempotency test script
7. `relayer/vitest.config.ts` - Added idempotency test config
8. `relayer/src/services/settlement-service.ts` - Integrated with IdempotencyManager

## Usage Examples

### Basic Pattern

```typescript
import { IdempotencyManager } from '../src/idempotency.js';

const manager = new IdempotencyManager();

// 1. Check if safe to attempt
if (!manager.canRetry('order-123', 'claim')) {
  const context = manager.getRecoveryContext('order-123', 'claim');
  log.warn('Cannot retry action', { reason: context.retryReason });
  return;
}

// 2. Record new attempt
const record = manager.record('order-123', 'claim', 'cid-abc');

// 3. Submit transaction
const txHash = await submitClaim();
manager.submitted('order-123', 'claim', txHash);

// 4. Complete after mined
await waitForReceipt(txHash);
manager.complete('order-123', 'claim', txHash, blockNumber);
```

### Recovery After Crash

```typescript
// At startup
const manager = new IdempotencyManager({ storageDir: '/path/to/store' });

// Load persisted state
const result = await manager.reconcile();

// Check for stale pending submissions
if (result.failed > 0) {
  log.warn('Marked stale actions as abandoned', { count: result.failed });
}

// Retry valid actions
const context = manager.getRecoveryContext('order-123', 'claim');
if (context.canRetry) {
  // Safe to retry
}
```

### With IdempotencyGuard

```typescript
const manager = new IdempotencyManager();
const guard = new IdempotencyGuard(manager);

try {
  guard.assertCanAttempt('order-123', 'claim');
  
  const record = manager.record('order-123', 'claim', 'cid-abc');
  
  const txHash = await submitClaim();
  manager.submitted('order-123', 'claim', txHash);
  
  await waitForReceipt(txHash);
  manager.complete('order-123', 'claim', '0xhash1', blockNumber);
  
} catch (err) {
  if (err instanceof IdempotencyError) {
    log.warn('Idempotency error', { reason: err.message });
  }
}
```

## Configuration

```typescript
const manager = new IdempotencyManager({
  storageDir: '/path/to/store',      // Default: .idempotency-store
  maxRetryCount: 10,                  // Default: 10
  pendingTimeoutMs: 15 * 60 * 1000,  // Default: 15 min
});
```

## Testing

### Run Tests

```bash
pnpm --filter @wafflefinance/relayer test idempotency
```

### Test Coverage

- ✅ Duplicate detection
- ✅ State transitions (pending → submitted → completed/failed)
- ✅ Retry validation (canRetry)
- ✅ Recovery scenarios (crash, network timeout)
- ✅ Edge cases (concurrent attempts, many orders, all action types)

## Integration with Existing Code

### SettlementService

```typescript
// Before: No idempotency tracking
await svc.settle({
  orderId: 'order-123',
  action: async () => { /* claim */ },
});

// After: With idempotency tracking
const idempotencyManager = new IdempotencyManager();
const svc = new SettlementService({ idempotencyManager });

if (svc.canAttempt('order-123', 'claim')) {
  await svc.settle({
    orderId: 'order-123',
    action: async () => { /* claim */ },
  });
}
```

### Recovery Service

```typescript
// Before: Could submit duplicate transactions
for (const order of stuckOrders) {
  await executeRefund(order);
}

// After: Deduplication prevents duplicates
const manager = new IdempotencyManager();
const guard = new IdempotencyGuard(manager);

for (const order of stuckOrders) {
  try {
    guard.assertCanAttempt(order.id, 'refund');
    await executeRefund(order);
  } catch (err) {
    if (err instanceof IdempotencyError) {
      log.info('Skipping duplicate refund', { orderId: order.id });
    }
  }
}
```

## Acceptance Criteria Met

✅ **Duplicate relayer actions are harmless or safely deduplicated**
- Composite key (orderId + actionType) ensures uniqueness
- State transitions prevent duplicate submissions
- IdempotencyGuard validates before operations

✅ **Crashed or retried recovery operations do not create inconsistent chain outcomes**
- State persistence across restarts
- Stale pending submissions marked as abandoned
- Retry safety assessment prevents unsafe retries
- Complete state prevents re-processing

## Benefits

### Operational Safety
1. **No duplicate transactions** - Deduplication prevents this
2. **No double processing** - State machine ensures single execution
3. **Clear state model** - Operators know what's happening

### Developer Experience
1. **Easy to use** - Simple API for tracking actions
2. **Type-safe** - TypeScript enforces valid states
3. **Well-tested** - Comprehensive test coverage

### Reliability
1. **Crash recovery** - State persisted to disk
2. **Network timeouts** - Safe retry assessment
3. **No data loss** - Stale pending submissions abandoned after timeout

## Migration Guide

### For Operators
**Before:** No idempotency tracking - duplicates possible

**After:** Idempotency tracking prevents duplicates
- Check `canRetry()` before each attempt
- Record attempts with `record()`
- Complete after success with `complete()`

### For Developers

**Before:**
```typescript
await svc.settle({
  orderId: 'order-123',
  action: async () => { /* claim */ },
});
```

**After:**
```typescript
const manager = new IdempotencyManager();
const svc = new SettlementService({ idempotencyManager: manager });

if (svc.canAttempt('order-123', 'claim')) {
  await svc.settle({
    orderId: 'order-123',
    action: async () => { /* claim */ },
  });
}
```

## Best Practices

1. **Always check before attempting**
   ```typescript
   if (!manager.canRetry(orderId, actionType)) {
     return; // Skip - already done or failed
   }
   ```

2. **Record attempts before action**
   ```typescript
   const record = manager.record(orderId, actionType, correlationId);
   ```

3. **Complete after success**
   ```typescript
   manager.complete(orderId, actionType, txHash, blockNumber);
   ```

4. **Clean up after completion**
   ```typescript
   manager.remove(orderId, actionType);
   ```

5. **Reconcile on startup**
   ```typescript
   const result = await manager.reconcile();
   if (result.failed > 0) {
     log.warn('Marked stale actions as abandoned', { count: result.failed });
   }
   ```

## Troubleshooting

### Problem: Duplicate Transactions Still Occurring

**Check:**
1. Is `canRetry()` being called before each attempt?
2. Is `record()` being called before each attempt?
3. Is `complete()` being called after success?

### Problem: Recovery Not Finding Pending Transactions

**Check:**
1. Is `storageDir` configured?
2. Is `reconcile()` called at startup?
3. Are records being persisted?

### Problem: Stale Pending Transactions Not Being Abandoned

**Check:**
1. Is `pendingTimeoutMs` set appropriately?
2. Is `reconcile()` called regularly?

## Future Enhancements

Potential future additions:
1. **Redis-based deduplication** for distributed systems
2. **Webhook notifications** for state changes
3. **State change history** for audit trails
4. **Metrics dashboard** for monitoring retries

## Related Documentation

- [Idempotency Documentation](./docs/idempotency.md)
- [Idempotency Quick Start](./IDEMPOTENCY_QUICK_START.md)
- [Relayer README](../README.md)
- [Settlement Service](../src/services/settlement-service.ts)
