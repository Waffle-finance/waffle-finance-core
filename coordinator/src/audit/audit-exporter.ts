/**
 * @file audit-exporter.ts
 *
 * Replay / export contract for the coordinator audit stream.
 *
 * Consumers (incident response tools, external SIEM, snapshot scripts) use
 * this module to read the audit log without touching a live database session
 * directly.  The exporter can:
 *
 *  1. Stream all entries from the beginning, or from a saved cursor position.
 *  2. Export a JSON-lines (NDJSON) file that is valid without any DB connection.
 *  3. Replay the stream through a handler function for validation or diffing.
 *
 * The exporter is intentionally read-only.  It never writes to the audit_log
 * table.
 */

import type { Writable } from 'node:stream';
import type { AuditRepository, AuditCursor, AuditQueryOptions } from './audit-repo.js';
import type { AuditEntry, AuditEventType } from './audit-log.js';
import { parseAuditPayload } from './audit-log.js';

/** Maximum page size the repository accepts (mirrors AuditRepository limit). */
const MAX_PAGE_SIZE = 1000;

// ─── Export options ───────────────────────────────────────────────────────────

export interface ExportOptions {
  /** Only export entries for this order. */
  orderId?: string;
  /** Filter to these event types. */
  eventTypes?: AuditEventType[];
  /** Start time (unix seconds, inclusive). */
  since?: number;
  /** End time (unix seconds, inclusive). */
  until?: number;
  /**
   * Number of entries to fetch per database page.
   * Larger = fewer round-trips, higher memory per page.
   * Default: 500.
   */
  pageSize?: number;
  /**
   * Resume export from this cursor position (returned by a previous export).
   * Allows incremental exports: run at T0, save cursor, run again at T1 to
   * get only the new entries without re-reading the full log.
   */
  resumeCursor?: AuditCursor;
}

// ─── Replay handler ───────────────────────────────────────────────────────────

export type ReplayHandler = (entry: AuditEntry) => void | Promise<void>;

// ─── Export result ────────────────────────────────────────────────────────────

export interface ExportResult {
  /** Total number of entries written/replayed during this run. */
  entriesProcessed: number;
  /**
   * Cursor pointing to the last entry that was processed.
   * Pass this as `resumeCursor` on the next run to get only new entries.
   * null if no entries were processed.
   */
  finalCursor: AuditCursor | null;
}

// ─── NDJSON record shape ──────────────────────────────────────────────────────

/**
 * Each line in the NDJSON export is one of these objects.
 * The `payload` field is the parsed AuditPayload (not the raw JSON string)
 * so the file is self-contained and human-readable.
 */
export interface NdjsonRecord {
  id: number;
  schemaVersion: number;
  eventType: string;
  orderId: string | null;
  requestId: string | null;
  createdAt: number;
  payload: unknown;
}

// ─── Exporter class ───────────────────────────────────────────────────────────

export class AuditExporter {
  constructor(private readonly repo: AuditRepository) {}

  /**
   * Stream all matching audit entries through `handler`, paginating
   * automatically until the log is exhausted.
   *
   * @param handler  Called once per entry, in ascending ID order.
   * @param opts     Filter / pagination options.
   * @returns        Summary of the replay run including the final cursor.
   *
   * @example
   * const result = await exporter.replay(
   *   (entry) => console.log(entry.eventType, entry.orderId),
   *   { orderId: 'wf_0xabc…', since: startTs }
   * );
   * console.log(`Replayed ${result.entriesProcessed} entries`);
   */
  async replay(handler: ReplayHandler, opts: ExportOptions = {}): Promise<ExportResult> {
    const pageSize = Math.min(opts.pageSize ?? 500, MAX_PAGE_SIZE);
    let cursor: AuditCursor | undefined = opts.resumeCursor;
    let entriesProcessed = 0;
    let finalCursor: AuditCursor | null = null;

    while (true) {
      const queryOpts: AuditQueryOptions = {
        orderId: opts.orderId,
        eventTypes: opts.eventTypes,
        since: opts.since,
        until: opts.until,
        limit: pageSize,
        cursor,
      };

      const page = await this.repo.query(queryOpts);

      for (const entry of page.entries) {
        await handler(entry);
        entriesProcessed++;
        finalCursor = { afterId: entry.id };
      }

      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }

    return { entriesProcessed, finalCursor };
  }

  /**
   * Export the audit stream as NDJSON (newline-delimited JSON) written to
   * any Node.js Writable stream (file, stdout, HTTP response body, etc.).
   *
   * Each output line is a valid JSON object terminated by `\n`.
   * The file can be consumed without a database connection.
   *
   * @example
   * import { createWriteStream } from 'node:fs';
   * const out = createWriteStream('/var/audit/export-2026-07-25.ndjson');
   * const result = await exporter.exportNdjson(out, { since: startTs });
   * out.end();
   * console.log(`Exported ${result.entriesProcessed} entries`);
   */
  async exportNdjson(dest: Writable, opts: ExportOptions = {}): Promise<ExportResult> {
    return this.replay(
      (entry) => {
        const record: NdjsonRecord = {
          id: entry.id,
          schemaVersion: entry.schemaVersion,
          eventType: entry.eventType,
          orderId: entry.orderId,
          requestId: entry.requestId,
          createdAt: entry.createdAt,
          payload: parseAuditPayload(entry) ?? entry.payloadJson,
        };
        const ok = dest.write(JSON.stringify(record) + '\n');
        if (!ok) {
          return new Promise<void>((resolve) => dest.once('drain', resolve));
        }
      },
      opts,
    );
  }

  /**
   * Collect all entries for a single order into an array, ordered oldest-first.
   * Convenience method for incident-response tooling.
   */
  async orderTimeline(orderId: string): Promise<AuditEntry[]> {
    return this.repo.forOrder(orderId);
  }

  /**
   * Validate that the audit stream for a given set of orderIds exactly
   * reflects the expected state-machine transition sequence.
   *
   * Returns an array of discrepancy descriptions (empty = audit is consistent).
   *
   * The check walks each order's entries in creation order and verifies:
   *   1. The first entry is always `order.announced`.
   *   2. Every subsequent `toStatus` in an order entry equals the
   *      `toStatus` of the previous entry (i.e. the recorded `fromStatus`
   *      matches what we last saw).
   *   3. No entries appear after a terminal status
   *      (completed / refunded / failed).
   */
  async validateOrderSequences(
    orderIds: string[],
  ): Promise<{ orderId: string; issue: string }[]> {
    const TERMINAL = new Set(['completed', 'refunded', 'failed', 'expired']);
    const discrepancies: { orderId: string; issue: string }[] = [];

    for (const orderId of orderIds) {
      const entries = await this.repo.forOrder(orderId);

      // Filter to order lifecycle entries only
      const orderEntries = entries.filter((e) =>
        e.eventType.startsWith('order.'),
      );

      if (orderEntries.length === 0) {
        discrepancies.push({ orderId, issue: 'No audit entries found for this order' });
        continue;
      }

      let lastStatus: string | null = null;
      let seenTerminal = false;

      for (const entry of orderEntries) {
        let payload: { fromStatus?: string | null; toStatus?: string } | null = null;
        try {
          payload = JSON.parse(entry.payloadJson);
        } catch {
          discrepancies.push({
            orderId,
            issue: `Entry id=${entry.id} has unparseable payloadJson`,
          });
          continue;
        }

        // Guard: payload must be a non-null object with a string toStatus
        if (!payload || typeof payload.toStatus !== 'string') {
          discrepancies.push({
            orderId,
            issue: `Entry id=${entry.id} is malformed: missing or invalid toStatus`,
          });
          continue;
        }

        // Guard: if fromStatus is present it must be a string or null/undefined
        if (
          payload.fromStatus !== null &&
          payload.fromStatus !== undefined &&
          typeof payload.fromStatus !== 'string'
        ) {
          discrepancies.push({
            orderId,
            issue: `Entry id=${entry.id} is malformed: invalid fromStatus type`,
          });
          continue;
        }

        // Check: first entry must be announced
        if (lastStatus === null && payload.toStatus !== 'announced') {
          discrepancies.push({
            orderId,
            issue: `First audit entry has toStatus="${payload.toStatus}" but expected "announced"`,
          });
        }

        // Check: fromStatus must match last observed toStatus
        if (
          lastStatus !== null &&
          payload.fromStatus !== null &&
          payload.fromStatus !== undefined &&
          payload.fromStatus !== lastStatus
        ) {
          discrepancies.push({
            orderId,
            issue:
              `Entry id=${entry.id} (${entry.eventType}): fromStatus="${payload.fromStatus}" ` +
              `but last observed toStatus="${lastStatus}"`,
          });
        }

        // Check: no entries after a terminal status
        if (seenTerminal) {
          discrepancies.push({
            orderId,
            issue:
              `Entry id=${entry.id} (${entry.eventType}) appears after ` +
              `the order reached terminal status "${lastStatus}"`,
          });
        }

        lastStatus = payload.toStatus;
        if (TERMINAL.has(payload.toStatus)) seenTerminal = true;
      }
    }

    return discrepancies;
  }
}
