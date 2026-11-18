# Event Ordering and Staleness Detection - Quick Start

This guide helps you understand and use the event ordering guards in the resolver.

## What This Solves

### Problem
Chain listeners receive events asynchronously, leading to:
- Events arriving out of order
- Stale block numbers from old blocks
- Chain reorganizations causing block regression
- Cross-chain event ordering inconsistencies

### Solution
The resolver now includes:
- Per-chain event ordering guards
- Block height watermark tracking
- Staleness detection based on block age
- Automatic rejection of invalid events

## Key Concepts

### EventOrderGuard
Tracks per-chain ordering state and validates events before processing.

**Key features:**
- Monotonically increasing order IDs per chain
- Block height watermark (highest observed block)
- Staleness detection (events must be within `maxBlockAge` blocks of head)

### EventOrderMonitor
Provides metrics and logging for event ordering.

**Key features:**
- Counts valid, rejected, invalid, and stale events
- Exposes metrics for monitoring
- Logs rejected events with full context

## Usage

### Basic Integration

```typescript
import { EventOrderGuard, EventOrderMonitor } from '../src/event-ordering.js';

export class YourListener {
  private readonly orderGuard = new EventOrderGuard();
  private readonly orderMonitor = new EventOrderMonitor();

  async handleEvent(event: YourEventType): Promise<void> {
    // 1. Update chain head before processing events
    this.orderGuard.updateChainHead('ethereum', event.blockNumber);

    // 2. Validate the event
    const metadata: EventMetadata = {
      chain: 'ethereum',
      eventType: 'order_created',
      orderId: event.orderId,
      blockNumber: event.blockNumber,
      timestamp: Date.now(),
    };

    const record = this.orderGuard.validateEvent(metadata);

    if (!record.valid) {
      // Event was rejected
      console.warn({
        orderId: event.orderId,
        reason: record.rejectionReason,
        expectedBlock: record.expectedBlockHeight,
        observedBlock: record.observedBlockHeight,
      });
      return;
    }

    // 3. Process the valid event
    this.processEvent(event);
  }
}
```

### Configuring Tolerance

```typescript
// More tolerant configuration
const guard = new EventOrderGuard({
  maxBlockAge: 200,        // Allow events up to 200 blocks old (default: 100)
  orderBufferMs: 60_000,   // Allow 60s timestamp buffer (default: 30s)
});

// Less tolerant configuration
const strictGuard = new EventOrderGuard({
  maxBlockAge: 10,         // Only allow 10 blocks old
  orderBufferMs: 5000,     // Only allow 5s timestamp buffer
});
```

### Getting Metrics

```typescript
const metrics = monitor.getMetrics();
console.log('Valid events:', metrics.valid);
console.log('Rejected events:', metrics.rejected);
console.log('Stale events:', metrics.stale);
console.log('Invalid events:', metrics.invalid);
console.log('Total events:', metrics.total);

// For Prometheus metrics
eventsTotal.inc({ chain: 'ethereum', event_type: 'valid' });
```

## Event Rejection Reasons

### Staleness Errors
- `block is from the future` - Block number higher than current head
- `block is 100 blocks old (max allowed: 10)` - Block too old

### Ordering Errors
- `order ID regressed from 10 to 5 - possible fork or replay attack` - Order ID decreased
- `timestamp regressed from 2000 to 500 - possible stale data` - Timestamp went backwards

## Testing

### Unit Tests

```bash
pnpm --filter @wafflefinance/resolver test event-ordering
```

### Test Coverage

Tests verify:
- Staleness detection for future and old blocks
- Order ID sequence validation
- Timestamp regression detection
- Per-chain state isolation
- Concurrent events from different chains

### Running Tests

```bash
# Run all tests
pnpm --filter @wafflefinance/resolver test

# Run event ordering tests only
pnpm --filter @wafflefinance/resolver test event-ordering

# Run with coverage
pnpm --filter @wafflefinance/resolver test -- --coverage
```

## Monitoring

### Prometheus Metrics

The resolver exposes event ordering metrics:

```prometheus
# Event ordering counts
resolver_event_ordering_valid_total{chain}
resolver_event_ordering_rejected_total{chain}
resolver_event_ordering_invalid_total{chain}
resolver_event_ordering_stale_total{chain}

# Chain state
resolver_chain_head_height{chain}
resolver_last_event_timestamp{chain}
```

### Alerting

Alert when:
- Stale event rate > 5% of total events
- Invalid event rate spikes
- Chain head stops advancing
- Order ID regression detected

## Best Practices

1. **Always update chain head first**
   ```typescript
   orderGuard.updateChainHead('ethereum', newHead);
   ```

2. **Log rejected events with full context**
   ```typescript
   if (!record.valid) {
     log.warn({
       orderId: event.orderId,
       reason: record.rejectionReason,
       expectedBlock: record.expectedBlockHeight,
       observedBlock: record.observedBlockHeight,
     }, 'Event rejected by order guard');
   }
   ```

3. **Monitor rejection rates**
   - High stale rates indicate network latency or chain issues
   - High invalid rates may indicate listener bugs
   - Order ID regression may indicate fork/replay

4. **Reset guards on chain changes**
   ```typescript
   if (chainReorganizationDetected) {
     orderGuard.resetChain('ethereum');
   }
   ```

## Examples

### Example 1: Rejecting Stale Events

```typescript
// Chain head at 200
orderGuard.updateChainHead('ethereum', 200n);

// Event from block 50 (150 blocks old, exceeds 100 block limit)
const metadata = makeEventMetadata({ blockNumber: 50n });
const record = orderGuard.validateEvent(metadata);

// record.valid === false
// record.rejectionReason === 'block is 150 blocks old (max allowed: 100)'
```

### Example 2: Detecting Order ID Regression

```typescript
// Order 10 was already processed
orderGuard.validateEvent(makeEventMetadata({ orderId: 10n }));

// Try to process order 5 (regression)
const metadata = makeEventMetadata({ orderId: 5n });
const record = orderGuard.validateEvent(metadata);

// record.valid === false
// record.rejectionReason === 'order ID regressed from 10 to 5 - possible fork or replay attack'
```

### Example 3: Handling Timestamp Regression

```typescript
// First event at timestamp 2000
orderGuard.validateEvent(makeEventMetadata({ timestamp: 2000 }));

// Second event at timestamp 500 (1500ms earlier, exceeds 5000ms buffer)
const metadata = makeEventMetadata({ timestamp: 500 });
const record = orderGuard.validateEvent(metadata);

// Within buffer, so still valid
// record.valid === true
```

## Integration with Chain Listeners

### Ethereum Listener

```typescript
export class EthereumListener {
  private readonly orderGuard = new EventOrderGuard();

  async onOrderCreated(event: EthereumOrderCreatedEvent): Promise<void> {
    this.orderGuard.updateChainHead('ethereum', event.blockNumber);

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
        reason: record.rejectionReason 
      }, 'Order created event rejected');
      return;
    }

    // Process the event
  }
}
```

### Solana Listener

```typescript
export class SolanaListener {
  private readonly orderGuard = new EventOrderGuard();

  async handleSolanaEvent(event: SolanaHtlcEvent): Promise<void> {
    this.orderGuard.updateChainHead('solana', event.slot);

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
      }, 'Solana event rejected');
      return;
    }

    // Process the event
  }
}
```

## Troubleshooting

### High Stale Rate

**Symptoms:** Many events rejected as stale

**Possible causes:**
- Network latency causing delayed events
- Listener not running recently
- Chain reorganizations

**Solutions:**
- Increase `maxBlockAge` tolerance
- Ensure listener runs continuously
- Monitor chain health

### Order ID Regression

**Symptoms:** Events rejected due to order ID regression

**Possible causes:**
- Chain reorganization
- Replay attack
- Listener bug causing duplicate processing

**Solutions:**
- Investigate chain health
- Review listener state persistence
- Add idempotency checks

### Timestamp Regression

**Symptoms:** Events rejected due to timestamp regression

**Possible causes:**
- Stale event data
- Clock skew between chains
- Fork/reorg

**Solutions:**
- Increase `orderBufferMs` tolerance
- Verify timestamp sources
- Monitor chain health

## Related Documentation

- [Event Ordering Documentation](./docs/event-ordering.md)
- [Resolver README](../README.md)
- [Listener State](../src/listener-state.ts)
