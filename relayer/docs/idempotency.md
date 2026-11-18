# Idempotency Tracking for Relayer Recovery

This document describes the idempotency system that prevents duplicate transaction submissions and ensures safe recovery after crashes.

## Problem Statement

Recovery operations (claims, refunds) can be retried due to:
- Network timeouts causing failed submissions
- Process restarts mid-operation
- Event re-delivery from chain listeners
- Operator-initiated recovery

Without idempotency tracking, retries can:
- Submit duplicate transactions to the chain
- Process the same order twice
- Create overfunding or incorrect state
- Confuse operators with duplicate logs

## Solution Overview

The idempotency system tracks actions by a composite key (orderId + actionType) and provides:

1. **In-memory deduplication** within a process lifetime
2. **Persistent state** across restarts (disk-backed)
3. **Safe retry** for known network failures
4. **Recovery after crash** without duplicate submission

## Key Components

### IdempotencyManager

Tracks idempotent actions with the following states:

| State | Description |
|-------|-------------|
| `pending` | Attempt recorded, not yet submitted |
| `submitted` | Transaction submitted, waiting for receipt |
| `completed` | Successfully completed |
| `failed` | Permanently failed |
| `abandoned` | Abandoned by operator |

### IdempotencyGuard

Validates operations based on idempotency state:
- `assertCanAttempt()` - Action can be attempted
- `assertCanRetry()` - Action can be retried
- `assertCompleted()` - Action has been completed
- `assertSubmitted()` - Action has been submitted

### Recovery Context

Provides safe retry assessment:
```typescript
{
  canRetry: boolean;
  retryReason: string;
  state: AttemptState;
  // ... other fields
}
```

## Usage

### Basic Usage

```typescript
import { IdempotencyManager } from '../src/idempotency.js';

const manager = new IdempotencyManager();

// Check if action was already attempted
const existing = manager.get('order-123', 'claim');

// Record new attempt
const record = manager.record('order-123', 'claim', 'cid-abc');

// Mark as submitted
manager.submitted('order-123', 'claim', '0xhash1');

// Mark as completed
manager.complete('order-123', 'claim', '0xhash1', 100);
```

### With IdempotencyGuard

```typescript
const manager = new IdempotencyManager();
const guard = new IdempotencyGuard(manager);

// Validate before attempting
guard.assertCanAttempt('order-123', 'claim');

// Validate before retrying
guard.assertCanRetry('order-123', 'claim');

// Validate completion
guard.assertCompleted('order-123', 'claim');
```

### Settlement Service Integration

```typescript
const svc = new SettlementService({ idempotencyManager: new IdempotencyManager() });

// Check if safe to attempt
if (svc.canAttempt('order-123', 'claim')) {
  // Safe to proceed
  await svc.settle({
    orderId: 'order-123',
    direction: 'xlm_to_eth',
    action: async () => {
      // Claim action
    },
  });
}
```

## Recovery After Crash

### Scenario: Process Restart During Submission

```typescript
// Before crash
manager.record('order-123', 'claim', 'cid-1');
manager.submitted('order-123', 'claim', '0xhash1');
// Process crashes before complete()

// After restart
await manager.reconcile(); // Loads persisted state

// Recovery context shows it's safe to retry
const context = manager.getRecoveryContext('order-123', 'claim');
// context.canRetry === true
// context.retryReason === 'Submission pending Xs, safe to retry'
```

### Scenario: Network Timeout

```typescript
// Attempt times out
manager.record('order-123', 'claim', 'cid-1');
manager.submitted('order-123', 'claim', '0xhash1');
// RPC timeout - tx may have been submitted

// Retry is safe
if (manager.canRetry('order-123', 'claim')) {
  // Check if tx was actually mined
  const receipt = await provider.getTransactionReceipt('0xhash1');
  if (receipt) {
    manager.complete('order-123', 'claim', '0xhash1', receipt.blockNumber);
  }
}
```

## Safe Retry Scenarios

### 1. New Action
- State: `pending`
- Retry: Always safe (first attempt)
- Reason: "No previous attempt found"

### 2. Pending Submission
- State: `pending`
- Retry: Safe if `retryCount < maxRetryCount`
- Reason: "Retry attempt X/Y"

### 3. Submitted, Not Mined
- State: `submitted` with no `minedBlock`
- Retry: Safe if within pending timeout
- Reason: "Submission pending Xs, safe to retry"

### 4. Completed
- State: `completed`
- Retry: **Never safe**
- Reason: "Action already completed successfully"

### 5. Failed
- State: `failed`
- Retry: **Never safe**
- Reason: "Action failed permanently"

### 6. Abandoned
- State: `abandoned`
- Retry: Safe if `retryCount < maxRetryCount`
- Reason: "Abandoned attempt, X/Y retries"

## Configuration

```typescript
const manager = new IdempotencyManager({
  storageDir: '/path/to/store',  // Default: .idempotency-store
  maxRetryCount: 10,             // Default: 10
  pendingTimeoutMs: 15 * 60 * 1000, // Default: 15 min
});
```

## Metrics

### Current State Counts

```typescript
const counts = manager.stateCounts();
// {
//   pending: 5,
//   submitted: 2,
//   completed: 100,
//   failed: 3,
//   abandoned: 1
// }
```

### By State

```typescript
const pending = manager.byState('pending');
// Array of pending records
```

### By Order ID

```typescript
const actions = manager.byOrderId('order-123');
// All actions for this order
```

## Testing

### Unit Tests

Run tests:
```bash
pnpm --filter @wafflefinance/relayer test idempotency
```

Test coverage includes:
- Duplicate detection
- State transitions
- Retry validation
- Recovery scenarios
- Edge cases

### Integration Test Example

```typescript
it('prevents duplicate claim on same order', async () => {
  const manager = new IdempotencyManager({ storageDir: null });

  // First claim
  manager.record('order-123', 'claim', 'cid-1');
  manager.complete('order-123', 'claim', '0xhash1', 100);

  // Second claim attempt
  expect(() => manager.record('order-123', 'claim', 'cid-2')).toThrow(
    'ALREADY_COMPLETED',
  );
});
```

## Files

1. `relayer/src/idempotency.ts` - Core implementation
2. `relayer/test/idempotency.test.ts` - Test suite

## Best Practices

1. **Always check before attempting**
   ```typescript
   if (!manager.canRetry(orderId, actionType)) {
     log.warn('Cannot retry action', { orderId, reason });
     return;
   }
   ```

2. **Record attempts before action**
   ```typescript
   const record = manager.record(orderId, 'claim', correlationId);
   try {
     // Execute action
   } catch (err) {
     manager.fail(orderId, 'claim', err.message);
   }
   ```

3. **Complete after success**
   ```typescript
   manager.record(orderId, 'claim', correlationId);
   const txHash = await executeClaim();
   manager.submitted(orderId, 'claim', txHash);
   // Wait for receipt
   manager.complete(orderId, 'claim', txHash, blockNumber);
   ```

4. **Reconcile on startup**
   ```typescript
   const result = await manager.reconcile();
   if (result.failed > 0) {
     log.warn('Recovery marked some actions as abandoned', result);
   }
   ```

5. **Clean up completed actions**
   ```typescript
   manager.complete(orderId, 'claim', txHash, blockNumber);
   // After sufficient confirmations
   manager.remove(orderId, 'claim');
   ```

## Recovery Workflow

```
1. Process starts
   ↓
2. manager.reconcile() loads persisted state
   ↓
3. Stale pending/submitted marked abandoned
   ↓
4. Valid records available for retry
   ↓
5. Guard.validate() checks canRetry
   ↓
6. If safe, retry action
   ↓
7. Update state (submitted → completed)
   ↓
8. Cleanup after success
```

## Related Documentation

- [Relayer README](../README.md)
- [Settlement Service](./settlement-service.md)
- [Tx State Store](./tx-state-store.md)
