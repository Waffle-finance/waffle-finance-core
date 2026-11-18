/**
 * @file audit-repo-kysely.ts
 *
 * Kysely-native implementation of the audit log repository (issue #479).
 *
 * This is a drop-in replacement for `AuditRepository` (audit-repo.ts) that
 * uses the Kysely query builder instead of raw SQL strings.  Key improvements
 * over the legacy implementation:
 *
 *  - No dialect-specific SQL: `CAST(strftime('%s','now') AS INTEGER)` vs
 *    `CAST(EXTRACT(EPOCH FROM NOW()) AS INTEGER)` are handled by Kysely's
 *    dialect layer automatically.
 *  - Compile-time type safety: column names, value types, and filter
 *    expressions are all checked by TypeScript via the `CoordinatorDatabase`
 *    schema types.
 *  - No named-parameter–to–positional translation: Kysely's query builder
 *    always emits the correct positional parameter syntax for the active
 *    dialect.
 *
 * The public API is intentionally identical to `AuditRepository` so call
 * sites can switch to this implementation with a single import change.
 */

import type { KyselyCoordinatorDb } from '../persistence/schema-types.js';
import { AUDIT_SCHEMA_VERSION, type AuditEntry, type AuditEntryInput } from './audit-log.js';

// ─── Re-export cursor / page types for API compatibility ─────────────────────

export interface AuditCursor {
  afterId: number;
}

export interface AuditPage {
  entries: AuditEntry[];
  nextCursor: AuditCursor | null;
  totalCount: number | null;
}

export interface AuditQueryOptions {
  orderId?: string;
  eventTypes?: string[];
  since?: number;
  until?: number;
  limit?: number;
  cursor?: AuditCursor;
  includeCount?: boolean;
}

// ─── Row → domain mapper ─────────────────────────────────────────────────────

function assertFiniteInteger(value: unknown, field: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n !== Math.trunc(n)) {
    throw new Error(`Malformed audit row: ${field} is not a finite integer (got ${String(value)})`);
  }
  return n;
}

function rowToEntry(r: {
  id: number;
  schema_version: number;
  event_type: string;
  order_id: string | null;
  request_id: string | null;
  payload_json: string;
  created_at: number;
}): AuditEntry {
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

// ─── Repository ───────────────────────────────────────────────────────────────

export class KyselyAuditRepository {
  constructor(private readonly db: KyselyCoordinatorDb) {}

  /**
   * Append a single audit entry.  Returns the auto-assigned id.
   */
  async append(input: AuditEntryInput): Promise<number> {
    try {
      JSON.parse(input.payloadJson);
    } catch {
      throw new SyntaxError(
        `KyselyAuditRepository.append: payloadJson is not valid JSON: ${input.payloadJson}`
      );
    }

    const result = await this.db
      .insertInto('audit_log')
      .values({
        schema_version: AUDIT_SCHEMA_VERSION,
        event_type: input.eventType,
        order_id: input.orderId ?? null,
        request_id: input.requestId ?? null,
        payload_json: input.payloadJson,
      })
      .executeTakeFirstOrThrow();

    // Kysely returns `insertId` (BigInt for MySQL/SQLite) or `undefined` for
    // Postgres (which uses RETURNING).  For Postgres we fall back to a
    // SELECT MAX(id) which is acceptable for append-only audit tables.
    if (result.insertId != null) {
      return Number(result.insertId);
    }

    const latest = await this.db
      .selectFrom('audit_log')
      .select('id')
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst();

    return latest?.id ?? 0;
  }

  /**
   * Append multiple entries atomically.
   */
  async appendBatch(inputs: AuditEntryInput[]): Promise<number[]> {
    if (inputs.length === 0) return [];

    const ids: number[] = [];
    await this.db.transaction().execute(async (trx) => {
      for (const input of inputs) {
        try {
          JSON.parse(input.payloadJson);
        } catch {
          throw new SyntaxError(
            `KyselyAuditRepository.appendBatch: payloadJson is not valid JSON: ${input.payloadJson}`
          );
        }

        const result = await trx
          .insertInto('audit_log')
          .values({
            schema_version: AUDIT_SCHEMA_VERSION,
            event_type: input.eventType,
            order_id: input.orderId ?? null,
            request_id: input.requestId ?? null,
            payload_json: input.payloadJson,
          })
          .executeTakeFirstOrThrow();

        ids.push(result.insertId != null ? Number(result.insertId) : 0);
      }
    });

    return ids;
  }

  /**
   * Query audit entries with filtering and cursor-based pagination.
   */
  async query(opts: AuditQueryOptions = {}): Promise<AuditPage> {
    if (opts.limit !== undefined && opts.limit <= 0) {
      throw new RangeError(
        `KyselyAuditRepository.query: limit must be a positive integer, got ${opts.limit}`
      );
    }
    const limit = Math.min(opts.limit ?? 100, 1000);
    const fetchLimit = limit + 1;

    // Build the base query
    let query = this.db
      .selectFrom('audit_log')
      .selectAll()
      .orderBy('id', 'asc')
      .limit(fetchLimit);

    if (opts.cursor) {
      query = query.where('id', '>', opts.cursor.afterId);
    }
    if (opts.orderId) {
      query = query.where('order_id', '=', opts.orderId);
    }
    if (opts.since !== undefined) {
      query = query.where('created_at', '>=', opts.since);
    }
    if (opts.until !== undefined) {
      query = query.where('created_at', '<=', opts.until);
    }
    if (opts.eventTypes && opts.eventTypes.length > 0) {
      query = query.where('event_type', 'in', opts.eventTypes);
    }

    const rows = await query.execute();

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const entries = pageRows.map(rowToEntry);

    const nextCursor: AuditCursor | null =
      hasMore && entries.length > 0
        ? { afterId: entries[entries.length - 1].id }
        : null;

    let totalCount: number | null = null;
    if (opts.includeCount) {
      let countQuery = this.db
        .selectFrom('audit_log')
        .select((eb) => eb.fn.countAll<number>().as('cnt'));

      if (opts.orderId) {
        countQuery = countQuery.where('order_id', '=', opts.orderId);
      }
      if (opts.since !== undefined) {
        countQuery = countQuery.where('created_at', '>=', opts.since);
      }
      if (opts.until !== undefined) {
        countQuery = countQuery.where('created_at', '<=', opts.until);
      }
      if (opts.eventTypes && opts.eventTypes.length > 0) {
        countQuery = countQuery.where('event_type', 'in', opts.eventTypes);
      }

      const countRow = await countQuery.executeTakeFirst();
      totalCount = Number(countRow?.cnt ?? 0);
    }

    return { entries, nextCursor, totalCount };
  }

  /**
   * All audit entries for a specific order, ascending.
   */
  async forOrder(orderId: string): Promise<AuditEntry[]> {
    const rows = await this.db
      .selectFrom('audit_log')
      .selectAll()
      .where('order_id', '=', orderId)
      .orderBy('id', 'asc')
      .execute();

    return rows.map(rowToEntry);
  }

  /**
   * The most recent N entries (tail of the log).
   */
  async tail(n = 50): Promise<AuditEntry[]> {
    const rows = await this.db
      .selectFrom('audit_log')
      .selectAll()
      .orderBy('id', 'desc')
      .limit(n)
      .execute();

    return rows.map(rowToEntry).reverse();
  }
}
