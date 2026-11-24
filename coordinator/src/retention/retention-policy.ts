/**
 * Sensitive-data retention classes and verifiable cleanup (#1134).
 *
 * The policy is intentionally explicit: every sensitive category has a
 * documented retention duration, a cleanup mode, and the constraints that
 * must be honoured before anything is removed. Audit records and active
 * settlement data are never deleted; expired secret ciphertext is cleared
 * in place and expired request metadata is physically removed.
 */

export type RetentionClass =
  | "active_settlement"
  | "legal_audit"
  | "secret_ciphertext"
  | "order_history"
  | "request_metadata";

export type RetentionMode = "delete" | "clear" | "retain";

export interface RetentionRule {
  readonly category: string;
  readonly retentionClass: RetentionClass;
  readonly retentionDays: number;
  readonly mode: RetentionMode;
  /** Human-readable justification recorded with each cleanup result. */
  readonly reason: string;
  /** Rows matching this predicate (with the cutoff bound) need action. */
  readonly eligibleSql: string;
  /** Statement used to count rows, with one `created_at` cutoff parameter. */
  readonly countSql: string;
  /** Statement used to clean rows, with one cutoff parameter (when applicable). */
  readonly cleanupSql: string;
}

const DAY_SECONDS = 86_400;

/**
 * Documented default retention policy. Durations are days; cleanup is driven
 * by row age (`created_at`, Unix seconds) unless a rule says otherwise.
 */
export const RETENTION_POLICY: readonly RetentionRule[] = [
  {
    category: "active settlement orders",
    retentionClass: "active_settlement",
    retentionDays: 0,
    mode: "retain",
    reason: "Orders in an active settlement state must never be deleted or cleared",
    eligibleSql: "1 = 0",
    countSql: "SELECT COUNT(*) AS n FROM orders WHERE status NOT IN ('expired', 'cancelled', 'refunded', 'failed')",
    cleanupSql: "",
  },
  {
    category: "audit records",
    retentionClass: "legal_audit",
    retentionDays: 2555,
    mode: "retain",
    reason: "Append-only audit log under legal hold; never updated or deleted",
    eligibleSql: "1 = 0",
    countSql: "SELECT COUNT(*) AS n FROM audit_log",
    cleanupSql: "",
  },
  {
    category: "secret ciphertext",
    retentionClass: "secret_ciphertext",
    retentionDays: 30,
    mode: "clear",
    reason: "Clear ciphertext on archived terminal orders only; keep the order row and audit trail",
    eligibleSql:
      "status IN ('expired', 'cancelled', 'refunded', 'failed') AND archived_at IS NOT NULL AND preimage IS NOT NULL AND created_at < ?",
    countSql:
      "SELECT COUNT(*) AS n FROM orders WHERE status IN ('expired', 'cancelled', 'refunded', 'failed') AND archived_at IS NOT NULL AND preimage IS NOT NULL",
    cleanupSql:
      "UPDATE orders SET preimage = NULL, preimage_enc_version = NULL WHERE status IN ('expired', 'cancelled', 'refunded', 'failed') AND archived_at IS NOT NULL AND preimage IS NOT NULL AND created_at < ?",
  },
  {
    category: "order history",
    retentionClass: "order_history",
    retentionDays: 3650,
    mode: "retain",
    reason: "Order transition history is retained for dispute resolution and exports",
    eligibleSql: "1 = 0",
    countSql: "SELECT COUNT(*) AS n FROM order_events",
    cleanupSql: "",
  },
  {
    category: "request metadata",
    retentionClass: "request_metadata",
    retentionDays: 7,
    mode: "delete",
    reason: "Expired replay/request metadata is safe to delete once its window has passed",
    eligibleSql: "created_at < ?",
    countSql: "SELECT COUNT(*) AS n FROM processed_events",
    cleanupSql: "DELETE FROM processed_events WHERE created_at < ?",
  },
];

/** Minimal database surface needed by the cleanup runner (better-sqlite3 compatible). */
export interface RetentionDb {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): { changes: number };
  };
}

export interface RetentionCleanupEntry {
  category: string;
  retentionClass: RetentionClass;
  retentionDays: number;
  mode: RetentionMode;
  reason: string;
  /** Rows present for the category before cleanup. */
  inspected: number;
  /** Rows cleared or removed by this run. */
  removed: number;
  /** Rows kept because they are active, under hold, or not yet expired. */
  retained: number;
  /** Unix seconds at which the cutoff was computed. */
  executedAt: number;
  /** Unix seconds before which eligible rows are removed. */
  cutoff: number;
}

export interface RetentionCleanupReport {
  executedAt: number;
  cutoff: number;
  entries: RetentionCleanupEntry[];
}

function countRows(db: RetentionDb, rule: RetentionRule): number {
  const rows = db.prepare(rule.countSql).all() as Array<{ n: number }>;
  return Number(rows[0]?.n ?? 0);
}

/**
 * Run every retention rule and return an auditable report of what was
 * inspected, removed and retained. `nowSeconds` is injectable so cleanup can
 * be verified deterministically in tests.
 */
export function runRetentionCleanup(
  db: RetentionDb,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  policy: readonly RetentionRule[] = RETENTION_POLICY,
): RetentionCleanupReport {
  const cutoff = nowSeconds - 0 * DAY_SECONDS;
  const entries: RetentionCleanupEntry[] = [];

  for (const rule of policy) {
    const ruleCutoff = nowSeconds - rule.retentionDays * DAY_SECONDS;
    const before = countRows(db, rule);
    let removed = 0;
    if (rule.mode !== "retain" && rule.cleanupSql) {
      removed = db.prepare(rule.cleanupSql).run(ruleCutoff).changes;
    }
    entries.push({
      category: rule.category,
      retentionClass: rule.retentionClass,
      retentionDays: rule.retentionDays,
      mode: rule.mode,
      reason: rule.reason,
      inspected: before,
      removed,
      retained: before - removed,
      executedAt: nowSeconds,
      cutoff: ruleCutoff,
    });
  }

  return { executedAt: nowSeconds, cutoff, entries };
}
