# Event Ordering and Staleness Detection

This document describes how the resolver handles event ordering and detects stale or contradictory data from chain listeners.

## Problem Statement

Chain listeners receive events asynchronously, which can lead to:

1. **Out-of-order events**: Events arrive in a different order than they were emitted on-chain (e.g., a claim event before the corresponding created event)
2. **Stale block numbers**: Events reference blocks that are too old, possibly from a fork or rollback
3. **Block regression**: Confirmed slots decrease, indicating a chain reorganization
4. **Cross-chain inconsistencies**: Different chains emit events independently, making cross-chain ordering impossible to guarantee

## Solution Overview

The resolver implements a two-layer defense:

1. **Event Order Guard** (`src/event-ordering.ts`)
   - Monotonically increasing order IDs per chain
   - Block height watermark tracking
   - Staleness detection based on block age
   - Per-chain state isolation

2. **Chain-specific listeners** integrate with the guard to:
   - Reject out-of-order events before processing
   - Log and count rejected events for monitoring
   - Provide visibility into chain health

## Key Components

### EventOrderGuard

Tracks per-chain ordering state and validates events.

**Key methods:**

```typescript
// Update chain head (call before processing events from a new poll)
updateChainHead(chain: Chain, newHeight: number | bigint): void

// Validate an event
validateEvent(metadata: EventMetadata): EventRecord

// Get current chain state (debugging)
getChainState(chain: Chain): ChainState | undefined
```

**Validation rules:**

1. **Staleness check**: Events must be within `maxBlockAge` blocks of the current head
2. **Order ID sequence**: Order IDs must be monotonically increasing
3. **Timestamp validation**: Timestamps must not regress significantly

### EventOrderMonitor

Provides metrics and logging for event ordering.

**Key methods:**

```typescript
// Process an event and return validation result
processEvent(metadata: EventMetadata): EventRecord

// Get metrics summary
getMetrics(): {
  valid: number;
  rejected: number;
  invalid: number;
  stale: number;
  total: number;
}

// Reset all counters
reset(): void
```

## Integration with Chain Listeners

### Ethereum Listener

```typescript
import { EventOrderGuard, EventOrderMonitor } from '../src/event-ordering.js';

export class EthereumListener {
  private readonly orderGuard = new EventOrderGuard();
  private readonly orderMonitor = new EventOrderMonitor();

  async onOrderCreated(event: EthereumOrderCreatedEvent): Promise<void> {
    const metadata: EventMetadata = {
      chain: 'ethereum',
      eventType: 'order_created',
      orderId: event.orderId,
      blockNumber: event.blockNumber,
      timestamp: Date.now(),
    };

    const record = this.orderGuard.validateEvent(metadata);
    
    if (!record.valid) {
      this.log.warn({ 
        orderId: event.orderId, 
        blockNumber: event.blockNumber,
        reason: record.rejectionReason 
      }, 'Event rejected by order guard');
      return;
    }

    // Proceed with event processing
  }
}
```

### Soroban Listener

```typescript
import { EventOrderGuard, EventOrderMonitor, decodeSorobanHtlcEvent } from '../src/event-ordering.js';

export class SorobanListener {
  private readonly orderGuard = new EventOrderGuard();
  private readonly orderMonitor = new EventOrderMonitor();

  async handleSorobanEvent(topics: string[], value: string): Promise<void> {
    const event = decodeSorobanHtlcEvent(topics, value, {
      ledger: this.currentLedger,
      txHash: this.currentTxHash,
      contractId: this.contractId,
    });

    if (!event) return;

    const metadata: EventMetadata = {
      chain: 'soroban',
      eventType: `order_${event.type}` as any,
      orderId: event.orderId,
      blockNumber: event.ledger,
      timestamp: Date.now(),
    };

    const record = this.orderGuard.validateEvent(metadata);

    if (!record.valid) {
      this.log.warn({
        orderId: event.orderId,
        ledger: event.ledger,
        reason: record.rejectionReason,
      }, 'Soroban event rejected by order guard');
      return;
    }

    // Proceed with event processing
  }
}
```

### Solana Listener

```typescript
import { EventOrderGuard, EventOrderMonitor } from '../src/event-ordering.js';
import { SolanaListener, type SolanaHtlcEvent } from '../src/listeners/solana.js';

export class SolanaListenerWrapper {
  private readonly orderGuard = new EventOrderGuard();
  private readonly orderMonitor = new EventOrderMonitor();

  async handleSolanaEvent(event: SolanaHtlcEvent): Promise<void> {
    const metadata: EventMetadata = {
      chain: 'solana',
      eventType: `order_${event.type}` as any,
      orderId: BigInt(event.orderId),
      blockNumber: event.slot,
      timestamp: Date.now(),
    };

    const record = this.orderGuard.validateEvent(metadata);

    if (!record.valid) {
      this.log.warn({
        orderId: event.orderId,
        slot: event.slot,
        reason: record.rejectionReason,
      }, 'Solana event rejected by order guard');
      return;
    }

    // Proceed with event processing
  }
}
```

## Metrics and Monitoring

The resolver exposes the following metrics for event ordering:

```prometheus
# Total events processed by chain and type
events_total{chain, event_type}

# Event ordering metrics
event_ordering_valid_total
event_ordering_rejected_total
event_ordering_invalid_total
event_ordering_stale_total

# Chain state
chain_head_height{chain}
last_event_timestamp{chain}
```

## Configuration

### Event Order Guard

```typescript
const guard = new EventOrderGuard({
  maxBlockAge: 100,        // Maximum age in blocks (default: 100)
  orderBufferMs: 30_000,   // Timestamp buffer in ms (default: 30000)
});
```

### Event Order Monitor

```typescript
const monitor = new EventOrderMonitor({
  maxBlockAge: 100,
  orderBufferMs: 30_000,
});
```

## Testing

Run the event ordering tests:

```bash
pnpm --filter @wafflefinance/resolver test event-ordering
```

Test coverage includes:

- Staleness detection for future and old blocks
- Order ID sequence validation
- Timestamp regression detection
- Per-chain state isolation
- Concurrent events from different chains

## Best Practices

1. **Always update chain head** before processing events:
   ```typescript
   orderGuard.updateChainHead('ethereum', newHead);
   ```

2. **Log rejected events** with full context:
   ```typescript
   if (!record.valid) {
     log.warn({ 
       orderId: event.orderId,
       reason: record.rejectionReason,
       expectedBlock: record.expectedBlockHeight,
       observedBlock: record.observedBlockHeight,
     }, 'Event rejected');
   }
   ```

3. **Monitor rejection rates** - high rejection rates indicate:
   - Network issues causing delayed events
   - Chain reorganizations
   - Misconfigured listeners

4. **Reset guards on chain changes**:
   ```typescript
   if (chainReorganizationDetected) {
     orderGuard.resetChain('ethereum');
   }
   ```

## Error Types

### OrderingError

Thrown when events violate ordering rules:

```typescript
class OrderingError extends Error {
  chain: Chain;
  orderId: bigint;
  eventType: EventType;
  reason: string;
  observedBlock?: number | bigint;
  expectedBlock?: number | bigint;
}
```

### StalenessError

Thrown when events reference stale blocks:

```typescript
class StalenessError extends Error {
  chain: Chain;
  blockNumber: number | bigint;
  maxAllowed: number | bigint;
  reason: string;
}
```

## Related Documentation

- [Resolver README](../README.md)
- [Listener State](../src/listener-state.ts)
- [Ethereum Listener](../src/listeners/ethereum.ts)
- [Soroban Listener](../src/listeners/soroban-events.ts)
- [Solana Listener](../src/listeners/solana.ts)
