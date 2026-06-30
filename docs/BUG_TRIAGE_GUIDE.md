# Bug Triage and Incident Response Guide

**Document Version**: 1.0  
**Last Updated**: 2026-06-30  
**Audience**: Contributors, maintainers, and on-call engineers

This guide provides a standardized process for triaging bugs and responding to incidents in the WaffleFinance repository. It covers issue classification, reproduction steps, log collection, and escalation paths tailored to the cross-chain atomic swap architecture.

---

## Table of Contents

- [Overview](#overview)
- [Triage Workflow](#triage-workflow)
- [Severity Classification](#severity-classification)
- [Issue Categories](#issue-categories)
- [Reproduction Steps](#reproduction-steps)
- [Log Collection](#log-collection)
- [Escalation Paths](#escalation-paths)
- [Common Incident Scenarios](#common-incident-scenarios)
- [Post-Incident Process](#post-incident-process)

---

## Overview

WaffleFinance is a non-custodial cross-chain atomic swap protocol spanning Ethereum, Stellar, and Solana. The architecture consists of:

- **Smart Contracts**: HTLCEscrow (Solidity), Soroban HTLC (Rust), Anchor HTLC (Solana)
- **Coordinator**: Order book service with event listeners and state machine
- **Relayer**: Event relay and refund watchdog
- **Resolver**: Open-source resolver runner for counterparty swaps
- **Frontend**: React dApp for user interactions
- **SDK**: Shared types and chain clients

When issues arise, they can originate from any layer. This guide helps systematically identify the root cause and coordinate response.

---

## Triage Workflow

### Step 1: Initial Assessment (5 minutes)

When a bug report or incident is received:

1. **Categorize the issue type**:
   - User-facing bug (frontend, wallet connection)
   - Transaction failure (swap stuck, refund issues)
   - Service outage (coordinator, relayer down)
   - Smart contract issue (contract logic, gas regression)
   - Security concern (potential vulnerability)

2. **Assign severity** (see [Severity Classification](#severity-classification))

3. **Check for duplicates**:
   - Search existing GitHub issues
   - Check `docs/OPERATIONS.md` for known incidents
   - Review recent commits for related changes

4. **Tag the issue** with appropriate labels:
   - `severity: critical`, `severity: high`, `severity: medium`, `severity: low`
   - `component: frontend`, `component: coordinator`, `component: relayer`, `component: contracts`, `component: sdk`
   - `chain: ethereum`, `chain: stellar`, `chain: solana`

### Step 2: Information Gathering (15 minutes)

Collect essential information from the reporter:

- **Environment**: Testnet or mainnet? Local development or production?
- **Reproduction rate**: One-time, intermittent, or consistent?
- **Transaction hashes**: If applicable, provide on-chain transaction IDs
- **Order ID**: For swap-related issues, provide the order identifier
- **Wallet addresses**: User's wallet addresses on affected chains
- **Browser/OS**: For frontend issues
- **Error messages**: Exact error text or screenshots

### Step 3: Initial Diagnosis (20 minutes)

Based on the issue category, perform initial checks:

#### For Transaction Failures:
```bash
# Check order status via coordinator API
curl $COORDINATOR_URL/orders/<order_id>

# Verify on-chain state
# Ethereum
cast call $HTLC_ESCROW_ADDRESS "getOrder(bytes32)" <order_id>

# Stellar
stellar contract invoke --id $HTLC_CONTRACT_ID --read-only -- get_order --order_id <order_id>
```

#### For Service Outages:
```bash
# Check coordinator health
curl $COORDINATOR_URL/health

# Check relayer health
curl $RELAYER_URL/api/health

# Verify metrics endpoint
curl $COORDINATOR_URL/metrics | grep coordinator_
```

#### For Frontend Issues:
- Check browser console for errors
- Verify `VITE_API_BASE_URL` is correctly set
- Test with different wallets (MetaMask, Freighter, Phantom)

### Step 4: Reproduction (30-60 minutes)

Attempt to reproduce the issue in a controlled environment:

1. **Local reproduction**:
   ```bash
   # Start local stack
   pnpm coordinator:dev
   pnpm relayer:dev
   pnpm frontend:dev
   ```

2. **Testnet reproduction**:
   - Use Sepolia (Ethereum) and Stellar testnet
   - Ensure sufficient testnet funds
   - Check RPC endpoint status

3. **Document reproduction steps** in the issue

### Step 5: Assignment and Escalation (5 minutes)

- **Assign to appropriate team**: Frontend, contracts, coordinator, or infrastructure
- **Escalate if severity is critical** (see [Escalation Paths](#escalation-paths))
- **Set SLA expectations** based on severity

---

## Severity Classification

| Severity | Definition | Response Time | Example |
|----------|------------|---------------|---------|
| **Critical** | Production outage, funds at risk, security vulnerability | < 15 minutes | Users cannot complete swaps, funds locked, smart contract exploit |
| **High** | Major functionality broken, significant user impact | < 1 hour | Swap failures on one chain, coordinator down, relayer not processing |
| **Medium** | Minor functionality broken, limited user impact | < 4 hours | UI glitches, non-critical API errors, slow performance |
| **Low** | Cosmetic issues, documentation errors, nice-to-have improvements | < 2 days | Typos, minor UI inconsistencies, enhancement requests |

### Severity Adjustment Criteria

**Upgrade severity if**:
- Affects mainnet (vs testnet)
- Involves fund loss or lockup risk
- Impacts > 10% of users
- No workaround available

**Downgrade severity if**:
- Only affects testnet
- Workaround exists
- Affects < 1% of users
- Non-critical path

---

## Issue Categories

### 1. Swap Stuck / Order Not Progressing

**Symptoms**: Order remains in `src_locked` or `dst_locked` state without progress

**Initial checks**:
- Check coordinator listener lag: `coordinator_listener_lag_blocks` metric
- Verify resolver is registered and staked
- Check on-chain HTLC state directly
- Review relayer logs for errors

**Common causes**:
- RPC endpoint downtime
- Resolver not running or out of stake
- Network congestion (high gas fees)
- Coordinator event listener stalled

**Logs to collect**:
- Coordinator logs: `docker logs wafflefinance-coordinator`
- Relayer logs: `docker logs wafflefinance-relayer`
- Resolver logs: `docker logs wafflefinance-resolver`
- Prometheus metrics: listener lag, reconciliation status

### 2. Transaction Reverted / Failed

**Symptoms**: User transaction fails with revert reason

**Initial checks**:
- Check transaction hash on block explorer
- Verify contract addresses are correct
- Check user has sufficient balance/gas
- Review contract deployment status

**Common causes**:
- Insufficient gas limit
- Incorrect parameters (amount, recipient)
- Contract not deployed on target network
- Wallet signature issues

**Logs to collect**:
- Transaction receipt from block explorer
- Frontend console logs
- Coordinator API response for the order
- RPC endpoint logs (if available)

### 3. Frontend / Wallet Connection Issues

**Symptoms**: Wallet won't connect, wrong network, UI errors

**Initial checks**:
- Verify wallet is installed and unlocked
- Check browser console for errors
- Verify network matches expected (testnet/mainnet)
- Test with alternative wallet

**Common causes**:
- Wallet not installed or locked
- Wrong network selected in wallet
- `VITE_API_BASE_URL` misconfigured
- Browser extension conflicts

**Logs to collect**:
- Browser console errors
- Network tab in browser dev tools
- Frontend build logs
- Coordinator health endpoint

### 4. Coordinator / Relayer Service Down

**Symptoms**: Health endpoint returns error, metrics not updating

**Initial checks**:
- Check service process status: `docker ps` or `systemctl status`
- Verify environment variables are set
- Check database connectivity
- Review recent deployments

**Common causes**:
- Deployment failure
- Database connection issues
- Environment variable misconfiguration
- Resource exhaustion (memory, disk)

**Logs to collect**:
- Service logs: `journalctl -u wafflefinance-coordinator`
- Database logs
- System metrics (CPU, memory, disk)
- Deployment logs

### 5. Smart Contract Issues

**Symptoms**: Unexpected contract behavior, gas regression, logic errors

**Initial checks**:
- Verify contract bytecode matches deployment
- Check contract on block explorer
- Review recent contract changes
- Run contract tests locally

**Common causes**:
- Contract logic bug
- Gas regression from compiler changes
- Incorrect initialization parameters
- Front-running vulnerability

**Logs to collect**:
- Contract deployment transaction
- Failed transaction receipts
- Local test results
- Compiler version and settings

### 6. Security Vulnerabilities

**Symptoms**: Potential exploit, unauthorized access, fund loss risk

**Immediate actions**:
1. **DO NOT publicize** - follow responsible disclosure
2. Escalate to security team immediately
3. If mainnet at risk, consider emergency pause (if available)
4. Document all findings privately

**Escalation**: See [Security Incident Escalation](#security-incident-escalation)

---

## Reproduction Steps

### Template for Bug Reports

When filing or triaging a bug, ensure the following information is present:

```markdown
## Environment
- Network: [testnet/mainnet]
- Chain(s) affected: [ethereum/stellar/solana]
- Frontend version: [commit hash or version]
- Coordinator version: [commit hash or version]
- Browser: [name and version]

## Steps to Reproduce
1. Go to [...]
2. Click on [...]
3. Select [...]
4. See error

## Expected Behavior
[What should happen]

## Actual Behavior
[What actually happens]

## Screenshots / Logs
[Attach relevant screenshots or log excerpts]

## Transaction Hashes / Order IDs
[If applicable]
```

### Reproduction Checklist

Before marking an issue as "cannot reproduce":

- [ ] Attempted on local development environment
- [ ] Attempted on testnet (if applicable)
- [ ] Tested with different wallets
- [ ] Tested in different browsers (for frontend issues)
- [ ] Verified environment variables match reporter's setup
- [ ] Checked for recent changes that may have introduced the issue

---

## Log Collection

### System-Level Logs

**Coordinator**:
```bash
# Docker deployment
docker logs wafflefinance-coordinator --tail 500 > coordinator.log

# Systemd deployment
journalctl -u wafflefinance-coordinator --since "1 hour ago" > coordinator.log
```

**Relayer**:
```bash
docker logs wafflefinance-relayer --tail 500 > relayer.log
```

**Resolver**:
```bash
docker logs wafflefinance-resolver --tail 500 > resolver.log
```

### Application Logs

**Structured logs** (if JSON logging enabled):
```bash
# Filter by error level
jq 'select(.level=="error")' < coordinator.log

# Filter by order ID
jq 'select(.order_id=="<order_id>")' < coordinator.log

# Filter by chain
jq 'select(.chain=="ethereum")' < coordinator.log
```

### Database Logs

**PostgreSQL**:
```bash
# Check for slow queries
docker exec postgres psql -U coordinator -d coordinator -c \
  "SELECT query, calls, mean_exec_time FROM pg_stat_statements ORDER BY mean_exec_time DESC LIMIT 10;"

# Check for locks
docker exec postgres psql -U coordinator -d coordinator -c \
  "SELECT * FROM pg_stat_activity WHERE wait_event IS NOT NULL;"
```

**SQLite**:
```bash
# Check database integrity
sqlite3 wafflefinance.db "PRAGMA integrity_check;"

# Export order data
sqlite3 wafflefinance.db "SELECT * FROM orders WHERE id='<order_id>';" > order.json
```

### Metrics Collection

**Prometheus metrics**:
```bash
# Snapshot current metrics
curl http://coordinator:3000/metrics > metrics.txt

# Query specific metric
curl -G 'http://prometheus:9090/api/v1/query' \
  --data-urlencode 'query=coordinator_listener_lag_blocks'
```

### On-Chain Data

**Ethereum**:
```bash
# Get event logs
cast logs --from-block <start> --to-block <end> \
  $HTLC_ESCROW_ADDRESS "OrderCreated(bytes32,address,uint256)"

# Get contract state
cast call $HTLC_ESCROW_ADDRESS "getOrder(bytes32)" <order_id>
```

**Stellar**:
```bash
# Get contract events
stellar contract events --contract $HTLC_CONTRACT_ID --limit 100

# Get contract state
stellar contract invoke --id $HTLC_CONTRACT_ID --read-only \
  -- get_order --order_id <order_id>
```

**Solana**:
```bash
# Get account data
solana account $HTLC_PROGRAM_ID

# Get transaction logs
solana confirm -v <transaction_signature>
```

---

## Escalation Paths

### Standard Escalation Flow

```
Bug Report
  ↓
Initial Triage (assign severity, category)
  ↓
[Severity: Low/Medium] → Assign to contributor, SLA: 2-4 days
  ↓
[Severity: High] → Assign to maintainer, SLA: 1 hour
  ↓
[Severity: Critical] → Page on-call, SLA: 15 minutes
  ↓
[Unresolved after SLA] → Escalate to tech lead
  ↓
[Security incident] → Escalate to security team immediately
```

### On-Call Rotation

**Critical severity triggers**:
- Coordinator or relayer service down on mainnet
- Funds locked or at risk
- Smart contract vulnerability suspected
- > 10% of users affected

**On-call responsibilities**:
- Respond to critical alerts within 15 minutes
- Coordinate incident response
- Communicate status updates
- Escalate to tech lead if unresolved after 1 hour

### Team Assignment Matrix

| Issue Category | Primary Team | Secondary Team |
|----------------|--------------|----------------|
| Frontend / UI | Frontend | SDK |
| Coordinator service | Backend/Infra | Database |
| Relayer service | Backend/Infra | Coordinator |
| Smart contracts (Ethereum) | Contracts | Security |
| Smart contracts (Stellar/Soroban) | Contracts | Security |
| SDK | SDK | All teams |
| Infrastructure / DevOps | Infra | All teams |
| Security | Security | All teams |

### Communication Channels

**Internal communication**:
- **Slack**: `#wafflefinance-incidents` for active incidents
- **Slack**: `#wafflefinance-dev` for general triage discussion
- **GitHub Issues**: For tracking and documentation

**External communication** (if user-facing):
- **Twitter/X**: For major outages
- **Discord**: For community updates
- **GitHub Status**: For service status page

### Security Incident Escalation

**If a security vulnerability is suspected**:

1. **DO NOT** create a public GitHub issue
2. **DO** create a private security advisory via GitHub
3. **DO** notify the security team immediately:
   - Email: security@wafflefinance.io (if configured)
   - Slack: `@security-team`
4. **DO** include:
   - Vulnerability description
   - Proof of concept (if available)
   - Potential impact
   - Suggested remediation

**Security team response time**: < 4 hours

---

## Common Incident Scenarios

### Scenario 1: Orders Stuck in `src_locked`

**Symptom**: Multiple orders remain in `src_locked` state, resolver not filling

**Triage steps**:
1. Check `coordinator_listener_lag_blocks` metric - if > 100, RPC issue
2. Check if resolver is registered: `curl $COORDINATOR_URL/resolvers`
3. Verify resolver has sufficient stake in ResolverRegistry
4. Check resolver logs for errors

**Resolution**:
- If RPC down: Wait for recovery or switch RPC endpoint
- If resolver not registered: Restart resolver registration process
- If resolver insufficient stake: Notify resolver operator to top up
- If resolver error: Check resolver logs for specific error

**Escalation**: If > 10 orders stuck for > 30 minutes, escalate to high severity

### Scenario 2: Coordinator Not Processing Events

**Symptom**: Listener lag increasing, orders not progressing

**Triage steps**:
1. Check coordinator health: `curl $COORDINATOR_URL/health`
2. Check database connectivity
3. Review coordinator logs for errors
4. Verify RPC endpoints are reachable

**Resolution**:
- If coordinator down: Restart service
- If database issue: Check database logs, restart if needed
- If RPC issue: Switch to backup RPC endpoint
- If resource exhaustion: Increase container resources

**Escalation**: If lag > 500 blocks for > 10 minutes, escalate to critical

### Scenario 3: Frontend Shows "Network Error"

**Symptom**: Frontend cannot connect to coordinator API

**Triage steps**:
1. Check coordinator is running: `curl $COORDINATOR_URL/health`
2. Verify `VITE_API_BASE_URL` is correctly set
3. Check browser console for CORS errors
4. Test coordinator API directly with curl

**Resolution**:
- If coordinator down: Follow coordinator incident response
- If CORS issue: Update coordinator CORS configuration
- If URL misconfigured: Update environment variable and rebuild frontend

**Escalation**: If affecting > 50% of users, escalate to high severity

### Scenario 4: Gas Regression on Ethereum

**Symptom**: Transaction gas costs significantly higher than expected

**Triage steps**:
1. Compare gas costs to previous deployments
2. Check recent contract changes
3. Run gas profiler: `pnpm --filter @wafflefinance/contracts test:gas`
4. Review compiler version changes

**Resolution**:
- If regression identified: Revert to previous version
- If optimization needed: Optimize contract code
- If compiler issue: Pin compiler version

**Escalation**: If gas costs > 2x baseline, escalate to high severity

### Scenario 5: Database Lock Contention

**Symptom**: Coordinator queries timing out, active orders increasing

**Triage steps**:
1. Check `coordinator_db_query_duration_seconds` metric
2. Identify slow queries in PostgreSQL logs
3. Check for long-running transactions
4. Review active connection count

**Resolution**:
- If slow query: Add index or optimize query
- If lock contention: Kill blocking transaction
- If connection pool exhausted: Increase pool size
- If database overloaded: Scale database resources

**Escalation**: If p95 latency > 500ms for > 10 minutes, escalate to high severity

---

## Post-Incident Process

### Incident Documentation

After resolving an incident, document it in the GitHub issue:

```markdown
## Incident Summary
[Brief description of what happened]

## Timeline
- HH:MM: Incident detected
- HH:MM: Initial triage completed
- HH:MM: Root cause identified
- HH:MM: Mitigation implemented
- HH:MM: Incident resolved

## Root Cause
[Technical explanation of the root cause]

## Impact
- Users affected: [number or percentage]
- Duration: [time]
- Funds at risk: [yes/no, details]

## Resolution
[Steps taken to resolve the incident]

## Preventive Measures
[Changes to prevent recurrence]
- [ ] Code change: [issue/PR link]
- [ ] Monitoring: [alert/metric added]
- [ ] Documentation: [doc updated]
- [ ] Process: [process improved]
```

### Root Cause Analysis (RCA)

For critical incidents, conduct a formal RCA:

1. **Gather facts**: Timeline, logs, metrics, changes
2. **Identify root cause**: Use "5 Whys" technique
3. **Develop corrective actions**: Specific, measurable, time-bound
4. **Assign owners**: Each action has a responsible person
5. **Follow up**: Track completion of corrective actions

### Follow-Up Actions

**Immediate (within 24 hours)**:
- [ ] Document incident in GitHub issue
- [ ] Update runbooks if new scenario discovered
- [ ] Add or adjust alerts if monitoring gap identified
- [ ] Communicate with affected users if necessary

**Short-term (within 1 week)**:
- [ ] Implement code fixes
- [ ] Add regression tests
- [ ] Update documentation
- [ ] Review and improve monitoring

**Long-term (within 1 month)**:
- [ ] Architectural improvements if systemic issue
- [ ] Process improvements
- [ ] Training for team if knowledge gap identified
- [ ] Review incident response effectiveness

### Retrospective Meeting

For critical incidents, schedule a retrospective meeting with stakeholders:

**Agenda**:
1. What happened? (Timeline review)
2. Why did it happen? (Root cause analysis)
3. How did we respond? (Response effectiveness)
4. What can we improve? (Preventive measures)
5. Action items and owners

**Participants**: On-call engineer, tech lead, relevant team members

---

## Related Documentation

- [Operations Runbooks](../docs/OPERATIONS.md) - Deployment and operational procedures
- [Development Guide](../docs/DEVELOPMENT.md) - Development setup and troubleshooting
- [Coordinator Observability](../coordinator/ops/README.md) - Monitoring and alerting
- [Coordinator Runbook](../coordinator/ops/RUNBOOK.md) - Detailed incident response procedures
- [Gas Regression Guide](../GAS_REGRESSION_GUIDE.md) - Gas optimization and regression testing

---

## Quick Reference

### Critical Commands

```bash
# Check coordinator health
curl $COORDINATOR_URL/health

# Check listener lag
curl $COORDINATOR_URL/metrics | grep coordinator_listener_lag_blocks

# Get order status
curl $COORDINATOR_URL/orders/<order_id>

# Check resolver status
curl $COORDINATOR_URL/resolvers

# View coordinator logs
docker logs wafflefinance-coordinator --tail 100 -f

# View relayer logs
docker logs wafflefinance-relayer --tail 100 -f
```

### Key Metrics to Monitor

- `coordinator_listener_lag_blocks` - Should be < 100
- `coordinator_reconciliation_last_run_timestamp_seconds` - Should be < 1 hour ago
- `coordinator_db_query_duration_seconds` - p95 should be < 100ms
- `coordinator_active_orders` - Should not grow unbounded
- `coordinator_http_request_duration_seconds` - p95 should be < 500ms

### Emergency Contacts

- **On-call engineer**: [Configure in team documentation]
- **Tech lead**: [Configure in team documentation]
- **Security team**: [Configure in team documentation]
- **Infrastructure lead**: [Configure in team documentation]

---

## Appendix

### Issue Label Reference

**Severity labels**:
- `severity: critical` - Immediate action required
- `severity: high` - Action required within 1 hour
- `severity: medium` - Action required within 4 hours
- `severity: low` - Action required within 2 days

**Component labels**:
- `component: frontend` - React dApp
- `component: coordinator` - Order book service
- `component: relayer` - Event relay service
- `component: contracts` - Smart contracts
- `component: sdk` - Shared SDK
- `component: infrastructure` - DevOps and deployment

**Chain labels**:
- `chain: ethereum` - Ethereum-specific issues
- `chain: stellar` - Stellar-specific issues
- `chain: solana` - Solana-specific issues
- `chain: cross-chain` - Issues spanning multiple chains

**Status labels**:
- `status: triage` - Needs initial assessment
- `status: in-progress` - Being worked on
- `status: blocked` - Waiting on dependency
- `status: needs-info` - Need more information from reporter
- `status: resolved` - Issue resolved

### SLA Summary

| Severity | Initial Response | Resolution Target | Escalation |
|----------|------------------|-------------------|------------|
| Critical | 15 minutes | 1 hour | After 30 min |
| High | 1 hour | 4 hours | After 2 hours |
| Medium | 4 hours | 2 days | After 1 day |
| Low | 2 days | 1 week | After 3 days |

---

**Document Maintainer**: WaffleFinance maintainers  
**Review Cycle**: Quarterly or after major incidents  
**Feedback**: Please suggest improvements via GitHub issues or pull requests
