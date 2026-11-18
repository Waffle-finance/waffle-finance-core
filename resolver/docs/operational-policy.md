# Resolver Operational Policy

This document describes how the WaffleFinance resolver behaves under partial
and total chain outages, and what operators should do in each degraded state.

---

## Chain health state machine

Each chain the resolver tracks goes through three states:

```
healthy  ──(failures ≥ degrade_threshold)──▶  degraded
  ▲                                               │
  │         (failures ≥ suspend_threshold)        ▼
  └─────────────────(success)──────────────── suspended
```

| State      | Meaning                                         |
|------------|-------------------------------------------------|
| `healthy`  | Chain is responding normally.                   |
| `degraded` | Failures are elevated but below suspend ceiling. |
| `suspended`| Consecutive failures reached the suspend threshold. Actions halted. |

Default thresholds (configurable via `ChainFallbackPolicy`):
- `degrade_threshold`: **2** consecutive failures
- `suspend_threshold`: **5** consecutive failures

---

## Per-state operator runbook

### `healthy` — no action needed

The resolver is polling and processing events normally. No intervention required.

---

### `degraded` — monitor closely

**What is happening:** One or more RPC calls have failed recently but the chain
has not yet been suspended. The resolver is retrying with exponential backoff.

**What to check:**
1. Look at `resolver_listener_errors_total{chain="<chain>"}` in Prometheus.
2. Check the resolver logs for `chain-fallback: <chain> → degraded`.
3. Verify the RPC endpoint is reachable: `curl <rpc_url>`.
4. Check for upstream network issues or provider maintenance windows.

**What the resolver is doing:**
- Continuing to listen and process events where possible.
- Retrying failed RPC calls with backoff scaled to the error type
  (`timeout` → short backoff, `unavailable` → long backoff).
- No actions are suppressed — claims and refunds proceed as normal.

**When to escalate:** If the chain stays in `degraded` for more than
`suspend_threshold - degrade_threshold` additional failures without recovering,
it will transition to `suspended` automatically.

---

### `suspended` — immediate operator attention required

**What is happening:** The resolver has seen `suspend_threshold` consecutive
failures on this chain without a single success. To prevent runaway retry
loops and to avoid submitting claims against an endpoint that cannot be
confirmed, **the resolver has halted all actions on this chain**.

**What the resolver is doing:**
- **Listener polling is paused** — no new events are fetched from this chain.
- **No claims or refunds are issued** — `canAct()` returns `false`.
- The other chains continue operating normally.
- The `/telemetry` endpoint reports `state: "degraded"` (at minimum).
- `resolver_listener_errors_total{chain="<chain>",error_type="poll_error"}` is incrementing.

**What to do (in order):**

1. **Verify the RPC endpoint:**
   ```
   curl -X POST <rpc_url> \
     -H 'Content-Type: application/json' \
     -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
   ```
   For Soroban:
   ```
   curl <rpc_url>/network
   ```

2. **Check for provider incidents** at the relevant status page
   (Alchemy / Infura / QuickNode / Stellar Foundation).

3. **Once the endpoint is confirmed healthy**, the resolver will auto-recover
   on the next successful poll — no manual restart is required.

4. **If the endpoint has permanently changed** (e.g. migration to a new
   provider), update `RESOLVER_ETH_RPC_URL` / `SOROBAN_RPC_URL` and restart
   the resolver process. The supervisor will restart listeners cleanly.

5. **Force a manual reset** (if the provider is healthy but the resolver
   hasn't recovered yet):
   ```
   # Send SIGHUP to trigger a graceful restart
   kill -HUP <pid>
   ```
   Or call `ChainFallbackPolicy.forceReset("<chain>")` via the admin API if
   one is wired up.

**Do NOT:**
- Restart the pod in a tight loop — the supervisor already has capped backoff.
- Lower the suspend threshold below 3 — this causes false suspensions on
  transient blips.

---

## Partial chain failure (one chain down, others healthy)

When chain A is suspended and chain B is healthy:

- The resolver **continues observing and acting on chain B** as normal.
- Events on chain A that arrive during the suspension window **will be missed**
  unless the chain's event history is replayed on recovery.
- For Soroban: the cursor-based polling means events are NOT missed if the
  outage is within the RPC node's retention window (~7 days on most providers).
  On recovery the listener resumes from the last persisted cursor.
- For Ethereum: viem's `watchEvent` subscription is torn down and restarted by
  the supervisor. Events during the outage window may require a historical
  backfill if the provider does not replay missed subscription events.

---

## Total chain failure (all chains suspended)

When all configured chains are suspended:

- The resolver enters `state: "degraded"` on `/telemetry`.
- No claims or refunds are issued.
- The supervisor does NOT exit — it waits for the chains to recover.
- The `/readyz` endpoint returns `503` (supervisor state is still `running`
  but telemetry is degraded).

**Operator action:** Follow the `suspended` runbook for each chain. Coordinate
with the team to confirm whether the outage is provider-side or network-wide.
Consider pausing new order announcements on the coordinator until at least one
chain recovers.

---

## Metrics reference

| Metric | Meaning |
|--------|---------|
| `resolver_listener_errors_total{chain,error_type}` | Cumulative listener errors by type |
| `resolver_listener_poll_runs_total{chain,result}` | Poll run outcomes (success/failure) |
| `resolver_listener_last_event_timestamp_seconds{chain}` | Age of last received event |
| `resolver_runtime_state_info{state}` | Current runtime state (1 = active) |
| `resolver_active_listeners{chain}` | Whether listener is active (1/0) |

Suggested alerting rules:
- Alert when `resolver_listener_last_event_timestamp_seconds` age exceeds 5 minutes on any chain.
- Alert when `resolver_runtime_state_info{state="suspended"} == 1`.
- Alert when `resolver_listener_errors_total` rate exceeds 1/min for 5 minutes.

---

## Retry and backoff reference

RPC errors are classified before applying backoff so the delay is proportional
to the severity:

| Error class    | Base delay multiplier | Typical scenarios |
|----------------|-----------------------|-------------------|
| `timeout`      | ×0.5                  | Read timeout, ETIMEDOUT |
| `partial`      | ×0.5                  | Malformed JSON, truncated response |
| `reset`        | ×0.75                 | ECONNRESET, socket hang up |
| `transient`    | ×1.0                  | Tagged TransientError |
| `unknown`      | ×1.0                  | Unclassified errors |
| `unavailable`  | ×1.5                  | ECONNREFUSED, 503 |
| `rate_limited` | ×2.0                  | HTTP 429, "too many requests" |

With the default base of 1 000 ms and a cap of 30 000 ms, a rate-limited
endpoint will see delays of approximately 2 s → 4 s → 8 s → 16 s → 30 s
across five attempts before the supervisor considers a restart.
