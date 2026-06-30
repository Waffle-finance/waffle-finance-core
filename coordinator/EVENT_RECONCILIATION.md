# Chain Event Reconciliation Strategy

## Overview

The coordinator implements a robust event reconciliation system to handle missed or delayed chain events without silently dropping state transitions.

## Event Catch-Up on Startup

### Ethereum Listener

**Lookback Window**: 5000 blocks (~16.7 hours at 12s/block)

**Behavior**:
1. Retrieves last processed block from database
2. Fetches all `OrderCreated` events from last block to current tip
3. Processes events to update order state
4. Starts watching for new events from current tip

**Gap Detection**: Warns if gap between last processed and current block exceeds 100 blocks

### Soroban Listener

**Lookback Window**: 34,560 ledgers (~48 hours at 5s/ledger)

**Behavior**:
1. Fetches events from contract within lookback window
2. Processes `OrderCreated`, `OrderClaimed`, and `OrderRefunded` events
3. Validates preimage/hashlock consistency for claim events
4. Updates order state machine accordingly

### Solana Listener

**Lookback Window**: 432,000 slots (~48 hours at 400ms/slot)

**Behavior**:
1. Fetches signatures for program within lookback window
2. Parses transaction logs for event data
3. Processes events with JSON payload extraction
4. Validates preimage/hashlock for claim events

## Periodic Reconciliation

**Trigger**: Configurable poll interval (default: 15 seconds)

**Lookback Windows**:
- Ethereum: 14,400 blocks (~48 hours)
- Soroban: 34,560 ledgers (~48 hours)
- Solana: 432,000 slots (~48 hours)

**Gap Detection**:
Before each reconciliation run, the system:
1. Compares last processed block to current chain tip
2. Logs warnings for gaps > 100 blocks
3. Provides debug logging for Soroban/Solana tips

**Event Replay**:
For each chain:
1. Fetches all events within lookback window
2. Replays events against current order state
3. Skips events that would cause invalid transitions
4. Logs warnings for replay errors
5. Metrics track events replayed and errors

## Event Processing Guarantees

### Idempotency

All event processing is idempotent:
- Duplicate events are safely ignored
- State machine guards prevent invalid transitions
- Reorg handling includes rollback logic

### Validation

**Preimage Validation**:
- Claim events validate preimage against hashlock
- Mismatched preimages are rejected with warning
- Prevents state corruption from malformed events

**State Machine Guards**:
- Cannot record src lock if already recorded
- Cannot record secret if already known
- Cannot transition terminal states
- Guards throw descriptive errors for debugging

### Error Handling

**Network Errors**: Logged but don't halt reconciliation
**Invalid Transitions**: Caught and logged, continue processing
**Missing Orders**: Events without local announce are logged
**Reorg Events**: Detected via `removed` flag, trigger rollback

## Recovery Paths

### Missed Events

1. **Startup Catch-Up**: Replays events from last known block
2. **Periodic Reconciliation**: Scans 48-hour window for missed events
3. **Gap Detection**: Identifies large gaps for investigation

### Delayed Events

1. **Extended Lookback**: 48-hour window captures delayed events
2. **Idempotent Processing**: Late events processed correctly if still valid
3. **State Machine Guards**: Rejects events that would create invalid state

### Reorg Recovery

1. **Removed Flag**: Detects reorged events via `removed: true`
2. **Rollback**: Reverts state transitions for reorged events
3. **Replay**: Processes new canonical events

## Monitoring

### Metrics

- `reconciliation_runs_total{result}`: Success/failure count
- `reconciliation_errors_total`: Error count
- `reconciliation_events_replayed_total`: Events replayed
- `reconciliation_last_run_seconds`: Unix timestamp of last run
- `listener_progress{chain}`: Last processed block/slot/ledger

### Logging

**Info Level**:
- Reconciliation run start/complete
- Events replayed per chain
- Gap detection warnings

**Warn Level**:
- Reconciliation failures
- Event replay errors
- Preimage/hashlock mismatches
- Significant block gaps

**Debug Level**:
- Chain tip monitoring
- Individual event processing

## Configuration

### Environment Variables

- `COORDINATOR_POLL_INTERVAL_MS`: Reconciliation interval (default: 15000)
- `ETH_HTLC_ESCROW_TESTNET`/`_MAINNET`: Ethereum contract address
- `SOROBAN_HTLC_TESTNET`/`_MAINNET`: Soroban contract ID
- `SOLANA_HTLC_PROGRAM_TESTNET`/`_MAINNET`: Solana program ID

### Tuning Guidelines

**Increase Lookback** if:
- Experiencing frequent missed events
- Running in regions with poor network connectivity
- Chain experiencing high reorg rates

**Decrease Lookback** if:
- Reconciliation runs are too slow
- Memory constraints on coordinator
- Chain is stable with low reorg rate

**Increase Poll Interval** if:
- Coordinator resource constrained
- Chain event rate is low

**Decrease Poll Interval** if:
- Need faster missed event detection
- High-value transactions require quick recovery

## Testing

Test reconciliation by:
1. Stopping coordinator during active orders
2. Restarting after several blocks/ledgers
3. Verifying events are caught up
4. Simulating reorgs (testnet only)
5. Monitoring metrics and logs
