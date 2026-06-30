import pino, { type Logger } from "pino";
import { getRequestId } from "./request-context.js";

let cached: Logger | null = null;

export function getLogger(level: string = "info"): Logger {
  if (!cached) {
    cached = pino({
      level,
      base: { service: "wafflefinance-coordinator" },
      // Inject the active request ID into every log line at write time.
      // Because the request-id middleware wraps each request in an
      // AsyncLocalStorage context, this picks up the correct ID even for
      // log calls deep inside service and repository methods.
      mixin() {
        const requestId = getRequestId();
        return requestId ? { requestId } : {};
      }
    });
  }
  return cached;
}
