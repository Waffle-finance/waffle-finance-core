# Recovery Service Migration Guide

This guide helps you migrate from the old scattered recovery implementation to the new centralized recovery service.

## Overview

**Before:** Recovery logic was scattered across multiple services with inconsistent behavior:
- `recovery-service.ts` - Mixed Ethereum/Stellar logic
- `refund-watchdog.ts` - Specialized for XLM→ETH refunds
- `xlm-refund.ts` - Low-level Stellar refund implementation

**After:** Single, unified service with consistent behavior across all chains:
- `RecoveryService` - Main orchestration entry point
- Chain-specific handlers (Ethereum, Stellar)
- Shared safety checks

## Migration Steps

### Step 1: Import the New Service

```typescript
// OLD
import { RecoveryService } from '../services/recovery-service.js';
import { startRefundWatchdog } from '../services/refund-watchdog.js';

// NEW
import { RecoveryService } from '../services/recovery/index.js';
```

### Step 2: Create Recovery Service Instance

```typescript
// OLD
const recoveryService = new RecoveryService(ordersService, eventManager, config);

// NEW
const recoveryService = new RecoveryService();
await recoveryService.start();
```

### Step 3: Update Recovery Calls

#### Old Pattern (Scattered)

```typescript
// In recovery-service.ts
if (order.srcChainId === 1) {
  await this.executeEthereumRefund(order);
}

if (order.dstChainId === 999) {
  await this.executeStellarRefund(order);
}
```

#### New Pattern (Unified)

```typescript
// Using RecoveryService
const result = await recoveryService.executeRecovery(order, 'timeout_refund');
```

### Step 4: Update Refund Watchdog

The refund watchdog is now a client of the recovery service:

```typescript
// OLD (in refund-watchdog.ts)
const refund = await refundXlmToUser({
  orderId,
  stellarAddress,
  stellarTxHash: order.stellarTxHash,
  networkMode: config.networkMode,
  horizonUrl: config.horizonUrl,
  refundSecret: config.refundSecret,
  fallbackStroops: order.amount,
  ledger,
});

// NEW (using RecoveryService)
const result = await recoveryService.executeRecoveryByChain(
  'stellar',
  order,
  'timeout_refund'
);

if (result.success) {
  // Handle successful refund
  order.status = 'refunded';
  order.refundTxHash = result.txHash;
  order.refundedAt = Date.now();
}
```

### Step 5: Update Timelock Monitoring

#### Old Pattern

```typescript
// In recovery-service.ts
if (currentTime > timelock + gracePeriod) {
  await this.initiateTimeoutRecovery(order);
}
```

#### New Pattern

```typescript
// Using RecoveryService
if (recoveryService.isOrderEligibleForAutoRecovery(order, currentTime)) {
  await recoveryService.executeRecovery(order, 'timeout_refund');
}
```

### Step 6: Update Safety Checks

#### Old Pattern (Duplicated)

```typescript
// Check if already refunded
if (order.status === 'refunded') {
  return;
}

// Check if already in refund ledger
const ledgerEntry = ledger.getEntry(orderId);
if (ledgerEntry?.state.phase === 'committed') {
  return;
}
```

#### New Pattern (Centralized)

```typescript
// Single safety check
const isDuplicate = await recoveryService.checkDuplicateRefund(order, 'stellar');
if (isDuplicate) {
  return;
}
```

## Chain-Specific Migration

### Ethereum

No special handling needed - the orchestrator automatically routes to `EthereumRecoveryHandler`.

### Stellar

The Stellar handler now includes:
- Ambiguous refund resolution (new feature)
- Enhanced safety checks
- Proper Horizon integration

```typescript
// For ambiguous refunds (Stellar-specific)
const result = await recoveryService.executeRecovery(
  order,
  'ambiguous_refund_resolution'
);
```

## Testing Updates

### Unit Tests

```typescript
// OLD
import { RecoveryService } from '../services/recovery-service.js';
import { refundXlmToUser } from '../services/xlm-refund.js';

// NEW
import { RecoveryService } from '../services/recovery/index.js';
```

### Integration Tests

Update to use the unified service interface:

```typescript
// Test auto-refund behavior
it('should auto-refund expired orders', async () => {
  const order = createTestOrder({
    status: 'expired',
    srcChain: 'ethereum',
    srcTimelock: Math.floor(Date.now() / 1000) - 3600, // 1 hour ago
  });
  
  // Mark order as eligible
  const service = new RecoveryService();
  await service.start();
  
  // Execute recovery
  const result = await service.executeRecovery(order, 'timeout_refund');
  
  expect(result.success).toBe(true);
  expect(result.chain).toBe('ethereum');
});
```

## Benefits of Migration

1. **Consistency**: Same decision logic across all chains
2. **Maintainability**: Single source of truth
3. **Safety**: Centralized safety checks prevent duplicate refunds
4. **Extensibility**: Easy to add new chain handlers
5. **Testability**: Clear interfaces for testing

## Migration Checklist

- [ ] Replace all direct references to `recovery-service.ts`
- [ ] Replace all direct calls to `refundXlmToUser`
- [ ] Update `refund-watchdog.ts` to use `RecoveryService`
- [ ] Update `order-service.ts` timelock expiry to use `RecoveryService`
- [ ] Update tests to use the new unified service
- [ ] Add safety checks for all recovery paths
- [ ] Verify no duplicate refunds in production
- [ ] Monitor recovery metrics

## Rollback Plan

If you need to rollback:

1. Keep the old `recovery-service.ts` in place
2. Update imports to use the old implementation
3. The new service is additive - it doesn't remove old functionality

```typescript
// To rollback, change import
// import { RecoveryService } from '../services/recovery/index.js';
import { RecoveryService } from '../services/recovery-service.js';
```

## Support

For questions or issues:
1. Check the [README](./recovery/README.md)
2. Review the [API documentation](./recovery/IRecoveryService.ts)
3. Examine test examples in `relayer/test/recovery/*.test.ts`
