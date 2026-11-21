# Operations Runbooks

This document provides operational guidance for deploying, monitoring, and troubleshooting WaffleFinance services.

For a rollback-first, step-by-step procedure specific to redeploying the coordinator and relayer (config changes, restart verification, secret rotation, rollback triggers), see [docs/DEPLOYMENT_ROLLBACK_RUNBOOK.md](DEPLOYMENT_ROLLBACK_RUNBOOK.md), which builds on the Rollback Procedures and Monitoring Guide sections below.

---

## Table of Contents

- [Deployment Checklist](#deployment-checklist)
- [Pre-deployment Validation](#pre-deployment-validation)
- [Service Dependencies](#service-dependencies)
- [Incident Response](#incident-response)
- [Postmortem Process](#postmortem-process)
- [Rollback Procedures](#rollback-procedures)
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

### Repository-wide Validation (`pnpm validate`)

The root `pnpm validate` command runs the static consistency checks below in
addition to the per-package lint, type-check, and test suites. All of them are
static: they read source files and documentation, never print secret values,
and never contact a network. Run `pnpm validate` before opening a PR that
touches configuration, metrics, or deployment artifacts.

#### Environment-variable coverage

The environment-variable validator extracts every variable referenced through
`process.env`, `import.meta.env`, and the config package accessors, then
compares that set against the example environment files and package
documentation.

- **Missing key** — a variable is read in code but absent from the relevant
  example file. Add it to the example file (with a placeholder value, never a
  real secret) and document its purpose.
- **Stale key** — an example file documents a variable that no code reads.
  Remove it, or, if it is intentionally reserved for operators, add it to the
  exemption list in the validator with a comment explaining why.
- **Exempt keys** — variables provided by the platform or CI (for example
  `CI`, `NODE_ENV`, or `VITE_*` values injected at build time) are exempt and
  listed in the validator. Add new exemptions there rather than deleting the
  check.

Failures report the variable name and the source location of the reference or
example entry; they never print the variable's value.

#### Metric-name consistency

The metric validator inventories the counters, gauges, and histograms
registered in `coordinator/src/metrics.ts` and related files, then parses the
metric-bearing entries in the Grafana dashboard, the Prometheus alert rules,
and the coordinator operations docs.

- A registered metric that is missing from an alert or from the documented
  metric list causes a failure naming the metric and the file that should
  reference it.
- **Label variations** are not failures: a metric may be referenced with any
  subset of its labels (for example `orders_completed_total{chain="stellar"}`
  matches `orders_completed_total`).
- **Intentional exclusions** — metrics that are deliberately not alerted on
  (debug-only or informational metrics) are listed in the validator's
  exclusion list with a comment. Add new exclusions there, not by weakening
  the check.

#### Deployment address consistency

The deployment validator compares chain-specific contract and program
identifiers across the sources that must stay synchronized:
`deployments.testnet.json`, the example environment files, and the operator
documentation. It uses explicit mappings for EVM, Soroban, and Solana
identifiers rather than searching for arbitrary strings.

- A mismatch reports the chain, the field, and the artifacts that disagree —
  never unrelated values or secrets.
- Optional networks that are intentionally unconfigured are skipped, so a
  clean checkout validates the testnet configuration without requiring every
  network to be set.

**How deployments update the artifacts:** when a contract or program is
deployed or migrated, update `deployments.testnet.json` first, then propagate
the same identifiers to the example environment files and the operator docs in
the same PR. Run `pnpm validate` to confirm all copies agree before merging.

### Mainnet-enabled frontend CI

CI builds and tests the frontend in both mainnet-disabled and
mainnet-enabled (`VITE_MAINNET_ENABLED=true`) configurations, using public
fixture values only. This job validates that the gated mainnet code paths
still compile and that mainnet route selection and disabled-mode gating behave
correctly.

**This job validates code paths only.** It does not authorize a mainnet
deployment, does not lift the independent security-audit gate, and does not
enable mainnet in production deployment configuration. Production mainnet
remains disabled until the security audit is complete and the release is
explicitly approved.

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
