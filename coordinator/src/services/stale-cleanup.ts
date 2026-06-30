import type { Logger } from "pino";
import type { OrdersRepository } from "../persistence/orders-repo.js";
import { staleCleanupRuns, staleOrdersArchived, staleCleanupLastRun } from "../metrics.js";

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
    try {
      const stale = await this.repo.findStaleAnnounced(this.retentionWindowSeconds);
      const batch = stale.slice(0, this.batchSize);

      for (const order of batch) {
        await this.repo.archiveOrder(order.publicId);
      }

      const archivedCount = batch.length;

      staleCleanupRuns.inc({ result: "success" });
      staleOrdersArchived.inc(archivedCount);
      staleCleanupLastRun.set(Math.floor(Date.now() / 1000));

      if (archivedCount > 0) {
        this.log.info(
          { archivedCount, retentionWindowSeconds: this.retentionWindowSeconds },
          "stale order cleanup archived records"
        );
      }

      return { archivedCount };
    } catch (err) {
      staleCleanupRuns.inc({ result: "failure" });
      this.log.error({ err }, "stale order cleanup failed");
      throw err;
    }
  }
}
