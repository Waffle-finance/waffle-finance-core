# Coordinator Observability — Prometheus + Grafana

Production observability guide for the WaffleFinance coordinator service.

**Local Development**: This folder includes Docker Compose for running Prometheus and Grafana locally.  
**Production**: Point any external Prometheus at the coordinator's `/metrics` endpoint.

---

## Table of Contents

1. [Local Quick Start](#local-quick-start)
2. [Exported Metrics](#exported-metrics)
3. [Production Monitoring Checklist](#production-monitoring-checklist)
4. [Alert Rules](#alert-rules)
5. [Grafana Dashboard Setup](#grafana-dashboard-setup)
6. [Troubleshooting](#troubleshooting)

---

## Local Quick Start

### Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (Engine ≥ 24)
- Coordinator running locally on port **3000** (`pnpm dev` inside `coordinator/`)

### Setup Steps (< 15 commands)

```bash
# 1. Install prom-client (first time only)
cd coordinator && pnpm install

# 2. Start the coordinator
pnpm dev

# 3. Verify metrics are served
curl http://localhost:3000/metrics | head -20

# 4. In a second terminal, start the observability stack
cd coordinator/ops
docker compose up -d

# 5. Open Prometheus
open http://localhost:9090

# 6. Open Grafana (admin / wafflefinance)
open http://localhost:3001
```

The **WaffleFinance coordinator** dashboard is pre-loaded in Grafana.

---

## Exported Metrics

### Listener Metrics

| Metric | Type | Labels | Description | Alert Threshold |
|---|---|---|---|---|
| `coordinator_listener_lag_blocks` | Gauge | `chain` (ethereum, soroban, solana) | Current lag in blocks/ledgers/slots | > 100 blocks for 5m |
| `coordinator_listener_last_block` | Gauge | `chain` | Most recent block processed | — |
| `coordinator_listener_head_block` | Gauge | `chain` | Chain's current head block | — |
| `coordinator_listener_event_processing_duration_seconds` | Histogram | `chain`, `event` | Time to process event batches | p95 > 1s continuously |

**Why Monitor**: Listener lag indicates the coordinator is falling behind the blockchain. Excessive lag delays order processing and recovery.

---

### Reconciliation Metrics (Secret Replay & Event Recovery)

| Metric | Type | Labels | Description | Alert Threshold |
|---|---|---|---|---|
| `coordinator_reconciliation_runs_total` | Counter | `result` (success, failure) | Reconciliation runs by outcome | — |
| `coordinator_reconciliation_errors_total` | Counter | — | Total reconciliation failures | > 5 failures in 1h |
| `coordinator_reconciliation_last_run_timestamp_seconds` | Gauge | — | Unix timestamp of last successful run | > 1h ago |
| `coordinator_reconciliation_events_replayed_total` | Counter | — | Events replayed by reconciliation | — |

**Why Monitor**: Reconciliation detects and replays missed on-chain events (e.g., expired locks, secret reveals, claim events). Failures indicate orders may be stuck or funds at risk.

---

### Database Metrics

| Metric | Type | Labels | Description | Alert Threshold |
|---|---|---|---|---|
| `coordinator_db_query_duration_seconds` | Histogram | `operation` | Query latency by operation type | p95 > 100ms continuously |

**Why Monitor**: Slow DB queries impact order processing latency and can delay secret reveals.

---

### Order Metrics

| Metric | Type | Labels | Description | Alert Threshold |
|---|---|---|---|---|
| `coordinator_orders_total` | Counter | `status`, `direction` | Orders by status (src_locked, dst_locked, etc.) | — |
| `coordinator_active_orders` | Gauge | `direction` | Orders not in terminal state | — |
| `coordinator_swap_duration_seconds` | Histogram | `direction`, `outcome` | End-to-end order completion time | p95 > 3600s |

**Why Monitor**: High active order count or slow swaps indicate processing backlog. Terminal state distribution reveals order success/failure rates.

---

### HTTP & Process Metrics

| Metric | Type | Description | Alert Threshold |
|---|---|---|---|
| `coordinator_http_request_duration_seconds` | Histogram | Latency by method, route, status code | p95 > 500ms for non-health routes |
| `coordinator_process_resident_memory_bytes` | Gauge | Heap memory usage | > 500MB continuously |
| `coordinator_process_heap_bytes_used` | Gauge | Used heap | > 80% of available |

**Why Monitor**: Memory leaks, high latency, and error rates degrade SLA.

---

## Production Monitoring Checklist

### Phase 1: Essential (First Week)

- [ ] **Listener Lag** is below 50 blocks on both Ethereum and Soroban
- [ ] **Reconciliation runs** succeed consistently (> 95% success rate)
- [ ] **Database query latency** p95 < 100ms
- [ ] **HTTP error rates** < 0.1% on `/announce` and `/quote` routes

### Phase 2: Advanced (Ongoing)

- [ ] **Active order count** is stable (no unbounded growth)
- [ ] **Swap completion** p95 < 1h under normal conditions
- [ ] **Memory usage** stable with no growth trend over 24h
- [ ] **Event replay count** < 10 per reconciliation run (indicates healthy operation)

### Phase 3: Hardened (Production Maturity)

- [ ] Reconciliation runs catch < 1 event per run on average (few missed events)
- [ ] Listener event processing < 100ms for 99% of batches
- [ ] Active order count never exceeds 10k for sustained periods
- [ ] Zero unhandled HTTP 500 errors on critical paths

---

## Alert Rules

### Prometheus Alert Configuration

Add the following alert rules to your Prometheus config or external alerting system:

```yaml
groups:
  - name: coordinator_alerts
    interval: 30s
    rules:
      # ========================================================================
      # LISTENER ALERTS (Critical: order processing delays)
      # ========================================================================
      
      - alert: CoordinatorListenerLagHigh
        expr: |
          coordinator_listener_lag_blocks > 100
        for: 5m
        labels:
          severity: warning
          service: coordinator
        annotations:
          summary: "Coordinator listener lag exceeds 100 blocks on {{ $labels.chain }}"
          description: |
            The {{ $labels.chain }} listener is {{ $value }} blocks behind.
            Recent actions:
            1. Check RPC endpoint health: curl <RPC_URL>/health
            2. Monitor listener event processing duration
            3. Check coordinator logs: docker logs wafflefinance_coordinator
            4. If sustained > 30m, restart listener

      - alert: CoordinatorListenerLagCritical
        expr: |
          coordinator_listener_lag_blocks > 500
        for: 2m
        labels:
          severity: critical
          service: coordinator
        annotations:
          summary: "Coordinator listener lag CRITICAL: {{ $value }} blocks on {{ $labels.chain }}"
          description: |
            Orders are NOT being processed. Immediate action required:
            1. Check if RPC is available: curl <RPC_URL>/health
            2. Check if coordinator process is running
            3. Review recent error logs
            4. Redeploy if necessary

      - alert: CoordinatorListenerNoProgress
        expr: |
          changes(coordinator_listener_last_block[5m]) == 0 and 
          coordinator_listener_lag_blocks > 0
        for: 5m
        labels:
          severity: critical
          service: coordinator
        annotations:
          summary: "Coordinator listener {{ $labels.chain }} not advancing blocks"
          description: |
            The listener has not processed any new blocks in 5 minutes.
            1. Restart the coordinator
            2. Check RPC connectivity
            3. Check disk space and logs

      - alert: CoordinatorListenerEventProcessingSlow
        expr: |
          histogram_quantile(0.95, 
            rate(coordinator_listener_event_processing_duration_seconds_bucket[5m])
          ) > 1
        for: 10m
        labels:
          severity: warning
          service: coordinator
        annotations:
          summary: "Listener event processing slow (p95 > 1s): {{ $labels.chain }} {{ $labels.event }}"
          description: |
            Event batches are taking > 1s to process, delaying order processing.
            1. Check DB query latency (coordinator_db_query_duration_seconds)
            2. Check active order count (coordinator_active_orders)
            3. Review slow query logs

      # ========================================================================
      # RECONCILIATION ALERTS (High: missed events & stuck funds)
      # ========================================================================

      - alert: CoordinatorReconciliationFailed
        expr: |
          increase(coordinator_reconciliation_runs_total{result="failure"}[1h]) > 5
        labels:
          severity: warning
          service: coordinator
        annotations:
          summary: "Coordinator reconciliation failing: {{ $value }} failures in 1h"
          description: |
            Reconciliation is failing repeatedly. Missed events may not be recovered.
            1. Check logs for reconciliation errors: grep reconciliation <logs>
            2. Verify RPC endpoints are healthy for all chains
            3. Check for database connectivity issues
            4. If persists > 1h, escalate to on-call

      - alert: CoordinatorReconciliationStale
        expr: |
          (time() - coordinator_reconciliation_last_run_timestamp_seconds) > 3600
        labels:
          severity: critical
          service: coordinator
        annotations:
          summary: "Coordinator reconciliation has not run for {{ $value | humanizeDuration }}"
          description: |
            Reconciliation is stale. Funds could be at risk if events are not replayed.
            1. Restart the coordinator
            2. Check if reconciliation is paused in config
            3. Review error logs for blocking issues

      - alert: CoordinatorReconciliationNoEvents
        expr: |
          increase(coordinator_reconciliation_events_replayed_total[24h]) == 0
        labels:
          severity: info
          service: coordinator
        annotations:
          summary: "No events replayed in 24h (may indicate healthy operation or disabled reconciliation)"
          description: |
            In 24h, reconciliation replayed 0 events. This can mean:
            - Perfect operation (no missed events)
            - Reconciliation is disabled in config
            - RPC endpoints are having issues
            Verify intentionally.

      # ========================================================================
      # DATABASE ALERTS (Medium: performance degradation)
      # ========================================================================

      - alert: CoordinatorDbQuerySlow
        expr: |
          histogram_quantile(0.95, 
            rate(coordinator_db_query_duration_seconds_bucket[5m])
          ) > 0.1
        for: 10m
        labels:
          severity: warning
          service: coordinator
        annotations:
          summary: "DB query latency high (p95 > 100ms)"
          description: |
            Database queries are slow, impacting order processing.
            1. Check database CPU and disk I/O
            2. Review slow query log
            3. Consider connection pool sizing
            4. Check for long-running transactions

      # ========================================================================
      # ORDER PROCESSING ALERTS (Medium: stuck orders)
      # ========================================================================

      - alert: CoordinatorActiveOrdersHigh
        expr: |
          coordinator_active_orders > 5000
        for: 15m
        labels:
          severity: warning
          service: coordinator
        annotations:
          summary: "Coordinator has {{ $value }} active orders (may indicate slow processing)"
          description: |
            High active order count may indicate:
            1. Slow order processing (check listener lag, DB latency)
            2. Temporary RPC congestion (wait or scale)
            3. Backlog from recent deployment

      - alert: CoordinatorSwapCompletionSlow
        expr: |
          histogram_quantile(0.95, 
            rate(coordinator_swap_duration_seconds_bucket[1h])
          ) > 3600
        for: 30m
        labels:
          severity: warning
          service: coordinator
        annotations:
          summary: "Swap completion p95 > 1h"
          description: |
            Orders are taking longer than expected to complete.
            Review listener lag, DB latency, and reconciliation health.

      # ========================================================================
      # PROCESS & SYSTEM ALERTS (Low: resource exhaustion)
      # ========================================================================

      - alert: CoordinatorHighMemoryUsage
        expr: |
          coordinator_process_resident_memory_bytes > 500_000_000
        for: 10m
        labels:
          severity: warning
          service: coordinator
        annotations:
          summary: "Coordinator memory usage > 500MB"
          description: |
            Check for:
            1. Memory leaks in order processing
            2. Unbounded cache growth
            3. Need to increase container memory limit

      - alert: CoordinatorHttpErrorRate
        expr: |
          (
            sum(rate(coordinator_http_request_duration_seconds_bucket{status_code=~"5.."}[5m]))
            /
            sum(rate(coordinator_http_request_duration_seconds_bucket[5m]))
          ) > 0.001
        for: 5m
        labels:
          severity: warning
          service: coordinator
        annotations:
          summary: "HTTP error rate > 0.1%: {{ $value | humanizePercentage }}"
          description: |
            Review coordinator application logs for errors.
```

---

## Grafana Dashboard Setup

### Pre-Built Dashboard

A dashboard is included at `grafana/dashboards/coordinator.json` with:

- **Listener Overview**: Lag, block progress, event processing
- **Reconciliation Health**: Run success rate, error trend, events replayed
- **Order Metrics**: Active count, completion duration, status distribution
- **System**: Memory, CPU, HTTP latency

### Custom Dashboard Queries

#### Example 1: Listener Lag by Chain (Gauge)

```
coordinator_listener_lag_blocks
```

#### Example 2: Reconciliation Success Rate (Stat)

```
sum(rate(coordinator_reconciliation_runs_total{result="success"}[1h]))
/
sum(rate(coordinator_reconciliation_runs_total[1h]))
```

#### Example 3: DB Query Latency (Time Series)

```
histogram_quantile(0.95, 
  sum(rate(coordinator_db_query_duration_seconds_bucket[5m])) by (operation)
)
```

#### Example 4: Active Orders Over Time (Time Series)

```
coordinator_active_orders
```

---

## Troubleshooting

### Metrics Not Appearing

1. **Verify endpoint is live**:
   ```bash
   curl http://localhost:3000/metrics | head -20
   ```

2. **Check Prometheus targets**:
   - Open `http://localhost:9090/targets`
   - Ensure coordinator target is `UP`

3. **Check scrape config**:
   - Edit `prometheus.yml` to verify the target URL

### Listener Lag Stuck at High Value

1. Check if process is running: `docker ps`
2. Inspect logs: `docker logs wafflefinance_coordinator`
3. Verify RPC endpoint: `curl <RPC_URL>/health`
4. Restart: `docker compose restart`

### Reconciliation Failing

1. Check RPC endpoints for all chains (Ethereum, Soroban, Solana)
2. Verify database connectivity and disk space
3. Review error logs for specific failure reason

### Memory Usage Growing

1. Enable heap dumps and analyze
2. Check for unmanaged subscriptions or timers
3. Restart coordinator if memory approaches limit

---

## Running Observability Stack in Production

### Option 1: External Prometheus (Recommended)

1. Configure external Prometheus to scrape: `http://<coordinator-host>:3000/metrics`
2. Set scrape interval to 30s (or adjust based on alert latency)
3. Set retention to ≥ 30 days
4. Configure alert rules using the rules above
5. Point Grafana to external Prometheus data source

### Option 2: Docker Compose in Production

```bash
cd coordinator/ops
docker compose up -d
```

**Security**: Restrict access to Grafana and Prometheus:
- Use reverse proxy with authentication
- Use firewall rules
- Do not expose on public internet

### Recommended Settings

```yaml
# In prometheus.yml
global:
  scrape_interval: 30s          # Balance latency vs storage
  evaluation_interval: 30s
  external_labels:
    cluster: production
    environment: prod

scrape_configs:
  - job_name: "coordinator"
    static_configs:
      - targets: ["coordinator:3000"]
    metrics_path: /metrics
    relabel_configs:
      - source_labels: [__address__]
        target_label: instance

# Storage retention
command:
  - "--storage.tsdb.retention.time=30d"  # 30 days of history
  - "--query.max-concurrency=10"
```

---

## Prometheus Scrape Config

Edit `ops/prometheus.yml` if the coordinator runs on a different host/port:

```yaml
scrape_configs:
  - job_name: "wafflefinance-coordinator"
    static_configs:
      - targets: ["host.docker.internal:3000"]   # change as needed
    metrics_path: /metrics
```

For a remote coordinator (e.g. Render), replace the target with the public URL and add any required auth headers.

---

## Key Dashboard Panels

| Panel | What to watch |
|---|---|
| **Orders by Status** | Flat/falling curve → listener stalled |
| **Listener Last Block** | Should increase every ~12 s (ETH) / ~5 s (Soroban) |
| **HTTP p95 latency** | Alert if > 500 ms |
| **Process Heap** | Alert if growing unbounded (memory leak) |

---

## Suggested Alerts

```yaml
# coordinator/ops/prometheus.yml — add under rule_files / alerting as needed

- alert: CoordinatorDown
  expr: up{job="wafflefinance-coordinator"} == 0
  for: 2m
  labels:
    severity: critical
  annotations:
    summary: "Coordinator is unreachable"

- alert: ListenerStale
  expr: time() - coordinator_listener_last_block > 120
  for: 5m
  labels:
    severity: warning
  annotations:
    summary: "Listener has not advanced for > 2 minutes"
```

---

## Tear Down

```bash
docker compose down -v   # removes volumes (Grafana state)
```
