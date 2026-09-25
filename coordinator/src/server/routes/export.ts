/**
 * Order lifecycle export routes.
 *
 * Provides HTTP endpoints for exporting order lifecycle data in a structured,
 * compliance-friendly format. Intended for:
 *  - Auditors reviewing order histories
 *  - Incident responders investigating failures
 *  - Operators analyzing completion rates and failure modes
 *
 * Security: these routes should be gated behind authentication in production.
 * Exported data includes sensitive order details (addresses, amounts, etc.).
 */

import { Router } from "express";
import { z } from "zod";
import type { Logger } from "pino";
import type { OrderExportService, OrderLifecycleExport } from "../../services/order-export.js";
import { validationError, notFoundError } from "../errors.js";

/** Supported download formats for the user-facing export endpoint. */
export type ExportFormat = "json" | "csv";

/** CSV column headers — must match `lifecycleToCsvRow` field order exactly. */
const CSV_HEADERS = [
  "orderId",
  "direction",
  "sourceChain",
  "destChain",
  "sourceAmount",
  "destAmount",
  "sourceAsset",
  "destAsset",
  "timestamp",
  "status",
  "beneficiary",
  "refundAddress",
  "claimedAt",
  "refundedAt",
  "schemaVersion",
] as const;

/** Schema version tag embedded in every exported row for forward compatibility. */
const EXPORT_SCHEMA_VERSION = "1";

/**
 * Convert a lifecycle export entry to a flat CSV row aligned with
 * CSV_HEADERS.  Missing values are represented as empty strings so the
 * column count stays constant for every row.
 */
function lifecycleToCsvRow(entry: OrderLifecycleExport): string {
  const isEthSrc = entry.direction.startsWith("eth");

  // `beneficiary` = destination address (the wallet receiving the swap output)
  const beneficiary = entry.dstChain.address;
  // `refundAddress` = source address (gets funds back on timeout)
  const refundAddress = entry.srcChain.address;

  // Derive claimed/refunded timestamps from lifecycle events
  let claimedAt = "";
  let refundedAt = "";
  for (const ev of entry.events) {
    if (
      (ev.type === "secret_revealed.transitioned" || ev.type === "status.transitioned") &&
      (ev.payload["toStatus"] === "secret_revealed" || ev.payload["toStatus"] === "completed")
    ) {
      if (!claimedAt) claimedAt = String(ev.timestamp);
    }
    if (
      (ev.type === "status.transitioned" && ev.payload["toStatus"] === "refunded") ||
      ev.type === "refund.confirmed"
    ) {
      if (!refundedAt) refundedAt = String(ev.timestamp);
    }
  }

  const cells = [
    entry.orderId,
    entry.direction,
    isEthSrc ? entry.srcChain.chain : entry.dstChain.chain,
    isEthSrc ? entry.dstChain.chain : entry.srcChain.chain,
    entry.srcChain.amount,
    entry.dstChain.amount,
    entry.srcChain.asset,
    entry.dstChain.asset,
    String(entry.timestamps.createdAt),
    entry.status,
    beneficiary,
    refundAddress,
    claimedAt,
    refundedAt,
    EXPORT_SCHEMA_VERSION,
  ];

  return cells.map(escapeCsvCell).join(",");
}

/** Wrap a cell value in quotes if it contains commas, quotes, or newlines. */
function escapeCsvCell(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Build a complete CSV string from a list of lifecycle exports.
 * The first row is the header; subsequent rows are data rows.
 */
function buildCsv(lifecycles: OrderLifecycleExport[]): string {
  const lines: string[] = [CSV_HEADERS.join(",")];
  for (const entry of lifecycles) {
    lines.push(lifecycleToCsvRow(entry));
  }
  return lines.join("\n");
}

/** Validation schema for single-order export requests. */
const exportOrderSchema = z.object({
  orderId: z.string().min(1, "Order ID is required"),
});

/** Validation schema for bulk export filter requests. */
const exportFiltersSchema = z.object({
  orderIds: z.array(z.string()).optional(),
  status: z.enum([
    "announced",
    "src_locked",
    "dst_locked",
    "secret_revealed",
    "completed",
    "refunded",
    "failed",
    "expired",
  ]).optional(),
  srcChain: z.enum(["ethereum", "stellar", "solana"]).optional(),
  dstChain: z.enum(["ethereum", "stellar", "solana"]).optional(),
  createdAfter: z.coerce.number().int().nonnegative().optional(),
  createdBefore: z.coerce.number().int().nonnegative().optional(),
  updatedAfter: z.coerce.number().int().nonnegative().optional(),
  updatedBefore: z.coerce.number().int().nonnegative().optional(),
  includeArchived: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().positive().max(1000).optional(),
}).refine(
  (data) => data.createdAfter === undefined || data.createdBefore === undefined || data.createdAfter <= data.createdBefore,
  {
    message: "createdAfter must not be later than createdBefore",
    path: ["createdBefore"],
  }
);

/**
 * Validation schema for the user-facing download endpoint.
 *
 * Accepts human-friendly ISO-date strings for startDate/endDate and converts
 * them to unix-second integers so they can be passed straight to
 * `exportOrders`.  The `format` param drives whether the response is JSON
 * or a CSV attachment.
 */
const downloadQuerySchema = z.object({
  format: z.enum(["json", "csv"]).default("json"),
  /** ISO date string or unix seconds.  "all" is accepted and means no lower bound. */
  startDate: z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (!v || v === "all") return undefined;
      const ts = Number.isFinite(Number(v)) ? Number(v) : Math.floor(new Date(v).getTime() / 1000);
      if (!Number.isFinite(ts)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Invalid startDate: "${v}" is not a valid date or unix timestamp` });
        return z.NEVER;
      }
      return ts;
    }),
  endDate: z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (!v || v === "all") return undefined;
      const ts = Number.isFinite(Number(v)) ? Number(v) : Math.floor(new Date(v).getTime() / 1000);
      if (!Number.isFinite(ts)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Invalid endDate: "${v}" is not a valid date or unix timestamp` });
        return z.NEVER;
      }
      return ts;
    }),
  status: z
    .enum([
      "announced",
      "src_locked",
      "dst_locked",
      "secret_revealed",
      "completed",
      "refunded",
      "failed",
      "expired",
      "all",
    ])
    .optional(),
  /** Comma-separated list of order IDs — passed straight through to exportOrders */
  orderIds: z
    .string()
    .optional()
    .transform((v) =>
      v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined
    ),
  limit: z.coerce.number().int().positive().max(1000).optional(),
  /** Optional address to scope the download to a specific wallet */
  address: z.string().optional(),
}).refine(
  (data) => data.startDate === undefined || data.endDate === undefined || data.startDate <= data.endDate,
  {
    message: "startDate must not be later than endDate",
    path: ["endDate"],
  }
);

/**
 * Create the export router with the given export service.
 *
 * @param exportService - Order export service instance
 * @param log - Optional logger for request logging
 * @returns Express router with export routes
 */
export function exportRoutes(exportService: OrderExportService, log?: Logger): Router {
  const router = Router();

  /**
   * GET /export/orders/:orderId
   *
   * Export a single order's full lifecycle.
   *
   * Response: OrderLifecycleExport (see order-export.ts)
   * Status: 200 OK | 400 Bad Request | 404 Not Found
   */
  router.get("/export/orders/:orderId", async (req, res, next) => {
    try {
      const { orderId } = exportOrderSchema.parse(req.params);

      const lifecycle = await exportService.exportOrder(orderId);

      if (!lifecycle) {
        res.status(404).json(notFoundError(`Order ${orderId} not found`));
        return;
      }

      log?.info({ orderId }, "Order lifecycle export generated");
      res.json(lifecycle);
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json(validationError(err.errors));
        return;
      }
      next(err);
    }
  });

  /**
   * POST /export/orders
   *
   * Bulk export: export multiple orders matching the given filters.
   *
   * Request body: OrderExportFilters (see order-export.ts)
   * Response: OrderExportResult
   * Status: 200 OK | 400 Bad Request
   */
  router.post("/export/orders", async (req, res, next) => {
    try {
      const filters = exportFiltersSchema.parse(req.body);

      const result = await exportService.exportOrders(filters);

      log?.info(
        { count: result.orders.length, filters },
        "Bulk order export generated"
      );
      res.json(result);
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json(validationError(err.errors));
        return;
      }
      next(err);
    }
  });

  /**
   * GET /orders/export
   *
   * User-facing download endpoint consumed by the frontend OrderExport component.
   *
   * Query parameters:
   *  - format    (csv | json, default: json)
   *  - startDate (ISO string or unix seconds — lower bound on createdAt)
   *  - endDate   (ISO string or unix seconds — upper bound on createdAt)
   *  - status    (order status filter; "all" or omit for no filter)
   *  - orderIds  (comma-separated list of order IDs)
   *  - address   (wallet address — passed as orderIds scope in a real implementation)
   *  - limit     (max rows, default 100)
   *
   * Response:
   *  - JSON: OrderExportResult body with Content-Disposition: attachment
   *  - CSV:  plain-text CSV with Content-Disposition: attachment
   *
   * Status: 200 OK | 400 Bad Request
   */
  router.get("/orders/export", async (req, res, next) => {
    try {
      const query = downloadQuerySchema.parse(req.query);
      const { format, startDate, endDate, status, orderIds, limit } = query;

      // Build filters for the export service
      const filters = {
        orderIds: orderIds && orderIds.length > 0 ? orderIds : undefined,
        status: status && status !== "all" ? (status as Exclude<typeof status, "all">) : undefined,
        createdAfter: startDate,
        createdBefore: endDate,
        limit: limit ?? 500,
      };

      const result = await exportService.exportOrders(filters);

      // Build a timestamped filename: orders-2026-08-16.csv / .json
      const dateTag = new Date().toISOString().slice(0, 10);
      const filename = `orders-${dateTag}.${format}`;

      log?.info(
        { count: result.orders.length, format, filters },
        "User-facing order export download generated"
      );

      if (format === "csv") {
        const csv = buildCsv(result.orders);
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
        res.setHeader("X-Export-Schema-Version", EXPORT_SCHEMA_VERSION);
        res.send(csv);
        return;
      }

      // JSON format
      const payload = {
        schemaVersion: EXPORT_SCHEMA_VERSION,
        generatedAt: new Date().toISOString(),
        totalCount: result.totalCount,
        orders: result.orders,
      };
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.setHeader("X-Export-Schema-Version", EXPORT_SCHEMA_VERSION);
      res.json(payload);
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json(validationError(err.errors));
        return;
      }
      next(err);
    }
  });

  return router;
}
