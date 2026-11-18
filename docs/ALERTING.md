# Alerting Guide

> **Owner:** Operations
> **Last audited:** 2026-09-27
> **Purpose:** Prometheus alert rules and operational thresholds for the
> coordinator's stale-order cleanup, expiry, and recovery observability.

The coordinator exposes Prometheus metrics at `GET /metrics`
(operator-key authenticated — see `coordinator/src/server/routes/metrics.ts`).
This document is the canonical reference for alerting on the stale-cleanup
and expiry subsystem. For endpoint health signals see
[`docs/HEALTH_DASHBOARD.md`](./HEALTH_DASHBOARD.md); for the metrics endpoint
and deployment topology see [`docs/OPERATIONS.md`](./OPERATIONS.md).

---

## Stale-Order Cleanup Metrics

All metrics below are emitted by the coordinator's `StaleCleanupService`
(`coordinator/src/services/stale-cleanup.ts`), which runs as the
`stale_cleanup` maintenance job (default cadence: every ~60 minutes,
`pollIntervalMs × 240`).

| Metric | Type | Labels | Meaning |
| ------ | ---- | ------ | ------- |
| `coordinator_stale_cleanup_runs_total` | counter | `result` (`success`\|`failure`) | Cleanup runs by outcome — success and failure are always distinguished |
| `coordinator_stale_orders_archived_total` | counter | — | Cumulative orphaned announced orders archived |
| `coordinator_stale_cleanup_backlog` | gauge | `direction` | **Backlog size** — orphaned announced orders awaiting cleanup, published at the start of every run |
| `coordinator_stale_cleanup_remaining` | gauge | `direction` | **Remaining backlog** — candidates left unarchived after the last run (batch-size truncation leftover) |
| `coordinator_stale_cleanup_run_duration_seconds` | histogram | — | Wall-clock seconds per cleanup run |
| `coordinator_stale_orders_archived_age_seconds` | histogram | — | Age at archival — how long each order sat orphaned (seconds) |
| `coordinator_stale_cleanup_already_archived_skipped_total` | counter | — | Run-overs landing on already-archived rows (candidate-query drift; expect 0) |
| `coordinator_stale_cleanup_last_run_timestamp_seconds` | gauge | — | Unix timestamp of the last cleanup run (success or failure) |

### Expiry metrics

Emitted by the `expiry_scan` maintenance job (default cadence: every ~60
seconds, `pollIntervalMs × 4`).

| Metric | Type | Labels | Meaning |
| ------ | ---- | ------ | ------- |
| `coordinator_expiry_scan_runs_total` | counter | `result` | Expiry scan runs by outcome |
| `coordinator_orders_expired_total` | counter | — | Orders transitioned to `expired` by the timelock scan |
| `coordinator_expired_orders_backlog` | gauge | `direction` | **Expired backlog** — orders currently in `expired` state awaiting refund/failure |
| `coordinator_orders_expired_skipped_total` | counter | — | Idempotent no-op skips (already `expired`) |
| `coordinator_orders_expired_terminal_skipped_total` | counter | — | Candidates already terminal (candidate-query drift; expect 0) |
| `coordinator_expiry_scan_last_run_timestamp_seconds` | gauge | — | Unix timestamp of the last expiry scan |

### Failed-recovery metrics

| Metric | Type | Labels | Meaning |
| ------ | ---- | ------ | ------- |
| `coordinator_secret_recovery_outcome_total` | counter | `outcome` | Secret recovery attempts: `recovered`, `already_known`, `invalid_preimage`, `state_conflict`, `error` |
| `coordinator_reconciliation_conflicts_total` | counter | `chain`, `conflict_type` | DB/chain state conflicts detected by the reconciler |
| `coordinator_reconciliation_ambiguous_states_total` | counter | `chain` | Orders whose state could not be deterministically resolved — needs operator review |
| `coordinator_reconciliation_chain_errors_total` | counter | `chain` | Per-chain RPC failures that skipped a chain for a whole run |
| `coordinator_listener_recovery_runs_total` | counter | `chain`, `result` | Bounded replay/recovery runs by outcome |

---

## Recommended Alert Rules

Copy into your Prometheus rules file. Thresholds are operational starting
points — tune to your order volume. Directions are `eth_to_xlm`, `xlm_to_eth`,
`eth_to_sol`, `sol_to_eth`.

```yaml
groups:
  - name: coordinator-stale-cleanup
    rules:
      # Backlog growing beyond the acceptable threshold.
      # Acceptance criteria for issue #740: operators get a clear operational
      # indication when the stale-order backlog grows beyond acceptable levels.
      - alert: StaleCleanupBacklogHigh
        expr: coordinator_stale_cleanup_backlog > 50
        for: 30m
        labels:
          severity: warning
        annotations:
          summary: Stale-order backlog is growing
          description: "{{ $value }} stale {{ $labels.direction }} orders are awaiting cleanup. Orphaned announcements are outpacing the every-hour cleanup job."

      # Batch truncation is leaving work behind run over run — the arrival
      # rate of orphaned orders exceeds cleanup throughput.
      - alert: StaleCleanupRemainingGrowing
        expr: coordinator_stale_cleanup_remaining > 0
        for: 2h
        labels:
          severity: warning
        annotations:
          summary: Stale cleanup is not keeping up
          description: "{{ $value }} stale {{ $labels.direction }} orders were left unarchived after the last run. Raise the batch size or investigate the announcement failure."

      # Cleanup failures — success and failure are distinguished by the
      # result label; any failure rate is actionable.
      - alert: StaleCleanupFailures
        expr: rate(coordinator_stale_cleanup_runs_total{result="failure"}[15m]) > 0
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: Stale cleanup is failing
          description: "stale_cleanup runs are failing ({{ $value }}/s over 15m). Check coordinator logs for 'stale order cleanup failed'."

      # The job has stopped running altogether (default cadence ~60 min,
      # pollIntervalMs × 240). Fire after two missed runs.
      - alert: StaleCleanupJobStalled
        expr: time() - coordinator_stale_cleanup_last_run_timestamp_seconds > 7200
        for: 15m
        labels:
          severity: critical
        annotations:
          summary: Stale cleanup job has not run recently
          description: "No stale_cleanup run in over 2h. Orphaned announced orders are accumulating unobserved."

      # Run duration regression — p95 cleanup latency above 30s usually
      # means table-scan degradation as the orders table grows.
      - alert: StaleCleanupSlow
        expr: histogram_quantile(0.95, rate(coordinator_stale_cleanup_run_duration_seconds_bucket[15m])) > 30
        for: 30m
        labels:
          severity: warning
        annotations:
          summary: Stale cleanup runs are slow
          description: "p95 stale_cleanup run duration is {{ $value }}s. Check orders table indexes (status, created_at)."

  - name: coordinator-expiry
    rules:
      # Expired orders are waiting on refund/failure transitions. A sustained
      # backlog means the refund path (resolver/relayer) is stuck.
      - alert: ExpiredOrdersBacklogHigh
        expr: coordinator_expired_orders_backlog > 20
        for: 30m
        labels:
          severity: warning
        annotations:
          summary: Expired-order backlog is growing
          description: "{{ $value }} {{ $labels.direction }} orders are expired and awaiting refund/failure. Check the refund path."

      # Same stall pattern as stale cleanup — default cadence ~60 s
      # (pollIntervalMs × 4). Fire after two missed runs.
      - alert: ExpiryScanJobStalled
        expr: time() - coordinator_expiry_scan_last_run_timestamp_seconds > 300
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: Expiry scan job has not run recently
          description: "No expiry_scan run in over 5m. Orders whose timelock elapsed are not being expired."

  - name: coordinator-recovery
    rules:
      # Failed recovery paths — invalid preimages or errors from the secret
      # reconciler indicate replayed or malformed events.
      - alert: SecretRecoveryFailures
        expr: rate(coordinator_secret_recovery_outcome_total{outcome=~"invalid_preimage|error"}[15m]) > 0
        for: 15m
        labels:
          severity: warning
        annotations:
          summary: Secret recovery is failing
          description: "invalid_preimage/error outcomes from the secret reconciler ({{ $value }}/s)."

      # Any deterministic-unresolvable order needs manual operator review.
      - alert: ReconciliationAmbiguousStates
        expr: increase(coordinator_reconciliation_ambiguous_states_total[1h]) > 0
        labels:
          severity: critical
        annotations:
          summary: Ambiguous order states detected
          description: "{{ $value }} order(s) could not be deterministically resolved in the last hour. Manual review required."
```

---

## Dashboard Panels

Recommended Grafana panels for stale-order tracking (the acceptance
criteria for issue #740 — track stale-order volume over time):

1. **Stale backlog by direction**: `coordinator_stale_cleanup_backlog`
2. **Stale orders archived per hour**: `rate(coordinator_stale_orders_archived_total[1h])`
3. **Cleanup run success vs failure**: `sum by (result) (rate(coordinator_stale_cleanup_runs_total[1h]))`
4. **Remaining (unarchived) after run**: `coordinator_stale_cleanup_remaining`
5. **Archived-order age distribution**: `histogram_quantile(0.5, rate(coordinator_stale_orders_archived_age_seconds_bucket[1h]))`
6. **Expired backlog by direction**: `coordinator_expired_orders_backlog`

---

## Operational Thresholds Summary

| Signal | Warning | Critical | Notes |
| ------ | ------- | -------- | ----- |
| Stale backlog (`stale_cleanup_backlog`) | > 50 for 30m | > 200 for 1h | Per-direction sum |
| Stale remaining after run (`stale_cleanup_remaining`) | > 0 for 2h | > 10 for 6h | Means batch truncation is chronic |
| Stale cleanup failure rate | any in 5m | — | `result="failure"` |
| Stale cleanup run p95 | > 30s | > 120s | Run duration histogram |
| Stale cleanup job silence | — | > 2h | Default cadence ~60 min |
| Expired backlog (`expired_orders_backlog`) | > 20 for 30m | > 100 for 2h | Awaiting refund/failure |
| Expiry scan job silence | — | > 5m | Default cadence ~60 s |
| Secret recovery `invalid_preimage`/`error` | > 0 for 15m | — | Reconciler input quality |
| Reconciliation ambiguous states | — | any in 1h | Needs manual review |
