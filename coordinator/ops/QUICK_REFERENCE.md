# Coordinator Observability - Quick Reference

**Print this or keep in your terminal favorites**

---

## Essential Commands

```bash
# Check coordinator is running
curl http://coordinator:3000/health

# View current metrics
curl http://coordinator:3000/metrics | grep coordinator_

# Check listener lag (MOST IMPORTANT)
curl http://coordinator:3000/metrics | grep coordinator_listener_lag_blocks

# View logs
docker logs wafflefinance-coordinator | tail -100

# Check database
docker exec wafflefinance-postgres psql -U coordinator -d coordinator -c "SELECT 1;"

# Restart if needed
docker restart wafflefinance-coordinator
```

---

## 5-Minute Diagnosis

When an alert fires, run these in order:

```bash
# 1. Is coordinator running?
curl http://coordinator:3000/health

# 2. What's the listener lag?
curl http://coordinator:3000/metrics | grep coordinator_listener_lag_blocks

# 3. Are reconciliation and DB working?
curl http://coordinator:3000/metrics | grep -E 'reconciliation|db_query'

# 4. Check logs for errors
docker logs wafflefinance-coordinator | tail -50

# 5. If everything looks bad, restart
docker restart wafflefinance-coordinator
```

---

## Alert → Action Matrix

| Alert | First Action | Second Action | Escalate If |
|-------|--------------|---------------|-------------|
| **ListenerLagHigh** | Check RPC health | Restart coordinator | Lag stays high > 30m |
| **ListenerLagCritical** | **Restart now** | Verify RPC | Still critical after restart |
| **ReconciliationStale** | Restart coordinator | Monitor logs | Still stale > 10m |
| **DbQueryLatencyHigh** | Check database load | Monitor orders | Latency doesn't improve |
| **ActiveOrdersHigh** | Check listener lag | Monitor trend | Count keeps growing |
| **HttpErrorRateHigh** | Check application logs | Monitor errors | Errors persist |
| **MemoryUsageHigh** | Monitor trend | Restart if > 1GB | Memory keeps growing |

---

## Metric Quick Checks

```bash
# High listener lag?
curl -s http://coordinator:3000/metrics | grep 'coordinator_listener_lag_blocks{chain'

# Reconciliation failing?
curl -s http://coordinator:3000/metrics | grep 'coordinator_reconciliation_runs_total'

# Active orders stuck?
curl -s http://coordinator:3000/metrics | grep 'coordinator_active_orders'

# Database slow?
curl -s http://coordinator:3000/metrics | grep 'coordinator_db_query_duration_seconds'
```

---

## Key Thresholds (Remember These)

| Metric | Warning | Critical |
|--------|---------|----------|
| Listener Lag | > 100 blocks | > 500 blocks |
| Reconciliation | No run > 1h | Already alerted |
| DB Query p95 | > 100ms | > 500ms |
| Active Orders | > 5000 | > 10000 |
| Memory | > 500MB | > 1GB |
| HTTP Errors | > 0.1% | > 1% |

---

## Dashboards & Links

- **Prometheus**: `http://prometheus:9090`
  - Query explorer: `Status > Query`
  - Targets: `Status > Targets`

- **Grafana**: `http://grafana:3000`
  - Coordinator dashboard: Search for "coordinator"

- **Logs**: Check `docker logs` or your logging service

---

## Emergency Contacts

```
On-call: [Platform team Slack #oncall]
Escalation: [Platform lead name]
DB Team: [Database team Slack]
```

---

## Useful Queries for Prometheus

```
# Listener lag by chain
coordinator_listener_lag_blocks

# Reconciliation success rate (%)
sum(rate(coordinator_reconciliation_runs_total{result="success"}[1h])) / sum(rate(coordinator_reconciliation_runs_total[1h]))

# Active orders
coordinator_active_orders

# DB latency p95
histogram_quantile(0.95, rate(coordinator_db_query_duration_seconds_bucket[5m]))

# HTTP error rate (%)
sum(rate(coordinator_http_request_duration_seconds_bucket{status_code=~"5.."}[5m])) / sum(rate(coordinator_http_request_duration_seconds_bucket[5m]))
```

---

## Did You Know?

- **Listener lag can spike** during RPC congestion but usually recovers
- **Reconciliation runs every 5m** (check prometheus for schedule)
- **Active orders trend up** when orders are processing normally (lag reduces them)
- **Database can slow down** under load; check active connections
- **Restart restarts logs** — capture them first if debugging

---

## Never Do This

❌ Don't reboot the database without warning  
❌ Don't purge old metrics without checking alert rules  
❌ Don't change alert thresholds without testing  
❌ Don't ignore critical alerts — always investigate  
❌ Don't assume "it's fine" if metrics look weird — check logs  

---

## Next Steps

1. Read full guide: [`coordinator/ops/README.md`](./README.md)
2. Study runbooks: [`coordinator/ops/RUNBOOK.md`](./RUNBOOK.md)
3. Review alert rules: [`coordinator/ops/coordinator-alerts.yml`](./coordinator-alerts.yml)

---

**Last Updated**: 2026-06-26  
**Questions?** See RUNBOOK.md or README.md for detailed guidance
