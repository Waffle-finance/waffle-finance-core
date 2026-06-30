# Coordinator Observability - Production Runbook

**Document Version**: 1.0  
**Last Updated**: 2026-06-26  
**Audience**: Platform engineers, SREs, operations teams

---

## Quick Links

- [Monitoring Setup](#monitoring-setup)
- [Alert Integration](#alert-integration)
- [On-Call Runbook](#on-call-runbook)
- [Dashboard Configuration](#dashboard-configuration)
- [Troubleshooting Guide](#troubleshooting-guide)

---

## Monitoring Setup

### 1. Expose Coordinator Metrics

The coordinator exports metrics on port 3000 at `/metrics` endpoint using Prometheus format.

**Configuration** (via environment variables in deployment):

```bash
# No special config needed — metrics are always exported
# Verify with:
curl http://coordinator:3000/metrics | head -30
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
      - targets: ["coordinator.internal:3000"]  # or specific IP
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
curl http://coordinator:3000/metrics
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
  curl http://coordinator:3000/health
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
curl http://coordinator:3000/metrics | grep coordinator_

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
curl http://coordinator:3000/debug/heapdump > heap.heapsnapshot

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

All metrics are exposed at `http://coordinator:3000/metrics` in Prometheus text format.

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
