import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Carries the current request ID through the async call chain for a single
 * HTTP request without threading it through every function signature.
 *
 * The request-id middleware calls `requestIdStore.run(id, next)` so every
 * async operation that originates from that request — route handlers, service
 * methods, database calls — will find the same ID when they call
 * `getRequestId()`. The pino logger mixin reads this store at write time so
 * every log line emitted during a request automatically includes `requestId`.
 */
export const requestIdStore = new AsyncLocalStorage<string>();

export function getRequestId(): string | undefined {
  return requestIdStore.getStore();
}
