/**
 * Explicit authorization matrix for every mounted coordinator HTTP route.
 *
 * `public`        — anonymous read/write allowed (rate limited where sensitive).
 * `user`          — caller-facing route; no operator key, but always rate limited.
 * `operator`      — requires `Authorization: Bearer <COORDINATOR_OPERATOR_KEYS>`.
 *
 * Any route mounted on the Express app without an entry here fails startup via
 * `assertRouteAuthorizationCoverage`, so a newly added route cannot silently
 * inherit a weaker policy.
 */

export type RoutePrincipal = "public" | "user" | "operator";

export interface AuthorizationPolicyEntry {
  /** "METHOD /canonical/path" — Express parameter syntax is preserved. */
  route: string;
  principal: RoutePrincipal;
  /** Why this exposure is intentional; used in failure messages and docs. */
  exposure: string;
}

const policy = (route: string, principal: RoutePrincipal, exposure: string): AuthorizationPolicyEntry => ({
  route,
  principal,
  exposure
});

/** Authoritative matrix of mounted coordinator endpoints. */
export const ROUTE_AUTHORIZATION_MATRIX: readonly AuthorizationPolicyEntry[] = [
  // Health / readiness / operator metrics.
  policy("GET /health", "public", "liveness probe, no sensitive data"),
  policy("GET /healthz", "public", "liveness probe, no sensitive data"),
  policy("GET /readyz", "public", "readiness probe, no sensitive data"),
  policy("GET /metrics", "operator", "Prometheus registry may expose operational data"),

  // User-facing order and secret workflows (rate limited, no raw audit data).
  policy("POST /api/orders/announce", "user", "intentional public order entry point"),
  policy("GET /api/orders/history", "user", "caller-supplied address history"),
  policy("GET /api/orders/:id", "user", "order status, redacted by service"),
  policy("GET /api/orders/:id/events", "user", "SSE stream of redacted status events"),
  policy("POST /api/secrets/reveal", "user", "resolver/user preimage submission"),
  policy("GET /api/secrets/:publicId", "user", "caller-facing secret retrieval"),
  policy("GET /api/quotes/eth-xlm", "public", "public price quote"),
  policy("GET /api/quotes/eth-sol", "public", "public price quote"),
  policy("GET /api/prices", "public", "public aggregated prices"),

  // Audit reads are redacted; the full NDJSON audit export is operator-only.
  policy("GET /api/audit", "public", "paginated redacted audit view"),
  policy("GET /api/audit/orders/:orderId", "public", "redacted order timeline"),
  policy("GET /api/audit/orders/:orderId/timeline", "public", "redacted order timeline"),
  policy("GET /api/audit/orders/:orderId/validate", "public", "sequence validation result"),
  policy("GET /api/audit/tail", "public", "redacted recent audit entries"),
  policy("GET /api/audit/export", "operator", "full audit stream export"),

  // Operator-only order export and maintenance endpoints.
  policy("GET /api/export/orders/:orderId", "operator", "full order export"),
  policy("POST /api/export/orders", "operator", "bulk order export"),
  policy("GET /api/orders/export", "operator", "bulk order export"),
  policy("POST /api/orders/:id/src-locked", "operator", "mutates order state"),
  policy("POST /api/orders/:id/dst-locked", "operator", "mutates order state"),
  policy("POST /admin/reconcile", "operator", "maintenance trigger"),
  policy("POST /admin/stale-cleanup", "operator", "maintenance trigger"),
  policy("POST /admin/expire-now", "operator", "maintenance trigger"),
  policy("GET /admin/reconciliation-cursors", "operator", "internal operator state")
];

const BY_ROUTE = new Map(
  ROUTE_AUTHORIZATION_MATRIX.map((entry) => [entry.route, entry])
);

export function policyForRoute(method: string, path: string): AuthorizationPolicyEntry | undefined {
  return BY_ROUTE.get(`${method.toUpperCase()} ${path}`);
}

interface RouterLayer {
  regexp?: { source?: string };
  route?: { path?: string; methods?: Record<string, boolean> };
  handle?: { stack?: RouterLayer[] };
}

function mountedPrefix(layer: RouterLayer): string {
  const source = layer.regexp?.source ?? "";
  // Express compiles a mount path such as "/api" into `^\/api\/?(?=\/|$)`.
  // Only capture literal escaped path segments; a router mounted without a
  // path (`^\/?(?=\/|$)`) yields no prefix.
  const match = /^\^((?:\\\/[^\\?^(]+)+)/.exec(source);
  return match ? match[1]!.replace(/\\\//g, "/") : "";
}

function collectRoutes(stack: RouterLayer[], prefix: string, into: string[]): void {
  for (const layer of stack) {
    if (layer.route?.path && layer.route.methods) {
      for (const method of Object.keys(layer.route.methods)) {
        if (layer.route.methods[method]) {
          into.push(`${method.toUpperCase()} ${prefix}${layer.route.path}`.replace(/\/+/g, "/"));
        }
      }
    }
    if (layer.handle?.stack) {
      collectRoutes(layer.handle.stack, prefix + mountedPrefix(layer), into);
    }
  }
}

/**
 * Return every route currently mounted on an Express app (including nested
 * routers), in canonical `METHOD /path` form. Exported for the guard tests.
 */
export function mountedRoutes(app: unknown): string[] {
  const router = (app as { _router?: { stack?: RouterLayer[] } })._router;
  const routes: string[] = [];
  if (router?.stack) collectRoutes(router.stack, "", routes);
  return routes;
}

/**
 * Fail fast if a mounted route has no explicit authorization classification.
 * Called at the end of `createApp` before the app is returned.
 */
export function assertRouteAuthorizationCoverage(app: unknown): void {
  const missing = mountedRoutes(app).filter((route) => !policyForRoute(...route.split(" ", 2) as [string, string]));
  if (missing.length > 0) {
    throw new Error(
      `Coordinator route authorization policy is missing entries for: ${missing.join(", ")}. ` +
      "Add each new route to ROUTE_AUTHORIZATION_MATRIX with an explicit principal."
    );
  }
}
