# WaffleFinance Contracts

Ethereum-side smart contracts for the WaffleFinance v2 cross-chain bridge.

## Contracts Overview

| Contract | Purpose |
|---|---|
| `HTLCEscrow.sol` | Hash Time-Lock Contract for atomic cross-chain swaps |
| `ResolverRegistry.sol` | Stake/slash registry that gates resolver eligibility |
| `interfaces/IHTLCEscrow.sol` | Minimal public interface for `HTLCEscrow` |
| `interfaces/IResolverRegistry.sol` | Minimal public interface for `ResolverRegistry` |

---

## HTLCEscrow

### Purpose

Locks ERC-20 tokens or native ETH on behalf of a swap participant and releases them only when a preimage is revealed (claim) or after a timelock expires (refund). It is the Ethereum counterpart to the WaffleFinance Soroban HTLC on Stellar.

### Non-Custodial Design

**The deployer and operator have zero privileged access to locked funds.**

There is no `emergencyWithdraw`, no `pause`, and no admin escape hatch of any kind. Once funds enter the contract under a specific `hashlock` and `timelock`, they can only exit via:

1. `claimOrder` — the preimage matching the hashlock is revealed before the timelock, and funds are sent to the `beneficiary`.
2. `refundOrder` — the timelock has expired and funds are returned to the `refundAddress`.

Both paths are **permissionless**: any address can call them, not only the original participants.

### Access Control

| Function | Who can call | Effect |
|---|---|---|
| `createOrder` | Any active resolver (when registry set); anyone (when registry is `address(0)`) | Locks funds; emits `OrderCreated` |
| `claimOrder` | Anyone | Pays `beneficiary` + safety deposit to caller; emits `OrderClaimed` |
| `refundOrder` | Anyone | Returns locked amount to `refundAddress` + safety deposit to caller; emits `OrderRefunded` |
| `withdraw` | Only the credited address | Collects deferred native-ETH payout from the pull-payment ledger |
| `pendingWithdrawals` | Anyone (view) | Returns the pull-payment balance of an address |
| `getOrder` | Anyone (view) | Returns order data |
| `nextOrderId` | Anyone (view) | Returns the next order ID |

The `resolverRegistry` field is **immutable after construction**. To change the registry, deploy a new `HTLCEscrow` and migrate.

### ResolverRegistry Integration (Soft Sybil Gate)

When `resolverRegistry != address(0)`, `createOrder` checks `resolverRegistry.isActive(msg.sender)`. This is a **soft gate** — it only restricts who may *create* orders, not who may claim or refund. The permissionless refund path is unaffected by the registry.

A registry compromise or operator error cannot steal funds; it can only temporarily delay order creation until a new escrow is deployed.

### Hashlock Semantics

The contract verifies preimages against **both** `sha256` and `keccak256`:

```
sha256(preimage) == hashlock   ||   keccak256(preimage) == hashlock
```

This lets a single hashlock span both Soroban (sha256-only) and EVM (both) without requiring bridged orders to pick a dialect. Cross-chain swaps **must** use `sha256` end-to-end because the Soroban and Solana HTLCs do not accept `keccak256`.

### Timelock Bounds

| Constant | Value | Reason |
|---|---|---|
| `MIN_TIMELOCK` | 300 s (5 min) | Prevents accidental near-instant expiry |
| `MAX_TIMELOCK` | 86 400 s (24 h) | Caps capital lock duration |

### Native-ETH Payout Safety

Native-ETH payouts during `claimOrder` and `refundOrder` forward only `PAYOUT_GAS_STIPEND` (30 000 gas). If the push fails (e.g. the recipient is a contract with expensive fallback logic) the amount is credited to a **pull-payment ledger** (`_pendingWithdrawals`) rather than reverting. The original claim or refund still finalises atomically.

The pull-payment ledger is strictly per-recipient and can only be collected by that recipient via `withdraw`. No other address — including the deployer — can redirect the credit.

### Contract Invariants (HTLCEscrow)

| # | Invariant |
|---|---|
| H1 | `order.amount > 0` for every stored order (zero amount is the sentinel for "does not exist") |
| H2 | `order.status ∈ {Funded, Claimed, Refunded}` and transitions are monotone (no rollback) |
| H3 | A `Claimed` or `Refunded` order can never be acted on again (`OrderNotClaimable` / `OrderNotRefundable`) |
| H4 | `claimOrder` succeeds iff `block.timestamp ≤ order.timelock` and the preimage matches |
| H5 | `refundOrder` succeeds iff `block.timestamp > order.timelock` and `status == Funded` |
| H6 | `_pendingWithdrawals[a]` is only ever increased inside `_payoutNative`; zeroed before the outgoing transfer in `withdraw` |
| H7 | The contract never holds more ETH than `∑(Funded orders amounts) + ∑(pendingWithdrawals)` |

---

## ResolverRegistry

### Purpose

Open stake/slash registry. Resolvers post a stake of a configured ERC-20 to become eligible to fill swap orders. The `owner` — intended to be a multisig or DAO, **not** an EOA — can slash misbehaving resolvers.

### Non-Custodial Property

A ResolverRegistry compromise **cannot move user funds**. The `HTLCEscrow` queries `isActive()` only as a soft sybil filter. Even if the registry owner is compromised and all resolvers are slashed, the permissionless refund path in `HTLCEscrow` remains fully functional.

### Access Control

| Function | Who can call | Effect |
|---|---|---|
| `register(stake)` | Any address (must approve `stakeAsset` first) | Locks stake; marks resolver `active`; adds to list |
| `increaseStake(additional)` | Registered resolvers only | Increases stake; can reactivate if deactivated |
| `unregister()` | Registered resolvers only | Returns full stake; removes from active list |
| `slash(resolver, amount)` | `owner` only (DAO/multisig) | Burns up to `amount` of stake; deactivates if below `minStake` |
| `setMinStake(newMinStake)` | `owner` only | Updates the activation threshold |
| `setSlashBeneficiary(addr)` | `owner` only | Updates the slash-proceeds recipient |
| `isActive(resolver)` | Anyone (view) | Returns `true` iff registered and stake ≥ `minStake` |
| `get(resolver)` | Anyone (view) | Returns full `ResolverInfo` struct |
| `list()` | Anyone (view) | Returns all registered resolver addresses |
| `getActiveResolvers()` | Anyone (view) | Returns `ResolverInfo[]` for active-only resolvers |
| `getBatchInfo(resolvers[])` | Anyone (view) | Batch `get()` in a single call |

The `owner` role is transferred via the `Ownable2Step` two-transaction handoff to prevent accidental ownership loss.

### Slashing Semantics

`slash` reduces a resolver's stake but does **not** remove them from the registry. The resolver stays registered (their address remains in `_resolverList`) but their `active` flag is set to `false` if their remaining stake falls below `minStake`. Resolvers can regain `active` status by calling `increaseStake`.

The owner can slash a resolver's entire stake in one call (the amount is capped at `info.stake` if `amount > info.stake`).

### Storage Invariants (ResolverRegistry)

These invariants are maintained by every state-mutating function and validated by inline `assert` statements in `register`, `unregister`, and `_removeFromList`:

| # | Invariant |
|---|---|
| I1 | `_resolverIndex[a] == 0` iff `a` is **not** in `_resolverList` (zero = absent; mapping is 1-based) |
| I2 | For every `a` with `_resolverIndex[a] != 0`: `_resolverList[_resolverIndex[a] - 1] == a` (round-trip identity) |
| I3 | `_resolvers[a].resolver == a` whenever `_resolverIndex[a] != 0` |
| I4 | `_resolvers[a]` is the zero-value struct whenever `_resolverIndex[a] == 0` (no orphaned records) |
| I5 | `_resolverList.length` equals the number of addresses for which `_resolverIndex[a] != 0` |

The `_removeFromList` helper uses swap-and-pop to maintain I1–I5 in O(1) without leaving gaps.

### Checks-Effects-Interactions (CEI) Order

All state-mutating functions commit **all** storage writes before any outgoing token transfer. This prevents reentrancy from observing stale state during the external call:

- `register`: writes `_resolvers`, `_resolverList`, `_resolverIndex` → then calls `safeTransferFrom`
- `unregister`: calls `_removeFromList` + `delete _resolvers` → then calls `safeTransfer`
- `slash`: updates `stake`, `active`, `totalSlashed`, `lastSlashAt` → then calls `safeTransfer` to beneficiary

---

## Finality Properties

| Property | Guarantee |
|---|---|
| Atomic settlement | A cross-chain swap either completes on both legs or neither leg is permanently stuck (permissionless refund after timelock) |
| Preimage non-repudiation | Once `claimOrder` succeeds, `preimageKeccak` is stored on-chain and the `OrderClaimed` event is emitted; the reveal cannot be denied |
| No admin rescue | Neither contract has a privileged path that can redirect or recover locked user funds |
| Resolver separation | Registry compromise is isolated from HTLC fund safety by design |

---

## Audit Notes

- **Reentrancy**: both contracts use OpenZeppelin `ReentrancyGuard`. All entry points that move funds are `nonReentrant`. CEI order is strictly observed in `ResolverRegistry`.
- **Integer overflow**: Solidity 0.8.x checked arithmetic is used throughout. `unchecked` is used only in `HTLCEscrow._orders` ID increment where overflow is impossible before 2^256 orders.
- **ERC-20 compatibility**: `SafeERC20` is used for all token transfers. Non-standard tokens (fee-on-transfer, rebasing) are out of scope and may behave unexpectedly.
- **Native ETH**: the `receive()` fallback in `HTLCEscrow` always reverts to prevent accidental ETH being locked without an order record.
