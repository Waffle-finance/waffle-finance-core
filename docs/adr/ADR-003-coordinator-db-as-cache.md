# ADR-003: Coordinator database as a rebuildable cache

| Field | Value |
|-------|-------|
| **Status** | Active |
| **Date** | 2026-10-01 |
| **Authors** | Engineering team |
| **Supersedes** | — |
| **Superseded by** | — |

---

## Context

The coordinator stores order state in a local database (SQLite in development,
PostgreSQL in production).  It receives lifecycle events from three chains and
from the relayer, and must survive restarts, missed events, and chain reorgs
without losing order data.

Two design philosophies were on the table:

1. **Authoritative ledger** — the database is the source of truth; chain events
   are inputs that update it.  Losing the database loses order state.
2. **Rebuildable cache** — the on-chain HTLC contracts are the source of truth;
   the database is a derived view that can be reconstructed by replaying chain
   history.

## Decision

The coordinator database is a **rebuildable cache**.  This is stated explicitly
in `coordinator/src/persistence/schema.sql`:

> This DB is treated as a CACHE — the source of truth is always the on-chain
> state of the HTLC contracts on both chains.

Concretely this means:

- Every field that the coordinator needs to operate (order status, lock
  transactions, secrets) has an on-chain origin.  The coordinator reconstructs
  it by replaying `OrderCreated`, `OrderClaimed`, and `OrderRefunded` events
  from the chain's event history.
- The reconciler (`coordinator/src/reconciliation/reconciler.ts`) re-scans a
  48-hour lookback window on every startup and on a configurable interval,
  applying any events the live listeners may have missed.
- Losing the coordinator database is a recoverable event: a fresh database
  reaches a consistent state after one full reconciliation run covering the
  48-hour window (minus any orders older than the window, whose on-chain data
  still exists but cannot be pulled back).

The only exception is order metadata not present on-chain: `direction`,
`srcAsset`, `dstAsset`, and `dstAmount` are stored coordinator-side only.  A
complete database wipe loses this metadata for historical orders permanently
(acknowledged in `ARCHITECTURE.md` under "What replay does NOT cover").

## Consequences

+ A coordinator crash or database corruption is recoverable without manual
  intervention — restart and let the reconciler catch up.
+ No single off-chain service is in the settlement path; a coordinator outage
  cannot trap user funds (users can claim or refund directly on-chain).
+ The design justifies the reconciler's 48-hour lookback window and the
  per-order cursor tracking added in migration 011.
- The coordinator's view of order status can lag chain reality by up to one
  reconciler interval (default 15 seconds).  Callers must not treat a
  `completed` or `refunded` status in the API as final without an on-chain
  confirmation.
- Some order metadata (direction, amounts) is permanently lost if the database
  is wiped.  This is a known limitation tracked as an open architectural gap in
  `ARCHITECTURE.md`.
- Chain listeners start lazily (TD-042), so there is a brief window after
  deployment where the coordinator is not watching for new events.  The
  reconciler fills this gap on the next run.

## Alternatives considered

**Authoritative ledger with event log.**  The database holds canonical order
state; the event log is append-only and used only for audit.  This eliminates
the metadata loss problem but means a database failure requires manual recovery
from backup rather than a replay.  For a bridge where on-chain contracts always
hold the ground truth, treating the database as authoritative adds operational
risk without meaningful benefit.
