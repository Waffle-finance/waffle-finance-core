# Coordinator listener startup — operational note

This document describes when each chain listener begins observing events,
how each listener recovers events that arrived before it started, and what
operators need to know about gaps that fall outside the automatic recovery
window.

---

## Startup sequence

The coordinator's `main()` function follows a fixed startup order before
any listener issues its first RPC call.

```
1. Load and validate configuration  (fatal on failure)
2. Solana placeholder check
3. Database connection               (retried up to 10 × with back-off)
4. RPC endpoint probe                (retried up to 8 × with back-off)
5. Wire services, HTTP server
6. Initial readiness check → derive fallback policy
7. Start listeners (per-chain, gated on fallback policy)
8. Enqueue first reconciliation run
```

Steps 3 and 4 use `retryAsync` with exponential back-off and jitter.  If
the RPC probe exhausts all retries the coordinator **proceeds anyway** and
logs a warning; the readiness endpoint (`/readyz`) will reflect the
degraded state until the chain becomes reachable.

---

## Listener startup triggers

All three listeners are started **eagerly** — unconditionally at boot, not
lazily on the first order — subject only to the degraded-mode fallback
policy and configuration guards described below.

### EthereumListener

Activated when:

- `cfg.ethereum.htlcEscrow` is configured (set via `ETH_HTLC_ESCROW_TESTNET` /
  `ETH_HTLC_ESCROW_MAINNET`, not `null`), **and**
- `ethereum` is not in `fallbackPolicy.disabledListeners`.

On `start()`, the listener runs asynchronously:

1. Fetches the current block number from the RPC.
2. Reads the persisted high-water-mark block from the DB
   (`getLastProcessedBlock("ethereum")`).
3. **Reorg check on restart** — if a prior high-water mark exists, the
   listener fetches the on-chain hash for that block and compares it with
   the stored hash.  A mismatch (reorg while offline) moves the scan start
   back `REORG_RESTART_LOOKBACK = 64` blocks.
4. **Catch-up scan** — issues `getLogs` over the window `[fromBlock, latest]`
   and enqueues all `OrderCreated` events found.
5. Starts the confirmation drain timer (every `DRAIN_INTERVAL_MS = 30 s`).
6. Registers three viem `watchEvent` watchers (OrderCreated, OrderClaimed,
   OrderRefunded) beginning at `latest + 1`.

If no prior block is recorded, the listener looks back up to **5 000 blocks**
from the current tip.

### SorobanListener

Activated when:

- `cfg.soroban.htlcContract` is configured (set via `SOROBAN_HTLC_TESTNET` /
  `SOROBAN_HTLC_MAINNET`, not `null`), **and**
- `soroban` is not in `fallbackPolicy.disabledListeners`.

On `start()`, the listener calls `bootstrapAndLoop()` as a fire-and-forget
async task:

1. **Bootstrap** — reads the persisted checkpoint from the DB
   (`getSorobanCheckpoint(contractId)`):
   - No checkpoint: starts near the chain tip.
   - `recoveryMarker === "clean"` and a cursor exists: resumes the live
     stream at the stored cursor (fast path).
   - `recoveryMarker === "clean"` but no cursor: runs a bounded ledger
     replay from `lastSafeLedger` before going live.
   - `recoveryMarker !== "clean"` (crashed mid-replay): re-runs the bounded
     replay from `lastSafeLedger` before going live.
2. **Loop** — polls `server.getEvents()` continuously, sleeping
   `pollIntervalMs` between iterations.

The bounded replay covers at most `MAX_REPLAY_LEDGERS = 34 560` ledgers
(~48 h of Stellar at ≈5 s/ledger).  If `lastSafeLedger` is further behind,
the listener logs a warning and the periodic reconciler backfills the
remainder.

### SolanaListener

Activated when:

- `cfg.solana.programId` is **not** a placeholder value (set via
  `SOLANA_HTLC_PROGRAM_TESTNET` / `SOLANA_HTLC_PROGRAM_MAINNET`), **and**
- `solana` is not in `fallbackPolicy.disabledListeners`.

On `start()`, the listener calls `loop()` as a fire-and-forget async task.
There is no separate bootstrap phase.  The first poll call fetches the
current finalized and confirmed slot from the RPC, then queries
`getSignaturesForAddress` for up to 50 recent signatures.  Signatures are
queued in `pendingSlots` and drained once a slot reaches
`finalizedSlot − FINALIZATION_SLOTS` (32 slots, ≈13 s).

The Solana listener has **no on-disk cursor of its own**.  Historical events
that predate startup are covered entirely by the reconciler (see below).

---

## Fallback policy — when listeners are disabled

Before starting listeners, the coordinator runs an initial readiness check
and passes the results to `deriveRuntimeFallbackPolicy()`.  A listener is
disabled if:

- Its chain RPC returned `ok: false` during the probe, **or**
- The database check failed (all three listeners are disabled in this case).

Disabled listeners are logged at `warn` level.  The coordinator still
starts and serves HTTP traffic; the readiness endpoint reports
`status: "degraded"` and names the unavailable chains in `degradedServices`.

There is no automatic re-enable after a listener is disabled at boot.  To
re-enable a listener after its RPC recovers, restart the coordinator process.

---

## Wake behavior

None of the three listeners implement a manual wake route.  The coordinator
exposes `POST /admin/reconcile` which triggers an immediate reconciler run,
but there is no HTTP endpoint that causes a listener to re-poll or advance
its cursor on demand.

The relayer (separate process) has a `wake()` call on its
`ContractEventPoller`, but the coordinator's listeners do not expose this
mechanism externally.

---

## Reconciliation — how earlier events are recovered

The reconciler is the safety net for events that arrived before a listener
started, during a listener outage, or that a listener missed due to an RPC
error.

### When it runs

- **Startup run** — enqueued immediately after listeners start, as a
  `REPLAY_JOB` priority task in the `BacklogScheduler`.  It completes before
  the readiness endpoint reports `status: "ready"`.
- **Periodic runs** — every `pollIntervalMs × 4` (default ≈60 s).

### Cursor and lookback window

Each chain has its own `LedgerCursor` seeded from the DB on the first run
(`initCursors()`).  The cursor high-water mark (HWM) is the highest
block/ledger/slot the reconciler successfully processed in a prior run.

On each run, `computeIncrementalScanStart()` computes the replay window:

| Chain | Lookback window | Approximate wall-clock coverage |
|---|---|---|
| Ethereum | `ETH_LOOKBACK_BLOCKS = 14 400` blocks | ~48 h at ≈12 s/block |
| Stellar | `SOROBAN_LOOKBACK_LEDGERS = 34 560` ledgers | ~48 h at ≈5 s/ledger |
| Solana | `SOLANA_LOOKBACK_SLOTS = 432 000` slots | ~48 h at ≈400 ms/slot |

When the HWM is fresh (within the lookback window), the reconciler scans
from the HWM forward.  When the HWM is stale or missing (first run, long
outage), it falls back to `tip − lookback`.

### What gets replayed

The reconciler re-processes every `OrderCreated`, `OrderClaimed`, and
`OrderRefunded` event in the window.  All writes to the DB are idempotent:
re-running the reconciler after a crash leaves the DB in the same state as
a single successful run.

### Gap-exceeded warning

If the cursor gap exceeds the lookback window, the reconciler:

1. Logs a structured `warn` entry with `conflict_type: "gap_exceeds_lookback"`.
2. Increments the `coordinator_reconciliation_conflicts_total` Prometheus counter.
3. Falls back to `tip − lookback` — events older than the lookback window
   are **not** automatically replayed.

To recover events beyond the lookback window, trigger a full historical
replay manually (outside the scope of the built-in reconciler).

---

## ⚠ Warning — deployments that require immediate event processing

The coordinator does not guarantee zero-latency event observation.  Several
gaps exist that operators must account for:

**1. Listener start lag.**  Listeners start after the RPC probe, service
wiring, and initial readiness check.  On a cold start with slow RPC
responses this can be several seconds.  Events emitted on-chain during
this window are not observed in real-time; they are recovered by the
startup reconciliation run.

**2. EthereumListener confirmation delay.**  `OrderCreated` events are held
in a confirmation queue for `CONFIRMATION_DEPTH = 12` blocks (~2.5 min on
mainnet) before being processed.  There is no way to skip confirmation
depth.

**3. SolanaListener finalization delay.**  Solana signatures are not
processed until the containing slot is `FINALIZATION_SLOTS = 32` slots
behind the finalized tip (~13 s additional lag beyond block inclusion).

**4. Soroban bootstrap replay.**  If the SorobanListener starts without a
clean checkpoint (first deploy, or a prior crash mid-replay), it runs a
bounded ledger replay before emitting live events.  During this replay
window live events are queued but not yet processed.

**5. Reconciler, not listeners, covers the offline gap.**  If the
coordinator was offline for longer than the respective lookback window (48 h
by default), events in the older part of the gap are **not** recovered
automatically.  The reconciler will log `gap_exceeds_lookback` warnings.
Operators must run a manual historical replay for events older than the
lookback window.

**6. No eager-start override.**  There is no configuration flag to start
listeners before the RPC probe or to skip the fallback-policy check.  A
listener whose RPC fails the initial probe is disabled for the lifetime of
that process.

**7. Disabled listener requires restart.**  If a listener is disabled at
boot due to a failed RPC probe, it will not re-enable automatically when the
RPC recovers.  A process restart is required.

---

## Readiness signals

| Phase | `/readyz` response | Meaning |
|---|---|---|
| `starting` | HTTP 503, `startup_phase: starting` | Startup tasks not yet complete |
| `pending` | HTTP 200, `startup_phase: pending` | Listeners running, first reconciliation not yet done |
| `ready` | HTTP 200, no `startup_phase` check | First reconciliation complete, all checks healthy |
| `degraded` | HTTP 503, `mode: degraded` or `partially_healthy` | One or more chains unavailable |

The transition from `pending` to `ready` happens when the startup
reconciliation run completes successfully and all dependency checks pass.

---

## Related documents

- [`REORG_RECOVERY.md`](./REORG_RECOVERY.md) — per-chain reorg detection
  and rollback strategies.
- [`database-durability.md`](./database-durability.md) — persistence
  guarantees for the DB-backed cursors.
- [`INTEGRATION_GUIDE.md`](./INTEGRATION_GUIDE.md) — API reference and
  health endpoint semantics.
