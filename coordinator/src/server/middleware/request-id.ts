import { randomUUID } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { runWithContext, type OperationClass } from "../../request-context.js";

export const REQUEST_ID_HEADER = "x-request-id";
export const CORRELATION_ID_HEADER = "x-correlation-id";

/**
 * Maximum accepted byte length for an incoming request/correlation ID.
 * Values exceeding this are replaced with a freshly generated UUID.
 */
export const REQUEST_ID_MAX_LENGTH = 128;

/**
 * Allowed character set for incoming request/correlation IDs.
 *
 * Accepts alphanumerics, hyphens, underscores, and dots — the characters
 * used by UUID v4, OpenTelemetry trace IDs, and common APM platforms.
 * Control characters, whitespace, and other special characters are rejected
 * to prevent log injection, header pollution, and tracing label corruption.
 */
const SAFE_ID_RE = /^[A-Za-z0-9\-_.]+$/;

/**
 * Return `true` when `value` is a safe, bounded request/correlation ID
 * that can be forwarded to logs, response headers, and tracing labels.
 *
 * Exported for unit testing.
 */
export function isSafeId(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= REQUEST_ID_MAX_LENGTH &&
    SAFE_ID_RE.test(value)
  );
}

/** Infer a coarse operation class from the request path and method. */
function inferOperationClass(req: Request): OperationClass {
  const path = req.path;
  const method = req.method.toUpperCase();

  if (path === '/healthz' || path === '/readyz') return 'health';
  if (path.startsWith('/metrics')) return 'health';
  if (path.startsWith('/admin')) return 'admin';

  if (path.startsWith('/api/orders')) {
    if (path.endsWith('/announce') && method === 'POST') return 'order.announce';
    if (path.includes('/lock')) return 'order.lock';
    if (method === 'GET') return 'order.query';
  }

  if (path.startsWith('/api/quotes')) return 'quote.fetch';
  if (path.startsWith('/api/secrets')) {
    if (path.includes('/reveal')) return 'secret.reveal';
    return 'secret.recover';
  }

  return 'unknown';
}

/**
 * Express middleware that assigns a rich typed request context to every
 * inbound request via AsyncLocalStorage.
 *
 * Behaviour:
 *  - If the caller supplies a non-empty `X-Request-ID` header (up to 128
 *    chars) it is accepted as-is so upstream load balancers and API gateways
 *    can propagate their own trace IDs. Otherwise a new UUID v4 is generated.
 *  - An optional `X-Correlation-ID` header carries a cross-service correlation
 *    anchor (coordinator ↔ relayer). When absent it defaults to requestId.
 *  - The full `RequestContext` (requestId, correlationId, operationClass, …)
 *    is available via `getRequestContext()` from any downstream async operation
 *    without threading it through function signatures.
 *
 * The request ID is:
 *  1. Written back on the response as `X-Request-ID`.
 *  2. Stored in `res.locals.requestId` for downstream handlers.
 *  3. Accessible via the legacy `getRequestId()` shim (backward compat).
 */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.headers[REQUEST_ID_HEADER];
  const requestId =
    typeof incoming === "string" && isSafeId(incoming)
      ? incoming
      : randomUUID();

  const incomingCorrelation = req.headers[CORRELATION_ID_HEADER];
  const correlationId =
    typeof incomingCorrelation === "string" && isSafeId(incomingCorrelation)
      ? incomingCorrelation
      : requestId;

  res.locals["requestId"] = requestId;
  res.setHeader(REQUEST_ID_HEADER, requestId);

  runWithContext(
    {
      requestId,
      correlationId,
      operationClass: inferOperationClass(req),
    },
    next
  );
}
