# Operations Runbooks

This document provides operational guidance for deploying, monitoring, and troubleshooting WaffleFinance services.

---

## Table of Contents

- [Deployment Checklist](#deployment-checklist)
- [Pre-deployment Validation](#pre-deployment-validation)
- [Service Dependencies](#service-dependencies)
- [Incident Response](#incident-response)
- [Rollback Procedures](#rollback-procedures)
- [Monitoring Guide](#monitoring-guide)
- [See Also](#see-also)

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
   ```

2. **Verify RPC connectivity:**
   ```bash
   # Ethereum
   curl -X POST $ETHEREUM_RPC_URL -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
   
   # Stellar Horizon
   curl "$STELLAR_HORIZON_URL" | head -1
   ```

3. **Check deployer balance:**
   ```bash
   # Ensure sufficient funds for contract deployment
   # Mainnet: at least 0.1 ETH
   # Sepolia: use faucet https://sepoliafaucet.com
   ```

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

| Service | Endpoint | Description |
|---------|----------|-------------|
| Coordinator | `GET /health` | Liveness check |
| Coordinator | `GET /metrics` | Prometheus metrics |
| Relayer | `GET /api/health` | Service health |
| Relayer | `GET /api/debug/chain-monitor` | Chain monitoring status |

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
   pnpm --filter @wafflefinance/resolver status
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

# Clear database (SQLite)
rm wafflefinance.db

# Or drop and recreate (PostgreSQL)
dropdb wafflefinance && createdb wafflefinance

# Restart - schema auto-applied, events re-fetched
```

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

### Key Metrics to Watch

| Metric | Alert Threshold | Meaning |
|--------|-----------------|---------|
| `orders_announced_total` | - | Orders arriving |
| `orders_completed_total` / `orders_refunded_total` | - | Settled orders |
| `resolvers_active` | = 0 | No resolvers available |
| `rpc_errors_total` | > 10/min | RPC connectivity issues |
| `restart_count` | > 5 | Service instability |

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

---

## See Also

- [`docs/DEVELOPMENT.md`](DEVELOPMENT.md) — local setup, per-package commands, and troubleshooting.
- [`docs/TECHNICAL_DEBT.md`](TECHNICAL_DEBT.md) — service-level technical debt register. Known operational gaps (lazy listener startup, hardcoded price oracle, missing distributed tracing) are tracked there with proposed next steps.
