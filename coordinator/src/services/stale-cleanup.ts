import type { Logger } from "pino";
import type { OrdersRepository } from "../persistence/orders-repo.js";
import {
  staleCleanupRuns,
  staleOrdersArchived,
  staleCleanupLastRun,
  staleCleanupBacklog,
  staleCleanupRemaining,
  staleCleanupRunDuration,
  staleOrdersArchivedAgeSeconds,
} from "../metrics.js";

export interface StaleCleanupResult {
  archivedCount: number;
}

/**
 * Archives announced orders that have received no source-chain lock within
 * the configured retention window.  These orders are orphaned — the chain
 * never saw a matching lock event — and would otherwise accumulate in the
 * database indefinitely.
 *
 * Archival is a soft-delete (sets archived_at) so records can be recovered
 * if a delayed event surfaces later.  The process is safe to run at any time
 * because it only touches orders that remain in the 'announced' state with no
 * src_order_id.  In-progress orders (src_locked and beyond) are never touched.
 *
 * Run during low-traffic periods via the coordinator's maintenance interval.
 */
export class StaleCleanupService {
  private readonly retentionWindowSeconds: number;

  constructor(
    private readonly repo: OrdersRepository,
    private readonly log: Logger,
    retentionDays = 30,
    private readonly batchSize = 100
  ) {
    this.retentionWindowSeconds = retentionDays * 24 * 60 * 60;
  }

  async run(): Promise<StaleCleanupResult> {
    const startedAtMs = Date.now();
    try {
      const stale = await this.repo.findStaleAnnounced(this.retentionWindowSeconds);

      // ── Backlog size (per direction) ───────────────────────────────────────
      // Published BEFORE the archival loop so operators see the full volume the
      // run is about to work through, including the portion a truncated batch
      // cannot reach.  Reset first so directions with no backlog disappear
      // instead of showing a stale value from a previous run.
      const backlogByDirection = new Map<string, number>();
      for (const order of stale) {
        backlogByDirection.set(
          order.direction,
          (backlogByDirection.get(order.direction) ?? 0) + 1
        );
      }
      staleCleanupBacklog.reset();
      for (const [direction, count] of backlogByDirection) {
        staleCleanupBacklog.set({ direction }, count);
      }

      const batch = stale.slice(0, this.batchSize);
      const archivedByDirection = new Map<string, number>();

      for (const order of batch) {
        await this.repo.abandonOrder(order.publicId, "stale:no_src_lock", "stale-cleanup");
        archivedByDirection.set(
          order.direction,
          (archivedByDirection.get(order.direction) ?? 0) + 1
        );
        // Age at archival — how long the order sat orphaned before cleanup.
        staleOrdersArchivedAgeSeconds.observe(
          Math.max(Date.now() / 1000 - order.createdAt, 0)
        );
      }

      const archivedCount = batch.length;
      const remainingCount = stale.length - archivedCount;

      // ── Remaining backlog after batch truncation (per direction) ────────────
      staleCleanupRemaining.reset();
      for (const [direction, backlog] of backlogByDirection) {
        staleCleanupRemaining.set(
          { direction },
          backlog - (archivedByDirection.get(direction) ?? 0)
        );
      }

      staleCleanupRunDuration.observe((Date.now() - startedAtMs) / 1000);
      staleCleanupRuns.inc({ result: "success" });
      staleOrdersArchived.inc(archivedCount);
      staleCleanupLastRun.set(Math.floor(Date.now() / 1000));

      if (archivedCount > 0 || remainingCount > 0) {
        this.log.info(
          {
            archivedCount,
            remainingCount,
            retentionWindowSeconds: this.retentionWindowSeconds,
          },
          "stale order cleanup completed"
        );
      }

      return { archivedCount };
    } catch (err) {
      staleCleanupRunDuration.observe((Date.now() - startedAtMs) / 1000);
      staleCleanupRuns.inc({ result: "failure" });
      this.log.error({ err }, "stale order cleanup failed");
      throw err;
    }
  }
}
