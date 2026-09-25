/**
 * @file routes/audit.ts
 *
 * Audit log replay and export endpoints.
 *
 * GET  /api/audit                  — paginated query of the audit stream
 * GET  /api/audit/orders/:orderId  — full timeline for one order
 * GET  /api/audit/export           — NDJSON export (streaming)
 * GET  /api/audit/tail             — most recent N entries (live monitoring)
 *
 * All endpoints are read-only.  The audit log is append-only and is never
 * mutated through these routes.
 *
 * Query params for GET /api/audit:
 *   orderId      Filter to a specific order
 *   eventTypes   Comma-separated list of event type strings
 *   since        Unix seconds (start of window, inclusive)
 *   until        Unix seconds (end of window, inclusive)
 *   limit        Page size (default 100, max 1000)
 *   afterId      Cursor — return entries with id > this value
 *   count        "true" to include totalCount in the response
 *
 * Query params for GET /api/audit/export:
 *   Same filters as above, plus:
 *   pageSize     Batch size used while streaming (default 500)
 */

import { Router, type Request, type Response } from "express";
import type { Logger } from "pino";
import type { AuditRepository } from "../../audit/audit-repo.js";
import type { AuditExporter } from "../../audit/audit-exporter.js";
import { AUDIT_EVENT_TYPES, type AuditEventType } from "../../audit/audit-log.js";
import { validationError } from "../errors.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Thrown when a query param is present but not a valid integer (or, for
 *  `limit`, not a positive one). Routes catch this and translate it into the
 *  existing `bad_request` client-facing validation response. */
class InvalidQueryParamError extends Error {
  constructor(public readonly param: string, public readonly value: string) {
    super(`invalid value for query param "${param}": ${value}`);
  }
}

const INTEGER_PATTERN = /^-?\d+$/;

/**
 * Parse a query param as an integer, requiring the *entire* string to
 * represent one — unlike `parseInt`, which silently accepts a numeric
 * prefix (e.g. "12junk" -> 12). Absent values fall back to `defaultVal`
 * unchanged. Throws {@link InvalidQueryParamError} for a present-but-malformed
 * value.
 */
function parseIntParam(val: unknown, paramName: string, defaultVal: number, max?: number): number {
  if (val === undefined) return defaultVal;

  const str = String(val);
  if (!INTEGER_PATTERN.test(str)) {
    throw new InvalidQueryParamError(paramName, str);
  }

  const n = Number(str);
  if (!Number.isFinite(n)) {
    throw new InvalidQueryParamError(paramName, str);
  }

  return max !== undefined ? Math.min(n, max) : n;
}

/**
 * Parse a query param as a strictly positive integer (used for `limit`,
 * where zero or negative values must never reach the repository layer).
 * Delegates format validation to {@link parseIntParam} and additionally
 * rejects nonpositive results.
 */
function parsePositiveIntParam(val: unknown, paramName: string, defaultVal: number, max?: number): number {
  const n = parseIntParam(val, paramName, defaultVal, max);
  if (n <= 0) {
    throw new InvalidQueryParamError(paramName, String(val ?? n));
  }
  return n;
}

/**
 * Parse a nonnegative integer query param (cursors, timestamps). Returns
 * `null` if the value is present but negative, so the caller can respond
 * with a 400 rather than silently passing it through to the repository.
 */
function parseNonNegativeIntParam(val: unknown, defaultVal: number): number | null {
  const n = parseIntParam(val, defaultVal);
  return n < 0 ? null : n;
}

/** Set of all known audit event types, used to validate untrusted query input at runtime. */
const AUDIT_EVENT_TYPE_SET = new Set<string>(AUDIT_EVENT_TYPES);

/**
 * Parse a comma-separated `eventTypes` query param, validating each entry
 * against the known event taxonomy. Returns `null` if any entry is not a
 * recognized event type, so the caller can respond with a 400.
 */
function parseEventTypes(val: unknown): AuditEventType[] | undefined | null {
  if (!val || typeof val !== 'string') return undefined;
  const parts = val.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return undefined;
  for (const part of parts) {
    if (!AUDIT_EVENT_TYPE_SET.has(part)) return null;
  }
  return parts as AuditEventType[];
}

// ─── Route factory ────────────────────────────────────────────────────────────

export function auditRoutes(
  repo: AuditRepository,
  exporter: AuditExporter,
  log: Logger,
): Router {
  const router = Router();

  /**
   * GET /api/audit
   * Paginated query of the audit stream with optional filters.
   */
  router.get('/audit', async (req: Request, res: Response): Promise<void> => {
    try {
      const limit = parsePositiveIntParam(req.query['limit'], 'limit', 100, 1000);
      const afterId = req.query['afterId'] !== undefined
        ? parseIntParam(req.query['afterId'], 'afterId', 0)
        : undefined;
      const since = req.query['since'] !== undefined
        ? parseIntParam(req.query['since'], 'since', 0)
        : undefined;
      const until = req.query['until'] !== undefined
        ? parseIntParam(req.query['until'], 'until', 0)
        : undefined;

      if (afterId === null || since === null || until === null) {
        res.status(400).json(validationError(
          [{ message: 'afterId, since, and until must be nonnegative' }],
          'Cursor and timestamp parameters must be nonnegative',
        ));
        return;
      }

      if (since !== undefined && until !== undefined && since > until) {
        res.status(400).json(validationError(
          [{ message: 'since must not be later than until' }],
          'Invalid time range: since must not be later than until',
        ));
        return;
      }

      const orderId = typeof req.query['orderId'] === 'string'
        ? req.query['orderId']
        : undefined;
      const eventTypes = parseEventTypes(req.query['eventTypes']);
      if (eventTypes === null) {
        res.status(400).json(validationError(
          [{ message: 'eventTypes contains an unrecognized event type' }],
          'Unknown event type in eventTypes filter',
        ));
        return;
      }
      const includeCount = req.query['count'] === 'true';

      const page = await repo.query({
        orderId,
        eventTypes,
        since,
        until,
        limit,
        cursor: afterId !== undefined ? { afterId } : undefined,
        includeCount,
      });

      res.json({
        entries: page.entries,
        nextCursor: page.nextCursor ? page.nextCursor.afterId : null,
        totalCount: page.totalCount,
      });
    } catch (err) {
      if (err instanceof InvalidQueryParamError) {
        res.status(400).json({ error: 'bad_request', message: err.message });
        return;
      }
      log.error({ err }, 'audit query failed');
      res.status(500).json({ error: 'internal_error', message: 'audit query failed' });
    }
  });

  /**
   * GET /api/audit/orders/:orderId
   * Full event timeline for a specific order, oldest-first.
   */
  router.get('/audit/orders/:orderId', async (req: Request, res: Response): Promise<void> => {
    try {
      const { orderId } = req.params;
      if (!orderId || typeof orderId !== 'string') {
        res.status(400).json({ error: 'bad_request', message: 'orderId is required' });
        return;
      }

      const entries = await exporter.orderTimeline(orderId);

      res.json({
        orderId,
        entries,
        count: entries.length,
      });
    } catch (err) {
      log.error({ err }, 'audit timeline query failed');
      res.status(500).json({ error: 'internal_error', message: 'audit timeline query failed' });
    }
  });

  /**
   * GET /api/audit/orders/:orderId/validate
   * Validate that the stored audit sequence is consistent with the
   * order state machine.  Returns any discrepancies found.
   */
  router.get('/audit/orders/:orderId/validate', async (req: Request, res: Response): Promise<void> => {
    try {
      const { orderId } = req.params;
      if (!orderId || typeof orderId !== 'string') {
        res.status(400).json({ error: 'bad_request', message: 'orderId is required' });
        return;
      }

      const discrepancies = await exporter.validateOrderSequences([orderId]);

      res.json({
        orderId,
        valid: discrepancies.length === 0,
        discrepancies,
      });
    } catch (err) {
      log.error({ err }, 'audit validation failed');
      res.status(500).json({ error: 'internal_error', message: 'audit validation failed' });
    }
  });

  /**
   * GET /api/audit/tail
   * Most recent N audit entries — useful for live monitoring dashboards.
   * Query param: n (default 50, max 500)
   */
  router.get('/audit/tail', async (req: Request, res: Response): Promise<void> => {
    try {
      const n = parsePositiveIntParam(req.query['n'], 'n', 50, 500);
      const entries = await repo.tail(n);
      res.json({ entries, count: entries.length });
    } catch (err) {
      if (err instanceof InvalidQueryParamError) {
        res.status(400).json({ error: 'bad_request', message: err.message });
        return;
      }
      log.error({ err }, 'audit tail query failed');
      res.status(500).json({ error: 'internal_error', message: 'audit tail query failed' });
    }
  });

  /**
   * GET /api/audit/export
   * Stream the audit log as NDJSON (newline-delimited JSON).
   *
   * Each line is a JSON object representing one audit entry with its payload
   * already parsed (not raw JSON string) — the output is self-contained and
   * requires no database connection to consume.
   *
   * The response streams as Transfer-Encoding: chunked so large exports do not
   * buffer in memory.
   *
   * Optional cursor param `afterId` allows incremental exports: save the last
   * id you received, pass it as afterId on the next call to get only new entries.
   */
  router.get('/audit/export', async (req: Request, res: Response): Promise<void> => {
    try {
      const afterId = req.query['afterId'] !== undefined
        ? parseIntParam(req.query['afterId'], 'afterId', 0)
        : undefined;
      const since = req.query['since'] !== undefined
        ? parseIntParam(req.query['since'], 'since', 0)
        : undefined;
      const until = req.query['until'] !== undefined
        ? parseIntParam(req.query['until'], 'until', 0)
        : undefined;

      if (afterId === null || since === null || until === null) {
        res.status(400).json(validationError(
          [{ message: 'afterId, since, and until must be nonnegative' }],
          'Cursor and timestamp parameters must be nonnegative',
        ));
        return;
      }

      if (since !== undefined && until !== undefined && since > until) {
        res.status(400).json(validationError(
          [{ message: 'since must not be later than until' }],
          'Invalid time range: since must not be later than until',
        ));
        return;
      }

      const orderId = typeof req.query['orderId'] === 'string'
        ? req.query['orderId']
        : undefined;
      const eventTypes = parseEventTypes(req.query['eventTypes']);
      const pageSize = parsePositiveIntParam(req.query['pageSize'], 'pageSize', 500, 2000);

      res.setHeader('Content-Type', 'application/x-ndjson');
      res.setHeader('Transfer-Encoding', 'chunked');
      // Tell clients the last cursor id so they can resume.
      // The actual value is sent as a trailing X-Audit-Final-Cursor header
      // once the stream completes.

      const result = await exporter.exportNdjson(res, {
        orderId,
        eventTypes,
        since,
        until,
        pageSize,
        resumeCursor: afterId !== undefined ? { afterId } : undefined,
      });

      // Append a metadata sentinel line at the end of the stream so clients
      // can detect a clean end-of-stream and extract the final cursor without
      // parsing HTTP trailers.
      const sentinel = JSON.stringify({
        _sentinel: true,
        entriesExported: result.entriesProcessed,
        finalCursorId: result.finalCursor?.afterId ?? null,
      }) + '\n';
      res.end(sentinel);

      log.info(
        { entriesExported: result.entriesProcessed, finalCursorId: result.finalCursor?.afterId },
        'audit export completed',
      );
    } catch (err) {
      if (err instanceof InvalidQueryParamError && !res.headersSent) {
        res.status(400).json({ error: 'bad_request', message: err.message });
        return;
      }
      log.error({ err }, 'audit export failed');
      // If headers already sent (partial stream), we can only close the conn.
      if (!res.headersSent) {
        res.status(500).json({ error: 'internal_error', message: 'audit export failed' });
      } else {
        res.end();
      }
    }
  });

  return router;
}
