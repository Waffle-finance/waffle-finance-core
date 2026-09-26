# Debugging Guide

> **Owner:** Engineering team  
> **Last updated:** 2026-09-25  
> **Purpose:** Fast triage paths during incidents. Start here — not the source code.

This guide is organized around symptoms, not architecture. Find the failure mode you're
seeing, follow the steps in order, and stop when the problem is resolved. Cross-references
to deeper docs are provided at each decision point.

For service health endpoint contracts, see [`docs/HEALTH_DASHBOARD.md`](./HEALTH_DASHBOARD.md).  
For rollback procedures, see [`docs/DEPLOYMENT_ROLLBACK_RUNBOOK.md`](./DEPLOYMENT_ROLLBACK_RUNBOOK.md).  
For production ops checklist, see [`docs/OPERATIONS.md`](./OPERATIONS.md).

---

## Table of Contents

- [Quick orientation](#quick-orientation)
- [Where to start per package](#where-to-start-per-package)
- [Coordinator](#coordinator)
- [Relayer](#relayer)
- [Resolver](#resolver)
- [Frontend](#frontend)
- [Diagnostic matrix](#diagnostic-matrix)
  - [Network failure](#network-failure)
  - [Database drift](#database-drift)
  - [Order stuck states](#order-stuck-states)
- [Log and telemetry reference](#log-and-telemetry-reference)
- [Common multi-service scenarios](#common-multi-service-scenarios)

---

## Quick orientation

Before diving into a specific service, run these three checks. They rule out the most
common systemic causes and take under two minutes.

```bash
# 1. Are all services reachable?
curl -sf "$COORDINATOR_URL/health"          || echo "COORDINATOR DOWN"
curl -sf "$RELAYER_URL/api/health"          || echo "RELAYER DOWN"
curl -sf "$RESOLVER_HEALTH_URL/health"      || echo "RESOLVER DOWN"

# 2. Are the chain listeners healthy?
curl -s "$COORDINATOR_URL/readyz" | jq '.checks'

# 3. Any orders stuck in a non-terminal state > 24h?
curl -s "$COORDINATOR_URL/metrics" | grep coordinator_active_orders
```

If a service is down, jump to [Where to start per package](#where-to-start-per-package).
If services are up but an order is stuck, jump to [Order stuck states](#order-stuck-states).

---

## Where to start per package

| You're investigating... | First look | Key log field |
|---|---|---|
| **Coordinator** | `GET /readyz` + Pino structured logs | `orderId`, `publicId` |
| **Relayer** | `GET /api/debug/chain-monitor` + console output | `orderId=` or `orderHash=` |
| **Resolver** | `GET /readyz` + `GET /telemetry` + Pino logs | `chain`, `event`, `state` |
| **Frontend** | Browser devtools Network tab → coordinator API calls | — |
| **Cross-service** | Coordinator logs first (it owns authoritative order state), then match `publicId` in relayer/resolver output | `publicId` |

> **Relayer log caveat (TD-051):** The relayer uses `console.log`/`console.error` rather
> than structured JSON. Log aggregation tools cannot parse it. To correlate a relayer
> event with a coordinator order, match the `orderId=<n>` or `orderHash=<hex>` text
> fields manually. Full structured logging migration is tracked in TD-051.

---

## Coordinator

### Step 1 — check startup phase

```bash
curl -s "$COORDINATOR_URL/readyz" | jq '{status, startup_phase, checks}'
```

Expected healthy response: `startup_phase: "ready"`, all checks `ok: true`.

| `startup_phase` value | Meaning | Action |
|---|---|---|
| `"initializing"` | Still applying DB migrations or waiting for first RPC response | Wait up to 30s, then check DB connectivity |
| `"warming"` | Listeners starting, reconciliation not yet run | Normal — wait for `"ready"` |
| `"ready"` | Fully operational | Proceed to step 2 |
| `"degraded"` | One or more dependency checks failing | Check `checks` detail |

### Step 2 — identify which check is failing

```bash
curl -s "$COORDINATOR_URL/readyz" | jq '.checks | to_entries[] | select(.value.ok == false)'
```

| Failing check | Likely cause | Fix |
|---|---|---|
| `database` | SQLite file locked or Postgres connection refused | Check `DATABASE_URL`; restart DB if needed |
| `ethereum_rpc` | RPC endpoint unreachable or rate-limited | Verify `SEPOLIA_RPC_URL`; switch to fallback RPC |
| `soroban_rpc` | Soroban RPC timeout | Check `SOROBAN_RPC_URL`; public endpoints have intermittent availability |
| `solana_rpc` | Solana devnet unreachable | Verify `SOLANA_RPC_URL`; devnet has maintenance windows |
| `reconciliation` | Reconciler hasn't run in > 2h | Check reconciler logs; may need restart if stuck |

### Step 3 — check listener state

```bash
# Listener lag per chain
curl -s "$COORDINATOR_URL/metrics" | grep coordinator_listener_lag_blocks

# Last reconciliation timestamp (Unix seconds)
curl -s "$COORDINATOR_URL/metrics" | grep coordinator_reconciliation_last_run_timestamp_seconds
```

Normal lag thresholds: ≤ 100 blocks = acceptable, 100–500 = investigate, > 500 = incident.

If a listener shows persistent lag, the coordinator may need a `POST /api/wake` to
trigger listener initialization (the listeners start lazily — see TD-042):

```bash
curl -X POST "$COORDINATOR_URL/api/wake"
```

### Step 4 — trace a specific order

```bash
# Look up order by publicId
curl -s "$COORDINATOR_URL/api/orders/<publicId>" | jq '{status, srcChain, dstChain, hashlock, createdAt}'

# Check coordinator logs for that order (Pino structured output)
# Filter by publicId field if log aggregation is available:
# jq 'select(.publicId == "<publicId>")' < coordinator.log
```

### Step 5 — secret storage issues

If orders are progressing to `secret_revealed` but the coordinator is not forwarding
the preimage, check whether secret encryption is configured:

```bash
# If SECRET_STORAGE_KEY is unset, secrets are stored in plaintext (TD-041)
# Verify the key is set in the environment
echo "${SECRET_STORAGE_KEY:+SET}" # prints "SET" if configured, blank if not
```

An unset `SECRET_STORAGE_KEY` is a security gap but does not prevent secrets from being
stored — secrets will be persisted unencrypted. If the coordinator returned a
`storage_failure` error for a reveal, check DB connectivity and free disk space.

---

## Relayer

### Step 1 — check chain monitoring status

```bash
curl -s "$RELAYER_URL/api/debug/chain-monitor" | jq '.'
```

Look for `chainMonitoringStarted: true` and no errors in the monitoring object. If
`chainMonitoringStarted: false`, the relayer's event loop has not started — restart it.

### Step 2 — check readiness

```bash
curl -s "$RELAYER_URL/readyz" | jq '.'
```

The relayer probes Ethereum RPC (`eth_blockNumber`) and Stellar Horizon on every
`/readyz` call. A single slow probe flips the response to 503. This is expected
behavior, not a relayer bug — it means the upstream RPC is the problem.

### Step 3 — read console output

Because the relayer uses `console.log` rather than structured JSON, filter by pattern:

```bash
# Find RPC errors
grep -i "rpc\|failed\|error\|timeout" relayer.log | tail -50

# Find order-specific activity (match orderId or orderHash)
grep "orderId=<id>\|orderHash=<hash>" relayer.log | tail -20

# Find the price cache update (confirms CoinGecko is reachable)
grep -i "price\|coingecko\|ETH_USD" relayer.log | tail -5
```

### Step 4 — safety deposit mismatch

If orders are being rejected by the relayer with a "safety deposit too low" error:

1. The relayer uses a hardcoded ETH/USD fallback of $3,500 in `calculateDynamicSafetyDeposit`
   (TD-052). If ETH price has moved significantly, deposits will be mis-sized.
2. Check the price cache: `grep "getPriceSnapshot\|ETH.*USD" relayer.log`.
3. If the live price fetch is failing, the fallback is active — resolve the
   CoinGecko connectivity issue or temporarily adjust the expected deposit range.

### Step 5 — Stellar / Soroban path

If Stellar-leg orders are failing but ETH-leg orders work:

```bash
# Check Stellar Horizon connectivity
curl -sf "$STELLAR_HORIZON_URL" | jq '.network_passphrase'

# Check relayer's Stellar signing key is configured
echo "${RELAYER_STELLAR_SECRET:+SET}"
```

The relayer's Stellar path uses the Horizon API directly. A bad `STELLAR_HORIZON_URL`
or an expired signing key causes silent failures on the Stellar leg only.

---

## Resolver

### Step 1 — check registration state

```bash
# Readiness (fails with 503 if any tracked chain is not active/unregistered)
curl -s "$RESOLVER_HEALTH_URL/readyz" | jq '.'

# Detailed telemetry with per-chain listener state
curl -s "$RESOLVER_HEALTH_URL/telemetry" | jq '.'
```

The resolver's `/readyz` checks configuration presence, not a live RPC probe (by design —
it is intentionally fast). The RPC health signal lives in `/telemetry`, which classifies
each chain as `connected | degraded | stale | inactive` based on listener staleness.

### Step 2 — interpret telemetry states

| Telemetry state | Meaning | Action |
|---|---|---|
| `connected` | Listener made progress within its staleness window | No action needed |
| `degraded` | Listener is receiving events but with errors | Check Pino logs for RPC error details |
| `stale` | No new events seen within the staleness threshold | RPC endpoint may be down or rate-limited |
| `inactive` | Chain is configured but listener has never started | Check config; trigger `POST /api/wake` on coordinator |

### Step 3 — supervisor restart loop

```bash
# Check resolver metrics for restart count
curl -s "$RESOLVER_METRICS_PORT_URL/metrics" | grep resolver_restart_count

# Check registration status metrics
curl -s "$RESOLVER_METRICS_PORT_URL/metrics" | grep resolver_registry_lifecycle_state
```

If `resolver_restart_count` is increasing rapidly:

1. The supervisor has a default `maxRestarts` of 5 (TD-061). After 5 crashes, the
   resolver process exits entirely — it will not recover without manual intervention.
2. Check logs for the root crash reason: `grep "error\|crash\|FATAL" resolver.log`.
3. Common cause: flaky RPC causing the listener to throw an unhandled error on startup.
   Fix: set a more resilient RPC endpoint and restart.

### Step 4 — on-chain registration check

```bash
# CLI status check (Ethereum ResolverRegistry only)
pnpm --filter @wafflefinance/resolver start -- status
```

| CLI output | Action |
|---|---|
| `active` | Resolver is registered and staked — operational |
| `low_stake` | Admin raised `minStake` — top up stake via `resolver register <amount>` |
| `slashed` | Resolver was penalized — top up stake AND investigate why |
| `unbonding` | (Soroban only) Unregister in progress — wait for unbonding window, then `withdraw_stake` and `register` again |
| `unregistered` | Resolver is not registered — run `resolver register` |

---

## Frontend

### Step 1 — identify which API call is failing

Open browser devtools → Network tab. Filter by `XHR` or the coordinator URL. Look for:
- 4xx or 5xx responses on coordinator API calls
- Requests to the wrong base URL (misconfigured `VITE_API_BASE_URL`)
- CORS errors (coordinator not running, or wrong origin)

```bash
# Verify VITE_API_BASE_URL is correct at build time
grep VITE_API_BASE_URL frontend/.env
```

### Step 2 — wallet connection errors

| Symptom | Chain | Check |
|---|---|---|
| "No wallet detected" | Ethereum | MetaMask not installed or locked |
| "Freighter not found" | Stellar | Freighter extension not installed |
| "Phantom wallet not connected" | Solana | Phantom not connected to the current site |
| Wrong network selected | Ethereum | MetaMask on wrong chain ID (should be 11155111 for Sepolia) |

### Step 3 — mainnet UI locked

If the mainnet route selector is unavailable, `VITE_MAINNET_ENABLED` is `false` (the default
until post-audit, per TD-001). This is intentional — the toggle is a release gate, not a bug.

### Step 4 — stale order status in UI

The frontend polls `GET /orders/:id` on a timer — there is no push/WebSocket (TD-044).
If order status appears stuck in the UI but the coordinator shows the correct state, the
polling interval has not elapsed yet. The frontend will converge on the next poll cycle.

---

## Diagnostic matrix

### Network failure

Use this matrix when a chain RPC is failing and you need to know which services are affected
and what the expected behavior is.

| Chain down | Services directly impacted | Expected degradation | Recovery path |
|---|---|---|---|
| **Ethereum RPC** | Coordinator `/readyz` → 503; Relayer `/readyz` → 503; Resolver telemetry → `stale`/`degraded` | New ETH-leg orders not processed. Existing orders may miss claim/refund events. Reconciler will catch missed events once RPC recovers (48h lookback window). | Switch `SEPOLIA_RPC_URL` / `ETHEREUM_RPC_URL` to a fallback provider; restart coordinator and relayer |
| **Soroban RPC** | Coordinator `/readyz` → 503 (Soroban check fails); Resolver telemetry `stale` for Soroban | New XLM-leg orders not processed. Soroban listener silently stops advancing. | Switch `SOROBAN_RPC_URL` to an alternate endpoint; `POST /api/wake` to restart listener |
| **Solana RPC** | Coordinator `/readyz` may degrade; Solana listener stops | New SOL-leg orders missed. | Switch `SOLANA_RPC_URL`; `POST /api/wake` |
| **Stellar Horizon** | Relayer Stellar signing path fails | XLM destination locks not sent. Existing orders will timeout to refund. | Switch `STELLAR_HORIZON_URL` to a fallback Horizon instance |
| **Coordinator itself** | Relayer can't POST order updates; Frontend shows no orders | Off-chain metadata unavailable. On-chain settlement is unaffected — HTLCs still enforce the timelock. | Restart coordinator. DB is a rebuildable cache; data is reconstructed via reconciler replay. |

**Key invariant:** A complete outage of all off-chain services does not trap funds. Every
HTLC refunds permissionlessly once its timelock expires. Users can call `refundOrder`
directly from any wallet.

### Database drift

Database drift occurs when the coordinator's SQLite/Postgres state diverges from on-chain
reality. This can happen after a missed event, a failed migration, or a corrupt DB file.

**Detect drift:**

```bash
# Check when reconciler last ran
curl -s "$COORDINATOR_URL/metrics" | grep coordinator_reconciliation_last_run_timestamp_seconds

# Compare coordinator order status with on-chain event logs for a specific order
curl -s "$COORDINATOR_URL/api/orders/<publicId>" | jq '.status'
# Then manually verify against Etherscan / Stellar Expert for the same hashlock
```

**Trigger reconciliation manually:**

The reconciler runs automatically on startup and on its polling interval. To trigger
an immediate run:

```bash
# Restart the coordinator — reconciler runs as part of startup
pnpm --filter @wafflefinance/coordinator start

# Or in dev mode (faster)
pnpm --filter @wafflefinance/coordinator dev
```

The reconciler scans a 48-hour lookback window (14,400 ETH blocks / 34,560 Soroban
ledgers / equivalent Solana slot range) and replays any events the live listener
missed. After a restart, allow 2–3 minutes for reconciliation to complete before
concluding a status is definitive.

**Rebuild from scratch (last resort):**

```bash
# Back up first
pnpm --filter @wafflefinance/coordinator db:backup -- --database-url "$DATABASE_URL" --out ./backups

# Delete the SQLite file (or drop/recreate the Postgres DB)
rm wafflefinance.db   # SQLite only

# Restart — migrations re-apply, reconciler rebuilds from chain history
pnpm --filter @wafflefinance/coordinator start
```

Because the coordinator's DB is explicitly documented as a **rebuildable cache**, a
full rebuild is always safe. The authoritative record is the on-chain HTLC state.

**Migration failure:**

If the coordinator fails to start with a schema error:

```bash
# Check which migrations have been applied
# SQLite:
sqlite3 wafflefinance.db "SELECT * FROM schema_migrations ORDER BY version;"
# Postgres:
psql "$DATABASE_URL" -c "SELECT * FROM schema_migrations ORDER BY version;"
```

Migrations are in `coordinator/migrations/` and are idempotent. If a migration
partially applied, check `coordinator/docs/migrations.md` for manual recovery steps.

### Order stuck states

Use this matrix when an order is not advancing through the expected state machine.

```
announced → src_locked → dst_locked → secret_revealed → completed
                                                    ↘
                                              refunded / failed / expired
```

| Stuck in state | Common causes | How to verify | Resolution |
|---|---|---|---|
| `announced` | No source lock arrived; user did not complete the transaction | Check on-chain: has the user's ETH/XLM/SOL HTLC been created? | If on-chain HTLC exists but coordinator missed the event: `POST /api/wake` or restart coordinator. If no on-chain HTLC: the user abandoned the swap. Order will be archived by stale-order cleanup. |
| `src_locked` | Resolver not filling orders; resolver not registered; resolver has insufficient stake | Check `resolver status` CLI; check resolver readiness; check `resolvers_active` metric | Fix resolver registration (see [Resolver step 4](#step-4--on-chain-registration-check)). If no resolver is available, orders will refund when the 24h timelock expires. |
| `dst_locked` | User has not claimed on destination chain; user's wallet not connected; user can't see the order | Check if destination HTLC exists on-chain. Check coordinator for `secret_revealed` events. | Share the order URL with the user. If the destination timelock has expired (12h), the resolver will refund its destination leg. The user's source leg refunds at 24h. |
| `secret_revealed` | Coordinator has the preimage but relayer hasn't claimed the source leg yet | Check relayer logs for the order's `orderHash`; check on-chain if source claim has been submitted | Check relayer `console.log` output for errors. If the relayer is down, restart it — it will pick up the public preimage from the coordinator on reconnect. |
| `src_locked` (> 24h) | Timelock has expired; refund not yet processed | Check on-chain: has the 24h timelock passed? | Anyone can call `refundOrder` on-chain directly. The relayer's refund watchdog should have caught this — check `refund-watchdog` logs. |

**Forcing a reconciliation pass for a specific order:**

The coordinator reconciler re-scans all events in its lookback window. There is no
per-order trigger, but restarting the coordinator achieves the same effect. If only
a single order is stuck and you don't want to restart:

1. Verify the on-chain state directly (Etherscan, Stellar Expert, Solana Explorer).
2. If the on-chain state is ahead of the coordinator, restart the coordinator to
   trigger reconciliation.
3. If the on-chain state matches the coordinator but the frontend shows something
   different, the frontend's poll cache is stale — wait one poll cycle.

---

## Log and telemetry reference

### Coordinator (Pino structured JSON)

The coordinator uses `pino` with `pino-http`. All request logs include a request ID.
All service logs include structured fields.

```bash
# Live tail (if running locally in dev mode)
pnpm --filter @wafflefinance/coordinator dev 2>&1 | jq '.'

# Filter by log level
jq 'select(.level >= 40)' < coordinator.log   # warn and above (level 40 = warn, 50 = error)

# Filter by orderId or publicId
jq 'select(.publicId == "swap-abc123")' < coordinator.log
jq 'select(.orderId == "42")' < coordinator.log

# Find secret reveal events
jq 'select(.msg | test("secret|preimage|reveal"))' < coordinator.log

# Find reconciliation runs
jq 'select(.msg | test("reconcil"))' < coordinator.log
```

**Key Pino log fields:**

| Field | Meaning |
|---|---|
| `level` | 10=trace, 20=debug, 30=info, 40=warn, 50=error, 60=fatal |
| `reqId` | Per-request ID (from pino-http) |
| `publicId` | Order public ID (primary correlation key) |
| `orderId` | Internal DB row ID |
| `hashlock` | Order hashlock (safe to log — not secret) |
| `chain` | Which chain the event originated from |
| `component` | Which internal module emitted the log |

**Key coordinator metrics (`GET /metrics`):**

| Metric | What it measures |
|---|---|
| `coordinator_orders_announced_total` | Cumulative orders received |
| `coordinator_orders_completed_total` | Cumulative completed swaps |
| `coordinator_orders_refunded_total` | Cumulative refunds |
| `coordinator_active_orders` | Current non-terminal orders (gauge) |
| `coordinator_listener_lag_blocks{chain}` | Block lag per chain listener |
| `coordinator_reconciliation_last_run_timestamp_seconds` | Unix timestamp of last reconciler run |
| `resolvers_active` | Count of active resolvers in the registry |
| `rpc_errors_total{chain}` | Cumulative RPC errors per chain |

Full Prometheus scrape endpoint: `GET /metrics` (requires `COORDINATOR_OPERATOR_KEYS` bearer token).

### Relayer (console.log — unstructured)

The relayer does not produce structured JSON (TD-051). Filter by text patterns:

```bash
# All errors and warnings
grep -iE "error|warn|fail|timeout|reject" relayer.log

# Order tracking (note: orderId and orderHash are distinct — see relayer/README.md)
grep "orderId=<value>" relayer.log
grep "orderHash=<value>" relayer.log

# Chain monitor status
grep -i "chain.*monitor\|uptime\|heartbeat" relayer.log

# Price feed
grep -iE "price|coingecko|usd" relayer.log | tail -5

# Refund watchdog activity
grep -i "refund.*watchdog\|watchdog.*refund\|expired\|timelock" relayer.log
```

**Key relayer health endpoints:**

| Endpoint | What it shows |
|---|---|
| `GET /api/health` | Basic service liveness |
| `GET /readyz` | Live RPC probes for Ethereum + Stellar; 503 if either fails |
| `GET /api/debug/chain-monitor` | Chain monitoring start state and uptime |

### Resolver (Pino structured JSON)

The resolver uses Pino. Structured fields include `chain`, `event`, `state` (supervisor),
and `action` (registration transitions).

```bash
# Supervisor state transitions
jq 'select(.component == "Supervisor")' < resolver.log

# Registration/stake state changes
jq 'select(.action | type == "string")' < resolver.log

# RPC retry attempts
jq 'select(.msg | test("retry|backoff|rpc"))' < resolver.log
```

**Key resolver metrics (`GET /metrics`, default port 3002):**

| Metric | What it measures |
|---|---|
| `resolver_registration_info{chain}` | `1` if `active`, else `0` |
| `resolver_registry_lifecycle_state{chain,state}` | Current state per chain (enum gauge) |
| `resolver_registration_changes_total{action}` | Counted state transitions |
| `restart_count` | Supervisor restart counter |

**Resolver telemetry (`GET /telemetry`, default port 3003):**

Returns per-chain listener state: `connected`, `degraded`, `stale`, or `inactive`.
This is the resolver's RPC health signal — unlike `/readyz`, it reflects actual
listener progress rather than a live probe.

---

## Common multi-service scenarios

### "User submitted a swap but nothing happened"

1. Check if an order was announced: `curl "$COORDINATOR_URL/api/orders/<publicId>"`. If
   404, the announce POST from the frontend never reached the coordinator.
2. Check the frontend Network tab for the announce request — look for 4xx/5xx or CORS errors.
3. If the announce succeeded (coordinator has the order in `announced`), the user's source
   HTLC transaction may not have been submitted or confirmed. Check the user's wallet
   history.
4. If the source HTLC is confirmed on-chain but coordinator shows `announced`: listener
   may have missed the event. Run `POST /api/wake` and wait for the next reconciler pass.

### "Order is src_locked but no resolver is filling it"

1. Check `resolvers_active` metric — if 0, no resolver is registered.
2. Check resolver `/readyz` — if 503, the resolver is not ready.
3. Check resolver registration: `pnpm --filter @wafflefinance/resolver start -- status`.
4. If the resolver is registered and healthy, check resolver logs for the specific
   order's hashlock. The resolver may be in observe-only mode (no signing key configured).
5. If no fix is available, the order will refund automatically when the 24h source
   timelock expires. Communicate the refund timeline to the user.

### "Secret was revealed on-chain but source chain claim hasn't happened"

1. Check if coordinator has the secret: `curl "$COORDINATOR_URL/api/secrets/<publicId>"`.
2. If coordinator has it, check relayer logs for the `orderHash` — the relayer should be
   submitting the claim transaction on the source chain.
3. If the relayer is up but not claiming: check ETH gas price. If gas is very high,
   the relayer's safety deposit calculation may be blocking the transaction.
4. If the relayer is down, restart it — it reads the secret from the coordinator on reconnect.
5. Note: once the preimage is on-chain (revealed by the user's destination claim), anyone
   can call `claimOrder` on the source chain using that preimage.

### "Coordinator restarted mid-incident — will it catch missed events?"

Yes. On every startup the reconciler scans the last 48 hours of chain history across all
three chains. It replays any `OrderCreated`, `OrderClaimed`, and `OrderRefunded` events
that the live listener missed. Processing priority on startup is:

```
LIVE_EVENT > REPLAY_JOB > SECRET_RECOVERY > STALE_CLEANUP
```

Allow 2–3 minutes after restart for the reconciler to complete before concluding any
order status is incorrect.

### "The coordinator DB was reset — how long until state is reconstructed?"

The coordinator DB is a rebuildable cache. After a full DB reset:

1. Start the coordinator — it creates a fresh schema automatically.
2. The reconciler immediately begins replaying the last 48 hours of chain events.
3. Orders older than 48 hours that are still active (unlikely given 24h timelocks, but
   possible for edge cases) may not be automatically recovered. For those, the on-chain
   HTLC state is still authoritative — the user can refund directly.
4. The `POST /api/wake` endpoint accelerates listener startup.
5. The `seed-demo` command (`pnpm --filter @wafflefinance/coordinator seed-demo`) can
   populate synthetic orders for testing, but should never be run in production.
