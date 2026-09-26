# Upgrade and Migration Safety

**Status:** Active — reviewed for production readiness.
**Owner:** Protocol Engineering
**Covers:** HTLCEscrow (EVM), Soroban HTLC (Stellar), Solana IDL (Solana)

---

## Overview

WaffleFinance is a non-custodial cross-chain bridge. Every upgrade decision must
preserve two invariants:

1. **Funds safety** — locked funds can only move by correct preimage reveal or
   timelock expiry. No admin, operator, or upgrade can redirect them.
2. **Liveness** — a user must always be able to claim or refund an active order,
   even if the protocol is paused, being upgraded, or the coordinator is offline.

This document defines the upgrade boundaries for each chain implementation,
the constraints operators must respect, and the migration procedures for
schema-level changes.

---

## Ethereum — HTLCEscrow

### Deployment model

`HTLCEscrow` is an **immutable, non-upgradeable contract** — there is no proxy
pattern, no `delegatecall` dispatcher, and no `SELFDESTRUCT`. A new version is
deployed as a new contract at a new address.

### Mutable parameters

| Parameter            | Type          | Mutability          | Guard                 |
|----------------------|---------------|---------------------|-----------------------|
| `resolverRegistry`   | `address`     | Owner-settable      | `onlyOwner`, non-zero |
| `minSafetyDeposit`   | `uint256`     | **Immutable**       | Set at construction   |
| `MIN_TIMELOCK`       | `uint64`      | **Constant**        | Cannot change         |
| `MAX_TIMELOCK`       | `uint64`      | **Constant**        | Cannot change         |
| `PAYOUT_GAS_STIPEND` | `uint256`     | **Constant**        | Cannot change         |

**Key constraints:**

- `minSafetyDeposit` is declared `immutable` in Solidity. It can never be
  changed without deploying a new contract. Deployments with different minimum
  deposits are different contracts at different addresses.
- `resolverRegistry` can only be set to a **non-zero** address. Clearing it to
  `address(0)` at runtime is intentionally blocked to prevent accidental
  removal of the sybil gate. To make `createOrder` permissionless, deploy with
  `address(0)` at construction time.
- The registry can only be updated by the current `owner`. Ownership follows
  `Ownable2Step`: transfer must be accepted by the new owner before it takes
  effect. Renouncing ownership permanently locks `setResolverRegistry`.

### Upgrade procedure

To upgrade `HTLCEscrow`:

1. Deploy a new `HTLCEscrow` contract with updated constructor arguments.
2. Update the coordinator and relayer configuration to point to the new address.
3. Drain active orders from the old contract naturally (claim/refund completes).
4. Once the old contract has no funded orders, stop monitoring it.
5. Update `deployments.<network>.json` with the new contract address.
6. Run `pnpm hardhat run scripts/validate-deployment.ts --network <network>` to
   verify the new deployment.

**Do not use `selfdestruct` or similar on the old contract.** Active orders
must still be settleable even after the coordinator switches to the new
contract.

### What is prohibited

- Any proxy pattern that allows logic replacement while preserving the same
  address. This breaks the non-custodial trust model because the upgraded logic
  could introduce an admin escape hatch.
- Adding `emergencyWithdraw`, `pause` affecting claim/refund, or any function
  that moves locked funds without the preimage or timelock constraint.
- Lowering `MIN_TIMELOCK` below 300 seconds. Users rely on this for the minimum
  claim window.

---

## Soroban — HTLC Contract

### Deployment model

Soroban contracts are **upgradeable via `WASM` hash replacement**. The contract
binary can be updated while the persistent storage (orders, config) remains at
the same contract address. This makes schema management critical.

### Schema versioning

The contract tracks a `SchemaVersion` in instance storage (see
`soroban/contracts/htlc/src/migration.rs`). Every state-reading entry point
calls `require_current_schema()` before deserialising any `Order`. A schema
mismatch panics with `Error::SchemaMismatch` rather than silently
mis-deserialising.

| Version | Description                                         |
|---------|-----------------------------------------------------|
| V0      | Pre-versioning baseline (no `SchemaVersion` key).   |
| V1      | Current layout: all fields in `Order` as shipped.   |

### Migration procedure

When a breaking change to `Order` layout is required:

1. Add a new `SchemaVersion::VN` variant.
2. Add an `OrderV(N-1)` snapshot struct with the **old** field layout.
3. Implement `From<OrderV(N-1)> for Order`.
4. Extend `execute_migration`'s dispatch table with the `V(N-1)→VN` arm.
5. Add a test in `harness.rs` that plants V(N-1) bytes and verifies
   post-migration correctness.
6. Deploy the new WASM.
7. Call `migrate_orders(start_id, end_id, finalize=false)` in batches to
   process all active orders without exceeding the per-transaction
   instruction budget.
8. On the final batch, pass `finalize=true` to atomically bump the schema
   version and emit the `("migration","schema")` event.
9. Verify via `schema_version()` and `check_config_keys()` that the on-chain
   state is consistent.

**Key properties of the migration framework:**

- **Idempotent**: calling `migrate_orders` with the same target version twice
  is a no-op (returns `AlreadyMigrated`).
- **Resumable**: if a batch panics mid-run, the schema version is not bumped.
  The admin can retry from any `start_id`.
- **Auditable**: every successful finalization emits
  `("migration","schema") → (from_version, to_version, migrated_count)`.

### Mutable parameters

| Parameter            | Mutability          | Guard                           |
|----------------------|---------------------|---------------------------------|
| `admin`              | Two-step transfer   | `transfer_admin` + `accept_admin` |
| `min_safety_deposit` | Admin-settable      | `set_config`, admin auth        |
| `contract_mode`      | Admin-settable      | `set_mode`, admin auth          |
| WASM binary          | Upgradeable         | Soroban `update_current_contract_wasm` |

### What is prohibited

- Deploying a new WASM that changes the `Order` layout without bumping the
  schema version. The `require_current_schema()` guard will block all reads.
- Setting `contract_mode` to `Paused` in a way that prevents `refund_order`.
  The contract enforces that `refund_order` remains accessible in `Maintenance`
  mode so users can always recover locked funds.

### TTL / archival safety

Order entries have a TTL derived from `timelock_seconds + ORDER_TTL_MARGIN_LEDGERS`
(~14 days). If a contract sits idle past the instance TTL (~30 days), restore
it with a standard `RestoreFootprint` operation before resuming operations.
No funds are lost by archival — only liveness is affected until restoration.

---

## Solana — HTLC Program

### Deployment model

The Solana program is currently in **simulation mode** — only SDK/IDL stubs are
present in this repository. When the on-chain Anchor program is deployed:

- Program upgrades follow Solana's BPF loader upgrade mechanism.
- The program authority controls upgrades; use a multisig for production.
- IDL version mismatches are surfaced by the SDK as `chain_error` with message
  "Solana IDL version mismatch — upgrade the SDK".

### Approval model

Solana SPL token transfers use a delegate authority embedded in the Anchor
instruction accounts. No explicit `approve` transaction is required from SDK
callers. See `APPROVAL_SEMANTICS.solana` in `packages/sdk/src/approval.ts`.

---

## Trust Model Summary

Across all three chains, the following invariants must hold at all times:

| Invariant                                  | EVM                     | Soroban                   | Solana           |
|--------------------------------------------|-------------------------|---------------------------|------------------|
| Claim is permissionless                    | Yes (anyone can submit) | Yes (caller arg)          | Yes (program)    |
| Refund is permissionless after expiry      | Yes                     | Yes (Maintenance allows)  | Yes              |
| Admin cannot move locked funds             | Yes (no escape hatch)   | Yes (hashlock enforced)   | Yes (program)    |
| Upgrade does not affect active orders      | N/A (new contract)      | Migration preserves state | Program upgrade  |
| Non-custodial: funds only exit via HTLC    | Yes                     | Yes                       | Yes              |

---

## Operator checklist before any production upgrade

- [ ] Review the diff for any new admin escape hatch, emergencyWithdraw, or
      pause that affects claim/refund.
- [ ] Confirm `minSafetyDeposit` is correct for the target network (EVM only).
- [ ] For Soroban: confirm schema version is bumped and migration tested on
      testnet with representative V(N-1) data.
- [ ] Run `pnpm validate:docs` to confirm no broken links in release docs.
- [ ] Run `contracts/scripts/check-upgrade.ts` to compare ABI compatibility
      against the previous deployment.
- [ ] Confirm all three SDK adapters are updated to handle any new error codes
      or ABI changes introduced by the upgrade.
- [ ] Verify `deployments.<network>.json` is updated after the new contract
      deploys.

See also: `docs/RELEASE_CHECKLIST_MULTI_PACKAGE.md` for cross-package impact
tracking.
