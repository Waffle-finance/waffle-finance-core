# Coordinator order retention and archival

Maintenance retains order rows; neither scheduled cleanup job hard-deletes them.
There is no scheduled deletion deadline for terminal orders, their transition
history, or the append-only audit log. Do not treat these records as disposable
after 30 days.

## Eligibility and effects

Both jobs select orders with `status = 'announced'`, `src_order_id IS NULL`,
`archived_at IS NULL`, and `created_at < now - 30 days` (2,592,000 seconds).
Age is measured from creation, not the last update. Exactly 30 days old is not
yet eligible. Both services default to at most 100 orders per invocation;
remaining candidates wait for subsequent runs. These are constructor defaults,
used without overrides in [startup wiring](../src/index.ts), rather than
environment settings for retention or batch size.

[Default retention tests](../test/retention-defaults.test.ts) pin both services'
30-day selector argument, the 100-order default batch cap, and the archival
policy's strict cutoff at exactly 30 days.

| Job | Effect on an eligible row | Protection |
| --- | --- | --- |
| `stale_cleanup` | Sets status to terminal `abandoned`, stamps `archived_at`, records reason `stale:no_src_lock` and actor `stale-cleanup`, and appends a transition event. | [Stale cleanup tests](../test/stale-cleanup.test.ts): “archives announced orders older than the retention window with no src lock”, “does not archive orders younger than the retention window”, and “respects batch size and leaves remaining stale orders for the next run”. |
| `archival_policy` | Stamps `archived_at`; preserves the existing `announced` status. | [Archival policy tests](../test/archival-policy.test.ts): “archives an announced order older than the retention window with no src lock”, “does NOT archive a fresh order within the retention window”, and “respects batchSize and leaves remaining eligible orders for the next run”. |

The [repository selector](../src/persistence/orders-repo.ts) excludes every
non-announced state, including locked/in-progress orders and terminal states
(`completed`, `refunded`, `failed`, `expired`, `cancelled`, `abandoned`). Source
locks and already archived rows are also excluded. The two jobs share candidates;
whichever processes a row first makes it ineligible for the other. See the
source-lock, non-announced-state, and already-archived cases in the tests above.

Archival preserves data for direct repository lookup and database inspection;
active maintenance selectors exclude archived rows. The archival policy's
`reactivateOrder()` clears `archived_at` only for an archived order still in
`announced`. It does not reverse a stale-cleanup transition to `abandoned`.
Recovery is covered by “clears archived_at on an archived announced order” and
“skips reactivation when the order was advanced by the reconciler while archived”
in the archival policy tests.

## Automatic scheduling

[Startup registration](../src/index.ts) schedules both cleanup jobs every
`COORDINATOR_POLL_INTERVAL_MS × 240`: 60 minutes at the configured default
15,000 ms ([configuration](../../packages/config/src/node.ts)). The separate
`expiry_scan` runs every poll interval × 4 (60 seconds by default), marking
orders expired by their chain timelocks; it does not delete order data.

The [maintenance scheduler](../src/services/maintenance-scheduler.ts) triggers
an immediate first run at startup, enqueues scheduled work through the backlog,
and skips concurrent execution of a job already running. Cadence is an execution
schedule, not a guarantee that all eligible records are processed immediately.
[Scheduler tests](../test/maintenance-scheduler.test.ts) cover “archives only
orders beyond the retention window”, “batchSize cap leaves remaining stale orders
for the next run”, “concurrent invocation returns skipped=true and does not
double-execute”, and “already-terminal orders are skipped by the expiry scan”.

## Safe operational verification

Use a read-only connection or a backup copy to preview SQLite candidates:

```sql
SELECT public_id, status, created_at, archived_at
FROM orders
WHERE status = 'announced'
  AND src_order_id IS NULL
  AND archived_at IS NULL
  AND created_at < CAST(strftime('%s', 'now') AS INTEGER) - 2592000
ORDER BY created_at, public_id;
```

This query does not mutate records and does not predict which 100 are selected:
the runtime selector has no ordering clause. Compare candidate counts, archived
rows, `abandon.transitioned` events, maintenance completion/error logs, and
`coordinator_stale_cleanup_*` metrics before and after scheduled runs. The
[stale cleanup metrics tests](../test/stale-cleanup.test.ts) cover backlog,
remaining backlog, duration, and failures.

The authenticated [POST /admin/stale-cleanup route](../src/server/routes/admin.ts)
performs a real cleanup; it is not a dry run. Preview and back up first, then use
the route only when a mutation is intended. No terminal-record purge or automatic
hard-delete operation is provided by these jobs.
