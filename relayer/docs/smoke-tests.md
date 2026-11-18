# Relayer Smoke Tests

This directory contains smoke tests that exercise the relayer under realistic failure conditions and degraded scenarios.

## Overview

The smoke tests cover:

1. **Failure Scenarios** (`failure-scenarios.ts`)
   - Network timeouts and connection drops
   - Rate limiting and quota exhaustion
   - Partial failures (some chains succeed, others fail)
   - Coordinator metadata delays
   - Provider latency variations

2. **Backlog Scenarios** (`backlog-scenarios.ts`)
   - Large order queue processing (100-1000 orders)
   - Memory pressure scenarios
   - Cursor persistence during heavy load
   - Batch reconciliation
   - Performance under sustained load

3. **Recovery Scenarios** (`recovery-scenarios.ts`)
   - Settlement failure recovery workflows
   - State reconciliation after failures
   - Backstop refund scenarios
   - Emergency recovery procedures
   - Idempotent retry behavior

## Running Tests

### Run All Smoke Tests

```bash
pnpm --filter @wafflefinance/relayer test:smoke
```

### Run Specific Test Suite

```bash
# Failure scenarios only
pnpm --filter @wafflefinance/relayer test:smoke -- --filter failure

# Backlog scenarios only
pnpm --filter @wafflefinance/relayer test:smoke -- --filter backlog

# Recovery scenarios only
pnpm --filter @wafflefinance/relayer test:smoke -- --filter recovery
```

### Run in Watch Mode

```bash
pnpm --filter @wafflefinance/relayer test:smoke:watch
```

### Run with Coverage

```bash
pnpm --filter @wafflefinance/relayer test:smoke -- --coverage
```

## Test Scenarios in Detail

### Failure Scenarios

#### Network Timeout Patterns
- Transient timeouts with retry
- Circuit breaker opening after sustained timeouts
- Recovery after cooldown period

#### Rate Limit Handling
- Appropriate backoff on rate limits
- Continues processing other orders when one hits rate limit

#### Partial Failure Scenarios
- Stellar-only failure when Ethereum succeeds
- Ethereum-only failure when Stellar succeeds
- Both chains failing (terminal failure)

#### Coordinator Metadata Delay
- Delayed coordinator acknowledgment
- Pending coordinator acks reconciliation

#### Provider Latency
- Slow RPC responses
- Latency-induced timeouts

### Backlog Scenarios

#### Large Order Processing
- Batch processing (100-1000 orders)
- Mixed success/failure rates
- State count verification

#### Cursor Persistence
- State persistence across virtual restarts
- Recovery after simulated crash

#### Batch Reconciliation
- Quick reconciliation of 50 orders
- Partial reconciliation failures

#### Memory Pressure
- Handling 1000 orders without memory issues
- Resource release after batch completion

#### Sustained Load
- Continuous performance under load
- Concurrent retries under load
- Partial batch recovery

### Recovery Scenarios

#### Settlement Failure Recovery
- Transient failure recovery with retry
- Terminal failure with manual intervention
- Failed order reconciliation on startup

#### State Reconciliation
- Pending submission records
- Coordinator_recorded records
- Mixed state order reconciliation

#### Backstop Refund Scenarios
- Orders stuck in pending_relayer_escrow
- Timeout-based failure marking

#### Emergency Recovery
- Emergency failure marking
- Operator-initiated recovery attempts

#### Idempotent Retry Behavior
- Duplicate submission prevention
- Retry with new orderId after failure
- Concurrent retry attempts

#### Failure Classification
- Transient failure classification
- Terminal failure classification
- Failure statistics tracking

#### Recovery Workflow Documentation
- Step-by-step recovery process

## Interpreting Results

### Success Indicators

- All tests pass without timeout errors
- State transitions follow expected patterns
- Circuit breakers open/close correctly
- Memory usage remains stable under load
- No data loss across virtual restarts

### Failure Indicators

- Tests timing out may indicate:
  - Circuit breaker not opening/closing correctly
  - Backoff strategy not working
  - Memory leaks under load

- Unexpected state transitions may indicate:
  - Race conditions in state machine
  - Missing reconciliation logic
  - Idempotency issues

- Memory issues may indicate:
  - Missing cleanup after batch completion
  - Order map not being pruned
  - Cursor persistence issues

## Adding New Scenarios

When adding new scenarios:

1. Create a new test file in `test/smoke/`
2. Add appropriate test suites following the existing patterns
3. Document the scenario in this file
4. Include expected success/failure indicators

## CI/CD Integration

Smoke tests run as part of the CI pipeline:

```yaml
# .github/workflows/relayer.yml
- name: Run smoke tests
  run: pnpm --filter @wafflefinance/relayer test:smoke
```

## Local Development

For local development, use the smoke tests to:

1. Validate changes to retry logic
2. Test new failure scenarios
3. Verify recovery workflows
4. Ensure no performance regressions

### Recommended Development Flow

1. Run individual test suites in watch mode:
   ```bash
   pnpm --filter @wafflefinance/relayer test:smoke -- --watch failure
   ```

2. Fix any issues in the implementation

3. Run full smoke test suite:
   ```bash
   pnpm --filter @wafflefinance/relayer test:smoke
   ```

4. Verify all scenarios pass before committing

## Troubleshooting

### Test Timeout Issues

If tests time out:

1. Check circuit breaker configuration
2. Verify backoff strategy
3. Review concurrent access patterns
4. Check for memory leaks

### State Mismatch Issues

If state doesn't match expectations:

1. Verify reconciliation logic
2. Check pending submission timeouts
3. Review state transition rules
4. Ensure idempotency is maintained

### Performance Issues

If performance degrades:

1. Profile memory usage
2. Check for unnecessary retries
3. Review batch sizes
4. Verify resource cleanup

## Related Documentation

- [Relayer README](../README.md)
- [Retry Engine](../src/utils/retry-engine.ts)
- [Settlement Service](../src/services/settlement-service.ts)
- [Tx State Store](../src/services/tx-state-store.ts)
