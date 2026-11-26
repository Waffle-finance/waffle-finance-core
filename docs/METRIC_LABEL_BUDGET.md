<!-- owner: Observability; subject: Prometheus metric label budget and cardinality enforcement -->
# Metric label budget

Prometheus series are the product of metric name and label values. A single
identifier label turns a bounded metric into unbounded state and exposes
sensitive identifiers through scrape endpoints, dashboards, and third-party
observability systems. This document is the canonical label inventory for
coordinator, relayer, and resolver metrics.

## Allowed dimensions

Every metric label must be a bounded enumeration or a small operational
category. The enforcement script allows only these names:

| Category | Labels |
| --- | --- |
| Chain / topology | `chain`, `listener`, `network_mode`, `route`, `direction` |
| HTTP / job classification | `method`, `route`, `status_code`, `job`, `type`, `priority`, `name`, `operation`, `query_name` |
| Outcomes and states | `result`, `outcome`, `decision`, `verdict`, `state`, `from`, `to`, `from_state`, `to_state`, `status`, `mode`, `phase`, `transition`, `trigger`, `recovery_type`, `recovered_to_state`, `checkpoint`, `action`, `mutation`, `path` |
| Error classification | `reason`, `error_type`, `failure_reason`, `failure_category`, `fault_class`, `conflict_type`, `mismatch_type`, `event`, `event_type` |

Budgets:

- At most **4 labels per metric**, and at most **200 exposed samples per
  metric** in a normal deployment.
- Label values must come from a fixed set (e.g. `chain="ethereum"`,
  `outcome="success"`), never from user or chain data.
- Default process metrics are excluded from this application budget.

## Forbidden dimensions

No metric label may contain an order ID, wallet address, resolver address,
preimage, secret, hashlock, transaction signature/hash, user/account, or
public key. The audit rejects label names containing these segments
(`order_id`, `wallet`, `address`, `preimage`, `secret`, `hashlock`,
`signature`, `tx`, `tx_hash`, etc.), even when the value happens to be bounded.

`coordinator_resolver_lock_actions_total` previously carried
`resolver_address`; it now counts by `action` only. Correlate a specific
resolver using redacted application logs or the order record in the database,
not through metrics.

## Safe alternatives for correlation

- Use a request/correlation ID in structured logs with identifier redaction;
  do not promote it to a metric label.
- Query the order record or audit table by ID when investigating one swap.
- Use bounded aggregate labels (chain, route, outcome) to find *which* class
  of operations is unhealthy, then pivot to redacted logs or the database for
  individual transactions.

## Enforcement

The dependency-free audit runs in the `Command Contract` CI workflow on every
push and PR, and can be run locally:

```bash
node scripts/validate-metric-labels.mjs
```

It parses all metric definitions in coordinator, relayer, and resolver and
fails with the offending metric name and source location when a label is
undeclared, high-cardinality, or over budget. Exposition-level tests in
`coordinator/test/metric-label-budget.test.ts` additionally verify that
rendered samples obey the same label and sample-count budgets, and that a
synthetic `order_id` label is rejected with its metric name in the failure.
