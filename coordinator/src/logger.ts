import pino, { type Logger } from "pino";
import { getRequestContext, getRequestId } from "./request-context.js";
import {
  sensitiveSerializers,
  SENSITIVE_FIELD_NAMES,
  REDACTED_PLACEHOLDER,
} from "./sensitive/sensitive-fields.js";

/**
 * Mixin that extracts correlation identifiers (requestId, correlationId, orderId)
 * from the active AsyncLocalStorage request context at log-write time.
 */
export function correlationMixin(): Record<string, unknown> {
  const ctx = getRequestContext();
  if (ctx) {
    const fields: Record<string, unknown> = {
      requestId: ctx.requestId,
      correlationId: ctx.correlationId,
    };
    if (ctx.orderId) {
      fields.orderId = ctx.orderId;
    }
    return fields;
  }
  const requestId = getRequestId();
  return requestId ? { requestId } : {};
}

let cached: Logger | null = null;

export function getLogger(level: string = "info"): Logger {
  if (!cached) {
    cached = pino({
      level,
      base: { service: "wafflefinance-coordinator" },
      mixin: correlationMixin,
      serializers: sensitiveSerializers(),
      redact: {
        paths: [
          ...SENSITIVE_FIELD_NAMES,
          "*.preimage",
          "*.secret",
          "*.privateKey",
          "*.secretKey",
        ],
        censor: REDACTED_PLACEHOLDER,
      },
    });
  }
  return cached;
}

export function resetLoggerForTesting(): void {
  cached = null;
}
