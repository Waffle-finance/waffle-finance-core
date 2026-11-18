# HTLCEscrow Replacement Runbook

**Audience:** Protocol operators with access to the deployer EOA/multisig and
the ability to update environment configuration for the coordinator and resolver
services.

**Scope:** This runbook covers deploying a replacement `HTLCEscrow`, switching
new order traffic to it, and waiting for old orders to settle or expire. It does
**not** cover `ResolverRegistry` replacement; the registry is separate and can
be pointed at from any escrow via `setResolverRegistry`.

**Non-goals:** This procedure never migrates, moves, or mutates user funds. Every
order locked in the old escrow remains independently claimable or refundable by
the parties named in that order. The only action taken on the old escrow is
observation.

---

## Background

`HTLCEscrow` holds one mutable contract reference — `resolverRegistry` — and
one immutable parameter — `minSafetyDeposit`. The registry pointer can be
updated via `setResolverRegistry` (owner-only), but `minSafetyDeposit` is
baked into the bytecode at construction and cannot be changed. Replacing the
escrow is therefore an operational (not an upgrade) procedure: you deploy a
fresh contract with the desired parameters, route new orders to it, and let the
old contract drain naturally as in-flight orders reach their terminal state
(`Claimed` or `Refunded`).

```
resolverRegistry   — mutable  (setResolverRegistry, owner-only)
minSafetyDeposit   — immutable (constructor arg, cannot change)
```

A replacement is warranted when you need to change `minSafetyDeposit`, when
the old bytecode requires a patch, or when governance decides to migrate to a
new registry that is not API-compatible with `setResolverRegistry`.

---

## Prerequisites

- Deployer account funded with enough ETH for two contract deployments
  plus verification calls (budget ≥ 0.05 ETH on mainnet).
- Environment variables for the target network populated (see
  `contracts/scripts/validateEnv.ts` and `env.example`):
  - `RELAYER_PRIVATE_KEY` — deployer key
  - `V2_STAKE_ASSET` — ERC20 address for resolver staking
  - `V2_MIN_STAKE` — minimum stake in wei
  - `V2_MIN_SAFETY_DEPOSIT` — new minimum safety deposit in wei (may differ from old)
- Shell access to the `contracts/` workspace with `pnpm` and Node available.
- Read access to the existing `deployments.<network>.json` at the repo root
  (written by the original deployment).

---

## Step 1 — Preflight: verify the current deployment

Confirm the old escrow address and its immutable `minSafetyDeposit`, and count
in-flight orders before doing anything.

```bash
# From contracts/
pnpm hardhat run scripts/validate-deployment.ts --network <network>
```

The script reads `deployments.<network>.json` and verifies:

1. `HTLCEscrow` has bytecode at the recorded address.
2. `HTLCEscrow.resolverRegistry()` matches the recorded `ResolverRegistry`
   address.
3. Chain ID matches the RPC endpoint.

**Stop condition:** if the script exits non-zero, do not proceed until the
discrepancy is resolved. A mismatch here indicates the artifact file is stale
or the RPC endpoint is wrong.

Capture the old escrow address for use throughout the runbook:

```bash
OLD_ESCROW=$(jq -r '.ethereum.htlcEscrow' deployments.<network>.json)
echo "Old escrow: $OLD_ESCROW"
```

---

## Step 2 — Count in-flight orders on the old escrow

An in-flight order is any order whose `status == Funded`. Query the next
order ID, then check each order:

```bash
# Using cast (Foundry) against the live network
# nextOrderId() — returns the next ID to be assigned, so active IDs are [1, nextOrderId)
cast call $OLD_ESCROW "nextOrderId()(uint256)" --rpc-url $ETHEREUM_RPC_URL
```

Record the value as `NEXT_ID`. If `NEXT_ID == 1` there are no orders and you
may skip directly to Step 5.

To count funded orders (requires a brief script or a block explorer):

```bash
# Quick check via the validate-deployment script logs, or query manually:
for i in $(seq 1 $((NEXT_ID - 1))); do
  STATUS=$(cast call $OLD_ESCROW "getOrder(uint256)((address,address,address,address,uint256,uint256,bytes32,uint64,uint64,uint64,uint8,bytes32))" $i --rpc-url $ETHEREUM_RPC_URL | awk -F, '{print $11}')
  [ "$STATUS" = "0" ] && echo "Order $i is Funded"
done
```

**Stop condition:** if `FUNDED_COUNT > 50`, treat the rollover as a migration
and engage the full governance process before proceeding. A large number of
active orders means users are currently mid-swap; the window for a clean
cutover is not open yet. Wait and re-check.

---

## Step 3 — Deploy the replacement escrow

Deploy a new `HTLCEscrow` pointing at the same (or new) `ResolverRegistry`
and with the updated `minSafetyDeposit`:

```bash
# From contracts/
pnpm hardhat run scripts/deploy.ts --network <network>
```

The deploy script:

1. Runs `runPreflightChecks` — validates all env vars before spending gas.
2. Deploys `ResolverRegistry` (re-deploys only if `V2_STAKE_ASSET` or
   `V2_MIN_STAKE` differs; otherwise you can repoint the escrow manually — see
   Step 4b).
3. Deploys `HTLCEscrow` with the new registry address and `V2_MIN_SAFETY_DEPOSIT`.
4. Reads back `resolverRegistry()` and `minSafetyDeposit()` from the deployed
   contract and asserts they match the input parameters.
5. Writes `deployments.<network>.json` with `ethereum.htlcEscrow` set to the
   **new** address.

The old escrow address is preserved as `ethereum.htlcEscrow` in the previous
artifact. If you want to retain it explicitly, copy it before running:

```bash
cp deployments.<network>.json deployments.<network>.old.json
```

---

## Step 4 — Verify the new deployment

```bash
pnpm hardhat run scripts/validate-deployment.ts --network <network>
```

This re-runs the validation against the updated `deployments.<network>.json`
and asserts the new escrow has the expected registry and immutable parameters.

Verify the new escrow's registry pointer manually:

```bash
NEW_ESCROW=$(jq -r '.ethereum.htlcEscrow' deployments.<network>.json)
cast call $NEW_ESCROW "resolverRegistry()(address)" --rpc-url $ETHEREUM_RPC_URL
cast call $NEW_ESCROW "minSafetyDeposit()(uint256)" --rpc-url $ETHEREUM_RPC_URL
```

**Stop condition:** if either value does not match what you intended, do **not**
proceed. The deployment is corrupt or the wrong artifact was used. Re-run
Step 3 with corrected env vars.

---

## Step 5 — Switch new orders to the replacement escrow

The coordinator and resolver services read the escrow address from environment
variables. Update these in your deployment environment (secrets manager, `.env`,
Kubernetes ConfigMap, etc.):

| Service      | Variable (testnet)             | Variable (mainnet)              |
| ------------ | ------------------------------ | ------------------------------- |
| coordinator  | `ETH_HTLC_ESCROW_TESTNET`      | `ETH_HTLC_ESCROW_MAINNET`       |
| resolver     | `ETH_HTLC_ESCROW_TESTNET`      | `ETH_HTLC_ESCROW_MAINNET`       |

Set each to the **new** escrow address:

```bash
NEW_ESCROW=$(jq -r '.ethereum.htlcEscrow' deployments.<network>.json)
# Example: export or write to secrets manager
echo "ETH_HTLC_ESCROW_<NETWORK>=$NEW_ESCROW"
```

Restart or hot-reload the coordinator and resolver processes so they pick up the
new value. After restart, confirm with:

```bash
# Coordinator health endpoint
curl -s <COORDINATOR_URL>/healthz | jq .

# Resolver readiness
curl -s <RESOLVER_URL>/readyz | jq .
```

Both should report `ok: true` (or equivalent). The resolver log should contain
a line referencing the new escrow address.

---

## Step 6 — Post-switch checks

Once traffic is routing to the new escrow, verify that no new orders are being
created on the old one:

```bash
# Poll nextOrderId on the old escrow — it must not increase
OLD_ID_BEFORE=$(cast call $OLD_ESCROW "nextOrderId()(uint256)" --rpc-url $ETHEREUM_RPC_URL)
sleep 60
OLD_ID_AFTER=$(cast call $OLD_ESCROW "nextOrderId()(uint256)" --rpc-url $ETHEREUM_RPC_URL)
[ "$OLD_ID_BEFORE" = "$OLD_ID_AFTER" ] && echo "✅ No new orders on old escrow" || echo "⚠️  New orders detected on old escrow — config update may not have propagated"
```

Verify new orders are landing on the new escrow:

```bash
NEW_ID=$(cast call $NEW_ESCROW "nextOrderId()(uint256)" --rpc-url $ETHEREUM_RPC_URL)
echo "New escrow next order ID: $NEW_ID"
# This should increment during normal swap activity
```

---

## Step 7 — Monitor the old escrow until it drains

Old escrow orders remain claimable/refundable permissionlessly. No operator
action is required; users and resolvers can claim or refund directly. The
maximum time any order can remain locked is `MAX_TIMELOCK = 24 hours` (constant
in `HTLCEscrow.sol`).

Monitor funded orders until the count reaches zero:

```bash
NEXT_ID=$(cast call $OLD_ESCROW "nextOrderId()(uint256)" --rpc-url $ETHEREUM_RPC_URL)
FUNDED=0
for i in $(seq 1 $((NEXT_ID - 1))); do
  STATUS=$(cast call $OLD_ESCROW "getOrder(uint256)((address,address,address,address,uint256,uint256,bytes32,uint64,uint64,uint64,uint8,bytes32))" $i --rpc-url $ETHEREUM_RPC_URL | awk -F, '{print $11}')
  [ "$STATUS" = "0" ] && FUNDED=$((FUNDED + 1))
done
echo "Funded orders remaining: $FUNDED"
```

When `FUNDED == 0` the old escrow holds no locked funds and the migration is
complete. Verify the contract balance is zero:

```bash
cast balance $OLD_ESCROW --rpc-url $ETHEREUM_RPC_URL
```

A non-zero balance with `FUNDED == 0` means there are uncollected
`pendingWithdrawals` credits. These are always owned by the credited address
and recoverable via `withdraw()`. The operator cannot and must not touch them.

---

## Step 8 — Archive the old escrow reference

Move the old deployment artifact to a permanent record so auditors and
monitoring can verify historic addresses:

```bash
# Append to CHANGES.md or a dedicated deployments history file
echo "## $(date -u +%Y-%m-%d) — HTLCEscrow replacement on <network>" >> CHANGES.md
echo "Old: $OLD_ESCROW" >> CHANGES.md
echo "New: $NEW_ESCROW" >> CHANGES.md
```

---

## Safety constraints

| Constraint | Rationale |
|---|---|
| Never call `selfdestruct` or any admin function on the old escrow | There is no such function — the contract has no admin escape hatch by design. |
| Never attempt to move funds out of the old escrow | Locked funds are non-custodial. The only exits are `claimOrder` (by the beneficiary/relayer) and `refundOrder` (by anyone after expiry). |
| Never set `ETH_HTLC_ESCROW_*` to a zero address or random EOA | The resolver and coordinator use this value to subscribe to on-chain events; a wrong address silently drops events. |
| Do not decommission the old escrow address from monitoring | Keep it in block-explorer watchlists until its ETH balance is zero. |
| Do not proceed past Step 2 stop condition | A high in-flight order count means real user funds are at risk from a disorderly cutover. |
