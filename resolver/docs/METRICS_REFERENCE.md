# Resolver Metrics Reference

> Issue #769 — Add metric coverage for resolver missed events and stale listeners.  
> Last updated: 2026-09-26  
> Source of truth: `resolver/src/metrics.ts`, `resolver/src/telemetry.ts`

This document is the operator-facing reference for every Prometheus metric the
resolver emits. Metrics are grouped by concern. For each metric the table lists
the name, type, labels, alert threshold recommendation, and the specific
condition it tracks.

The resolver exposes metrics on `GET /metrics` (default port `9090`, overridden
by `RESOLVER_METRICS_PORT`). The health server exposes a focused per-chain view
on `GET /listener-health` (default port `9091`, overridden by
`RESOLVER_HEALTH_PORT`) — see [Health endpoint](#health-endpoint) below.

---

## Table of contents

- [Missed-event and staleness metrics (issue #769)](#missed-event-and-staleness-metrics)
- [Listener liveness metrics](#listener-liveness-metrics)
- [Event throughput metrics](#event-throughput-metrics)
- [Resolver lifecycle metrics](#resolver-lifecycle-metrics)
- [Claim / refund operation metrics](#claim--refund-operation-metrics)
- [Health endpoint](#health-endpoint)
- [Alert threshold summary](#alert-threshold-summary)
- [Dashboard query examples](#dashboard-query-examples)

---

## Missed-event and staleness metrics

These are the primary metrics for issue #769. They make missed-event behaviour
visible from the monitoring interface so degraded states are never hidden behind
generic health responses.

### `resolver_missed_events_total`

| Property | Value |
|----------|-------|
| Type | Counter |
| Labels | `chain`, `reason` |
| Alert threshold | Any non-zero value in a 5-minute window |

Incremented whenever the listener detects it has skipped a batch of events that
should have been processed. Two reasons are emitted today:

- `history_window_overflow` — Soroban: the persisted ledger cursor fell outside
  the RPC's history retention window. The listener clamped to the current ledger
  head and may have silently missed events between the stale cursor and the
  clamp point.
- `slot_regression` — Solana: the confirmed slot regressed beyond
  `REGRESSION_THRESHOLD` slots, indicating a fork. Pending events in the
  affected slot range were dropped to avoid processing double-spends.

**Why this matters:** a single missed-event batch means at minimum one HTLC event
(created, claimed, or refunded) may not have been relayed. If the missed event
was a `claimed` event, the source-leg claim was not submitted and the user's
settlement is delayed until the next event is observed or the user claims
manually. Alert immediately; do not wait for the user to report a stuck swap.

**Recommended alert:**
```promql
increase(resolver_missed_events_total[5m]) > 0
```

---

### `resolver_listener_last_healthy_timestamp_seconds`

| Property | Value |
|----------|-------|
| Type | Gauge |
| Labels | `chain` |
| Alert threshold | `now - value > 300` (5 min) for Soroban; `> 120` (2 min) for Ethereum |

Unix timestamp of the most recent successful poll tick or live event per chain.
Set to `0` when the chain has never had a healthy tick since process startup.

Used as the primary input for staleness detection. A chain that goes silent
produces no events, so only this gauge can tell you when silence became a
problem.

**Recommended alert (Soroban):**
```promql
(time() - resolver_listener_last_healthy_timestamp_seconds{chain="soroban"}) > 300
  and resolver_active_listeners{chain="soroban"} == 1
```

**Recommended alert (Ethereum):**
```promql
(time() - resolver_listener_last_healthy_timestamp_seconds{chain="ethereum"}) > 120
  and resolver_active_listeners{chain="ethereum"} == 1
```

---

### `resolver_listener_staleness_seconds`

| Property | Value |
|----------|-------|
| Type | Gauge |
| Labels | `chain` |
| Alert threshold | `> 300` (5 min) |

Seconds since the last healthy tick, updated by the telemetry collector on every
`GET /telemetry` request and by the `StalenessMonitor.updateStalenessGauges()`
call. Unlike computing `now - last_healthy_timestamp`, this gauge is ready to
read in dashboards without additional PromQL arithmetic.

**Recommended alert:**
```promql
resolver_listener_staleness_seconds > 300
```

---

### `resolver_listener_health_state`

| Property | Value |
|----------|-------|
| Type | Gauge (enum-style: exactly one state = 1 per chain at any time) |
| Labels | `chain`, `state` |
| States | `healthy`, `stale`, `degraded`, `stopped` |
| Alert threshold | `state != "healthy"` for > 3 min |

Encodes the per-chain listener health as a Prometheus-native enum. Exactly one
`(chain, state)` series is `1` at a time; all others for that chain are `0`.

State semantics:

| State | Meaning |
|-------|---------|
| `healthy` | Listener running, successful tick within staleness window, no consecutive failures |
| `stale` | Listener running but no healthy tick for longer than `staleAfterSeconds` |
| `degraded` | Listener running but ≥ 3 consecutive poll failures OR missed event batches recorded |
| `stopped` | Listener not running (`activeListeners = 0`) |

**Recommended alert (any non-healthy state lasting > 3 min):**
```promql
(
  resolver_listener_health_state{state!="healthy"} == 1
) and (
  resolver_listener_health_state{state!="healthy"} offset 3m == 1
)
```

---

### `resolver_listener_consecutive_failures`

| Property | Value |
|----------|-------|
| Type | Gauge |
| Labels | `chain` |
| Alert threshold | `> 3` |

Number of consecutive poll failures since the last successful tick. Reset to `0`
on any healthy tick. Accumulates across supervisor restarts within a single
process lifecycle.

A value above 3 means the listener has failed every recent poll attempt and is
unlikely to self-heal without operator intervention (e.g. RPC endpoint is down
or unreachable from this network location).

**Recommended alert:**
```promql
resolver_listener_consecutive_failures > 3
```

---

### `resolver_listener_health_transitions_total`

| Property | Value |
|----------|-------|
| Type | Counter |
| Labels | `chain`, `from`, `to` |
| Alert threshold | `healthy` → `stale` or `healthy` → `degraded` transitions |

Incremented on every state transition between listener health states. Used to
chart recovery rate (how quickly a chain returns to `healthy` after a degraded
episode) and to alert on specific bad transitions.

**Recommended alert (transition to stale):**
```promql
increase(resolver_listener_health_transitions_total{to="stale"}[5m]) > 0
```

**Recommended alert (transition to degraded):**
```promql
increase(resolver_listener_health_transitions_total{to="degraded"}[5m]) > 0
```

---

### `resolver_event_processing_lag_seconds`

| Property | Value |
|----------|-------|
| Type | Histogram |
| Labels | `chain` |
| Buckets | `0, 1, 5, 10, 30, 60, 120, 300, 600` |
| Alert threshold | p95 > 60 s |

Seconds between the on-chain event timestamp and the resolver processing it.
High lag means the listener is behind the chain tip and settlement may be
delayed. A value of `0` is emitted as a sentinel for chains that do not include
a reliable timestamp in their event payloads.

**Recommended alert:**
```promql
histogram_quantile(0.95,
  rate(resolver_event_processing_lag_seconds_bucket[5m])
) > 60
```

---

## Listener liveness metrics

### `resolver_listener_last_event_timestamp_seconds`

| Property | Value |
|----------|-------|
| Type | Gauge |
| Labels | `chain` |

Unix timestamp of the most recent event (any type) observed per chain. Unlike
`resolver_listener_last_healthy_timestamp_seconds`, this updates on any event
delivery, not just healthy poll ticks. On Ethereum this updates on every `watchEvent`
callback; on Soroban and Solana it updates inside the dispatch path.

---

### `resolver_active_listeners`

| Property | Value |
|----------|-------|
| Type | Gauge |
| Labels | `chain` |
| Values | `1` = running, `0` = stopped |

Set to `1` when a listener starts and `0` when it stops. Used in conjunction with
staleness metrics: an active listener that has gone quiet is more alarming than a
stopped listener (which is expected during restart / shutdown).

---

### `resolver_listener_poll_runs_total`

| Property | Value |
|----------|-------|
| Type | Counter |
| Labels | `chain`, `result` (`success` \| `failure`) |

Total poll runs by outcome. The failure rate (`failure / (success + failure)`)
is the primary signal for whether an RPC endpoint is healthy.

**Recommended alert (high failure rate):**
```promql
rate(resolver_listener_poll_runs_total{result="failure"}[5m])
  /
rate(resolver_listener_poll_runs_total[5m])
> 0.5
```

---

### `resolver_listener_poll_duration_seconds`

| Property | Value |
|----------|-------|
| Type | Histogram |
| Labels | `chain` |
| Buckets | `0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10, 30` |

Duration of each poll tick. p99 above 10 s indicates the RPC endpoint is under
load or the chain is experiencing unusually high block times.

---

### `resolver_listener_errors_total`

| Property | Value |
|----------|-------|
| Type | Counter |
| Labels | `chain`, `error_type` |

Error types emitted today:

| `error_type` | Chain | Meaning |
|---|---|---|
| `poll_error` | all | Unhandled error during a poll tick |
| `handler_error` | all | Event handler callback threw |
| `parse_error` | solana | Malformed JSON in Anchor program log |
| `history_window_overflow` | soroban | Ledger cursor outside RPC retention window |

---

## Event throughput metrics

### `resolver_events_total`

| Property | Value |
|----------|-------|
| Type | Counter |
| Labels | `chain`, `event_type` |

Total HTLC events dispatched to handlers. Event types: `order_created`,
`order_claimed`, `order_refunded` (Ethereum); `created`, `claimed`, `refunded`
(Solana).

A sustained drop to 0 on a chain that normally sees activity is an early-warning
signal before the staleness gauge fires.

---

## Resolver lifecycle metrics

### `resolver_lifecycle_state`

| Property | Value |
|----------|-------|
| Type | Gauge (enum-style) |
| Labels | `state` |
| States | `idle`, `running`, `restarting`, `stopping`, `stopped`, `failed` |

Supervisor state machine. Exactly one state is `1` at any time.

**Recommended alert (failed):**
```promql
resolver_lifecycle_state{state="failed"} == 1
```

### `resolver_runtime_state_info`

| Property | Value |
|----------|-------|
| Type | Gauge (enum-style) |
| Labels | `state` |
| States | `connected`, `degraded`, `stale`, `inactive` |

Coarse telemetry state derived by `ResolverTelemetryCollector`. Mirrors the
`GET /telemetry` response `state` field.

---

### `resolver_start_time_seconds`

| Property | Value |
|----------|-------|
| Type | Gauge |
| Labels | (none) |

Unix timestamp of process start. Use `time() - resolver_start_time_seconds` for
uptime dashboards.

---

## Claim / refund operation metrics

### `resolver_claim_attempts_total`

| Property | Value |
|----------|-------|
| Type | Counter |
| Labels | `chain`, `result` (`success` \| `failure`) |

Total `claimOrder` transaction attempts. Persistent failures indicate either RPC
issues or that the source timelock expired before the resolver could relay the
preimage.

### `resolver_refund_attempts_total`

| Property | Value |
|----------|-------|
| Type | Counter |
| Labels | `chain`, `result` |

Total `refundOrder` transaction attempts.

### `resolver_retry_attempts_total`

| Property | Value |
|----------|-------|
| Type | Counter |
| Labels | `chain`, `operation` |

Total retry submissions. A high retry count relative to attempts indicates
transient RPC instability.

### `resolver_operation_duration_seconds`

| Property | Value |
|----------|-------|
| Type | Histogram |
| Labels | `chain`, `operation` |

End-to-end duration of claim/refund operations including retries.

### `resolver_operation_failures_total`

| Property | Value |
|----------|-------|
| Type | Counter |
| Labels | `chain`, `operation`, `reason` |

Terminal failures (after all retries exhausted).

### `resolver_active_operations`

| Property | Value |
|----------|-------|
| Type | Gauge |
| Labels | `chain`, `operation` |

In-flight operations. Used by `ResolverTelemetryCollector` to derive
`commandQueueDepth`.

---

## Health endpoint

`GET /listener-health` (health server port, default `9091`) returns a focused
per-chain view of the staleness monitor state. This endpoint was added
specifically to satisfy issue #769: "degraded states are not hidden behind
generic health responses."

**Response shape:**

```json
{
  "status": "healthy" | "degraded",
  "allHealthy": true | false,
  "unhealthyChains": ["soroban"],
  "totalMissedEventBatches": 0,
  "chains": [
    {
      "chain": "soroban",
      "healthState": "healthy" | "stale" | "degraded" | "stopped",
      "isActive": true,
      "staleness_seconds": 42,
      "staleAfterSeconds": 300,
      "consecutiveFailures": 0,
      "missedEventBatches": 0,
      "lastHealthyTickAt": "2026-09-26T01:23:45.000Z"
    }
  ],
  "uptime": 3600,
  "pid": 12345,
  "version": "1.0.0"
}
```

**HTTP status codes:**

| Code | Meaning |
|------|---------|
| `200` | All chains healthy |
| `503` | One or more chains stale, degraded, or stopped |

**Relation to `/telemetry`:** `/telemetry` returns the coarse
`connected/degraded/stale/inactive` state of the whole resolver.
`/listener-health` returns the per-chain breakdown. Use `/listener-health` when
you need to know *which* chain is the problem.

---

## Alert threshold summary

| Metric | Condition | Urgency |
|--------|-----------|---------|
| `resolver_missed_events_total` | Any increment in 5 min | HIGH — possible missed settlement |
| `resolver_listener_health_state{state="stale"}` | == 1 for > 3 min | HIGH — chain gone quiet |
| `resolver_listener_health_state{state="degraded"}` | == 1 for > 3 min | MEDIUM — persistent failures |
| `resolver_listener_health_state{state="stopped"}` | == 1 | LOW — expected during restart; HIGH if unexpected |
| `resolver_listener_consecutive_failures` | > 3 | MEDIUM — RPC degraded |
| `resolver_listener_staleness_seconds` | > 300 | HIGH |
| `resolver_lifecycle_state{state="failed"}` | == 1 | HIGH — process will not self-recover |
| `resolver_listener_poll_runs_total` failure rate | > 50% over 5 min | MEDIUM |
| `resolver_event_processing_lag_seconds` p95 | > 60 s | MEDIUM |

---

## Dashboard query examples

### Is the resolver making progress? (top-level health)

```promql
# 1 = connected, check against the enum gauge
resolver_runtime_state_info{state="connected"}
```

### How long since each chain had a healthy tick?

```promql
time() - resolver_listener_last_healthy_timestamp_seconds
```

### Missed event rate over the last hour

```promql
increase(resolver_missed_events_total[1h])
```

### Event throughput per chain (events/min)

```promql
rate(resolver_events_total[5m]) * 60
```

### Claim success rate per chain

```promql
rate(resolver_claim_attempts_total{result="success"}[5m])
  /
rate(resolver_claim_attempts_total[5m])
```

### Uptime

```promql
time() - resolver_start_time_seconds
```
