# HTLCEscrow — Invariant & Fuzz Test Documentation

This document describes every invariant and stateful fuzz scenario implemented in
`InvariantHTLCEscrow.t.sol`. It serves as the authoritative reference for
security reviewers, auditors, and contributors making changes to `HTLCEscrow.sol`.

---

## Overview

The invariant suite runs **1 024 fuzz sequences, each 50 operations deep** (configured in
`foundry.toml`). Each sequence is a random interleaving of:

| Handler action             | Description                                              |
|---------------------------|----------------------------------------------------------|
| `createOrderNative`        | Create an ETH-denominated HTLC order                     |
| `createOrderERC20`         | Create an ERC20-denominated HTLC order                   |
| `claimOrder`               | Attempt to claim with correct or incorrect preimage      |
| `refundOrder`              | Refund a past-expiry order (warps time if needed)        |
| `withdraw`                 | Pull a deferred native-ETH payout from the escrow        |
| `warpTime`                 | Advance `block.timestamp` by 1 s – 7 days                |
| `setReceiverMode`          | Toggle `HTLCReceiverMock` between Accept / Reject / Guzzle |

After every sequence the six invariant functions below are evaluated by Foundry.
A single violation fails the entire campaign.

---

## Six Specific Invariants

### 1. Balance & Solvency Invariant
**Function:** `invariant_balanceMatchesFundedOrdersAndWithdrawals`

**Property:**

```
address(htlc).balance
  == Σ (order.amount + order.safetyDeposit)  for all Funded native-ETH orders
   + Σ order.safetyDeposit                   for all Funded ERC20 orders
   + Σ pendingWithdrawals[actor]              for all tracked actors
```

**Rationale:** Every wei deposited must be accounted for at all times — either
locked in a `Funded` order, or credited as a pull-payment pending collection.
A breach means funds have leaked, been double-counted, or permanently stranded.

**Threat model:** ETH drain attacks, arithmetic over/underflow on payout accounting,
incorrect push vs pull-payment branch selection.

---

### 2. Pull-Payment Isolation Invariant
**Function:** `invariant_pullPaymentIsolation`

**Property:**

```
∀ actor ∈ tracked actors:
  htlc.pendingWithdrawals(actor) == handler.ghostPendingWithdrawals(actor)
```

The ghost variable is updated only by the handler's own tracked actions for that
specific actor. If the on-chain value deviates from the ghost, another actor's
operation polluted it.

**Rationale:** `_pendingWithdrawals` is a strictly per-recipient ledger. No
third-party action should be able to credit, debit, or read-and-drain another
address's balance. This is the non-custodial guarantee for deferred payouts.

**Threat model:** Cross-account pull-payment injection, reentrancy via deferred
payout to accumulate unearned credits, accounting bugs from shared state.

---

### 3. Reentrancy Safety Invariant
**Function:** `invariant_reentrancySafety`

**Property:**

```
ReentrantActor.reentrancySucceeded() == false
```

`ReentrantActor.receive()` attempts to re-enter `withdraw()`, `claimOrder()`,
or `refundOrder()` whenever it receives native ETH. OpenZeppelin's
`ReentrancyGuard` should cause every re-entry to revert.

**Rationale:** `claimOrder`, `refundOrder`, and `withdraw` each call
`_payoutNative` which forwards ETH to potentially adversarial contracts.
If the guard were missing or incorrectly applied a reentrant call could
double-spend a safety deposit or drain the pending withdrawal balance.

**Threat model:** Classic re-entrancy (double spend), cross-function reentrancy
(claim then withdraw in the same call stack), pull-payment reentrancy.

---

### 4. Timelock Enforcement & Immutable Finality Invariant
**Function:** `invariant_timelockEnforcement`

**Property:**

```
∀ order with status ∈ {Claimed, Refunded}:
  order.finalisedAt > 0
  order.finalisedAt >= order.createdAt
```

Once an order transitions to a terminal state it is permanently frozen.
`finalisedAt` must be a positive timestamp after creation.

**Rationale:** The state machine must be one-way. A finalized order that can
revert to `Funded` would allow double-claim or double-refund.
`finalisedAt` is also used by off-chain indexers to construct proofs for
Soroban-side settlement; a zero value there would break cross-chain finality.

**Threat model:** Status-reset attacks, integer truncation setting `finalisedAt`
to zero, race conditions on the `block.timestamp` boundary between claim and refund.

---

### 5. Preimage Integrity Invariant
**Function:** `invariant_preimageIntegrity`

**Property:**

```
∀ order with status == Claimed:
  |preimage| == 32 bytes
  (sha256(preimage) == order.hashlock) ∨ (keccak256(preimage) == order.hashlock)
  order.preimageKeccak == keccak256(preimage)

∀ order with status ≠ Claimed:
  order.preimageKeccak == bytes32(0)
```

**Rationale:** The dual-digest design (`sha256` + `keccak256`) is what makes the
HTLC interoperate with both Soroban (sha256-native) and EVM (keccak256-native)
counterparties. Any drift between the stored `preimageKeccak` and the actual
preimage would break cross-chain claim proofs and allow false finality.

**Threat model:** Preimage substitution (different 32-byte value that collides),
storing a digest-of-digest as the preimage, hash-length extension attacks,
non-32-byte preimage acceptance.

---

### 6. Safety Deposit Accounting Invariant
**Function:** `invariant_safetyDepositAccounting`

**Property:**

```
Σ order.safetyDeposit for all Funded orders
  ≤ handler.ghostTotalSafetyDepositsFunded
```

Active (unliquidated) safety deposits must never exceed the total ever funded.
The inequality (≤) rather than equality accounts for deposits already paid out
to claimers / refunders or deferred into `pendingWithdrawals`.

**Rationale:** Safety deposits are the economic incentive that drives relayer
participation. Overcounting would allow the contract to promise more than it
holds; undercounting would strand incentive payments permanently.

**Threat model:** Safety-deposit inflation (crafted `createOrder` overwriting
accounting), double-crediting during claim and refund, arithmetic errors in
the combined push/defer payout path.

---

## Stateful Bug-Finding Scenarios (Concrete Tests)

### `testStateful_concurrentClaims`
Two callers attempt to claim the same order sequentially. The first succeeds;
the second must revert with `OrderNotClaimable`. Simulates a race where two
relayers both hold the preimage and race to the mempool.

### `testStateful_claimRefundRaces`
Tests the exact expiry boundary (`block.timestamp == order.timelock`):
- `refundOrder` must revert `NotExpired` at exact expiry (strict `>`).
- `claimOrder` must succeed at exact expiry (`block.timestamp < order.timelock`
  semantics: `>=` means expired for claims).
- After a successful claim, `refundOrder` at `timelock + 1` must revert `OrderNotRefundable`.

### `testStateful_zeroAmountsAndEdgeCases`
Validates all input-validation guards:
- `amount == 0` → `InvalidAmount`
- `beneficiary == address(0)` → `InvalidAmount`
- `hashlock == bytes32(0)` → `InvalidHashlock`
- `timelockSeconds < MIN_TIMELOCK (300)` → `InvalidTimelock`
- `safetyDeposit < minSafetyDeposit` → `SafetyDepositTooSmall`

---

## Gas Profiling Benchmarks

Each benchmark creates a realistic scenario and measures gas via `gasleft()`
before and after the call under test, asserting the result stays below a
ceiling that acts as a regression guard.

| Test                               | Ceiling     | What is measured                                            |
|-----------------------------------|-------------|-------------------------------------------------------------|
| `testGas_createOrder_native`       | 200 000 gas | Single `createOrder` for an ETH-denominated order           |
| `testGas_claimOrder_native`        | 100 000 gas | `claimOrder` with valid preimage, EOA beneficiary (push OK) |
| `testGas_refundOrder_native`       | 100 000 gas | `refundOrder` after expiry, EOA refundAddress (push OK)     |
| `testGas_withdraw_deferredPayout`  |  60 000 gas | `withdraw()` for a deferred payout (pull path)              |
| `testGas_stressCreateClaimRefund`  | n/a         | 20 orders: 10 claimed, 10 refunded; asserts zero residual balance |

---

## Running the Tests

```bash
# From the repo root contracts/ directory:

# Run all Foundry tests (unit + fuzz + invariant)
forge test -v

# Run only invariant tests (1 024 sequences × 50 depth)
forge test --match-contract InvariantHTLCEscrowTest -v

# Run only gas benchmarks
forge test --match-contract InvariantHTLCEscrowTest --match-test testGas -v

# Run only security tests
forge test --match-contract HTLCEscrowSecurityTest -v

# Run with increased fuzz runs for deeper campaign
FOUNDRY_INVARIANT_RUNS=5000 FOUNDRY_INVARIANT_DEPTH=100 forge test --match-contract InvariantHTLCEscrowTest -v
```

## CI Integration

Foundry invariant and fuzz tests run in CI via `.github/workflows/soroban-contracts.yml`
(or the equivalent contracts workflow). The `scripts/test-foundry.sh` script in
the contracts workspace provides a convenience wrapper.

---

## Fuzz Campaign Configuration (`foundry.toml`)

```toml
[fuzz]
runs = 1024

[invariant]
runs  = 1024
depth = 50
```

- `runs`: Number of independent random sequences per invariant function.
- `depth`: Maximum number of handler calls per sequence.
- Total maximum calls per invariant: `1 024 × 50 = 51 200`.

Increase `runs` and `depth` locally for deeper pre-deployment security assurance.
