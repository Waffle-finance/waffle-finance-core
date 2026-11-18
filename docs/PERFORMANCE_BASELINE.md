# Performance baseline: order lifecycle and event indexing

The coordinator's order book grows without bound in three ways: more orders
announced, more chain events to replay after any downtime, and more stale
orders to sweep. This document is the measurable baseline for that growth —
what already exists, what it actually measures today, and the target
coverage still needed to turn "we think it's fast enough" into a checkable
contract.

This sits alongside [`ARCHITECTURE.md`](./ARCHITECTURE.md#order-lifecycle-and-event-flow)
(what the lifecycle is) and [`QUALITY_GATE.md`](./QUALITY_GATE.md) /
[`SMOKE_TEST_CONTRACT.md`](./SMOKE_TEST_CONTRACT.md) (other specified-but-not-fully-built
gates in this repo) — the same "document the real gap" approach applies here.

---

## Table of contents

- [What exists today](#what-exists-today)
- [Measured baseline](#measured-baseline)
- [Why only order lookup is covered today](#why-only-order-lookup-is-covered-today)
- [Target coverage: the full benchmark harness](#target-coverage-the-full-benchmark-harness)
- [Methodology constraints](#methodology-constraints)
- [How to regenerate these numbers](#how-to-regenerate-these-numbers)

---

## What exists today

`coordinator/test/performance.test.ts` is the one benchmark in the repo. It:

1. Inserts 1,000 orders into a fresh temp-file SQLite database via
   `OrdersRepository.announce()`.
2. Times a warm `findByAddress(addr, 50, 0)` call with `performance.now()`.
3. Asserts the query takes **under 50ms** — a regression guardrail, not just
   an observation.
4. Asserts the query-supporting indexes still exist
   (`idx_orders_src_address_created_at`, `idx_orders_dst_address_created_at`,
   `idx_orders_created_at`, `idx_orders_public_id`) — catching a migration
   that silently drops an index as a performance regression, not just a
   schema diff.

In production, every repository query is also independently timed via the
`dbQueryDuration` Prometheus histogram (`coordinator/src/metrics.ts`),
wrapped around every `OrdersRepository` call in `withMetrics()`
(`coordinator/src/persistence/orders-repo.ts`). That instrumentation
already exists at runtime — what's missing is a *deterministic, offline*
benchmark for the operations besides address lookup.

---

## Measured baseline

Captured by running the existing benchmark on this repo's dev container
(single run, no other load on the machine):

```bash
$ pnpm --filter @wafflefinance/coordinator exec vitest run test/performance.test.ts

Insertion of 1000 orders took 354ms
Query for 0x1111111111111111111111111111111111111111 took 1.3485ms
```

| Operation | Data size | Measured | Guardrail |
| --- | --- | --- | --- |
| `announce()` (sequential insert) | 1,000 orders | ~0.35ms/order (354ms total) | none asserted today |
| `findByAddress(addr, limit=50)` | 1,000 rows, 500 matching one address | 1.35ms | `< 50ms` (asserted) |

**These numbers are illustrative, not an SLA.** They depend on the host
machine, Node/SQLite version, and disk. Treat them as "this is roughly
where we are today" — the value of this document is the *methodology* and
the *trend*, not the absolute millisecond figures. Re-run the command above
before relying on a specific number.

---

## Why only order lookup is covered today

`findByAddress` was the first target because it's the query pattern most
directly exposed to users (transaction history) and most sensitive to
missing indexes. The other three operations named in the order lifecycle —
announcement throughput, event replay, and stale-order cleanup — have no
equivalent benchmark yet, even though all three have code paths that scale
with order count or chain history:

- **Announcement** (`OrdersRepository.announce()`) — a single-row insert
  today; worth benchmarking as a write-throughput baseline once contention
  (concurrent announces) is a realistic scenario, not just sequential
  inserts.
- **Event replay** (`coordinator/src/reconciliation/reconciler.ts`) — replays
  a bounded lookback window on every restart: 14,400 Ethereum blocks,
  34,560 Soroban ledgers, 432,000 Solana slots (all ~48h of history). This
  is the operation most likely to regress silently, because its cost is
  driven by *chain event density*, not order count — a benchmark here needs
  a synthetic event-log fixture, not just a database with N orders in it.
- **Stale-order cleanup** (`coordinator/src/services/stale-cleanup.ts`) —
  processes stale orders in batches of 100
  (`StaleCleanupService`'s `batchSize`); worth benchmarking
  `findStaleAnnounced()` at realistic order-table sizes (10k–100k rows) to
  confirm the query stays index-backed as the table grows well past the
  1,000-row baseline above.

---

## Target coverage: the full benchmark harness

Extending `coordinator/test/performance.test.ts` (or a new
`coordinator/test/benchmarks/` directory, mirroring the existing flat
`test/` layout) with three more scenarios, each following the same
methodology as the existing lookup benchmark:

| Scenario | What it measures | Proposed guardrail |
| --- | --- | --- |
| Announce throughput | Time to insert N orders sequentially (N = 1,000 and 10,000, to see how it scales) | Track ms/order; flag if it stops being ~linear |
| `findByAddressWithCursor` at scale | Cursor-paginated history query at 10k+ orders (the UNION query across src/dst indexes) | `< 50ms`, matching the existing `findByAddress` bar |
| Event replay throughput | Replay a synthetic fixture of N chain events (not a live RPC — a canned log/event array) through `Reconciler`'s replay path, timing events/sec | Track events/sec; flag regressions relative to the last recorded baseline |
| Stale-cleanup batch cost | `findStaleAnnounced()` + one archival batch at 10k+ orders, a fraction of which are stale | `< 100ms` per batch of 100 |

Each scenario should report both a raw number (for humans reading CI
output) and an assertion (so a regression fails the build, the same way the
existing `findByAddress` test already does).

---

## Methodology constraints

These match the determinism requirements already established by
`docs/SMOKE_TEST_CONTRACT.md` for the repo's other cross-cutting test
suite, applied to performance work specifically:

- **In-process SQLite, isolated per run** — a fresh temp-file database per
  test (as the existing benchmark already does via `mkdtempSync`), never a
  shared or persistent database, so runs don't interfere with each other or
  with CI concurrency.
- **Deterministic data sizes** — fixed N (1,000 / 10,000), not
  randomly-sized fixtures, so two runs are comparable.
- **No live RPC, no live network** — event-replay benchmarks use a
  synthetic in-memory event fixture, not a real chain node; this keeps the
  benchmark's variance a property of the database and code, not of network
  conditions (which the [RPC degradation matrix](./RPC_DEGRADATION_TEST_MATRIX.md)
  covers separately).
- **Report, then assert** — every benchmark logs its raw timing
  (`console.log`, as the existing test already does) *and* asserts a
  guardrail bound, so a CI failure is actionable without needing to
  reproduce locally first.

---

## How to regenerate these numbers

```bash
pnpm --filter @wafflefinance/sdk build   # required before any coordinator command
pnpm --filter @wafflefinance/coordinator exec vitest run test/performance.test.ts
```

Once the target scenarios above are added, the same command (or a
dedicated `benchmark` script added to `@wafflefinance/coordinator` — see
`docs/TECHNICAL_DEBT.md` for the backlog item) should regenerate the full
table in this document. Update
this file in the same PR that changes anything on the order lifecycle's
hot path — persistence schema, index definitions, or the reconciler's
replay logic — so the baseline doesn't silently go stale.
