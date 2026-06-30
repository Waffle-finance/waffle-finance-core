# Reorg Recovery — Operator Guide

This document explains how the coordinator's chain event listeners detect and
recover from chain reorganisations and temporary node inconsistencies. It is
intended for operators running production or testnet deployments.

---

## Background

The coordinator watches three chains for HTLC lifecycle events
(`OrderCreated`, `OrderClaimed`, `OrderRefunded`). Each chain has a different
finality model, so each listener uses a different recovery strategy.

| Chain | Finality model | Listener |
|---|---|---|
| Ethereum | Probabilistic PoS (12-block depth) | `EthereumListener` |
| Stellar | BFT-finalized (no true reorgs) | `SorobanListener` |
| Solana | Fork-based supermajority vote (≈32-slot lockout) | `SolanaListener` |

---

## Ethereum — EthereumListener

### How it works

`EthereumListener` never processes an `OrderCreated` event immediately. It
queues each event in a **confirmation queue** keyed by block number and only
drains entries that are at least `CONFIRMATION_DEPTH = 12` blocks behind the
current chain head. This gives strong finality guarantees for PoS Ethereum.

Reorg detection happens at three points:

#### 1. Startup hash check

When the listener starts, it reads the last processed block from the database.
It then fetches that block's hash from the RPC and compares it to the hash
stored during the previous run. A mismatch means a reorg happened while the
service was down.

```
Stored high-water mark: block 15000, hash 0xaaa...
RPC returns block 15000 hash: 0xbbb...  ← MISMATCH → reorg detected
```

On mismatch the listener rolls the **catch-up scan start block** back by
`REORG_RESTART_LOOKBACK = 64` blocks so it replays any events that may have
landed on a different fork.

#### 2. Drain-time per-block hash check

Before processing events from a queued block, the drain loop fetches the
block's current hash from the RPC and compares it to the hash stored when the
event was first seen. If they differ, the queued events for that block are
**dropped silently** — they will be re-observed if the canonical chain includes
a replacement transaction at that block.

#### 3. Rolling window hash re-validation (`checkStoredHashes`)

The listener maintains a rolling window of the last `BLOCK_HASH_WINDOW = 64`
confirmed block hashes. On every drain cycle it re-checks each stored hash
against the live chain. If a hash in the window has changed (deep reorg), the
listener drops any still-queued events for that block.

#### Live reorg signals from viem

Viem's `watchEvent` emits a `removed = true` flag when a log is ejected by a
reorg. The listener handles this immediately:

- If the event is still in the confirmation queue → it is removed from the
  queue.
- If it was already drained and committed to the database → `rollbackSrcLock`
  is called, reverting the order to `announced` status.

### What operators see in logs

| Log message | Meaning | Action needed |
|---|---|---|
| `reorg detected on restart – rescanning from rollback point` | Block hash mismatch at startup | None — automatic |
| `dropping queued events – block was reorged` | Drain caught a hash mismatch | None — events will be re-observed |
| `ETH OrderCreated event removed due to reorg` | viem reported a live reorg | None — automatic rollback |
| `block hash mismatch – reorg detected` | In-session reorg detected | None — automatic |
| `could not rollback src lock after reorg` | DB rollback failed | Check DB health; order may be stuck in `src_locked` |

### Monitoring

- `listener_last_block{chain="ethereum"}` — the highest block seen. A stale
  value indicates the RPC is down or events have stopped.
- `listener_event_processing_duration_seconds{chain="ethereum"}` — per-event
  latency.
- `listener_queue_size` (custom gauge if enabled) — confirmation queue depth.

### Manual recovery

If an order is stuck in `src_locked` after a confirmed reorg:

```bash
# Connect to the coordinator DB and run:
UPDATE orders
SET src_order_id = NULL, src_lock_tx = NULL, src_lock_block = NULL,
    src_timelock = NULL, status = 'announced',
    updated_at = CAST(strftime('%s','now') AS INTEGER)
WHERE public_id = '<publicId>' AND status = 'src_locked';
```

The user can then resubmit or wait for the on-chain timelock to expire and
call `refundOrder` directly.

---

## Stellar — SorobanListener

### How it works

Stellar uses BFT consensus: once a ledger is closed, it is permanent. True
chain reorgs **cannot occur**. The listener guards against three classes of
**node-level inconsistency** instead:

#### Guard 1: Out-of-order event delivery

The Soroban RPC occasionally delivers events from a stale shard that has not
caught up with the cluster. If a received event's ledger number is lower than
the last processed ledger, the event is skipped with a warning.

```
lastProcessedLedger = 10050
Event at ledger 10020 received → skipped (out of order)
```

#### Guard 2: Ledger gap

If an event arrives at a ledger more than `MAX_LEDGER_GAP = 100` ahead of
`lastProcessedLedger`, the listener suspects the node skipped ledgers (e.g.
history was pruned or the node fast-forwarded). It resets the cursor so the
next iteration re-scans from `lastProcessedLedger`, replaying any missed
events.

```
lastProcessedLedger = 10050
Event at ledger 10200 received → gap = 150 > 100 → cursor reset
```

#### Guard 3: Stale / expired cursor

The Soroban RPC limits event history to a rolling window. If the coordinator
has been offline long enough for the cursor to fall outside that window, the
next `getEvents` call fails. The listener catches this error, resets the
cursor, and resumes from the latest ledger on the next poll cycle. Events
older than the history window are therefore lost — but the HTLC timelock
mechanism ensures user funds are never at risk (see Refund Layers in the main
README).

### What operators see in logs

| Log message | Meaning | Action needed |
|---|---|---|
| `Soroban event out of order — possible node inconsistency` | Stale shard event | None — skipped safely |
| `Soroban ledger gap detected, re-scanning from last known ledger` | Node skipped ledgers | None — automatic re-scan |
| `Soroban cursor reset due to error` | Cursor expired or node restarted | None — automatic reset |
| `Soroban poll failed` | RPC unavailable | Check RPC URL / node health |

### Monitoring

- `listener_last_block{chain="soroban"}` — the last processed ledger.
- `listener_event_processing_duration_seconds{chain="soroban"}`.

### Recovery after extended downtime

If the coordinator was offline for longer than the Soroban node's history
window (typically 24 h on Testnet, longer on Mainnet), events during the
outage are permanently unavailable from the cursor API. The listener will
resume from the current ledger.

If you need to backfill missing events, use the Stellar Horizon API to query
`/operations?order=asc` for the HTLC contract and manually replay them via the
coordinator's debug endpoint (if enabled) or directly via the DB.

---

## Solana — SolanaListener

### How it works

Solana validators regularly produce forks. A "confirmed" transaction has been
voted on by a supermajority but can still be reverted if the fork is abandoned
before reaching max lockout. The listener uses a **two-stage pipeline**:

1. **Queue stage** — signatures fetched at `confirmed` commitment are stored in
   `pendingSlots` (keyed by slot number). They are NOT processed yet.
2. **Drain stage** — on each poll, any slots that are at least
   `FINALIZATION_SLOTS = 32` slots behind the `finalized` commitment level are
   drained and processed. Transactions in those slots are irreversible.

#### Slot regression detection

On every poll the listener compares the new confirmed slot to the previous one.
If the confirmed slot has fallen by more than `REGRESSION_THRESHOLD = 5` slots,
a fork abandonment is detected:

```
previousConfirmedSlot = 1080
newConfirmedSlot      = 1060
regression            = 20 > 5 → fork detected
```

The listener then:

1. **Drops** all `pendingSlots` entries in the range `[1061, 1080]` — these
   transactions may not exist on the canonical fork.
2. **Rolls back** any `src_locked` orders whose `srcLockBlock` (Solana slot)
   falls in the same range, reverting them to `announced`.

#### Stale slot pruning

Entries in `pendingSlots` that are more than `PENDING_SLOTS_MAX_AGE = 200`
slots behind the finalized slot are pruned unconditionally. This prevents
unbounded memory growth if the listener receives events that are too old to
ever be relevant.

### What operators see in logs

| Log message | Meaning | Action needed |
|---|---|---|
| `Solana slot regression detected` | Fork abandonment observed | None — automatic rollback |
| `dropped pending transactions in regressed slot range` | Pending events discarded | None — they will be re-observed on canonical fork |
| `rolled back src lock due to Solana slot regression` | Order reverted to announced | None — order will be re-locked when canonical tx is seen |
| `pruning stale pending slot` | Old slot cleaned up | None |
| `Solana poll failed` | RPC unavailable | Check RPC URL / node health |
| `failed to fetch tx` | Transaction fetch failed | Transient — will retry on next poll |

### Monitoring

- `listener_last_block{chain="solana"}` — the highest confirmed slot seen.
- `listener_event_processing_duration_seconds{chain="solana"}`.

### Solana is in simulation mode

Until the Anchor HTLC program is deployed to devnet, `SOLANA_HTLC_PROGRAM` is
left blank and the listener disables itself at startup:

```
SOLANA_HTLC_PROGRAM not configured - Solana listener disabled
```

Set `SOLANA_HTLC_PROGRAM=<program_id>` to activate it.

---

## General operational advice

### RPC health

All three listeners degrade gracefully when their RPC is unavailable: they log
a warning and retry on the next poll cycle. The confirmation queue / pending
slots queue continues to hold unprocessed events so nothing is lost across
short outages.

For long outages (hours+), check the `listener_last_block` metric against the
live chain head. A large lag means you may need to verify that backfilled
events are processed correctly after the RPC recovers.

### Database consistency

The coordinator database is the source of truth for order state. Reorg
rollbacks use `UPDATE orders SET status = 'announced' ...` which is idempotent.
If you suspect inconsistency:

1. Check `SELECT * FROM orders WHERE status = 'src_locked'` for orders whose
   on-chain transaction no longer exists.
2. Manually rollback as shown in the Ethereum section above.
3. Restart the coordinator — the catch-up scan will replay any missing events.

### Restart behaviour summary

| Chain | On restart | Outcome |
|---|---|---|
| Ethereum | Reads last processed block from DB; verifies block hash | If hash matches → scan forward from last block. If mismatch (reorg) → scan from `lastBlock - 64`. |
| Stellar | Resumes from stored cursor | If cursor expired → re-scans from latest ledger minus 1. Events older than history window are skipped. |
| Solana | Starts fresh from current confirmed slot | Pending queue is empty after restart; events from the outage window are re-fetched via `getSignaturesForAddress`. |

---

*See also: [`docs/OPERATIONS.md`](../docs/OPERATIONS.md) for full deployment
runbooks and alerting configuration.*
