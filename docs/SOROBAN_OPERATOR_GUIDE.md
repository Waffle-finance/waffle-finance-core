# Soroban Operator Guide

**Audience**: Platform engineers and SREs deploying and operating WaffleFinance on Stellar.

---

## Table of Contents

1. [Trust Model](#trust-model)
2. [Contract Lifecycle](#contract-lifecycle)
3. [Network Assumptions](#network-assumptions)
4. [Startup Validation and Readiness Checks](#startup-validation-and-readiness-checks)
5. [RPC Degradation Behaviour](#rpc-degradation-behaviour)
6. [Resolver Registry Enforcement](#resolver-registry-enforcement)
7. [Testnet Deployment Verification](#testnet-deployment-verification)
8. [Mainnet Deployment Verification](#mainnet-deployment-verification)
9. [Recovery Procedures](#recovery-procedures)

---

## Trust Model

The WaffleFinance Soroban HTLC enforces the same atomicity guarantee as the EVM contracts: locked funds can only move when a cryptographic condition is satisfied. No party — including the coordinator, the admin, or any resolver — can move funds without meeting one of the two on-chain conditions.

| Actor | Permitted | Not permitted |
|---|---|---|
| **User (sender)** | Lock funds via `create_order`, claim with preimage, trigger refund after timelock | Claim without valid preimage; refund before timelock |
| **Beneficiary** | Claim by calling `claim_order` with the correct preimage | Claim after timelock expiry; alter the locked amount |
| **Resolver** | Fill orders permissionlessly by providing the preimage, stake/unstake in registry | Steal stake of other resolvers; claim without valid preimage |
| **Coordinator** | Observe events, relay secrets, run reference resolver | Move locked funds; sign on behalf of users |
| **Admin** | Update min safety deposit, set resolver registry address | Move locked HTLC funds; bypass timelock; alter an existing order |

### Key invariant

Once an order is created on Soroban, neither the admin nor the coordinator can unilaterally alter or spend it. The contract never holds custodial discretion. This is enforced entirely by the contract code and is verifiable on-chain.

---

## Contract Lifecycle

### Phase 1: Build

```bash
cd soroban
stellar contract build
# Artefacts: target/wasm32-unknown-unknown/release/*.wasm
```

Run the test suite to confirm no regressions before deploying:

```bash
cargo test --workspace
```

### Phase 2: Install (upload WASM to network)

```bash
stellar contract install \
  --network testnet \               # or mainnet
  --source deployer \
  --wasm target/wasm32-unknown-unknown/release/wafflefinance_htlc.wasm
# Prints a wasm hash — record it for the deploy step
```

### Phase 3: Deploy

The constructor sets all config atomically, eliminating the front-running window present in two-step init patterns:

```bash
HTLC_ID=$(stellar contract deploy \
  --network testnet \
  --source deployer \
  --wasm target/wasm32-unknown-unknown/release/wafflefinance_htlc.wasm \
  -- \
  --admin $(stellar keys address deployer) \
  --min_safety_deposit 1000000)

echo "HTLC contract: $HTLC_ID"
```

Record the contract ID. On testnet use `SOROBAN_HTLC_TESTNET`; on mainnet use `SOROBAN_HTLC_MAINNET`.

Repeat for the resolver registry:

```bash
REGISTRY_ID=$(stellar contract deploy \
  --network testnet \
  --source deployer \
  --wasm target/wasm32-unknown-unknown/release/wafflefinance_resolver_registry.wasm \
  -- \
  --admin $(stellar keys address deployer) \
  --min_stake 10000000)
```

### Phase 4: Wire registry into HTLC

```bash
stellar contract invoke \
  --network testnet \
  --source deployer \
  --id "$HTLC_ID" \
  -- set_resolver_registry --registry "$REGISTRY_ID"
```

### Phase 5: Regenerate TypeScript bindings

After any contract upgrade or first deployment:

```bash
stellar contract bindings typescript \
  --network testnet \
  --contract-id "$HTLC_ID" \
  --output-dir ../packages/sdk/src/soroban/htlc-bindings
```

### Phase 6: Admin handover (two-step)

Admin handover is intentionally two-step to prevent accidental lockout:

```bash
# Step 1: initiate transfer
stellar contract invoke --id "$HTLC_ID" --source deployer \
  -- transfer_admin --new_admin "$NEW_ADMIN"

# Step 2: new admin accepts (must be signed by the new admin key)
stellar contract invoke --id "$HTLC_ID" --source new-admin \
  -- accept_admin

# Emergency escape: revoke a pending transfer before it is accepted
stellar contract invoke --id "$HTLC_ID" --source deployer \
  -- revoke_pending_admin
```

Every admin mutation emits an event (`adm_xfer` / `cfg` topics) with old and new values for audit trails.

---

## Network Assumptions

### Ledger close time

Soroban ledgers close roughly every 5 seconds. Timelock values in seconds are converted to ledger counts using a conservative 3-second minimum close time (faster assumed close = more ledger headroom). This means a 3600-second (1-hour) timelock corresponds to approximately 1200 ledgers minimum.

### TTL and archival

Soroban archives ledger entries whose TTL (time-to-live, measured in ledgers) expires. WaffleFinance manages TTLs proactively:

- **Instance storage** (admin, config) is re-extended on every state-mutating call, keeping the contract live for ~30 days (≈720,000 ledgers) after any activity.
- **Order entries** get a TTL at creation: `ceil(timelockSeconds / 3) + ORDER_TTL_MARGIN_LEDGERS` (≈14 days safety margin). This keeps each order alive through its claim window and through the post-expiry refund window.
- **Claimed/refunded entries** are re-extended after settlement, keeping records queryable by indexers for ~30 days.

If a contract is left completely idle and its instance TTL expires, no funds are lost. Archived entries can be restored using a `RestoreFootprint` operation (paying the rent bump), after which claim and refund proceed normally under the original conditions.

**Public `extend_order_ttl` entrypoint**: permissionless; anyone can call it to bump a live order's TTL. Use this when a claim window risks straddling an archival boundary (e.g. after a long period of elevated network activity that drained TTL budgets).

```bash
stellar contract invoke --id "$HTLC_ID" \
  -- extend_order_ttl --order_id 42
```

### Minimum account balance (XLM reserve)

Every Soroban transaction requires the source account to hold enough XLM to cover:

- The transaction fee (dynamic; scales with resource usage)
- The **minimum balance**: `(2 + subentry_count) × 0.5 XLM` base reserve

A `tx_insufficient_balance` error at submission time means the relayer or resolver account needs to be topped up. The SDK maps this to `HTLCError(tx_rejected, retryable=false)` with a message that names the source account and the reserve formula.

---

## Startup Validation and Readiness Checks

### Config validation (fail-fast at startup)

All services call `validateSorobanChainConfig()` (from `@wafflefinance/config`) during startup. A misconfigured deployment fails immediately with a descriptive error list rather than starting and silently failing on first use.

Required fields that must be non-placeholder at startup:

| Env var | Description |
|---|---|
| `SOROBAN_RPC_URL` | Soroban RPC endpoint (`https://soroban-testnet.stellar.org` or `https://mainnet.sorobanrpc.com`) |
| `STELLAR_HORIZON_URL` | Stellar Horizon endpoint |
| `STELLAR_NETWORK_PASSPHRASE` | Must exactly match `NETWORK_MODE` — testnet and mainnet passphrases are not interchangeable |
| `NETWORK_MODE` | `testnet` or `mainnet` — drives passphrase and chain ID validation |

Optional fields that disable the corresponding feature if absent (no error, warning only):

| Env var | Effect when absent |
|---|---|
| `SOROBAN_HTLC_TESTNET` / `SOROBAN_HTLC_MAINNET` | Soroban settlement flows disabled |
| `SOROBAN_RESOLVER_REGISTRY_TESTNET` / `SOROBAN_RESOLVER_REGISTRY_MAINNET` | On-chain resolver lookup disabled |

### Readiness probe

The `/readyz` endpoint (coordinator: port 3000) includes a `soroban_rpc` check:

```bash
curl http://coordinator:3000/readyz | jq '.checks[] | select(.name=="soroban_rpc")'
```

Expected response when healthy:

```json
{ "name": "soroban_rpc", "ok": true, "latencyMs": 42 }
```

The coordinator exposes the following startup phases via the `startup_phase` check:

| Phase | Meaning |
|---|---|
| `starting` | Dependencies (DB, RPC nodes) still being waited on. `/readyz` returns 503. |
| `pending` | All deps are up; first reconciliation pass not yet complete. |
| `ready` | All checks pass; fully operational. |
| `degraded` | One or more dependency checks failing after prior `ready` state. |

### Minimum Soroban readiness checklist

Before routing live traffic to a new deployment:

- [ ] `/readyz` returns 200 with `soroban_rpc.ok=true`
- [ ] Config validation passes with no errors (warnings for absent optional contracts are acceptable)
- [ ] The HTLC contract is reachable: `stellar contract invoke --id $HTLC_ID -- version_info`
- [ ] Resolver registry is reachable: `stellar contract invoke --id $REGISTRY_ID -- version_info`
- [ ] Source account (relayer/resolver) holds at least 5 XLM above the minimum reserve
- [ ] `STELLAR_NETWORK_PASSPHRASE` matches the deployed network

---

## RPC Degradation Behaviour

### Soroban RPC unavailable

When the Soroban RPC endpoint is unreachable, the coordinator's `soroban_rpc` readiness check returns `ok=false` and the startup phase transitions to `degraded`. The coordinator continues processing Ethereum events; new Soroban orders will not be indexed until the RPC recovers.

The Soroban listener maintains a checkpoint cursor. On RPC recovery it replays up to `MAX_REPLAY_LEDGERS` (34,560 ≈ 48 hours) from the last known good cursor. Events older than the replay window are considered permanently missed; an incident should be filed and the reconciler consulted for affected orders.

### Horizon unavailable

Horizon is used for XLM payment submission (refunds and safety deposit settlements). The relayer classifies Horizon errors as:

| Error type | Behaviour |
|---|---|
| `HorizonTimeoutError` (504/408/ECONNABORTED) | Transaction may have landed. Marked **ambiguous**; watchdog resolves later. Do not retry immediately. |
| `HorizonTerminalError` | Definitive rejection. Alert operator. No retry. |
| `HorizonTransientError` | Transient (5xx, connection). Already retried internally with exponential back-off. |

### Soroban RPC congestion (`TRY_AGAIN_LATER`)

The SDK orchestrator retries `TRY_AGAIN_LATER` responses up to `maxRetries` times (default: 3) with a configurable delay. If the RPC remains congested past the retry budget, the call surfaces as `HTLCError(chain_error, retryable=false)`. The coordinator will leave the order in `pending` state for the next reconciliation cycle.

### Fee pressure (`tx_insufficient_fee`)

The orchestrator automatically fee-bumps when the network rejects a transaction for insufficient fee. The fee is multiplied by `feeBumpMultiplier` (default: 2) on each bump attempt, up to `feeBumpCap` (default: 1,000,000 stroops ≈ 0.1 XLM). If the cap is exceeded, the call fails with `HTLCError(tx_rejected)` and `submissionMeta.feeBumpHistory` records every attempted fee.

To raise the cap for a service under persistent fee pressure:

```ts
// In the service's SorobanHTLCClient constructor:
orchestration: {
  feeBumpCap: 5_000_000,     // 0.5 XLM
  feeBumpMultiplier: 1.5,
}
```

---

## Resolver Registry Enforcement

The HTLC contract optionally enforces that only registered resolvers can call `claim_order`. This is controlled by the resolver registry address set on the contract.

### Check current enforcement mode

```bash
stellar contract invoke --id "$HTLC_ID" -- version_info
# Returns admin, min_safety_deposit, resolver_registry (null = enforcement off)
```

### Enable registry enforcement

```bash
stellar contract invoke \
  --id "$HTLC_ID" \
  --source deployer \
  -- set_resolver_registry --registry "$REGISTRY_ID"
```

Once set, only accounts staked in the resolver registry can call `claim_order`. Calls from unregistered accounts return `Error(ResolverNotAuthorised)`, which the SDK maps to `HTLCError(simulation_failed, retryable=false)`.

### Register a resolver

```bash
stellar contract invoke \
  --id "$REGISTRY_ID" \
  --source my-resolver \
  -- register --resolver $(stellar keys address my-resolver) --stake 10000000
```

### Verify resolver registration

```bash
stellar contract invoke \
  --id "$REGISTRY_ID" \
  -- is_registered --resolver $(stellar keys address my-resolver)
```

---

## Testnet Deployment Verification

Run these commands immediately after a testnet deployment:

```bash
# 1. Confirm contract is reachable and schema version matches the SDK
stellar contract invoke --network testnet --id "$SOROBAN_HTLC_TESTNET" \
  -- schema_version
# Expected: current schema integer (e.g. 1)

# 2. Verify contract config
stellar contract invoke --network testnet --id "$SOROBAN_HTLC_TESTNET" \
  -- version_info
# Prints admin address, min_safety_deposit, resolver_registry

# 3. Confirm the coordinator can reach the RPC
curl -s https://soroban-testnet.stellar.org \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' | jq .result

# 4. Create a test order (use the SDK e2e helpers or stellar CLI)
# See e2e/health/HEALTH_ENDPOINTS.md for the smoke-test contract

# 5. Check coordinator readiness
curl http://localhost:3000/readyz | jq .
# Expect: soroban_rpc.ok=true, startup_phase.detail=ready (or absent in healthy state)

# 6. Verify config report at startup (coordinator logs)
grep "Soroban/chain configuration report" coordinator.log
```

---

## Mainnet Deployment Verification

All testnet checks apply. Additional mainnet-specific steps:

```bash
# 1. Confirm HTTPS endpoints are in use (plain HTTP is rejected in mainnet mode)
echo "$SOROBAN_RPC_URL" | grep -q "^https://" || echo "ERROR: non-HTTPS mainnet RPC"

# 2. Confirm the network passphrase matches mainnet
# STELLAR_NETWORK_PASSPHRASE must equal exactly:
# "Public Global Stellar Network ; September 2015"

# 3. Confirm the correct Ethereum chain ID (1 for Ethereum mainnet)
# NETWORK_MODE=mainnet expects chainId=1; Sepolia (11155111) will be rejected

# 4. Verify the HTLC contract is deployed on Stellar mainnet
stellar contract invoke --network mainnet --id "$SOROBAN_HTLC_MAINNET" \
  -- schema_version

# 5. Verify relayer / resolver accounts have sufficient XLM reserves
stellar account show $(stellar keys address relayer) --network mainnet \
  | grep balance
# Ensure balance > (2 + subentry_count) × 0.5 XLM + expected transaction costs

# 6. Confirm resolver is registered (if registry enforcement is active)
stellar contract invoke --network mainnet --id "$SOROBAN_RESOLVER_REGISTRY_MAINNET" \
  -- is_registered --resolver $(stellar keys address resolver)
```

---

## Recovery Procedures

### Archived contract entry

If a `claim_order` or `refund_order` call returns `Error(SchemaMismatch)` or a low-level archival error:

```bash
# Restore the archived instance/entry (pays rent bump)
stellar contract restore \
  --network testnet \
  --source deployer \
  --id "$HTLC_ID"
```

After restoration the original hashlock and timelock rules remain in effect. Claim and refund proceed normally.

### Archived order entry

If a specific order is archived (rare — would require the order to outlive its TTL margin):

```bash
# Extend the TTL of a live order proactively
stellar contract invoke --id "$HTLC_ID" \
  -- extend_order_ttl --order_id <ORDER_ID>

# Or restore a specifically archived order key (advanced)
stellar ledger restore-footprint --network testnet --source deployer \
  -- <contract-key-xdr>
```

### Stuck pending order (RPC outage recovery)

1. Confirm the coordinator's Soroban listener cursor: check the `soroban_checkpoints` table.
2. If ledger gap exceeds `MAX_REPLAY_LEDGERS` (34,560 ≈ 48 hours), events in the gap are missed. Run the reconciler against on-chain state:
   ```bash
   pnpm --filter coordinator reconcile --from-ledger <last_good_ledger>
   ```
3. For orders stuck in `src_locked` (Soroban side locked, Ethereum not yet claimed), check whether the preimage was revealed on-chain and re-run the settlement path manually via the coordinator API.

### Refund failing with `tx_insufficient_balance`

The relayer or resolver source account is below the minimum XLM reserve.

```bash
# Check current balance
stellar account show <SOURCE_ACCOUNT> --network testnet

# Fund via Friendbot (testnet only)
curl "https://friendbot.stellar.org/?addr=<SOURCE_ACCOUNT>"

# Fund manually (mainnet)
# Transfer at least 5 XLM above the minimum reserve to <SOURCE_ACCOUNT>
```

The minimum safe balance formula: `(2 + num_subentries) × 0.5 XLM + 1 XLM buffer`.

### Refund failing with `tx_bad_auth`

The signing key does not match the source account.

1. Verify `RELAYER_STELLAR_SECRET` matches the public key of the relayer account.
2. Check that the account's signers list has not been modified (multi-sig configuration).
3. Confirm `STELLAR_NETWORK_PASSPHRASE` matches the network being targeted.

```bash
# Check account signers
stellar account show <SOURCE_ACCOUNT> --network testnet | grep signer
```

### Schema mismatch after contract upgrade

If `migrate_orders` needs to be run after an upgrade:

```bash
# Run a batch (100 orders per call to stay within Soroban resource limits)
stellar contract invoke --id "$HTLC_ID" --source deployer \
  -- migrate_orders --batch_size 100
# Repeat until it returns MigrationComplete
```

The final batch emits a `("migration","schema")` event on-chain for audit.

---

## Related Documents

- [HTLC IDL Reference](../soroban/docs/HTLC_IDL.md) — contract entrypoints, types, storage schemas
- [Soroban README](../soroban/README.md) — build, test, deploy commands
- [Soroban Event Parser](../coordinator/README.SOROBAN_EVENT_PARSER.md) — event decoding design
- [Coordinator Runbook](../coordinator/ops/RUNBOOK.md) — monitoring, alerting, dashboards
- [RPC Degradation Test Matrix](./RPC_DEGRADATION_TEST_MATRIX.md) — failure scenario coverage
- [Health Endpoints](../e2e/health/HEALTH_ENDPOINTS.md) — readiness probe reference
