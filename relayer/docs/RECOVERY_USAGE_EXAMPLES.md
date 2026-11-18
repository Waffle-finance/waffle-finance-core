# Recovery Service Usage Examples

This document provides practical examples of using the new centralized recovery service in various scenarios.

## Basic Recovery Example

### Scenario: Processing an expired order for refund

```typescript
import { RecoveryService } from '../services/recovery';
import type { OrderRow } from '../persistence/orders-repo';

async function processExpiredOrder(
  order: OrderRow,
  recoveryService: RecoveryService
): Promise<void> {
  // Check if order is eligible for automatic recovery
  const currentTime = Math.floor(Date.now() / 1000);
  if (!recoveryService.isOrderEligibleForAutoRecovery(order, currentTime)) {
    console.log('Order not eligible for recovery');
    return;
  }
  
  // Execute recovery (auto-detects chain)
  const result = await recoveryService.executeRecovery(order, 'timeout_refund');
  
  if (result.success) {
    // Update order status in database
    await updateOrderStatus(order.publicId, 'refunded', result.txHash);
    
    // Broadcast event
    eventManager.broadcast('order_refunded', {
      orderId: order.publicId,
      txHash: result.txHash,
      amount: result.amount,
    });
    
    console.log(`Refunded order ${order.publicId}: ${result.amount} via ${result.chain}`);
  } else {
    console.error(`Failed to refund order ${order.publicId}: ${result.error}`);
    
    // Record failure for monitoring
    failureStore.recordFailure({
      orderId: order.publicId,
      direction: order.direction,
      category: 'recovery_failed',
      errorMessage: result.error,
      chain: result.chain,
    });
  }
}
```

## Chain-Specific Recovery

### Scenario: Force refund on a specific chain

```typescript
import { RecoveryService } from '../services/recovery';

async function forceRefundOnEthereum(
  order: OrderRow,
  recoveryService: RecoveryService,
  reason: string
): Promise<void> {
  // Execute recovery on specific chain
  const result = await recoveryService.executeRecoveryByChain(
    'ethereum',
    order,
    'force_recovery'
  );
  
  if (result.success) {
    console.log(`Force refund completed on Ethereum: ${result.txHash}`);
  } else {
    console.error(`Force refund failed: ${result.error}`);
  }
}
```

## Safety Check Pattern

### Scenario: Verify no duplicate refund before executing

```typescript
import { RecoveryService } from '../services/recovery';

async function safeRefund(
  order: OrderRow,
  chain: string,
  recoveryService: RecoveryService
): Promise<void> {
  // Check for duplicate
  const isDuplicate = await recoveryService.checkDuplicateRefund(order, chain);
  if (isDuplicate) {
    console.log(`Refund already exists for ${order.publicId}`);
    return;
  }
  
  // Check balance capacity
  const hasCapacity = await recoveryService.checkBalanceCapacity(order, chain);
  if (!hasCapacity) {
    console.warn(`Insufficient balance for refund of ${order.publicId}`);
    return;
  }
  
  // Execute recovery
  const result = await recoveryService.executeRecovery(order, 'timeout_refund');
  
  if (result.success) {
    console.log(`Refund successful: ${result.txHash}`);
  }
}
```

## Ambiguous Refund Resolution (Stellar)

### Scenario: Handle Horizon timeout scenario

```typescript
import { RecoveryService } from '../services/recovery';

async function resolveAmbiguousStellarRefund(
  order: OrderRow,
  recoveryService: RecoveryService
): Promise<void> {
  // Check existing refund ledger entry
  const existingRequests = recoveryService.getRecoveryRequests(order.orderHash);
  const pendingRequest = existingRequests.find(r => 
    r.status === 'pending' || r.status === 'failed'
  );
  
  if (pendingRequest) {
    // Resolution is automatic in the Stellar handler
    const result = await recoveryService.executeRecovery(
      order,
      'ambiguous_refund_resolution'
    );
    
    if (result.success) {
      console.log(`Ambiguous refund resolved: ${result.txHash}`);
    } else if (result.errorType === 'ambiguous') {
      console.log('Refund status still ambiguous - will retry later');
    }
  }
}
```

## Integration with Watchdog

### Scenario: Background watchdog using new service

```typescript
import { RecoveryService } from '../services/recovery';
import { WatchdogOrder } from '../services/refund-watchdog';

class RefundWatchdog {
  private recoveryService: RecoveryService;
  
  constructor(recoveryService: RecoveryService) {
    this.recoveryService = recoveryService;
  }
  
  async scanAndRefundStaleOrders(activeOrders: Map<string, WatchdogOrder>): Promise<void> {
    const currentTime = Date.now();
    
    for (const [orderId, order] of activeOrders.entries()) {
      // Check if order is an XLM→ETH swap awaiting ETH
      if (this.isXlmToEthAwaitingEth(order)) {
        // Check if order is stale (hasn't been processed in 5 minutes)
        const age = currentTime - this.toMillis(order.created);
        if (age > 5 * 60 * 1000) {
          // Execute refund using new service
          const result = await this.recoveryService.executeRecoveryByChain(
            'stellar',
            order,
            'stuck_order_refund'
          );
          
          if (result.success) {
            order.status = 'refunded';
            order.refundTxHash = result.txHash;
            order.refundedAt = Date.now();
            
            console.log(`Watchdog refunded ${orderId}: ${result.txHash}`);
          } else {
            console.error(`Watchdog refund failed for ${orderId}: ${result.error}`);
          }
        }
      }
    }
  }
  
  private isXlmToEthAwaitingEth(order: WatchdogOrder): boolean {
    return order.direction === 'xlm_to_eth' && 
           order.stellarTxHash && 
           !order.refundTxHash &&
           order.status !== 'completed' &&
           order.status !== 'refunded';
  }
  
  private toMillis(value: string | number | undefined): number {
    if (typeof value === 'number') {
      return value > 1e12 ? value : value * 1000;
    }
    return Date.parse(String(value)) || 0;
  }
}
```

## Monitoring and Statistics

### Scenario: Monitor recovery operations

```typescript
import { RecoveryService } from '../services/recovery';

class RecoveryMonitor {
  private recoveryService: RecoveryService;
  
  constructor(recoveryService: RecoveryService) {
    this.recoveryService = recoveryService;
  }
  
  async logRecoveryStats(): Promise<void> {
    const stats = this.recoveryService.getRecoveryStats();
    
    console.log('=== Recovery Statistics ===');
    console.log(`Total Recoveries: ${stats.totalRecoveries}`);
    console.log(`Successful: ${stats.successfulRecoveries}`);
    console.log(`Failed: ${stats.failedRecoveries}`);
    console.log(`Pending: ${stats.pendingRecoveries}`);
    console.log(`Total Value Recovered: ${stats.totalValueRecovered}`);
    console.log(`Avg Recovery Time: ${stats.averageRecoveryTime}s`);
    console.log(`Last Recovery: ${new Date(stats.lastRecoveryAt * 1000).toISOString()}`);
    console.log('===========================\n');
  }
  
  async checkPendingRecoveries(): Promise<void> {
    // Get orders with active recoveries
    const pendingOrders = Array.from(activeOrders.values())
      .filter(order => this.recoveryService.isOrderEligibleForAutoRecovery(order, Date.now() / 1000));
    
    if (pendingOrders.length > 0) {
      console.log(`⚠️ ${pendingOrders.length} orders pending recovery`);
      for (const order of pendingOrders) {
        console.log(`  - ${order.publicId} (${order.direction})`);
      }
    }
  }
}
```

## Error Handling Pattern

### Scenario: Handle different error types appropriately

```typescript
import { RecoveryService, RecoveryResult } from '../services/recovery';

async function handleRecoveryWithRetry(
  order: OrderRow,
  recoveryService: RecoveryService,
  maxRetries: number = 3
): Promise<void> {
  let attempts = 0;
  let lastError: string | undefined;
  
  while (attempts < maxRetries) {
    const result = await recoveryService.executeRecovery(order, 'timeout_refund');
    
    if (result.success) {
      console.log('Recovery successful!');
      return;
    }
    
    lastError = result.error;
    attempts++;
    
    // Handle different error types
    switch (result.errorType) {
      case 'transient':
        console.log(`Transient error (attempt ${attempts}/${maxRetries}), retrying...`);
        await sleep(1000 * attempts); // Exponential backoff
        break;
        
      case 'ambiguous':
        console.log('Ambiguous error - may have succeeded, checking status...');
        // For ambiguous errors, we might want to check on-chain status
        await this.checkOnChainStatus(order, result.chain);
        break;
        
      case 'terminal':
        console.error(`Terminal error, stopping retries: ${result.error}`);
        return;
        
      default:
        console.error(`Unknown error type: ${result.error}`);
        return;
    }
  }
  
  console.error(`Recovery failed after ${maxRetries} attempts: ${lastError}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
```

## Recovery Request Creation

### Scenario: Manual recovery initiation

```typescript
import { RecoveryService, RecoveryRequest } from '../services/recovery';

async function initiateManualRecovery(
  order: OrderRow,
  recoveryType: 'emergency_refund' | 'force_recovery',
  reason: string,
  initiator: string,
  recoveryService: RecoveryService
): Promise<void> {
  const result = await recoveryService.executeRecovery(order, recoveryType, reason);
  
  if (result.success) {
    console.log(`Manual recovery initiated: ${result.txHash}`);
    
    // Record metadata for audit
    const request: RecoveryRequest = {
      id: `manual_${Date.now()}`,
      orderId: order.publicId,
      orderHash: order.orderHash,
      type: recoveryType,
      status: result.success ? 'completed' : 'failed',
      chain: result.chain,
      initiator,
      reason,
      metadata: {
        srcChainId: this.getChainId(order.srcChain),
        dstChainId: this.getChainId(order.dstChain),
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    
    this.recordRecoveryRequest(request);
  }
}

private getChainId(chain: string): number | undefined {
  const chainIds: Record<string, number> = {
    ethereum: 1,
    polygon: 137,
    stellar: 999,
    solana: 1151111081099710,
  };
  return chainIds[chain.toLowerCase()];
}
```

## Benefits Demonstrated

1. **Consistency**: Same recovery logic across all chains
2. **Safety**: Automatic duplicate prevention
3. **Flexibility**: Chain-specific handlers for protocol details
4. **Testability**: Clear interfaces for unit testing
5. **Extensibility**: Easy to add new chain handlers

## Migration Path

For existing code using old recovery services:

1. Import from new location: `import { RecoveryService } from '../services/recovery'`
2. Create service instance: `const service = new RecoveryService()`
3. Replace method calls with unified interface
4. Remove chain-specific conditional logic

See [RECOVERY_MIGRATION_GUIDE.md](./RECOVERY_MIGRATION_GUIDE.md) for detailed migration steps.
