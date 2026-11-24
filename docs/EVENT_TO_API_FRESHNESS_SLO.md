<!-- owner: Platform reliability; subject: event-to-API freshness SLO, measurement and alert response -->
# Event-to-API freshness SLO

**Objective:** for finalized chain events whose observation time is
trustworthy, the related order transition must be durably visible through the
coordinator API within the target below, measured as a per-chain histogram.

| Chain | Observation boundary | Target (p95) | Finality assumption |
| --- | --- | --- | --- |
| Ethereum | Listener observes a finalized `OrderCreated`/claim/refund event | 60 s | Poll interval + configured confirmation depth |
| Soroban | Listener observes a finalized ledger event | 60 s | Ledger close + confirmation window |
| Solana | Listener observes a finalized slot event | 60 s | Slot finalization + poll interval |

The signal is `coordinator_event_to_api_freshness_seconds{chain="..."}`. It has
only a bounded `chain` label; no order ID, wallet, preimage, or transaction
signature is exposed. Samples are recorded at the durable order transition
(the repository write that makes the state queryable via `/orders`), using the
listener-supplied observation timestamp. The recorder skips missing, future,
or older-than-24-hour timestamps instead of guessing, so only events with a
trustworthy observation time are measured.

## Separating finality from processing delay

Compare two signals before paging a listener owner:

- `coordinator_event_to_api_freshness_seconds` — total observation-to-API time.
- `coordinator_listener_lag_blocks{chain="..."}` and
  `coordinator_listener_last_block` — distance from the chain head and
  listener progress.
- `coordinator_soroban_listener_last_poll_timestamp_seconds` and
  `coordinator_listener_event_processing_duration_seconds` — coordinator
  processing/poll health.

If freshness and listener lag rise together, the chain/RPC endpoint is likely
slow or the confirmation depth is not met yet. If lag is flat but freshness
rises, the delay is in coordinator processing or the database write path.

## Dashboard and alerting

Panel: `histogram_quantile(0.95, sum by (le, chain) (rate(coordinator_event_to_api_freshness_seconds_bucket[5m])))`.
Alert `EventToApiFreshnessSLO` fires when p95 exceeds 60 s for 10 minutes.

Runbook guidance:

1. Confirm the alert is per-chain and that sample count is non-zero; a missing
   histogram means no trusted observations, not a passing SLO.
2. Check `/readyz` and the chain's listener lag before changing any config.
3. If finality delay dominates, verify RPC provider health using
   [`RPC_PROVIDER_FAILOVER_RUNBOOK.md`](RPC_PROVIDER_FAILOVER_RUNBOOK.md).
   Do not reset durable cursors to improve a metric.
4. If processing delay dominates, inspect database write latency and event
   processing duration, then escalate to the coordinator owner.
5. Sustained misses (> 30 min) or a burn rate that threatens the 30-day error
   budget require an incident. Track cumulative miss duration in the incident
   review; do not relax the target without an explicit SLO review.
