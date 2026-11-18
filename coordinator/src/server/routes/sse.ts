/**
 * SSE route: GET /api/orders/:id/events
 *
 * Returns a text/event-stream response that pushes order state transitions to
 * the connected client in real time. The connection stays open until:
 *   - The client disconnects
 *   - The order reaches a terminal status (completed / refunded / failed)
 *   - The coordinator receives SIGTERM (shutdown frame sent before close)
 */

import { Router, type Request, type Response } from "express";
import type { Logger } from "pino";
import { z } from "zod";
import type { OrderService } from "../../services/order-service.js";
import { orderIdSchema } from "../../validation/address.js";
import { SSE_CONNECTED_FRAME, buildReplayGapPayload } from "../../sse/event-builders.js";
import type { SseBroker } from "../../sse/sse-broker.js";
import { MAX_SUBSCRIBERS } from "../../sse/sse-broker.js";
import { validationError, notFoundError } from "../errors.js";

export function sseRoutes(
  orders: OrderService,
  broker: SseBroker,
  log?: Logger,
): Router {
  const router = Router();

  router.get("/orders/:id/events", async (req: Request, res: Response) => {
    // 1. Validate order id
    const idResult = orderIdSchema.safeParse(req.params.id);
    if (!idResult.success) {
      res.status(400).json(validationError(idResult.error.errors));
      return;
    }
    const orderId = idResult.data;

    // 2. Ensure order exists before upgrading to stream
    let order;
    try {
      order = await orders.get(orderId);
    } catch (err) {
      log?.warn({ err, orderId }, "SSE route: failed to fetch order");
      res.status(500).json({ error: "internal_error", message: "Failed to fetch order" });
      return;
    }

    if (!order) {
      res.status(404).json(notFoundError("Order not found"));
      return;
    }

    // 3. Subscriber cap
    if (broker.subscriberCount >= MAX_SUBSCRIBERS) {
      res.status(503)
        .set("X-WF-Error", "subscriber-limit")
        .json({ error: "service_unavailable", message: "SSE subscriber limit reached" });
      return;
    }

    // 4. Set SSE response headers
    res.status(200).set({
      "Content-Type":    "text/event-stream",
      "Cache-Control":   "no-cache",
      "Connection":      "keep-alive",
      "X-Accel-Buffering": "no",
    });

    // Flush headers immediately so the client knows the stream is open
    if (typeof (res as any).flushHeaders === "function") {
      (res as any).flushHeaders();
    }

    // 5. Parse Last-Event-ID header for reconnect replay
    const lastEventIdRaw = req.headers["last-event-id"];
    const lastEventId =
      typeof lastEventIdRaw === "string" && lastEventIdRaw.trim() !== ""
        ? parseInt(lastEventIdRaw, 10)
        : undefined;

    // 6. Register subscriber — replay is handled inside subscribe()
    const cleanup = broker.subscribe(orderId, res, lastEventId);

    if (cleanup === false) {
      // Race condition: cap was hit between our check and subscribe()
      res.status(503)
        .set("X-WF-Error", "subscriber-limit")
        .end();
      return;
    }

    req.once("aborted", cleanup);
    res.once("close", () => req.removeListener("aborted", cleanup));
    if (req.aborted) {
      cleanup();
      return;
    }

    // 7. Send connected comment so the client knows the stream is live
    res.write(SSE_CONNECTED_FRAME);

    log?.debug({ orderId, lastEventId }, "SSE subscriber connected");
  });

  return router;
}
