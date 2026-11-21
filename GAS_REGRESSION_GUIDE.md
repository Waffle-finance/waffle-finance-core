# Gas Regression Test Harness - Implementation Guide

## Overview

A gas regression testing harness lives in
[`contracts/test/gas-regression.test.ts`](contracts/test/gas-regression.test.ts).
It tracks gas usage for the order lifecycle (native and token order creation,
successful claims, refunds) and the pull-payment withdrawal fallback, and
prevents silent regressions.

The harness uses **committed gas snapshots** as the baseline. Snapshots are
checked into the repo, so any change to user-facing gas costs shows up as a
reviewable diff in the PR.

## What Was Created

### Test File: `contracts/test/gas-regression.test.ts`

The harness includes:

1. **Gas Thresholds** - Baseline limits for all critical operations
2. **Measurement Helpers** - Functions to capture and validate gas usage
3. **Test Suites** - Comprehensive coverage of all HTLC operations
4. **Integration Tests** - End-to-end swap sequence analysis
5. **Summary Reports** - Pretty-printed baseline documentation

## Setup & Installation

### Prerequisites

- Node.js 22.5+
- pnpm 8+ (the workspace uses pnpm@8.15.0)
- Hardhat dependencies

### Installation Steps

```bash
# From repo root
pnpm install
```

## Running the Tests

### Execute All Gas Regression Tests

```bash
# From repo root
pnpm --filter @wafflefinance/contracts test -- --grep "Gas Regression"
```

### Run Specific Test Suites

```bash
# Order lifecycle operations only
pnpm --filter @wafflefinance/contracts test -- --grep "Order Lifecycle Gas Snapshots"

# Withdrawal fallback only
pnpm --filter @wafflefinance/contracts test -- --grep "Withdrawal Fallback Gas Snapshots"

# View gas summary
pnpm --filter @wafflefinance/contracts test -- --grep "Gas Summary Report"
```

### Run All Contract Tests (includes gas regression)

```bash
pnpm --filter @wafflefinance/contracts test
```

## Test Coverage

### Order Lifecycle Snapshots

| Operation             | Tests | Purpose                                       |
| --------------------- | ----- | --------------------------------------------- |
| `createOrder(native)` | 1     | Native ETH order creation with safety deposit |
| `createOrder(ERC20)`  | 1     | ERC20 token order with approval               |
| `claimOrder`          | 2     | Claim with preimage reveal (native + ERC20)   |
| `refundOrder`         | 2     | Refund after timelock expiry (native + ERC20) |

### Withdrawal Fallback Snapshots

| Operation  | Tests | Purpose                            |
| ---------- | ----- | ---------------------------------- |
| `withdraw` | 1     | Withdraw from pull-payment balance |

All cases use fixed token and recipient fixtures so the measured gas is
reproducible run-to-run.

## Gas Snapshots & Tolerances

Baselines are stored as committed snapshots (one entry per operation above).
Each snapshot is compared against the measured value with a tolerance that
absorbs insignificant compiler noise while still catching meaningful
regressions:

- **Tolerance:** ±2% of the recorded baseline.
- **Rationale:** Hardhat runs are deterministic, so run-to-run variance is
  near zero. The small buffer only absorbs minor compiler/optimizer noise
  (e.g. after a Solidity patch bump). Anything larger than 2% is treated as a
  real, user-facing fee change and fails the test.
- **No silent drift:** a failing snapshot is never auto-accepted. Updating a
  baseline is an explicit, reviewable change (see below).

## Interpreting Test Output

### Successful Run

```
Order Lifecycle Gas Snapshots
  createOrder
    ✓ createOrder with native ETH matches snapshot (234ms)
    ├─ createOrder(native): 87234 gas (baseline: 87000, tolerance: ±2%)
```

### Regression Detection

```
  1) claimOrder matches snapshot
     ├─ claimOrder: 125800 gas (baseline: 105000, tolerance: ±2%)
     └─ ⚠️  GAS REGRESSION: claimOrder used 125800 gas,
        exceeding baseline 105000 by more than 2%
     Error: claimOrder gas usage (125800) exceeds snapshot baseline (105000) + 2% tolerance
```

When a regression is detected:

1. Test fails with a clear error message
2. Actual gas vs. baseline is displayed
3. The tolerance is shown
4. Developer must investigate the contract change before touching the snapshot

## Integration with CI/CD

The gas regression tests run as part of the contracts test suite in the
repo's CI workflows (see [docs/DOC_MAP.md](docs/DOC_MAP.md) for the workflows
that actually run). Because the snapshots are committed, CI reports gas
changes for the tracked lifecycle operations directly in the PR diff.

### Continuous Monitoring

The gas regression tests should run on:

- ✅ Every PR (gate merge)
- ✅ Pre-deployment (catch before mainnet)
- ✅ Post-deployment (establish new baseline if intentional)

## Refreshing Snapshots

When a contract change intentionally alters gas usage:

1. **Verify the change is intentional** - Review the contract modifications.
2. **Understand the impact** - Estimate the user-facing fee change.
3. **Regenerate the baseline** - Refresh the committed snapshots:

   ```bash
   pnpm --filter @wafflefinance/contracts test -- --grep "Gas Snapshots" --update-snapshots
   ```

4. **Review the diff** - The regenerated snapshot file must appear as an
   explicit, reviewable change in the PR. Never hand-edit or silently accept
   snapshot updates.
5. **Document the change** - The PR description and commit message must
   explain why gas moved and confirm the new baseline is acceptable.

### Review Process for Baseline Changes

- Snapshot updates are treated like any other production change: they need
  an explicit diff and reviewer sign-off.
- Reviewers should confirm the delta is explained by the contract change and
  is within an acceptable user-facing range.
- A snapshot change bundled with unrelated code changes should be split out
  or called out separately so it is easy to review.
- If the delta is unexpected, treat it as a regression and investigate before
  refreshing the baseline.

## Debugging High Gas Usage

If tests fail with gas regressions:

### 1. Confirm It's Real

```bash
pnpm --filter @wafflefinance/contracts test -- --grep "claimOrder matches snapshot"
```

Run multiple times - if consistent, it's real.

### 2. Generate Gas Report

```bash
REPORT_GAS=true pnpm --filter @wafflefinance/contracts test
```

This generates `gas-report.txt` with detailed per-function breakdown.

### 3. Compare to Baseline

- Check git history for when threshold was set
- Review any recent contract changes
- Look for added loops, storage writes, or external calls

### 4. Investigate Contract Changes

```bash
# Find what changed
git log --oneline -n 20 contracts/contracts/

# View specific changes
git diff HEAD~5 contracts/contracts/HTLCEscrow.sol
```

## Test Architecture

### Helper Functions

**`measureGas(tx)`**

- Takes a transaction response
- Returns gas used (BigInt)
- Handles receipt and error cases

**`assertGasMatchesSnapshot(actual, name)`**

- Validates gas usage against the committed snapshot baseline + tolerance
- Logs detailed output
- Throws if exceeded

**`deployEscrow()`, `deployToken()`, `deployResolverRegistry()`**

- Fresh contract instances for each test
- Isolates state between tests
- Configurable parameters for edge cases

### Isolation

Each test:

- Gets fresh contract instances
- Independent timelock values
- Isolated signer accounts
- Clean blockchain state (Hardhat networks reset between tests)

## Performance Impact

- **Test runtime:** ~15-25 seconds for full suite
- **CI overhead:** Minimal (<5% of total test time)
- **Deterministic:** Same result every run (Hardhat test network)

## Known Limitations

1. **Hardhat Network Only** - Tests run on simulated network
   - Real network gas may vary slightly
   - Use as early warning, not absolute guarantee

2. **Compiler Optimizer** - Gas depends on Solidity version
   - Update thresholds when upgrading compiler
   - Document changes in commit

3. **Storage State** - Initial state affects gas
   - Tests start with empty contracts
   - Real usage patterns may differ

## Maintenance Checklist

- [ ] Run tests before any contract merge
- [ ] Refresh snapshots only for intentional gas changes
- [ ] Ensure snapshot updates are explicit and reviewable in the PR
- [ ] Document snapshot changes
- [ ] Monitor gas trend over releases
- [ ] Review expensive operations quarterly

## Example: Adding New Operation

To add gas tracking for a new contract function:

```typescript
describe('newOperation', () => {
  it('should not regress', async () => {
    const [caller] = await ethers.getSigners();
    const contract = await deployEscrow();

    // Setup
    // ...

    // Execute
    const tx = await contract.connect(caller).newOperation(params);

    // Measure
    const gas = await measureGas(tx);
    assertGasMatchesSnapshot(gas, 'newOperation');
  });
});
```

Then record the baseline by refreshing snapshots (see
[Refreshing Snapshots](#refreshing-snapshots)) and commit the resulting
snapshot diff for review.

## Support & Troubleshooting

### Issue: Tests timeout

**Solution:** Increase timeout in hardhat.config.ts

```typescript
mocha: {
  timeout: 40000; // ms
}
```

### Issue: Gas values unstable

**Solution:** This is normal variance. Increase buffer or check for:

- Non-deterministic code (timestamps, randomness)
- External RPC calls affecting state
- Insufficient test isolation

### Issue: Snapshot tolerance too tight

**Solution:** The ±2% tolerance should be sufficient. If hitting the edge:

1. Run multiple times to confirm variance
2. Investigate whether the change is a real regression before adjusting
3. If a tolerance change is justified, make it an explicit, documented
   change in the PR

## References

- [Hardhat Gas Reporting](https://hardhat.org/plugins/hardhat-gas-reporter)
- [Ethers.js Transaction Response](https://docs.ethers.org/v6/api/contract/#ContractTransactionResponse)
- [Solidity Gas Optimization](https://docs.soliditylang.org/en/latest/internals/optimizer.html)

---

**Status:** ✅ Production Ready
**Maintained By:** WaffleFinance Team
