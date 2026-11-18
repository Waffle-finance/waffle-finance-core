# Relayer Smoke Tests - Quick Start

This guide helps you run the smoke tests locally to validate the relayer under realistic failure conditions.

## Prerequisites

- Node.js >= 22.0.0
- pnpm >= 8.0.0
- TypeScript

## Running Tests

### All Smoke Tests

```bash
pnpm --filter @wafflefinance/relayer test:smoke
```

### Individual Test Suites

```bash
# Failure scenarios (timeouts, rate limits, etc.)
pnpm --filter @wafflefinance/relayer test:smoke -- --filter failure

# Backlog scenarios (large batches, memory, etc.)
pnpm --filter @wafflefinance/relayer test:smoke -- --filter backlog

# Recovery scenarios (state reconciliation, etc.)
pnpm --filter @wafflefinance/relayer test:smoke -- --filter recovery
```

### Watch Mode

```bash
# Watch all smoke tests
pnpm --filter @wafflefinance/relayer test:smoke:watch

# Watch specific suite
pnpm --filter @wafflefinance/relayer test:smoke:watch -- --filter failure
```

### With Coverage

```bash
pnpm --filter @wafflefinance/relayer test:smoke -- --coverage
```

## What These Tests Validate

### Failure Scenarios
Tests how the relayer handles:
- Network timeouts and connection drops
- Rate limiting and quota exhaustion
- Partial failures (some chains succeed, others fail)
- Coordinator metadata delays
- Provider latency variations

### Backlog Scenarios
Tests how the relayer handles:
- Large order queues (100-1000 orders)
- Memory pressure scenarios
- Cursor persistence during heavy load
- Batch reconciliation
- Performance under sustained load

### Recovery Scenarios
Tests how the relayer handles:
- Settlement failure recovery workflows
- State reconciliation after failures
- Backstop refund scenarios
- Emergency recovery procedures
- Idempotent retry behavior

## Common Test Scenarios

### Simulating Network Timeouts

```typescript
// The test suite already includes this simulation
// Look for: "handles transient network timeouts with retry"
```

### Simulating Rate Limits

```typescript
// The test suite already includes this simulation
// Look for: "handles rate limit errors"
```

### Simulating Partial Failures

```typescript
// The test suite already includes this simulation
// Look for: "handles Stellar-only failure when Ethereum succeeds"
```

### Testing Circuit Breakers

```typescript
// The test suite already includes this simulation
// Look for: "marks circuit as open after sustained timeouts"
```

### Testing State Recovery

```typescript
// The test suite already includes this simulation
// Look for: "persists state across virtual restarts"
```

## Debugging Tests

### Verbose Output

```bash
pnpm --filter @wafflefinance/relayer test:smoke -- --reporter=verbose
```

### Single Test

```bash
pnpm --filter @wafflefinance/relayer test:smoke -- --test-namePattern="handles transient network timeouts"
```

### With Debug Logs

```bash
pnpm --filter @wafflefinance/relayer test:smoke -- --logHeapUsage
```

## Continuous Integration

Smoke tests run in CI/CD as part of the test suite:

```yaml
# .github/workflows/relayer.yml
- name: Run smoke tests
  run: pnpm --filter @wafflefinance/relayer test:smoke
```

## Local Development Workflow

1. **Make changes** to the relayer code

2. **Run smoke tests locally**:
   ```bash
   pnpm --filter @wafflefinance/relayer test:smoke
   ```

3. **Debug failures**:
   - Check test output for specific failures
   - Run individual tests with `--test-namePattern`
   - Use watch mode for rapid iteration

4. **Verify fixes**:
   ```bash
   pnpm --filter @wafflefinance/relayer test:smoke
   ```

5. **Commit changes** once all tests pass

## Troubleshooting

### Tests Timing Out

**Cause**: Circuit breaker not opening/closing correctly, or backoff strategy not working

**Solution**: 
- Check circuit breaker configuration
- Review backoff strategy
- Verify concurrent access patterns

### Unexpected State Transitions

**Cause**: Race conditions in state machine, missing reconciliation logic, or idempotency issues

**Solution**:
- Verify reconciliation logic
- Check pending submission timeouts
- Review state transition rules
- Ensure idempotency is maintained

### Memory Issues

**Cause**: Missing cleanup after batch completion, order map not being pruned, or cursor persistence issues

**Solution**:
- Profile memory usage
- Check for unnecessary retries
- Review batch sizes
- Verify resource cleanup

## Related Documentation

- [Full Smoke Tests Documentation](docs/smoke-tests.md)
- [Relayer README](../README.md)
- [Retry Engine](../src/utils/retry-engine.ts)
- [Settlement Service](../src/services/settlement-service.ts)
- [Tx State Store](../src/services/tx-state-store.ts)

## Getting Help

If you encounter issues:

1. Check the [Smoke Tests Documentation](docs/smoke-tests.md)
2. Review the [Relayer README](../README.md)
3. Check existing issues in the repository
4. Open a new issue with test output and reproduction steps
