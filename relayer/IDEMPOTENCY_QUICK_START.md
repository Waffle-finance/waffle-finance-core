# Idempotency Tracking - Quick Start

This guide helps you understand and use the idempotency system for relayer recovery operations.

## What This Solves

### Problem
Recovery operations can be retried due to network timeouts, process restarts, or event re-delivery. Without idempotency tracking, this can:
- Submit duplicate transactions
- Process the same order twice
- Create overfunding or incorrect state

### Solution
The idempotency system tracks actions by `(orderId, actionType)` and provides:
- In-memory deduplication within a process lifetime
- Persistent state across restarts (disk-backed)
- Safe retry for known network failures
- Recovery after crash without duplicate submission

## Key Concepts

### Composite Key
Actions are tracked by a key combining orderId and actionType:
```typescript
key = `${orderId}:${actionType}`  // e.g., "order-123:claim"
```

### State Machine
Actions progress through states:
1. `pending` → Recorded, not yet submitted
2. `submitted` → Transaction broadcast, waiting for receipt
3. `completed` → Transaction mined and processed successfully
4. `failed` → Permanently failed
5. `abandoned` → Abandoned by operator

### Retry Safety
Not all states allow retries:
- ✅ **Can retry**: `pending`, `submitted` (if not mined), `abandoned`
- ❌ **Cannot retry**: `completed`, `failed`

## Quick Usage

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

### With Guard

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

## Configuration

```typescript
const manager = new IdempotencyManager({
  storageDir: '/var/lib/wafflefinance/idempotency', // Default: .idempotency-store
  maxRetryCount: 10,  // Default: 10
  pendingTimeoutMs: 15 * 60 * 1000,  // Default: 15 min
});
```

## Common Scenarios

### 1. First Attempt

```typescript
const manager = new IdempotencyManager();

// No previous attempt - safe to start
manager.canRetry('order-123', 'claim');  // true

const record = manager.record('order-123', 'claim', 'cid-1');
// record.state === 'pending'
```

### 2. Network Timeout (Retry)

```typescript
// First attempt times out
manager.record('order-123', 'claim', 'cid-1');
manager.submitted('order-123', 'claim', '0xhash1');
// Process crashes

// After restart
const manager = new IdempotencyManager({ storageDir: ... });
const context = manager.getRecoveryContext('order-123', 'claim');

// Safe to retry
context.canRetry;  // true
context.retryReason;  // "Submission pending Xs, safe to retry"
```

### 3. Completed Action (No Retry)

```typescript
manager.record('order-123', 'claim', 'cid-1');
manager.complete('order-123', 'claim', '0xhash1', 100);

// Second attempt blocked
manager.canRetry('order-123', 'claim');  // false
manager.getRecoveryContext('order-123', 'claim').retryReason;
// "Action already completed successfully"
```

### 4. Failed Action (No Retry)

```typescript
manager.record('order-123', 'claim', 'cid-1');
manager.fail('order-123', 'claim', 'insufficient funds', true);

// Cannot retry
manager.canRetry('order-123', 'claim');  // false
```

### 5. Abandoned Action (Can Retry)

```typescript
manager.record('order-123', 'claim', 'cid-1');
manager.fail('order-123', 'claim', 'manual abandon', false);  // false = not terminal

// Can retry
manager.canRetry('order-123', 'claim');  // true
```

## API Reference

### IdempotencyManager

```typescript
class IdempotencyManager {
  // Get existing record
  get(orderId: string, actionType: IdempotentActionType): IdempotentActionRecord | undefined

  // Check if action has been attempted
  hasAttempted(orderId: string, actionType: IdempotentActionType): boolean

  // Record new attempt
  record(
    orderId: string,
    actionType: IdempotentActionType,
    correlationId?: string,
    forceNew?: boolean
  ): IdempotentActionRecord

  // Mark as submitted
  submitted(orderId: string, actionType: IdempotentActionType, txHash: string): IdempotentActionRecord

  // Mark as completed
  complete(orderId: string, actionType: IdempotentActionType, txHash: string, minedBlock?: number): IdempotentActionRecord

  // Mark as failed
  fail(orderId: string, actionType: IdempotentActionType, reason: string, isTerminal: boolean): IdempotentActionRecord

  // Check if safe to retry
  canRetry(orderId: string, actionType: IdempotentActionType): boolean

  // Get recovery context
  getRecoveryContext(orderId: string, actionType: IdempotentActionType): RecoveryContext

  // Reconcile after restart
  reconcile(): Promise<ReconcileResult>

  // Get records by state
  byState(state: AttemptState): IdempotentActionRecord[]

  // Get records for an order
  byOrderId(orderId: string): IdempotentActionRecord[]

  // Get state counts
  stateCounts(): Record<AttemptState, number>

  // Remove a record
  remove(orderId: string, actionType: IdempotentActionType): void

  // Clear all records
  clear(): void
}
```

### IdempotencyGuard

```typescript
class IdempotencyGuard {
  constructor(manager: IdempotencyManager)

  // Assert action can be attempted
  assertCanAttempt(orderId: string, actionType: IdempotentActionType): void

  // Assert action can be retried
  assertCanRetry(orderId: string, actionType: IdempotentActionType): void

  // Assert action is completed
  assertCompleted(orderId: string, actionType: IdempotentActionType): void

  // Assert action is submitted
  assertSubmitted(orderId: string, actionType: IdempotentActionType): void
}
```

## Testing

### Run Tests

```bash
pnpm --filter @wafflefinance/relayer test idempotency
```

### Test Scenarios

```typescript
it('prevents duplicate claim', async () => {
  const manager = new IdempotencyManager({ storageDir: null });
  
  // Complete first claim
  manager.record('order-123', 'claim', 'cid-1');
  manager.complete('order-123', 'claim', '0xhash1', 100);
  
  // Second claim blocked
  expect(() => manager.record('order-123', 'claim', 'cid-2')).toThrow('ALREADY_COMPLETED');
});

it('allows retry after timeout', async () => {
  const manager = new IdempotencyManager({ storageDir: null });
  
  manager.record('order-123', 'claim', 'cid-1');
  manager.submitted('order-123', 'claim', '0xhash1');
  
  // Retry safe
  expect(manager.canRetry('order-123', 'claim')).toBe(true);
});

it('handles process restart', async () => {
  const tempDir = '/tmp/idempotency-test';
  const manager1 = new IdempotencyManager({ storageDir: tempDir });
  
  manager1.record('order-123', 'claim', 'cid-1');
  manager1.submitted('order-123', 'claim', '0xhash1');
  
  // Simulate restart
  const manager2 = new IdempotencyManager({ storageDir: tempDir });
  
  const record = manager2.get('order-123', 'claim');
  expect(record?.state).toBe('submitted');
  expect(record?.txHash).toBe('0xhash1');
  
  // Cleanup
  manager2.clear();
});
```

## Troubleshooting

### Problem: Duplicate Transactions Still Occurring

**Check:**
1. Is `canRetry()` being called before each attempt?
2. Is `record()` being called before each attempt?
3. Is `complete()` being called after success?

**Solution:**
```typescript
// Always check before attempting
if (!manager.canRetry(orderId, actionType)) {
  log.warn('Cannot retry action', { orderId, reason: manager.getRecoveryContext(orderId, actionType).retryReason });
  return;
}

// Always record before action
const record = manager.record(orderId, actionType, correlationId);
```

### Problem: Recovery Not Finding Pending Transactions

**Check:**
1. Is `storageDir` configured?
2. Is `reconcile()` called at startup?
3. Are records being persisted?

**Solution:**
```typescript
const manager = new IdempotencyManager({
  storageDir: '/path/to/store',  // Must be set for persistence
});

// Call reconcile at startup
await manager.reconcile();
```

### Problem: Stale Pending Transactions Not being Abandoned

**Check:**
1. Is `pendingTimeoutMs` set appropriately?
2. Is `reconcile()` called regularly?

**Solution:**
```typescript
const manager = new IdempotencyManager({
  pendingTimeoutMs: 15 * 60 * 1000,  // 15 minutes
});

// Call reconcile regularly (e.g., every 5 minutes)
setInterval(() => void manager.reconcile(), 5 * 60 * 1000);
```

## Best Practices

1. **Always check before attempting**
   ```typescript
   if (!manager.canRetry(orderId, actionType)) {
     const reason = manager.getRecoveryContext(orderId, actionType).retryReason;
     log.warn('Cannot retry action', { orderId, reason });
     return;
   }
   ```

2. **Record attempts before action**
   ```typescript
   const record = manager.record(orderId, actionType, correlationId);
   try {
     // Execute action
   } catch (err) {
     manager.fail(orderId, actionType, err.message, true);
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

4. **Clean up completed actions**
   ```typescript
   manager.complete(orderId, 'claim', txHash, blockNumber);
   // After sufficient confirmations
   manager.remove(orderId, 'claim');
   ```

5. **Monitor recovery**
   ```typescript
   const result = await manager.reconcile();
   if (result.failed > 0) {
     alert(`Marked ${result.failed} stale actions as abandoned`);
   }
   ```

## Related Documentation

- [Idempotency Documentation](./docs/idempotency.md)
- [Relayer README](../README.md)
- [Settlement Service](../src/services/settlement-service.ts)
