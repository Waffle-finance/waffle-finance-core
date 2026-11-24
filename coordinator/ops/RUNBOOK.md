# Coordinator Observability - Production Runbook

**Document Version**: 1.0  
**Last Updated**: 2026-06-26  
**Audience**: Platform engineers, SREs, operations teams

---

## Quick Links

- [Monitoring Setup](#monitoring-setup)
- [Alert Integration](#alert-integration)
- [On-Call Runbook](#on-call-runbook)
- [Soroban Admin Key Rotation](#soroban-admin-key-rotation)
- [Dashboard Configuration](#dashboard-configuration)
- [Troubleshooting Guide](#troubleshooting-guide)

---

## Monitoring Setup

### 1. Expose Coordinator Metrics

The coordinator exports metrics on port 3001 at `/metrics` endpoint using Prometheus format.

**Configuration** (via environment variables in deployment):

```bash
# No special config needed — metrics are always exported
# Verify with:
curl http://coordinator:3001/metrics | head -30
```

### 2. Configure Prometheus Scraping

Add this scrape config to your Prometheus instance:

```yaml
# prometheus.yml
global:
  scrape_interval: 30s              # 30s is standard; adjust based on alert latency needs
  evaluation_interval: 30s
  external_labels:
    cluster: production
    environment: prod
    team: platform

scrape_configs:
  - job_name: "wafflefinance-coordinator"
    static_configs:
      - targets: ["coordinator.internal:3001"]  # or specific IP
        labels:
          service: coordinator
          datacenter: us-east-1
    
    # Adjust timeout based on network latency
    scrape_timeout: 10s
    metrics_path: /metrics
    
    # Optional: drop high-cardinality labels to save storage
    metric_relabel_configs:
      # Keep all metrics by default; examples below for optimization
      # - source_labels: [__name__]
      #   regex: 'coordinator_http_request_duration_seconds_bucket'
      #   action: keep
    
    # Optional: sample limit to prevent cardinality explosion
    sample_limit: 10000

# Storage configuration
# (adjust command-line flags if using remote storage)
storage:
  retention:
    time: 30d  # Keep 30 days of history for trend analysis
```

**Verify scrape is working**:

```bash
# In Prometheus UI
# 1. Go to Status > Targets
# 2. Find "wafflefinance-coordinator"
# 3. Should show "UP" in green
#
# If DOWN, check:
curl http://coordinator:3001/metrics
# Should return metrics in text format
```

### 3. Load Alert Rules

Use `coordinator-alerts.yml` included in this directory.

**Option A: Direct file inclusion** (recommended for single instance)

```yaml
# prometheus.yml
rule_files:
  - /etc/prometheus/coordinator-alerts.yml
```

**Option B: Prometheus operator** (Kubernetes)

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: coordinator-alerts
  namespace: monitoring
spec:
  groups:
    # Contents of coordinator-alerts.yml groups go here
    - name: coordinator_listeners
      interval: 30s
      rules:
        # ... alert rules ...
```

**Option C: Alertmanager HTTP API**

```bash
curl -X POST \
  -H "Content-Type: application/yaml" \
  -d @coordinator-alerts.yml \
  http://prometheus:9090/api/v1/alerts/update
```

### 4. Configure Alerting

Alerts route to Alertmanager, which sends notifications.

**Example Alertmanager config** (`alertmanager.yml`):

```yaml
global:
  resolve_timeout: 5m

route:
  receiver: platform-team
  group_by: [service, severity, component]
  group_wait: 10s
  group_interval: 30s
  repeat_interval: 4h

receivers:
  - name: platform-team
    slack_configs:
      - api_url: <SLACK_WEBHOOK_URL>
        channel: "#coordinator-alerts"
        title: "{{ .GroupLabels.severity | upper }}: {{ .GroupLabels.component }}"
        text: "{{ range .Alerts }}{{ .Annotations.summary }}\n{{ end }}"

  - name: pagerduty-escalation
    pagerduty_configs:
      - service_key: <PAGERDUTY_SERVICE_KEY>
        description: "{{ .GroupLabels.severity }}: {{ .Alerts.Firing | len }} firing"

inhibit_rules:
  # Don't alert on warning if critical already firing
  - source_match:
      severity: critical
    target_match:
      severity: warning
    equal: [service, component]
```

### 5. Set Up Grafana Dashboard

Import the pre-built dashboard:

```bash
# Copy dashboard JSON
cp coordinator/ops/grafana/dashboards/coordinator.json /var/lib/grafana/dashboards/

# Set Grafana datasource to your Prometheus instance
# UI: Admin > Data Sources > Add Prometheus
#   Name: Prometheus
#   URL: http://prometheus:9090
#   Access: Server
```

Or use Grafana Provisioning:

```yaml
# /etc/grafana/provisioning/dashboards/coordinator.yml
apiVersion: 1

providers:
  - name: coordinator
    orgId: 1
    folder: WaffleFinance
    type: file
    disableDeletion: false
    updateIntervalSeconds: 30
    allowUiUpdates: true
    options:
      path: /var/lib/grafana/dashboards
```

---

## Alert Integration

### Severity Levels

| Severity | Response Time | Action |
|----------|---|---|
| **info** | Best effort | Log and monitor trends |
| **warning** | < 30 minutes | Investigate, no customer impact yet |
| **critical** | < 5 minutes | Page on-call, immediate action |

### Alert Routing Examples

**Slack**: For ops team visibility
```yaml
slack_configs:
  - api_url: <WEBHOOK>
    channel: "#alerts-coordinator"
    text: |
      *{{ .Status | upper }}* {{ .GroupLabels.severity }}: {{ .CommonLabels.component }}
      {{ range .Alerts }}• {{ .Annotations.summary }}{{ end }}
```

**PagerDuty**: For critical incidents
```yaml
pagerduty_configs:
  - service_key: <KEY>
    description: "{{ .GroupLabels.severity }}: {{ .CommonLabels.component }}"
    details:
      service: "{{ .GroupLabels.service }}"
      component: "{{ .CommonLabels.component }}"
```

**Email**: For less urgent escalation
```yaml
email_configs:
  - to: platform-team@company.com
    from: alertmanager@company.com
    smarthost: smtp.company.com:587
```

---

## On-Call Runbook

### Alert: ListenerLagHigh

**Symptom**: Coordinator listener is > 100 blocks behind for > 5 minutes

**Checklist**:

- [ ] **Verify coordinator is running**
  ```bash
  curl http://coordinator:3001/health
  ```
  Expected: `{"ok":true}`

- [ ] **Check listener lag value in Prometheus**
  ```
  coordinator_listener_lag_blocks
  ```

- [ ] **Check RPC endpoint health**
  ```bash
  # Ethereum
  curl -X POST https://eth-rpc-url/api \
    -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","method":"net_version","params":[],"id":1}'
  
  # Soroban
  curl https://soroban-rpc-url/
  ```

- [ ] **Check coordinator logs for errors**
  ```bash
  docker logs wafflefinance-coordinator | tail -100
  grep -i error log.json | tail -20
  ```

- [ ] **Check database connectivity**
  ```bash
  docker exec wafflefinance-postgres psql -U coordinator -d coordinator -c "SELECT 1;"
  ```

**Resolution**:

1. If RPC is down: Wait for RPC to recover (lag will decrease automatically)
2. If coordinator not responding: Restart container
   ```bash
   docker restart wafflefinance-coordinator
   ```
3. If persists > 30 min: Escalate to platform lead

---

### Alert: ReconciliationStale

**Symptom**: Reconciliation last run > 1 hour ago

**Checklist**:

- [ ] **Verify coordinator is running** (see ListenerLagHigh checklist)
- [ ] **Check reconciliation status** in logs
  ```bash
  docker logs wafflefinance-coordinator | grep reconciliation
  ```
- [ ] **Verify all RPC endpoints** (Ethereum, Soroban, Solana)
- [ ] **Check database lock status**
  ```bash
  docker exec postgres psql -c "SELECT * FROM pg_stat_activity WHERE wait_event IS NOT NULL;"
  ```

**Resolution**:

1. Restart coordinator to clear any hung processes:
   ```bash
   docker restart wafflefinance-coordinator
   ```
2. Monitor reconciliation_last_run_timestamp_seconds metric
3. If still stale after 10 min: Check detailed error logs

---

### Alert: DbQueryLatencyHigh

**Symptom**: Database query p95 > 100ms

**Checklist**:

- [ ] **Check database CPU/memory**
  ```bash
  docker stats wafflefinance-postgres
  ```
  
- [ ] **Identify slow queries**
  ```bash
  docker exec postgres psql -c "SELECT query, calls, mean_exec_time FROM pg_stat_statements ORDER BY mean_exec_time DESC LIMIT 5;"
  ```

- [ ] **Check connection count**
  ```bash
  docker exec postgres psql -c "SELECT count(*) FROM pg_stat_activity;"
  ```

- [ ] **Monitor active order count**
  ```
  coordinator_active_orders
  ```

**Resolution**:

1. Increase database resources (CPU, RAM) if consistently high
2. Run VACUUM/ANALYZE if not done recently
3. Add indexes if specific query identified
4. Scale coordinator horizontally if load-related

---

### Alert: ActiveOrdersHigh

**Symptom**: > 5000 active orders for > 15 minutes

**Checklist**:

- [ ] **Check listener lag** (must be low for orders to progress)
- [ ] **Check DB latency** (slow queries block order completion)
- [ ] **Check reconciliation health** (failed reconciliation blocks order state machine)
- [ ] **Check on-chain confirmation times** (network congestion?)

**Resolution**:

1. If listener lag high: Wait for recovery (or apply ListenerLagHigh runbook)
2. If DB slow: Apply DbQueryLatencyHigh runbook
3. If reconciliation failing: Apply ReconciliationStale runbook
4. Monitor for trend; if continued growth, scale coordinator

---

### Alert: HttpErrorRateHigh

**Symptom**: > 0.1% of API requests returning 5xx errors

**Checklist**:

- [ ] **Identify which route is failing**
  ```
  topk(5, rate(coordinator_http_request_duration_seconds_bucket{status_code="500"}[5m]))
  ```

- [ ] **Check application logs**
  ```bash
  docker logs wafflefinance-coordinator | grep ERROR
  ```

- [ ] **Check input validation** (if `/announce` is failing)

**Resolution**:

1. Review error logs to identify root cause
2. If temporary spike: Usually resolves on its own
3. If persistent: Restart coordinator or investigate specific bug

---

## Soroban Admin Key Rotation

The Soroban HTLC contract and the resolver registry expose privileged
configuration entrypoints that affect the safety of future orders. The
deployer identity may be distinct from long-term governance, so authority
must be rotated through a controlled procedure that verifies the new
authority **before** the previous one is relinquished.

> **Secret handling rule (non-negotiable):** Never paste, print, log, or
> attach secret key material (seed phrases, `S...` secret keys, private
> keys, keystore files, or decrypted environment dumps) in terminal output,
> logs, tickets, issue text, chat, or PR descriptions. Only public
> identifiers (`G...` addresses, contract IDs, transaction hashes) may be
> recorded. If secret material is ever exposed, treat it as a security
> incident: stop, rotate the key immediately, and escalate.

### Admin-Controlled Entrypoints

| Contract | Entrypoint | Authorization requirement |
|----------|------------|---------------------------|
| HTLC | `set_admin` / admin transfer | Current admin address must authorize (`require_auth` on stored admin); new admin address is recorded |
| HTLC | `pause` / `unpause` (emergency controls) | Current admin address must authorize |
| HTLC | Fee / config setters (e.g. fee bps, treasury) | Current admin address must authorize |
| HTLC | `upgrade` (wasm replacement) | Current admin address must authorize |
| Resolver registry | `set_admin` / admin transfer | Current registry admin must authorize |
| Resolver registry | `add_resolver` / `remove_resolver` | Current registry admin must authorize |
| Resolver registry | Resolver metadata / config updates | Current registry admin must authorize |

Notes:

- Authorization is enforced on-chain via `require_auth` against the
  **currently stored** admin address. After a successful rotation, the
  previous admin's signatures are rejected for every entrypoint above.
- Read-only entrypoints (e.g. `get_admin`, order lookups) require no auth
  and are used for verification below.
- Confirm the exact entrypoint names against the deployed contract
  interface (`stellar contract invoke -- --help`) before executing; names
  may differ between contract versions.

### Procedure

#### 1. Prepare the new key

1. Generate the new admin keypair in an approved signer/HSM or offline
   environment. Do not generate it on a shared host.
2. Record only the **public** address (`G...`) in the change ticket.
3. Fund the new account if required by the network (reserve balance).
4. Confirm the new key holder has completed authorization review and is
   listed as the intended long-term governance authority.

#### 2. Pre-rotation verification

```bash
# Read current admin (public info only)
stellar contract invoke \
  --id "$HTLC_CONTRACT_ID" \
  --source-account "$OPS_ACCOUNT" \
  -- get_admin

stellar contract invoke \
  --id "$REGISTRY_CONTRACT_ID" \
  --source-account "$OPS_ACCOUNT" \
  -- get_admin
```

- [ ] Current admin matches the expected value in the change ticket.
- [ ] New admin public address matches the reviewed value.
- [ ] A dry run on testnet (or a fork) succeeded with the same parameters.

#### 3. Update authority

Submit the rotation from the **current** admin signer. Signing happens in
the signer/HSM; the secret never enters shell history or logs.

```bash
# HTLC rotation
stellar contract invoke \
  --id "$HTLC_CONTRACT_ID" \
  --source-account "$CURRENT_ADMIN_SIGNER" \
  --network "$NETWORK" \
  -- set_admin --new_admin "$NEW_ADMIN_ADDRESS"

# Resolver registry rotation
stellar contract invoke \
  --id "$REGISTRY_CONTRACT_ID" \
  --source-account "$CURRENT_ADMIN_SIGNER" \
  --network "$NETWORK" \
  -- set_admin --new_admin "$NEW_ADMIN_ADDRESS"
```

Record the resulting transaction hash (public) in the change ticket.

#### 4. Read-back verification

```bash
# Confirm stored admin equals the new address
stellar contract invoke --id "$HTLC_CONTRACT_ID" \
  --source-account "$OPS_ACCOUNT" -- get_admin
stellar contract invoke --id "$REGISTRY_CONTRACT_ID" \
  --source-account "$OPS_ACCOUNT" -- get_admin
```

- [ ] Both `get_admin` calls return the new admin address.
- [ ] New admin performs a low-risk protected operation (e.g. a no-op
      config update on testnet, or a pause/unpause cycle in a maintenance
      window) and it succeeds.
- [ ] Old admin attempts the same protected operation and is **rejected**
      with an authorization error. This proves the rotation took effect.

#### 5. Response to a failed transaction

If the rotation transaction fails or read-back does not match:

1. **Do not** retry blindly. Capture the transaction hash and the error
   code/message (public data only).
2. Common causes:
   - `Error(Auth, InvalidAction)` — signer is not the current admin, or
     the new admin address is malformed.
   - Insufficient fee/reserve — fund the source account and resubmit.
   - Wrong network passphrase — verify `--network` matches the target.
3. If the transaction failed, the stored admin is unchanged; the old admin
   remains authoritative. Re-verify with `get_admin` before retrying.
4. If the transaction succeeded but read-back shows the old admin, treat as
   a critical incident: halt privileged operations, escalate to the
   platform lead and security, and investigate before any further attempt.
5. Never "fix" a failed rotation by exporting or sharing the admin secret;
   re-run signing through the approved signer.

#### 6. Post-rotation

- [ ] Update the change ticket with new admin public address and tx hash.
- [ ] Revoke/retire the old signer per key-management policy.
- [ ] Update secret-manager references to the new signer.
- [ ] Confirm monitoring/alerting still has a valid admin signer configured.

### Release & Mainnet Readiness Checklist

Before any release or mainnet launch, confirm:

- [ ] Admin rotation runbook reviewed and rehearsed on testnet.
- [ ] Current admin and intended governance admin documented (public
      addresses only).
- [ ] Rotation test passes: new admin succeeds, old admin is rejected.
- [ ] No secret key material present in logs, tickets, or issue text.

---

## Dashboard Configuration

### Key Panels to Monitor

#### 1. Listener Health (Top-Left)

```
Gauge: max(coordinator_listener_lag_blocks) by (chain)
Thresholds: Green < 50, Orange 50-200, Red > 200
```

Should stay green in normal operation.

#### 2. Reconciliation Success Rate (Top-Center)

```
Stat: 
  sum(rate(coordinator_reconciliation_runs_total{result="success"}[1h]))
  /
  sum(rate(coordinator_reconciliation_runs_total[1h]))
Format: Percent (0-100)
Threshold: > 95% = good
```

Watch for drops below 95%.

#### 3. Active Orders (Top-Right)

```
Gauge: coordinator_active_orders
Threshold: Green < 1000, Orange 1-5k, Red > 5k
```

Trending upward indicates processing backlog.

#### 4. DB Latency (Bottom-Left)

```
Time Series:
  histogram_quantile(0.95, rate(coordinator_db_query_duration_seconds_bucket[5m]))
  by (operation)
Threshold: Keep < 100ms
```

Spikes indicate database stress.

#### 5. Order Outcomes (Bottom-Center)

```
Pie Chart:
  sum(increase(coordinator_orders_total[24h])) by (status)
Labels: completed, refunded, failed, src_locked, dst_locked
```

Should see high % completed, < 5% refunded/failed.

#### 6. HTTP Error Rate (Bottom-Right)

```
Gauge:
  sum(rate(coordinator_http_request_duration_seconds_bucket{status_code=~"5.."}[5m]))
  /
  sum(rate(coordinator_http_request_duration_seconds_bucket[5m]))
Format: Percent
Threshold: Keep < 0.1%
```

---

## Troubleshooting Guide

### Metrics Not Appearing

**Problem**: Dashboard shows "No data"

**Diagnosis**:
```bash
# 1. Verify coordinator is serving metrics
curl http://coordinator:3001/metrics | grep coordinator_

# 2. Verify Prometheus scrape is working
# In Prometheus UI: Status > Targets
# Look for coordinator target, should be "UP"

# 3. Check scrape_configs in prometheus.yml
grep -A 5 "job_name.*coordinator" /etc/prometheus/prometheus.yml
```

**Solutions**:
- If coordinator not serving: Start/restart it
- If target DOWN: Fix URL in prometheus.yml
- If no metrics: Verify prom-client is installed (`npm list prom-client`)

---

### Alerts Firing but No Issue

**Problem**: Alert is critical but system seems fine

**Diagnosis**:
- Check alert threshold (may be too aggressive)
- Verify metric calculation is correct
- Check if system has recovered but alert hasn't cleared

**Solutions**:
- Adjust threshold if consistently false positive
- Check alert resolution/duration settings
- Verify Prometheus scrape interval is appropriate

---

### Memory Growing Over Time

**Problem**: Heap memory increases without leveling off

**Diagnosis**:
```bash
# Check memory trend (compare to 24h ago)
coordinator_process_resident_memory_bytes

# Enable detailed heap profiling
curl http://coordinator:3001/debug/heapdump > heap.heapsnapshot

# Analyze with Node debugging tools
node --inspect=0.0.0.0:9229
```

**Solutions**:
- Identify memory leak source via heap dump analysis
- Restart coordinator if approaching memory limit
- File bug report if memory leak confirmed

---

### False Positives from Listener Lag

**Problem**: Lag spikes occur but order processing not actually delayed

**Cause**: Lag can fluctuate due to:
- RPC latency variation
- Block production timing
- Normal polling cycles

**Solution**:
- Extend alert `for:` duration (e.g., 5m to 10m)
- Combine with other metrics (active orders, latency)
- Consider derivative: is lag *increasing* or just high?

---

## Metrics Reference

All metrics are exposed at `http://coordinator:3001/metrics` in Prometheus text format.

### Core Metrics

| Metric | Type | Key Labels | Description |
|--------|------|-----------|-------------|
| `coordinator_listener_lag_blocks` | Gauge | chain | Blocks behind current chain head |
| `coordinator_reconciliation_runs_total` | Counter | result | Successful and failed reconciliation runs |
| `coordinator_reconciliation_errors_total` | Counter | — | Total reconciliation failures |
| `coordinator_reconciliation_last_run_timestamp_seconds` | Gauge | — | Last successful run (Unix timestamp) |
| `coordinator_db_query_duration_seconds` | Histogram | operation | Query latency by operation type |
| `coordinator_orders_total` | Counter | status, direction | Orders by state |
| `coordinator_active_orders` | Gauge | direction | Orders not in terminal state |
| `coordinator_http_request_duration_seconds` | Histogram | method, route, status_code | HTTP latency |

See `coordinator/ops/README.md` for complete metric list with thresholds.

---

## Escalation Path

```
Alert fires
  ↓
[Warn] P2 1h → [Crit] P1 5m
  ↓
Check on-call runbook
  ↓
[Resolved] → Document & update runbooks
  ↓
[Unresolved] Escalate to Platform Lead
```

---

## Related Documents

- [Coordinator README](./README.md) - Full observability guide
- [Alert Rules](./coordinator-alerts.yml) - Prometheus alert definitions
- [Metrics Handbook](../../README.md#metrics) - All coordinator metrics
- [Soroban Admin Key Rotation](#soroban-admin-key-rotation) - Admin authority rotation procedure (also required in release and mainnet readiness checklists)


---

### Alert: ReconciliationProgressStale

**Symptom**: Reconciliation has not completed successfully within operational limit (7 min)

**Checklist**:

- [ ] **Check reconciliation success timestamp**
  ```
  coordinator_reconciliation_last_success_timestamp_seconds
  ```
  Compare to current time to verify staleness

- [ ] **Check RPC health for all chains**
  ```bash
  # Ethereum
  curl -X POST $ETH_RPC_URL -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
  
  # Soroban
  curl $SOROBAN_RPC_URL/health
  
  # Solana
  curl $SOLANA_RPC_URL -X POST \
    -d '{"jsonrpc":"2.0","method":"getHealth","id":1}'
  ```

- [ ] **Check cursor age and backlog**
  ```
  coordinator_reconciliation_gap_blocks
  increase(coordinator_reconciliation_events_replayed_total[1h])
  ```

- [ ] **Review coordinator logs for reconciliation errors**
  ```bash
  grep "reconciliation run" /var/log/coordinator.log | tail -20
  grep "reconciler:" /var/log/coordinator.log | grep -i error | tail -10
  ```

- [ ] **Verify database connectivity**
  ```bash
  # For PostgreSQL
  psql $DATABASE_URL -c "SELECT 1;"
  
  # Check for long-running transactions
  psql $DATABASE_URL -c "SELECT pid, now() - query_start AS duration, query FROM pg_stat_activity WHERE state = 'active' ORDER BY duration DESC;"
  ```

**Resolution**:

1. If RPC is unhealthy: Wait for RPC to recover or switch to backup endpoint
2. If database is locked: Identify and kill blocking transaction
3. If coordinator logs show errors: Address the specific error code (see error taxonomy)
4. If persists > 10 min: Restart coordinator
   ```bash
   docker restart wafflefinance-coordinator
   # or
   kubectl rollout restart deployment/coordinator
   ```
5. Monitor reconciliation success metric after restart to confirm recovery

---

### Alert: DbPoolSaturation

**Symptom**: Database connection pool near saturation (>90% utilization)

**Checklist**:

- [ ] **Check pool metrics**
  ```
  coordinator_db_pool_active_connections
  coordinator_db_pool_idle_connections
  coordinator_db_pool_total_connections
  ```

- [ ] **Check pool wait time**
  ```
  histogram_quantile(0.95, rate(coordinator_db_pool_wait_duration_seconds_bucket[5m]))
  ```

- [ ] **Identify slow queries**
  ```
  coordinator_db_query_category_duration_seconds
  coordinator_db_named_query_duration_seconds
  ```

- [ ] **Check for long-running transactions**
  ```bash
  # PostgreSQL
  psql $DATABASE_URL -c "
    SELECT pid, usename, application_name, state, 
           now() - query_start AS duration, query
    FROM pg_stat_activity
    WHERE state != 'idle'
    ORDER BY duration DESC
    LIMIT 10;
  "
  ```

- [ ] **Review database resource usage**
  ```bash
  # CPU and memory
  top -p $(pgrep postgres)
  
  # Disk I/O
  iostat -x 1 5
  ```

**Resolution**:

1. **If wait time is high but queries are fast** → Pool too small
   - Increase pool size in DATABASE_URL connection string
   - Example: `postgresql://user:pass@host/db?max_pool_size=20`
   - Restart coordinator after config change

2. **If queries are slow (>100ms p95)** → Query optimization needed
   - Identify slow category from `coordinator_db_query_category_duration_seconds`
   - Review query plans and add missing indexes
   - Consider archival or partitioning for large tables

3. **If long-running transactions exist** → Kill blocking queries
   ```bash
   # PostgreSQL
   psql $DATABASE_URL -c "SELECT pg_terminate_backend(<pid>);"
   ```

4. **If database CPU/disk is saturated** → Scale database resources
   - Vertical scaling: increase CPU/memory
   - Consider read replicas for query load distribution

---

### Alert: DbPoolWaitTimeHigh

**Symptom**: Queries waiting >100ms (p95) for available database connections

**Checklist**:

- [ ] **Distinguish pool saturation from slow queries**
  ```
  # If pool utilization is high → pool too small
  coordinator_db_pool_active_connections / coordinator_db_pool_total_connections
  
  # If query duration is normal → pool saturation
  coordinator_db_query_category_duration_seconds
  ```

- [ ] **Check for connection leaks**
  ```bash
  # Count connections by state (PostgreSQL)
  psql $DATABASE_URL -c "
    SELECT state, count(*) 
    FROM pg_stat_activity 
    WHERE datname = current_database()
    GROUP BY state;
  "
  ```

**Resolution**:

- See DbPoolSaturation runbook above for detailed steps
- If pool has idle connections but wait time is high → investigate coordinator connection handling logic

---

### Alert: DbQueryCategoryLatencyHigh

**Symptom**: Specific query category experiencing high latency (p95 >250ms)

**Checklist**:

- [ ] **Identify slow category**
  ```
  topk(5, histogram_quantile(0.95, 
    rate(coordinator_db_query_category_duration_seconds_bucket[5m])) 
    by (category))
  ```

- [ ] **Review query plans for the category**
  ```bash
  # For PostgreSQL, enable auto_explain
  psql $DATABASE_URL -c "
    ALTER SYSTEM SET auto_explain.log_min_duration = 100;
    ALTER SYSTEM SET auto_explain.log_analyze = true;
    SELECT pg_reload_conf();
  "
  
  # Check logs for EXPLAIN output
  tail -f /var/log/postgresql/postgresql.log | grep EXPLAIN
  ```

- [ ] **Check table statistics**
  ```bash
  # PostgreSQL
  psql $DATABASE_URL -c "
    SELECT schemaname, tablename, last_analyze, last_autoanalyze
    FROM pg_stat_user_tables
    ORDER BY last_analyze NULLS FIRST;
  "
  ```

**Resolution**:

1. **For order_scan category** → Add indexes or optimize scan predicates
2. **For maintenance category** → Review cleanup query batch sizes
3. **If statistics are stale** → Run ANALYZE
   ```bash
   psql $DATABASE_URL -c "ANALYZE orders;"
   ```
4. **If table has grown large** → Consider partitioning or archival strategy

---

### Alert: ErrorRateHigh / RpcErrorRateHigh / DatabaseErrorRateHigh

**Symptom**: Elevated error rate in a specific component or error code category

**Checklist**:

- [ ] **Review error breakdown by code**
  ```
  topk(10, rate(coordinator_errors_total[5m])) by (code, component)
  ```

- [ ] **Check error taxonomy reference** (see `coordinator/src/errors.ts`)
  - **1xxx**: Database/persistence errors
  - **2xxx**: RPC/chain connectivity errors
  - **3xxx**: Validation errors
  - **4xxx**: Workflow/order processing errors
  - **5xxx**: External service errors
  - **9xxx**: Internal errors

- [ ] **Review recent error logs**
  ```bash
  # Errors with stable codes
  grep '"code":' /var/log/coordinator.log | tail -50
  
  # By component
  grep '"component":"reconciler"' /var/log/coordinator.log | grep error | tail -20
  ```

**Resolution by error category**:

1. **RPC errors (2xxx)**
   - Check RPC endpoint health (see ReconciliationProgressStale runbook)
   - If RPC_RATE_LIMIT → reduce polling frequency or upgrade RPC plan
   - If RPC_AUTH_FAILED → verify API keys are valid and not expired

2. **Database errors (1xxx)**
   - If DB_CONNECTION_FAILED → verify database is running and accessible
   - If DB_DEADLOCK → review transaction patterns and reduce lock contention
   - If DB_QUERY_TIMEOUT → see DbQueryCategoryLatencyHigh runbook

3. **Validation errors (3xxx)**
   - Review recent requests in application logs
   - Identify common patterns in rejected inputs
   - If rate is sustained → may indicate client bug or attack

4. **Workflow errors (4xxx)**
   - If ORDER_NOT_FOUND → expected for replayed events (normal)
   - If RECONCILIATION_CONFLICT → review chain/DB state consistency
   - If SECRET_MISSING_SRC_LOCK → check listener health and event processing

5. **Internal errors (9xxx)**
   - Review stack traces in logs
   - Open incident ticket — indicates code bug
   - Apply immediate mitigation (restart if needed), fix in next release

---

### Dashboard Interpretation Thresholds

**Order Age by State** (Panel IDs 18-23):

- **Announced state**
  - Green: <50 orders
  - Yellow: 50-200 orders
  - Red: >200 orders
  - *Action*: If red, check listener lag and reconciliation health

- **Src Locked state**
  - Green: <30 orders
  - Yellow: 30-100 orders
  - Red: >100 orders
  - *Action*: If red, check secret reveal processing and RPC health

- **Secret Revealed state**
  - Green: <20 orders
  - Yellow: 20-50 orders
  - Red: >50 orders
  - *Action*: If red, check destination chain listener and claim processing

**DB Pool Utilization** (Panel ID 24):

- Idle connections should remain >10% of total pool
- If idle drops to 0 for >5 minutes → pool saturation
- Action: Increase pool size or optimize slow queries

**Reconciliation Progress** (Panel ID 27):

- Time since last success should be <420s (7 minutes)
- Yellow threshold: 300s (5 minutes)
- Red threshold: 420s (7 minutes)
- Action: See ReconciliationProgressStale runbook

**Error Rate** (Panel ID 28):

- Normal baseline: <0.1 errors/sec per component
- Yellow threshold: 0.5 errors/sec
- Red threshold: 1 error/sec
- Action: See ErrorRateHigh runbook
