import { randomUUID } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { requestIdStore } from "../../request-context.js";

export const REQUEST_ID_HEADER = "x-request-id";

/**
 * Express middleware that assigns a correlation ID to every inbound request.
 *
 * Behaviour:
 *  - If the caller supplies a non-empty `X-Request-ID` header (up to 128
 *    chars) it is accepted as-is so upstream load balancers and API gateways
 *    can propagate their own trace IDs.
 *  - Otherwise a new UUID v4 is generated.
 *
 * The ID is:
 *  1. Written back on the response as `X-Request-ID` so clients can correlate
 *     their request with coordinator log entries.
 *  2. Stored in `res.locals.requestId` for downstream handlers.
 *  3. Bound into the Node AsyncLocalStorage store so that the pino logger
 *     mixin can inject `requestId` into every log line emitted during the
 *     lifetime of the request — including those produced by OrderService and
 *     SecretService — without any change to their call signatures.
 */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.headers[REQUEST_ID_HEADER];
  const id =
    typeof incoming === "string" && incoming.length > 0 && incoming.length <= 128
      ? incoming
      : randomUUID();

  res.locals["requestId"] = id;
  res.setHeader(REQUEST_ID_HEADER, id);

  requestIdStore.run(id, next);
}
