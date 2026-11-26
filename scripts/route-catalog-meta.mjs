/**
 * scripts/route-catalog-meta.mjs
 *
 * Authoritative route metadata for every public HTTP endpoint across the
 * WaffleFinance services (coordinator, relayer, resolver).
 *
 * Each entry describes one route:
 *
 *   service   — "coordinator" | "relayer" | "resolver"
 *   method    — HTTP verb in uppercase (GET, POST, …)
 *   path      — Express-style path pattern, e.g. "/api/orders/:id"
 *   auth      — Authorization class (see AUTH_CLASSES below)
 *   health    — Readiness semantics: "liveness" | "readiness" | "metrics" | "none"
 *   summary   — One-sentence description
 *   sourceRef — Source file relative to the workspace root (documentation aid)
 *
 * AUTH CLASSES
 *   public         — No authentication required; accessible to any caller.
 *   operator       — Requires a valid operator bearer token
 *                    (COORDINATOR_OPERATOR_KEYS / RELAYER_ADMIN_KEY).
 *   rate-limited   — No token required, but subject to per-IP rate limiting.
 *   internal       — Intended for service-to-service calls; not exposed to end
 *                    users. No token required but should be firewalled.
 *
 * HEALTH SEMANTICS
 *   liveness   — Container-orchestrator liveness probe; always returns 200
 *                when the process is alive.
 *   readiness  — Readiness probe; returns 503 when dependencies are not ready.
 *   metrics    — Prometheus scrape endpoint.
 *   none       — Not a health endpoint.
 *
 * HOW TO ADD A NEW ROUTE
 *   1. Implement the route handler in the relevant service's routes/ directory.
 *   2. Add an entry to this file following the schema above.
 *   3. Run `pnpm validate:routes` (or `node scripts/generate-route-catalog.mjs --check`)
 *      to verify the metadata is well-formed and no required field is missing.
 *   4. Run `node scripts/generate-route-catalog.mjs` to regenerate
 *      docs/ROUTE_CATALOG.md.
 *   5. Commit both the route change and the updated catalog.
 *
 * Adding a route without a matching entry here will cause `validate:routes` to
 * fail in CI.
 */

// ---------------------------------------------------------------------------
// Schema constants
// ---------------------------------------------------------------------------

/** All valid auth-class strings. */
export const AUTH_CLASSES = /** @type {const} */ ([
  'public',
  'operator',
  'rate-limited',
  'internal',
]);

/** All valid health-semantics strings. */
export const HEALTH_SEMANTICS = /** @type {const} */ ([
  'liveness',
  'readiness',
  'metrics',
  'none',
]);

// ---------------------------------------------------------------------------
// Route catalog
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} RouteMeta
 * @property {'coordinator'|'relayer'|'resolver'} service
 * @property {string} method
 * @property {string} path
 * @property {'public'|'operator'|'rate-limited'|'internal'} auth
 * @property {'liveness'|'readiness'|'metrics'|'none'} health
 * @property {string} summary
 * @property {string} sourceRef
 */

/** @type {RouteMeta[]} */
export const ROUTES = [

  // ── Coordinator — health ─────────────────────────────────────────────────

  {
    service: 'coordinator',
    method: 'GET',
    path: '/health',
    auth: 'public',
    health: 'liveness',
    summary: 'Returns service status, reconciliation state, and Soroban listener staleness.',
    sourceRef: 'coordinator/src/server/routes/health.ts',
  },
  {
    service: 'coordinator',
    method: 'GET',
    path: '/healthz',
    auth: 'public',
    health: 'liveness',
    summary: 'Lightweight liveness probe for load balancers; always 200 when the process is alive.',
    sourceRef: 'coordinator/src/server/routes/health.ts',
  },
  {
    service: 'coordinator',
    method: 'GET',
    path: '/readyz',
    auth: 'public',
    health: 'readiness',
    summary: 'Readiness probe; returns 503 when any configured dependency check fails.',
    sourceRef: 'coordinator/src/server/routes/health.ts',
  },

  // ── Coordinator — metrics ────────────────────────────────────────────────

  {
    service: 'coordinator',
    method: 'GET',
    path: '/metrics',
    auth: 'operator',
    health: 'metrics',
    summary: 'Prometheus metrics scrape endpoint; requires operator bearer token.',
    sourceRef: 'coordinator/src/server/routes/metrics.ts',
  },

  // ── Coordinator — orders ─────────────────────────────────────────────────

  {
    service: 'coordinator',
    method: 'POST',
    path: '/api/orders/announce',
    auth: 'rate-limited',
    health: 'none',
    summary: 'Create a new coordinator order after validating the announce payload.',
    sourceRef: 'coordinator/src/server/routes/orders.ts',
  },
  {
    service: 'coordinator',
    method: 'GET',
    path: '/api/orders/history',
    auth: 'rate-limited',
    health: 'none',
    summary: 'Paginated order history for a wallet address (cursor- or offset-based).',
    sourceRef: 'coordinator/src/server/routes/orders.ts',
  },
  {
    service: 'coordinator',
    method: 'GET',
    path: '/api/orders/:id',
    auth: 'rate-limited',
    health: 'none',
    summary: 'Fetch a single order by its public ID.',
    sourceRef: 'coordinator/src/server/routes/orders.ts',
  },
  {
    service: 'coordinator',
    method: 'POST',
    path: '/api/orders/:id/src-locked',
    auth: 'operator',
    health: 'none',
    summary: 'Record that the source-chain HTLC has been locked; requires operator token.',
    sourceRef: 'coordinator/src/server/routes/orders.ts',
  },
  {
    service: 'coordinator',
    method: 'POST',
    path: '/api/orders/:id/dst-locked',
    auth: 'operator',
    health: 'none',
    summary: 'Record that the destination-chain HTLC has been locked; requires operator token.',
    sourceRef: 'coordinator/src/server/routes/orders.ts',
  },

  // ── Coordinator — SSE ────────────────────────────────────────────────────

  {
    service: 'coordinator',
    method: 'GET',
    path: '/api/orders/:id/events',
    auth: 'public',
    health: 'none',
    summary: 'Server-Sent Events stream; pushes order state transitions to the client in real time. A subscriber whose socket stays backpressured for more than 256 consecutive frames is disconnected; reconnect with Last-Event-ID to resync.',
    sourceRef: 'coordinator/src/server/routes/sse.ts',
  },

  // ── Coordinator — secrets ────────────────────────────────────────────────

  {
    service: 'coordinator',
    method: 'POST',
    path: '/api/secrets/reveal',
    auth: 'rate-limited',
    health: 'none',
    summary: 'Record the revealed HTLC preimage for a completed order.',
    sourceRef: 'coordinator/src/server/routes/secrets.ts',
  },
  {
    service: 'coordinator',
    method: 'GET',
    path: '/api/secrets/:publicId',
    auth: 'rate-limited',
    health: 'none',
    summary: 'Retrieve the revealed preimage for an order by its public ID.',
    sourceRef: 'coordinator/src/server/routes/secrets.ts',
  },

  // ── Coordinator — quotes / prices ────────────────────────────────────────

  {
    service: 'coordinator',
    method: 'GET',
    path: '/api/quotes/eth-xlm',
    auth: 'public',
    health: 'none',
    summary: 'ETH/XLM exchange rate from the SWR price cache.',
    sourceRef: 'coordinator/src/server/routes/quotes.ts',
  },
  {
    service: 'coordinator',
    method: 'GET',
    path: '/api/quotes/eth-sol',
    auth: 'public',
    health: 'none',
    summary: 'ETH/SOL exchange rate from the SWR price cache.',
    sourceRef: 'coordinator/src/server/routes/quotes.ts',
  },
  {
    service: 'coordinator',
    method: 'GET',
    path: '/api/prices',
    auth: 'public',
    health: 'none',
    summary: 'Aggregated price feed (ETH, XLM, SOL) consumed by the BridgeForm frontend.',
    sourceRef: 'coordinator/src/server/routes/quotes.ts',
  },

  // ── Coordinator — admin ───────────────────────────────────────────────────

  {
    service: 'coordinator',
    method: 'POST',
    path: '/admin/reconcile',
    auth: 'operator',
    health: 'none',
    summary: 'Trigger an immediate chain-event reconciliation run outside the normal schedule.',
    sourceRef: 'coordinator/src/server/routes/admin.ts',
  },
  {
    service: 'coordinator',
    method: 'POST',
    path: '/admin/stale-cleanup',
    auth: 'operator',
    health: 'none',
    summary: 'Trigger an immediate stale-order cleanup run; archives orders past the retention window.',
    sourceRef: 'coordinator/src/server/routes/admin.ts',
  },
  {
    service: 'coordinator',
    method: 'POST',
    path: '/admin/expire-now',
    auth: 'operator',
    health: 'none',
    summary: 'Trigger an on-demand expiry scan; marks all timelock-elapsed orders as expired.',
    sourceRef: 'coordinator/src/server/routes/admin.ts',
  },
  {
    service: 'coordinator',
    method: 'GET',
    path: '/admin/reconciliation-cursors',
    auth: 'operator',
    health: 'none',
    summary: 'Return chain-level and per-order reconciler cursor state for operator observability.',
    sourceRef: 'coordinator/src/server/routes/admin.ts',
  },

  // ── Coordinator — audit ───────────────────────────────────────────────────

  {
    service: 'coordinator',
    method: 'GET',
    path: '/api/audit',
    auth: 'public',
    health: 'none',
    summary: 'Paginated query of the audit event stream with optional filters.',
    sourceRef: 'coordinator/src/server/routes/audit.ts',
  },
  {
    service: 'coordinator',
    method: 'GET',
    path: '/api/audit/orders/:orderId',
    auth: 'public',
    health: 'none',
    summary: 'Full audit event timeline for a specific order, oldest-first.',
    sourceRef: 'coordinator/src/server/routes/audit.ts',
  },
  {
    service: 'coordinator',
    method: 'GET',
    path: '/api/audit/orders/:orderId/timeline',
    auth: 'public',
    health: 'none',
    summary: 'Unified mutation timeline merging audit_log and order_events rows for one order.',
    sourceRef: 'coordinator/src/server/routes/audit.ts',
  },
  {
    service: 'coordinator',
    method: 'GET',
    path: '/api/audit/orders/:orderId/validate',
    auth: 'public',
    health: 'none',
    summary: 'Validate that the stored audit sequence is consistent with the order state machine.',
    sourceRef: 'coordinator/src/server/routes/audit.ts',
  },
  {
    service: 'coordinator',
    method: 'GET',
    path: '/api/audit/tail',
    auth: 'public',
    health: 'none',
    summary: 'Most recent N audit entries; useful for live monitoring dashboards.',
    sourceRef: 'coordinator/src/server/routes/audit.ts',
  },
  {
    service: 'coordinator',
    method: 'GET',
    path: '/api/audit/export',
    auth: 'public',
    health: 'none',
    summary: 'Stream the full audit log as NDJSON with optional filters and incremental cursor.',
    sourceRef: 'coordinator/src/server/routes/audit.ts',
  },

  // ── Coordinator — export ──────────────────────────────────────────────────

  {
    service: 'coordinator',
    method: 'GET',
    path: '/api/export/orders/:orderId',
    auth: 'operator',
    health: 'none',
    summary: 'Export a single order\'s full lifecycle in structured JSON.',
    sourceRef: 'coordinator/src/server/routes/export.ts',
  },
  {
    service: 'coordinator',
    method: 'POST',
    path: '/api/export/orders',
    auth: 'operator',
    health: 'none',
    summary: 'Bulk export multiple orders matching supplied filters.',
    sourceRef: 'coordinator/src/server/routes/export.ts',
  },
  {
    service: 'coordinator',
    method: 'GET',
    path: '/api/orders/export',
    auth: 'operator',
    health: 'none',
    summary: 'User-facing download endpoint; returns JSON or CSV attachment with optional date/status filters.',
    sourceRef: 'coordinator/src/server/routes/export.ts',
  },

  // ── Relayer — health ──────────────────────────────────────────────────────

  {
    service: 'relayer',
    method: 'GET',
    path: '/healthz',
    auth: 'public',
    health: 'liveness',
    summary: 'Liveness probe; always 200 when the relayer process is alive.',
    sourceRef: 'relayer/src/routes/health.ts',
  },
  {
    service: 'relayer',
    method: 'GET',
    path: '/readyz',
    auth: 'public',
    health: 'readiness',
    summary: 'Readiness probe; probes Ethereum RPC, Stellar Horizon, Soroban RPC, Solana RPC, and coordinator.',
    sourceRef: 'relayer/src/routes/health.ts',
  },
  {
    service: 'relayer',
    method: 'GET',
    path: '/health',
    auth: 'public',
    health: 'liveness',
    summary: 'Detailed health payload from the UptimeMonitor for dashboards; 503 when unhealthy.',
    sourceRef: 'relayer/src/routes/health.ts',
  },

  // ── Relayer — metrics ─────────────────────────────────────────────────────

  {
    service: 'relayer',
    method: 'GET',
    path: '/metrics',
    auth: 'public',
    health: 'metrics',
    summary: 'Prometheus metrics scrape endpoint (no auth — restrict at the network layer).',
    sourceRef: 'relayer/src/routes/metrics.ts',
  },

  // ── Relayer — orders ──────────────────────────────────────────────────────

  {
    service: 'relayer',
    method: 'POST',
    path: '/api/wake',
    auth: 'public',
    health: 'none',
    summary: 'Mark a visitor as present to keep site-presence cache alive; returns 204.',
    sourceRef: 'relayer/src/routes/orders.ts',
  },
  {
    service: 'relayer',
    method: 'GET',
    path: '/api/wake',
    auth: 'public',
    health: 'none',
    summary: 'Mark a visitor as present (GET variant); returns 204.',
    sourceRef: 'relayer/src/routes/orders.ts',
  },
  {
    service: 'relayer',
    method: 'GET',
    path: '/api/prices',
    auth: 'public',
    health: 'none',
    summary: 'Real-time ETH/XLM price snapshot from the relayer pricing service.',
    sourceRef: 'relayer/src/routes/orders.ts',
  },
  {
    service: 'relayer',
    method: 'GET',
    path: '/api/support',
    auth: 'public',
    health: 'none',
    summary: 'Returns the current support policy (which swap routes are enabled).',
    sourceRef: 'relayer/src/routes/orders.ts',
  },
  {
    service: 'relayer',
    method: 'POST',
    path: '/api/transactions/history',
    auth: 'public',
    health: 'none',
    summary: 'Returns in-memory order history filtered by ETH or Stellar address.',
    sourceRef: 'relayer/src/routes/orders.ts',
  },
  {
    service: 'relayer',
    method: 'POST',
    path: '/api/orders/create',
    auth: 'public',
    health: 'none',
    summary: 'Create a new bridge order (ETH→XLM or XLM→ETH); returns approval transaction data.',
    sourceRef: 'relayer/src/routes/orders.ts',
  },
  {
    service: 'relayer',
    method: 'POST',
    path: '/api/orders/process',
    auth: 'public',
    health: 'none',
    summary: 'Process an approved bridge order; verifies Stellar payment and releases ETH.',
    sourceRef: 'relayer/src/routes/orders.ts',
  },
  {
    service: 'relayer',
    method: 'POST',
    path: '/api/orders/xlm-to-eth',
    auth: 'public',
    health: 'none',
    summary: 'Complete an XLM→ETH swap by verifying Stellar TX and sending ETH to the user.',
    sourceRef: 'relayer/src/routes/orders.ts',
  },
  {
    service: 'relayer',
    method: 'POST',
    path: '/api/orders/manual-refund',
    auth: 'public',
    health: 'none',
    summary: 'Manually trigger an XLM refund for a failed or stuck order.',
    sourceRef: 'relayer/src/routes/orders.ts',
  },
  {
    service: 'relayer',
    method: 'GET',
    path: '/api/escrow/info',
    auth: 'public',
    health: 'none',
    summary: 'Returns escrow factory address and method info for the current network.',
    sourceRef: 'relayer/src/routes/orders.ts',
  },
  {
    service: 'relayer',
    method: 'GET',
    path: '/api/debug/chain-monitor',
    auth: 'internal',
    health: 'none',
    summary: 'Debug: returns chain-monitor state and active order status counts.',
    sourceRef: 'relayer/src/routes/orders.ts',
  },

  // ── Relayer — settlement ──────────────────────────────────────────────────

  {
    service: 'relayer',
    method: 'GET',
    path: '/api/settlement/status',
    auth: 'public',
    health: 'none',
    summary: 'Returns a snapshot of all settlement records and per-state counts.',
    sourceRef: 'relayer/src/routes/settlement.ts',
  },
  {
    service: 'relayer',
    method: 'GET',
    path: '/api/settlement/status/:orderId',
    auth: 'public',
    health: 'none',
    summary: 'Returns the settlement record for a specific order.',
    sourceRef: 'relayer/src/routes/settlement.ts',
  },
  {
    service: 'relayer',
    method: 'POST',
    path: '/api/settlement/recover/:orderId',
    auth: 'operator',
    health: 'none',
    summary: 'Manually trigger reconciliation for a specific order; operator-only in production.',
    sourceRef: 'relayer/src/routes/settlement.ts',
  },
  {
    service: 'relayer',
    method: 'POST',
    path: '/api/settlement/reconcile',
    auth: 'operator',
    health: 'none',
    summary: 'Trigger a full reconciliation sweep across all non-terminal settlement records.',
    sourceRef: 'relayer/src/routes/settlement.ts',
  },

  // ── Relayer — admin ───────────────────────────────────────────────────────

  {
    service: 'relayer',
    method: 'POST',
    path: '/api/admin/authorize-relayer',
    auth: 'operator',
    health: 'none',
    summary: 'Authorize the relayer address as a resolver in the EscrowFactory contract.',
    sourceRef: 'relayer/src/routes/admin.ts',
  },
  {
    service: 'relayer',
    method: 'GET',
    path: '/api/admin/relayer-status',
    auth: 'operator',
    health: 'none',
    summary: 'Check whether the relayer address is currently authorized as a resolver.',
    sourceRef: 'relayer/src/routes/admin.ts',
  },
  {
    service: 'relayer',
    method: 'GET',
    path: '/api/admin/resolvers',
    auth: 'operator',
    health: 'none',
    summary: 'List all known resolver addresses and their authorization status.',
    sourceRef: 'relayer/src/routes/admin.ts',
  },
  {
    service: 'relayer',
    method: 'GET',
    path: '/api/admin/settlement-failures',
    auth: 'operator',
    health: 'none',
    summary: 'List settlement failure records with optional status filter and limit.',
    sourceRef: 'relayer/src/routes/admin.ts',
  },
  {
    service: 'relayer',
    method: 'GET',
    path: '/api/admin/settlement-failures/:orderId',
    auth: 'operator',
    health: 'none',
    summary: 'Return the full failure record for a specific order.',
    sourceRef: 'relayer/src/routes/admin.ts',
  },

  // ── Resolver — metrics ────────────────────────────────────────────────────

  {
    service: 'resolver',
    method: 'GET',
    path: '/metrics',
    auth: 'public',
    health: 'metrics',
    summary: 'Prometheus metrics scrape endpoint for the resolver (no auth — restrict at network layer).',
    sourceRef: 'resolver/src/routes/metrics.ts',
  },
];
