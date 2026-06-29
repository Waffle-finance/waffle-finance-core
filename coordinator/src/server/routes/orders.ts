import { Router } from "express";
import { z } from "zod";
import type { Logger } from "pino";
import type { OrderRow } from "../../persistence/orders-repo.js";
import type { OrderService } from "../../services/order-service.js";
import { OrderValidationError } from "../../services/order-service.js";
import { announceSchema } from "../../validation/announce.js";
import { historyAddressSchema } from "../../validation/address.js";
import { makeRateLimiter, loadApiKeys, loadTrustedProxies } from "../middleware/ratelimit.js";
import { validationError, orderValidationError, notFoundError } from "../errors.js";

function serialiseOrder(order: OrderRow | null) {
  if (!order) return null;
  return {
    id: order.publicId,
    direction: order.direction,
    status: order.status,
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
    updatedAt: order.updatedAt
  };
}

export function ordersRoutes(orders: OrderService, log?: Logger): Router {
  const router = Router();

  const apiKeys = loadApiKeys();
  const trustedProxies = loadTrustedProxies();

  // 20 announces per IP per minute — rate is intentionally conservative so
  // that legitimate resolvers are not impacted during normal operations.
  const announceRateLimit = makeRateLimiter({
    windowMs: 60_000,
    max: 20,
    name: "orders/announce",
    log,
    apiKeys,
    trustedProxies
  });

  router.post("/orders/announce", announceRateLimit, async (req, res, next) => {
    try {
      const parsed = announceSchema.parse(req.body);
      const order = await orders.announce(parsed);
      res.status(201).json(serialiseOrder(order));
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
    const limit = Math.min(Number(req.query.limit ?? 50), 200);

    // Support both cursor-based (preferred) and offset-based (legacy) pagination
    const cursorParam = req.query.cursor as string | undefined;
    const cursor = cursorParam && cursorParam.trim() !== '' ? cursorParam : undefined;
    const offset = req.query.offset !== undefined ? Math.max(Number(req.query.offset), 0) : undefined;

    try {
      // Use cursor pagination if cursor is provided, otherwise use offset (legacy default)
      if (cursor !== undefined) {
        // Cursor-based pagination
        const result = await orders.historyWithCursor(address, limit, cursor);
        res.json({
          transactions: result.orders.map((o) => serialiseOrder(o)).filter(Boolean),
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
          transactions: list.map((o) => serialiseOrder(o)).filter(Boolean),
          pagination: { limit, offset: finalOffset, count: list.length }
        });
      }
    } catch (err) {
      // Handle invalid cursor gracefully
      if (err instanceof Error && err.message.includes('Invalid cursor')) {
        res.status(400).json({
          error: "invalid_cursor", 
          message: "The provided cursor is invalid or expired" 
        });
        return;
      }
      next(err);
    }
  });

  router.get("/orders/:id", async (req, res, next) => {
    const id = req.params.id;
    try {
      const order = await orders.get(id);
      if (!order) {
        res.status(404).json(notFoundError("Order not found"));
        return;
      }
      res.json(serialiseOrder(order));
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

  router.post("/orders/:id/src-locked", async (req, res, next) => {
    try {
      const body = lockSchema.parse(req.body);
      await orders.recordSrcLock({ publicId: req.params.id, ...body });
      res.json({ ok: true });
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

  router.post("/orders/:id/dst-locked", async (req, res, next) => {
    try {
      const body = lockSchema.extend({ resolver: z.string().nullable().optional() }).parse(req.body);
      await orders.recordDstLock({
        publicId: req.params.id,
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
        res.status(400).json(orderValidationError(err.message));
        return;
      }
      next(err);
    }
  });

  return router;
}
