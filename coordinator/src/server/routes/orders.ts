import { Router } from "express";
import { z } from "zod";
import type { Logger } from "pino";
import type { OrderRow } from "../../persistence/orders-repo.js";
import type { OrderService } from "../../services/order-service.js";
import { OrderValidationError } from "../../services/order-service.js";
import { announceSchema } from "../../validation/announce.js";
import { historyAddressSchema, orderIdSchema } from "../../validation/address.js";
import { makeRateLimiter, loadApiKeys, loadTrustedProxies } from "../middleware/ratelimit.js";
import { requireRole, loadOperatorKeys } from "../middleware/auth.js";
import type { AbuseDetector } from "../middleware/abuse-detection.js";
import { validationError, orderValidationError, conflictError, notFoundError, invalidCursorError } from "../errors.js";
import { getRequestId } from "../../request-context.js";

/// Strictly parse a query-string integer parameter. Returns `undefined` when
/// `raw` is omitted so the caller can fall back to a default, but rejects any
/// value that isn't a plain finite integer — `NaN`, decimals, and text with a
/// numeric prefix/suffix ("12junk") all fail rather than silently coercing
/// (e.g. via `Number(...)`) into `NaN` or a truncated value that could reach
/// persistence.
function parseStrictQueryInt(raw: unknown): number | undefined | null {
  if (raw === undefined) return undefined;
  const str = Array.isArray(raw) ? raw[0] : raw;
  if (typeof str !== "string" || str.trim() === "") return undefined;
  if (!/^-?\d+$/.test(str.trim())) return null;
  const n = Number(str.trim());
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  return n;
}

function serialiseOrder(order: OrderRow | null, requestId?: string | null) {
  if (!order) return null;
  // `isRefundable` reflects whether the user can still call refund on-chain:
  //   - expired:    timelock elapsed, on-chain refund not yet confirmed
  //   - src_locked: src funds locked but resolver hasn't filled yet
  //   - dst_locked: both sides locked, can be unwound if secret not revealed
  //   - failed:     terminal, but src funds may still be locked on-chain if
  //                 the failure was detected before the lock expired — flag
  //                 so UIs can surface a refund option when srcLockTx is set.
  const isRefundable =
    order.status === "expired" ||
    order.status === "src_locked" ||
    order.status === "dst_locked" ||
    (order.status === "failed" && order.srcLockTx !== null);

  return {
    id: order.publicId,
    direction: order.direction,
    status: order.status,
    isRefundable,
    hashlock: order.hashlock,
    src: {
      chain: order.srcChain,
      address: order.srcAddress,
      asset: order.srcAsset,
      amount: order.srcAmount,
      safetyDeposit: order.srcSafetyDeposit,
      orderId: order.srcOrderId,
      lockTx: order.srcLockTx,
      lockBlock: order.srcLockBlock,
      timelock: order.srcTimelock
    },
    dst: {
      chain: order.dstChain,
      address: order.dstAddress,
      asset: order.dstAsset,
      amount: order.dstAmount,
      orderId: order.dstOrderId,
      lockTx: order.dstLockTx,
      lockBlock: order.dstLockBlock,
      timelock: order.dstTimelock
    },
    secret: {
      revealed: order.preimage !== null,
      preimage: order.preimage,
      revealedTx: order.secretRevealedTx
    },
    resolver: order.resolverAddress,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    // Operational metadata — correlates this response to server-side logs.
    meta: {
      requestId: requestId ?? null,
      serverTime: Math.floor(Date.now() / 1000),
    },
  };
}

export function ordersRoutes(orders: OrderService, log?: Logger, abuseDetector?: AbuseDetector): Router {
  const router = Router();

  const apiKeys = loadApiKeys();
  const trustedProxies = loadTrustedProxies();
  const operatorKeys = loadOperatorKeys();

  // 20 announces per IP per minute — rate is intentionally conservative so
  // that legitimate resolvers are not impacted during normal operations.
  const announceRateLimit = makeRateLimiter({
    windowMs: 60_000,
    max: 20,
    name: "orders/announce",
    log,
    apiKeys,
    trustedProxies,
    abuseDetector
  });

  router.post("/orders/announce", announceRateLimit, async (req, res, next) => {
    try {
      const parsed = announceSchema.parse(req.body);
      const order = await orders.announce(parsed);
      res.status(201).json(serialiseOrder(order, getRequestId()));
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json(validationError(err.errors));
        return;
      }
      if (err instanceof OrderValidationError) {
        res.status(400).json(orderValidationError(err.message));
        return;
      }
      next(err);
    }
  });

  // NOTE: the literal /orders/history route must be registered before the
  // /orders/:id param route, otherwise Express matches "history" as an :id.
  router.get("/orders/history", async (req, res, next) => {
    const parsedAddress = historyAddressSchema.safeParse(req.query.address);
    if (!parsedAddress.success) {
      res.status(400).json(validationError(parsedAddress.error.errors));
      return;
    }
    const address = parsedAddress.data;

    const rawLimit = parseStrictQueryInt(req.query.limit);
    if (rawLimit === null) {
      res.status(400).json(validationError([], "limit must be a valid integer"));
      return;
    }
    const limit = rawLimit !== undefined ? Math.min(Math.max(rawLimit, 1), 200) : 50;

    // Support both cursor-based (preferred) and offset-based (legacy) pagination
    const cursorParam = req.query.cursor as string | undefined;
    const cursor = cursorParam && cursorParam.trim() !== '' ? cursorParam : undefined;
    if (cursor !== undefined) {
      const cursorNum = Number(cursor);
      if (Number.isFinite(cursorNum) && cursorNum < 0) {
        res.status(400).json(invalidCursorError());
        return;
      }
    }
    const offset = req.query.offset !== undefined ? Math.max(Number(req.query.offset), 0) : undefined;

    try {
      // Use cursor pagination if cursor is provided, otherwise use offset (legacy default)
      if (cursor !== undefined) {
        // Cursor-based pagination
        const result = await orders.historyWithCursor(address, limit, cursor);
        res.json({
          orders: result.orders.map((o) => serialiseOrder(o, getRequestId())).filter(Boolean),
          pagination: {
            limit,
            count: result.orders.length,
            nextCursor: result.nextCursor
          }
        });
      } else {
        // Offset-based pagination (default for backward compatibility)
        const finalOffset = offset ?? 0;
        const list = await orders.history(address, limit, finalOffset);
        res.json({
          orders: list.map((o) => serialiseOrder(o, getRequestId())).filter(Boolean),
          pagination: { limit, offset: finalOffset, count: list.length }
        });
      }
    } catch (err) {
      // Handle invalid cursor gracefully
      if (err instanceof Error && err.message.includes('Invalid cursor')) {
        res.status(400).json(invalidCursorError());
        return;
      }
      next(err);
    }
  });

  router.get("/orders/:id", async (req, res, next) => {
    const idResult = orderIdSchema.safeParse(req.params.id);
    if (!idResult.success) {
      res.status(400).json(validationError(idResult.error.errors));
      return;
    }
    const id = idResult.data;
    try {
      const order = await orders.get(id);
      if (!order) {
        res.status(404).json(notFoundError("Order not found"));
        return;
      }
      res.json(serialiseOrder(order, getRequestId()));
    } catch (err) {
      next(err);
    }
  });

  const lockSchema = z.object({
    orderId: z.string().min(1),
    txHash: z.string().min(1),
    blockNumber: z.coerce.number().int().nonnegative(),
    timelock: z.coerce.number().int().nonnegative()
  });

  router.post(
    "/orders/:id/src-locked",
    requireRole("operator", { operatorKeys, log, trustedProxies }),
    async (req, res, next) => {
      const idResult = orderIdSchema.safeParse(req.params.id);
      if (!idResult.success) {
        res.status(400).json(validationError(idResult.error.errors));
        return;
      }
      try {
        const body = lockSchema.parse(req.body);
        await orders.recordSrcLock({ publicId: idResult.data, actor: "operator_http", ...body });
        res.json({ ok: true });
      } catch (err) {
        if (err instanceof z.ZodError) {
          res.status(400).json(validationError(err.errors));
          return;
        }
        if (err instanceof OrderValidationError) {
          // Concurrent write conflicts (two listeners racing on the same lock)
          // are semantically different from bad input — return 409 so clients
          // can distinguish and retry with a fresh order fetch (#745).
          if (err.message.startsWith("conflicting")) {
            res.status(409).json(conflictError(err.message));
            return;
          }
          res.status(400).json(orderValidationError(err.message));
          return;
        }
        next(err);
      }
    }
  );

  router.post(
    "/orders/:id/dst-locked",
    requireRole("operator", { operatorKeys, log, trustedProxies }),
    async (req, res, next) => {
      const idResult = orderIdSchema.safeParse(req.params.id);
      if (!idResult.success) {
        res.status(400).json(validationError(idResult.error.errors));
        return;
      }
      try {
        const body = lockSchema.extend({ resolver: z.string().nullable().optional() }).parse(req.body);
        await orders.recordDstLock({
          publicId: idResult.data,
          actor: "operator_http",
          orderId: body.orderId,
          txHash: body.txHash,
          blockNumber: body.blockNumber,
          timelock: body.timelock,
          resolver: body.resolver ?? null
        });
        res.json({ ok: true });
      } catch (err) {
        if (err instanceof z.ZodError) {
          res.status(400).json(validationError(err.errors));
          return;
        }
        if (err instanceof OrderValidationError) {
          if (err.message.startsWith("conflicting")) {
            res.status(409).json(conflictError(err.message));
            return;
          }
          res.status(400).json(orderValidationError(err.message));
          return;
        }
        next(err);
      }
    }
  );

  return router;
}