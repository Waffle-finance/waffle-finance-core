# Operations Runbooks

This document provides operational guidance for deploying, monitoring, and troubleshooting WaffleFinance services.

For a rollback-first, step-by-step procedure specific to redeploying the coordinator and relayer (config changes, restart verification, secret rotation, rollback triggers), see [docs/DEPLOYMENT_ROLLBACK_RUNBOOK.md](DEPLOYMENT_ROLLBACK_RUNBOOK.md), which builds on the Rollback Procedures and Monitoring Guide sections below.

For replacing the escrow (whose registry reference is immutable), including the values that change, how new order intake is gated while in-flight orders remain claimable or refundable on the old contract, the rollback point, and the dry-run validator, see [Escrow Replacement Migration](#escrow-replacement-migration).

---

## Table of Contents

- [Deployment Checklist](#deployment-checklist)
- [Pre-deployment Validation](#pre-deployment-validation)
- [Service Dependencies](#service-dependencies)
- [Incident Response](#incident-response)
- [Postmortem Process](#postmortem-process)
- [Rollback Procedures](#rollback-procedures)
- [Escrow Replacement Migration](#escrow-replacement-migration)
- [Monitoring Guide](#monitoring-guide)

---

## Deployment Checklist

Before deploying contracts or services, complete the following checklist:

### Environment Setup

1. **Set required environment variables:**

   ```bash
   # Required for deployment
   export RELAYER_PRIVATE_KEY="<your-deployer-private-key>"
   export V2_STAKE_ASSET="0x0000000000000000000000000000000000000000000000000000000000000000"  # ETH or ERC20
   export V2_MIN_STAKE="<min-stake-in-wei>"
   export V2_MIN_SAFETY_DEPOSIT="<min-safety-deposit-in-wei>"  # optional, defaults to 0
   export SOLANA_HTLC_PROGRAM_MAINNET="<solana-program-pubkey>"
   ```

2. **Verify RPC connectivity:**

   ```bash
   # Ethereum
   curl -X POST $ETHEREUM_RPC_URL -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'

   # Stellar Horizon
   curl "$STELLAR_HORIZON_URL" | head -1

   # Solana (primary & failover RPCs)
   curl -X POST $SOLANA_RPC_URL -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'
   ```

3. **Check deployer balance:**
   ```bash
   # Ethereum — Mainnet: at least 0.1 ETH; Sepolia: use faucet https://sepoliafaucet.com
   # Stellar — Testnet: friendbot; Mainnet: at least 50 XLM
   # Solana — Devnet: airdrop; Mainnet: at least 2.0 SOL for Program deploy + Order PDA rent buffers
   ```

4. **Review chain operator guides:**
   - Stellar / Soroban: see [docs/SOROBAN_OPERATOR_GUIDE.md](SOROBAN_OPERATOR_GUIDE.md)
   - Solana: see [docs/SOLANA_OPERATOR_GUIDE.md](SOLANA_OPERATOR_GUIDE.md) (devnet vs production gap audit, Anchor lifecycle, readiness gating, settlement checklist)

5. **Generate and store `SECRET_STORAGE_KEY`** — see the full guide below.

---

## Secret storage key generation and rotation

The coordinator encrypts HTLC preimages at rest using AES-256-GCM keyed by
`SECRET_STORAGE_KEY`.  If the variable is unset, preimages are stored
**unencrypted** — acceptable for local development only.  Always set it for
any environment that processes real swap orders.

### Key format

`SECRET_STORAGE_KEY` must be a **64-character lowercase hex string** encoding
exactly 32 bytes.  The coordinator's `deriveKey()` function also accepts a
44-character base64 string; the hex form is recommended because it is easier
to audit visually and is the format produced by the generation command below.

### Generating a key

Run the following command on your local machine or a trusted bastion host.
The output is written only to stdout — nothing is persisted to disk, logs, or
application state.

```bash
pnpm --filter @wafflefinance/coordinator generate-key
# example output (do not use this value):
# a3f1c2e9b4d07856f193a8d2c50be4671f82390e5a6c7b1d9e2f4a0c8d3b5e71
```

Alternatively, use `openssl` if pnpm is not available in the target
environment:

```bash
openssl rand -hex 32
```

Both commands produce an equivalent 64-character hex string.

**⚠️ Never commit the generated key to source control, paste it into a
PR description, or include it in CI logs.**

### Storing the key securely

Inject `SECRET_STORAGE_KEY` at process startup from a secrets manager:

| Platform | Example |
|---|---|
| AWS Secrets Manager | `aws secretsmanager get-secret-value --secret-id prod/coordinator/secret-storage-key --query SecretString --output text` |
| HashiCorp Vault | `vault kv get -field=value secret/coordinator/secret-storage-key` |
| DigitalOcean App Platform | Set as an encrypted environment variable in the app spec |
| Docker / Kubernetes | Mount as a secret and reference with `secretKeyRef` |

Do **not** write the key to a `.env` file that is committed or shared.
The `.env` on the server must be outside the repository checkout directory or
protected by strict filesystem permissions (`chmod 600`).

### Key rotation

Rotating the key requires a coordinated migration because existing rows were
encrypted with the old key:

1. Deploy the coordinator with **both** the old and new key available (using
   a temporary `SECRET_STORAGE_KEY_PREV` variable, plus application-level
   re-encryption logic, if you have implemented it — see TD-041).
2. Run the re-encryption migration job against the database backup.
3. Switch `SECRET_STORAGE_KEY` to the new value and restart the coordinator.
4. Verify the coordinator starts cleanly and can decrypt all stored preimages.
5. Revoke the old key from the secrets manager.

**Back up the database before rotation.**  Without the key that encrypted a
row, that preimage is unrecoverable.  Keep the old key available in the
secrets manager for at least 24 hours after a successful rotation.

---

## Pre-deployment Validation

### Validate Deployment Artifact

Before deploying to a network, validate the deployment artifact:

```bash
# Run validation against current network
pnpm --filter @wafflefinance/contracts exec hardhat run scripts/validate-deployment.ts --network sepolia

# Check upgrade compatibility
pnpm --filter @wafflefinance/contracts exec hardhat run scripts/check-upgrade.ts --network sepolia
```

### Validation Checks

The validation script performs:

1. **Chain ID verification** - Confirms RPC endpoint matches expected network
2. **Contract existence check** - Verifies previously deployed contracts are reachable
3. **Interface verification** - Confirms on-chain contract ABI matches source
4. **Configuration validation** - Checks stake asset and minimum values

---

## Service Dependencies

### Startup Order

Services must be started in this order:

```
1. Database (PostgreSQL or SQLite auto-created)
2. Contracts deployed and addresses in .env
3. Coordinator (depends on contracts)
4. Relayer (depends on coordinator)
5. Frontend (depends on coordinator)
6. Resolver (depends on contracts)
```

### Dependency Diagram

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Frontend  │────▶│ Coordinator │────▶│  Database   │
└─────────────┘     └─────────────┘     └─────────────┘
                         │
                         ▼
                    ┌─────────────┐
                    │   Relayer   │
                    └─────────────┘
                         │
                         ▼
       ┌─────────┬─────────────┬───────────┐
       ▼         ▼             ▼           ▼
   Ethereum   Stellar      Solana    ResolverRegistry
   Contracts   Contracts     Contracts
```

### Health Check Endpoints

| Service     | Endpoint                       | Description             |
| ----------- | ------------------------------ | ----------------------- |
| Coordinator | `GET /health`                  | Liveness check          |
| Coordinator | `GET /metrics`                 | Prometheus metrics      |
| Relayer     | `GET /api/health`              | Service health          |
| Relayer     | `GET /api/debug/chain-monitor` | Chain monitoring status |

---

## Incident Response

### Common Issues

#### RPC Errors (Transient)

**Symptom:** Resolver logs show "RPC call failed" messages, order processing stalls.

**Resolution:**

1. Check RPC endpoint status (Infura/Alchemy dashboard)
2. Verify rate limits aren't exhausted
3. Restart affected service - it will resume from last processed block
4. Check network connectivity

**Configuration:**

```bash
# Adjust retry settings
export RESOLVER_RPC_MAX_RETRIES=10
export RESOLVER_RPC_BASE_DELAY_MS=2000
export RESOLVER_RPC_MAX_DELAY_MS=60000
```

#### Stuck Orders

**Symptom:** Orders remain in `src_locked` or `dst_locked` without progress.

**Resolution:**

1. Check resolver logs for errors
2. Verify resolver is staked in ResolverRegistry
3. Manually check on-chain state:
   ```bash
   # Ethereum
   curl $ETH_HTLC_ESCROW_TESTNET/events?hashlock=<hashlock>

   # Stellar
   curl "$STELLAR_HORIZON_URL/contracts/$SOROBAN_HTLC/events"
   ```
4. Users can always refund permissionlessly after timelock expires

#### Resolver Not Filling Orders

**Symptom:** Orders announced but no destination lock occurs.

**Resolution:**

1. Verify resolver is registered:
   ```bash
   # Check resolver health endpoint (the service exposes /health on RESOLVER_HEALTH_PORT)
   curl http://localhost:${RESOLVER_HEALTH_PORT:-8081}/health
   # Or check on-chain registration via the SDK:
   pnpm --filter @wafflefinance/resolver start -- --check-registration
   ```
2. Check resolver has sufficient stake
3. Verify resolver RPC endpoints are configured correctly
4. Check resolver logs for errors

#### Missing Secrets

**Symptom:** Preimages not being relayed between chains.

**Resolution:**

1. Check coordinator `SECRET_STORAGE_KEY` is set consistently
2. Verify coordinator can reach both chains
3. Run secret recovery via on-chain log replay (coordinator feature)

---

## Postmortem Process

Any SEV-1 or SEV-2 incident that has resolved requires a postmortem. The postmortem must be opened within 24 hours of resolution and merged within eight business days.

| Document | Purpose |
|---|---|
| [docs/postmortem/WORKFLOW.md](postmortem/WORKFLOW.md) | End-to-end postmortem process — roles, phases, deadlines, quality bar |
| [docs/postmortem/TEMPLATE.md](postmortem/TEMPLATE.md) | Fill-in-the-blank postmortem document |
| [docs/postmortem/examples/](postmortem/examples/) | Worked examples showing the template applied to real incidents |
| [docs/BUG_TRIAGE.md](BUG_TRIAGE.md) | Severity definitions, triage workflow, and escalation path |

### Quick reference

1. Incident resolved → incident commander opens a `postmortem: YYYY-MM-DD <description>` GitHub issue within 24 h.
2. Author copies `docs/postmortem/TEMPLATE.md` to `docs/postmortem/YYYY-MM-DD-<slug>.md` on a new branch.
3. Draft completed within five business days.
4. PR reviewed by ≥ 2 people and merged within eight business days.
5. Every action item tracked as a GitHub issue with an owner and due date.
6. 30-day follow-up to verify action items are on track.

For severity definitions and how to route an active incident, see [Bug Triage](BUG_TRIAGE.md).

---

## Rollback Procedures

### Contract Recovery

If a contract deployment fails or needs replacement:

1. **Identify the issue:**

   ```bash
   # Check validation
   pnpm --filter @wafflefinance/contracts exec hardhat run scripts/validate-deployment.ts --network <network>
   ```

2. **For failed transactions:** Wait for the nonce to expire or manually reset:

   ```bash
   # Cancel pending transactions
   pnpm --filter @wafflefinance/contracts exec hardhat run scripts/cancel-pending.ts --network <network>
   ```

3. **For corrupted state:** Redeploy with new addresses (last resort)

### Database Recovery

The coordinator database is a cache - it can be rebuilt from on-chain state:

```bash
# Stop coordinator
pnpm --filter @wafflefinance/coordinator stop

# Create a verified backup first
pnpm --filter @wafflefinance/coordinator db:backup -- --database-url "$DATABASE_URL" --out ./backups

# Restore a known-good SQLite backup
pnpm --filter @wafflefinance/coordinator db:restore -- --database-url "$DATABASE_URL" --from ./backups/coordinator-sqlite-example.db --force

# Or restore a PostgreSQL custom dump
pnpm --filter @wafflefinance/coordinator db:restore -- --database-url "$DATABASE_URL" --from ./backups/coordinator-postgres-example.dump --force

# Restart - schema auto-applied, events re-fetched
```

See `coordinator/docs/backup-restore.md` for the full backup/restore procedure,
validation checks, and PostgreSQL tool requirements.

### Emergency Shutdown

To halt all services immediately:

```bash
# Set emergency shutdown flag
export EMERGENCY_SHUTDOWN=true

# Or for relayer
export MAINTENANCE_MODE=true
```

---

## Escrow Replacement Migration

The escrow's registry reference is **immutable**: it is set once in the
constructor and cannot be updated in place. Migrating to a new
`ResolverRegistry` therefore requires deploying a **replacement escrow** and
coordinating configuration changes across the coordinator, relayer, resolver,
and frontend. This section is the operator runbook for that migration.

> **Key constraint:** in-flight orders cannot be migrated. Orders already
> locked in the old escrow must be claimed or refunded **through the old
> contract** until they settle. The migration must never strand them.

### Values that change on escrow replacement

When a replacement escrow is deployed, every one of the following must be
updated and verified. Missing any one of them routes new orders to the wrong
registry or leaves services pointed at a dead contract.

| Value | Where it lives | Notes |
|---|---|---|
| `ResolverRegistry` address | Deployment manifest, `.env` (`RESOLVER_REGISTRY_ADDRESS`) | New registry (or the existing one, if only the escrow is being replaced) |
| Escrow address | Deployment manifest, `.env` (`ETH_HTLC_ESCROW_MAINNET` / `ETH_HTLC_ESCROW_TESTNET`) | New escrow; the old address stays valid for in-flight orders |
| Chain ID | Deployment manifest, validation config | Must match the target network; a mismatch aborts the dry run |
| Deployment manifest entry | `deployments/<network>.json` | New escrow + registry addresses, deploy block, and bytecode hash |
| Coordinator config | Coordinator `.env` / config | Escrow + registry addresses used for order intake and event indexing |
| Relayer config | Relayer `.env` / config | Escrow address used for chain monitoring |
| Resolver config | Resolver `.env` / config | Escrow + registry addresses used for fills and stake checks |
| Frontend config | Frontend build-time env | Escrow + registry addresses shown to users |
| Event indexer start block | Coordinator/relayer config | Set to the new escrow's deploy block; old escrow events must still be indexed until in-flight orders settle |

### Gating new order intake

New orders must not be accepted against the new escrow until the migration is
verified, and must not be accepted against the old escrow once the new one is
live. Gate intake as follows:

1. **Before cutover:** set `MAINTENANCE_MODE=true` on the relayer and stop the
   coordinator from announcing new orders (pause the order-intake worker or
   set `EMERGENCY_SHUTDOWN=true`). Existing orders continue to be processed.
2. **During cutover:** deploy the replacement escrow, update all values in the
   table above, and run the dry-run validator (below). No new orders are
   accepted during this window.
3. **After cutover:** restart services with the new configuration, verify the
   dry run passes, then clear `MAINTENANCE_MODE` / `EMERGENCY_SHUTDOWN` to
   resume intake against the new escrow.
4. **In-flight orders:** keep the old escrow address configured for event
   indexing and settlement until every order locked in it has been claimed or
   refunded. Users can always refund permissionlessly after the timelock
   expires, so no manual intervention is required to unblock them.

### Rollback point

The rollback point is **immediately before step 2 (cutover)**. At that point
the old escrow and registry are still live and all services still point at
them. To roll back:

1. Revert the coordinator, relayer, resolver, and frontend configuration to
   the previous escrow and registry addresses (keep the previous `.env` and
   deployment manifest under version control so this is a single revert).
2. Restart services and clear `MAINTENANCE_MODE` / `EMERGENCY_SHUTDOWN`.
3. Confirm the dry-run validator passes against the restored configuration.

Because the replacement escrow is a new contract, rolling back does not
require any on-chain action — the old escrow was never modified. If the
replacement escrow has already accepted orders, those orders must be settled
through the replacement contract before it is abandoned.

### Dry-run validator

The dry-run validator checks the migration without sending any transaction.
It verifies:

- **Network:** the RPC endpoint's chain ID matches the expected network.
- **Bytecode:** the escrow and registry addresses have deployed code and the
  escrow's bytecode hash matches the deployment manifest.
- **Registry linkage:** the escrow's immutable registry reference equals the
  configured `ResolverRegistry` address.
- **Manifest consistency:** the deployment manifest's escrow, registry, chain
  ID, and deploy block match the configured values.

Run it before cutover and again after restarting services:

```bash
pnpm --filter @wafflefinance/contracts exec hardhat run scripts/validate-escrow-migration.ts \
  --network <network> -- --dry-run
```

The validator performs **no transaction** in dry-run mode and exits non-zero
if the chain ID or registry configuration does not match. Do not proceed with
cutover until it exits zero.

---

## Monitoring Guide

> For the full Prometheus rule set and thresholds (stale-cleanup backlog,
> expiry backlog, job stalls, failed recovery paths) see
> [`docs/ALERTING.md`](./ALERTING.md).

### Key Metrics to Watch

| Metric                                             | Alert Threshold | Meaning                 |
| -------------------------------------------------- | --------------- | ----------------------- |
| `orders_announced_total`                           | -               | Orders arriving         |
| `orders_completed_total` / `orders_refunded_total` | -               | Settled orders          |
| `resolvers_active`                                 | = 0             | No resolvers available  |
| `rpc_errors_total`                                 | > 10/min        | RPC connectivity issues |
| `restart_count`                                    | > 5             | Service instability     |
| `coordinator_stale_cleanup_backlog`                 | > 50 for 30m    | Stale-order backlog size (see [`docs/ALERTING.md`](./ALERTING.md)) |
| `coordinator_stale_cleanup_remaining`               | > 0 for 2h      | Stale orders left unarchived after a run |
| `coordinator_expired_orders_backlog`               | > 20 for 30m    | Expired orders awaiting refund/failure |

### Health Check Script

```bash
#!/bin/bash
# scripts/health-check.sh

COORDINATOR_URL=${COORDINATOR_URL:-http://localhost:3001}

# Check coordinator
curl -sf "$COORDINATOR_URL/health" || echo "Coordinator down"

# Check chain monitoring (relayer)
curl -sf "$COORDINATOR_URL/api/debug/chain-monitor" | jq '.chainMonitoringStarted' || echo "Chain monitoring off"
```

### Log Analysis

Common log patterns:

```bash
# Find failed RPC calls
jq 'select(.level=="warn" and (.msg | contains("RPC")))' < coordinator.log

# Find stuck orders
jq 'select(.status=="src_locked" and .age_hours > 24)' < orders-table.json

# Find restart loops
jq 'select(.component=="Supervisor")' < resolver.log
```

---

## Local Development with Seeded Data

To quickly bootstrap a development environment with realistic sample data:

```bash
# Start coordinator (creates empty DB)
pnpm --filter @wafflefinance/coordinator dev &

# Seed with demo orders covering all states
pnpm --filter @wafflefinance/coordinator seed-demo

# Demo orders include:
# - completed (secret revealed, both legs settled)
# - secret_revealed (claimable on destination)
# - src_locked (waiting for resolver)
# - dst_locked (waiting for user claim)
# - refunded (timelock passed, refunded)
# - expired (ready for refund)
```

View seeded data:

```bash
# List all orders
curl "$COORDINATOR_URL/orders/history?address=0x742d35cF0b7bbF6E175239d74a0e0a3d1C7B87E4" | jq

# Get specific order
curl "$COORDINATOR_URL/orders/demo-xxx" | jq
```
