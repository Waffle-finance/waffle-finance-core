# Coordinator Observability Documentation Index

Welcome to the WaffleFinance Coordinator observability system. This directory contains everything you need to monitor, alert on, and debug the coordinator in production.

---

## 📖 Documentation Files

### Quick References (Start Here!)

| Document | Purpose | Audience | Time |
|----------|---------|----------|------|
| **[QUICK_REFERENCE.md](./QUICK_REFERENCE.md)** | Emergency cheat sheet for on-call engineers | On-call, SRE | 5 min |
| **[README.md](./README.md)** | Complete observability guide with metrics & alert rules | Platform eng | 30 min |
| **[RUNBOOK.md](./RUNBOOK.md)** | Production setup & troubleshooting runbooks | Ops, DevOps | 45 min |

### Configuration Files

| File | Purpose | Audience |
|------|---------|----------|
| **[coordinator-alerts.yml](./coordinator-alerts.yml)** | Prometheus alert rules ready to import | Platform eng |
| **[prometheus.yml](./prometheus.yml)** | Prometheus scrape configuration | DevOps |
| **[docker-compose.yml](./docker-compose.yml)** | Local dev stack (Prometheus + Grafana) | Developers |

### Grafana Dashboards

| File | Location | Purpose |
|------|----------|---------|
| **coordinator.json** | `grafana/dashboards/` | Main production dashboard |

---

## 🚀 Getting Started

### For Local Development

```bash
cd coordinator/ops
docker compose up -d
# Visit http://localhost:9090 (Prometheus)
# Visit http://localhost:3001 (Grafana - admin/wafflefinance)
```

### For Production Setup

1. **Read** [README.md](./README.md#production-monitoring-checklist) - Essential checklist
2. **Configure** Prometheus using [prometheus.yml](./prometheus.yml) as template
3. **Load** alert rules from [coordinator-alerts.yml](./coordinator-alerts.yml)
4. **Import** dashboard from `grafana/dashboards/coordinator.json`
5. **Test** by checking Prometheus targets: `http://prometheus:9090/targets`

### For On-Call Duty

1. **Keep** [QUICK_REFERENCE.md](./QUICK_REFERENCE.md) open or printed
2. **Study** the [Alert → Action Matrix](./QUICK_REFERENCE.md#alert--action-matrix)
3. **Know** the [5-Minute Diagnosis](./QUICK_REFERENCE.md#5-minute-diagnosis)
4. **Bookmark** this directory for emergency access

---

## 📊 Key Metrics to Know

### Critical (Order Processing)

| Metric | Threshold | Reference |
|--------|-----------|-----------|
| `coordinator_listener_lag_blocks` | > 100 = warn, > 500 = critical | [README Listener Alerts](./README.md#listener-alerts-critical-order-processing-delays) |
| `coordinator_reconciliation_last_run_timestamp_seconds` | > 3600s = critical | [README Reconciliation](./README.md#reconciliation-alerts-high-missed-events--stuck-funds) |

### Important (Performance)

| Metric | Threshold | Reference |
|--------|-----------|-----------|
| `coordinator_db_query_duration_seconds` (p95) | > 100ms = warn | [README DB Alerts](./README.md#database-alerts-medium-performance-degradation) |
| `coordinator_active_orders` | > 5000 = warn | [README Order Alerts](./README.md#order-processing-alerts-medium-stuck-orders) |

### Health (Resource)

| Metric | Threshold | Reference |
|--------|-----------|-----------|
| `coordinator_process_resident_memory_bytes` | > 500MB = warn, > 1GB = critical | [README Process Alerts](./README.md#process--system-alerts-low-resource-exhaustion) |

---

## 🔍 Troubleshooting Quick Links

| Problem | Solution |
|---------|----------|
| Metrics not showing | [README > Troubleshooting](./README.md#troubleshooting) |
| Alerts not firing | [RUNBOOK > Alert Integration](./RUNBOOK.md#alert-integration) |
| Listener lag stuck high | [RUNBOOK > ListenerLagHigh](./RUNBOOK.md#alert-listenerlaghigh) |
| Reconciliation stale | [RUNBOOK > ReconciliationStale](./RUNBOOK.md#alert-reconciliationstale) |
| Memory growing | [RUNBOOK > Troubleshooting](./RUNBOOK.md#memory-growing-over-time) |

---

## 🎯 Success Criteria

Your monitoring is working when:

- ✅ Prometheus is scraping metrics (check `Status > Targets`)
- ✅ Alert rules are loaded (check `Alerts` tab)
- ✅ Grafana dashboard displays live data
- ✅ An alert fires when you manually increase a metric (test it!)
- ✅ You receive notifications via your alerting channel (Slack/PagerDuty)

---

## 📈 Production Monitoring Phases

### Phase 1: Essential (Week 1)

- [ ] Setup Prometheus to scrape coordinator
- [ ] Load alert rules
- [ ] Configure Alertmanager routing
- [ ] Test one alert fires
- [ ] Document your endpoints

**Goal**: Basic observability operational

### Phase 2: Advanced (Week 2-4)

- [ ] Setup Grafana dashboards
- [ ] Train team on key metrics
- [ ] Create runbooks for common alerts
- [ ] Implement alert SLA tracking
- [ ] Document escalation paths

**Goal**: Production-ready monitoring

### Phase 3: Hardened (Week 4+)

- [ ] Analyze alert noise, tune thresholds
- [ ] Implement metric retention policy
- [ ] Setup backup alerting channels
- [ ] Document lessons learned
- [ ] Regular runbook reviews

**Goal**: Optimized, reliable alerting

---

## 📚 Full Documentation Structure

```
coordinator/ops/
├── README.md                    ← Full observability guide
├── RUNBOOK.md                   ← Production setup & ops runbooks
├── QUICK_REFERENCE.md           ← On-call cheat sheet (THIS FILE)
├── INDEX.md                     ← This file
├── coordinator-alerts.yml       ← Prometheus alert rules
├── prometheus.yml               ← Prometheus config template
├── docker-compose.yml           ← Local dev stack
└── grafana/
    ├── dashboards/
    │   └── coordinator.json     ← Main dashboard
    └── provisioning/
        ├── dashboards/
        └── datasources/
```

---

## 🆘 Getting Help

**Question**: Where do I find...?
- **Metrics reference**: [README.md > Exported Metrics](./README.md#exported-metrics)
- **Alert setup**: [RUNBOOK.md > Monitoring Setup](./RUNBOOK.md#monitoring-setup)
- **Troubleshooting**: [RUNBOOK.md > Troubleshooting Guide](./RUNBOOK.md#troubleshooting-guide)
- **Emergency response**: [QUICK_REFERENCE.md](./QUICK_REFERENCE.md)

**Problem**: Alert is firing but looks wrong
- Check alert threshold (may be too aggressive)
- See [RUNBOOK.md > Alerts Firing but No Issue](./RUNBOOK.md#alerts-firing-but-no-issue)

**Problem**: Can't find docs for something
- Check the full [README.md](./README.md) table of contents
- Check [RUNBOOK.md](./RUNBOOK.md) setup section

---

## ✅ Checklist: Before Going to Production

- [ ] Coordinator's `/metrics` endpoint is accessible
- [ ] Prometheus is scraping coordinator (check targets page)
- [ ] Alert rules are loaded and showing in Prometheus UI
- [ ] Alertmanager is configured with your notification channel
- [ ] Grafana dashboard is imported and showing data
- [ ] You can manually trigger a test alert and receive notification
- [ ] On-call team has access to [QUICK_REFERENCE.md](./QUICK_REFERENCE.md)
- [ ] You've read [RUNBOOK.md](./RUNBOOK.md)
- [ ] Metric retention is set appropriately (30d+ recommended)
- [ ] Backup alerting channel is configured

---

## 📝 Document Versions

| Document | Version | Date | Author |
|----------|---------|------|--------|
| README.md | 1.0 | 2026-06-26 | Platform Team |
| RUNBOOK.md | 1.0 | 2026-06-26 | Platform Team |
| QUICK_REFERENCE.md | 1.0 | 2026-06-26 | Platform Team |
| coordinator-alerts.yml | 1.0 | 2026-06-26 | Platform Team |

**Last Updated**: 2026-06-26

---

## 🔗 Related Resources

- **Main Coordinator README**: `../../README.md`
- **Coordinator Source**: `../src/`
- **Test Examples**: `../test/`
- **Configuration**: `../src/config.ts`
- **Metrics Implementation**: `../src/metrics.ts`

---

**Questions? Start with [QUICK_REFERENCE.md](./QUICK_REFERENCE.md) for a quick answer, then read [README.md](./README.md) for details.**
