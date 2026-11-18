# Recovery Services Module

Centralized recovery and refund operations for the WaffleFinance cross-chain bridge.

## Overview

This module provides a unified interface for handling recovery and refund operations across all supported chains (Ethereum, Solana, and Stellar). It ensures consistent behavior and enforces safety checks to prevent over-refunding or duplicate recovery claims.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    RecoveryService                       │
│              (Main orchestration entry point)            │
└────────────────────┬────────────────────────────────────┘
                     │
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│                 RecoveryOrchestrator                     │
│          (Route requests to appropriate handler)         │
└────────────────────┬────────────────────────────────────┘
                     │
         ┌───────────┼───────────┐
         ▼           ▼           ▼
┌─────────────┐ ┌─────────┐ ┌──────────┐
│  Ethereum   │ │ Stellar │ │ Solana   │
│  Handler    │ │ Handler │ │ Handler  │
└─────────────┘ └─────────┘ └──────────┘
```

## Components

### IRecoveryService

The main interface for recovery operations. Provides:
- Start/stop monitoring
- Execute recovery with automatic chain detection
- Get recovery statistics
- Safety checks for duplicates and balance capacity

### RecoveryOrchestrator

Routes recovery requests to the appropriate chain-specific handler:
- Automatically selects handler based on order's source/destination chain
- Validates safety constraints before execution
- Provides consistent error handling

### Chain-Specific Handlers

Each chain has its own handler implementing `IRecoveryHandler`:

#### EthereumRecoveryHandler
- Timeout refunds for expired HTLC orders
- Emergency refunds for urgent scenarios
- Public withdrawals
- Safety validation using Ethereum semantics

#### StellarRecoveryHandler
- Timeout refunds with Horizon integration
- Emergency refunds
- Public withdrawals
- **Ambiguous refund resolution** - Stellar-specific feature to check if a refund may have landed after a timeout

## Recovery Types

| Type | Description | Use Case |
|------|-------------|----------|
| `timeout_refund` | Refund after timelock expires | Normal refund path |
| `stuck_order_refund` | Refund for stuck orders | User reported stuck order |
| `emergency_refund` | Urgent refund with reason | Operator-initiated emergency |
| `public_withdrawal` | Public withdrawal of funds | Withdrawal by order recipient |
| `force_recovery` | Force recovery regardless of state | Admin override |
| `ambiguous_refund_resolution` | Check if refund may have landed | Stellar timeout recovery |

## Safety Checks

The service implements several safety checks:

1. **Duplicate Prevention**: Check if a refund is already in progress or completed
2. **Balance Capacity**: Verify refund amount doesn't exceed available balance
3. **Terminal State Guard**: Prevent recovery of orders in terminal states (completed, refunded, failed)
4. **Ambiguous State Handling**: Properly handle cases where transaction status is uncertain

## Usage

### Basic Recovery

```typescript
import { RecoveryService } from './services/recovery';

const service = new RecoveryService();
await service.start();

// Execute recovery for an order
const order = await ordersRepository.findByPublicId('order_123');
const result = await service.executeRecovery(order, 'timeout_refund');

if (result.success) {
  console.log(`Recovery successful: ${result.txHash}`);
} else {
  console.error(`Recovery failed: ${result.error}`);
}
```

### Execute Recovery by Chain

```typescript
// Force recovery on a specific chain
const result = await service.executeRecoveryByChain(
  'ethereum',
  order,
  'emergency_refund'
);
```

### Safety Check

```typescript
// Check for duplicate before executing
const isDuplicate = await service.checkDuplicateRefund(order, 'stellar');
if (isDuplicate) {
  // Skip this recovery
}

// Check balance capacity
const hasCapacity = await service.checkBalanceCapacity(order, 'stellar');
if (!hasCapacity) {
  // Skip or alert
}
```

## Monitoring

```typescript
// Get recovery statistics
const stats = service.getRecoveryStats();
console.log(stats);
// {
//   totalRecoveries: 150,
//   successfulRecoveries: 142,
//   failedRecoveries: 8,
//   pendingRecoveries: 3,
//   totalValueRecovered: '1250.50',
//   averageRecoveryTime: 45,
//   lastRecoveryAt: 1698765432
// }
```

## Configuration

The service automatically configures itself with default handlers for Ethereum and Stellar. To add a custom handler:

```typescript
import { RecoveryService, RecoveryOrchestrator } from './services/recovery';
import { CustomChainHandler } from './custom-chain-handler';

const orchestrator = new RecoveryOrchestrator();
orchestrator.registerHandler(new CustomChainHandler());

const service = new RecoveryService(orchestrator);
await service.start();
```

## Error Handling

All errors include:
- `errorType`: `'transient'`, `'terminal'`, or `'ambiguous'`
- `chain`: The chain where the error occurred
- `timestamp`: When the error occurred

Example error response:
```json
{
  "success": false,
  "error": "Refund transaction not found on chain",
  "errorType": "ambiguous",
  "timestamp": 1698765432,
  "chain": "stellar"
}
```

## Testing

```typescript
import { RecoveryService, EthereumRecoveryHandler, StellarRecoveryHandler } from './services/recovery';

describe('RecoveryService', () => {
  let service: RecoveryService;
  
  beforeEach(() => {
    service = new RecoveryService();
  });
  
  it('should execute timeout refund', async () => {
    const order = createTestOrder({ status: 'expired', srcChain: 'ethereum' });
    const result = await service.executeRecovery(order, 'timeout_refund');
    
    expect(result.success).toBe(true);
    expect(result.chain).toBe('ethereum');
  });
  
  it('should prevent duplicate refunds', async () => {
    const order = createTestOrder({ status: 'expired', srcChain: 'stellar' });
    
    // First refund
    await service.executeRecovery(order, 'timeout_refund');
    
    // Second refund should fail
    const result = await service.executeRecovery(order, 'timeout_refund');
    expect(result.success).toBe(false);
    expect(result.error).toContain('already in progress');
  });
});
```

## Migration from Old Implementation

The old recovery logic was scattered across multiple services:
- `recovery-service.ts` - Ethereum/Stellar specific logic
- `refund-watchdog.ts` - Background refund rescuer
- `xlm-refund.ts` - Stellar refund implementation

The new centralized service:
1. Replaces `recovery-service.ts` with a unified interface
2. Maintains `refund-watchdog.ts` as a client of the new service
3. Uses `xlm-refund.ts` within the Stellar handler for low-level operations

## Benefits

1. **Consistency**: Same decision logic across all chains
2. **Maintainability**: Single source of truth for recovery logic
3. **Safety**: Centralized safety checks prevent duplicate refunds
4. **Extensibility**: Easy to add new chain handlers
5. **Testability**: Clear interfaces make testing straightforward

## Future Enhancements

1. Solana handler implementation
2. Integration with a persistent recovery queue
3. Enhanced metrics and alerting
4. Support for partial settlements
5. Recovery prioritization based on age and value
