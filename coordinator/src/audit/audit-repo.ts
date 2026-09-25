/**
 * @file audit-repo.ts
 *
 * Persistence layer for the coordinator audit log.
 *
 * Works with both the SQLite (node:sqlite) backend and the PostgreSQL (pg)
 * backend that `coordinator/src/persistence/db.ts` abstracts behind the
 * `Database` interface.  The same query logic covers both because the SQL
 * dialect used here (INSERT, SELECT with cursor, COUNT) is identical between
 * SQLite and Postgres.
 */

import type { Database } from '../persistence/db.js';
import { AUDIT_SCHEMA_VERSION, type AuditEntry, type AuditEntryInput } from './audit-log.js';

// ─── Internal DB row shape ────────────────────────────────────────────────────

interface AuditDbRow {
  id: number;
  schema_version: number;
  event_type: string;
  order_id: string | null;
  request_id: string | null;
  payload_json: string;
  created_at: number;
}

function assertFiniteInteger(value: unknown, field: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n !== Math.trunc(n)) {
    throw new Error(`Malformed audit row: ${field} is not a finite integer (got ${String(value)})`);
  }
  return n;
}

function rowToEntry(r: AuditDbRow): AuditEntry {
  return {
    id: assertFiniteInteger(r.id, 'id'),
    schemaVersion: r.schema_version as typeof AUDIT_SCHEMA_VERSION,
    eventType: r.event_type as AuditEntry['eventType'],
    orderId: r.order_id,
    requestId: r.request_id,
    payloadJson: r.payload_json,
    createdAt: assertFiniteInteger(r.created_at, 'created_at'),
  };
}

// ─── Cursor type ──────────────────────────────────────────────────────────────

export interface AuditCursor {
  /** The `id` of the last entry returned on the previous page. */
  afterId: number;
}

export interface AuditPage {
  entries: AuditEntry[];
  /** null when there are no more rows after this page. */
  nextCursor: AuditCursor | null;
  totalCount: number | null; // null when count was not requested
}

// ─── Query options ────────────────────────────────────────────────────────────

export interface AuditQueryOptions {
  /** Only return entries for this orderId. */
  orderId?: string;
  /** Only return entries of these event types. */
  eventTypes?: string[];
  /** Return entries created at or after this unix-second timestamp. */
  since?: number;
  /** Return entries created at or before this unix-second timestamp. */
  until?: number;
  /** Maximum number of entries per page (default: 100, max: 1000). */
  limit?: number;
  /** Cursor from a previous page response. */
  cursor?: AuditCursor;
  /** Whether to include a totalCount in the response (adds a COUNT query). */
  includeCount?: boolean;
}

// ─── Statement adapter ────────────────────────────────────────────────────────

type Statement = ReturnType<Database['prepare']>;
type StatementResult = { changes: number; lastInsertRowid: number };
type AsyncStatement = Statement & {
  runAsync?: (...p: unknown[]) => Promise<StatementResult>;
  getAsync?: (...p: unknown[]) => Promise<unknown>;
  allAsync?: (...p: unknown[]) => Promise<unknown[]>;
};

async function stmtRun(stmt: Statement, ...params: unknown[]): Promise<StatementResult> {
  const s = stmt as AsyncStatement;
  if (s.runAsync) return s.runAsync(...params);
  const r = stmt.run(...params);
  return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
}

async function stmtGet<T>(stmt: Statement, ...params: unknown[]): Promise<T | undefined> {
  const s = stmt as AsyncStatement;
  if (s.getAsync) return (await s.getAsync(...params)) as T | undefined;
  return stmt.get(...params) as T | undefined;
}

async function stmtAll<T>(stmt: Statement, ...params: unknown[]): Promise<T[]> {
  const s = stmt as AsyncStatement;
  if (s.allAsync) return (await s.allAsync(...params)) as T[];
  return stmt.all(...params) as T[];
}

// ─── Repository ───────────────────────────────────────────────────────────────

export class AuditRepository {
  private readonly insertStmt: Statement;

  constructor(private readonly db: Database) {
    this.insertStmt = db.prepare(`
      INSERT INTO audit_log (
        schema_version, event_type, order_id, request_id, payload_json
      ) VALUES (
        :schemaVersion, :eventType, :orderId, :requestId, :payloadJson
      )
    `);
  }

  /**
   * Append a single audit entry to the log.
   * Returns the auto-assigned id of the new row.
   *
   * This is the only write path — entries are never updated or deleted.
   */
  async append(input: AuditEntryInput): Promise<number> {
    // Validate that payloadJson is parseable JSON before hitting the database.
    // Malformed JSON stored in the audit table would cause downstream export
    // and replay code to fail far from the original write.
    try {
      JSON.parse(input.payloadJson);
    } catch {
      throw new SyntaxError(`AuditRepository.append: payloadJson is not valid JSON: ${input.payloadJson}`);
    }

    const result = await stmtRun(this.insertStmt, {
      schemaVersion: AUDIT_SCHEMA_VERSION,
      eventType: input.eventType,
      orderId: input.orderId ?? null,
      requestId: input.requestId ?? null,
      payloadJson: input.payloadJson,
    });
    return Number(result.lastInsertRowid);
  }

  /**
   * Append multiple entries in a single transaction.
   * Prefer this over calling `append` in a loop for batch inserts.
   */
  async appendBatch(inputs: AuditEntryInput[]): Promise<number[]> {
    if (inputs.length === 0) return [];

    const ids: number[] = [];
    // Use a transaction so the batch is atomic.
    // The db.prepare/exec pattern works for both SQLite and Postgres adapters.
    const txStmt = this.db.prepare('BEGIN');
    const commitStmt = this.db.prepare('COMMIT');
    const rollbackStmt = this.db.prepare('ROLLBACK');

    try {
      await stmtRun(txStmt);
      for (const input of inputs) {
        ids.push(await this.append(input));
      }
      await stmtRun(commitStmt);
    } catch (err) {
      await stmtRun(rollbackStmt).catch(() => {/* swallow rollback error */});
      throw err;
    } finally {
      // Release temporary statements so adapter resources are not held
      // across repeated batch writes. SQLite's DatabaseSync requires
      // explicit finalization; Postgres statements are stateless and
      // safe to skip.
      for (const s of [txStmt, commitStmt, rollbackStmt]) {
        if (typeof (s as any).finalize === 'function') (s as any).finalize();
      }
    }

    return ids;
  }

  /**
   * Query audit entries with filtering and cursor-based pagination.
   *
   * The cursor is the `id` of the last returned entry so the stream is
   * stable even if new entries are appended while a consumer is paginating.
   */
  async query(opts: AuditQueryOptions = {}): Promise<AuditPage> {
    if (opts.limit !== undefined && opts.limit <= 0) {
      throw new RangeError(`AuditRepository.query: limit must be a positive integer, got ${opts.limit}`);
    }
    const limit = Math.min(opts.limit ?? 100, 1000);
    const fetchLimit = limit + 1; // fetch one extra to detect hasMore

    // Build WHERE clauses
    const conditions: string[] = [];
    const params: Record<string, unknown> = { fetchLimit };

    if (opts.cursor) {
      conditions.push('id > :afterId');
      params.afterId = opts.cursor.afterId;
    }
    if (opts.orderId) {
      conditions.push('order_id = :orderId');
      params.orderId = opts.orderId;
    }
    if (opts.eventTypes && opts.eventTypes.length > 0) {
      // Build a static IN list; parameterised IN is non-trivial across
      // SQLite/Postgres without a helper, and eventTypes come from trusted
      // internal callers only (not user input).
      const placeholders = opts.eventTypes
        .map((_, i) => `:et${i}`)
        .join(', ');
      conditions.push(`event_type IN (${placeholders})`);
      opts.eventTypes.forEach((et, i) => { params[`et${i}`] = et; });
    }
    if (opts.since !== undefined) {
      conditions.push('created_at >= :since');
      params.since = opts.since;
    }
    if (opts.until !== undefined) {
      conditions.push('created_at <= :until');
      params.until = opts.until;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const rows = await stmtAll<AuditDbRow>(
      this.db.prepare(`
        SELECT id, schema_version, event_type, order_id, request_id, payload_json, created_at
        FROM audit_log
        ${where}
        ORDER BY id ASC
        LIMIT :fetchLimit
      `),
      params,
    );

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const entries = pageRows.map(rowToEntry);

    const nextCursor: AuditCursor | null =
      hasMore && entries.length > 0
        ? { afterId: entries[entries.length - 1].id }
        : null;

    let totalCount: number | null = null;
    if (opts.includeCount) {
      const countRow = await stmtGet<{ cnt: number }>(
        this.db.prepare(`SELECT COUNT(*) AS cnt FROM audit_log ${where}`),
        // Exclude fetchLimit from count params
        Object.fromEntries(Object.entries(params).filter(([k]) => k !== 'fetchLimit')),
      );
      totalCount = Number(countRow?.cnt ?? 0);
    }

    return { entries, nextCursor, totalCount };
  }

  /**
   * Return all audit entries for a specific order in ascending creation order.
   * Convenience wrapper around `query` for the common single-order case.
   */
  async forOrder(orderId: string): Promise<AuditEntry[]> {
    const rows = await stmtAll<AuditDbRow>(
      this.db.prepare(`
        SELECT id, schema_version, event_type, order_id, request_id, payload_json, created_at
        FROM audit_log
        WHERE order_id = ?
        ORDER BY id ASC
      `),
      orderId,
    );
    return rows.map(rowToEntry);
  }

  /**
   * Return the most recent N entries (tail of the log).
   * Useful for live monitoring and health-check endpoints.
   */
  async tail(n = 50): Promise<AuditEntry[]> {
    const rows = await stmtAll<AuditDbRow>(
      this.db.prepare(`
        SELECT id, schema_version, event_type, order_id, request_id, payload_json, created_at
        FROM audit_log
        ORDER BY id DESC
        LIMIT ?
      `),
      n,
    );
    // Return in ascending order so callers always see oldest-first
    return rows.map(rowToEntry).reverse();
  }
}
