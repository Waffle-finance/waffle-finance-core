import { AsyncLocalStorage } from "node:async_hooks";

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * The class of operation a request belongs to. Used as a Prometheus label and
 * as a filter in audit log queries — never contains free-form user input.
 */
export type OperationClass =
  | 'order.announce'
  | 'order.lock'
  | 'order.settle'
  | 'order.refund'
  | 'order.query'
  | 'quote.fetch'
  | 'secret.reveal'
  | 'secret.recover'
  | 'admin'
  | 'health'
  | 'unknown';

/**
 * Rich typed context carried through the entire async call chain for a single
 * coordinator HTTP request.
 *
 * Every field is optional (except `requestId`) so the context can be partially
 * populated as a request progresses through middleware and service layers.
 */
export interface RequestContext {
  /** UUID v4 assigned by the request-id middleware. Stable for the request. */
  readonly requestId: string;

  /**
   * Coordinator-assigned public order ID (wf_0x…).
   * Set as soon as the route handler resolves or creates an order.
   */
  orderId: string | null;

  /**
   * Correlation ID that travels across service boundaries.
   * When a relayer or upstream caller supplies one via a header it is forwarded
   * here; otherwise it defaults to `requestId`.
   */
  correlationId: string;

  /**
   * Source chain relevant to this request (e.g. "ethereum", "stellar", "solana").
   * Populated from the announce body or the order row during routing.
   */
  chainContext: string | null;

  /** Coarse classification of the operation for labels and audit filtering. */
  operationClass: OperationClass;

  /**
   * Append a named checkpoint to the in-request audit trail.
   * Each checkpoint is a timestamped string describing a lifecycle moment
   * (e.g. "order_fetched", "state_transition_validated").
   */
  addCheckpoint(name: string): void;

  /** Ordered list of checkpoints recorded so far. */
  readonly checkpoints: ReadonlyArray<{ name: string; at: number }>;
}

// ── Internal store ────────────────────────────────────────────────────────────

/**
 * The AsyncLocalStorage backing the rich context. Typed as `RequestContext`
 * so all read paths get the full contract.
 *
 * The legacy `requestIdStore` export is preserved for backward compat — it
 * re-reads from `_contextStore` so both APIs stay in sync without two stores.
 */
const _contextStore = new AsyncLocalStorage<RequestContext>();

// ── Legacy compat shim ────────────────────────────────────────────────────────

/**
 * @deprecated Prefer `getRequestContext()`. This shim keeps the pino mixin and
 * existing callers working while they migrate to the richer API.
 *
 * Backed by the same AsyncLocalStorage as `_contextStore` — a middleware that
 * calls `runWithContext()` satisfies both `getRequestId()` and
 * `getRequestContext()` without two separate `run()` calls.
 */
export const requestIdStore = {
  getStore(): string | undefined {
    return _contextStore.getStore()?.requestId;
  },
} as unknown as AsyncLocalStorage<string>;

// ── Public API ────────────────────────────────────────────────────────────────

/** Return the current request context, or undefined outside a request scope. */
export function getRequestContext(): RequestContext | undefined {
  return _contextStore.getStore();
}

/** Return the request ID from the current context, or undefined outside a request scope. */
export function getRequestId(): string | undefined {
  return _contextStore.getStore()?.requestId;
}

/** Return the order ID from the current context, or undefined outside a scope or before set. */
export function getOrderId(): string | undefined {
  return _contextStore.getStore()?.orderId ?? undefined;
}

/** Return the correlation ID from the current context, or undefined outside a request scope. */
export function getCorrelationId(): string | undefined {
  return _contextStore.getStore()?.correlationId ?? undefined;
}

/**
 * Set the order ID on the current request context.
 * No-op when called outside a runWithContext scope.
 */
export function setOrderId(orderId: string): void {
  const store = _contextStore.getStore();
  if (store) {
    store.orderId = orderId;
  }
}

/**
 * Set the correlation ID on the current request context.
 * No-op when called outside a runWithContext scope.
 */
export function setCorrelationId(correlationId: string): void {
  const store = _contextStore.getStore();
  if (store) {
    store.correlationId = correlationId;
  }
}

/**
 * Run `fn` inside a new request context scope.
 *
 * Call this from the request-id middleware instead of the old
 * `requestIdStore.run(id, next)`. All downstream code — route handlers,
 * services, database calls — will see the same `RequestContext` via
 * `getRequestContext()` / `getRequestId()`.
 */
export function runWithContext<T>(
  initial: Pick<RequestContext, 'requestId'> & Partial<Omit<RequestContext, 'requestId' | 'addCheckpoint' | 'checkpoints'>>,
  fn: () => T
): T {
  const checkpoints: Array<{ name: string; at: number }> = [];

  const ctx: RequestContext = {
    requestId: initial.requestId,
    orderId: initial.orderId ?? null,
    correlationId: initial.correlationId ?? initial.requestId,
    chainContext: initial.chainContext ?? null,
    operationClass: initial.operationClass ?? 'unknown',
    checkpoints,
    addCheckpoint(name: string): void {
      checkpoints.push({ name, at: Date.now() });
    },
  };

  return _contextStore.run(ctx, fn);
}
