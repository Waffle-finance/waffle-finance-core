import { Router } from "express";
import { z } from "zod";
import type { Request, Response, NextFunction } from "express";
import type { OrderRow } from "../../persistence/orders-repo.js";
import { announceSchema, OrderService, OrderValidationError } from "../../services/order-service.js";

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

/** Simple in-process rate limiter: max `limit` requests per `windowMs` per IP. */
function makeRateLimiter(windowMs: number, limit: number) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return function rateLimiter(req: Request, res: Response, next: NextFunction): void {
    const ip = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim()
      ?? req.socket.remoteAddress
      ?? "unknown";
    const now = Date.now();
    const entry = hits.get(ip);
    if (!entry || now > entry.resetAt) {
      hits.set(ip, { count: 1, resetAt: now + windowMs });
      return next();
    }
    entry.count += 1;
    if (entry.count > limit) {
      res.status(429).json({ error: "too_many_requests", message: "Rate limit exceeded. Try again shortly." });
      return;
    }
    next();
  };
}

const announceRateLimit = makeRateLimiter(60_000, 20); // 20 announces per IP per minute

export function ordersRoutes(orders: OrderService): Router {
  const router = Router();

  router.post("/orders/announce", announceRateLimit, async (req, res, next) => {
    try {
      const parsed = announceSchema.parse(req.body);
      const order = await orders.announce(parsed);
      res.status(201).json(serialiseOrder(order));
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: "validation_error", details: err.errors });
        return;
      }
      if (err instanceof OrderValidationError) {
        res.status(400).json({ error: "order_validation_error", message: err.message });
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
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.json(serialiseOrder(order));
    } catch (err) {
      next(err);
    }
  });

  router.get("/orders/history", async (req, res, next) => {
    const address = (req.query.address as string | undefined) ?? "";
    if (!address) {
      res.status(400).json({ error: "address_required" });
      return;
    }
    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    const offset = Math.max(Number(req.query.offset ?? 0), 0);
    try {
      const list = await orders.history(address, limit, offset);
      res.json({
        transactions: list.map((o) => serialiseOrder(o)).filter(Boolean),
        pagination: { limit, offset, count: list.length }
      });
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
        res.status(400).json({ error: "validation_error", details: err.errors });
        return;
      }
      if (err instanceof OrderValidationError) {
        res.status(400).json({ error: "order_validation_error", message: err.message });
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
        res.status(400).json({ error: "validation_error", details: err.errors });
        return;
      }
      if (err instanceof OrderValidationError) {
        res.status(400).json({ error: "order_validation_error", message: err.message });
        return;
      }
      next(err);
    }
  });

  return router;
}
